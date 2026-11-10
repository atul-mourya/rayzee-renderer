/**
 * The compact layout's jobs (PathTracerStage `compactLayout`), each over records it reads itself: run in a
 * CompactWorker, or on the page where there are no workers. Imports nothing a worker lacks.
 */

import { readPieces } from '../memory/ChunkedRecords.js';
import { packCornerBlock } from '../scene/TriangleClusters.js';
import { collapseObjects } from '../bvh/WideBVH.js';
import { packCopyRange } from '../scene/BufferLayout.js';

/** Runs `job`; the result also says how long reading its records (`readMs`) and the job itself (`workMs`) took. */
export async function runCompactJob( job ) {

	const startedAt = performance.now();
	const lanes = await readPieces( job.pieces );
	const readAt = performance.now();
	const result = run( job, lanes );
	return Object.assign( result, { readMs: readAt - startedAt, workMs: performance.now() - readAt } );

}

function run( job, lanes ) {

	if ( job.type === 'corners' ) return packCornerBlock( lanes, job.count, job.leafFirst, job.leafCount, job.cornerBase ?? null );
	if ( job.type === 'copies' ) return packCopyRange( new Float32Array( lanes.buffer, lanes.byteOffset, lanes.length ), job.count, job.slotBase ?? null );
	if ( job.type !== 'wide' ) throw new Error( `compact layout: no job ${job.type}` );

	// Binary nodes from node `base` on; a leaf whose lanes were written on disk takes them from `leafLanes`.
	const f = new Float32Array( lanes.buffer, lanes.byteOffset, lanes.length );
	const src = { f, u: lanes, at: ( n ) => ( n >= job.base && n < job.base + lanes.length / 16 ? ( n - job.base ) * 16 : - 1 ) };
	const leafLanes = job.leafLanes?.length ? new Map( job.leafLanes ) : null;
	const onLeafCopy = leafLanes ? ( n, w ) => {

		const set = leafLanes.get( n );
		if ( set ) w.u.set( set, w.o );

	} : null;
	return collapseObjects( src, job.roots, { wideBase: job.wideBase ?? null, onLeafCopy } );

}
