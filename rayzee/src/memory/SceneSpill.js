import { Box3, Vector3, Sphere } from 'three';
import { estimateSceneBytes, SAFE_SCENE_BYTES, SPILL_TRIANGLE_BUDGET, SPILL_PLACEMENT_BUDGET, SPILL_ENVIRONMENT_WIDTH } from './HostMemory.js';
import { SpillStore } from '../storage/SpillStore.js';
import { GeometrySpill } from '../storage/GeometrySpill.js';
import { createLogger, fmt } from '../Logger.js';
import { RECORD_VEC4 } from '../scene/BufferLayout.js';
import { geometryBytesOf } from '../scene/GeometryExtractor.js';
import { updateLoading, EngineEvents } from '../EngineEvents.js';
import { limitEnvironmentWidth } from '../loaders/AssetLoader.js';
import { ISSUE_CODES } from '../EngineIssues.js';

const log = createLogger( 'scene' );
const engineLog = createLogger( 'engine' );

// Quiet time after an edit before memory spill puts back on disk what the edit read back.
const RESPILL_AFTER_MS = 30_000;

// A spilled build's order maps go to disk in writes of this size and come back in reads of the other.
const ORDER_PACK_BYTES = 32 * 1024 * 1024;

const ORDER_WINDOW_BYTES = 64 * 1024 * 1024;

export function needsSpill( processor, object ) {

	return estimateSceneBytes( processor.geometryExtractor.surveyScene( object ) ).total > SAFE_SCENE_BYTES;

}

export async function spillToDisk( processor, storage ) {

	const triangles = processor.triangles;
	const bvh = processor.bvh;
	if ( ! storage || processor.spilled || processor._spillStores || ! triangles?.chunks || triangles.chunks.length < 2 || ! bvh?.chunks ) return null;

	await processor._blasStoring;
	const version = processor._geometryVersion;
	const started = performance.now();
	const key = `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}`;
	const stride = records => records.recordsPerChunk * records.lanesPerRecord * records.LaneType.BYTES_PER_ELEMENT;

	const triStore = await SpillStore.create( storage, `${key}:tri`, stride( triangles ), { label: 'Triangle records', expectedBytes: triangles.byteLength } );
	const bvhStore = triStore && await SpillStore.create( storage, `${key}:bvh`, stride( bvh ), { label: 'BLAS nodes', expectedBytes: bvh.byteLength } );
	if ( ! triStore || ! bvhStore ) {

		await triStore?.dispose();
		return null;

	}

	processor._spillStores = [ triStore, bvhStore ];
	const tlasChunks = Math.ceil( ( processor.instanceTable?.blasBase ?? 1 ) / bvh.recordsPerChunk );

	let bytes = await triangles.spill( triStore );
	bytes += await bvh.spill( bvhStore, { keep: k => k < tlasChunks } );
	await triStore.flush();
	await bvhStore.flush();

	if ( version !== processor._geometryVersion ) return null;
	const ms = performance.now() - started;
	log.info( `spilled ${( bytes / 1048576 ).toFixed( 0 )} MB of triangles and BLAS nodes to disk in ${ms.toFixed( 0 )} ms` );
	return { bytes, ms };

}

export function ensureResident( processor ) {

	processor._paging ??= ( async () => {

		await processor.triangles?.ensureResident?.();
		await processor.bvh?.ensureResident?.();
		await restoreOrderMaps( processor );
		if ( ! processor.spilled ) processor._disposeSpill();

	} )().finally( () => {

		processor._paging = null;

	} );

	return processor._paging;

}

export function ensureGeometryResident( processor ) {

	const geometry = processor._geometryOwner ? processor._geometryReading ??= processor._restoreGeometry( processor._geometryOwner ).finally( () => {

		processor._geometryReading = null;

	} ) : null;
	return Promise.all( [ geometry, processor.ensureMovable() ] );

}

export async function ensureMovable( processor, meshIndices = [] ) {

	processor._movePageIns = ( processor._movePageIns ?? 0 ) + 1;
	try {

		await processor._afterLoadSpill;
		const spill = processor._matrixSpill;
		if ( spill ) await ( processor._matrixReading ??= spill.restore().then( () => processor._disposeMatrixSpill() ).finally( () => {

			processor._matrixReading = null;

		} ) );

		const table = processor.instanceTable, bvh = processor.bvh;
		if ( ! meshIndices.length || ! table || ! bvh?.spilledChunks ) return;
		await bvh.ensureResident( 0, table.blasBase );
		for ( const k of recordChunksOf( processor, meshIndices ) ) await bvh.ensureResident( k * bvh.recordsPerChunk, 1 );

	} finally {

		processor._movePageIns --;

	}

}

