// SceneProcessor.js - Processes scene geometry into GPU-ready data (BVH, textures, materials)
import { BVHBuilder } from './BVHBuilder.js';
import { BVHRefitter } from './BVHRefitter.js';
import { buildBVHParallel, shouldUseParallelBuild } from './ParallelBVHBuilder.js';
import { TLASBuilder } from './TLASBuilder.js';
import { InstanceTable, isIdentity } from './InstanceTable.js';
import { TextureCreator } from './TextureCreator.js';
import { GeometryExtractor } from './GeometryExtractor.js';
import { EmissiveTriangleBuilder } from './EmissiveTriangleBuilder.js';
import { updateLoading } from '../Processor/utils.js';
import { BuildTimer } from './BuildTimer.js';
import { createLogger, fmt, workerLogLevel } from '../utils/Logger.js';
import { SRGBColorSpace } from 'three';
import {
	TRIANGLE_DATA_LAYOUT, TEXTURE_CONSTANTS, getTextureBucketId, packTextureIndex, planTextureBuckets,
	packNormalOct } from '../EngineDefaults.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import BVHWorker from './Workers/BVHWorker.js?worker&inline';
import BVHRefitWorker from './Workers/BVHRefitWorker.js?worker&inline';
import TLASWorker from './Workers/TLASWorker.js?worker&inline';

// Under this the TLAS build is a few ms; the worker round trip would cost more than it saves.
const TLAS_WORKER_MIN_ENTRIES = 50_000;

