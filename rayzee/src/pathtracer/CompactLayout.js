/**
 * The compact layout's GPU data (PathTracerStage `compactLayout`): the corners packed in clusters
 * (scene/TriangleClusters.js), each object's tree 4-wide (bvh/WideBVH.js) under the binary top level, the copy records
 * in 32 B. Built after the upload from the binary records where they are, in memory or spilled. Each pass counts, then
 * writes at the offsets the counts give; its jobs run in CompactWorkers, which view a resident chunk's shared memory
 * and are handed what the page reads from the spill. Functions take the stage first.
 */

import { StorageParts } from '../shaders/ThreePatches.js';
import {
	BVH_LEAF_MARKERS, BVH_MAX_INDEX, CLUSTER_COUNT_SHIFT, CLUSTER_ROOT_MASK, COMPACT_RECORD_LANES, COPY_SHEAR_LIMIT,
	TRIANGLE_DATA_LAYOUT, packCopyRecord,
} from '../scene/BufferLayout.js';
import { NODE_WORD_LANES } from '../scene/TriangleClusters.js';
import { lanePieces, readPieces } from '../memory/ChunkedRecords.js';
import { traversalStackSize, SPILLED_TRAVERSAL_STACK } from '../bvh/TraversalStack.js';
import { createWorker, hardwareThreads, hasWorkers } from '../Platform.js';
import { runCompactJob } from './CompactJobs.js';
import { createLogger } from '../Logger.js';
import CompactWorker from './CompactWorker.js?worker&inline';

// Records a job: ~40 MB of triangles, ~32 MB of nodes, ~24 MB of copy records, so the workers' copies stay small.
// `stage.compactJobSize` lowers it, for tests to force many jobs.
const JOB_RECORDS = 1 << 19;
const READ_STEP = 4 << 20;
const LANES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const log = createLogger( 'pathtracer' );

/** Workers for the jobs, or the page itself where there are none. */
function jobPool() {

	const workers = [];
	if ( hasWorkers() ) {

		try {

			for ( let i = Math.min( 8, Math.max( 1, hardwareThreads() - 1 ) ); i > 0; i -- ) workers.push( createWorker( CompactWorker ) );

		} catch {

			workers.forEach( ( w ) => w.terminate() );
			workers.length = 0;

		}

	}

	const idle = [ ...workers ], waiting = [];
	// A spilled piece is read here, one at a time, 4 MB a step, and moves: a worker reads the store's file far slower than
	// the page, and reads at once on the page slow each other.
	let reads = Promise.resolve();
	const readSpilled = ( p ) => {

		const read = reads.then( async () => {

			const buffer = new ArrayBuffer( p.bytes ), out = new Uint8Array( buffer );
			for ( let at = 0; at < p.bytes; at += READ_STEP ) {

				const n = Math.min( READ_STEP, p.bytes - at );
				const bytes = await p.store.readAt( p.at + at, n );
				out.set( new Uint8Array( bytes ), at );
				bytes.transfer?.( 0 );

			}

			return { buffer, byteOffset: 0, byteLength: p.bytes };

		} );
		reads = read.catch( () => {} );
		return read;

	};

	const send = ( worker, task ) => {

		worker.onmessage = ( e ) => {

			worker.onmessage = null;
			if ( e.data?.error ) task.reject( new Error( e.data.error ) );
			else task.resolve( e.data );
			const next = waiting.shift();
			if ( next ) send( worker, next );
			else idle.push( worker );

		};

		worker.onerror = ( e ) => task.reject( new Error( e.message ?? 'compact worker failed' ) );
		const transfer = task.pieces.filter( ( p ) => p.buffer instanceof ArrayBuffer ).map( ( p ) => p.buffer );
		worker.postMessage( { ...task.job, pieces: task.pieces }, transfer );

	};

	return {
		size: Math.max( 1, workers.length ),
		run: async ( job ) => {

			if ( ! workers.length ) return runCompactJob( job );
			const pieces = await Promise.all( job.pieces.map( ( p ) => ( p.store ? readSpilled( p ) : p ) ) );
			return new Promise( ( resolve, reject ) => {

				const task = { job, pieces, resolve, reject };
				const worker = idle.pop();
				if ( worker ) send( worker, task );
				else waiting.push( task );

			} );

		},
		close: () => workers.forEach( ( w ) => w.terminate() ),
	};

}