/**
 * A spilling build's matrix lists go to disk as well — 2.4 GB on the Moana island; only a move reads them. Each
 * InstancedMesh gets its bounds from its copies' boxes first, so three.js never derives them from the empty list;
 * `again`, only one without bounds yet.
 * @private
 */
async function spillMatrices( processor, again = false ) {

	const table = processor.instanceTable;
	const lists = table?.adoptedMatrices() ?? [];
	const bounds = processor._spillMeshBounds;
	processor._spillMeshBounds = null;
	if ( ! lists.length || ! processor._progressive?.storage ) return;

	const spill = await GeometrySpill.create( processor._progressive.storage, `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}:mat` );
	if ( ! spill ) return;

	for ( const [ mesh, b ] of bounds ?? processor._instancedMeshBounds( ( e, out ) => table.writeEntryWorldAABB( e, out, 0 ), again ) ) {

		mesh.boundingBox = new Box3( new Vector3( b[ 0 ], b[ 1 ], b[ 2 ] ), new Vector3( b[ 3 ], b[ 4 ], b[ 5 ] ) );
		mesh.boundingSphere = mesh.boundingBox.getBoundingSphere( new Sphere() );

	}

	const bytes = lists.reduce( ( n, a ) => n + a.array.byteLength, 0 );
	spill.addAttributes( lists );
	processor._matrixSpill = spill;
	log.info( `${fmt.mb( bytes )} of instance matrices left for disk` );

}

/**
 * A spilling build's TLAS goes to disk too when copies are clustered — 1.3 GB on the Moana island — and any chunk a
 * move read back (its copy records), keeping only the chunks over the group trees, which a visibility change
 * rewrites. An edit reads them back first (the stage's `_whenTLASResident`, {@link ensureMovable}).
 */
export async function spillTLAS( processor ) {

	const table = processor.instanceTable, bvh = processor.bvh, store = processor._bvhSpillStore;
	if ( ! store || ! table?.clusterCount ) return;
	const per = bvh.recordsPerChunk;
	const groupFirst = ( table.groupNodeStart / per ) | 0;
	const groupLast = ( ( table.groupNodeStart + Math.max( 1, table.groupNodeCount ) - 1 ) / per ) | 0;
	processor._spilledRootBounds = processor.sceneBounds();
	const bytes = await bvh.spill( store, { keep: k => table.groupNodeCount > 0 && k >= groupFirst && k <= groupLast } );
	log.info( `spilled ${fmt.mb( bytes )} of TLAS to disk` );

}

/**
 * A spilling build's triangle order maps go to disk too (0.43 GB on the Moana island): only refits and BLAS swaps
 * read them, after {@link ensureResident}, which reads them back. Packed into 32 MB writes.
 */
export async function spillOrderMaps( processor ) {

	const table = processor.instanceTable, storage = processor._progressive?.storage;
	if ( ! table?.bvhToOriginal.size || ! storage ) return;
	let bytes = 0;
	for ( const map of table.bvhToOriginal.values() ) bytes += map.byteLength;
	const store = await SpillStore.create( storage, `spill:${Date.now().toString( 36 )}:${Math.random().toString( 36 ).slice( 2 )}:order`, 0, { label: 'Triangle order maps', expectedBytes: bytes } );
	if ( ! store ) return;

	const index = [], pack = new Uint8Array( ORDER_PACK_BYTES );
	let at = 0, packed = 0;
	const flush = async () => {

		if ( packed ) await store.writeAt( at - packed, pack.subarray( 0, packed ) );
		packed = 0;

	};

	for ( const [ t, map ] of table.bvhToOriginal ) {

		const data = new Uint8Array( map.buffer, map.byteOffset, map.byteLength );
		index.push( t, at, map.length );
		if ( packed + data.length > pack.length ) await flush();
		if ( data.length > pack.length ) await store.writeAt( at, data );
		else {

			pack.set( data, packed );
			packed += data.length;

		}

		at += data.length;

	}

	await flush();
	await store.flush();
	table.bvhToOriginal.clear();
	processor._orderSpill = { store, index, bytes };

}

