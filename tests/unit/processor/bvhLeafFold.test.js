import { describe, it, expect, vi } from 'vitest';
import { BVH_LEAF_MARKERS, BVH_FOLDED_LEAF_MAX } from '@/core/EngineDefaults.js';

vi.mock( '@/core/Processor/TreeletOptimizer.js', () => ( {
	TreeletOptimizer: class {

		setTreeletSize() {}
		setMinImprovement() {}
		setMaxTreelets() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

vi.mock( '@/core/Processor/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';
import { foldLeaves, rebaseNodes, isFoldedRef, foldedFirst, foldedCount, foldedRef } from '@/core/Processor/BVHLeafFold.js';

const LANES = 20;
const TRIANGLE_LEAF = BVH_LEAF_MARKERS.TRIANGLE_LEAF;

function triangles( count ) {

	const data = new Uint32Array( count * LANES );
	const f = new Float32Array( data.buffer );
	let seed = 11;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	for ( let i = 0; i < count; i ++ ) {

		const x = rand() * 30, y = rand() * 30, z = rand() * 30;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + 0.4, y, z ], i * LANES + 4 );
		f.set( [ x, y + 0.4, z + 0.1 ], i * LANES + 8 );

	}

	return data;

}

function build( count, depth = 30 ) {

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( triangles( count ), depth ) );
	return { bvh, tris: builder.reorderedTriangleData };

}

/** Every leaf range reachable from the root, and each child box as its parent stores it, in walk order. */
function walk( data ) {

	const idx = new Uint32Array( data.buffer, data.byteOffset, data.length );
	const leaves = [];
	const boxes = [];
	const visit = n => {

		const o = n * 16;
		if ( idx[ o + 3 ] === TRIANGLE_LEAF ) return void leaves.push( [ idx[ o ], idx[ o + 1 ] ] );

		for ( const [ slot, box ] of [[ 3, 0 ], [ 7, 8 ]] ) {

			boxes.push( Array.from( data.subarray( o + box, o + box + 3 ) ).concat( Array.from( data.subarray( o + box + 4, o + box + 7 ) ) ) );
			const ref = idx[ o + slot ];
			if ( isFoldedRef( ref ) ) leaves.push( [ foldedFirst( ref ), foldedCount( ref ) ] );
			else {

				expect( ref ).toBeGreaterThan( n );
				visit( ref );

			}

		}

	};

	visit( 0 );
	return { leaves, boxes };

}

describe( 'foldLeaves', () => {

	it( 'reaches the same triangles through the same boxes, in the same order, with the leaf nodes gone', () => {

		const { bvh } = build( 3000 );
		const folded = foldLeaves( bvh );

		const before = walk( bvh );
		const after = walk( folded );
		expect( after.leaves ).toEqual( before.leaves );
		expect( after.boxes ).toEqual( before.boxes );

		const leafNodes = before.leaves.length;
		expect( folded.length / 16 ).toBe( bvh.length / 16 - leafNodes );

		// Nothing left in it is a leaf node: every leaf fit in its parent.
		const idx = new Uint32Array( folded.buffer );
		for ( let o = 0; o < idx.length; o += 16 ) expect( idx[ o + 3 ] >>> 30 ).not.toBe( 1 );

	} );

	it( 'keeps a leaf too large to fold as a node, and a BLAS that is one leaf unchanged', () => {

		const { bvh } = build( 400, 2 );
		const folded = foldLeaves( bvh );
		expect( walk( folded ).leaves ).toEqual( walk( bvh ).leaves );
		const idx = new Uint32Array( folded.buffer );
		let nodes = 0;
		for ( let o = 0; o < idx.length; o += 16 ) if ( idx[ o + 3 ] === TRIANGLE_LEAF ) {

			nodes ++;
			expect( idx[ o + 1 ] ).toBeGreaterThan( BVH_FOLDED_LEAF_MAX );

		}

		expect( nodes ).toBeGreaterThan( 0 );

		const single = build( 5 ).bvh;
		expect( Array.from( foldLeaves( single ) ) ).toEqual( Array.from( single ) );

	} );

	it( 'rebases node indices and triangle offsets, folded or not', () => {

		const { bvh } = build( 2000 );
		const folded = foldLeaves( bvh );
		const moved = folded.slice();
		rebaseNodes( new Uint32Array( moved.buffer ), 1000, 70 );

		const idx = new Uint32Array( moved.buffer );
		const orig = new Uint32Array( folded.buffer );
		let folds = 0;
		for ( let o = 0; o < idx.length; o += 16 ) {

			for ( const slot of [ 3, 7 ] ) {

				const ref = orig[ o + slot ];
				if ( isFoldedRef( ref ) ) {

					folds ++;
					expect( idx[ o + slot ] ).toBe( foldedRef( foldedFirst( ref ) + 70, foldedCount( ref ) ) );

				} else expect( idx[ o + slot ] ).toBe( ref + 1000 );

			}

		}

		expect( folds ).toBeGreaterThan( 0 );
		// Stored as the stack entry itself: ~( first << 4 | count ) read as an int is negative.
		expect( foldedRef( 5, 3 ) | 0 ).toBe( - 1 - ( ( 5 << 4 ) | 3 ) );

	} );

	it( 'refits to exactly what folding a refit tree gives', () => {

		const { bvh, tris } = build( 3000 );
		const f = new Float32Array( tris.buffer );
		for ( let i = 0; i < f.length; i += LANES ) for ( const v of [ 0, 4, 8 ] ) f[ i + v + 1 ] *= 1.5;

		const unfolded = bvh.slice();
		new BVHRefitter().refit( unfolded, tris, unfolded.length / 16 );

		const folded = foldLeaves( bvh );
		new BVHRefitter().refit( folded, tris, folded.length / 16 );

		expect( Array.from( folded ) ).toEqual( Array.from( foldLeaves( unfolded ) ) );

	} );

} );