/**
 * Runs `jobs` across the pool, a lane a worker, handing each result to `onResult` (which may upload) before the next;
 * `times` adds up the phase's wall time and its jobs' read, work and upload times.
 */
async function mapJobs( pool, jobs, onResult, times = null ) {

	let next = 0, failed = null;
	const startedAt = performance.now();
	const lane = async () => {

		while ( next < jobs.length && ! failed ) {

			const job = jobs[ next ++ ];
			try {

				const result = await pool.run( job );
				if ( times ) {

					times.readMs += result.readMs ?? 0;
					times.workMs += result.workMs ?? 0;

				}

				const handed = performance.now();
				await onResult( result, job );
				if ( times ) times.uploadMs += performance.now() - handed;

			} catch ( error ) {

				failed ??= error;

			}

		}

	};

	await Promise.all( Array.from( { length: pool.size }, lane ) );
	if ( times ) times.ms += performance.now() - startedAt;
	if ( failed ) throw failed;

}

const phaseTimes = () => ( { ms: 0, readMs: 0, workMs: 0, uploadMs: 0 } );

// A spill store's file is read only once its writes are in it.
const settled = async ( records ) => records?._store?.flush?.();

/**
 * Packs the corners in clusters and uploads them: the triangle records split at leaf boundaries into jobs, each
 * counted, then packed at its corners' offset. A triangle leaf node keeps its cluster's corner base in slot [2], its
 * words in lanes 4–15.
 * @returns {Promise<{ parts: StorageParts, stats: Object }>}
 */
export async function buildCorners( stage ) {

	const startedAt = performance.now();
	const count = stage._triangleRecordCount;
	const records = stage._triangleRecords ?? stage._triangleFlat;
	const leaves = await triangleLeaves( stage );
	await settled( stage._triangleRecords );

	const jobSize = stage.compactJobSize ?? JOB_RECORDS;
	const jobs = [];
	const leafCount = leaves.first.length;
	for ( let first = 0, l = 0; first < count; ) {

		// Cut before a leaf that runs past the job's end, or after it when it is the job's first.
		let end = Math.min( count, first + jobSize );
		let j = l;
		while ( j < leafCount && leaves.first[ j ] < end ) j ++;
		if ( j > l && leaves.first[ j - 1 ] + leaves.count[ j - 1 ] > end ) {

			if ( leaves.first[ j - 1 ] > first ) end = leaves.first[ -- j ];
			else end = leaves.first[ j - 1 ] + leaves.count[ j - 1 ];

		}

		jobs.push( {
			type: 'corners', first, count: end - first, leafStart: l,
			leafFirst: leaves.first.slice( l, j ).map( ( f ) => f - first ), leafCount: leaves.count.slice( l, j ),
			pieces: lanePieces( records, first * LANES, ( end - first ) * LANES ),
		} );
		l = j;
		first = end;

	}

	const pool = jobPool();
	const backend = stage.renderer.backend;
	const times = { leavesMs: performance.now() - startedAt, count: phaseTimes(), pack: phaseTimes() };
	let parts, clusters = 0, tooBig = 0;
	const lanes = { nodes: [], first: [], count: [], base: [], words: [] };
	try {

		await mapJobs( pool, jobs, ( r, job ) => {

			job.corners = r.corners;

		}, times.count );
		const pairRows = Math.ceil( count / 2 );
		let at = pairRows;
		for ( const job of jobs ) {

			job.cornerBase = at;
			at += job.corners;

		}

		parts = new StorageParts( at * 4, 4, stage._maxPartBytes(), Uint32Array );
		stage._assertBindings( { geo: parts.attrs.length } );
		parts.create( backend );
		// Each job's rows drain before a lane takes the next: unpaced, Chrome's upload pool grew by the whole store.
		await mapJobs( pool, jobs, async ( r, job ) => {

			parts.write( backend, job.first * 2, r.pairs, 0, r.pairs.length );
			parts.write( backend, job.cornerBase * 4, r.rows, 0, r.rows.length );
			clusters += r.clusters;
			tooBig += r.tooBig;
			for ( let i = 0; i < job.leafFirst.length; i ++ ) {

				const l = job.leafStart + i;
				lanes.nodes.push( leaves.node[ l ] );
				lanes.first.push( leaves.first[ l ] );
				lanes.count.push( leaves.count[ l ] );
				lanes.base.push( r.leafBase[ i ] );
				lanes.words.push( r.leafWords.subarray( i * NODE_WORD_LANES, ( i + 1 ) * NODE_WORD_LANES ) );

			}

			await stage.drainUploads();

		}, times.pack );

	} finally {

		pool.close();

	}

	writeClusterLanes( stage, lanes );
	parts.nodeWordRows = Math.ceil( leaves.count.reduce( ( m, n ) => ( n > NODE_WORD_LANES ? m : Math.max( m, n ) ), 1 ) / 4 );
	parts.noLanes = tooBig > 0;
	const rows = jobs.length ? jobs[ jobs.length - 1 ].cornerBase + jobs[ jobs.length - 1 ].corners : Math.ceil( count / 2 );
	return {
		parts,
		stats: {
			triangles: count, clusters, corners: rows - Math.ceil( count / 2 ), bytes: rows * 16, geoBytes: count * 3 * 16,
			leafNodes: leaves.node.length, tooBig, jobs: jobs.length, workers: pool.size, times, buildMs: performance.now() - startedAt,
		},
	};

}

