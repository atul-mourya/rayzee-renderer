import { storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import {
	NearestFilter, Vector2, Matrix4,
	TextureLoader, RepeatWrapping
} from 'three';
import { stbnScalarTextureNode, stbnVec2TextureNode } from '../TSL/Random.js';

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
import { ENGINE_DEFAULTS as DEFAULT_STATE } from '../EngineDefaults.js';
import { getAssetConfig } from '../AssetConfig.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'pathtracer' );

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
		// Triangle data carries the per-triangle `side` flag (NORMAL_C.w). The
		// authoritative CPU array is triangleStorageAttr.array (not sdfs.triangleData,
		// which isn't populated on the PathTracerApp build path). The patch mutates
		// the array in place — only a dirty flag is needed for GPU re-upload.
		this.materialData.callbacks.getTriangleData = () => ( {
			array: this.triangleStorageAttr?.array,
			count: this.triangleCount,
		} );
		this.materialData.callbacks.onTriangleDataChanged = () => {

			if ( this.triangleStorageAttr ) this.triangleStorageAttr.needsUpdate = true;

		};

		// Initialize environment manager
		this.environment = new EnvironmentManager( this.scene, this.uniforms );
		this.environment.callbacks.onReset = () => this.reset();
		this.environment.callbacks.getSceneTextureNodes = () => this.shaderBuilder.getSceneTextureNodes();

		// Initialize shader composer
		this.shaderBuilder = new ShaderBuilder();

		// Initialize rendering state
		this._initRenderingState();

		// Setup blue noise
		this.setupBlueNoise();

		// Cache frequently used objects
		this.tempVector2 = new Vector2();
		this.lastCameraMatrix = new Matrix4();
		this.lastProjectionMatrix = new Matrix4();

		// Sampler seed axis — advances per rendered frame, survives accumulation resets.
		// Pinned back to the accumulation index in deterministic mode.
		this._seedTick = 0;
		this._pinSeedToFrame = false;

		// Denoising management state
		this.lastRenderMode = - 1;
		this.renderModeChangeTimeout = null;
		this.renderModeChangeDelay = 50;
		this.pendingRenderMode = null;

		// Track interaction mode state for accumulation
		this.lastInteractionModeState = false;

		// Track changes for event emission
		this.cameraChanged = false;

		// Update completion threshold
		this.updateCompletionThreshold();

	}

	/**
	 * Initialize data texture references and metadata
	 */
	_initDataTextures() {

		// Triangle data (storage buffer for WebGPU)
		this.triangleStorageAttr = null;
		this.triangleStorageNode = null;
		this.triangleCount = 0;

		// BVH data (storage buffer for WebGPU)
		this.bvhStorageAttr = null;
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

		// STBN noise textures
		this.stbnScalarTexture = null;
		this.stbnVec2Texture = null;

		/**
		 * Resolves once both STBN atlases have loaded. Await before any render whose
		 * output must be reproducible — see PathTracerApp.setDeterministicMode().
		 * Replaced by the real promise in setupBlueNoise(), which runs after this.
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
				maxBounceCount: {
					get value() {

						return self.maxBounces.value;

					},
					set value( v ) {

						self.maxBounces.value = v;

					}
				},
				enableAccumulation: {
					get value() {

						return self.enableAccumulation.value;

					},
					set value( v ) {

						self.enableAccumulation.value = v;

					}
				},
				enableEmissiveTriangleSampling: {
					get value() {

						return self.enableEmissiveTriangleSampling.value;

					},
					set value( v ) {

						self.enableEmissiveTriangleSampling.value = v;

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
			qualitySettings: {
				maxBounceCount: 1,
				enableAccumulation: false,
				enableEmissiveTriangleSampling: false,
			},
			onReset: () => {

				this.reset();
				this.emit( 'pathtracer:viewpointChanged' );

			}
		} );

	}

	/**
	 * Load STBN (Spatiotemporal Blue Noise) atlas textures.
	 * Each atlas is 1024×1024: 8×8 grid of 128×128 tiles, 64 temporal slices.
	 */
	setupBlueNoise() {

		const loader = new TextureLoader();
		loader.setCrossOrigin( 'anonymous' );

		const configure = ( tex ) => {

			tex.minFilter = NearestFilter;
			tex.magFilter = NearestFilter;
			tex.wrapS = RepeatWrapping;
			tex.wrapT = RepeatWrapping;
			tex.generateMipmaps = false;
			return tex;

		};

		const { stbnScalarAtlas, stbnVec2Atlas } = getAssetConfig();

		const scalarLoad = loader.loadAsync( stbnScalarAtlas ).then( ( tex ) => {

			this.stbnScalarTexture = configure( tex );
			stbnScalarTextureNode.value = tex;
			log.debug( `STBN scalar atlas ${fmt.px( tex.image.width, tex.image.height )}` );

		} );

		const vec2Load = loader.loadAsync( stbnVec2Atlas ).then( ( tex ) => {

			this.stbnVec2Texture = configure( tex );
			stbnVec2TextureNode.value = tex;
			log.debug( `STBN vec2 atlas ${fmt.px( tex.image.width, tex.image.height )}` );

		} );

		// Until the atlases land the STBN sampler reads a constant-0.5 placeholder and bakes
		// that degenerate "noise" permanently into the accumulation buffer. The cut-over frame
		// is disk/network dependent, so reproducible renders must await this. Never rejects.
		this.blueNoiseReady = Promise.allSettled( [ scalarLoad, vec2Load ] ).then( ( results ) => {

			for ( const result of results ) {

				if ( result.status === 'rejected' ) log.warn( 'STBN atlas failed to load', result.reason );

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
		this.materialData.setMaterialData( this.sdfs.materialData );

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

		// Add sun as directional light if procedural sky is active
		if ( this.hasSun.value ) {

			const scaledSunIntensity = this.environment.envParams.skySunIntensity * 950.0;

			const sunLight = {
				intensity: scaledSunIntensity,
				color: { r: 1.0, g: 1.0, b: 1.0 },
				userData: {
					angle: this.sunAngularSize.value
				},
				updateMatrixWorld: () => {},
				getWorldPosition: ( target ) => {

					const sunDir = this.sunDirection.value;
					return target.set( sunDir.x, sunDir.y, sunDir.z ).multiplyScalar( 1e10 );

				}
			};

			this.lightSerializer.addDirectionalLight( sunLight );
			this.lightSerializer.preprocessLights();
			this.lightSerializer.updateShaderUniforms( mockMaterial );

			this.directionalLightsData = mockMaterial.uniforms.directionalLights.value;

			log.debug( `sun added as directional light · intensity ${scaledSunIntensity.toFixed( 2 )}` );

		}

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

		// Only deterministic mode rewinds the seed axis; see _pinSeedToFrame.
		if ( this._pinSeedToFrame ) this._seedTick = 0;

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

	// ===== TEXTURE SETTERS =====

	/**
	 * Sets the triangle data from raw Float32Array via storage buffer.
	 * On first call, creates the storage buffer and node.
	 * On subsequent calls, creates a new attribute with the correct size
	 * and updates the storage node's value to preserve shader graph references.
	 * @param {Float32Array} triangleData - Raw triangle data
	 * @param {number} triangleCount - Number of triangles
	 */
	setTriangleData( triangleData, triangleCount ) {

		if ( ! triangleData ) return;

		const vec4Count = triangleData.length / 4;

		if ( this.triangleStorageNode ) {

			// Create new attribute with correct size (old one is GC'd, backend WeakMap cleans up GPU buffer)
			this.triangleStorageAttr = new StorageInstancedBufferAttribute( triangleData, 4 );

			// Update storage node references (preserves compiled shader graph)
			this.triangleStorageNode.value = this.triangleStorageAttr;
			this.triangleStorageNode.bufferCount = vec4Count;

		} else {

			// First time: create storage buffer and node
			this.triangleStorageAttr = new StorageInstancedBufferAttribute( triangleData, 4 );
			this.triangleStorageNode = storage( this.triangleStorageAttr, 'vec4', vec4Count ).toReadOnly();

		}

		this.triangleCount = triangleCount;

		log.debug( `${fmt.n( this.triangleCount )} triangles (storage buffer)` );

	}

	/**
	 * Sets the BVH data from raw Float32Array via storage buffer.
	 * @param {Float32Array} bvhImageData - Raw BVH data from DataTexture.image.data
	 */
	setBVHData( bvhImageData ) {

		if ( ! bvhImageData ) return;

		const vec4Count = bvhImageData.length / 4;

		if ( this.bvhStorageNode ) {

			this.bvhStorageAttr = new StorageInstancedBufferAttribute( bvhImageData, 4 );
			this.bvhStorageNode.value = this.bvhStorageAttr;
			this.bvhStorageNode.bufferCount = vec4Count;

		} else {

			this.bvhStorageAttr = new StorageInstancedBufferAttribute( bvhImageData, 4 );
			this.bvhStorageNode = storage( this.bvhStorageAttr, 'vec4', vec4Count ).toReadOnly();

		}

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

		for ( let i = 0; i < meshes.length; i ++ ) {

			this._patchTLASLeafVisibility( i, this._isWorldVisible( meshes[ i ] ) );

		}

		if ( this.bvhStorageAttr ) this.bvhStorageAttr.needsUpdate = true;

	}

	/**
	 * Update visibility for a single mesh by patching its TLAS leaf slot [2].
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	updateMeshVisibility( meshIndex, visible ) {

		if ( ! this._patchTLASLeafVisibility( meshIndex, visible ) ) return;
		if ( this.bvhStorageAttr ) this.bvhStorageAttr.needsUpdate = true;

	}

	/**
	 * Recompute world-visibility for all meshes and patch TLAS leaves in place.
	 * Call this when group visibility changes at runtime.
	 */
	updateAllMeshVisibility() {

		if ( ! this._meshRefs || ! this._instanceTable ) return;

		for ( let i = 0; i < this._meshRefs.length; i ++ ) {

			this._patchTLASLeafVisibility( i, this._isWorldVisible( this._meshRefs[ i ] ) );

		}

		if ( this.bvhStorageAttr ) this.bvhStorageAttr.needsUpdate = true;

	}

	/**
	 * Patch a single TLAS leaf's visibility flag in the combined BVH buffer.
	 * Returns true if the patch was applied.
	 * @private
	 */
	_patchTLASLeafVisibility( meshIndex, visible ) {

		const entry = this._instanceTable?.entries?.[ meshIndex ];
		if ( ! entry || entry.tlasLeafIndex < 0 || ! this.bvhStorageAttr ) return false;

		entry.visible = visible;
		this.bvhStorageAttr.array[ entry.tlasLeafIndex * 16 + 2 ] = visible ? 1.0 : 0.0;
		return true;

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
		attr.needsUpdate = true;

	}

	/** Update triangle positions in the existing GPU buffer (full). */
	updateTriangleData( triangleData ) {

		this._updateStorageBuffer( this.triangleStorageAttr, triangleData );

	}

	/** Update BVH node data in the existing GPU buffer (full). */
	updateBVHData( bvhData ) {

		this._updateStorageBuffer( this.bvhStorageAttr, bvhData );

	}

	/**
	 * Update only specific ranges of the GPU storage buffers.
	 * Uses addUpdateRange for partial GPU upload instead of full buffer copy.
	 *
	 * @param {Array<{offset: number, count: number}>} triRanges - Dirty triangle ranges (element index + count)
	 * @param {Array<{offset: number, count: number}>} bvhRanges - Dirty BVH node ranges (element index + count)
	 */
	updateBufferRanges( triRanges, bvhRanges ) {

		if ( this.triangleStorageAttr && triRanges.length > 0 ) {

			this.triangleStorageAttr.clearUpdateRanges();

			for ( const r of triRanges ) {

				this.triangleStorageAttr.addUpdateRange( r.offset, r.count );

			}

			this.triangleStorageAttr.version ++;

		}

		if ( this.bvhStorageAttr && bvhRanges.length > 0 ) {

			this.bvhStorageAttr.clearUpdateRanges();

			for ( const r of bvhRanges ) {

				this.bvhStorageAttr.addUpdateRange( r.offset, r.count );

			}

			this.bvhStorageAttr.version ++;

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
	 * @param {number} renderMode
	 */
	_updateAccumulationUniforms( frameValue, renderMode ) {

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

	setBlueNoiseTexture( tex ) {

		// Legacy API — sets the scalar STBN atlas texture
		this.stbnScalarTexture = tex;
		if ( tex ) stbnScalarTextureNode.value = tex;

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
		const trail = this._bitTrailMapCache;
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
			this.updateSceneUniforms();
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
		this.stbnScalarTexture?.dispose();
		this.stbnVec2Texture?.dispose();
		this.placeholderTexture?.dispose();

		// Clear data references
		this.triangleStorageAttr = null;
		this.triangleStorageNode = null;
		this.bvhStorageAttr = null;
		this.bvhStorageNode = null;
		this.placeholderTexture = null;

		this.isReady = false;

	}

}