const log = createLogger( 'scene' );

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
			// Treelet optimization configuration
			// Keep: `_buildBVH` sends `enabled: value !== false`, so undefined re-enables treelets.
			enableTreeletOptimization: false,
			treeletSize: 7, // 7 nodes gives 315 topologies for optimal enumeration
			treeletOptimizationPasses: 1,
			treeletMinImprovement: 0.01, // Minimum SAH improvement threshold
			// Above this triangle count the builder drops treelets to size 3.
			treeletComplexityThreshold: 50000,
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
		this.bvhData = null;
		this.materialData = null;

		// Two-level BVH (TLAS/BLAS) support
		this.instanceTable = null; // Per-mesh BLAS metadata
		this.originalToBvhMap = null; // Uint32Array: original tri index → BVH-order index (global, for legacy compat)
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

		// Performance tracking
		this.performanceMetrics = {
			textureCreationTime: 0,
			geometryExtractionTime: 0,
			bvhBuildTime: 0,
			blasBuildTime: 0,
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
     * Build the BVH from a 3D object/scene
     * @param {Object3D} object - Three.js object to process
     * @returns {Promise<SceneProcessor>} - This instance (for chaining)
     */
	async buildBVH( object ) {

		if ( this.isProcessing ) {

			throw new Error( "Already processing a scene. Call dispose() first." );

		}

		this.isProcessing = true;
		this.processingStage = 'init';

		const timer = new BuildTimer( object.name ?? '', { namespace: 'scene' } );

		try {

			// Reset state before beginning
			this._reset();
			this._log( 'Starting scene processing' );

			// Step 1: Extract geometry (0-20%)
			this.processingStage = 'extraction';
			timer.start( 'Geometry extraction' );
			await this._extractGeometry( object );
			timer.end( 'Geometry extraction' );
			this.performanceMetrics.geometryExtractionTime = timer.getDuration( 'Geometry extraction' );

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
			if ( this.bvhRoot && ! this.bvhData ) {

				this.bvhData = this.textureCreator.createBVHRawData( this.bvhRoot );

			}

			timer.end( 'BVH data packing' );

			// Create additional scene elements (spheres, etc.)
			this.spheres = this._createSpheres();

			// Calculate total performance
			this.performanceMetrics.totalProcessingTime = performance.now() - timer.totalStart;

			timer.print();

			this.processingStage = 'complete';
			updateLoading( { status: "Scene data ready", progress: 85 } );
			return this;

		} catch ( error ) {

			this.processingStage = 'error';
			log.error( 'processing failed:', error );
			updateLoading( {
				status: `Error: ${error.message}`,
				progress: 100
			} );
			throw error;

		} finally {

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

			// Extract geometry data
			const extractedData = this.geometryExtractor.extract( object );

			this._setTriangleData( extractedData.triangleData );
			this.triangleCount = extractedData.triangleCount;
			// Callers build refit buffers by walking meshes, which counts a shared geometry
			// once per placement; storage counts it once.
			this.expandedTriangleCount = extractedData.expandedTriangleCount ?? extractedData.triangleCount;
			this.instanceSource = extractedData.instanceSource || null;
			this.instanceMatrices = extractedData.instanceMatrices || null;
			this.instanceCount = extractedData.instanceCount || 0;

			this._log( `Using Float32Array format: ${this.triangleCount} triangles, ${( this.triangleData.byteLength / ( 1024 * 1024 ) ).toFixed( 2 )}MB` );

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
				progress: 25
			} );
			throw error;

		}

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
		const startTime = performance.now();

		try {

			const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
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

			const originalTreeletEnabled = this.config.enableTreeletOptimization;
			const LARGE_MESH_THRESHOLD = 200000;

			// Separate into worker-pool tasks and multi-worker parallel tasks
			const poolTasks = [];
			const parallelTasks = [];

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

				if ( range.count >= LARGE_MESH_THRESHOLD && shouldUseParallelBuild( range.count ) ) {

					parallelTasks.push( { m, range } );

				} else {

					poolTasks.push( { m, range } );

				}

			}

			// Worker config shared by all builds
			const workerOpts = {
				depth: this.config.bvhDepth,
				treeletOptimization: {
					enabled: originalTreeletEnabled !== false,
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

			const totalTasks = poolTasks.length + parallelTasks.length;

			// Build all meshes via bounded worker pool (main thread stays free)
			const poolPromise = this._buildBLASesWithPool( poolTasks, workerOpts, ( done ) => {

				updateLoading( {
					status: `Building BLAS ${done + parallelTasks.length}/${totalTasks}...`,
					progress: 25 + Math.floor( ( done / totalTasks ) * 45 )
				} );

			} );

			// Very large meshes use multi-worker parallel builder concurrently
			const parallelPromises = parallelTasks.map( ( { m, range } ) => {

				const meshTriData = this.triangleData.slice(
					range.start * FPT,
					( range.start + range.count ) * FPT
				);

				return buildBVHParallel( meshTriData, this.config.bvhDepth, null, {
					maxLeafSize: this.bvhBuilder.maxLeafSize,
					numBins: this.bvhBuilder.numBins,
					maxBins: this.bvhBuilder.maxBins,
					minBins: this.bvhBuilder.minBins,
					...workerOpts
				} ).then( result => ( { m, range, result } ) );

			} );

			// Await both paths concurrently
			const [ poolResults, parallelResults ] = await Promise.all( [
				poolPromise,
				Promise.all( parallelPromises )
			] );

			// Store all results, summing per-mesh split stats for one aggregate BVH line
			const blasStats = { sah: 0, objMed: 0, spatMed: 0, failed: 0, treeletsImproved: 0, treeletsProcessed: 0 };

			for ( const { m, range, result } of [ ...poolResults, ...parallelResults ] ) {

				if ( result.reorderedTriangles ) {

					this.triangleData.set( result.reorderedTriangles, range.start * FPT );

				}

				const st = result.splitStats;
				if ( st ) {

					blasStats.sah += st.sahSplits ?? 0;
					blasStats.objMed += st.objectMedianSplits ?? 0;
					blasStats.spatMed += st.spatialMedianSplits ?? 0;
					blasStats.failed += st.failedSplits ?? 0;
					blasStats.treeletsImproved += st.treeletsImproved ?? 0;
					blasStats.treeletsProcessed += st.treeletsProcessed ?? 0;

				}

				this.instanceTable.setEntry( {
					meshIndex: m,
					blasNodeCount: result.bvhData.length / 16,
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
			const tlasStart = performance.now();

			const table = this.instanceTable;

			// Always build a TLAS — even for a single mesh — so the BLAS-pointer leaf
			// carries packed per-mesh visibility in its slot [2]. The 1-node TLAS
			// overhead (one extra leaf fetch per ray) is negligible and eliminates
			// a dedicated visibility storage buffer binding.
			this.instanceTable.computeAABBs( this.triangleData );

			// Node count is exact up front (every leaf holds one entry), so BLAS offsets can be
			// assigned before the build and the TLAS is written in a single pass.
			this.instanceTable.assignOffsets( TLASBuilder.nodeCountFor( table.count ) );
			const totalNodes = this.instanceTable.totalNodeCount;

			const tlasData = await this._buildTLAS( table );
			this.performanceMetrics.tlasBuildTime = performance.now() - tlasStart;

			// Assemble combined buffer: [TLAS][BLAS_0][BLAS_1]...[BLAS_M]
			const assembleStart = performance.now();
			this.bvhData = new Float32Array( totalNodes * 16 );
			this.bvhData.set( tlasData );

			for ( let i = 0; i < table.count; i ++ ) {

				if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue; // alias — owner writes
				const blas = table.blasData.get( table.sourceMesh[ i ] );
				const blasOffset = table.blasOffsetOf( i );
				const destOffset = blasOffset * 16;
				this.bvhData.set( blas, destOffset );
				this._offsetBLASInPlace( destOffset, blas.length / 16, blasOffset, table.triOffsetOf( i ) );

			}

			this._buildGlobalOriginalToBvhMap();
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
				`${fmt.n( this.bvhData.length / 16 )} nodes`,
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
				progress: 75
			} );
			throw error;

		}

	}

	/**
	 * Adjust BLAS node indices in-place within the combined bvhData buffer.
	 * @private
	 */
	_offsetBLASInPlace( destFloat, nodeCount, nodeOffset, triOffset ) {

		for ( let i = 0; i < nodeCount; i ++ ) {

			const o = destFloat + i * 16;

			if ( this.bvhData[ o + 3 ] === - 1 ) {

				this.bvhData[ o ] += triOffset;

			} else {

				this.bvhData[ o + 3 ] += nodeOffset;
				this.bvhData[ o + 7 ] += nodeOffset;

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
	_buildBLASesWithPool( tasks, opts, onProgress ) {

		if ( tasks.length === 0 ) return Promise.resolve( [] );

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const poolSize = Math.min( tasks.length, this.config.maxConcurrentTextureTasks || 4 );
		const results = [];
		let nextTask = 0;
		let completed = 0;

		return new Promise( ( resolve, reject ) => {

			const workers = [];

			const dispatchNext = ( worker ) => {

				if ( nextTask >= tasks.length ) {

					// No more tasks — terminate this worker
					worker.terminate();
					workers.splice( workers.indexOf( worker ), 1 );
					if ( workers.length === 0 ) resolve( results );
					return;

				}

				const { m, range } = tasks[ nextTask ++ ];
				const meshTriData = this.triangleData.slice(
					range.start * FPT,
					( range.start + range.count ) * FPT
				);

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

			};

			const onWorkerMessage = ( worker, e ) => {

				const data = e.data;

				if ( data.error ) {

					workers.forEach( w => w.terminate() );
					reject( new Error( data.error ) );
					return;

				}

				if ( data.progress !== undefined ) return; // Ignore progress messages

				const { m, range } = worker._currentTask;
				results.push( {
					m,
					range,
					result: {
						bvhData: data.bvhData,
						reorderedTriangles: data.triangles || null,
						originalToBvh: data.originalToBvh || null,
						splitStats: data.treeletStats || null,
					}
				} );

				completed ++;
				onProgress?.( completed );

				dispatchNext( worker );

			};

			// Spin up the pool
			( async () => {

				for ( let i = 0; i < poolSize; i ++ ) {

					let worker;
					try {

						worker = new BVHWorker();

					} catch ( e ) {

						reject( e );
						return;

					}

					worker.onmessage = ( e ) => onWorkerMessage( worker, e );
					worker.onerror = ( err ) => {

						workers.forEach( w => w.terminate() );
						reject( err );

					};

					workers.push( worker );
					dispatchNext( worker );

				}

			} )().catch( reject );

		} );

	}

	/**
	 * Build global originalToBvhMap and per-mesh bvhToOriginal maps.
	 * The inverse map enables cache-friendly sequential writes during position updates.
	 * @private
	 */
	_buildGlobalOriginalToBvhMap() {

		this.originalToBvhMap = new Uint32Array( this.triangleCount );

		const table = this.instanceTable;
		for ( let m = 0; m < table.count; m ++ ) {

			// Aliases read the owner's map straight out of the table; nothing to store.
			if ( ! table.isSet[ m ] || ! table.isOwner( m ) ) continue;

			const t = table.sourceMesh[ m ];
			const triCount = table.tplTriCount[ t ], triOffset = table.tplTriOffset[ t ];
			const originalToBvh = table.originalToBvhMap.get( t );

			// Build per-mesh bvhToOriginal (inverse map for sequential writes)
			const bvhToOrig = new Uint32Array( triCount );

			if ( originalToBvh ) {

				for ( let i = 0; i < triCount; i ++ ) {

					const bvhLocal = originalToBvh[ i ];
					this.originalToBvhMap[ triOffset + i ] = triOffset + bvhLocal;
					bvhToOrig[ bvhLocal ] = i;

				}

			} else {

				for ( let i = 0; i < triCount; i ++ ) {

					this.originalToBvhMap[ triOffset + i ] = triOffset + i;
					bvhToOrig[ i ] = i;

				}

			}

			table.bvhToOriginal.set( t, bvhToOrig );

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
			this.triangleData,
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
		this.bvhData = null;
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
			hasTextures: !! this.materialData && !! this.bvhData,
			useFloat32Array: this.config.useFloat32Array,
			triangleDataSize: this.triangleData ? ( this.triangleData.byteLength / ( 1024 * 1024 ) ).toFixed( 2 ) + 'MB' : '0MB'
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
	 * Refit BVH with updated vertex positions (same topology — no triangle add/remove).
	 * O(N) bottom-up AABB update instead of full O(N log N) SAH rebuild.
	 *
	 * @param {Float32Array} newPositions - 9 floats per triangle (ax,ay,az, bx,by,bz, cx,cy,cz) in original mesh order
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	async refitBVH( newPositions, newNormals ) {

		if ( ! this.bvhData || ! this.triangleData || ! this.originalToBvhMap ) {

			throw new Error( 'No BVH data available for refit. Run buildBVH() first.' );

		}

		// The worker reads triCount * 9 floats unconditionally, and the shared position buffer
		// is sized from the FIRST call's argument — so a short array reads past its end and
		// writes NaN into triangleData and every AABB above it, with no error anywhere. A
		// caller that misses a mesh (the hidden ground disk is easy to miss) sees the scene
		// silently vanish instead of a thrown exception, so check the length up front.
		const expectedFloats = ( this.expandedTriangleCount ?? this.triangleCount ) * 9;

		if ( newPositions?.length !== expectedFloats ) {

			throw new Error(
				`SceneProcessor.refitBVH: expected ${expectedFloats} position floats ` +
				`(${this.expandedTriangleCount ?? this.triangleCount} triangles × 9), got ${newPositions?.length ?? 'none'}. ` +
				'Positions must cover every triangle in the scene, meshes in this.meshes order.'
			);

		}

		if ( newNormals && newNormals.length !== expectedFloats ) {

			throw new Error(
				`SceneProcessor.refitBVH: expected ${expectedFloats} normal floats, got ${newNormals.length}.`
			);

		}

		// Lazy-create worker
		if ( ! this._refitWorker ) {

			this._refitWorker = new BVHRefitWorker();

		}

		// First call: set up SharedArrayBuffers for zero-copy communication.
		// Worker writes into shared bvh/tri data; main thread reads them for GPU upload.
		// Race-free because _animRefitInFlight guard prevents overlapping calls.
		if ( ! this._refitSharedBuffers ) {

			const sharedBvhBuf = new SharedArrayBuffer( this.bvhData.byteLength );
			const sharedTriBuf = new SharedArrayBuffer( this.triangleData.byteLength );
			const sharedPosBuf = new SharedArrayBuffer( newPositions.byteLength );

			const sharedBvhData = new Float32Array( sharedBvhBuf );
			const sharedTriData = new Uint32Array( sharedTriBuf );

			sharedBvhData.set( this.bvhData );
			sharedTriData.set( this.triangleData );

			// Replace local refs with shared views
			this.bvhData = sharedBvhData;
			this._setTriangleData( sharedTriData );

			// Build bvhToOriginal map (inverse of originalToBvh) for cache-friendly
			// sequential writes in the worker's updateTrianglePositions.
			const triCount = this.originalToBvhMap.length;
			const bvhToOriginal = new Uint32Array( triCount );
			for ( let i = 0; i < triCount; i ++ ) {

				bvhToOriginal[ this.originalToBvhMap[ i ] ] = i;

			}

			this._refitSharedBuffers = {
				bvhBuf: sharedBvhBuf,
				triBuf: sharedTriBuf,
				posBuf: sharedPosBuf,
				posView: new Float32Array( sharedPosBuf ),
			};

			// Send shared buffers + immutable index map to worker (cached there)
			this._refitWorker.postMessage( {
				type: 'init',
				sharedBvhBuf,
				sharedTriBuf,
				sharedPosBuf,
				bvhToOriginal,
			}, [ bvhToOriginal.buffer ] );

		}

		// Write new positions into shared buffer (main thread → worker, zero-copy). The
		// worker writes triangles verbatim, so the world-to-object step happens here rather
		// than shipping every instance matrix across.
		this._writeObjectSpacePositions( newPositions, this._refitSharedBuffers.posView );

		return new Promise( ( resolve, reject ) => {

			this._refitWorker.onmessage = ( e ) => {

				const msg = e.data;
				if ( msg.type === 'refitComplete' ) {

					// bvhData/triangleData already updated via shared memory.
					// If smooth normals provided, overwrite the face normals the worker computed.
					if ( newNormals ) {

						this._patchSmoothNormals( newNormals );

					}

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
	_patchSmoothNormals( normals ) {

		const table = this.instanceTable;
		if ( ! table || table.count === 0 ) {

			this._patchNormalsRange( normals, 0, this.originalToBvhMap.length, null, null );
			return;

		}

		for ( let i = 0; i < table.count; i ++ ) {

			if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue;
			this._patchNormalsRange(
				normals, table.triOffsetOf( i ), table.triCountOf( i ),
				table.matrixWorldOf( i ), table.expandedStartOf( i )
			);

		}

	}

	/**
	 * Refit specific BLASes and rebuild TLAS after object transform or per-mesh animation.
	 * Runs on the main thread (fast for per-mesh updates).
	 *
	 * @param {number[]} affectedMeshIndices - Indices into meshTriangleRanges / the instance table
	 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order (full scene)
	 * @param {Float32Array} [newNormals] - Optional smooth normals (9 floats per tri)
	 * @returns {{ refitTimeMs: number }}
	 */
	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		if ( ! this.instanceTable || ! this.bvhData || ! this.triangleData ) {

			throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

		}

		// Indexed by absolute triangle, so a short buffer reads undefined → NaN bounds for the
		// affected meshes with no error. Same silent-corruption trap as refitBVH.
		const expectedFloats = ( this.expandedTriangleCount ?? this.triangleCount ) * 9;

		if ( newPositions?.length !== expectedFloats ) {

			throw new Error(
				`SceneProcessor.refitBLASes: expected ${expectedFloats} position floats ` +
				`(${this.expandedTriangleCount ?? this.triangleCount} triangles × 9, full scene), got ${newPositions?.length ?? 'none'}.`
			);

		}

		if ( newNormals && newNormals.length !== expectedFloats ) {

			throw new Error(
				`SceneProcessor.refitBLASes: expected ${expectedFloats} normal floats, got ${newNormals.length}.`
			);

		}

		const start = performance.now();

		// Lazy-create refitter instance
		if ( ! this._blasRefitter ) {

			this._blasRefitter = new BVHRefitter();

		}

		// Step 1: Update triangle positions and refit each affected BLAS
		for ( const meshIdx of affectedMeshIndices ) {

			const entry = this.instanceTable.entryAt( meshIdx );
			if ( ! entry ) continue;

			// Update triangle positions within this mesh's range
			this._updateMeshTrianglePositions( entry, newPositions );

			// Patch smooth normals for this mesh if provided
			if ( newNormals ) {

				this._patchMeshSmoothNormals( entry, newNormals );

			}

			// Refit this BLAS's nodes
			this._blasRefitter.refitRange(
				this.bvhData,
				this.triangleData,
				entry.blasOffset,
				entry.blasNodeCount
			);

			// Recompute this mesh's AABB for TLAS rebuild
			this.instanceTable.recomputeAABB( meshIdx, this.bvhData, this.triangleData );

		}

		// Step 2: Refit TLAS AABBs in-place (O(tlasNodeCount), no SAH rebuild)
		this._refitTLAS();

		return { refitTimeMs: performance.now() - start };

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

		for ( const meshIdx of affectedMeshIndices ) {

			const table = this.instanceTable;
			if ( ! table.isSet[ meshIdx ] ) continue;

			triRanges.push( { offset: table.triOffsetOf( meshIdx ) * FPT, count: table.triCountOf( meshIdx ) * FPT } );
			bvhRanges.push( { offset: table.blasOffsetOf( meshIdx ) * FPN, count: table.blasNodeCountOf( meshIdx ) * FPN } );

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
	 * @returns {boolean} false if critical data is missing
	 */
	uploadToPathTracer( pathTracer, lightManager, meshScene, environmentTexture ) {

		if ( ! this.triangleData ) {

			log.error( 'failed to get triangle data' );
			return false;

		}

		pathTracer.setTriangleData( this.triangleData, this.triangleCount );

		if ( ! this.bvhData ) {

			log.error( 'failed to get BVH data' );
			return false;

		}

		pathTracer.setBVHData( this.bvhData );
		pathTracer.setInstanceTable( this.instanceTable );

		if ( this.materialData ) {

			pathTracer.materialData.setMaterialData( this.materialData );

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

		}

		if ( this.lightBVHNodeData ) {

			pathTracer.setLightBVHData(
				this.lightBVHNodeData,
				this.lightBVHNodeCount,
			);

		}

		lightManager.transferSceneLights( meshScene );
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
			this.triangleData, this.materials, this.triangleCount,
		);

		if ( ! changed ) return null;

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

		return {
			rawData: this.emissiveTriangleData,
			emissiveCount: this.emissiveTriangleCount,
			totalPower: this.emissiveTotalPower,
			bitTrailMap: this.emissiveBitTrailMap,
			lightBVHNodeData: this.lightBVHNodeData,
			lightBVHNodeCount: this.lightBVHNodeCount,
		};

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
	_setTriangleData( data ) {

		this.triangleData = data;
		this.triangleFloats = data ? new Float32Array( data.buffer, data.byteOffset, data.length ) : null;

	}

	_writeObjectSpacePositions( src, dst ) {

		const table = this.instanceTable;
		let covered = 0;

		for ( let i = 0; i < ( table?.count || 0 ); i ++ ) {

			// Aliases point at the owner's triangles; deforming them once is the whole story.
			if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue;

			const from = table.expandedStartOf( i ) * 9;
			const to = table.triOffsetOf( i ) * 9;
			const len = table.triCountOf( i ) * 9;
			covered = Math.max( covered, to + len );

			// Callers hand over world-space positions; triangles are stored per instance, so
			// they come back through the inverse.
			const m = table.matrixInverseOf( i );
			if ( isIdentity( m ) ) {

				dst.set( src.subarray( from, from + len ), to );
				continue;

			}

			for ( let i = 0; i < len; i += 3 ) {

				const x = src[ from + i ], y = src[ from + i + 1 ], z = src[ from + i + 2 ];
				dst[ to + i ] = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
				dst[ to + i + 1 ] = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
				dst[ to + i + 2 ] = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];

			}

		}

		void covered;

	}

	/**
	 * Update triangle positions for a single mesh entry.
	 * Iterates in BVH order for sequential writes (cache-friendly), random reads from newPositions.
	 * @private
	 */
	_updateMeshTrianglePositions( entry, newPositions ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
		const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
		const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;
		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;
		const f = this.triangleFloats;

		const bvhToOrig = entry.bvhToOriginal;

		// Callers hand over world-space positions, which is the only space they can build
		// one in; triangles are stored per instance, so they come back through the inverse.
		const m = entry.matrixInverse;
		const identity = isIdentity( m );

		for ( let bvhLocal = 0; bvhLocal < entry.triCount; bvhLocal ++ ) {

			const origLocal = bvhToOrig[ bvhLocal ];
			const dst = ( entry.triOffset + bvhLocal ) * FPT;
			const src = ( entry.expandedStart + origLocal ) * 9;

			let ax = newPositions[ src ];
			let ay = newPositions[ src + 1 ];
			let az = newPositions[ src + 2 ];
			let bx = newPositions[ src + 3 ];
			let by = newPositions[ src + 4 ];
			let bz = newPositions[ src + 5 ];
			let cx = newPositions[ src + 6 ];
			let cy = newPositions[ src + 7 ];
			let cz = newPositions[ src + 8 ];

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

			this.triangleData[ dst + NA ] = packed;
			this.triangleData[ dst + NB ] = packed;
			this.triangleData[ dst + NC ] = packed;

		}

	}

	/**
	 * Patch smooth normals for a single mesh's triangles.
	 * @private
	 */
	_patchMeshSmoothNormals( entry, normals ) {

		this._patchNormalsRange( normals, entry.triOffset, entry.triCount, entry.matrixWorld, entry.expandedStart );

	}

	/**
	 * Shared normal-patching loop for a range of triangles.
	 * @private
	 */
	_patchNormalsRange( normals, startOrig, count, matrixWorld, srcStart = null ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
		const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
		const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;

		// Callers supply world-space normals. Traversal takes object normals out through the
		// transpose of world-to-object, so coming the other way is the transpose of
		// object-to-world — not its inverse, which is what a position would use.
		const m = matrixWorld;
		const plain = ! m || isIdentity( m );
		const slots = [ NA, NB, NC ];

		for ( let i = 0; i < count; i ++ ) {

			const orig = startOrig + i;
			const bvhIdx = this.originalToBvhMap[ orig ];
			const dst = bvhIdx * FPT;
			const src = ( ( srcStart ?? startOrig ) + i ) * 9;

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

				this.triangleData[ dst + slots[ v ] ] = packNormalOct( ox, oy, oz );

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

		// Build blasOffset → entry lookup (avoids O(M) .find() per leaf)
		if ( ! this._blasOffsetMap ) {

			this._blasOffsetMap = new Map();

		}

		this._blasOffsetMap.clear();
		const table = this.instanceTable;
		for ( let i = 0; i < table.count; i ++ ) {

			if ( table.isSet[ i ] ) this._blasOffsetMap.set( table.blasOffsetOf( i ), i );

		}

		// Bottom-up pass: reverse iteration over TLAS nodes
		for ( let i = tlasNodeCount - 1; i >= 0; i -- ) {

			const o = i * FPN;
			const marker = this.bvhData[ o + 3 ];

			if ( marker === - 2 ) {

				// BLAS-pointer leaf: read AABB from instance table
				const blasRoot = this.bvhData[ o ];
				const entryIndex = this._blasOffsetMap.get( blasRoot );
				if ( entryIndex !== undefined ) {

					table.writeWorldAABB( entryIndex, this._tlasBounds, i * 6 );

				}

			} else if ( marker >= 0 ) {

				// Inner node: union of children bounds, update bvhData in-place
				const leftIdx = this.bvhData[ o + 3 ];
				const rightIdx = this.bvhData[ o + 7 ];
				const lb = leftIdx * 6;
				const rb = rightIdx * 6;
				const bounds = this._tlasBounds;

				this.bvhData[ o ] = bounds[ lb ];
				this.bvhData[ o + 1 ] = bounds[ lb + 1 ];
				this.bvhData[ o + 2 ] = bounds[ lb + 2 ];
				this.bvhData[ o + 4 ] = bounds[ lb + 3 ];
				this.bvhData[ o + 5 ] = bounds[ lb + 4 ];
				this.bvhData[ o + 6 ] = bounds[ lb + 5 ];

				this.bvhData[ o + 8 ] = bounds[ rb ];
				this.bvhData[ o + 9 ] = bounds[ rb + 1 ];
				this.bvhData[ o + 10 ] = bounds[ rb + 2 ];
				this.bvhData[ o + 12 ] = bounds[ rb + 3 ];
				this.bvhData[ o + 13 ] = bounds[ rb + 4 ];
				this.bvhData[ o + 14 ] = bounds[ rb + 5 ];

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

		if ( ! this.instanceTable || ! this.triangleData ) return;

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		this._rebuildGeneration ++;
		const generation = this._rebuildGeneration;

		const dispatchRebuild = ( meshIdx, entry, worker ) => {

			const meshTriData = this.triangleData.slice(
				entry.triOffset * FPT,
				( entry.triOffset + entry.triCount ) * FPT
			);

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

		for ( const meshIdx of meshIndices ) {

			const entry = this.instanceTable.entryAt( meshIdx );
			if ( ! entry ) continue;

			// Cancel any in-flight rebuild for this mesh
			const existing = this._pendingRebuilds.get( meshIdx );
			if ( existing ) existing.terminate();

			dispatchRebuild( meshIdx, entry, new BVHWorker() );

		}

	}

	/**
	 * Swap a rebuilt BLAS into the combined buffer.
	 * @private
	 */
	_swapBLAS( meshIdx, entry, workerData, onSwap ) {

		const FPN = 16;
		const newBvhData = workerData.bvhData;
		const newNodeCount = newBvhData.length / FPN;

		// Node count must match — refit doesn't change topology, rebuild shouldn't either
		// for the same triangle set. If it differs, the buffer layout is invalid.
		if ( newNodeCount !== entry.blasNodeCount ) {

			log.warn( `background rebuild node count mismatch for mesh ${meshIdx} (${newNodeCount} vs ${entry.blasNodeCount}), skipping swap` );
			return;

		}

		// Write rebuilt BLAS nodes into the combined buffer at the entry's offset
		const destOffset = entry.blasOffset * FPN;
		this.bvhData.set( newBvhData, destOffset );
		this._offsetBLASInPlace( destOffset, newNodeCount, entry.blasOffset, entry.triOffset );

		// Write reordered triangles back into global array
		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const reorderedTris = workerData.triangles;
		if ( reorderedTris ) {

			this.triangleData.set( reorderedTris, entry.triOffset * FPT );

		}

		// Update per-mesh maps
		const newOrigToBvh = workerData.originalToBvh;
		if ( newOrigToBvh ) {

			// Update global originalToBvhMap for this mesh's range
			for ( let i = 0; i < entry.triCount; i ++ ) {

				this.originalToBvhMap[ entry.triOffset + i ] = entry.triOffset + newOrigToBvh[ i ];

			}

			// Update per-mesh bvhToOriginal
			const bvhToOrig = new Uint32Array( entry.triCount );
			for ( let i = 0; i < entry.triCount; i ++ ) {

				bvhToOrig[ newOrigToBvh[ i ] ] = i;

			}

			entry.bvhToOriginal = bvhToOrig;

		}

		// Recompute AABB and refit TLAS
		this.instanceTable.recomputeAABB( meshIdx, this.bvhData, this.triangleData );
		this._refitTLAS();

		this._log( `Background BLAS rebuild complete for mesh ${meshIdx}` );

		onSwap?.();

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