/**
 * Every triangle leaf node of the combined BVH, by first triangle, its chunks read where they are (from disk in 4 MB
 * pieces). Leaves folded into their parents have no node: their triangles cluster as runs of 8. The copy records
 * after the nodes are not nodes.
 */
async function triangleLeaves( stage ) {

	const attr = stage.bvhStorageAttr;
	const end = attr.copyRecordBase !== undefined ? attr.copyRecordBase / 4 : stage.bvhNodeCount;
	const TRIANGLE_LEAF = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
	const first = [], count = [], node = [];
	const scan = ( u, firstNode, nodes ) => {

		for ( let i = 0; i < nodes; i ++ ) {

			const o = i * 16;
			if ( u[ o + 3 ] === TRIANGLE_LEAF && u[ o + 1 ] > 0 ) {

				node.push( firstNode + i );
				first.push( u[ o ] );
				count.push( u[ o + 1 ] );

			}

		}

	};

	const recs = stage._bvhRecords;
	if ( ! recs ) scan( stage._bvhIndexView( attr.array ), 0, end );
	else for ( let k = 0; k < recs.chunks.length; k ++ ) {

		const startNode = k * recs.recordsPerChunk;
		if ( startNode >= end ) break;
		const here = Math.min( recs.recordsPerChunk, end - startNode );
		const chunk = recs.chunks[ k ];
		if ( chunk ) {

			scan( stage._bvhIndexView( chunk ), startNode, here );
			continue;

		}

		for ( let p = 0; p < here; p += 65536 ) {

			const nodes = Math.min( 65536, here - p );
			const bytes = await recs._store.readAt( k * recs._store._chunkBytes + p * 64, nodes * 64 );
			scan( new Uint32Array( bytes ), startNode + p, nodes );
			bytes.transfer?.( 0 );

		}

	}

	const order = Uint32Array.from( { length: node.length }, ( _, k ) => k );
	if ( first.some( ( f, i ) => i > 0 && f < first[ i - 1 ] ) ) order.sort( ( a, b ) => first[ a ] - first[ b ] );
	const by = ( a ) => Uint32Array.from( order, ( k ) => a[ k ] );
	return { first: by( first ), count: by( count ), node: by( node ) };

}

/**
 * Writes each leaf node's corner base into slot [2] and its words into lanes 4–15: into the CPU records where they are
 * in memory, else kept for the wide build to copy in (the binary tree never reaches the GPU).
 */
