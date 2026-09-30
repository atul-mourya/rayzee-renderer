import { storage } from 'three/tsl';
import { gpuOnlyStorageAttribute, uploadStorageChunkRange, uploadStorageChunks } from '../TSL/patches.js';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { Vector2, Matrix4 } from 'three';

// Pipeline system
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';

// Managers (renderer-agnostic)
import { CameraOptimizer } from '../Processor/CameraOptimizer.js';
import { createPerformanceMonitor, calculateAccumulationAlpha, updateCompletionThreshold } from '../Processor/utils.js';
import { StorageTexturePool } from '../Processor/StorageTexturePool.js';
import { UniformManager } from '../managers/UniformManager.js';
import { MaterialDataManager } from '../managers/MaterialDataManager.js';
import { EnvironmentManager } from '../managers/EnvironmentManager.js';
import { ShaderBuilder } from '../Processor/ShaderBuilder.js';

// Scene building
import { SceneProcessor } from '../Processor/SceneProcessor.js';
import { LightSerializer } from '../Processor/LightSerializer';

// Constants
import { ENGINE_DEFAULTS as DEFAULT_STATE, TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';
import { TRI_GEO_ROWS, TRI_SHADE_ROWS } from '../TSL/Common.js';
import { createLogger, fmt } from '../utils/Logger.js';

// Triangles converted per staging pass: 256K is 12 + 8 MB of staging, kept for the stage's life.
const TRIANGLE_UPLOAD_SLICE = 1 << 18;

const log = createLogger( 'pathtracer' );

// How long after the last move the view still counts as moving. Matches CameraOptimizer's own
// settle delay, so the answer does not change when interaction mode is switched off.
const VIEW_SETTLE_MS = 100;

/**
 * Data layout constants
 */
const BVH_VEC4_PER_NODE = 4;

/**
 * Path Tracing Stage for WebGPU.
 *
 * Full-featured path tracing stage:
 * - BVH-accelerated ray traversal
 * - GGX/Diffuse BSDF sampling
 * - Environment lighting with importance sampling
 * - Progressive and tiled accumulation
 * - MRT outputs for denoising (normal/depth, albedo)
 * - Camera interaction mode optimization
 * - Event-driven pipeline communication
 *
 * Events emitted:
 * - pathtracer:frameComplete - When a frame finishes rendering
 * - camera:moved - When camera position/orientation changes
 * - asvgf:reset - Request ASVGF to reset temporal data
 * - asvgf:updateParameters - Update ASVGF parameters
 *
 * Textures published to context:
 * - pathtracer:color - Main color output
 * - pathtracer:normalDepth - Normal/depth buffer
 */
export class PathTracerStage extends RenderStage {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {Scene} scene - Three.js scene
	 * @param {PerspectiveCamera} camera - Three.js camera
	 * @param {Object} options - Configuration options
	 */
	constructor( renderer, scene, camera, options = {} ) {

		super( 'PathTracer', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		const width = options.width || 1920;
		const height = options.height || 1080;

		this.camera = camera;
		this.width = width;
		this.height = height;
		this.renderer = renderer;
		this.scene = scene;

		// Scene building
		this.sdfs = new SceneProcessor();
		this.lightSerializer = new LightSerializer();

		// State management
		this.accumulationEnabled = true;
		this.isComplete = false;
		this.cameras = [];
		// Performance monitoring
		this.performanceMonitor = createPerformanceMonitor();
		this.completionThreshold = 0;
		this.renderLimitMode = 'frames';

		// Initialize data textures
		this._initDataTextures();

		// Initialize storage texture pool (ping-pong compute output)
		this.storageTextures = new StorageTexturePool( 0, 0 );

		// Initialize uniforms via UniformManager
		this.uniforms = new UniformManager( width, height );

		// Define getters for every uniform so that this.maxBounces, this.frame, etc.
		// return the uniform node (backward-compat with this.X.value pattern).
		this._defineUniformGetters();

		// Initialize material data manager
		this.materialData = new MaterialDataManager( this.sdfs );
		this.materialData.callbacks.onReset = () => this.reset();
		// Material edits patch the per-triangle flags lane in the CPU records (`_triangleRecords`
		// when chunked, `_triangleFlat` otherwise — not sdfs.triangleData, which the PathTracerApp
		// build path never fills). The flags live in the shade rows, so only those go up again.
		this.materialData.callbacks.getTriangleData = () => ( {
			array: this._triangleFlat,
			records: this._triangleRecords,
			count: this.triangleCount,
		} );
		this.materialData.callbacks.onTriangleDataChanged = () => {

			if ( this.triangleShadeAttr ) this._uploadTriangles( 0, this._triangleRecordCount, { geo: false } );

		};

		// Initialize environment manager
		this.environment = new EnvironmentManager( this.scene, this.uniforms, this.renderer );
		this.environment.callbacks.onReset = () => this.reset();
		this.environment.callbacks.getSceneTextureNodes = () => this.shaderBuilder.getSceneTextureNodes();

		// Initialize shader composer
		this.shaderBuilder = new ShaderBuilder();

		// Initialize rendering state
		this._initRenderingState();

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();

		// Sampler seed axis — advances per rendered frame, survives accumulation resets.
		// Pinned back to the accumulation index in deterministic mode.
		this._seedTick = 0;
		this._pinSeedToFrame = false;
		// Monotonic, unlike the seed axis; let observers tell a traced frame and a reset apart.
		this.tracedFrames = 0;
		this.resetCount = 0;

		// Denoising management state
		this.lastRenderMode = - 1;
		this.renderModeChangeTimeout = null;
		this.renderModeChangeDelay = 50;
		this.pendingRenderMode = null;

		// Track interaction mode state for accumulation
		this.lastInteractionModeState = false;

		// Track changes for event emission
		this.cameraChanged = false;
		// When the view was last moved, for viewIsChanging.
		this._lastViewChangeAt = - Infinity;

		// Update completion threshold
		this.updateCompletionThreshold();

	}

	/**
	 * Initialize data texture references and metadata
	 */
	_initDataTextures() {

		// Triangle data: two GPU buffers (TRI_GEO_ROWS / TRI_SHADE_ROWS rows a triangle), one
		// { geo, shade } node pair, and the CPU records they were written from.
		this.triangleGeoAttr = null;
		this.triangleShadeAttr = null;
		this._triangleRecords = null;
		this._triangleFlat = null;
		this._triangleRecordCount = 0;
		this.triangleStorageNode = null;
		this.triangleCount = 0;

		// BVH data (storage buffer for WebGPU)
		this.bvhStorageAttr = null;
		this._bvhRecords = null;
		this.bvhStorageNode = null;
		this.bvhNodeCount = 0;

		// Lights
		this.directionalLightsData = null;
		this.pointLightsData = null;
		this.spotLightsData = null;
		this.areaLightsData = null;

		// Spot light gobo (projection mask) DataArrayTexture. Owned externally
		// (GoboManager); ShaderBuilder reads via this property at graph build time
		// and refreshes the bound TextureNode in-place when it changes.
		this.goboMaps = null;

		// Spot light IES photometric profiles DataArrayTexture. Owned externally
		// (IESManager); ShaderBuilder reads via this property at graph build time
		// and refreshes the bound TextureNode in-place when it changes.
		this.iesProfiles = null;

		/**
		 * @deprecated Always resolved: the engine no longer loads blue-noise textures.
		 * @type {Promise<void>}
		 */
		this.blueNoiseReady = Promise.resolve();

		// Packed light buffer — [lightBVH nodes (4 vec4s each) | emissive triangles (2 vec4s each)]
		// emissiveVec4Offset uniform tracks the vec4-count offset where emissive data starts.
		// Initialized with dummy data so TSL compilation never sees null.
		this.lightStorageAttr = new StorageInstancedBufferAttribute( new Float32Array( 16 ), 4 );
		this.lightStorageNode = storage( this.lightStorageAttr, 'vec4', 1 ).toReadOnly();
		// Set when _rebuildLightBuffer had to grow-reallocate the attribute: compiled
		// kernels still bind the old one and must be rebuilt to see the new data.
		this._lightBufferRealloc = false;

		// Cached CPU-side data — rebuilt into the packed buffer whenever any source changes.
		this._lbvhDataCache = null;
		this._emissiveDataCache = null;
		// Per-triangle bit-trail map (root→leaf Light BVH path, 1 float per triangleIndex); packed
		// after the emissive entries so the bounce-hit MIS path can re-walk the descent pdf.
		this._bitTrailMapCache = null;
		this._bitTrailOffset = 0;
		this._bitTrailLength = 0;

		// Per-mesh visibility is packed into the TLAS BLAS-pointer leaf's slot [2]
		// (see TLASBuilder.flatten + BVHTraversal.js). The InstanceTable holds the
		// tlasLeafIndex for each mesh so we can patch visibility in place.
		this._instanceTable = null;

		// Spheres
		this.spheres = [];

	}

	/**
	 * Dynamically defines getters for all uniform names so that
	 * this.maxBounces, this.frame, etc. return the uniform node.
	 * Also defines light buffer node getters.
	 * @private
	 */
	_defineUniformGetters() {

		const uniforms = this.uniforms;

		for ( const name of uniforms.keys() ) {

			Object.defineProperty( this, name, {
				get: () => uniforms.get( name ),
				configurable: true,
			} );

		}

		// Light buffer node getters
		const lightBuffers = uniforms.getLightBufferNodes();
		for ( const [ suffix, node ] of Object.entries( lightBuffers ) ) {

			Object.defineProperty( this, `${suffix}LightsBufferNode`, {
				get: () => node,
				configurable: true,
			} );

		}

	}

	/**
	 * Initialize rendering state
	 */
	_initRenderingState() {

		// State flags
		this.isReady = false;
		this.frameCount = 0;

	}

	/**
	 * Initialize camera movement optimizer
	 */
	_initCameraOptimizer() {

		// Create adapter interface for TSL uniforms
		const self = this;
		const materialInterface = {
			uniforms: {
				enableAccumulation: {
					get value() {

						return self.enableAccumulation.value;

					},
					set value( v ) {

						self.enableAccumulation.value = v;

					}
				},
				fireflyThreshold: {
					get value() {

						return self.fireflyThreshold.value;

					},
					set value( v ) {

						self.fireflyThreshold.value = v;

					}
				},
				cameraIsMoving: {
					get value() {

						return self.cameraIsMoving.value;

					},
					set value( v ) {

						self.cameraIsMoving.value = v;

					}
				}
			}
		};

		this.cameraOptimizer = new CameraOptimizer( this.renderer, materialInterface, {
			enabled: DEFAULT_STATE.interactionModeEnabled,
			// Nothing that costs light: the app lowers the resolution instead (PathTracerApp._applyRenderScale).
			// The firefly limit grows with sqrt(frame + 1), and every moving frame is frame 0, where it clipped
			// ~10% of an emissive-lit interior's light. ×8 is the limit a still image reaches at 64 samples:
			// lowest large-area error of the values measured, and half the extra grain of turning it off.
			qualitySettings: {
				enableAccumulation: false,
				fireflyThreshold: ( threshold ) => threshold * 8,
			},
			onEnter: () => this.emit( 'pathtracer:interactionStart' ),
			onExit: () => this.emit( 'pathtracer:interactionEnd' ),
			onReset: () => {

				this.reset();
				this.emit( 'pathtracer:viewpointChanged' );

			}
		} );

	}

	/**
	 * Setup event listeners for pipeline events
	 */
	setupEventListeners() {

		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

		this.on( 'pipeline:resize', ( data ) => {

			if ( data && data.width && data.height ) {

				this.setSize( data.width, data.height );

			}

		} );

		this.on( 'pathtracer:setCompletionThreshold', ( data ) => {

			if ( data && data.threshold !== undefined ) {

				this.completionThreshold = data.threshold;

			}

		} );

	}

	// ===== PUBLIC API METHODS =====

	/**
	 * Build scene data (BVH, geometry, materials)
	 * @param {Object3D} scene - Three.js scene or object
	 */
	async build( scene ) {

		this.dispose();
		this.scene = scene;

		await this.sdfs.buildBVH( scene );
		this.cameras = this.sdfs.cameras;

		// Update uniforms with scene data
		this.updateSceneUniforms();
		this.updateLights();

		// Initialize camera optimizer after scene is built
		this._initCameraOptimizer();

		// Setup material now that we have scene data
		this.setupMaterial();

	}

	/**
	 * Update scene uniforms from SceneProcessor data
	 */
	updateSceneUniforms() {

		// Set data references
		this.setTriangleData( this.sdfs.triangleData, this.sdfs.triangleCount );
		this.setBVHData( this.sdfs.bvhData );
		this.setInstanceTable( this.sdfs.instanceTable );
		this.materialData.setMaterialData( this.sdfs.materialData, this.sdfs.materials?.map( m => m.sources ) );

		// Material texture arrays
		this.materialData.loadTexturesFromSdfs();

		// Emissive triangles (storage buffer)
		if ( this.sdfs.emissiveTriangleData ) {

			this.setEmissiveTriangleData( this.sdfs.emissiveTriangleData, this.sdfs.emissiveTriangleCount || 0 );

		} else {

			this.emissiveTriangleCount.value = 0;

		}

		// Light BVH
		if ( this.sdfs.lightBVHNodeData ) {

			this.setLightBVHData( this.sdfs.lightBVHNodeData, this.sdfs.lightBVHNodeCount || 0 );

		} else {

			this.lightBVHNodeCount.value = 0;

		}

		// Per-mesh visibility — collect meshes from scene ordered by meshIndex
		this._meshRefs = this._collectMeshRefs( this.scene );
		this.setMeshVisibilityData( this._meshRefs );

		// Spheres
		this.spheres = this.sdfs.spheres || [];

	}

	/**
	 * Update lights from scene
	 */
	updateLights() {

		// Process scene lights
		const mockMaterial = {
			uniforms: {
				directionalLights: { value: null },
				pointLights: { value: null },
				spotLights: { value: null },
				areaLights: { value: null }
			},
			defines: {}
		};

		this.lightSerializer.processSceneLights( this.scene, mockMaterial );

		// Store light data
		this.directionalLightsData = mockMaterial.uniforms.directionalLights.value;
		this.pointLightsData = mockMaterial.uniforms.pointLights.value;
		this.spotLightsData = mockMaterial.uniforms.spotLights.value;
		this.areaLightsData = mockMaterial.uniforms.areaLights.value;

		// Update TSL uniform buffer nodes from raw Float32Array data
		this._updateLightBufferNodes();

	}

	/**
	 * Update TSL uniformArray nodes with current light Float32Array data
	 */
	_updateLightBufferNodes() {

		// Directional lights (12 floats per light — 8 light fields + gobo {index, signed intensity, scale, pad})
		if ( this.directionalLightsData && this.directionalLightsData.length > 0 ) {

			this.directionalLightsBufferNode.array = Array.from( this.directionalLightsData );
			this.numDirectionalLights.value = Math.floor( this.directionalLightsData.length / 12 );

		} else {

			this.numDirectionalLights.value = 0;

		}

		// Area lights (16 floats per light — 13 base + normalize/spread/shape)
		if ( this.areaLightsData && this.areaLightsData.length > 0 ) {

			this.areaLightsBufferNode.array = Array.from( this.areaLightsData );
			this.numAreaLights.value = Math.floor( this.areaLightsData.length / 16 );

		} else {

			this.numAreaLights.value = 0;

		}

		// Point lights (9 floats per light)
		if ( this.pointLightsData && this.pointLightsData.length > 0 ) {

			this.pointLightsBufferNode.array = Array.from( this.pointLightsData );
			this.numPointLights.value = Math.floor( this.pointLightsData.length / 9 );

		} else {

			this.numPointLights.value = 0;

		}

		// Spot lights (20 floats per light — 14 light fields + gobo {idx, signed intensity} + IES {idx, intensity} + 2 reserved)
		if ( this.spotLightsData && this.spotLightsData.length > 0 ) {

			this.spotLightsBufferNode.array = Array.from( this.spotLightsData );
			this.numSpotLights.value = Math.floor( this.spotLightsData.length / 20 );

		} else {

			this.numSpotLights.value = 0;

		}

	}

	/**
	 * Reset accumulation
	 */
	reset() {

		this.resetCount ++;
		this.frameCount = 0;
		this.frame.value = 0;
		this.hasPreviousAccumulated.value = 0;
		this.storageTextures.currentTarget = 0;

		// Update completion threshold
		this.updateCompletionThreshold();
		this.isComplete = false;
		this.performanceMonitor?.reset();

		// lastRenderMode is deliberately NOT invalidated here — clearing it made
		// manageASVGFForRenderMode see a phantom mode change 50 ms after every reset, wiping
		// ASVGF's history. A real mode change is still caught by the renderMode comparison.
		this.lastInteractionModeState = false;

		// Only deterministic mode and lockstep readbacks rewind the seed axis; see _pinSeedToFrame.
		if ( this._pinSeedToFrame || this._lockstep ) this._seedTick = 0;

	}

	/**
	 * Set render size
	 * @param {number} width
	 * @param {number} height
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		this.resolution.value.set( width, height );
		this.createStorageTextures( width, height );

	}

	/**
	 * Set accumulation enabled state
	 * @param {boolean} enabled
	 */
	setAccumulationEnabled( enabled ) {

		this.accumulationEnabled = enabled;
		this.enableAccumulation.value = enabled ? 1 : 0;

	}

	// ===== MANAGER DELEGATION METHODS =====

	enterInteractionMode() {

		this.cameraOptimizer?.enterInteractionMode();

	}

	setInteractionModeEnabled( enabled ) {

		this.cameraOptimizer?.setInteractionModeEnabled( enabled );

	}

	// ===== PROPERTY GETTERS =====

	get interactionMode() {

		return this.cameraOptimizer?.isInInteractionMode() ?? false;

	}

	/**
	 * Whether the view is being moved right now — the camera or a gizmo — whether or not interaction
	 * mode is on. Interaction mode answers a narrower question (may quality be reduced) and is a
	 * switch a host can turn off; what a denoiser needs to know is only whether this frame is about
	 * to be thrown away by the next move.
	 */
	get viewIsChanging() {

		return this.interactionMode || performance.now() - this._lastViewChangeAt < VIEW_SETTLE_MS;

	}

	// Called by the host loop on a frame whose reset came from the view moving.
	noteViewChanged() {

		this._lastViewChangeAt = performance.now();

	}

	// ===== TEXTURE SETTERS =====

	/**
	 * Sets the triangle data. The records stay whole on the CPU and are split into the geo and
	 * shade GPU buffers as they go up. Later calls swap the nodes' attributes, which keeps the
	 * compiled shader graph.
	 * @param {Uint32Array|import('../Processor/ChunkedRecords.js').ChunkedRecords} triangleData
	 * @param {number} triangleCount - Number of triangles
	 */
	setTriangleData( triangleData, triangleCount ) {

		if ( ! triangleData ) return;

		const chunked = triangleData.chunks && triangleData.chunks.length > 1 ? triangleData : null;
		const flat = chunked ? null : ( triangleData.chunks ? triangleData.chunks[ 0 ] : triangleData );
		const records = chunked ? chunked.recordCount : Math.ceil( flat.length / TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );
		const pre = chunked?._gpuUpload?.triangles ? chunked._gpuUpload : null;
		const { geo, shade } = pre ?? this._allocateTriangleBuffers( records );

		if ( this.triangleStorageNode ) {

			this.triangleStorageNode.geo.value = geo;
			this.triangleStorageNode.geo.bufferCount = geo.count;
			this.triangleStorageNode.shade.value = shade;
			this.triangleStorageNode.shade.bufferCount = shade.count;

		} else {

			this.triangleStorageNode = {
				geo: storage( geo, 'uvec4', geo.count ).toReadOnly(),
				shade: storage( shade, 'uvec4', shade.count ).toReadOnly(),
			};

		}

		this.triangleGeoAttr = geo;
		this.triangleShadeAttr = shade;
		this._triangleRecords = chunked;
		this._triangleFlat = flat;
		this._triangleRecordCount = records;
		this.triangleCount = triangleCount;
		this._uploadTriangles( 0, records, { skipChunks: pre?.uploaded } );

		log.debug( `${fmt.n( this.triangleCount )} triangles (storage buffer)` );

	}

	/** GPU-only geo and shade buffers for `records` triangles, created now. @private */
	_allocateTriangleBuffers( records ) {

		const n = Math.max( 1, records );
		this._assertFitsGPU( n * TRI_GEO_ROWS * 16 );
		const geo = gpuOnlyStorageAttribute( n * TRI_GEO_ROWS, 4, Uint32Array );
		const shade = gpuOnlyStorageAttribute( n * TRI_SHADE_ROWS, 4, Uint32Array );
		this.renderer.backend.createStorageAttribute( geo );
		this.renderer.backend.createStorageAttribute( shade );
		return { geo, shade };

	}

	/**
	 * Writes triangles [start, start + count) of the CPU records into the geo and shade buffers:
	 * the first TRI_GEO_ROWS rows of each record to one, the rest to the other.
	 * @param {number} start
	 * @param {number} count
	 * @param {{ geo?: boolean, shade?: boolean, skipChunks?: Set<number>, source?: Uint32Array, sourceStart?: number }} [options]
	 *   `source` writes those records instead of reading the stage's own (a chunk being handed over).
	 * @private
	 */
	_uploadTriangles( start, count, { geo = true, shade = true, skipChunks = null, source = null, sourceStart = 0, geoAttr = this.triangleGeoAttr, shadeAttr = this.triangleShadeAttr } = {} ) {

		if ( count <= 0 || ! geoAttr ) return;

		const backend = this.renderer.backend;
		const geoBuffer = backend.get( geoAttr ).buffer;
		const shadeBuffer = backend.get( shadeAttr ).buffer;
		const LANES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const GEO = TRI_GEO_ROWS * 4, SHADE = TRI_SHADE_ROWS * 4;
		const records = this._triangleRecords;
		const perChunk = source ? count : records ? records.recordsPerChunk : this._triangleRecordCount;
		// One staging pair for every upload: a fresh one per chunk was churn that failed to
		// allocate on a scene already at the edge of the address space.
		const slice = TRIANGLE_UPLOAD_SLICE;
		this._triangleStaging ??= { geo: new Uint32Array( slice * GEO ), shade: new Uint32Array( slice * SHADE ) };
		const geoStage = this._triangleStaging.geo;
		const shadeStage = this._triangleStaging.shade;

		for ( let at = start, end = start + count; at < end; ) {

			const k = source ? 0 : Math.floor( at / perChunk );
			const chunkStart = source ? start : k * perChunk;
			const chunkEnd = Math.min( end, chunkStart + perChunk );
			if ( skipChunks?.has( k ) ) {

				at = chunkEnd;
				continue;

			}

			const src = source ?? ( records ? records.chunks[ k ] : this._triangleFlat );
			if ( ! src ) throw new Error( `triangle chunk ${k} is on disk and was never uploaded` );

			const n = Math.min( slice, chunkEnd - at );
			let s = ( source ? at - start + sourceStart : at - chunkStart ) * LANES;
			for ( let i = 0, g = 0, h = 0; i < n; i ++, s += LANES ) {

				if ( geo ) for ( let l = 0; l < GEO; l ++ ) geoStage[ g ++ ] = src[ s + l ];
				if ( shade ) for ( let l = GEO; l < LANES; l ++ ) shadeStage[ h ++ ] = src[ s + l ];

			}

			if ( geo ) backend.device.queue.writeBuffer( geoBuffer, at * GEO * 4, geoStage, 0, n * GEO );
			if ( shade ) backend.device.queue.writeBuffer( shadeBuffer, at * SHADE * 4, shadeStage, 0, n * SHADE );
			at += n;

		}

	}

	/**
	 * Allocates the GPU buffer for chunked `records` now and returns a function that writes one
	 * chunk into it, so a build can hand chunks over as it finishes them and let them go (the
	 * memory spill). setTriangleData / setBVHData then adopt that buffer rather than upload again.
	 * @param {import('../Processor/ChunkedRecords.js').ChunkedRecords} records
	 * @returns {function(number): void} uploads chunk k from `records.chunks[ k ]`
	 */
	createChunkUploader( records ) {

		this._assertFitsGPU( records.recordCount * records.lanesPerRecord * records.LaneType.BYTES_PER_ELEMENT );
		const attr = gpuOnlyStorageAttribute( records.recordCount * records.lanesPerRecord / 4, 4, records.LaneType );
		const backend = this.renderer.backend;
		backend.createStorageAttribute( attr );
		const buffer = backend.get( attr ).buffer;
		const stride = records.recordsPerChunk * records.lanesPerRecord * records.LaneType.BYTES_PER_ELEMENT;
		const uploaded = new Set();
		records._gpuUpload = { attr, uploaded };

		return k => {

			const chunk = records.chunks[ k ];
			backend.device.queue.writeBuffer( buffer, k * stride, chunk, 0, chunk.length );
			uploaded.add( k );

		};

	}

	/**
	 * createChunkUploader for triangle records: both GPU buffers are allocated now and each
	 * chunk is split into them as it is handed over.
	 * @param {import('../Processor/ChunkedRecords.js').ChunkedRecords} records
	 * @returns {function(number): void}
	 */
	createTriangleChunkUploader( records ) {

		const { geo, shade } = this._allocateTriangleBuffers( records.recordCount );
		const uploaded = new Set();
		records._gpuUpload = { triangles: true, geo, shade, uploaded };
		const perChunk = records.recordsPerChunk;

		return k => {

			const first = k * perChunk;
			const count = Math.min( perChunk, records.recordCount - first );
			this._uploadTriangles( first, count, { source: records.chunks[ k ], geoAttr: geo, shadeAttr: shade } );
			uploaded.add( k );

		};

	}

	/**
	 * One storage buffer holds all of a scene's triangles, and one its BVH. Past the device's
	 * limit WebGPU hands back an invalid buffer and every write to it fails quietly.
	 * @private
	 */
	_assertFitsGPU( bytes ) {

		const limits = this.renderer?.backend?.device?.limits;
		const max = Math.min( limits?.maxBufferSize ?? Infinity, limits?.maxStorageBufferBindingSize ?? Infinity );
		if ( bytes > max ) throw new Error( `the scene needs a ${fmt.mb( bytes )} GPU buffer, past the ${fmt.mb( max )} this GPU allows for one — load fewer triangles` );

	}

	/** Uploads chunked records, or — for a buffer a build already filled — whatever it has not. @private */
	_uploadChunked( attr, records ) {

		const pre = records._gpuUpload;
		if ( ! pre || pre.attr !== attr ) {

			uploadStorageChunks( this.renderer, attr, records.chunks );
			return;

		}

		const buffer = this.renderer.backend.get( attr ).buffer;
		const stride = records.recordsPerChunk * records.lanesPerRecord * records.LaneType.BYTES_PER_ELEMENT;
		for ( let k = 0; k < records.chunks.length; k ++ ) {

			if ( pre.uploaded.has( k ) ) continue;
			const chunk = records.chunks[ k ];
			if ( ! chunk ) throw new Error( `chunk ${k} is on disk and was never uploaded` );
			this.renderer.backend.device.queue.writeBuffer( buffer, k * stride, chunk, 0, chunk.length );
			pre.uploaded.add( k );

		}

	}

	/**
	 * Sets the BVH data from raw Float32Array via storage buffer.
	 * @param {Float32Array} bvhImageData - Raw BVH data from DataTexture.image.data
	 */
	setBVHData( bvhImageData ) {

		if ( ! bvhImageData ) return;

		// Same story as the triangles: past the ~2 GB array cap the nodes arrive as several
		// chunks and still become one GPU buffer.
		const chunked = bvhImageData.chunks && bvhImageData.chunks.length > 1 ? bvhImageData : null;
		const flat = chunked ? null : ( bvhImageData.chunks ? bvhImageData.chunks[ 0 ] : bvhImageData );
		const lanes = chunked ? chunked.recordCount * chunked.lanesPerRecord : flat.length;
		const vec4Count = lanes / 4;
		this._assertFitsGPU( lanes * 4 );

		const makeAttr = () => chunked
			? chunked._gpuUpload?.attr ?? gpuOnlyStorageAttribute( vec4Count, 4, Float32Array )
			: new StorageInstancedBufferAttribute( flat, 4 );

		if ( this.bvhStorageNode ) {

			this.bvhStorageAttr = makeAttr();
			this.bvhStorageNode.value = this.bvhStorageAttr;
			this.bvhStorageNode.bufferCount = vec4Count;

		} else {

			this.bvhStorageAttr = makeAttr();
			this.bvhStorageNode = storage( this.bvhStorageAttr, 'vec4', vec4Count ).toReadOnly();

		}

		this.bvhStorageAttr.foldedLeaves = bvhImageData.foldedLeaves === true;
		this._bvhRecords = chunked;
		if ( chunked ) this._uploadChunked( this.bvhStorageAttr, chunked );

		this.bvhNodeCount = Math.floor( vec4Count / BVH_VEC4_PER_NODE );
		log.debug( `${fmt.n( this.bvhNodeCount )} BVH nodes (storage buffer)` );

	}

	/**
	 * Bind the InstanceTable used to locate each mesh's TLAS leaf for in-place
	 * visibility patching. Called by SceneProcessor during upload.
	 * @param {import('../Processor/InstanceTable.js').InstanceTable} instanceTable
	 */
	setInstanceTable( instanceTable ) {

		this._instanceTable = instanceTable;

	}

	/**
	 * Initialize packed visibility for each mesh from current world-visibility.
	 * Patches the TLAS leaf slots in the combined BVH buffer that was just uploaded.
	 * @param {Array} meshes - Array of Three.js mesh objects, ordered by meshIndex
	 */
	setMeshVisibilityData( meshes ) {

		if ( ! meshes || meshes.length === 0 || ! this._instanceTable ) return;

		this._patchVisibilityFromMeshes( meshes );
		this._flushBVHEdits();

	}

	/**
	 * Resolve each placement's visibility from the object it came from. Entries are per
	 * instance, so an InstancedMesh covers a whole run of them with one authored flag.
	 * @private
	 */
	_patchVisibilityFromMeshes( meshes ) {

		const table = this._instanceTable;
		const cache = new Map();

		for ( let i = 0; i < table.count; i ++ ) {

			if ( ! table.isSet[ i ] ) continue;

			const src = table.sourceMesh[ i ];
			let visible = cache.get( src );
			if ( visible === undefined ) cache.set( src, visible = this._isWorldVisible( meshes[ src ] ) );
			this._patchTLASLeafVisibility( i, visible );

		}

	}

	/**
	 * Update visibility for a single mesh by patching its TLAS leaf slot [2].
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	updateMeshVisibility( meshIndex, visible ) {

		if ( ! this._patchTLASLeafVisibility( meshIndex, visible ) ) return;
		this._flushBVHEdits();

	}

	/**
	 * Recompute world-visibility for all meshes and patch TLAS leaves in place.
	 * Call this when group visibility changes at runtime.
	 */
	updateAllMeshVisibility() {

		if ( ! this._meshRefs || ! this._instanceTable ) return;

		this._patchVisibilityFromMeshes( this._meshRefs );
		this._flushBVHEdits();

	}

	/**
	 * Patch a single TLAS leaf's visibility flag in the combined BVH buffer.
	 * Returns true if the patch was applied.
	 * @private
	 */
	_patchTLASLeafVisibility( meshIndex, visible ) {

		const table = this._instanceTable;
		if ( ! table || ! table.isSet?.[ meshIndex ] || ! this.bvhStorageAttr ) return false;

		const leaf = table.tlasLeafIndex[ meshIndex ];
		if ( leaf < 0 ) return false;

		table.visible[ meshIndex ] = visible ? 1 : 0;

		// A chunked attribute owns no CPU array; write into the chunk that holds this leaf.
		if ( this._bvhRecords ) this._bvhRecords.chunkFor( leaf )[ this._bvhRecords.baseOf( leaf ) + 2 ] = visible ? 1.0 : 0.0;
		else this.bvhStorageAttr.array[ leaf * 16 + 2 ] = visible ? 1.0 : 0.0;

		this._dirtyBVHLeaves ??= new Set();
		this._dirtyBVHLeaves.add( leaf );
		return true;

	}

	/**
	 * Push BVH edits to the GPU. A chunked attribute cannot go through three.js's dirty flag,
	 * so the touched leaves are written straight into the buffer.
	 * @private
	 */
	_flushBVHEdits() {

		if ( ! this.bvhStorageAttr ) return;

		if ( ! this._bvhRecords ) {

			// Leaves sit in the TLAS at the front; needsUpdate would re-upload every BLAS too.
			let lo = Infinity, hi = - 1;
			for ( const leaf of this._dirtyBVHLeaves ?? [] ) {

				if ( leaf < lo ) lo = leaf;
				if ( leaf > hi ) hi = leaf;

			}

			if ( hi >= 0 ) {

				this.bvhStorageAttr.addUpdateRange( lo * 16, ( hi - lo + 1 ) * 16 );
				this.bvhStorageAttr.version ++;

			}

			this._dirtyBVHLeaves?.clear();
			return;

		}

		for ( const leaf of this._dirtyBVHLeaves ?? [] ) {

			uploadStorageChunkRange( this.renderer, this.bvhStorageAttr, this._bvhRecords, leaf * 16, 16 );

		}

		this._dirtyBVHLeaves?.clear();

	}

	/**
	 * Collect mesh references from scene, ordered by meshIndex (assigned during extraction).
	 * @param {Object3D} scene
	 * @returns {Array}
	 * @private
	 */
	_collectMeshRefs( scene ) {

		if ( ! scene ) return [];

		const meshes = [];
		scene.traverse( obj => {

			if ( obj.isMesh && obj.userData.meshIndex !== undefined ) {

				meshes[ obj.userData.meshIndex ] = obj;

			}

		} );

		return meshes;

	}

	/**
	 * Walk the parent chain to determine world-space visibility.
	 * @param {Object3D} object
	 * @returns {boolean}
	 * @private
	 */
	_isWorldVisible( object ) {

		while ( object ) {

			if ( ! object.visible ) return false;
			object = object.parent;

		}

		return true;

	}

	// ===== FAST BUFFER UPDATES (BVH Refit / Animation) =====

	/**
	 * Update an existing GPU storage buffer in-place (no reallocation).
	 * @param {StorageInstancedBufferAttribute} attr
	 * @param {Float32Array} data
	 * @private
	 */
	_updateStorageBuffer( attr, data ) {

		if ( ! attr ) return;
		attr.array.set( data );
		// A pending update range would cut this full upload down to that range.
		attr.clearUpdateRanges();
		attr.needsUpdate = true;

	}

	/** Re-uploads every triangle from the CPU records, adopting `triangleData` as them when given. */
	updateTriangleData( triangleData ) {

		if ( triangleData?.chunks?.length > 1 ) this._triangleRecords = triangleData;
		else if ( triangleData ) this._triangleFlat = triangleData.chunks ? triangleData.chunks[ 0 ] : triangleData;
		this._uploadTriangles( 0, this._triangleRecordCount );

	}

	/** Update BVH node data in the existing GPU buffer (full). */
	updateBVHData( bvhData ) {

		if ( this._bvhRecords ) {

			uploadStorageChunks( this.renderer, this.bvhStorageAttr, this._bvhRecords.chunks );
			return;

		}

		this._updateStorageBuffer( this.bvhStorageAttr, bvhData?.chunks ? bvhData.chunks[ 0 ] : bvhData );

	}

	/**
	 * Update only specific ranges of the GPU storage buffers.
	 * Uses addUpdateRange for partial GPU upload instead of full buffer copy.
	 *
	 * @param {Array<{offset: number, count: number}>} triRanges - Dirty triangle ranges (element index + count)
	 * @param {Array<{offset: number, count: number}>} bvhRanges - Dirty BVH node ranges (element index + count)
	 */
	updateBufferRanges( triRanges, bvhRanges ) {

		if ( this.triangleGeoAttr && triRanges.length > 0 ) {

			// Ranges are in lanes of the CPU records; the GPU copy is written a triangle at a time.
			const lanes = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
			for ( const r of triRanges ) {

				const first = Math.floor( r.offset / lanes );
				this._uploadTriangles( first, Math.ceil( ( r.offset + r.count ) / lanes ) - first );

			}

		}

		if ( this.bvhStorageAttr && bvhRanges.length > 0 ) {

			if ( this._bvhRecords ) {

				for ( const r of bvhRanges ) {

					uploadStorageChunkRange( this.renderer, this.bvhStorageAttr, this._bvhRecords, r.offset, r.count );

				}

			} else {

				this.bvhStorageAttr.clearUpdateRanges();

				for ( const r of bvhRanges ) {

					this.bvhStorageAttr.addUpdateRange( r.offset, r.count );

				}

				this.bvhStorageAttr.version ++;

			}

		}

	}

	// ===== STORAGE TEXTURES =====

	/**
	 * Creates storage textures for compute accumulation.
	 * @param {number} width
	 * @param {number} height
	 */
	createStorageTextures( width, height ) {

		if ( this.storageTextures.writeColor ) {

			// Resize existing textures — preserves JS object references
			// so the compiled compute node's bindings remain valid
			this.storageTextures.setSize( width, height );

		} else {

			// Initial creation
			this.storageTextures.create( width, height );

		}

		// Update resolution uniform
		this.resolution.value.set( width, height );

	}

	// ===== MATERIAL SETUP =====

	/**
	 * Creates the path tracing material and quad.
	 * On subsequent calls (after the first), updates texture node values
	 * in-place instead of rebuilding the entire shader to avoid TSL/WGSL
	 * compilation failures from duplicate variable names.
	 */
	setupMaterial() {

		// Ensure camera optimizer exists (build() creates it, but loadSceneData() skips build())
		if ( ! this.cameraOptimizer ) {

			this._initCameraOptimizer();

		}

		if ( ! this.triangleStorageNode ) {

			log.error( 'triangle data required' );
			return;

		}

		if ( ! this.bvhStorageNode ) {

			log.error( 'BVH data required' );
			return;

		}

		// If compute nodes already exist, update texture nodes in-place
		// instead of rebuilding the shader (avoids TSL recompilation issues)
		if ( this.isReady && this.shaderBuilder.getSceneTextureNodes() ) {

			this.shaderBuilder.updateSceneTextures( this );
			return;

		}

		this._ensureStorageTextures();

		// Build the shared scene texture nodes (prev*, adaptive, scene textures, gobo/IES) the kernels read.
		this.shaderBuilder.createSceneTextureNodes( this, this.storageTextures );

		this.isReady = true;

	}

	/**
	 * Ensure storage textures exist at correct size
	 */
	_ensureStorageTextures() {

		const canvas = this.renderer.domElement;
		const width = Math.max( 1, canvas.width || this.width );
		const height = Math.max( 1, canvas.height || this.height );

		if ( this.storageTextures.ensureSize( width, height ) ) {

			this.resolution.value.set( width, height );

		}

	}

	/**
	 * Handle canvas resize
	 */
	_handleResize() {

		const canvas = this.renderer.domElement;
		const { width, height } = canvas;

		if ( width !== this.storageTextures.renderWidth || height !== this.storageTextures.renderHeight ) {

			this.createStorageTextures( width, height );
			this.frameCount = 0;

		}

		this.resolution.value.set( width, height );

	}

	/**
	 * Compare two Matrix4 with tolerance to avoid false positives from
	 * floating-point drift (e.g. OrbitControls spherical↔cartesian round-trips).
	 * @param {Matrix4} a
	 * @param {Matrix4} b
	 * @param {number} epsilon
	 * @returns {boolean} True if matrices are approximately equal
	 */
	_matricesApproxEqual( a, b, epsilon = 1e-10 ) {

		const ae = a.elements;
		const be = b.elements;
		for ( let i = 0; i < 16; i ++ ) {

			if ( Math.abs( ae[ i ] - be[ i ] ) > epsilon ) return false;

		}

		return true;

	}

	/**
	 * Update camera uniforms
	 * @returns {boolean} True if camera changed
	 */
	_updateCameraUniforms() {

		if ( ! this._matricesApproxEqual( this.lastCameraMatrix, this.camera.matrixWorld ) ||
			! this._matricesApproxEqual( this.lastProjectionMatrix, this.camera.projectionMatrixInverse ) ) {

			this.cameraWorldMatrix.value.copy( this.camera.matrixWorld );
			this.cameraViewMatrix.value.copy( this.camera.matrixWorldInverse );
			this.cameraProjectionMatrix.value.copy( this.camera.projectionMatrix );
			this.cameraProjectionMatrixInverse.value.copy( this.camera.projectionMatrixInverse );

			this.lastCameraMatrix.copy( this.camera.matrixWorld );
			this.lastProjectionMatrix.copy( this.camera.projectionMatrixInverse );

			return true;

		}

		return false;

	}

	/**
	 * Update accumulation uniforms
	 * @param {number} frameValue
	 */
	_updateAccumulationUniforms( frameValue ) {

		const currentInteractionMode = this.cameraOptimizer?.isInInteractionMode() ?? false;
		this.lastInteractionModeState = currentInteractionMode;

		if ( this.accumulationEnabled ) {

			if ( currentInteractionMode ) {

				this.accumulationAlpha.value = 1.0;
				this.hasPreviousAccumulated.value = 0;

			} else {

				this.accumulationAlpha.value = calculateAccumulationAlpha( frameValue );

				this.hasPreviousAccumulated.value = frameValue > 0 ? 1 : 0;

			}

		} else {

			this.accumulationAlpha.value = 1.0;
			this.hasPreviousAccumulated.value = 0;

		}

	}

	/**
	 * Publish textures to pipeline context
	 * @param {PipelineContext} context
	 * @param {Object} writeTex - The just-written StorageTexture set { color, normalDepth, albedo }
	 */
	_publishTexturesToContext( context, writeTex ) {

		context.setTexture( 'pathtracer:color', writeTex.color );
		context.setTexture( 'pathtracer:normalDepth', writeTex.normalDepth );
		context.setTexture( 'pathtracer:albedo', writeTex.albedo );

		// Not the same as the context's own `accumulatedFrames`, which counts pipeline renders — this
		// freezes when the frame retires or the camera moves, which is what a denoiser needs.
		context.setState( 'pathtracer:samples', this.frameCount );
		context.setState( 'interactionMode', this.cameraOptimizer?.isInInteractionMode() ?? false );
		context.setState( 'renderMode', this.renderMode.value );

	}

	/**
	 * Emit state change events
	 */
	_emitStateEvents() {

		this.emit( 'pathtracer:frameComplete', {
			frame: this.frameCount,
			isComplete: this.isComplete
		} );

		if ( this.cameraChanged ) {

			this.emit( 'camera:moved' );
			this.cameraChanged = false;

		}

	}

	/**
	 * Update completion threshold based on render mode. The ceiling holds in every limit mode —
	 * uncapping it under a time budget lets a generous deadline silently slow every render.
	 */
	updateCompletionThreshold() {

		this.completionThreshold = updateCompletionThreshold(
			this.renderMode.value,
			this.maxSamples.value
		);

	}

	setRenderLimitMode( mode ) {

		this.renderLimitMode = mode;
		this.updateCompletionThreshold();

	}

	// ===== ASVGF DENOISING MANAGEMENT =====

	manageASVGFForRenderMode( renderMode ) {

		if ( renderMode !== this.lastRenderMode ) {

			if ( this.renderModeChangeTimeout ) {

				clearTimeout( this.renderModeChangeTimeout );

			}

			this.pendingRenderMode = renderMode;

			this.renderModeChangeTimeout = setTimeout( () => {

				if ( this.pendingRenderMode !== null && this.pendingRenderMode !== this.lastRenderMode ) {

					this.lastRenderMode = this.pendingRenderMode;
					// History from the previous mode is not comparable. temporalAlpha is NOT
					// touched here — it is owned by ASVGF_QUALITY_PRESETS, and overwriting it
					// with a hardcoded value meant `medium` and `high` never took effect.
					this.emit( 'asvgf:reset' );
					this.emit( 'denoiser:reset' );

				}

				this.renderModeChangeTimeout = null;
				this.pendingRenderMode = null;

			}, this.renderModeChangeDelay );

		}

	}

	// ===== UNIFORM & DATA SETTERS =====

	/**
	 * Generic uniform setter. Handles booleans (→ int 0/1),
	 * vectors/matrices (→ .copy()), and plain scalars automatically.
	 * @param {string} name - Uniform name (e.g. 'maxBounces', 'showBackground')
	 * @param {*} value
	 */
	setUniform( name, value ) {

		this.uniforms.set( name, value );

	}

	/**
	 * Rebuild the packed light buffer from cached lightBVH + emissive data.
	 * Layout: [ lightBVH (LBVH_STRIDE vec4s per node) | emissive (EMISSIVE_STRIDE vec4s per entry) ].
	 * Also updates `emissiveVec4Offset` uniform (in vec4 elements).
	 *
	 * The compiled wavefront kernels bind the attribute that existed at kernel-build
	 * time and NEVER pick up a `lightStorageNode.value` reassignment — so runtime
	 * updates MUST write in-place into the bound attribute (+ needsUpdate). Only
	 * grow-reallocate when the data outgrows capacity, and flag it so the kernels
	 * get rebuilt against the new attribute.
	 * @private
	 */
	_rebuildLightBuffer() {

		const LBVH_STRIDE = 4; // vec4s per LBVH node — must match LightBVHSampling.js
		const lbvh = this._lbvhDataCache;
		const emis = this._emissiveDataCache;
		// The bit-trail map (4 B a triangle) lives only in the light buffer: without a new one, the
		// current one is carried over from there rather than kept as a second copy.
		const held = this.lightStorageAttr?.array;
		const trail = this._bitTrailMapCache
			?? ( held && this._bitTrailLength ? held.slice( this._bitTrailOffset, this._bitTrailOffset + this._bitTrailLength ) : null );
		this._bitTrailMapCache = null;
		const lbvhLen = lbvh ? lbvh.length : 0;
		const emisLen = emis ? emis.length : 0;
		// Bit-trail map packs 4 trails per vec4 → pad to a vec4 boundary.
		const trailPadded = trail ? Math.ceil( trail.length / 4 ) * 4 : 0;

		// Ensure at least a minimal non-empty buffer so GPU allocation remains valid.
		const totalLen = Math.max( lbvhLen + emisLen + trailPadded, 4 );

		if ( this.lightStorageAttr && totalLen <= this.lightStorageAttr.array.length ) {

			// In-place update of the bound attribute. Stale floats past the new data
			// are unreachable — all reads are gated by the count/offset uniforms.
			const arr = this.lightStorageAttr.array;
			if ( lbvh ) arr.set( lbvh, 0 );
			if ( emis ) arr.set( emis, lbvhLen );
			if ( trail ) arr.set( trail, lbvhLen + emisLen );
			this.lightStorageAttr.needsUpdate = true;

		} else {

			const combined = new Float32Array( totalLen );
			if ( lbvh ) combined.set( lbvh, 0 );
			if ( emis ) combined.set( emis, lbvhLen );
			if ( trail ) combined.set( trail, lbvhLen + emisLen );

			this.lightStorageAttr = new StorageInstancedBufferAttribute( combined, 4 );
			this.lightStorageNode.value = this.lightStorageAttr;
			this.lightStorageNode.bufferCount = combined.length / 4;

			// Already-compiled kernels still bind the old attribute — request a rebuild.
			// (During scene load this is a no-op: setupMaterial rebuilds kernels anyway.)
			this._lightBufferRealloc = true;

		}

		// Offset (in vec4 elements) where emissive data starts.
		this.emissiveVec4Offset.value = ( this.lightBVHNodeCount.value || 0 ) * LBVH_STRIDE;
		// Offset (in vec4 elements) where the bit-trail map starts (lbvhLen + emisLen are float
		// counts, both multiples of 4, so this divides cleanly).
		this.reverseMapVec4Offset.value = ( lbvhLen + emisLen ) / 4;
		this._bitTrailOffset = lbvhLen + emisLen;
		this._bitTrailLength = trail ? trail.length : 0;

	}

	setEmissiveTriangleData( emissiveData, count, totalPower = 0, bitTrailMap = null ) {

		if ( ! emissiveData ) return;

		this._emissiveDataCache = emissiveData;
		if ( bitTrailMap ) this._bitTrailMapCache = bitTrailMap;
		this.emissiveTriangleCount.value = count;
		this.emissiveTotalPower.value = totalPower;
		this._rebuildLightBuffer();
		log.debug( `${fmt.n( count )} emissive triangles · totalPower ${totalPower.toFixed( 4 )} (storage buffer)` );

	}

	setLightBVHData( nodeData, nodeCount ) {

		if ( ! nodeData ) return;

		this._lbvhDataCache = nodeData;
		this.lightBVHNodeCount.value = nodeCount;
		this._rebuildLightBuffer();
		log.debug( `light BVH ${fmt.n( nodeCount )} nodes` );

	}

	// ===== UTILITY METHODS =====

	updateUniforms( updates ) {

		let hasChanges = false;

		for ( const [ key, value ] of Object.entries( updates ) ) {

			if ( this[ key ] && this[ key ].value !== undefined ) {

				if ( this[ key ].value !== value ) {

					this[ key ].value = value;
					hasChanges = true;

				}

			}

		}

		if ( hasChanges ) {

			this.reset();

		}

	}

	async rebuildMaterials( scene ) {

		if ( ! this.sdfs ) {

			throw new Error( "Scene not built yet. Call build() first." );

		}

		try {

			log.debug( 'material rebuild started' );

			await this.sdfs.rebuildMaterials( scene );
			// Materials and textures only. `sdfs` is not the processor that built the scene
			// (PathTracerApp._sdf is), so re-uploading everything from it put its empty emissive
			// data and instance table in place of the scene's: emitters stopped being sampled.
			this.materialData.setMaterialData( this.sdfs.materialData, this.sdfs.materials?.map( m => m.sources ) );
			this.materialData.loadTexturesFromSdfs();
			this.shaderBuilder.updateSceneTextures( this );
			this.updateLights();
			this.reset();

			log.debug( 'material rebuild complete' );

		} catch ( error ) {

			log.error( 'material rebuild failed:', error );

			try {

				log.warn( 'attempting recovery by resetting the path tracer' );
				this.reset();

			} catch ( recoveryError ) {

				log.error( 'recovery failed:', recoveryError );

			}

			throw error;

		}

	}

	// ===== DISPOSE =====

	/**
	 * Disposes of GPU resources.
	 */
	dispose() {

		// Clear timeouts
		if ( this.renderModeChangeTimeout ) {

			clearTimeout( this.renderModeChangeTimeout );
			this.renderModeChangeTimeout = null;

		}

		// Dispose managers
		this.cameraOptimizer?.dispose();
		this.materialData?.dispose();
		this.environment?.dispose();
		this.shaderBuilder?.dispose();
		this.uniforms?.dispose();

		// Dispose storage textures
		this.storageTextures?.dispose();

		// Dispose textures
		this.placeholderTexture?.dispose();

		// Clear data references
		this.triangleGeoAttr = null;
		this.triangleShadeAttr = null;
		this._triangleStaging = null;
		this._triangleRecords = null;
		this._triangleFlat = null;
		this._triangleRecordCount = 0;
		this.triangleStorageNode = null;
		this.bvhStorageAttr = null;
		this._bvhRecords = null;
		this.bvhStorageNode = null;
		this.placeholderTexture = null;

		this.isReady = false;

	}

}
