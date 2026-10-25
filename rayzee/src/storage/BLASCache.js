/**
 * Stored per-mesh BVHs (BLASes), so reopening a scene skips building them. Keyed by the scene's
 * source and the builder settings; every template's triangles are checksummed on both sides, so a
 * stored BLAS is only ever used for exactly the triangles it was built over.
 */

import { ENGINE_AREAS, sharedStorage } from './StorageAreas.js';
import { VERSION } from '../Version.js';
import { getAssetConfig } from '../AssetConfig.js';
import { createLogger, fmt } from '../Logger.js';

const log = createLogger( 'scene' );

export const BLAS_CACHE_FORMAT = 2;

const PIECE_RECORDS = 1 << 20;
const YIELD_EVERY = 1 << 21;

const pause = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

// A BLAS depends on vertex positions alone: lanes 0-2, 4-6 and 8-10 of a triangle record.
const POSITION_LANES = [ 0, 1, 2, 4, 5, 6, 8, 9, 10 ];

/**
 * Sum of per-record hashes over records [start, start + count): the same whatever order the
 * records are in, so it compares triangles before and after a BLAS build reorders them.
 * @param {number[]} [lanes] - which lanes to hash; the triangle positions by default
 */
export function rangeChecksum( records, start, count, lanes = POSITION_LANES ) {

	const stride = records.lanesPerRecord;
	const used = lanes.length;
	let a = 0;
	let b = 0;
	let done = 0;

	while ( done < count ) {

		const rec = start + done;
		const chunk = records.chunkFor( rec );
		const n = Math.min( records.recordsPerChunk - ( rec % records.recordsPerChunk ), count - done );
		let o = records.baseOf( rec );

		for ( let i = 0; i < n; i ++, o += stride ) {

			let h = 0x811c9dc5;
			let g = 0x9e3779b9;
			for ( let l = 0; l < used; l ++ ) {

				const v = chunk[ o + lanes[ l ] ];
				h = Math.imul( h ^ v, 0x01000193 );
				g = Math.imul( ( g + v ) | 0, 0x85ebca6b ) ^ ( g >>> 13 );

			}

			a = ( a + h ) >>> 0;
			b = ( b + g ) >>> 0;

		}

		done += n;

	}

	return `${a.toString( 16 )}.${b.toString( 16 )}`;

}

/** Checksums every owning template, yielding now and then so a big scene does not freeze the page. */
export async function templateChecksums( records, templates ) {

	const out = [];
	let since = 0;
	for ( const { triOffset, triCount } of templates ) {

		out.push( rangeChecksum( records, triOffset, triCount ) );
		since += triCount;
		if ( since >= YIELD_EVERY ) {

			since = 0;
			await pause();

		}

	}

	return out;

}

/**
 * @param {import('../addons/storage/StorageManager.js').StorageManager} storage
 * @returns {Promise<?{index: Object, nodes: File, order: File, release: function(): void}>}
 */
export async function openBLASCache( storage, key ) {

	const entry = await storage?.area( ENGINE_AREAS.SCENES ).open( key );
	if ( ! entry ) return null;

	try {

		const index = await entry.json( 'index.json' );
		const nodes = await entry.file( 'nodes.f32' );
		const order = await entry.file( 'order.u32' );
		if ( index?.v !== BLAS_CACHE_FORMAT || ! nodes || ! order ) {

			entry.release();
			return null;

		}

		return { index, nodes, order, release: () => entry.release() };

	} catch {

		entry.release();
		return null;

	}

}

/**
 * @param {{index: Object, bvh: import('../memory/ChunkedRecords.js').ChunkedRecords,
 *   orders: Array<?Uint32Array>, isStale: function(): boolean, label?: string}} build
 * @returns {Promise<boolean>}
 */
export async function saveBLASCache( storage, key, { index, bvh, orders, isStale, label = '' } ) {

	const area = storage?.area( ENGINE_AREAS.SCENES );
	if ( ! area ) return false;

	const nodeRecords = index.totalNodes - index.tlasNodeCount;
	const orderBytes = orders.reduce( ( n, o ) => n + ( o?.byteLength ?? 0 ), 0 );
	const writer = await area.create( key, { label: `${label} (BVH)`, expectedBytes: nodeRecords * 64 + orderBytes } );
	if ( ! writer ) return false;

	try {

		for ( let rec = index.tlasNodeCount; rec < index.totalNodes; ) {

			if ( isStale() ) throw new Error( 'scene changed while it was being stored' );
			const chunk = bvh.chunkFor( rec );
			const room = bvh.recordsPerChunk - ( rec % bvh.recordsPerChunk );
			const n = Math.min( room, index.totalNodes - rec, PIECE_RECORDS );
			const base = bvh.baseOf( rec );
			await writer.write( 'nodes.f32', chunk.subarray( base, base + n * 16 ) );
			rec += n;

		}

		for ( const order of orders ) {

			if ( ! order ) continue;
			for ( let at = 0; at < order.length; at += PIECE_RECORDS * 4 ) {

				await writer.write( 'order.u32', order.subarray( at, Math.min( order.length, at + PIECE_RECORDS * 4 ) ) );

			}

		}

		if ( orderBytes === 0 ) await writer.write( 'order.u32', new Uint8Array( 0 ) );
		if ( isStale() ) throw new Error( 'scene changed while it was being stored' );
		await writer.writeJSON( 'index.json', index );
		await writer.commit();
		return true;

	} catch {

		await writer.abort();
		return false;

	}

}

