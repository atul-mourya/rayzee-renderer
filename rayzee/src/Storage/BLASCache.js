/**
 * Stored per-mesh BVHs (BLASes), so reopening a scene skips building them. Keyed by the scene's
 * source and the builder settings; every template's triangles are checksummed on both sides, so a
 * stored BLAS is only ever used for exactly the triangles it was built over.
 */

import { ENGINE_AREAS } from './StorageManager.js';

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
 * @param {import('./StorageManager.js').StorageManager} storage
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
 * @param {{index: Object, bvh: import('../Processor/ChunkedRecords.js').ChunkedRecords,
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