function writeClusterLanes( stage, leaves ) {

	const lanes = new Uint32Array( 16 );
	const recs = stage._bvhRecords;
	for ( let i = 0; i < leaves.nodes.length; i ++ ) {

		const n = leaves.nodes[ i ];
		lanes.fill( 0 );
		lanes[ 0 ] = leaves.first[ i ];
		lanes[ 1 ] = leaves.count[ i ];
		lanes[ 2 ] = leaves.base[ i ];
		lanes[ 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
		lanes.set( leaves.words[ i ], 4 );
		if ( ! recs ) stage._bvhIndexView( stage.cpuTree ).set( lanes, n * 16 );
		else if ( recs.chunks[ Math.floor( n / recs.recordsPerChunk ) ] ) stage._bvhIndexView( recs.chunkFor( n ) ).set( lanes, recs.baseOf( n ) );
		else stage._wideLeafLanes.set( n, lanes.slice() );

	}

}

/**
 * The objects' trees 4-wide, from the binary tree where it is, and the GPU's tree buffer around them: the top level
 * (the TLAS, then the group trees) binary as built, its object roots renamed; the objects' trees; the copy records
 * packed to 32 B, sheared ones whole behind them. Objects go in batches and copy records in ranges, each counted, then
 * written at the offsets the counts give. Sets `stage._wide`, what later writes to the top level and the copy records
 * need ({@link writeTreeRecords}).
 * @returns {Promise<{ parts: StorageParts, attr: Object, stats: Object }>}
 */
export async function buildWideTree( stage ) {

	const startedAt = performance.now();
	const attr = stage.bvhStorageAttr;
	const table = stage._instanceTable;
	if ( ! attr?.binaryOnly ) throw new Error( 'wide BVH: the binary tree is on the GPU already' );
	if ( ! table ) throw new Error( 'wide BVH: no instance table' );
	const end = attr.copyRecordBase !== undefined ? attr.copyRecordBase / 4 : stage.bvhNodeCount;
	const top = table.blasBase;
	const records = stage._bvhRecords ?? stage.cpuTree;
	await settled( stage._bvhRecords );

	// Each object once, in tree order, its nodes from its root on.
	const size = new Map();
	for ( let t = 0; t < table.templateCount; t ++ ) {

		const owner = table.tplOwner[ t ];
		const n = table.tplBlasOffset[ t ];
		if ( owner >= 0 && table.sourceMesh[ owner ] === t && n >= top && n < end ) size.set( n, table.tplNodeCount[ t ] );

	}

	const objects = [ ...size.keys() ].sort( ( a, b ) => a - b );
	const jobSize = stage.compactJobSize ?? JOB_RECORDS;
	const leafLanes = stage._wideLeafLanes;
	const batches = [];
	for ( let i = 0; i < objects.length; ) {

		const from = objects[ i ];
		let to = from, j = i;
		while ( j < objects.length && ( j === i || to - from < jobSize ) ) to = Math.max( to, objects[ j ] + size.get( objects[ j ++ ] ) );
		const lanesIn = leafLanes?.size ? [ ...leafLanes ].filter( ( [ n ] ) => n >= from && n < to ) : [];
		batches.push( { type: 'wide', base: from, roots: Uint32Array.from( objects.slice( i, j ) ), leafLanes: lanesIn, pieces: lanePieces( records, from * 16, ( to - from ) * 16 ) } );
		i = j;

	}

	const copies = attr.copyRecordBase !== undefined ? table.entryCount : 0;
	const ranges = [];
	for ( let r = 0; r < copies; r += jobSize ) {

		const n = Math.min( jobSize, copies - r );
		ranges.push( { type: 'copies', first: r, count: n, pieces: lanePieces( records, end * 16 + r * 12, n * 12 ) } );

	}

	const pool = jobPool();
	const backend = stage.renderer.backend;
	const times = { count: phaseTimes(), topMs: 0, pack: phaseTimes() };
	const roots = new Map(), needs = new Map();
	let parts, objectNodes, sheared = 0, nodes, recordNodes;
	const shearedRecords = [];
	try {

		await mapJobs( pool, [ ...batches, ...ranges ], ( r, job ) => {

			if ( job.type === 'wide' ) job.counts = r.counts;
			else job.sheared = r.sheared;
			if ( job.type === 'wide' ) job.roots.forEach( ( n, k ) => needs.set( n, r.stacks[ k ] ) );

		}, times.count );

		// An object's wide root is the first node it writes.
		let at = top;
		for ( const batch of batches ) {

			batch.wideBase = at;
			batch.roots.forEach( ( n, k ) => {

				roots.set( n, at );
				at += batch.counts[ k ];

			} );

		}

		nodes = at;
		objectNodes = at - top;
		for ( const range of ranges ) {

			range.slotBase = sheared;
			sheared += range.sheared;

		}

		const packedNodes = Math.ceil( copies * COMPACT_RECORD_LANES / 16 );
		recordNodes = copies ? packedNodes + Math.ceil( sheared * 12 / 16 ) : 0;
		parts = new StorageParts( ( nodes + recordNodes ) * 16, 16, stage._maxPartBytes(), Float32Array );
		stage._assertBindings( { bvh: parts.attrs.length } );
		parts.create( backend );
		stage._wide = { top, end, nodes, roots, needs, overflowAt: nodes + packedNodes, shearedRecords: null };

		const topAt = performance.now();
		await writeTopNodes( stage, parts, records, top );
		times.topMs = performance.now() - topAt;
		await mapJobs( pool, [ ...batches, ...ranges ], async ( r, job ) => {

			if ( job.type === 'wide' ) {

				job.roots.forEach( ( n, k ) => {

					if ( r.roots[ k ] !== roots.get( n ) ) throw new Error( `wide BVH: object ${n} moved from ${roots.get( n )} to ${r.roots[ k ]}` );

				} );
				parts.write( backend, job.wideBase * 16, r.nodes, 0, r.nodes.length );

			} else {

				parts.write( backend, nodes * 16 + job.first * COMPACT_RECORD_LANES, r.packed, 0, r.packed.length );
				if ( r.full.length ) parts.write( backend, stage._wide.overflowAt * 16 + job.slotBase * 12, r.full, 0, r.full.length );
				job.shearedIds = r.sheared;

			}

			await stage.drainUploads();

		}, times.pack );

	} finally {

		pool.close();

	}

	for ( const range of ranges ) for ( const k of range.shearedIds ) shearedRecords.push( range.first + k );
	stage._wide.shearedRecords = Uint32Array.from( shearedRecords );

	const wide = parts.attrs[ 0 ];
	wide.wide = true;
	wide.foldedLeaves = true;
	wide.copyRecordBase = copies ? nodes * 4 : undefined;
	wide.compactCopies = copies > 0;
	wide.copyOverflowBase = sheared ? stage._wide.overflowAt * 4 : undefined;
	wide.traversalStack = wideTraversalStack( stage );
	return {
		parts, attr: wide,
		stats: {
			binaryNodes: end, topNodes: top, objectNodes, recordNodes, objects: objects.length, copies, sheared,
			bytes: ( nodes + recordNodes ) * 64, binaryBytes: stage.bvhNodeCount * 64, parts: parts.attrs.length,
			jobs: batches.length + ranges.length, workers: pool.size, stack: wide.traversalStack, times, buildMs: performance.now() - startedAt,
		},
	};

}

/** The stack for the top level over the objects' wide trees, as traversalStackSize sizes one. */
export function wideTraversalStack( stage ) {

	const { top, needs } = stage._wide;
	const recs = stage._bvhRecords;
	const resident = ! recs || recs.chunks.slice( 0, Math.ceil( top / recs.recordsPerChunk ) ).every( Boolean );
	// The top level on disk cannot be walked: the size a spilled tree gets.
	if ( ! resident ) return Math.max( SPILLED_TRAVERSAL_STACK, ...needs.values() );
	return traversalStackSize( recs ?? stage.cpuTree, { folded: true, count: top, objectNeed: ( n ) => needs.get( n ) ?? 0 } );

}

/** The top level (nodes before `top`) to the GPU as built, each object root renamed to its wide root, 64K nodes a run. */
async function writeTopNodes( stage, parts, records, top ) {

	const RUN = 65536;
	for ( let n = 0; n < top; n += RUN ) {

		const count = Math.min( RUN, top - n );
		const u = ( await readPieces( lanePieces( records, n * 16, count * 16 ) ) ).slice();
		renameObjectRoots( stage, u, count );
		parts.write( stage.renderer.backend, n * 16, new Float32Array( u.buffer ), 0, count * 16 );
		await stage.drainUploads();

	}

}

/**
 * Points what names an object among `count` top-level nodes (`u`, u32 lanes) at its wide root: a placement leaf, a
 * copy cluster's copies, and a group tree's inner nodes, whose children are its members' roots.
 */
function renameObjectRoots( stage, u, count ) {

	const { top, roots } = stage._wide;
	const rename = ( n ) => ( n >= top ? roots.get( n ) ?? n : n );
	for ( let i = 0, o = 0; i < count; i ++, o += 16 ) {

		const tag = u[ o + 3 ];
		if ( tag < BVH_MAX_INDEX ) {

			u[ o + 3 ] = rename( tag );
			u[ o + 7 ] = rename( u[ o + 7 ] );

		} else if ( tag === BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ) u[ o ] = rename( u[ o ] );
		else if ( tag === BVH_LEAF_MARKERS.CLUSTER_LEAF ) {

			const copies = ( ( u[ o ] >>> CLUSTER_COUNT_SHIFT ) & 3 ) + 1;
			for ( let k = 0; k < copies; k ++ ) {

				const word = u[ o + 12 + k ];
				u[ o + 12 + k ] = ( ( word & ~ CLUSTER_ROOT_MASK ) | rename( word & CLUSTER_ROOT_MASK ) ) >>> 0;

			}

		}

	}

}

/**
 * Writes binary tree lanes [offset, offset + count) — the CPU records, as edits leave them — to the compact layout:
 * top-level nodes as they are, their object roots renamed; copy records packed (a sheared one whole, in the slot it
 * got at load). An object's own tree is never written again: its triangles and nodes stay as loaded.
 */
export function writeTreeRecords( stage, offset, count ) {

	const { top, end, nodes } = stage._wide;
	const backend = stage.renderer.backend;
	const first = Math.floor( offset / 16 ), last = Math.ceil( ( offset + count ) / 16 );
	if ( first < top ) {

		const k = Math.min( last, top ) - first;
		const staging = readLanes( stage, first * 16, k * 16 ).slice();
		renameObjectRoots( stage, new Uint32Array( staging.buffer ), k );
		stage._bvhParts.write( backend, first * 16, staging, 0, k * 16 );

	}

	if ( last > top && first < end ) throw new Error( 'compact layout: an object\'s tree is static' );
	if ( last <= end ) return;

	// Copy records: 12 lanes each from node `end` of the binary tree.
	const from = Math.floor( ( Math.max( offset, end * 16 ) - end * 16 ) / 12 );
	const to = Math.ceil( ( offset + count - end * 16 ) / 12 );
	const lanes = readLanes( stage, end * 16 + from * 12, ( to - from ) * 12 );
	const OUT = COMPACT_RECORD_LANES;
	const packed = new Float32Array( OUT ), packedU = new Uint32Array( packed.buffer );
	const sheared = stage._wide.shearedRecords;
	for ( let r = from; r < to; r ++ ) {

		const k = r - from;
		const slot = sheared ? binarySearch( sheared, r ) : - 1;
		if ( slot >= 0 ) {

			stage._bvhParts.write( backend, stage._wide.overflowAt * 16 + slot * 12, lanes, k * 12, 12 );
			continue;

		}

		if ( packCopyRecord( lanes, k * 12, packed, packedU, 0 ) > COPY_SHEAR_LIMIT && ! stage._shearWarned ) {

			log.warn( 'compact layout: a copy sheared after the load is drawn as the nearest unsheared one' );
			stage._shearWarned = true;

		}

		stage._bvhParts.write( backend, nodes * 16 + r * OUT, packed, 0, OUT );

	}

}

/** Binary tree lanes [lane, lane + count) from the CPU records. */
function readLanes( stage, lane, count ) {

	const n = Math.floor( lane / 16 ), k = Math.ceil( ( lane + count ) / 16 ) - n;
	const nodes = new Float32Array( k * 16 );
	if ( stage._bvhRecords ) stage._bvhRecords.readRecords( n, k, nodes );
	else nodes.set( stage.cpuTree.subarray( n * 16, ( n + k ) * 16 ) );
	return nodes.subarray( lane - n * 16, lane - n * 16 + count );

}

/** The index of `value` in ascending `sorted`, or −1. */
function binarySearch( sorted, value ) {

	let lo = 0, hi = sorted.length - 1;
	while ( lo <= hi ) {

		const mid = ( lo + hi ) >>> 1;
		if ( sorted[ mid ] === value ) return mid;
		if ( sorted[ mid ] < value ) lo = mid + 1;
		else hi = mid - 1;

	}

	return - 1;

}