/** Reads records [from, to) of a stored node file into `bvh` at the same indices + `offset`. */
export async function readNodesInto( file, bvh, firstRecord, recordCount ) {

	for ( let done = 0; done < recordCount; done += PIECE_RECORDS ) {

		const n = Math.min( PIECE_RECORDS, recordCount - done );
		const buffer = await file.slice( done * 64, ( done + n ) * 64 ).arrayBuffer();
		bvh.setRecords( firstRecord + done, new Float32Array( buffer ) );

	}

}

export async function readOrder( file, offset, count ) {

	return new Uint32Array( await file.slice( offset * 4, ( offset + count ) * 4 ).arrayBuffer() );

}

function blasCacheKey( processor, workerOpts ) {

	const builder = { ...workerOpts };
	delete builder.logLevel;
	const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
	return `blas:${BLAS_CACHE_FORMAT}:${VERSION}:${JSON.stringify( builder )}:${cores}:${processor._sceneKey}`;

}

/**
 * Reuses stored BLASes when every owning template matches what was stored — same ranges, same
 * node counts, same offsets, same triangles — and puts the triangles in their built order.
 * @returns {Promise<?{results: Array, orders: Map<number, Uint32Array>, nodes: File, release: function(): void}>}
 */
export async function restoreBLASes( processor, owners, blasBase, workerOpts ) {

	if ( ! processor._sceneKey || processor.config.sceneCache === false ) return null;
	const storage = sharedStorage( getAssetConfig().cacheNamespace );
	if ( ! storage ) return null;

	processor._blasKey = blasCacheKey( processor, workerOpts );
	const cached = await openBLASCache( storage, processor._blasKey );
	if ( ! cached ) return null;

	const miss = ( reason ) => {

		log.debug( `stored BLASes not used: ${reason}` );
		cached.release();
		return null;

	};

	const { index } = cached;
	// `tlasNodeCount` is where the stored BLASes start: past the TLAS and any group trees.
	if ( index.tlasNodeCount !== blasBase || index.templates.length !== owners.length ) return miss( 'layout changed' );

	let offset = blasBase;
	for ( let i = 0; i < owners.length; i ++ ) {

		const [ t, triOffset, triCount, nodeCount, blasOffset ] = index.templates[ i ];
		const o = owners[ i ];
		if ( o.t !== t || o.triOffset !== triOffset || o.triCount !== triCount || blasOffset !== offset ) return miss( 'layout changed' );
		offset += nodeCount;

	}

	if ( offset !== index.totalNodes ) return miss( 'layout changed' );

	const checkStart = performance.now();
	const sums = await templateChecksums( processor.triangles, owners );
	for ( let i = 0; i < owners.length; i ++ ) if ( sums[ i ] !== index.templates[ i ][ 6 ] ) return miss( 'triangles changed' );
	const permuteStart = performance.now();

	try {

		const orders = new Map();
		const results = [];
		for ( let i = 0; i < owners.length; i ++ ) {

			const [ t, triOffset, triCount, nodeCount, , orderOffset, , root ] = index.templates[ i ];
			const order = await readOrder( cached.order, orderOffset, triCount );
			processor._permuteRange( triOffset, triCount, order );
			orders.set( t, order );
			results.push( {
				m: owners[ i ].m,
				range: owners[ i ].range,
				result: { bvhData: new Float32Array( Uint32Array.from( root ).buffer ), originalToBvh: null, nodeCount },
			} );

		}

		processor._blasRestored = true;
		processor.performanceMetrics.blasRestore = { checksumMs: permuteStart - checkStart, permuteMs: performance.now() - permuteStart };
		log.debug( `restored ${fmt.n( owners.length )} stored BLASes` );
		return { results, orders, nodes: cached.nodes, release: cached.release };

	} catch ( error ) {

		cached.release();
		throw error;

	}

}

/** Writes this build's BLASes to storage in the background; abandons it if the scene changes. */
export async function storeBLASes( processor, label ) {

	const storage = sharedStorage( getAssetConfig().cacheNamespace );
	const table = processor.instanceTable;
	if ( ! storage || ! table || ! processor.bvh ) return false;

	const key = processor._blasKey;
	const version = processor._geometryVersion;
	const isStale = () => processor._geometryVersion !== version || processor._blasKey !== key;

	const owners = [];
	for ( let t = 0; t < table.templateCount; t ++ ) {

		const owner = table.tplOwner[ t ];
		if ( owner < 0 || table.sourceMesh[ owner ] !== t ) continue;
		owners.push( { t, triOffset: table.tplTriOffset[ t ], triCount: table.tplTriCount[ t ], nodeCount: table.tplNodeCount[ t ], blasOffset: table.tplBlasOffset[ t ] } );

	}

	const sums = await templateChecksums( processor.triangles, owners );
	if ( isStale() ) return false;

	const rootBits = ( n ) => {

		const chunk = processor.bvhIndexChunks.chunkFor( n );
		const base = processor.bvhIndexChunks.baseOf( n );
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

	const index = { v: BLAS_CACHE_FORMAT, tlasNodeCount: table.blasBase, totalNodes: table.treeNodeCount, templates };
	const stored = await saveBLASCache( storage, key, { index, bvh: processor.bvh, orders, isStale, label } );
	if ( stored ) log.debug( `stored ${fmt.n( owners.length )} BLASes for the next load` );
	return stored;

}
