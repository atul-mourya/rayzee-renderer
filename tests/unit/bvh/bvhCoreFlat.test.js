import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { bvhCoreReady } from '@/core/bvh/ParallelBVHBuilder.js';

const FPT = 20;
const u32 = ( a ) => [ ...new Uint32Array( a.buffer, a.byteOffset, a.length ) ];

/** Small triangles scattered in a box, one in a hundred long, one in five hundred with a NaN corner. */
function mixed( count, seed = 5 ) {

	let s = seed;
	const rnd = () => ( ( s = ( s * 1103515245 + 12345 ) >>> 0 ) / 4294967296 );
	const f = new Float32Array( count * FPT );
	for ( let t = 0; t < count; t ++ ) {

		const cx = rnd() * 100, cy = rnd() * 100, cz = rnd() * 100, size = rnd() < 0.01 ? 30 : 1;
		for ( let k = 0; k < 3; k ++ ) {

			f[ t * FPT + k * 4 ] = cx + rnd() * size;
			f[ t * FPT + k * 4 + 1 ] = cy + rnd() * size;
			f[ t * FPT + k * 4 + 2 ] = cz + rnd() * size;

		}

		if ( rnd() < 0.002 ) f[ t * FPT ] = NaN;

	}

	return new Uint32Array( f.buffer );

}

describe( 'BVHBuilder flat in WebAssembly', () => {

	beforeAll( () => bvhCoreReady() );
	afterEach( () => vi.restoreAllMocks() );

	it( 'reinserts, orders and flattens as the JavaScript build does, bit for bit', () => {

		for ( const [ data, leaf ] of [[ mixed( 20000, 777 ), 4 ], [ mixed( 5000, 777 ), 8 ], [ mixed( 900 ), 4 ]] ) {

			const js = new BVHBuilder();
			js.useWasm = false;
			js.maxLeafSize = leaf;
			const jsFlat = js.flattenBVH( js.buildSync( data.slice() ) );

			const core = new BVHBuilder();
			core.maxLeafSize = leaf;
			const ran = vi.spyOn( core, '_runCoreFlat' );
			const flat = core.buildFlat( data.slice() );

			expect( ran ).toHaveBeenCalledTimes( 1 );
			expect( u32( flat ) ).toEqual( u32( jsFlat ) );
			expect( [ ...core.reorderedTriangleData ] ).toEqual( [ ...js.reorderedTriangleData ] );
			expect( [ ...core.originalToBvhMap ] ).toEqual( [ ...js.originalToBvhMap ] );
			expect( core.splitStats.reinsertionsApplied ).toBe( js.splitStats.reinsertionsApplied );
			if ( data.length / FPT > 1000 ) expect( js.splitStats.reinsertionsApplied ).toBeGreaterThan( 0 );

		}

	} );

	it( 'builds a frontier subtree flat as the JavaScript path does', () => {

		const data = mixed( 12000 );
		const prepared = () => {

			const b = new BVHBuilder();
			b.maxLeafSize = 4;
			const n = data.length / FPT;
			Object.assign( b, { triangles: data, totalTriangles: n, centroids: new Float32Array( n * 3 ), bMin: new Float32Array( n * 3 ), bMax: new Float32Array( n * 3 ), indices: new Uint32Array( n ) } );
			b.initializeTriangleArrays();
			return b;

		};

		const top = prepared();
		top.frontierTasks = [];
		top.buildRange( 0, top.totalTriangles, 30, 2, null );
		const reinsertion = { enabled: true, batchSizeRatio: 0.05, maxIterations: 3 };
		for ( const t of top.frontierTasks ) {

			const bounds = [ t.preMinX, t.preMinY, t.preMinZ, t.preMaxX, t.preMaxY, t.preMaxZ ];
			const side = ( useWasm ) => {

				const b = prepared();
				b.useWasm = useWasm;
				b.indices = top.indices.slice();
				return { flat: u32( b.buildRangeFlat( t.start, t.end, t.depth, null, bounds, reinsertion ) ), order: [ ...b.indices.subarray( t.start, t.end ) ] };

			};

			expect( side( true ) ).toEqual( side( false ) );

		}

	} );

	it( 'builds in JavaScript when the flat core fails partway', () => {

		const data = mixed( 3000 );
		const js = new BVHBuilder();
		js.useWasm = false;
		const jsFlat = u32( js.flattenBVH( js.buildSync( data.slice() ) ) );
		for ( const failure of [ () => null, () => {

			throw new WebAssembly.RuntimeError( 'unreachable' );

		} ] ) {

			vi.spyOn( BVHBuilder.prototype, '_runCoreFlat' ).mockImplementation( failure );
			const b = new BVHBuilder();
			expect( u32( b.buildFlat( data.slice() ) ) ).toEqual( jsFlat );
			vi.restoreAllMocks();

		}

	} );

} );