/** Reads the order maps {@link spillOrderMaps} moved to disk back, in 64 MB windows. @private */
async function restoreOrderMaps( processor ) {

	const spill = processor._orderSpill;
	if ( ! spill ) return;
	processor._orderSpill = null;
	const { store, index, bytes } = spill, maps = processor.instanceTable.bvhToOriginal;
	let windowAt = 0, window = null;
	for ( let i = 0; i < index.length; i += 3 ) {

		const t = index[ i ], at = index[ i + 1 ], length = index[ i + 2 ] * 4;
		if ( length > ORDER_WINDOW_BYTES ) {

			maps.set( t, new Uint32Array( await store.readAt( at, length ) ) );
			continue;

		}

		if ( ! window || at + length > windowAt + window.byteLength ) {

			windowAt = at;
			window = await store.readAt( at, Math.min( ORDER_WINDOW_BYTES, bytes - at ) );

		}

		maps.set( t, new Uint32Array( window.slice( at - windowAt, at - windowAt + length ) ) );

	}

	await store.dispose();

}

export function spillAfterLoad( processor ) {

	if ( ! processor._geometryOwner || processor._spilledAfterLoad ) return processor._afterLoadSpill ?? Promise.resolve();
	processor._spilledAfterLoad = true;
	return spillUnused( processor, false );

}

export function respill( processor ) {

	if ( ! processor._geometryOwner || ! processor._spilledAfterLoad || processor._afterLoadSpill ) return processor._afterLoadSpill ?? Promise.resolve();
	if ( processor._matrixReading || processor._tlasReading || processor._movePageIns ) return Promise.resolve();
	return spillUnused( processor, true );

}

/** @private */
function spillUnused( processor, again ) {

	processor._afterLoadSpill = ( async () => {

		await spillMatrices( processor, again );
		await processor._spillTLAS();
		await processor._spillOrderMaps();

	} )().finally( () => {

		processor._afterLoadSpill = null;

	} );
	return processor._afterLoadSpill;

}

export function whenTLASEditable( processor ) {

	if ( processor._afterLoadSpill ) return processor._afterLoadSpill.then( () => processor.whenTLASEditable() );
	const bvh = processor.bvh, table = processor.instanceTable;
	if ( ! bvh || ! table || bvh.isResident( 0, table.blasBase ) ) return null;
	return processor._tlasReading ??= bvh.ensureResident( 0, table.blasBase ).finally( () => {

		processor._tlasReading = null;

	} );

}

export function needsPageInForMove( processor, meshIndices ) {

	if ( processor._matrixSpill || processor._afterLoadSpill ) return true;
	const table = processor.instanceTable, bvh = processor.bvh;
	if ( ! table || ! bvh?.spilledChunks ) return false;
	if ( ! bvh.isResident( 0, table.blasBase ) ) return true;
	for ( const k of recordChunksOf( processor, meshIndices ) ) if ( ! bvh.isResident( k * bvh.recordsPerChunk, 1 ) ) return true;
	return false;

}

/** The BVH chunks holding the copy records of `meshIndices` and their group siblings. @private */
function recordChunksOf( processor, meshIndices ) {

	const table = processor.instanceTable, per = processor.bvh.recordsPerChunk, chunks = new Set();
	if ( ! table.clusterCount ) return chunks;
	const meshes = new Set( meshIndices );
	for ( const m of meshIndices ) {

		const g = table.groupOfTemplate?.[ m ] ?? - 1;
		if ( g >= 0 ) for ( const member of table.groups[ g ].members ) meshes.add( member );

	}

	for ( const m of meshes ) {

		const run = table.placementRunOf( m );
		if ( ! run ) continue;
		for ( let p = run.start; p < run.start + run.count; p ++ ) {

			const r = table.tlasLeafIndex[ p ];
			if ( r < 0 ) continue;
			const lane = table.recordNodeStart * 16 + r * RECORD_VEC4 * 4;
			chunks.add( Math.floor( lane / 16 / per ) );
			chunks.add( Math.floor( ( lane + 11 ) / 16 / per ) );

		}

	}

	return chunks;

}

export function disposeMatrixSpill( processor ) {

	const spill = processor._matrixSpill;
	processor._matrixSpill = null;
	spill?.dispose().catch( () => {} );

}

