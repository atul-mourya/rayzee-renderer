// SceneProcessor.js - Processes scene geometry into GPU-ready data (BVH, textures, materials)
import { BVHBuilder } from './BVHBuilder.js';
import { BVHRefitter } from './BVHRefitter.js';
import { buildBVHParallel, shouldUseParallelBuild } from './ParallelBVHBuilder.js';
import { TLASBuilder } from './TLASBuilder.js';
import { InstanceTable, isIdentity, multiplyAffine } from './InstanceTable.js';
import { ChunkedRecords, SHARED_MEMORY_AVAILABLE, setChunkObserver, DEFAULT_CHUNK_BYTES } from './ChunkedRecords.js';
import {
	MemoryLedger, estimateSceneBytes, probeAddressSpace,
	PREFLIGHT_MIN_BYTES, PREFLIGHT_SAFETY, SAFE_SCENE_BYTES, MAX_SCENE_BYTES,
} from './HostMemory.js';
import { TextureCreator } from './TextureCreator.js';
import { GeometryExtractor, geometryBytesOf } from './GeometryExtractor.js';
import { EmissiveTriangleBuilder } from './EmissiveTriangleBuilder.js';
import { updateLoading } from '../Processor/utils.js';
import { BuildTimer } from './BuildTimer.js';
import { createLogger, fmt, workerLogLevel } from '../utils/Logger.js';
import { SRGBColorSpace } from 'three';
import {
	TRIANGLE_DATA_LAYOUT, TEXTURE_CONSTANTS, getTextureBucketId, packTextureIndex, planTextureBuckets,
	packNormalOct, BVH_LEAF_MARKERS, assertBVHIndexFits, bvhIndexView, TLAS_PLACEMENT_MASK, TRI_MATERIAL_MASK } from '../EngineDefaults.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { BLAS_CACHE_FORMAT, openBLASCache, saveBLASCache, templateChecksums, readNodesInto, readOrder } from '../Storage/BLASCache.js';
import { sharedStorage } from '../Storage/shared.js';
import { SpillStore } from '../Storage/SpillStore.js';
import { GeometrySpill } from '../Storage/GeometrySpill.js';
import { getAssetConfig } from '../AssetConfig.js';
import { VERSION } from '../version.js';
import { SCENE_CACHE_MIN_BUILD_MS } from '../Storage/sceneCachePolicy.js';
import BVHWorker from './Workers/BVHWorker.js?worker&inline';
import BVHRefitWorker from './Workers/BVHRefitWorker.js?worker&inline';
import TLASWorker from './Workers/TLASWorker.js?worker&inline';

// Under this the TLAS build is a few ms; the worker round trip would cost more than it saves.
const TLAS_WORKER_MIN_ENTRIES = 50_000;

// Meshes past this build across every core, one at a time.
const LARGE_MESH_TRIANGLES = 200000;
// A streamed build's extraction waits while more triangle records than this are in memory.
const STREAM_RESIDENT_BYTES = 1.5 * 1024 ** 3;
// Extraction waits while more three.js geometry than this is queued for disk.
const GEOMETRY_QUEUE_BYTES = 256 * 1024 * 1024;

const log = createLogger( 'scene' );

function largestMeshTriangles( object ) {

	let largest = 0;
	object.traverse( node => {

		const g = node.isMesh ? node.geometry : null;
		if ( g ) largest = Math.max( largest, Math.ceil( ( g.index ? g.index.count : ( g.attributes.position?.count ?? 0 ) ) / 3 ) );

	} );
	return largest;

}

/**
 * SceneProcessor - Processes scene geometry into GPU-ready data:
 * BVH acceleration, texture atlas, material buffers.
 */
export class SceneProcessor {

	/**
     * Create a new SceneProcessor
     * @param {Object} options - Configuration options
     * @param {boolean} [options.useWorkers=true] - Use worker threads when available
     * @param {number} [options.bvhDepth=30] - Maximum BVH tree depth
     * @param {number} [options.maxLeafSize=4] - Maximum triangles per BVH leaf
     * @param {boolean} [options.verbose=false] - Enable verbose logging
     * @param {boolean} [options.useFloat32Array=true] - Use Float32Array for triangle data
     * @param {string} [options.textureQuality='adaptive'] - Texture quality mode
     * @param {boolean} [options.enableTextureCache=true] - Enable texture caching
     * @param {import('../EngineIssues.js').IssueLog} [options.issues] - forwarded to TextureCreator
     * @param {number} [options.maxSceneBytes] - refuse a scene estimated above this many CPU
     *   bytes. Defaults to {@link MAX_SCENE_BYTES}; past it the renderer process dies rather
     *   than throwing, so there is nothing to catch. Raise it to try a bigger scene anyway.
     */
	constructor( options = {} ) {

		// Configuration options with defaults
		this.config = {
			useWorkers: true, // Enable workers by default for peak performance
			bvhDepth: 30,
			maxLeafSize: 4,
			verbose: false,
			useFloat32Array: true,
			textureQuality: 'adaptive', // 'low', 'medium', 'high', 'adaptive'
			maxTextureSize: TEXTURE_CONSTANTS.DEFAULT_MAX_TEXTURE_SIZE, // longest-edge cap for material textures
			enableTextureCache: true,
			maxConcurrentTextureTasks: Math.min( navigator.hardwareConcurrency || 4, 6 ),
			maxSceneBytes: MAX_SCENE_BYTES,
			// Treelet optimization configuration
			// Keep: `_buildBVH` sends `enabled: value !== false`, so undefined re-enables treelets.
			enableTreeletOptimization: false,
			treeletSize: 7, // 7 nodes gives 315 topologies for optimal enumeration
			treeletOptimizationPasses: 1,
			treeletMinImprovement: 0.01, // Minimum SAH improvement threshold
			// Above this triangle count the builder drops treelets to size 3.
			treeletComplexityThreshold: 50000,
			// Store the per-mesh BVHs of a scene whose build took at least this long (needs a sceneKey).
			sceneCache: true,
			sceneCacheMinBuildMs: SCENE_CACHE_MIN_BUILD_MS,
			...options
		};

		// Initialize geometry data containers
		this.triangleData = null; // uint lanes; this.triangleFloats views the same memory
		this.triangleFloats = null;
		this.triangleCount = 0; // Number of triangles
		this.materials = [];
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.displacementMaps = [];
		this.anisotropyMaps = [];
		this.transmissionMaps = [];
		this.clearcoatMaps = [];
		this.clearcoatRoughnessMaps = [];
		this.sheenColorMaps = [];
		this.sheenRoughnessMaps = [];
		this.iridescenceMaps = [];
		this.iridescenceThicknessMaps = [];
		this.specularIntensityMaps = [];
		this.specularColorMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;

		// Raw data for storage buffers
		this.bvh = null;
		this.bvhData = null;
		this.bvhIndexChunks = null;
		this.bvhIndex = null;
		this.materialData = null;

		// Two-level BVH (TLAS/BLAS) support
		this.instanceTable = null; // Per-mesh BLAS metadata
		this._refitWorker = null;
		this._refitSharedBuffers = null; // SharedArrayBuffer refs for zero-copy refit
		this._rebuildGeneration = 0; // Monotonic counter to discard stale background rebuilds
		this._pendingRebuilds = new Map(); // meshIndex → worker

		// Initialize texture references.
		// Material maps are packed into consolidated size-bucketed arrays (see _bucketTextures):
		//   srgbBucketTextures[K]  — albedo + emissive  (SRGBColorSpace)
		//   linearBucketTextures[K] — normal/bump/roughness/metalness/displacement
		// A material's per-map index encodes (bucket, layer) via packTextureIndex.
		this.srgbBucketTextures = null;
		this.linearBucketTextures = null;
		this.emissiveTriangleData = null;
		this.emissiveTriangleCount = 0;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;
		this.emissiveBitTrailMap = null;

		// Initialize processing components
		this._initProcessors();

		// Processing state
		this.isProcessing = false;
		this.processingStage = null;

		// What the build spent, by phase, and what the preflight expected it to spend.
		this.memory = new MemoryLedger();
		this.memoryPreflight = null;

		// Performance tracking
		this.performanceMetrics = {
			textureCreationTime: 0,
			geometryExtractionTime: 0,
			bvhBuildTime: 0,
			blasBuildTime: 0,
			// Summed per-mesh build time reported by the workers. Divided by blasBuildTime it
			// gives how many workers were actually busy — a health signal, not a cost.
			blasWorkerTime: 0,
			tlasBuildTime: 0,
			bvhAssembleTime: 0,
			totalProcessingTime: 0
		};

	}

	/**
	 * Set the max material-texture dimension applied on the next scene build.
	 * @param {number} size - Longest-edge cap (clamped to the hardware ceiling).
	 */
	setMaxTextureSize( size ) {

		this.config.maxTextureSize = size;
		return this.textureCreator?.setMaxTextureSize( size );

	}

	/**
     * Initialize processing components with configuration
     * @private
     */
	_initProcessors() {

		// Create and configure geometry extractor
		this.geometryExtractor = new GeometryExtractor( { issues: this.config.issues } );

		// Create and configure BVH builder
		this.bvhBuilder = new BVHBuilder();
		this.bvhBuilder.maxLeafSize = this.config.maxLeafSize;

		// Configure treelet optimization
		this.bvhBuilder.setTreeletConfig( {
			enabled: this.config.enableTreeletOptimization,
			size: this.config.treeletSize,
			passes: this.config.treeletOptimizationPasses,
			minImprovement: this.config.treeletMinImprovement,
			complexityThreshold: this.config.treeletComplexityThreshold
		} );

		// Create and configure texture creator
		this.textureCreator = new TextureCreator( { maxTextureSize: this.config.maxTextureSize, issues: this.config.issues } );
		// The optimized TextureCreator will auto-detect capabilities and select optimal methods

		// Create emissive triangle builder for direct lighting
		this.emissiveTriangleBuilder = new EmissiveTriangleBuilder();

		// Create TLAS builder for two-level BVH
		this.tlasBuilder = new TLASBuilder();
		this._tlasWorker = null;
		this._tlasWorkerFailed = false;

	}

	/**
     * Log message if verbose mode is enabled
     * @private
     */
	_log( message, data ) {

		// Visibility is the log level's job now; config.verbose no longer gates this.
		if ( data !== undefined ) log.debug( message, data );
		else log.debug( message );

	}

	/**
	 * Price the scene before the build starts spending, and say so if it is over what a healthy
	 * session can place.
	 *
	 * Estimate only — no allocation. Probing the whole scene up front was measurably worse than
	 * not checking: the probe's peak lands on top of the parse's, and a 9 GB probe taken while
	 * the parser still held 3.6 GB doubled a 40M load from 135 s to 268 s. The allocation test
	 * belongs at the step that actually runs out, which is
	 * {@link SceneProcessor#_checkAssemblyHeadroom}.
	 *
	 * The geometry figure reads before `_compressAttributes` halves normals and colours, so it
	 * runs ~7% high on a typical scene. That direction is the safe one.
	 * @private
	 */
	_preflightMemory( object ) {

		const maxBytes = this.config.maxSceneBytes ?? MAX_SCENE_BYTES;
		const survey = this.geometryExtractor.surveyScene( object );
		const estimate = estimateSceneBytes( survey );
		// Spilled as it is built, the BVH is never resident as a whole.
		if ( this._progressive ) estimate.total -= estimate.bvh;
		// Streamed, neither are the triangles: what is held is the resident cap plus the largest
		// mesh in the parallel builder — its copy and 44 B a triangle of scratch, the store's own
		// chunks for it let go meanwhile.
		if ( this._streaming ) {

			const resident = STREAM_RESIDENT_BYTES + largestMeshTriangles( object ) * ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 + 44 );
			estimate.total -= Math.max( 0, estimate.triangles - resident );

		}

		const report = {
			...survey, estimate,
			safeBytes: SAFE_SCENE_BYTES, maxBytes,
			fits: estimate.total <= SAFE_SCENE_BYTES,
		};
		this.memoryPreflight = report;

		if ( estimate.total < PREFLIGHT_MIN_BYTES ) return report;

		log.debug( fmt.list( [
			`memory preflight: ${fmt.mb( estimate.total )} estimated`,
			`triangles ${fmt.mb( estimate.triangles )} · bvh ${fmt.mb( estimate.bvh )} · geometry ${fmt.mb( estimate.geometry )}`,
			`${fmt.n( survey.triangles )} tris · ${fmt.n( survey.placements )} placements`,
		] ) );

		// Past the hard line the renderer process dies rather than throwing, so there is nothing
		// to catch and nothing to degrade to. Refusing with a reason is the only useful answer.
		if ( estimate.total > maxBytes ) {

			const message = `Scene needs about ${fmt.mb( estimate.total )} of CPU memory, past the ${fmt.mb( maxBytes )} `
				+ 'a browser tab can hold — loading it would crash the tab rather than fail. '
				+ `Reduce the scene (it has ${fmt.n( survey.triangles )} triangles), or raise maxSceneBytes to try anyway.`;

			this.config.issues?.record(
				ISSUE_CODES.SCENE_MEMORY_BUDGET, message, { ...survey, estimate, maxBytes }
			);
			throw new Error( message );

		}

		if ( ! report.fits ) {

			this.config.issues?.warn(
				ISSUE_CODES.SCENE_MEMORY_BUDGET,
				`Scene needs about ${fmt.mb( estimate.total )} of CPU memory, above the ${fmt.mb( SAFE_SCENE_BYTES )} a fresh browser `
					+ 'session can usually place. It may still load, but a long-running session will probably fail during BVH assembly; '
					+ 'restarting the browser recovers the address space.',
				{ ...survey, estimate, safeBytes: SAFE_SCENE_BYTES }
			);

		}

		return report;

	}

	/**
	 * Test the one allocation that has failed every time: the combined BVH.
	 *
	 * By this point the archive and the parser's scratch are gone and the BLASes are about to be
	 * handed over chunk by chunk, so the probe is small (the BVH's own size plus headroom, ~2 GB
	 * at 40M rather than the whole scene's 9 GB) and it is asking the question at the moment the
	 * answer matters. A failure here is still only a warning — the build is allowed to try.
	 * @private
	 */
	_checkAssemblyHeadroom( totalNodes ) {

		const need = totalNodes * 64;
		if ( need < PREFLIGHT_MIN_BYTES ) return true;

		// Same flavour the store uses: shared and non-shared buffers need not come from one pool.
		const probe = probeAddressSpace( Math.ceil( need * PREFLIGHT_SAFETY ), { shared: SHARED_MEMORY_AVAILABLE } );
		if ( this.memoryPreflight ) this.memoryPreflight.assemblyProbed = probe.placed;

		if ( probe.exhausted ) {

			this.config.issues?.warn(
				ISSUE_CODES.SCENE_MEMORY_BUDGET,
				`BVH assembly needs ${fmt.mb( need )} but only ${fmt.mb( probe.placed )} could be allocated. `
					+ 'Restarting the browser usually recovers the address space.',
				{ totalNodes, need, placeable: probe.placed }
			);

		}

		return ! probe.exhausted;

	}

	/**
	 * Byte sizes of the CPU structures alive right now. Anything already released is absent,
	 * which is the point: this is what the peak is made of, not what was ever allocated.
	 * @private
	 */
	_liveMemoryParts() {

		const table = this.instanceTable;
		const parts = {
			triangles: this.triangles?.byteLength ?? 0,
			bvh: this.bvh?.byteLength ?? 0,
			geometry: this._geometryBytes ?? this.memoryPreflight?.geometryBytes ?? 0,
			placements: table?.world?.byteLength ?? 0,
			blasScratch: 0,
			orderMaps: 0,
		};

		if ( table ) {

			for ( const blas of table.blasData.values() ) parts.blasScratch += blas?.byteLength ?? 0;
			for ( const m of table.bvhToOriginal.values() ) parts.orderMaps += m?.byteLength ?? 0;
			for ( const m of table.originalToBvhMap.values() ) parts.orderMaps += m?.byteLength ?? 0;

		}

		return parts;

	}

	/**
	 * World-space bounds of everything in the BVH, as `{ min: [x,y,z], max: [x,y,z] }`.
	 *
	 * ⚠️ Node 0 is not "the root's box". A BVH inner node stores its two CHILDREN's boxes —
	 * `[Amin, Aidx, Amax, _, Bmin, Bidx, Bmax, _]` — so the first six floats are one subtree,
	 * not the scene. Reading them as the scene box is wrong and looks plausible: the two halves
	 * legitimately rebalance between a build and a refit, so the number moves while the actual
	 * bounds are unchanged. Verified against the union of all 3.7M placement AABBs at 40M.
	 *
	 * @returns {?{min: number[], max: number[]}} null before a BVH is built
	 */
	sceneBounds() {

		if ( ! this.bvh || this.bvh.recordCount === 0 ) return null;

		const chunk = this.bvh.chunkFor( 0 );
		const base = this.bvh.baseOf( 0 );
		const min = [], max = [];

		for ( let k = 0; k < 3; k ++ ) {

			min.push( Math.min( chunk[ base + k ], chunk[ base + 8 + k ] ) );
			max.push( Math.max( chunk[ base + 4 + k ], chunk[ base + 12 + k ] ) );

		}

		return { min, max };

	}

	/** @private */
	_sampleMemory( label ) {

		this.memory.sample( label, this._liveMemoryParts() );

	}

	/** One line on what the build actually cost, and whether the preflight called it right. @private */
	_logMemoryReport() {

		const { allocatedBytes, peakLiveBytes, byPhase } = this.memory;
		if ( allocatedBytes === 0 ) return;

		const phases = Object.keys( byPhase )
			.filter( name => byPhase[ name ].allocated > 0 )
			.map( name => `${name} ${fmt.mb( byPhase[ name ].allocated )}` );

		const predicted = this.memoryPreflight?.estimate?.total;

		log.debug( fmt.list( [
			`memory: peak live ${fmt.mb( peakLiveBytes )}`,
			`allocated ${fmt.mb( allocatedBytes )}`,
			predicted ? `predicted ${fmt.mb( predicted )}` : null,
			phases.join( ' · ' ),
		] ) );

	}

	/**
     * Build the BVH from a 3D object/scene
     * @param {Object3D} object - Three.js object to process
     * @returns {Promise<SceneProcessor>} - This instance (for chaining)
     */
	/**
	 * @param {Object3D} object
	 * @param {{sceneKey?: ?string}} [options] - what the scene was loaded from; enables the BLAS cache
	 */
	async buildBVH( object, { sceneKey = null, progressive = null } = {} ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing a scene. Call dispose() first." );

		}

		this.isProcessing = true;
		this.processingStage = 'init';
		this.memory.reset();
		this._geometryBytes = 0;
		// Module-global by design: one build at a time, and `isProcessing` above enforces it.
		setChunkObserver( bytes => this.memory.alloc( bytes ) );

		const timer = new BuildTimer( object.name ?? '', { namespace: 'scene' } );

		try {

			// Reset state before beginning
			this._reset();
			this._sceneKey = sceneKey;
			this._blasKey = null;
			this._blasRestored = false;
			this._progressive = progressive?.storage && progressive.uploader ? progressive : null;
			// A spilling build of more than one chunk extracts and builds its BLASes together.
			this._streaming = !! this._progressive
				&& this.geometryExtractor._countStoredTriangles( object ) > Math.floor( DEFAULT_CHUNK_BYTES / ( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4 ) );
			this._log( 'Starting scene processing' );

			// Step 0: will this scene fit in the address space this process has left?
			this.memory.mark( 'preflight' );
			this._preflightMemory( object );

			// Step 1: Extract geometry (0-20%)
			this.processingStage = 'extraction';
			this.memory.mark( 'extraction' );
			timer.start( 'Geometry extraction' );
			if ( this._streaming ) await this._extractStreaming( object );
			else await this._extractGeometry( object );
			timer.end( 'Geometry extraction' );
			this.performanceMetrics.geometryExtractionTime = timer.getDuration( 'Geometry extraction' );
			// The preflight figure was taken before `_compressAttributes` halved normals and
			// colours; every sample from here on should use what the mirror actually holds.
			this._geometryBytes = geometryBytesOf( object );
			this._sampleMemory( 'after extraction' );

			// Step 2: BVH + textures in parallel (20-95%)
			// Texture creation only needs GeometryExtractor output (materials + texture maps)
			// BVH construction is independent — run both concurrently
			this.processingStage = 'bvh';
			timer.start( 'BVH construction (worker)' );
			timer.start( 'Material textures (parallel)' );

			let texturesDone = false;
			const bvhPromise = this._buildBVH().then( () => timer.end( 'BVH construction (worker)' ) );
			const texturePromise = this._createMaterialTextures().then( () => {

				timer.end( 'Material textures (parallel)' );
				texturesDone = true;

			} );

			// Await BVH first (it drives progress and reorders triangleData).
			// Emissive extraction needs the final reordered triangle indices,
			// so it runs here — overlapping with any remaining texture work.
			await bvhPromise;

			updateLoading( { status: "Building light data...", progress: 77 } );
			timer.start( 'Emissive extraction + Light BVH' );
			this._buildEmissiveData();
			timer.end( 'Emissive extraction + Light BVH' );

			if ( ! texturesDone ) {

				updateLoading( { status: "Processing material textures...", progress: 80 } );

			}

			await texturePromise;

			this.performanceMetrics.bvhBuildTime = timer.getDuration( 'BVH construction (worker)' );
			this.performanceMetrics.textureCreationTime = timer.getDuration( 'Material textures (parallel)' );

			// Step 3: BVH data is already flattened inside the worker (or sync path).
			// Only fall back to main-thread flattening if bvhData wasn't produced.
			this.processingStage = 'finalize';
			timer.start( 'BVH data packing' );
			if ( this.bvhRoot && ! this.bvh ) {

				this._setBVHData( this.textureCreator.createBVHRawData( this.bvhRoot ) );

			}

			timer.end( 'BVH data packing' );

			// Create additional scene elements (spheres, etc.)
			this.spheres = this._createSpheres();

			// Calculate total performance
			this.performanceMetrics.totalProcessingTime = performance.now() - timer.totalStart;

			timer.print();

			this.processingStage = 'complete';
			await this._restoreGeometry( object );
			updateLoading( { status: "Scene data ready", progress: 85 } );
			if ( this._blasKey && ! this._blasRestored && this.performanceMetrics.totalProcessingTime >= this.config.sceneCacheMinBuildMs ) {

				this._blasStoring = this._storeBLASes( object.name ?? '' ).catch( ( error ) => log.debug( 'storing BLASes failed:', error ) );

			}

			return this;

		} catch ( error ) {

			this.processingStage = 'error';
			log.error( 'processing failed:', error );
			updateLoading( {
				status: `Error: ${error.message}`,
				failed: true,
				progress: 100
			} );
			throw error;

		} finally {

			// A failed build's model is discarded, so its geometry is not read back.
			this._disposeGeometrySpill();
			setChunkObserver( null );
			this._sampleMemory( `at ${this.processingStage}` );
			this._logMemoryReport();
			this.isProcessing = false;

		}

	}

	/**
     * Extract geometry data from the object
     * @private
     */
	async _extractGeometry( object ) {

		updateLoading( {
			isLoading: true,
			title: "Processing",
			status: "Extracting geometry...",
			progress: 15
		} );
		await new Promise( r => setTimeout( r, 0 ) );

		// 15-25% range for extraction

		this._log( 'Extracting geometry' );
		const startTime = performance.now();

		try {

			this._adoptExtraction( this.geometryExtractor.extract( object ) );
			const duration = performance.now() - startTime;
			this._log( `Geometry extraction complete (${duration.toFixed( 2 )}ms)`, {
				triangleCount: this.triangleCount,
				materials: this.materials.length,
			} );

			updateLoading( {
				status: `Extracted ${this.triangleCount.toLocaleString()} triangles`,
				progress: 25
			} );

		} catch ( error ) {

			log.error( 'geometry extraction failed:', error );
			updateLoading( {
				status: `Extraction error: ${error.message}`,
				failed: true,
				progress: 25
			} );
			throw error;

		}

	}

	/**
	 * Extraction and the BLAS builds together, for a spilling build of several chunks. Each
	 * stored range goes to a worker the moment it is written, each chunk whose BLASes are all
	 * built goes to the GPU and then to disk, and the extraction waits whenever more than
	 * STREAM_RESIDENT_BYTES of triangles are still in memory — so the records are never all
	 * resident at once, which they are at the start of the BLAS phase otherwise.
	 * @private
	 */
	async _extractStreaming( object ) {

		updateLoading( { isLoading: true, title: 'Processing', status: 'Extracting geometry and building BVHs...', progress: 15 } );
		await new Promise( r => setTimeout( r, 0 ) );
		const startTime = performance.now();

		const extractor = this.geometryExtractor;
		const { storage, uploader } = this._progressive;
		const key = `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}`;
		const capacity = extractor._countStoredTriangles( object );
		const probe = ChunkedRecords.lazy( capacity, TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE, Uint32Array );
		const stride = probe.recordsPerChunk * probe.lanesPerRecord * 4;

		const triStore = await SpillStore.create( storage, `${key}:tri`, stride, { label: 'Triangle records', expectedBytes: capacity * stride / probe.recordsPerChunk } );
		const blasStore = triStore && await SpillStore.create( storage, `${key}:blas`, 0, { label: 'BLAS nodes (while building)' } );
		if ( ! blasStore ) {

			await triStore?.dispose();
			this._streaming = false;
			return this._extractGeometry( object );

		}

		// The three.js geometry waits on disk from its last read until the build is done.
		const geometry = await GeometrySpill.create( storage, `${key}:geo`, this.memoryPreflight?.geometryBytes ?? 0 );
		this._geometrySpill = geometry;

		const state = {
			key, triStore, blasStore, bvhStore: null,
			blasBytes: 0, blasAt: new Map(),
			pending: [], extractedChunks: 0,
			emitterChunks: new Set(),
			isEmitter: materialIndex => extractor._emissiveMaterial( materialIndex ),
			uploadTriangles: null,
			chain: Promise.resolve(),
			error: null,
		};
		this._spillStores = [ triStore ];
		this._blasKey = null;

		const templates = new Map();
		const workerOpts = this._blasWorkerOpts();
		let waiters = [];
		const built = () => new Promise( resolve => waiters.push( resolve ) );
		const wake = () => {

			const w = waiters;
			waiters = [];
			for ( const resolve of w ) resolve();

		};

		let tri = null;
		const onBuilt = ( t, range, result ) => {

			const nodes = result.bvhData;
			const aabb = new Float32Array( 6 );
			InstanceTable.rootAABB( nodes, tri, range.start, range.count, aabb, 0 );
			templates.set( t, { result, aabb } );

			const at = state.blasBytes;
			state.blasBytes += nodes.byteLength;
			state.blasAt.set( t, at );
			result.nodeCount = nodes.length / 16;
			result.bvhData = null;
			this._queueSpill( state, () => blasStore.writeAt( at, nodes ) );

			this._forEachChunk( tri, range.start, range.count, k => {

				if ( -- state.pending[ k ] === 0 && k < state.extractedChunks ) this._finishTriangleChunk( state, k );

			} );
			wake();

		};

		let finished = 0;
		const pool = this._blasPool( workerOpts, () => finished ++, ( t, range, result ) => onBuilt( t, range, result ) );
		let large = Promise.resolve();
		let largePending = 0;
		const advance = ( written ) => {

			const done = written >= tri.recordCount ? tri.chunks.length : Math.floor( written / tri.recordsPerChunk );
			for ( let k = state.extractedChunks; k < done; k ++ ) if ( ! state.pending[ k ] ) this._finishTriangleChunk( state, k );
			state.extractedChunks = Math.max( state.extractedChunks, done );

		};

		let extracted;
		try {

			extracted = await extractor.extractStreaming( object, {

				onStore: store => {

					tri = store;
					this._setTriangleData( store );
					state.uploadTriangles = uploader( store, 'triangles' );

				},

				onRange: ( t, range ) => {

					this._forEachChunk( tri, range.start, range.count, k => state.pending[ k ] = ( state.pending[ k ] ?? 0 ) + 1 );
					if ( this._isLargeMesh( range ) ) {

						largePending ++;
						large = large.then( async () => {

							onBuilt( t, range, await this._buildLargeBLAS( range, workerOpts ) );
							largePending --;

						} );
						large.catch( error => {

							state.error ??= error;
							wake();

						} );

					} else pool.submit( { m: t, range } );

				},

				releaseGeometry: geometry ? g => geometry.add( g ) : null,

				pause: async ( written ) => {

					advance( written );
					if ( geometry?.queuedBytes > GEOMETRY_QUEUE_BYTES ) await geometry.written();
					updateLoading( { status: `Extracted ${written.toLocaleString()} triangles, ${finished.toLocaleString()} BVHs built...`, progress: 15 + Math.floor( 20 * written / Math.max( 1, capacity ) ) } );
					await new Promise( r => setTimeout( r, 0 ) );
					// A timer, not the spill chain: an already-settled promise would spin this loop in
					// microtasks and keep out the worker messages it is waiting for.
					while ( tri.byteLength > STREAM_RESIDENT_BYTES && ( pool.pending > 0 || largePending > 0 ) && ! state.error && ! pool.error ) {

						await Promise.race( [ built(), new Promise( r => setTimeout( r, 50 ) ) ] );

					}

					if ( state.error || pool.error ) throw state.error ?? pool.error;

				},

			} );

			advance( Infinity );
			await Promise.all( [ pool.close(), large ] );
			await state.chain;
			if ( state.error ) throw state.error;

		} catch ( error ) {

			pool.abort( error );
			log.error( 'streamed extraction failed:', error );
			updateLoading( { status: `Extraction error: ${error.message}`, failed: true, progress: 25 } );
			throw error;

		}

		this._adoptExtraction( extracted );
		this._streamed = { state, templates };
		this._log( `Geometry extracted and ${templates.size} BLASes built together (${( performance.now() - startTime ).toFixed( 0 )}ms)` );

	}

	/** Takes over what the extractor produced. @private */
	_adoptExtraction( extractedData ) {

		this._setTriangleData( extractedData.triangleData );
		this.geometryExtractor.releaseTriangles();
		this.triangleCount = assertBVHIndexFits( extractedData.triangleCount, 'triangle count' );
		// Callers build refit buffers by walking meshes, which counts a shared geometry
		// once per placement; storage counts it once.
		this.expandedTriangleCount = extractedData.expandedTriangleCount ?? extractedData.triangleCount;
		this.instanceSource = extractedData.instanceSource || null;
		this.instanceMatrices = extractedData.instanceMatrices || null;
		this.instanceCount = extractedData.instanceCount || 0;
		this.bakeInverse = extractedData.bakeInverse || null;

		this._log( `Using Float32Array format: ${this.triangleCount} triangles, ${( this.triangles.byteLength / ( 1024 * 1024 ) ).toFixed( 2 )}MB` );

		// Store other extracted data
		this.materials = extractedData.materials;
		this.materialTriangleCounts = extractedData.materialTriangleCounts; // Per-material tri count for sort-bin remap
		this.meshes = extractedData.meshes;
		this.meshTriangleRanges = extractedData.meshTriangleRanges; // Per-mesh { start, count } for TLAS/BLAS
		this.maps = extractedData.maps;
		this.normalMaps = extractedData.normalMaps;
		this.bumpMaps = extractedData.bumpMaps;
		this.roughnessMaps = extractedData.roughnessMaps;
		this.metalnessMaps = extractedData.metalnessMaps;
		this.emissiveMaps = extractedData.emissiveMaps;
		this.displacementMaps = extractedData.displacementMaps;
		this.anisotropyMaps = extractedData.anisotropyMaps;
		this.transmissionMaps = extractedData.transmissionMaps;
		this.clearcoatMaps = extractedData.clearcoatMaps;
		this.clearcoatRoughnessMaps = extractedData.clearcoatRoughnessMaps;
		this.sheenColorMaps = extractedData.sheenColorMaps;
		this.sheenRoughnessMaps = extractedData.sheenRoughnessMaps;
		this.iridescenceMaps = extractedData.iridescenceMaps;
		this.iridescenceThicknessMaps = extractedData.iridescenceThicknessMaps;
		this.specularIntensityMaps = extractedData.specularIntensityMaps;
		this.specularColorMaps = extractedData.specularColorMaps;
		this.directionalLights = extractedData.directionalLights;
		this.cameras = extractedData.cameras;

	}

	/**
	 * Build two-level BVH (TLAS/BLAS): one BLAS per mesh, one TLAS over mesh AABBs.
	 * @private
	 */
	async _buildBVH() {

		updateLoading( {
			status: "Building BVH...",
			progress: 25
		} );

		if ( this.triangleCount === 0 ) {

			throw new Error( "No triangles to build BVH from" );

		}

		this._log( 'Building two-level BVH (TLAS/BLAS)' );
		this.memory.mark( 'blas' );
		const startTime = performance.now();

		try {

			const ranges = this.meshTriangleRanges;

			if ( ! ranges || ranges.length === 0 ) {

				throw new Error( "No mesh triangle ranges available for TLAS/BLAS build" );

			}

			// ── Step 1: Build per-mesh BLASes ──

			// One entry per PLACEMENT, not per object: an InstancedMesh contributes a matrix per
			// instance while the scene graph still holds one object. The extractor hands over the
			// transforms as one contiguous pool, which the table adopts rather than copying.
			const pooled = this.instanceCount > 0;
			const meshCount = pooled ? this.instanceCount : ranges.length;
			const instSource = this.instanceSource;
			const worldPool = pooled ? this.instanceMatrices : null;
			const sourceOf = m => ( pooled ? instSource[ m ] : m );

			this.instanceTable = new InstanceTable();
			this.instanceTable.allocate( meshCount, ranges.length, worldPool, pooled ? instSource : null );
			this.instanceTable.tplBakeInverse = this.bakeInverse;

			// Built while the geometry was extracted (the streaming path): only adopt the results.
			const streamed = this._streamed;
			this._streamed = null;

			// Separate into worker-pool tasks and multi-worker parallel tasks
			const poolTasks = [];
			const parallelTasks = [];
			const streamedTasks = [];

			// Placements that reuse another's triangles reuse its BLAS too — the whole point of
			// storing geometry in object space. Only the first placement of a range is built.
			const aliasOf = new Map();
			const ownerOfRange = new Map();

			for ( let m = 0; m < meshCount; m ++ ) {

				const range = ranges[ sourceOf( m ) ];
				if ( ! range || range.count === 0 ) continue;

				const owner = ownerOfRange.get( range.start );
				if ( owner !== undefined ) {

					aliasOf.set( m, owner );
					continue;

				}

				ownerOfRange.set( range.start, m );

				if ( streamed ) streamedTasks.push( { m, range } );
				else if ( this._isLargeMesh( range ) ) parallelTasks.push( { m, range } );
				else poolTasks.push( { m, range } );

			}

			const workerOpts = this._blasWorkerOpts();

			const totalTasks = poolTasks.length + parallelTasks.length;
			let doneTasks = 0;
			const reportBLASProgress = () => {

				doneTasks ++;
				updateLoading( {
					status: `Building BLAS ${doneTasks}/${totalTasks}...`,
					progress: 25 + Math.floor( ( doneTasks / totalTasks ) * 45 )
				} );

			};

			const owners = [ ...poolTasks, ...parallelTasks ]
				.map( ( { m, range } ) => ( { m, range, t: sourceOf( m ), triOffset: range.start, triCount: range.count } ) )
				.sort( ( a, b ) => a.t - b.t );
			const restored = streamed ? null : await this._restoreBLASes( owners, TLASBuilder.nodeCountFor( meshCount ), workerOpts );
			const spill = streamed ? streamed.state
				: ! restored && this._progressive && this.triangles.chunks.length > 1 ? await this._beginProgressiveSpill( owners ) : null;
			const onBuilt = spill && ! streamed ? ( m, range, result ) => this._onBLASBuilt( spill, sourceOf( m ), range, result ) : null;
			if ( streamed ) {

				for ( const [ t, built ] of streamed.templates ) {

					this.instanceTable.tplObjectAABB.set( built.aabb, t * 6 );

				}

			}

			if ( restored ) {

				poolTasks.length = 0;
				parallelTasks.length = 0;
				updateLoading( { status: 'Restored stored BVHs', progress: 68 } );

			}

			// Build all meshes via bounded worker pool (main thread stays free)
			const poolPromise = restored ? Promise.resolve( restored.results )
				: streamed ? Promise.resolve( streamedTasks.map( ( { m, range } ) => ( { m, range, result: streamed.templates.get( sourceOf( m ) ).result } ) ) )
					: this._buildBLASesWithPool( poolTasks, workerOpts, reportBLASProgress, onBuilt );

			// One at a time: each build already spreads over every core and pins ~200 bytes per
			// triangle of SharedArrayBuffer until it finishes. This is a memory bound, not a core one.
			const parallelResults = [];
			const parallelPromise = ( async () => {

				for ( const { m, range } of parallelTasks ) {

					const result = await this._buildLargeBLAS( range, workerOpts );
					onBuilt?.( m, range, result );
					parallelResults.push( { m, range, result } );
					reportBLASProgress();

				}

			} )();

			const [ poolResults ] = await Promise.all( [ poolPromise, parallelPromise ] );
			if ( spill ) {

				await spill.chain;
				if ( spill.error ) throw spill.error;

			}

			// Store all results, summing per-mesh split stats for one aggregate BVH line
			const blasStats = { sah: 0, objMed: 0, spatMed: 0, failed: 0, treeletsImproved: 0, treeletsProcessed: 0 };

			for ( const { m, range, result } of [ ...poolResults, ...parallelResults ] ) {

				const st = result.splitStats;
				if ( st ) {

					blasStats.sah += st.sahSplits ?? 0;
					blasStats.objMed += st.objectMedianSplits ?? 0;
					blasStats.spatMed += st.spatialMedianSplits ?? 0;
					blasStats.failed += st.failedSplits ?? 0;
					blasStats.treeletsImproved += st.treeletsImproved ?? 0;
					blasStats.treeletsProcessed += st.treeletsProcessed ?? 0;
					this.performanceMetrics.blasWorkerTime += st.totalBuildTime ?? 0;

				}

				this.instanceTable.setEntry( {
					meshIndex: m,
					blasNodeCount: result.nodeCount ?? result.bvhData.length / 16,
					triOffset: range.start,
					triCount: range.count,
					originalToBvhMap: result.originalToBvh || null,
					bvhData: result.bvhData,
					matrixWorld: pooled ? worldPool : ( this.meshes?.[ m ]?.matrixWorld?.elements ?? null ),
					matrixOffset: pooled ? m * 16 : 0,
					expandedStart: range.expandedStart,
					sourceMesh: sourceOf( m ),
				} );

			}

			for ( const [ m, owner ] of aliasOf ) {

				this.instanceTable.setAlias(
					m, owner,
					pooled ? worldPool : ( this.meshes?.[ m ]?.matrixWorld?.elements ?? null ),
					ranges[ sourceOf( m ) ].expandedStart,
					sourceOf( m ),
					pooled ? m * 16 : 0
				);

			}

			updateLoading( { status: 'Built all BLASes', progress: 70 } );

			this.performanceMetrics.blasBuildTime = performance.now() - startTime;

			// ── Step 2: Assemble BVH buffer ──

			updateLoading( { status: "Building TLAS...", progress: 72 } );
			this._sampleMemory( 'BLASes built' );
			this.memory.mark( 'tlas' );
			const tlasStart = performance.now();

			const table = this.instanceTable;

			// Always build a TLAS — even for a single mesh — so the BLAS-pointer leaf
			// carries packed per-mesh visibility in its slot [2]. The 1-node TLAS
			// overhead (one extra leaf fetch per ray) is negligible and eliminates
			// a dedicated visibility storage buffer binding.
			this.instanceTable.computeAABBs( this.triangles, { owners: ! spill } );

			// Node count is exact up front (every leaf holds one entry), so BLAS offsets can be
			// assigned before the build and the TLAS is written in a single pass.
			this.instanceTable.assignOffsets( TLASBuilder.nodeCountFor( table.count ) );
			const totalNodes = this.instanceTable.totalNodeCount;

			let tlasData = await this._buildTLAS( table );
			this.performanceMetrics.tlasBuildTime = performance.now() - tlasStart;

			// Assemble combined buffer: [TLAS][BLAS_0][BLAS_1]...[BLAS_M]
			this.memory.mark( 'assemble' );
			const assembleStart = performance.now();
			// Chunked for the same reason triangles are: 64 B a node puts the 2 GB array cap at
			// 33.4M nodes, which a large instanced scene reaches well before the GPU's 4 GB.
			// Lazy, and walked in template order so offsets ascend: chunks are allocated as the fill
			// reaches them and each BLAS is released as it lands, never both fully resident.
			if ( ! spill ) this._checkAssemblyHeadroom( totalNodes );
			this._setBVHData( ChunkedRecords.lazy( totalNodes, 16, Float32Array, undefined, SHARED_MEMORY_AVAILABLE ) );
			const flushBVH = spill ? await this._beginBVHSpill( spill, table.tlasNodeCount ) : null;
			this.bvh.setRecords( 0, tlasData );
			// Hundreds of megabytes at millions of placements, and the chunks below need the room
			// more than a later refit needs the cache.
			tlasData = null;
			this.tlasBuilder.releaseFlattenBuffer();

			// Sample ~32 times across the fill rather than per template: this is where every
			// allocation failure so far has landed, and the live total moves in both directions
			// as chunks are taken and BLASes released.
			const sampleEvery = Math.max( 1, Math.ceil( table.templateCount / 32 ) );

			if ( restored ) {

				// Stored already assembled: same template order, same offsets, indices already rebased.
				try {

					const readStart = performance.now();
					await readNodesInto( restored.nodes, this.bvh, table.tlasNodeCount, totalNodes - table.tlasNodeCount );
					this.performanceMetrics.blasRestore.readMs = performance.now() - readStart;

				} finally {

					restored.release();

				}

				table.blasData.clear();

			} else {

				for ( let t = 0; t < table.templateCount; t ++ ) {

					// Only owning templates hold one; spilled, they are read back one at a time.
					const blas = spill ? await this._readSpilledBLAS( spill, t ) : table.blasData.get( t );
					if ( ! blas ) continue;

					const blasOffset = table.tplBlasOffset[ t ];
					this.bvh.setRecords( blasOffset, blas );
					this._offsetBLASInPlace( blasOffset, blas.length / 16, blasOffset, table.tplTriOffset[ t ] );
					table.blasData.delete( t );
					await flushBVH?.( blasOffset + blas.length / 16 );

					if ( t % sampleEvery === 0 ) this._sampleMemory( `assembling ${t}/${table.templateCount}` );

				}

				await flushBVH?.( totalNodes, true );
				if ( spill ) await spill.blasStore.dispose();

			}

			this._setBVHData( this.bvh.materializeAll() );

			if ( restored ) for ( const [ t, map ] of restored.orders ) table.bvhToOriginal.set( t, map );
			else this._buildBvhToOriginalMaps();
			this.performanceMetrics.bvhAssembleTime = performance.now() - assembleStart;

			table.originalToBvhMap.clear();
			table.blasData.clear();

			this.bvhRoot = true;
			this._disposeRefitWorker();

			const duration = performance.now() - startTime;
			// One aggregate line for the whole two-level build; the workers' per-mesh
			// detail sits a level below at `debug`.
			log.debug( fmt.list( [
				`${fmt.n( table.setCount )} BLASes + TLAS`,
				`${fmt.n( this.bvh.recordCount )} nodes`,
				`SAH ${fmt.n( blasStats.sah )} · objMed ${blasStats.objMed} · spatMed ${blasStats.spatMed} · failed ${blasStats.failed}`,
				blasStats.treeletsProcessed ? `treelets ${blasStats.treeletsImproved}/${blasStats.treeletsProcessed} improved` : null,
				fmt.ms( duration ),
			] ) );

			updateLoading( {
				status: "BVH construction complete",
				progress: 75
			} );

		} catch ( error ) {

			log.error( 'BVH build failed:', error );
			updateLoading( {
				status: `BVH error: ${error.message}`,
				failed: true,
				progress: 75
			} );
			throw error;

		}

	}

	/** Worker config shared by all BLAS builds. @private */
	_blasWorkerOpts() {

		return {
			depth: this.config.bvhDepth,
			treeletOptimization: {
				enabled: this.config.enableTreeletOptimization !== false,
				size: this.config.treeletSize,
				passes: this.config.treeletOptimizationPasses,
				minImprovement: this.config.treeletMinImprovement,
				complexityThreshold: this.config.treeletComplexityThreshold
			},
			reinsertionOptimization: {
				enabled: this.bvhBuilder.enableReinsertionOptimization,
				batchSizeRatio: this.bvhBuilder.reinsertionBatchSizeRatio,
				maxIterations: this.bvhBuilder.reinsertionMaxIterations
			},
			// BVH build params — previously omitted, so the pool path built at the
			// BVHBuilder default (leaf 8) instead of the configured value.
			maxLeafSize: this.bvhBuilder.maxLeafSize,
			numBins: this.bvhBuilder.numBins,
			maxBins: this.bvhBuilder.maxBins,
			minBins: this.bvhBuilder.minBins,
			logLevel: workerLogLevel(),
		};

	}

	/** @private */
	_isLargeMesh( range ) {

		return range.count >= LARGE_MESH_TRIANGLES && shouldUseParallelBuild( range.count );

	}

	/**
	 * One mesh's BLAS across every core. The range is read straight into the SharedArrayBuffer
	 * the builder works in, and its BVH order written back chunk by chunk, so the mesh is held
	 * once rather than three times.
	 * @private
	 */
	async _buildLargeBLAS( range, workerOpts ) {

		const meshTriData = new Uint32Array( new SharedArrayBuffer( range.count * this.triangles.lanesPerRecord * 4 ) );
		this.triangles.readRecords( range.start, range.count, meshTriData );
		// The builder has its own copy and the order comes back into every record of the range, so
		// the chunks wholly inside it can go meanwhile — 1 GB at the build's peak for a 15M mesh.
		this.triangles.release( range.start, range.count );

		const result = await buildBVHParallel( meshTriData, this.config.bvhDepth, null, workerOpts );

		if ( result.reorderedTriangles ) {

			this.triangles.setRecords( range.start, result.reorderedTriangles );
			delete result.reorderedTriangles;

		} else if ( result.order ) {

			this._writeInOrder( range.start, result.triangles, result.order );
			delete result.order;
			delete result.triangles;

		}

		return result;

	}

	_blasCacheKey( workerOpts ) {

		const builder = { ...workerOpts };
		delete builder.logLevel;
		const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
		return `blas:${BLAS_CACHE_FORMAT}:${VERSION}:${JSON.stringify( builder )}:${cores}:${this._sceneKey}`;

	}

	/**
	 * Reuses stored BLASes when every owning template matches what was stored — same ranges, same
	 * node counts, same offsets, same triangles — and puts the triangles in their built order.
	 * @returns {Promise<?{results: Array, orders: Map<number, Uint32Array>, nodes: File, release: function(): void}>}
	 * @private
	 */
	async _restoreBLASes( owners, tlasNodeCount, workerOpts ) {

		if ( ! this._sceneKey || this.config.sceneCache === false ) return null;
		const storage = sharedStorage( getAssetConfig().cacheNamespace );
		if ( ! storage ) return null;

		this._blasKey = this._blasCacheKey( workerOpts );
		const cached = await openBLASCache( storage, this._blasKey );
		if ( ! cached ) return null;

		const miss = ( reason ) => {

			log.debug( `stored BLASes not used: ${reason}` );
			cached.release();
			return null;

		};

		const { index } = cached;
		if ( index.tlasNodeCount !== tlasNodeCount || index.templates.length !== owners.length ) return miss( 'layout changed' );

		let offset = tlasNodeCount;
		for ( let i = 0; i < owners.length; i ++ ) {

			const [ t, triOffset, triCount, nodeCount, blasOffset ] = index.templates[ i ];
			const o = owners[ i ];
			if ( o.t !== t || o.triOffset !== triOffset || o.triCount !== triCount || blasOffset !== offset ) return miss( 'layout changed' );
			offset += nodeCount;

		}

		if ( offset !== index.totalNodes ) return miss( 'layout changed' );

		const checkStart = performance.now();
		const sums = await templateChecksums( this.triangles, owners );
		for ( let i = 0; i < owners.length; i ++ ) if ( sums[ i ] !== index.templates[ i ][ 6 ] ) return miss( 'triangles changed' );
		const permuteStart = performance.now();

		try {

			const orders = new Map();
			const results = [];
			for ( let i = 0; i < owners.length; i ++ ) {

				const [ t, triOffset, triCount, nodeCount, , orderOffset, , root ] = index.templates[ i ];
				const order = await readOrder( cached.order, orderOffset, triCount );
				this._permuteRange( triOffset, triCount, order );
				orders.set( t, order );
				results.push( {
					m: owners[ i ].m,
					range: owners[ i ].range,
					result: { bvhData: new Float32Array( Uint32Array.from( root ).buffer ), originalToBvh: null, nodeCount },
				} );

			}

			this._blasRestored = true;
			this.performanceMetrics.blasRestore = { checksumMs: permuteStart - checkStart, permuteMs: performance.now() - permuteStart };
			log.debug( `restored ${fmt.n( owners.length )} stored BLASes` );
			return { results, orders, nodes: cached.nodes, release: cached.release };

		} catch ( error ) {

			cached.release();
			throw error;

		}

	}

	/** Puts records [start, start + count) in built order: slot j takes caller's triangle order[ j ]. @private */
	/** Record `start + j` of the store becomes record `order[ j ]` of `src`, chunk by chunk. @private */
	_writeInOrder( start, src, order ) {

		const store = this.triangles;
		const lanes = store.lanesPerRecord;
		for ( let j = 0, n = order.length; j < n; ) {

			const dst = store.chunkFor( start + j );
			const end = Math.min( n, ( ( ( ( start + j ) / store.recordsPerChunk ) | 0 ) + 1 ) * store.recordsPerChunk - start );
			for ( let d = store.baseOf( start + j ); j < end; j ++, d += lanes ) {

				const s = order[ j ] * lanes;
				for ( let l = 0; l < lanes; l ++ ) dst[ d + l ] = src[ s + l ];

			}

		}

	}

	_permuteRange( start, count, order ) {

		let identity = true;
		for ( let j = 0; j < count && identity; j ++ ) identity = order[ j ] === j;
		if ( identity ) return;

		const lanes = this.triangles.lanesPerRecord;
		// A view when the range sits in one chunk: read from it, write a fresh buffer, copy back once.
		const src = this.triangles.slice( start, count );
		const out = new src.constructor( src.length );
		if ( lanes === 20 ) {

			for ( let j = 0, d = 0; j < count; j ++, d += 20 ) {

				const s = order[ j ] * 20;
				out[ d ] = src[ s ]; out[ d + 1 ] = src[ s + 1 ]; out[ d + 2 ] = src[ s + 2 ]; out[ d + 3 ] = src[ s + 3 ];
				out[ d + 4 ] = src[ s + 4 ]; out[ d + 5 ] = src[ s + 5 ]; out[ d + 6 ] = src[ s + 6 ]; out[ d + 7 ] = src[ s + 7 ];
				out[ d + 8 ] = src[ s + 8 ]; out[ d + 9 ] = src[ s + 9 ]; out[ d + 10 ] = src[ s + 10 ]; out[ d + 11 ] = src[ s + 11 ];
				out[ d + 12 ] = src[ s + 12 ]; out[ d + 13 ] = src[ s + 13 ]; out[ d + 14 ] = src[ s + 14 ]; out[ d + 15 ] = src[ s + 15 ];
				out[ d + 16 ] = src[ s + 16 ]; out[ d + 17 ] = src[ s + 17 ]; out[ d + 18 ] = src[ s + 18 ]; out[ d + 19 ] = src[ s + 19 ];

			}

		} else {

			for ( let j = 0; j < count; j ++ ) {

				const s = order[ j ] * lanes;
				const d = j * lanes;
				for ( let l = 0; l < lanes; l ++ ) out[ d + l ] = src[ s + l ];

			}

		}

		this.triangles.setRecords( start, out );

	}

	/** Writes this build's BLASes to storage in the background; abandons it if the scene changes. @private */
	async _storeBLASes( label ) {

		const storage = sharedStorage( getAssetConfig().cacheNamespace );
		const table = this.instanceTable;
		if ( ! storage || ! table || ! this.bvh ) return false;

		const key = this._blasKey;
		const version = this._geometryVersion;
		const isStale = () => this._geometryVersion !== version || this._blasKey !== key;

		const owners = [];
		for ( let t = 0; t < table.templateCount; t ++ ) {

			const owner = table.tplOwner[ t ];
			if ( owner < 0 || table.sourceMesh[ owner ] !== t ) continue;
			owners.push( { t, triOffset: table.tplTriOffset[ t ], triCount: table.tplTriCount[ t ], nodeCount: table.tplNodeCount[ t ], blasOffset: table.tplBlasOffset[ t ] } );

		}

		const sums = await templateChecksums( this.triangles, owners );
		if ( isStale() ) return false;

		const rootBits = ( n ) => {

			const chunk = this.bvhIndexChunks.chunkFor( n );
			const base = this.bvhIndexChunks.baseOf( n );
			return Array.from( chunk.subarray( base, base + 16 ) );

		};

		let orderOffset = 0;
		const orders = [];
		const templates = owners.map( ( o, i ) => {

			orders.push( table.bvhToOriginal.get( o.t ) ?? Uint32Array.from( { length: o.triCount }, ( _, j ) => j ) );
			const entry = [ o.t, o.triOffset, o.triCount, o.nodeCount, o.blasOffset, orderOffset, sums[ i ], rootBits( o.blasOffset ) ];
			orderOffset += o.triCount;
			return entry;

		} );

		const index = { v: BLAS_CACHE_FORMAT, tlasNodeCount: table.tlasNodeCount, totalNodes: table.totalNodeCount, templates };
		const stored = await saveBLASCache( storage, key, { index, bvh: this.bvh, orders, isStale, label } );
		if ( stored ) log.debug( `stored ${fmt.n( owners.length )} BLASes for the next load` );
		return stored;

	}

	/**
	 * Adjust BLAS node indices in-place within the combined bvhData buffer.
	 * @private
	 */
	/**
	 * Memory spill during the build (8c): each BLAS goes to a scratch file as it arrives, and each
	 * triangle chunk goes to the GPU and then to disk once every BLAS over it is built — so the
	 * triangles and the BVH are never all in memory at once. Chunks holding emitters stay: the
	 * emissive pass reads them. Null when storage cannot take it, and the build carries on as usual.
	 * @private
	 */
	async _beginProgressiveSpill( owners ) {

		const { storage, uploader } = this._progressive;
		const tri = this.triangles;
		const key = `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}`;
		const stride = tri.recordsPerChunk * tri.lanesPerRecord * tri.LaneType.BYTES_PER_ELEMENT;

		const triStore = await SpillStore.create( storage, `${key}:tri`, stride, { label: 'Triangle records', expectedBytes: tri.byteLength } );
		const blasStore = triStore && await SpillStore.create( storage, `${key}:blas`, 0, { label: 'BLAS nodes (while building)' } );
		if ( ! blasStore ) {

			await triStore?.dispose();
			return null;

		}

		const state = {
			key, triStore, blasStore, bvhStore: null,
			blasBytes: 0, blasAt: new Map(),
			pending: new Int32Array( tri.chunks.length ),
			emitterChunks: new Set(),
			isEmitter: materialIndex => {

				const m = this.materials[ materialIndex ];
				return ( m?.emissiveIntensity ?? 0 ) > 0 && !! m.emissive && ( m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0 );

			},
			uploadTriangles: uploader( tri, 'triangles' ),
			chain: Promise.resolve(),
			error: null,
		};

		this._spillStores = [ triStore ];
		this._blasKey = null;
		for ( const { triOffset, triCount } of owners ) this._forEachChunk( tri, triOffset, triCount, k => state.pending[ k ] ++ );
		for ( let k = 0; k < tri.chunks.length; k ++ ) if ( state.pending[ k ] === 0 ) this._finishTriangleChunk( state, k );
		return state;

	}

	/** @private */
	_forEachChunk( records, start, count, fn ) {

		if ( count <= 0 ) return;
		const last = ( ( start + count - 1 ) / records.recordsPerChunk ) | 0;
		for ( let k = ( start / records.recordsPerChunk ) | 0; k <= last; k ++ ) fn( k );

	}

	/** A BLAS has landed: its bounds are taken now, its nodes go to scratch. @private */
	_onBLASBuilt( state, t, range, result ) {

		const table = this.instanceTable;
		const nodes = result.bvhData;
		table.tplTriOffset[ t ] = range.start;
		table.tplTriCount[ t ] = range.count;
		table._readRootAABB( nodes, t, this.triangles, table.tplObjectAABB, t * 6 );

		const at = state.blasBytes;
		state.blasBytes += nodes.byteLength;
		state.blasAt.set( t, at );
		result.nodeCount = nodes.length / 16;
		result.bvhData = null;

		this._queueSpill( state, () => state.blasStore.writeAt( at, nodes ) );
		this._forEachChunk( this.triangles, range.start, range.count, k => {

			if ( -- state.pending[ k ] === 0 ) this._finishTriangleChunk( state, k );

		} );

	}

	/** @private */
	_queueSpill( state, step ) {

		state.chain = state.chain.then( step ).catch( error => {

			state.error ??= error;

		} );

	}

	/** Every BLAS over chunk `k` is built: upload it, and let it go unless it holds emitters. @private */
	_finishTriangleChunk( state, k ) {

		this._queueSpill( state, async () => {

			const tri = this.triangles;
			const chunk = tri.chunks[ k ];
			if ( ! chunk ) return;
			state.uploadTriangles( k );

			const lanes = tri.lanesPerRecord;
			for ( let o = TRIANGLE_DATA_LAYOUT.MATERIAL_FLAGS_OFFSET; o < chunk.length; o += lanes ) {

				if ( state.isEmitter( chunk[ o ] & TRI_MATERIAL_MASK ) ) {

					state.emitterChunks.add( k );
					return;

				}

			}

			await tri.spillChunk( k, state.triStore );

		} );

	}

	/** @private */
	async _readSpilledBLAS( state, t ) {

		const at = state.blasAt.get( t );
		if ( at === undefined ) return null;
		const bytes = this.instanceTable.tplNodeCount[ t ] * 64;
		return new Float32Array( await state.blasStore.readAt( at, bytes ) );

	}

	/**
	 * The combined BVH is filled in ascending order, so every chunk the fill has passed is done:
	 * upload it and let it go. The TLAS chunks stay, as they do after any spill.
	 * @returns {Promise<?function(number, boolean=): Promise<void>>} call with the fill's end
	 * @private
	 */
	async _beginBVHSpill( state, tlasNodeCount ) {

		const { storage, uploader } = this._progressive;
		const bvh = this.bvh;
		const stride = bvh.recordsPerChunk * bvh.lanesPerRecord * bvh.LaneType.BYTES_PER_ELEMENT;
		const bvhStore = await SpillStore.create( storage, `${state.key}:bvh`, stride, { label: 'BLAS nodes', expectedBytes: bvh.recordCount * 64 } );
		const upload = uploader( bvh );
		const tlasChunks = Math.ceil( tlasNodeCount / bvh.recordsPerChunk );
		if ( bvhStore ) this._spillStores.push( bvhStore );
		let next = tlasChunks;

		return async ( filledTo, last = false ) => {

			while ( next < bvh.chunks.length && ( last || ( next + 1 ) * bvh.recordsPerChunk <= filledTo ) ) {

				if ( ! bvh.chunks[ next ] ) bvh._materialize( next );
				upload( next );
				if ( bvhStore ) await bvh.spillChunk( next, bvhStore );
				next ++;

			}

			if ( last ) for ( let k = 0; k < Math.min( tlasChunks, bvh.chunks.length ); k ++ ) {

				if ( ! bvh.chunks[ k ] ) bvh._materialize( k );
				upload( k );

			}

		};

	}

	_offsetBLASInPlace( startNode, nodeCount, nodeOffset, triOffset ) {

		const idx = this.bvhIndexChunks;

		for ( let i = 0; i < nodeCount; i ++ ) {

			const n = startNode + i;
			const chunk = idx.chunkFor( n );
			const o = idx.baseOf( n );

			if ( chunk[ o + 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

				chunk[ o ] += triOffset;

			} else {

				chunk[ o + 3 ] += nodeOffset;
				chunk[ o + 7 ] += nodeOffset;

			}

		}

	}

	/**
	 * Build multiple BLASes using a bounded worker pool.
	 * Each mesh is dispatched to an available BVHWorker; at most poolSize workers run concurrently.
	 *
	 * @param {Array<{m: number, range: {start: number, count: number}}>} tasks
	 * @param {Object} opts - Worker build options (depth, treeletOptimization, reinsertionOptimization)
	 * @param {Function} onProgress - Called with (completedCount) as builds finish
	 * @returns {Promise<Array<{m, range, result}>>}
	 * @private
	 */
	_buildBLASesWithPool( tasks, opts, onProgress, onResult = null ) {

		const pool = this._blasPool( opts, onProgress, onResult );
		for ( const task of tasks ) pool.submit( task );
		return pool.close();

	}

	/**
	 * A BLAS worker pool that takes builds while it runs: `submit( { m, range } )` queues one,
	 * `close()` resolves with every result once the queue has drained. Workers start as work
	 * arrives, up to the pool size.
	 * @private
	 */
	_blasPool( opts, onProgress, onResult = null ) {

		const poolSize = this.config.maxConcurrentTextureTasks || 4;
		const queue = [];
		const results = [];
		const workers = [];
		const idle = [];
		let closed = false, running = 0, completed = 0, failure = null;
		let settle;
		const done = new Promise( ( resolve, reject ) => settle = { resolve, reject } );
		done.catch( () => {} );

		const fail = ( error ) => {

			if ( failure ) return;
			failure = error;
			workers.forEach( w => w.terminate() );
			settle.reject( error );

		};

		const finishIfDrained = () => {

			if ( failure || ! closed || queue.length > 0 || running > 0 ) return;
			workers.forEach( w => w.terminate() );
			settle.resolve( results );

		};

		const dispatch = ( worker ) => {

			const task = queue.shift();
			if ( ! task ) {

				idle.push( worker );
				finishIfDrained();
				return;

			}

			const { m, range } = task;
			running ++;
			try {

				const meshTriData = this.triangles.copyOf( range.start, range.count );

				// Disable treelet for tiny meshes
				const triCount = range.count;
				const treeletOpts = triCount <= 500
					? { ...opts.treeletOptimization, enabled: false }
					: opts.treeletOptimization;

				worker._currentTask = { m, range };
				worker.postMessage( {
					triangleData: meshTriData.buffer,
					triangleByteOffset: meshTriData.byteOffset,
					triangleByteLength: meshTriData.byteLength,
					triangleCount: triCount,
					depth: opts.depth,
					reportProgress: false,
					sharedReorderBuffer: null,
					treeletOptimization: treeletOpts,
					reinsertionOptimization: opts.reinsertionOptimization,
					maxLeafSize: opts.maxLeafSize,
					numBins: opts.numBins,
					maxBins: opts.maxBins,
					minBins: opts.minBins,
					logLevel: opts.logLevel,
				}, [ meshTriData.buffer ] );

			} catch ( error ) {

				fail( error );

			}

		};

		const onWorkerMessage = ( worker, e ) => {

			const data = e.data;

			if ( data.error ) {

				fail( new Error( data.error ) );
				return;

			}

			if ( data.progress !== undefined ) return; // Ignore progress messages

			const { m, range } = worker._currentTask;
			running --;

			try {

				// Write back now: holding one copy per mesh until the pool drains is the whole
				// triangle buffer over again, ~3 GB at 40M.
				if ( data.triangles ) this.triangles.setRecords( range.start, data.triangles );

				const result = {
					bvhData: data.bvhData,
					originalToBvh: data.originalToBvh || null,
					splitStats: data.treeletStats || null,
				};
				onResult?.( m, range, result );
				results.push( { m, range, result } );

			} catch ( error ) {

				// Thrown here, it would stop the pool with the promise never settled.
				fail( error );
				return;

			}

			completed ++;
			onProgress?.( completed );
			dispatch( worker );

		};

		const spawn = () => {

			const worker = new BVHWorker();
			worker.onmessage = ( e ) => onWorkerMessage( worker, e );
			worker.onerror = ( err ) => fail( err );
			workers.push( worker );
			return worker;

		};

		return {

			submit( task ) {

				if ( failure ) return;
				queue.push( task );
				try {

					const worker = idle.pop() ?? ( workers.length < poolSize ? spawn() : null );
					if ( worker ) dispatch( worker );

				} catch ( error ) {

					fail( error );

				}

			},

			close() {

				closed = true;
				finishIfDrained();
				return done;

			},

			abort( error ) {

				fail( error ?? new Error( 'BLAS pool aborted' ) );

			},

			/** Builds queued or running. */
			get pending() {

				return queue.length + running;

			},

			get error() {

				return failure;

			},

		};

	}

	/**
	 * Build the per-template bvhToOriginal maps: stored-order index → the caller's triangle index.
	 * Only this direction is kept — every reader walks stored order, so the forward map was a
	 * second copy of the same permutation (114 MB at 30M triangles) that nothing needed.
	 * @private
	 */
	_buildBvhToOriginalMaps() {

		const table = this.instanceTable;
		for ( let m = 0; m < table.count; m ++ ) {

			// Aliases read the owner's map straight out of the table; nothing to store.
			if ( ! table.isSet[ m ] || ! table.isOwner( m ) ) continue;

			const t = table.sourceMesh[ m ];
			const triCount = table.tplTriCount[ t ];
			const originalToBvh = table.originalToBvhMap.get( t );

			// Build per-mesh bvhToOriginal (inverse map for sequential writes)
			const bvhToOrig = new Uint32Array( triCount );

			if ( originalToBvh ) {

				for ( let i = 0; i < triCount; i ++ ) bvhToOrig[ originalToBvh[ i ] ] = i;

			} else {

				for ( let i = 0; i < triCount; i ++ ) bvhToOrig[ i ] = i;

			}

			table.bvhToOriginal.set( t, bvhToOrig );
			table.originalToBvhMap.delete( t ); // consumed; the caller clears the rest anyway

		}

	}

	/**
     * Create material textures and emissive data concurrently with BVH.
     * Only depends on GeometryExtractor output, NOT on BVH.
     * @private
     */
	async _createMaterialTextures() {

		this._log( 'Creating material textures (parallel with BVH)' );

		try {

			// Group the extractor's per-type arrays into consolidated colorSpace×size-bucket
			// pools, and rewrite each material's per-map index to the packed (bucket, layer)
			// form. Must run BEFORE createMaterialRawData (which reads mat.map etc.).
			const { srgbLists, linearLists, remap } = this._bucketTextures();
			this._remapMaterialTextureIndices( remap );

			// Material raw data for storage buffers (sync, ~1-5ms) — now holds packed indices.
			if ( this.materials?.length ) {

				this.materialData = this.textureCreator.createMaterialRawData( this.materials );

			}

			// One DataArrayTexture per non-empty bucket. The sRGB pool (albedo + emissive — both
			// authored in sRGB per glTF) carries SRGBColorSpace so the GPU decodes sRGB→linear
			// before lighting; the linear pool (normal/roughness/metalness/bump/displacement —
			// data textures) stays linear. Applied consistently across load AND rebuildMaterials
			// (the prior model-load path omitted this, leaving albedo un-decoded / too bright).
			const buildBucket = ( list, srgb ) => list.length === 0
				? Promise.resolve( null )
				: this.textureCreator.createTexturesToDataTexture( list, { srgbPool: srgb } ).then( tex => {

					if ( tex && srgb ) tex.colorSpace = SRGBColorSpace;
					return tex;

				} );

			const [ srgbTextures, linearTextures ] = await Promise.all( [
				Promise.all( srgbLists.map( list => buildBucket( list, true ) ) ),
				Promise.all( linearLists.map( list => buildBucket( list, false ) ) ),
			] );

			this.srgbBucketTextures = srgbTextures;
			this.linearBucketTextures = linearTextures;

			this._log( 'Material textures complete', {
				materialData: !! this.materialData,
				srgbBuckets: srgbTextures.map( t => ( t ? `${t.image.width}x${t.image.height}x${t.image.depth}` : '-' ) ).join( ',' ),
				linearBuckets: linearTextures.map( t => ( t ? `${t.image.width}x${t.image.height}x${t.image.depth}` : '-' ) ).join( ',' ),
			} );

		} catch ( error ) {

			log.error( 'texture creation failed:', error );
			throw error;

		}

	}

	/**
	 * Group the extractor's seven per-type texture arrays into two consolidated colorSpace
	 * pools (sRGB: albedo+emissive; linear: normal/bump/roughness/metalness/displacement),
	 * each split into at most MATERIAL_BUCKET_COUNT buckets whose shapes are planned from the
	 * pool's own texture dimensions. Textures are deduped across types within a (pool, bucket)
	 * so a shared image (e.g. ORM) costs one layer.
	 * @returns {{ srgbLists: Array<Array>, linearLists: Array<Array>, remap: Object }}
	 *          bucket lists + per-type remap arrays (old per-type layer → packed bucket index).
	 * @private
	 */
	_bucketTextures() {

		const cap = this.config.maxTextureSize;
		const K = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT;
		const STRIDE = TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE;

		const poolSizes = ( types ) => {

			const seen = new Set();
			const sizes = [];

			for ( const arr of types ) {

				for ( const tex of arr || [] ) {

					if ( ! tex?.image ) continue;
					const uuid = tex.source?.uuid ?? tex.uuid;
					if ( seen.has( uuid ) ) continue;
					seen.add( uuid );
					sizes.push( { width: tex.image.width, height: tex.image.height } );

				}

			}

			return sizes;

		};

		const srgbTypes = [ this.maps, this.emissiveMaps, this.sheenColorMaps, this.specularColorMaps ];
		const linearTypes = [
			this.normalMaps, this.bumpMaps, this.roughnessMaps, this.metalnessMaps, this.displacementMaps,
			this.anisotropyMaps, this.transmissionMaps, this.clearcoatMaps, this.clearcoatRoughnessMaps,
			this.sheenRoughnessMaps, this.iridescenceMaps, this.iridescenceThicknessMaps, this.specularIntensityMaps,
		];

		const srgbShapes = planTextureBuckets( poolSizes( srgbTypes ), cap, K );
		const linearShapes = planTextureBuckets( poolSizes( linearTypes ), cap, K );
		this._srgbBucketShapes = srgbShapes;
		this._linearBucketShapes = linearShapes;

		// Always K-length even when the plan needs fewer shapes: downstream nodes are built
		// per MATERIAL_BUCKET_COUNT and a short array would leave stale bindings behind.
		const srgbLists = Array.from( { length: K }, () => [] );
		const linearLists = Array.from( { length: K }, () => [] );
		const srgbDedup = Array.from( { length: K }, () => new Map() );
		const linearDedup = Array.from( { length: K }, () => new Map() );

		// Persistent uuid → packed maps so runtime material edits (updateMaterial) can re-pack
		// a texture's index against the CURRENT bucket layout instead of the stale per-type index.
		this._srgbTexPacked = new Map();
		this._linearTexPacked = new Map();

		let bucketOverflowReported = false;
		let undecodedReported = false;

		// Assign one texture to its (bucket, layer) within a pool; dedup by source uuid.
		const assign = ( tex, lists, dedup, flat, shapes ) => {

			if ( ! tex ) return - 1;

			// A map whose image has not landed yet is indistinguishable here from no map at
			// all, and the material would render untextured with nothing in the log.
			if ( ! tex.image ) {

				if ( ! undecodedReported ) this.config.issues?.record(
					ISSUE_CODES.TEXTURE_BUILD_FAILED,
					'a material map had not finished decoding when the scene was packed; it renders untextured',
					{ texture: tex.name || tex.source?.uuid || tex.uuid }
				);
				undecodedReported = true;
				return - 1;

			}

			const bucket = getTextureBucketId( tex.image.width, tex.image.height, shapes );
			const uuid = tex.source?.uuid ?? tex.uuid;
			const seen = dedup[ bucket ].get( uuid );
			if ( seen !== undefined ) return packTextureIndex( bucket, seen );
			if ( lists[ bucket ].length >= STRIDE ) {

				log.warn( `texture bucket ${bucket} full (${STRIDE}); dropping a map` );
				if ( ! bucketOverflowReported ) this.config.issues?.record(
					ISSUE_CODES.TEXTURE_LIMIT_EXCEEDED,
					`texture bucket ${bucket} full (${STRIDE} layers); the rest render untextured`,
					{ bucket, limit: STRIDE }
				);
				bucketOverflowReported = true;
				return - 1;

			}

			lists[ bucket ].push( tex );
			const layer = lists[ bucket ].length - 1;
			dedup[ bucket ].set( uuid, layer );
			const packed = packTextureIndex( bucket, layer );
			flat.set( uuid, packed );
			return packed;

		};

		// Per-type arrays hold unique textures indexed by the layer the extractor assigned
		// (= array position), so remap[type][oldLayer] = packed index.
		const remapType = ( arr, lists, dedup, flat, shapes ) => ( arr || [] ).map( tex => assign( tex, lists, dedup, flat, shapes ) );

		const remap = {
			albedo: remapType( this.maps, srgbLists, srgbDedup, this._srgbTexPacked, srgbShapes ),
			emissive: remapType( this.emissiveMaps, srgbLists, srgbDedup, this._srgbTexPacked, srgbShapes ),
			normal: remapType( this.normalMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			bump: remapType( this.bumpMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			roughness: remapType( this.roughnessMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			metalness: remapType( this.metalnessMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			displacement: remapType( this.displacementMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			anisotropy: remapType( this.anisotropyMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			// Extension maps — data maps → linear pool; color maps (sheenColor, specularColor) → sRGB pool.
			transmission: remapType( this.transmissionMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			clearcoat: remapType( this.clearcoatMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			clearcoatRoughness: remapType( this.clearcoatRoughnessMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			sheenColor: remapType( this.sheenColorMaps, srgbLists, srgbDedup, this._srgbTexPacked, srgbShapes ),
			sheenRoughness: remapType( this.sheenRoughnessMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			iridescence: remapType( this.iridescenceMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			iridescenceThickness: remapType( this.iridescenceThicknessMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			specularIntensity: remapType( this.specularIntensityMaps, linearLists, linearDedup, this._linearTexPacked, linearShapes ),
			specularColor: remapType( this.specularColorMaps, srgbLists, srgbDedup, this._srgbTexPacked, srgbShapes ),
		};

		return { srgbLists, linearLists, remap };

	}

	/**
	 * Rewrite each material's per-map index from the extractor's per-type layer to the
	 * packed (bucket, layer) index. Idempotency is NOT guaranteed — call exactly once per
	 * extraction (materials are freshly extracted on each process/rebuild).
	 * @private
	 */
	_remapMaterialTextureIndices( remap ) {

		const fix = ( v, table ) => ( v >= 0 && v < table.length ? table[ v ] : - 1 );
		for ( const mat of this.materials ) {

			mat.map = fix( mat.map, remap.albedo );
			mat.emissiveMap = fix( mat.emissiveMap, remap.emissive );
			mat.normalMap = fix( mat.normalMap, remap.normal );
			mat.bumpMap = fix( mat.bumpMap, remap.bump );
			mat.roughnessMap = fix( mat.roughnessMap, remap.roughness );
			mat.metalnessMap = fix( mat.metalnessMap, remap.metalness );
			mat.displacementMap = fix( mat.displacementMap, remap.displacement );
			mat.anisotropyMap = fix( mat.anisotropyMap, remap.anisotropy );
			mat.transmissionMap = fix( mat.transmissionMap, remap.transmission );
			mat.clearcoatMap = fix( mat.clearcoatMap, remap.clearcoat );
			mat.clearcoatRoughnessMap = fix( mat.clearcoatRoughnessMap, remap.clearcoatRoughness );
			mat.sheenColorMap = fix( mat.sheenColorMap, remap.sheenColor );
			mat.sheenRoughnessMap = fix( mat.sheenRoughnessMap, remap.sheenRoughness );
			mat.iridescenceMap = fix( mat.iridescenceMap, remap.iridescence );
			mat.iridescenceThicknessMap = fix( mat.iridescenceThicknessMap, remap.iridescenceThickness );
			mat.specularIntensityMap = fix( mat.specularIntensityMap, remap.specularIntensity );
			mat.specularColorMap = fix( mat.specularColorMap, remap.specularColor );

		}

	}

	/**
	 * Extract emissive triangles and build Light BVH.
	 * MUST run after BVH reordering — emissive data stores triangle indices
	 * that reference the main triangle storage buffer.
	 * @private
	 */
	_buildEmissiveData() {

		this.emissiveTriangleCount = this.emissiveTriangleBuilder.extractEmissiveTriangles(
			this.triangles,
			this.materials,
			this.triangleCount,
			this.instanceTable ?? null
		);

		this.emissiveTriangleData = this.emissiveTriangleBuilder.createEmissiveRawData();
		this.emissiveTotalPower = this.emissiveTriangleBuilder.totalEmissivePower;
		this._log( 'Emissive triangle extraction complete', this.emissiveTriangleBuilder.getStats() );

		// Build Light BVH for spatially-aware emissive sampling
		this.emissiveTriangleBuilder.buildLightBVH();
		this.lightBVHNodeData = this.emissiveTriangleBuilder.lightBVHNodeData;
		this.lightBVHNodeCount = this.emissiveTriangleBuilder.lightBVHNodeCount;
		// Replace emissiveTriangleData with sorted version (LBVH reorders it)
		this.emissiveTriangleData = this.emissiveTriangleBuilder.emissiveTriangleData || this.emissiveTriangleData;
		// Per-triangle bit-trail map for the bounce-hit MIS re-walk
		this.emissiveBitTrailMap = this.emissiveTriangleBuilder.emissiveBitTrailMap;
		// buildLightBVH is authoritative for the sampled (visible-subset) count/power
		this.emissiveTriangleCount = this.emissiveTriangleBuilder.emissiveCount;
		this.emissiveTotalPower = this.emissiveTriangleBuilder.totalEmissivePower;

	}

	/**
     * Create additional sphere objects if needed
     * @private
     */
	_createSpheres() {

		// Factory method for creating any additional scene elements
		// Currently returns an empty array by default
		// const white = new Color( 0xffffff );
		// const black = new Color( 0x000000 );
		return [
			// { position: new Vector3( - 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( - 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 1.5, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
			// { position: new Vector3( 4, 2, 0 ), radius: 0.8, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },

			// { position: new Vector3( 0, 2, 0 ), radius: 1, material: { color: white, emissive: black, emissiveIntensity: 0, roughness: 1.0 } },
		];

	}

	/**
     * Reset all data before processing a new scene
     * @private
     */
	_reset() {

		this._geometryVersion = ( this._geometryVersion ?? 0 ) + 1;
		this._disposeSpill();
		this._disposeGeometrySpill();

		// First dispose any existing resources
		this._disposeTextures();

		// Reset all containers
		this.triangles = [];
		this._setTriangleData( null );
		this.triangleCount = 0;
		this.materials = [];
		this.meshTriangleRanges = null;
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.roughnessMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.displacementMaps = [];
		this.anisotropyMaps = [];
		this.transmissionMaps = [];
		this.clearcoatMaps = [];
		this.clearcoatRoughnessMaps = [];
		this.sheenColorMaps = [];
		this.sheenRoughnessMaps = [];
		this.iridescenceMaps = [];
		this.iridescenceThicknessMaps = [];
		this.specularIntensityMaps = [];
		this.specularColorMaps = [];
		this.directionalLights = [];
		this.cameras = [];
		this.spheres = [];
		this.bvhRoot = null;
		this.bvh = null;
		this.bvhData = null;
		this.bvhIndexChunks = null;
		this.bvhIndex = null;
		this.instanceTable = null;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;
		this.emissiveBitTrailMap = null;

		// Reset performance metrics
		this.performanceMetrics = {
			textureCreationTime: 0,
			geometryExtractionTime: 0,
			bvhBuildTime: 0,
			blasBuildTime: 0,
			// Summed per-mesh build time reported by the workers. Divided by blasBuildTime it
			// gives how many workers were actually busy — a health signal, not a cost.
			blasWorkerTime: 0,
			tlasBuildTime: 0,
			bvhAssembleTime: 0,
			totalProcessingTime: 0
		};

	}

	/**
     * Dispose of texture resources
     * @private
     */
	_disposeTextures() {

		this._disposeBucketTextures();

	}

	/**
	 * Dispose the consolidated bucket arrays (srgb/linear), each an Array<K> of
	 * DataArrayTexture | null.
	 * @private
	 */
	_disposeBucketTextures() {

		for ( const prop of [ 'srgbBucketTextures', 'linearBucketTextures' ] ) {

			const arr = this[ prop ];
			if ( ! arr ) continue;
			for ( const tex of arr ) {

				if ( tex && typeof tex.dispose === 'function' ) {

					try {

						tex.dispose();

					} catch ( error ) {

						log.warn( `error disposing ${prop}:`, error );

					}

				}

			}

			this[ prop ] = null;

		}

	}

	/**
     * Rebuild only materials and textures without touching triangle/BVH data
     * @param {Object3D} object - Three.js object to extract materials from
     * @returns {Promise<SceneProcessor>} - This instance (for chaining)
     */
	async rebuildMaterials( object ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing. Cannot rebuild materials during processing." );

		}

		this._log( 'Rebuilding materials and textures' );
		const startTime = performance.now();

		try {

			// Set processing flag to prevent concurrent operations
			this.isProcessing = true;

			// Extract only material-related data from the scene (skip geometry extraction)
			const extractedData = this.geometryExtractor.extractMaterialsOnly( object );

			// Dispose old texture resources BEFORE updating arrays
			this._disposeMaterialTextures();

			// Update material arrays (but keep existing triangle data)
			this.materials = extractedData.materials;
			this.meshes = extractedData.meshes; // Update mesh data
			this.maps = extractedData.maps;
			this.normalMaps = extractedData.normalMaps;
			this.bumpMaps = extractedData.bumpMaps;
			this.roughnessMaps = extractedData.roughnessMaps;
			this.metalnessMaps = extractedData.metalnessMaps;
			this.emissiveMaps = extractedData.emissiveMaps;
			this.displacementMaps = extractedData.displacementMaps;

			// Bucket textures, remap material indices, regenerate raw material data, and
			// build the consolidated bucket arrays — same path as the initial build.
			await this._createMaterialTextures();

			const duration = performance.now() - startTime;
			this._log( `Material rebuild complete (${duration.toFixed( 2 )}ms)`, {
				materials: this.materials.length,
				textures: this.maps.length
			} );

			return this;

		} catch ( error ) {

			log.error( 'material rebuild failed:', error );
			throw error;

		} finally {

			// Always clear processing flag
			this.isProcessing = false;

		}

	}

	/**
     * Dispose only material-related textures
     * @private
     */
	_disposeMaterialTextures() {

		this._disposeBucketTextures();

		// Clear texture creator cache to prevent stale references
		if ( this.textureCreator && this.textureCreator.textureCache ) {

			this.textureCreator.textureCache.dispose();
			this.textureCreator.textureCache = new ( this.textureCreator.textureCache.constructor )();

		}

	}

	/**
     * Get statistics about the current state
     * @returns {Object} - Statistics object
     */
	getStatistics() {

		const baseStats = {
			triangleCount: this.triangleCount,
			materialCount: this.materials.length,
			textureCount: this.maps.length,
			lightCount: this.directionalLights.length,
			cameraCount: this.cameras.length,
			processingComplete: this.processingStage === 'complete',
			hasBVH: !! this.bvhRoot,
			hasTextures: !! this.materialData && !! this.bvh,
			useFloat32Array: this.config.useFloat32Array,
			triangleDataSize: this.triangles ? ( this.triangles.byteLength / ( 1024 * 1024 ) ).toFixed( 2 ) + 'MB' : '0MB'
		};

		// Add performance metrics
		if ( this.performanceMetrics.totalProcessingTime > 0 ) {

			baseStats.performance = {
				totalTime: this.performanceMetrics.totalProcessingTime,
				textureTime: this.performanceMetrics.textureCreationTime,
				bvhTime: this.performanceMetrics.bvhBuildTime,
				extractionTime: this.performanceMetrics.geometryExtractionTime,
				texturePercentage: ( ( this.performanceMetrics.textureCreationTime / this.performanceMetrics.totalProcessingTime ) * 100 ).toFixed( 1 ) + '%'
			};

		}

		// Add texture creator capabilities if available
		if ( this.textureCreator && this.textureCreator.capabilities ) {

			baseStats.textureCapabilities = this.textureCreator.capabilities;

		}

		return baseStats;

	}

	/**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
	updateConfig( newConfig ) {

		Object.assign( this.config, newConfig );

		// Update component configurations
		if ( this.bvhBuilder ) {

			this.bvhBuilder.maxLeafSize = this.config.maxLeafSize;

			// Update treelet optimization configuration
			this.bvhBuilder.setTreeletConfig( {
				enabled: this.config.enableTreeletOptimization,
				size: this.config.treeletSize,
				passes: this.config.treeletOptimizationPasses,
				minImprovement: this.config.treeletMinImprovement,
				complexityThreshold: this.config.treeletComplexityThreshold
			} );

		}

		// Note: TextureCreator auto-configures based on capabilities
		// but could be enhanced to accept runtime configuration updates

		this._log( 'Configuration updated', this.config );

	}

	// ===== BVH REFIT (Animation Support) =====

	/**
	 * Make sure a store's chunks live in shared memory. Already-shared chunks are left alone; a
	 * page without cross-origin isolation falls back to copying, which is the old cost.
	 * @private
	 */
	_adoptSharedChunks( field, LaneType ) {

		const records = this[ field ];
		if ( records.shared ) return;

		const chunks = records.chunks.map( c => {

			const view = new LaneType( new SharedArrayBuffer( c.byteLength ) );
			view.set( c );
			return view;

		} );

		const adopted = ChunkedRecords.adopt(
			chunks, records.recordCount, records.lanesPerRecord, records.recordsPerChunk
		);

		if ( field === 'bvh' ) this._setBVHData( adopted );
		else this._setTriangleData( adopted );

	}

	/**
	 * Normalize a caller's positions or normals into a per-mesh reader. A full-scene array is
	 * handed back as views into itself, so the old contract costs nothing extra; a callback lets a
	 * caller build one mesh at a time and never hold 9 floats × every triangle at once — 1,030 MB
	 * at 30M triangles, which is past what a renderer can allocate.
	 * @private
	 */
	_meshSource( source, what ) {

		if ( source == null ) return null;

		const table = this.instanceTable;

		if ( typeof source === 'function' ) {

			// The table is keyed by placement and one instanced mesh holds several, so a raw
			// placement index is not something the caller can look up. Hand back the mesh.
			return i => {

				const mesh = table.sourceMesh[ i ];
				const got = source( mesh, table.triCountOf( i ) );
				const want = table.triCountOf( i ) * 9;
				if ( got && got.length !== want ) {

					throw new Error(
						`SceneProcessor: ${what}s for mesh ${mesh} must be ${want} floats ` +
						`(${table.triCountOf( i )} triangles × 9), got ${got.length}.`
					);

				}

				return got ?? null;

			};

		}

		// A short array reads past its end and writes NaN through every AABB above it with no
		// error anywhere, so the scene just vanishes. Check once here instead.
		const expected = ( this.expandedTriangleCount ?? this.triangleCount ) * 9;
		if ( source.length !== expected ) {

			throw new Error(
				`SceneProcessor: expected ${expected} ${what} floats (${expected / 9} triangles × 9, ` +
				`full scene), got ${source.length}. Pass a per-mesh callback instead to avoid ` +
				'building one array for the whole scene.'
			);

		}

		return i => {

			const from = table.expandedStartOf( i ) * 9;
			return source.subarray( from, from + table.triCountOf( i ) * 9 );

		};

	}

	/**
	 * Refit BVH with updated vertex positions (same topology — no triangle add/remove).
	 * O(N) bottom-up AABB update instead of full O(N log N) SAH rebuild.
	 *
	 * @param {Float32Array|function(number, number): Float32Array} newPositions - either 9 floats
	 *   per triangle for the whole scene (meshes in `this.meshes` order), or a callback given a
	 *   mesh index and its triangle count that returns just that mesh's 9-floats-per-triangle
	 *   slice. Prefer the callback: the scene-wide form is 1,030 MB at 30M triangles.
	 * @param {Float32Array|function(number, number): Float32Array} [newNormals] - same two shapes
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	async refitBVH( newPositions, newNormals ) {

		this._geometryVersion = ( this._geometryVersion ?? 0 ) + 1;

		if ( ! this.bvh || ! this.triangles || ! this.instanceTable ) {

			throw new Error( 'No BVH data available for refit. Run buildBVH() first.' );

		}

		const positionsFor = this._meshSource( newPositions, 'position' );
		const normalsFor = this._meshSource( newNormals, 'normal' );

		if ( ! positionsFor ) throw new Error( 'SceneProcessor.refitBVH: positions are required.' );

		// Lazy-create worker
		if ( ! this._refitWorker ) {

			this._refitWorker = new BVHRefitWorker();

		}

		// First call: move triangles and nodes into shared memory so the worker refits them in
		// place. Positions never cross the boundary — they are scattered into the triangle records
		// below, one mesh at a time, so nothing scene-sized is allocated on either side.
		if ( ! this._refitSharedBuffers ) {

			// Both stores are built on SharedArrayBuffer when the page allows it, so the worker
			// takes them as they are. Copying instead would duplicate the two largest structures
			// in the scene — 3,968 MB at 30M triangles, which is where this used to fail.
			this._adoptSharedChunks( 'bvh', Float32Array );
			this._adoptSharedChunks( 'triangles', Uint32Array );

			const sharedBvhBufs = this.bvh.chunks.map( c => c.buffer );
			const sharedTriBufs = this.triangles.chunks.map( c => c.buffer );
			this._refitSharedBuffers = { bvhBufs: sharedBvhBufs, triBufs: sharedTriBufs };

			this._refitWorker.postMessage( {
				type: 'init',
				sharedBvhBufs,
				bvhRecordCount: this.bvh.recordCount,
				bvhRecordsPerChunk: this.bvh.recordsPerChunk,
				sharedTriBufs,
				triRecordCount: this.triangles.recordCount,
				triLanesPerRecord: this.triangles.lanesPerRecord,
				triRecordsPerChunk: this.triangles.recordsPerChunk,
			} );

		}

		// Scatter straight into the shared triangle records, mesh by mesh, so the caller's slice
		// can be released as soon as it is read. Callers hand over world space; triangles are
		// stored per instance, so each mesh comes back through its own inverse.
		const table = this.instanceTable;
		for ( let i = 0; i < table.count; i ++ ) {

			if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue;

			const p = positionsFor( i );
			if ( ! p ) continue;
			this._updateMeshTrianglePositions( i, p );

			// Smooth normals overwrite the face normals just computed, so they follow per mesh.
			if ( normalsFor ) {

				const n = normalsFor( i );
				if ( n ) this._patchMeshSmoothNormals( i, n );

			}

		}

		return new Promise( ( resolve, reject ) => {

			this._refitWorker.onmessage = ( e ) => {

				const msg = e.data;
				if ( msg.type === 'refitComplete' ) {

					resolve( { refitTimeMs: msg.refitTimeMs } );

				} else if ( msg.type === 'error' ) {

					reject( new Error( msg.error ) );

				}

			};

			// Signal worker — no data transfer needed, everything is in shared memory
			this._refitWorker.postMessage( { type: 'refit' } );

		} );

	}

	/**
	 * Overwrite face normals in triangleData with smooth vertex normals (full scene).
	 * @private
	 */
	_patchSmoothNormals( normalsFor ) {

		const table = this.instanceTable;
		if ( ! table ) return;

		for ( let i = 0; i < table.count; i ++ ) {

			if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue;
			const n = normalsFor( i );
			if ( n ) this._patchMeshSmoothNormals( i, n );

		}

	}

	/**
	 * Refit specific BLASes and rebuild TLAS after object transform or per-mesh animation.
	 * Runs on the main thread (fast for per-mesh updates).
	 *
	 * @param {number[]} affectedMeshIndices - Indices into `this.meshes`, the same space
	 *   {@link updateMeshTransforms} takes
	 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order (full scene)
	 * @param {Float32Array} [newNormals] - Optional smooth normals (9 floats per tri)
	 * @returns {{ refitTimeMs: number }}
	 */
	/**
	 * The placement holding a mesh's triangles. The instance table is keyed by placement and one
	 * instanced mesh contributes several, so every entry point taking mesh indices converts here.
	 *
	 * @param {number} meshIndex
	 * @returns {number} placement index, or -1 when the mesh placed nothing
	 * @private
	 */
	_placementOf( meshIndex ) {

		return this.instanceTable?.placementRunOf( meshIndex )?.start ?? - 1;

	}

	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		this._geometryVersion = ( this._geometryVersion ?? 0 ) + 1;

		if ( ! this.instanceTable || ! this.bvh || ! this.triangles ) {

			throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

		}

		const positionsFor = this._meshSource( newPositions, 'position' );
		const normalsFor = this._meshSource( newNormals, 'normal' );

		if ( ! positionsFor ) throw new Error( 'SceneProcessor.refitBLASes: positions are required.' );

		const start = performance.now();

		// Lazy-create refitter instance
		if ( ! this._blasRefitter ) {

			this._blasRefitter = new BVHRefitter();

		}

		// Step 1: Update triangle positions and refit each affected BLAS
		const table = this.instanceTable;

		for ( const meshIndex of affectedMeshIndices ) {

			const placement = this._placementOf( meshIndex );
			if ( placement < 0 || ! table.isSet[ placement ] ) continue;

			// Triangles are shared between placements of one geometry, so writing this mesh's
			// vertices would move every other copy with them. Anything that deforms is extracted
			// with triangles of its own, so reaching here means the wrong mesh was handed over.
			if ( ! table.isOwner( placement ) ) {

				const owner = table.tplOwner[ table.sourceMesh[ placement ] ];
				this.config.issues?.record(
					ISSUE_CODES.REFIT_SHARED_GEOMETRY,
					`mesh ${meshIndex} shares its triangles with another placement; deforming it would move every copy, so it was skipped`,
					{ meshIndex, owner: table.sourceMesh[ owner ] ?? owner }
				);
				continue;

			}

			const p = positionsFor( placement );
			if ( ! p ) continue;
			this._updateMeshTrianglePositions( placement, p );

			if ( normalsFor ) {

				const n = normalsFor( placement );
				if ( n ) this._patchMeshSmoothNormals( placement, n );

			}

			// Refit this BLAS's nodes
			this._blasRefitter.refitRange(
				this.bvh,
				this.triangles,
				table.blasOffsetOf( placement ),
				table.blasNodeCountOf( placement )
			);

			// Recompute this mesh's AABB for TLAS rebuild
			this.instanceTable.recomputeAABB( placement, this.bvh, this.triangles );

		}

		// Step 2: Refit TLAS AABBs in-place (O(tlasNodeCount), no SAH rebuild)
		this._refitTLAS();

		return { refitTimeMs: performance.now() - start };

	}

	/**
	 * Move objects without touching their geometry: the placements a mesh contributed get new
	 * transforms, the TLAS leaves get the matching world-to-object matrices, and the TLAS boxes
	 * are refit. Triangles, BLASes and the GPU triangle buffer are all left alone.
	 *
	 * This is what a gizmo drag wants. {@link refitBLASes} exists for geometry that actually
	 * deformed; used for a rigid move it would bake the new world positions into triangles that
	 * a second placement of the same geometry may be sharing, and drag that one along too.
	 *
	 * @param {number[]} meshIndices - indices into `this.meshes`
	 * @returns {{ refitTimeMs: number, placements: number }}
	 */
	updateMeshTransforms( meshIndices ) {

		if ( ! this.instanceTable || ! this.bvh ) {

			throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

		}

		const start = performance.now();
		const table = this.instanceTable;
		const composed = this._transformScratch ??= new Float32Array( 16 );
		let moved = 0;

		for ( const meshIndex of meshIndices ) {

			const mesh = this.meshes?.[ meshIndex ];
			const run = table.placementRunOf( meshIndex );
			if ( ! mesh || ! run ) continue;

			mesh.updateMatrixWorld( true );
			const world = mesh.matrixWorld.elements;
			const instances = mesh.isInstancedMesh ? this._ownInstanceMatrices( mesh ) : null;
			// Baked triangles hold the pose they were extracted at; the leaf only carries the delta.
			const bakeInverse = table.tplBakeInverse?.get( table.sourceMesh[ run.start ] ) ?? null;

			for ( let k = 0; k < run.count; k ++ ) {

				const p = run.start + k;
				if ( ! table.isSet[ p ] ) continue;

				if ( instances ) {

					multiplyAffine( world, instances, k * 16, composed );
					table.setPlacementMatrix( p, composed );

				} else if ( bakeInverse ) {

					multiplyAffine( world, bakeInverse, 0, composed );
					table.setPlacementMatrix( p, composed );

				} else {

					table.setPlacementMatrix( p, world );

				}

				this._writeLeafMatrix( p );
				moved ++;

			}

		}

		this._refitTLAS();

		return { refitTimeMs: performance.now() - start, placements: moved };

	}

	/**
	 * An InstancedMesh's own instance matrices, split off the placement pool if they still alias it.
	 *
	 * The extractor points a host-at-origin InstancedMesh straight at the pool, since world and
	 * instance matrices hold identical bytes there. Composing a moved host back into the pool would
	 * overwrite the matrices it just read, so the next move would compose onto its own result.
	 * @private
	 */
	_ownInstanceMatrices( mesh ) {

		const attr = mesh.instanceMatrix;
		if ( ! attr?.array ) return null;

		if ( attr.array.buffer === this.instanceTable.world.buffer ) {

			attr.array = attr.array.slice();
			attr.needsUpdate = true;

		}

		return attr.array;

	}

	/** Refresh one TLAS leaf's world-to-object matrix from the table. @private */
	_writeLeafMatrix( placement ) {

		const node = this.instanceTable.tlasLeafIndex[ placement ];
		if ( node < 0 ) return;

		TLASBuilder.writeLeafMatrix(
			this.bvh.chunkFor( node ), this.bvhIndexChunks.chunkFor( node ), this.bvh.baseOf( node ),
			this.instanceTable.world, placement
		);

	}

	/** The TLAS occupies the front of the BVH buffer and is the only part a move rewrites. */
	computeTLASDirtyRange() {

		return { offset: 0, count: this.instanceTable.tlasNodeCount * 16 };

	}

	/**
	 * Computes the dirty buffer ranges for a set of affected mesh BLASes.
	 * Used for partial GPU upload after per-mesh refit instead of full buffer copy.
	 *
	 * @param {number[]} affectedMeshIndices
	 * @returns {{ triRanges: Array<{offset:number,count:number}>, bvhRanges: Array<{offset:number,count:number}> }}
	 */
	computeBLASDirtyRanges( affectedMeshIndices ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const FPN = 16; // FLOATS_PER_NODE — 4 × vec4 per BVH node
		const triRanges = [];
		const bvhRanges = [];

		for ( const meshIndex of affectedMeshIndices ) {

			const table = this.instanceTable;
			const placement = this._placementOf( meshIndex );
			if ( placement < 0 || ! table.isSet[ placement ] ) continue;

			triRanges.push( { offset: table.triOffsetOf( placement ) * FPT, count: table.triCountOf( placement ) * FPT } );
			bvhRanges.push( { offset: table.blasOffsetOf( placement ) * FPN, count: table.blasNodeCountOf( placement ) * FPN } );

		}

		// Always include TLAS range (rebuilt on every refit)
		bvhRanges.push( { offset: 0, count: this.instanceTable.tlasNodeCount * FPN } );

		return { triRanges, bvhRanges };

	}

	/**
	 * Transfers all scene data (geometry, BVH, materials, textures, emissive, lights)
	 * from this SceneProcessor to the PathTracer stage for GPU rendering.
	 *
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
	 * @param {import('../managers/LightManager.js').LightManager} lightManager
	 * @param {import('three').Scene} meshScene
	 * @param {import('three').Texture|null} environmentTexture
	 * @param {{keepUserLights?: boolean}} [options] - an incremental rebuild keeps the lights a host added
	 * @returns {boolean} false if critical data is missing
	 */
	uploadToPathTracer( pathTracer, lightManager, meshScene, environmentTexture, { keepUserLights = false } = {} ) {

		if ( ! this.triangles ) {

			log.error( 'failed to get triangle data' );
			return false;

		}

		pathTracer.setTriangleData( this.triangles, this.triangleCount );

		if ( ! this.bvh ) {

			log.error( 'failed to get BVH data' );
			return false;

		}

		pathTracer.setBVHData( this.bvh );
		pathTracer.setInstanceTable( this.instanceTable );

		if ( this.materialData ) {

			pathTracer.materialData.setMaterialData( this.materialData, this.materials.map( m => m.sources ) );

		} else {

			log.warn( 'no material data, using defaults' );

		}

		if ( environmentTexture ) {

			pathTracer.environment.setEnvironmentTexture( environmentTexture );

		}

		pathTracer.materialData.setMaterialTextures( {
			srgbBuckets: this.srgbBucketTextures,
			linearBuckets: this.linearBucketTextures,
		} );
		// Hand the uuid→packed maps to materialData so runtime edits (updateMaterial) can
		// re-pack a texture's index against this scene's bucket layout.
		pathTracer.materialData.setTexturePackMaps?.( this._srgbTexPacked, this._linearTexPacked );

		if ( this.emissiveTriangleData ) {

			pathTracer.setEmissiveTriangleData(
				this.emissiveTriangleData,
				this.emissiveTriangleCount,
				this.emissiveTotalPower,
				this.emissiveBitTrailMap,
			);
			// The light buffer holds the map from here; a rebuild makes a new one.
			this._releaseBitTrailMap();

		}

		if ( this.lightBVHNodeData ) {

			pathTracer.setLightBVHData(
				this.lightBVHNodeData,
				this.lightBVHNodeCount,
			);

		}

		lightManager.transferSceneLights( meshScene, { keepUserLights } );
		return true;

	}

	/**
	 * Updates material emissive data and rebuilds emissive triangle sampling data.
	 * Returns null if no change, or the updated emissive data for GPU upload.
	 *
	 * @param {number} materialIndex
	 * @param {string} property - 'emissive' | 'emissiveIntensity'
	 * @param {*} value
	 * @returns {{ rawData: Float32Array, emissiveCount: number, totalPower: number }|null}
	 */
	updateMaterialEmissive( materialIndex, property, value ) {

		if ( ! this.emissiveTriangleBuilder ) return null;

		const mat = this.materials[ materialIndex ];
		if ( ! mat ) return null;

		if ( property === 'emissive' ) mat.emissive = value;
		else if ( property === 'emissiveIntensity' ) mat.emissiveIntensity = value;

		const changed = this.emissiveTriangleBuilder.updateMaterialEmissive(
			materialIndex, mat,
			this.triangles, this.materials, this.triangleCount,
		);

		if ( ! changed ) return null;

		return this._collectEmissivePayload();

	}

	/**
	 * Re-read every emitter's colour, after the working space changed.
	 *
	 * `rebuildMaterials` re-packs the material buffer but leaves this list alone, and next-event
	 * estimation lights the scene from this list — so without a rebuild, emitters would be seen in
	 * the new space and cast light in the old one.
	 *
	 * @returns {object|null} GPU upload payload
	 */
	rebuildEmissiveColors() {

		if ( ! this.emissiveTriangleBuilder || ! this.triangleCount ) return null;

		this.emissiveTriangleBuilder.extractEmissiveTriangles(
			this.triangles,
			this.materials,
			this.triangleCount,
			this.instanceTable ?? null
		);
		this.emissiveTriangleBuilder.createEmissiveRawData();
		return this._collectEmissivePayload();

	}

	/**
	 * Re-derive the sampled emissive set from per-mesh visibility.
	 * @param {Set<number>|Iterable<number>} hiddenMeshIndices - meshIndex values that are world-hidden
	 * @param {boolean} force - rebuild even if the effective hidden set is unchanged
	 * @returns {object|null} GPU upload payload, or null when nothing changed
	 */
	rebuildEmissiveForVisibility( hiddenMeshIndices, force = false ) {

		if ( ! this.emissiveTriangleBuilder ) return null;

		const changed = this.emissiveTriangleBuilder.setHiddenMeshes( hiddenMeshIndices );
		if ( ! changed && ! force ) return null;

		return this._collectEmissivePayload();

	}

	/** Whether any of these meshes emits light. */
	movesEmitters( meshIndices ) {

		const emitters = this.emissiveTriangleBuilder?.emissiveMeshes;
		return !! emitters?.size && meshIndices.some( m => emitters.has( m ) );

	}

	/**
	 * Re-measure emitters at their current placements and rebuild the light hierarchy.
	 * @returns {object|null} GPU upload payload, or null when the scene has no emitters
	 */
	refreshEmissiveTransforms() {

		const builder = this.emissiveTriangleBuilder;
		if ( ! builder?.emissiveTriangles.length || ! this.instanceTable || ! this.triangles ) return null;

		builder.refreshTransforms( this.triangles, this.instanceTable );
		return this._collectEmissivePayload();

	}

	/**
	 * Rebuild the Light BVH + sorted emissive data + bit-trail map (over the visible
	 * subset) so the stochastic descent and the bounce-hit MIS re-walk stay consistent,
	 * then sync the processor fields and return the GPU upload payload.
	 * @private
	 */
	_collectEmissivePayload() {

		this.emissiveTriangleBuilder.buildLightBVH();
		this.lightBVHNodeData = this.emissiveTriangleBuilder.lightBVHNodeData;
		this.lightBVHNodeCount = this.emissiveTriangleBuilder.lightBVHNodeCount;
		this.emissiveTriangleData = this.emissiveTriangleBuilder.emissiveTriangleData;
		this.emissiveBitTrailMap = this.emissiveTriangleBuilder.emissiveBitTrailMap;
		this.emissiveTriangleCount = this.emissiveTriangleBuilder.emissiveCount;
		this.emissiveTotalPower = this.emissiveTriangleBuilder.totalEmissivePower;

		const bitTrailMap = this.emissiveBitTrailMap;
		this._releaseBitTrailMap();

		return {
			rawData: this.emissiveTriangleData,
			emissiveCount: this.emissiveTriangleCount,
			totalPower: this.emissiveTotalPower,
			bitTrailMap,
			lightBVHNodeData: this.lightBVHNodeData,
			lightBVHNodeCount: this.lightBVHNodeCount,
		};

	}

	/** Whether any triangle records or BLAS nodes are on disk (see {@link spillToDisk}). */
	get spilled() {

		return !! ( this.triangles?.spilledChunks || this.bvh?.spilledChunks );

	}

	/**
	 * Experimental memory spill: once the scene is on the GPU, moves the triangle records and the
	 * BLAS part of the BVH to disk. The TLAS stays, so visibility and rigid moves need nothing
	 * back; anything that reads triangles or BLAS nodes awaits {@link ensureResident} first.
	 * Multi-chunk scenes only — below a chunk the saving is small and the cost is not.
	 * @param {import('../Storage/StorageManager.js').StorageManager} storage
	 * @returns {Promise<?{bytes: number, ms: number}>} null when nothing was spilled
	 */
	async spillToDisk( storage ) {

		const triangles = this.triangles;
		const bvh = this.bvh;
		if ( ! storage || this.spilled || this._spillStores || ! triangles?.chunks || triangles.chunks.length < 2 || ! bvh?.chunks ) return null;

		await this._blasStoring;
		const version = this._geometryVersion;
		const started = performance.now();
		const key = `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}`;
		const stride = records => records.recordsPerChunk * records.lanesPerRecord * records.LaneType.BYTES_PER_ELEMENT;

		const triStore = await SpillStore.create( storage, `${key}:tri`, stride( triangles ), { label: 'Triangle records', expectedBytes: triangles.byteLength } );
		const bvhStore = triStore && await SpillStore.create( storage, `${key}:bvh`, stride( bvh ), { label: 'BLAS nodes', expectedBytes: bvh.byteLength } );
		if ( ! triStore || ! bvhStore ) {

			await triStore?.dispose();
			return null;

		}

		this._spillStores = [ triStore, bvhStore ];
		const tlasChunks = Math.ceil( ( this.instanceTable?.tlasNodeCount ?? 1 ) / bvh.recordsPerChunk );

		let bytes = await triangles.spill( triStore );
		bytes += await bvh.spill( bvhStore, { keep: k => k < tlasChunks } );
		await triStore.flush();
		await bvhStore.flush();

		if ( version !== this._geometryVersion ) return null;
		const ms = performance.now() - started;
		log.info( `spilled ${( bytes / 1048576 ).toFixed( 0 )} MB of triangles and BLAS nodes to disk in ${ms.toFixed( 0 )} ms` );
		return { bytes, ms };

	}

	/** Reads every spilled triangle record and BLAS node back, then drops the scratch files. */
	ensureResident() {

		this._paging ??= ( async () => {

			await this.triangles?.ensureResident?.();
			await this.bvh?.ensureResident?.();
			if ( ! this.spilled ) this._disposeSpill();

		} )().finally( () => {

			this._paging = null;

		} );

		return this._paging;

	}

	/** Reads the three.js geometry a streamed build moved to disk back into place. @private */
	async _restoreGeometry( object ) {

		const spill = this._geometrySpill;
		if ( ! spill?.bytes ) return;
		updateLoading( { status: 'Reading scene geometry back...', progress: 84 } );
		const started = performance.now();
		const bytes = spill.bytes;
		await spill.restore();
		this._disposeGeometrySpill();
		this._geometryBytes = geometryBytesOf( object );
		log.info( `read ${fmt.mb( bytes )} of scene geometry back from disk in ${fmt.ms( performance.now() - started )}` );
		if ( spill.error ) log.warn( 'some scene geometry stayed in memory, its spill write failed:', spill.error );

	}

	/** @private */
	_disposeGeometrySpill() {

		const spill = this._geometrySpill;
		this._geometrySpill = null;
		spill?.dispose().catch( () => {} );

	}

	/** @private */
	_disposeSpill() {

		const stores = this._spillStores;
		this._spillStores = null;
		for ( const store of stores ?? [] ) store.dispose().catch( () => {} );

	}

	/** The map goes to the path tracer's light buffer and is not kept here as well. */
	_releaseBitTrailMap() {

		this.emissiveBitTrailMap = null;
		if ( this.emissiveTriangleBuilder ) this.emissiveTriangleBuilder.emissiveBitTrailMap = null;

	}

	/**
	 * Copy world-space positions into `dst`, each mesh's range carried into its own space.
	 * @private
	 */
	/**
	 * Build the TLAS, off the main thread when a worker is available.
	 *
	 * The worker returns structure only; leaf payloads are filled here. On any failure the
	 * synchronous path runs instead, so a blocked or unavailable worker costs responsiveness,
	 * never a scene.
	 * @private
	 */
	async _buildTLAS( table ) {

		const n = table.count;

		// Below this the build is a few ms and the round trip costs more than it saves.
		if ( n >= TLAS_WORKER_MIN_ENTRIES && ! this._tlasWorkerFailed ) {

			try {

				// The worker needs a buffer it can own, and world bounds are derived anyway.
				const aabbs = new Float64Array( n * 6 );
				table.writeWorldAABBs( aabbs );
				const { tlasData, nodeCount } = await this._runTLASWorker( aabbs, n );
				TLASBuilder.fillLeaves( tlasData, nodeCount, table );
				return tlasData;

			} catch ( error ) {

				this._tlasWorkerFailed = true;
				log.warn( `TLAS worker unavailable (${error.message}); building on the main thread` );

			}

		}

		return this.tlasBuilder.build( table ).data;

	}

	/** @private */
	_runTLASWorker( aabbs, count ) {

		if ( ! this._tlasWorker ) this._tlasWorker = new TLASWorker();
		const worker = this._tlasWorker;

		return new Promise( ( resolve, reject ) => {

			const done = ( event ) => {

				worker.removeEventListener( 'message', done );
				worker.removeEventListener( 'error', failed );
				if ( event.data?.error ) reject( new Error( event.data.error ) );
				else resolve( event.data );

			};

			const failed = ( event ) => {

				worker.removeEventListener( 'message', done );
				worker.removeEventListener( 'error', failed );
				reject( new Error( event.message || 'worker error' ) );

			};

			worker.addEventListener( 'message', done );
			worker.addEventListener( 'error', failed );
			worker.postMessage(
				{ aabbs: aabbs.buffer, count, logLevel: workerLogLevel() },
				[ aabbs.buffer ]
			);

		} );

	}

	/** Keep the f32 view in step with the uint record buffer. @private */
	/** Keep the chunked BVH and its u32 index view in step. @private */
	_setBVHData( data ) {

		const records = ! data ? null
			: ( data instanceof ChunkedRecords
				? data
				: ChunkedRecords.adopt( [ data ], data.length / 16, 16, data.length / 16 ) );

		this.bvh = records;
		this.bvhIndexChunks = records ? records.viewAs( Uint32Array ) : null;
		// Null once the BVH needs more than one chunk; hot paths use `bvh` / `bvhIndexChunks`.
		this.bvhData = records ? records.single : null;
		this.bvhIndex = this.bvhIndexChunks ? this.bvhIndexChunks.single : null;

	}

	_setTriangleData( data ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const records = ! data ? null
			: ( data instanceof ChunkedRecords
				? data
				: ChunkedRecords.adopt( [ data ], data.length / FPT, FPT, data.length / FPT ) );

		this.triangles = records;
		this.triangleFloatChunks = records ? records.viewAs( Float32Array ) : null;
		// Null once the scene needs more than one chunk; everything hot goes through
		// `triangles` / `triangleFloatChunks` instead.
		this.triangleData = records ? records.single : null;
		this.triangleFloats = this.triangleFloatChunks ? this.triangleFloatChunks.single : null;

	}

	/**
	 * Update triangle positions for a single mesh entry.
	 * Iterates in BVH order for sequential writes (cache-friendly), random reads from newPositions.
	 * @private
	 */
	_updateMeshTrianglePositions( i, meshPositions ) {

		const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
		const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
		const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;
		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;
		const tri = this.triangles, triF = this.triangleFloatChunks;
		const table = this.instanceTable;

		const bvhToOrig = table.bvhToOriginalOf( i );
		const triOffset = table.triOffsetOf( i ), triCount = table.triCountOf( i );

		// Callers hand over world-space positions, which is the only space they can build
		// one in; triangles are stored per instance, so they come back through the inverse.
		const m = table.matrixInverseOf( i );
		const identity = isIdentity( m );

		for ( let bvhLocal = 0; bvhLocal < triCount; bvhLocal ++ ) {

			const origLocal = bvhToOrig ? bvhToOrig[ bvhLocal ] : bvhLocal;
			const t = triOffset + bvhLocal;
			const f = triF.chunkFor( t ), u = tri.chunkFor( t );
			const dst = tri.baseOf( t );
			const src = origLocal * 9;

			let ax = meshPositions[ src ];
			let ay = meshPositions[ src + 1 ];
			let az = meshPositions[ src + 2 ];
			let bx = meshPositions[ src + 3 ];
			let by = meshPositions[ src + 4 ];
			let bz = meshPositions[ src + 5 ];
			let cx = meshPositions[ src + 6 ];
			let cy = meshPositions[ src + 7 ];
			let cz = meshPositions[ src + 8 ];

			if ( ! identity ) {

				const px = ( x, y, z ) => m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
				const py = ( x, y, z ) => m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
				const pz = ( x, y, z ) => m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];
				const a = [ px( ax, ay, az ), py( ax, ay, az ), pz( ax, ay, az ) ];
				const b = [ px( bx, by, bz ), py( bx, by, bz ), pz( bx, by, bz ) ];
				const c = [ px( cx, cy, cz ), py( cx, cy, cz ), pz( cx, cy, cz ) ];
				ax = a[ 0 ]; ay = a[ 1 ]; az = a[ 2 ];
				bx = b[ 0 ]; by = b[ 1 ]; bz = b[ 2 ];
				cx = c[ 0 ]; cy = c[ 1 ]; cz = c[ 2 ];

			}

			f[ dst + PA ] = ax;
			f[ dst + PA + 1 ] = ay;
			f[ dst + PA + 2 ] = az;
			f[ dst + PB ] = bx;
			f[ dst + PB + 1 ] = by;
			f[ dst + PB + 2 ] = bz;
			f[ dst + PC ] = cx;
			f[ dst + PC + 1 ] = cy;
			f[ dst + PC + 2 ] = cz;

			const abx = bx - ax, aby = by - ay, abz = bz - az;
			const acx = cx - ax, acy = cy - ay, acz = cz - az;
			const packed = packNormalOct(
				aby * acz - abz * acy,
				abz * acx - abx * acz,
				abx * acy - aby * acx
			);

			u[ dst + NA ] = packed;
			u[ dst + NB ] = packed;
			u[ dst + NC ] = packed;

		}

	}

	/**
	 * Patch smooth normals for a single mesh's triangles.
	 * @private
	 */
	_patchMeshSmoothNormals( i, meshNormals ) {

		const table = this.instanceTable;
		this._patchNormalsRange(
			meshNormals, table.triOffsetOf( i ), table.triCountOf( i ),
			table.matrixWorldOf( i ), table.bvhToOriginalOf( i )
		);

	}

	/**
	 * Shared normal-patching loop for a range of triangles.
	 * @private
	 */
	_patchNormalsRange( normals, triOffset, count, matrixWorld, bvhToOrig ) {

		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;

		// Callers supply world-space normals. Traversal takes object normals out through the
		// transpose of world-to-object, so coming the other way is the transpose of
		// object-to-world — not its inverse, which is what a position would use.
		const m = matrixWorld;
		const plain = ! m || isIdentity( m );
		const slots = [ NA, NB, NC ];

		// Walked in stored order so the writes stay sequential; the inverse map is the only
		// permutation kept, so the read is the scattered side.
		for ( let k = 0; k < count; k ++ ) {

			const bvhIdx = triOffset + k;
			const u = this.triangles.chunkFor( bvhIdx );
			const dst = this.triangles.baseOf( bvhIdx );
			const src = ( bvhToOrig ? bvhToOrig[ k ] : k ) * 9;

			for ( let v = 0; v < 3; v ++ ) {

				const s = src + v * 3;
				const nx = normals[ s ], ny = normals[ s + 1 ], nz = normals[ s + 2 ];
				let ox = nx, oy = ny, oz = nz;

				if ( ! plain ) {

					ox = m[ 0 ] * nx + m[ 1 ] * ny + m[ 2 ] * nz;
					oy = m[ 4 ] * nx + m[ 5 ] * ny + m[ 6 ] * nz;
					oz = m[ 8 ] * nx + m[ 9 ] * ny + m[ 10 ] * nz;
					const len = Math.hypot( ox, oy, oz ) || 1;
					ox /= len; oy /= len; oz /= len;

				}

				u[ dst + slots[ v ] ] = packNormalOct( ox, oy, oz );

			}

		}

	}

	/**
	 * Refit TLAS AABBs in-place without rebuilding the tree structure.
	 * O(tlasNodeCount) bottom-up pass — much faster than full SAH rebuild.
	 * @private
	 */
	_refitTLAS() {

		const tlasNodeCount = this.instanceTable.tlasNodeCount;
		const FPN = 16;

		// Grow-only bounds buffer for TLAS refit
		if ( ! this._tlasBounds || this._tlasBounds.length < tlasNodeCount * 6 ) {

			this._tlasBounds = new Float32Array( tlasNodeCount * 6 );

		}

		const table = this.instanceTable;

		// Bottom-up pass: reverse iteration over TLAS nodes
		for ( let i = tlasNodeCount - 1; i >= 0; i -- ) {

			const idxChunk = this.bvhIndexChunks.chunkFor( i );
			const fChunk = this.bvh.chunkFor( i );
			const o = this.bvh.baseOf( i );
			const marker = idxChunk[ o + 3 ];

			if ( marker === BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ) {

				// Slot [1] is this leaf's own placement. Keying off slot [0] instead collapsed
				// every placement of a shared geometry onto one box, so all but one copy sat
				// outside its own bounds and rays walked straight past it.
				const entryIndex = idxChunk[ o + 1 ] & TLAS_PLACEMENT_MASK;
				if ( entryIndex < table.count ) {

					table.writeWorldAABB( entryIndex, this._tlasBounds, i * 6 );

				}

			} else if ( marker < BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

				// Inner node: union of children bounds, update bvhData in-place
				const leftIdx = marker;
				const rightIdx = idxChunk[ o + 7 ];
				const lb = leftIdx * 6;
				const rb = rightIdx * 6;
				const bounds = this._tlasBounds;

				fChunk[ o ] = bounds[ lb ];
				fChunk[ o + 1 ] = bounds[ lb + 1 ];
				fChunk[ o + 2 ] = bounds[ lb + 2 ];
				fChunk[ o + 4 ] = bounds[ lb + 3 ];
				fChunk[ o + 5 ] = bounds[ lb + 4 ];
				fChunk[ o + 6 ] = bounds[ lb + 5 ];

				fChunk[ o + 8 ] = bounds[ rb ];
				fChunk[ o + 9 ] = bounds[ rb + 1 ];
				fChunk[ o + 10 ] = bounds[ rb + 2 ];
				fChunk[ o + 12 ] = bounds[ rb + 3 ];
				fChunk[ o + 13 ] = bounds[ rb + 4 ];
				fChunk[ o + 14 ] = bounds[ rb + 5 ];

				const b = i * 6;
				bounds[ b ] = Math.min( bounds[ lb ], bounds[ rb ] );
				bounds[ b + 1 ] = Math.min( bounds[ lb + 1 ], bounds[ rb + 1 ] );
				bounds[ b + 2 ] = Math.min( bounds[ lb + 2 ], bounds[ rb + 2 ] );
				bounds[ b + 3 ] = Math.max( bounds[ lb + 3 ], bounds[ rb + 3 ] );
				bounds[ b + 4 ] = Math.max( bounds[ lb + 4 ], bounds[ rb + 4 ] );
				bounds[ b + 5 ] = Math.max( bounds[ lb + 5 ], bounds[ rb + 5 ] );

			}

		}

	}

	/**
	 * Schedule background BLAS rebuilds for affected meshes.
	 * Rebuilds optimal SAH BVH in a worker, then swaps into the combined buffer.
	 * Stale rebuilds (object moved again) are discarded via generation counter.
	 *
	 * @param {number[]} meshIndices - Mesh indices to rebuild
	 * @param {Function} onSwap - Called after a successful swap (for GPU upload)
	 */
	scheduleBackgroundRebuild( meshIndices, onSwap ) {

		if ( ! this.instanceTable || ! this.triangles ) return;

		this._rebuildGeneration ++;
		const generation = this._rebuildGeneration;

		const dispatchRebuild = ( meshIdx, entry, worker ) => {

			const meshTriData = this.triangles.copyOf( entry.triOffset, entry.triCount );

			this._pendingRebuilds.set( meshIdx, worker );

			worker.onmessage = ( e ) => {

				const data = e.data;
				worker.terminate();
				this._pendingRebuilds.delete( meshIdx );

				if ( data.error ) {

					log.error( `background BLAS rebuild failed (mesh ${meshIdx}):`, data.error );
					return;

				}

				// Discard if object was transformed again since this rebuild started
				if ( generation !== this._rebuildGeneration ) return;

				this._swapBLAS( meshIdx, entry, data, onSwap );

			};

			worker.onerror = ( err ) => {

				log.error( `background BLAS rebuild worker failed (mesh ${meshIdx}):`, err );
				worker.terminate();
				this._pendingRebuilds.delete( meshIdx );

			};

			// Disable treelet for tiny meshes
			const treeletEnabled = entry.triCount > 500;

			worker.postMessage( {
				triangleData: meshTriData.buffer,
				triangleByteOffset: meshTriData.byteOffset,
				triangleByteLength: meshTriData.byteLength,
				triangleCount: entry.triCount,
				depth: this.config.bvhDepth,
				// Without these the worker builds at its own defaults (leaf size 8 against the
				// scene's 4), producing a tree of a different size that the swap below rejects —
				// so every rebuild was thrown away.
				maxLeafSize: this.bvhBuilder.maxLeafSize,
				numBins: this.bvhBuilder.numBins,
				maxBins: this.bvhBuilder.maxBins,
				minBins: this.bvhBuilder.minBins,
				reportProgress: false,
				sharedReorderBuffer: null,
				treeletOptimization: {
					enabled: treeletEnabled,
					size: this.config.treeletSize,
					passes: this.config.treeletOptimizationPasses,
					minImprovement: this.config.treeletMinImprovement,
					complexityThreshold: this.config.treeletComplexityThreshold
				},
				reinsertionOptimization: {
					enabled: this.bvhBuilder.enableReinsertionOptimization,
					batchSizeRatio: this.bvhBuilder.reinsertionBatchSizeRatio,
					maxIterations: this.bvhBuilder.reinsertionMaxIterations
				},
			}, [ meshTriData.buffer ] );

		};

		for ( const meshIndex of meshIndices ) {

			const placement = this._placementOf( meshIndex );
			if ( placement < 0 ) continue;
			const entry = this.instanceTable.entryAt( placement );
			// A placement that borrows another's BLAS must not rebuild it: the work is the
			// owner's, and two placements would dispatch the same rebuild twice.
			if ( ! entry || ! this.instanceTable.isOwner( placement ) ) continue;

			// Cancel any in-flight rebuild for this mesh
			const existing = this._pendingRebuilds.get( placement );
			if ( existing ) existing.terminate();

			dispatchRebuild( placement, entry, new BVHWorker() );

		}

	}

	/**
	 * Swap a rebuilt BLAS into the combined buffer.
	 * @private
	 */
	_swapBLAS( meshIdx, entry, workerData, onSwap ) {

		this._geometryVersion = ( this._geometryVersion ?? 0 ) + 1;

		const FPN = 16;
		const newBvhData = workerData.bvhData;
		const newNodeCount = newBvhData.length / FPN;

		// The rebuilt tree only has to fit the range the build reserved. Demanding an exact match
		// was too strict: the triangles have moved, so the splits land differently and the count
		// legitimately drifts. Anything past the reserved range would overwrite the next BLAS.
		if ( newNodeCount > entry.blasNodeCount ) {

			log.warn( `background rebuild does not fit for mesh ${meshIdx} (${newNodeCount} nodes vs ${entry.blasNodeCount} reserved), skipping swap` );
			return;

		}

		// Write rebuilt BLAS nodes into the combined buffer at the entry's offset
		this.bvh.setRecords( entry.blasOffset, newBvhData );
		this._offsetBLASInPlace( entry.blasOffset, newNodeCount, entry.blasOffset, entry.triOffset );

		// Write reordered triangles back into global array
		const reorderedTris = workerData.triangles;
		if ( reorderedTris ) {

			this.triangles.setRecords( entry.triOffset, reorderedTris );

		}

		// The live tree is whatever the rebuild produced; any reserved nodes past it are dead and
		// nothing reaches them, but a later refit would walk them as garbage.
		this.instanceTable.setBlasNodeCount( meshIdx, newNodeCount );

		// The rebuild reordered the triangles, so the map from stored order back to the caller's
		// order has to follow. `entryAt()` hands back a snapshot, so writing it there was lost and
		// the next refit scattered every position through the previous permutation.
		//
		// The worker was handed the triangles already in stored order, so its permutation is
		// relative to that, not to the caller's order. Overwriting rather than composing would
		// discard how the original build shuffled them.
		const newOrigToBvh = workerData.originalToBvh;
		if ( newOrigToBvh ) {

			const prev = this.instanceTable.bvhToOriginalOf( meshIdx );
			const bvhToOrig = new Uint32Array( entry.triCount );
			for ( let i = 0; i < entry.triCount; i ++ ) {

				bvhToOrig[ newOrigToBvh[ i ] ] = prev ? prev[ i ] : i;

			}

			this.instanceTable.setBvhToOriginal( meshIdx, bvhToOrig );

		}

		// Recompute AABB and refit TLAS
		this.instanceTable.recomputeAABB( meshIdx, this.bvh, this.triangles );
		this._refitTLAS();

		this._log( `Background BLAS rebuild complete for mesh ${meshIdx}` );

		// The caller asked in mesh indices and gets one back, not the placement used here.
		onSwap?.( this.instanceTable.sourceMesh[ meshIdx ] ?? meshIdx );

	}

	/**
	 * Cancel all pending background rebuilds.
	 */
	cancelBackgroundRebuilds() {

		for ( const worker of this._pendingRebuilds.values() ) {

			worker.terminate();

		}

		this._pendingRebuilds.clear();

	}

	/**
	 * Terminate the refit worker if active.
	 * @private
	 */
	_disposeRefitWorker() {

		if ( this._refitWorker ) {

			this._refitWorker.terminate();
			this._refitWorker = null;

		}

		this._refitSharedBuffers = null;
		this.cancelBackgroundRebuilds();

	}

	/** @private */
	_disposeTLASWorker() {

		if ( this._tlasWorker ) {

			this._tlasWorker.terminate();
			this._tlasWorker = null;

		}

	}

	/**
     * Completely dispose of all resources
     * Call this when the instance is no longer needed
     */
	dispose() {

		this._geometryVersion = ( this._geometryVersion ?? 0 ) + 1;

		this._log( 'Disposing resources' );

		// Dispose workers
		this._disposeRefitWorker();
		this._disposeTLASWorker();

		// Dispose textures
		this._disposeTextures();

		// Clear all data
		this._reset();

		// Dispose texture creator
		if ( this.textureCreator ) {

			this.textureCreator.dispose();
			this.textureCreator = null;

		}

		// Clear reference to other processing components
		this.geometryExtractor = null;
		this.bvhBuilder = null;
		this.tlasBuilder = null;
		this._blasRefitter = null;

	}

}