/** Reads the three.js geometry a streamed build moved to disk back into place. */
export async function restoreGeometry( processor, object ) {

	const spill = processor._geometrySpill;
	if ( ! spill?.bytes ) {

		processor._geometryOwner = null;
		return;

	}

	if ( ! processor._geometryOwner ) updateLoading( { status: 'Reading scene geometry back...', progress: 84 } );
	const started = performance.now();
	const bytes = spill.bytes;
	await spill.restore();
	processor._disposeGeometrySpill();
	processor._geometryBytes = geometryBytesOf( object );
	log.info( `read ${fmt.mb( bytes )} of scene geometry back from disk in ${fmt.ms( performance.now() - started )}` );
	if ( spill.error ) log.warn( 'some scene geometry stayed in memory, its spill write failed:', spill.error );

}

export function disposeGeometrySpill( processor ) {

	const spill = processor._geometrySpill;
	processor._geometrySpill = null;
	processor._geometryOwner = null;
	spill?.dispose().catch( () => {} );

}

export function disposeSpill( processor ) {

	const stores = processor._spillStores;
	processor._spillStores = null;
	for ( const store of stores ?? [] ) store.dispose().catch( () => {} );

}

export function setMemorySpill( app, mode ) {

	app._memorySpill = mode === true || mode === false ? mode : 'auto';

}

/**
 * Triangle and placement budgets for a scene archive: raised whenever a build could spill, since the preflight
 * refuses what cannot fit either way. @private
 */
export function sceneBudgets( app, options ) {

	if ( app._memorySpill === false || ! app.storage ) return options;
	return { maxTriangles: SPILL_TRIANGLE_BUDGET, maxPlacements: SPILL_PLACEMENT_BUDGET, ...options };

}

/**
 * Decides whether the scene about to be built spills: static scenes only, since a deforming clip refits every
 * frame. Held for the build that follows ({@link progressiveSpill}). @private
 */
export function planSpill( app ) {

	const offered = app._memorySpill !== false && !! app.storage && ( app.assetLoader?.animations?.length ?? 0 ) === 0;
	const spill = offered && ( app._memorySpill === true || app._sdf.needsSpill( app.meshScene ) );
	if ( app.assetLoader ) app.assetLoader.maxEnvironmentWidth = spill ? SPILL_ENVIRONMENT_WIDTH : 0;
	// An importer installs its own sky at the end of its read, before this.
	const sky = spill ? app.meshScene?.environment : null;
	const image = sky?.image;
	if ( image ) limitEnvironmentWidth( sky, SPILL_ENVIRONMENT_WIDTH );
	if ( sky && sky.image !== image ) {

		// three.js keeps an uploaded texture's size, so the old one goes.
		sky.dispose();
		sky.needsUpdate = true;

	}

	if ( spill && app._memorySpill === 'auto' ) engineLog.info( 'scene is past the in-memory line: building it through disk' );
	app._spillPlan = spill;
	return spill;

}

export function progressiveSpill( app ) {

	const spill = app._spillPlan ?? app._planSpill();
	app._spillPlan = null;
	return spill ? { storage: app.storage, uploader: app._chunkUploader() } : null;

}

export function chunkUploader( app ) {

	const stage = app.stages.pathTracer;
	return ( records, kind, options ) => kind === 'triangles' ? stage.createTriangleChunkUploader( records, options ) : stage.createChunkUploader( records );

}

/** The rest of a spilling scene's spill, once it is on the GPU, in the background. */
export function maybeSpill( app ) {

	if ( ! app._sdf?.spilling || ! app.storage ) return;
	app._sdf.spillAfterLoad().catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );
	app._sdf.spillToDisk( app.storage )
		.then( result => result && app.dispatchEvent( { type: EngineEvents.SCENE_SPILLED, ...result } ) )
		.catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );

}

/** Once edits have been quiet for {@link RESPILL_AFTER_MS}, puts back on disk what they read back. */
export function scheduleRespill( app ) {

	if ( ! app._sdf?.spilling ) return;
	clearTimeout( app._respillTimer );
	app._respillTimer = setTimeout( () => {

		app._respillTimer = null;
		app._sdf?.respill().catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );

	}, RESPILL_AFTER_MS );
	app._respillTimer.unref?.();

}

export async function ensureSceneResident( app ) {

	if ( app._sdf?.spilled ) await app._sdf.ensureResident();
	await app._sdf?.ensureGeometryResident();

}
