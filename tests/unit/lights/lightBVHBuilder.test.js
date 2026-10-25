import { describe, it, expect, beforeEach } from 'vitest';
import { LightBVHBuilder } from '@/core/lights/LightBVHBuilder.js';

function makeEmissiveTri( index, cx, cy, cz, power = 1.0 ) {

	return {
		triangleIndex: index, power, area: 1.0,
		emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1,
		cx, cy, cz,
		bMinX: cx - 0.5, bMinY: cy - 0.5, bMinZ: cz - 0.5,
		bMaxX: cx + 0.5, bMaxY: cy + 0.5, bMaxZ: cz + 0.5,
	};

}

describe( 'LightBVHBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new LightBVHBuilder();

	} );

	describe( 'empty input', () => {

		it( 'returns a single dummy leaf node', () => {

			const result = builder.build( [] );

			expect( result.nodeCount ).toBe( 1 );
			expect( result.nodeData ).toBeInstanceOf( Float32Array );
			expect( result.nodeData.length ).toBe( 16 );

		} );

		it( 'marks the dummy node as a leaf', () => {

			const { nodeData } = builder.build( [] );

			// isLeaf is at offset 7
			expect( nodeData[ 7 ] ).toBe( 1.0 );

		} );

		it( 'returns an empty sortedPerm', () => {

			const { sortedPerm } = builder.build( [] );

			expect( sortedPerm ).toBeInstanceOf( Int32Array );
			expect( sortedPerm.length ).toBe( 0 );

		} );

	} );

	describe( 'single triangle', () => {

		it( 'creates one leaf node', () => {

			const tris = [ makeEmissiveTri( 0, 1, 2, 3, 5.0 ) ];
			const { nodeCount, nodeData } = builder.build( tris );

			expect( nodeCount ).toBe( 1 );
			expect( nodeData.length ).toBe( 16 );

			// isLeaf
			expect( nodeData[ 7 ] ).toBe( 1.0 );

			// emissiveStart=0, emissiveCount=1
			expect( nodeData[ 8 ] ).toBe( 0 );
			expect( nodeData[ 9 ] ).toBe( 1 );

		} );

		it( 'stores correct AABB and totalPower', () => {

			const tris = [ makeEmissiveTri( 0, 1, 2, 3, 5.0 ) ];
			const { nodeData } = builder.build( tris );

			// vec4[0]: [minX, minY, minZ, totalPower]
			expect( nodeData[ 0 ] ).toBeCloseTo( 0.5 );
			expect( nodeData[ 1 ] ).toBeCloseTo( 1.5 );
			expect( nodeData[ 2 ] ).toBeCloseTo( 2.5 );
			expect( nodeData[ 3 ] ).toBeCloseTo( 5.0 );

			// vec4[1]: [maxX, maxY, maxZ, isLeaf]
			expect( nodeData[ 4 ] ).toBeCloseTo( 1.5 );
			expect( nodeData[ 5 ] ).toBeCloseTo( 2.5 );
			expect( nodeData[ 6 ] ).toBeCloseTo( 3.5 );

		} );

		it( 'returns sortedPerm with single element', () => {

			const tris = [ makeEmissiveTri( 0, 1, 2, 3 ) ];
			const { sortedPerm } = builder.build( tris );

			expect( sortedPerm.length ).toBe( 1 );
			expect( sortedPerm[ 0 ] ).toBe( 0 );

		} );

	} );

	describe( 'count <= maxLeafSize', () => {

		it( 'creates a single leaf for 4 triangles', () => {

			const tris = [
				makeEmissiveTri( 0, 0, 0, 0 ),
				makeEmissiveTri( 1, 1, 0, 0 ),
				makeEmissiveTri( 2, 2, 0, 0 ),
				makeEmissiveTri( 3, 3, 0, 0 ),
			];

			const { nodeCount, nodeData } = builder.build( tris );

			expect( nodeCount ).toBe( 1 );
			expect( nodeData[ 7 ] ).toBe( 1.0 ); // isLeaf
			expect( nodeData[ 8 ] ).toBe( 0 ); // emissiveStart
			expect( nodeData[ 9 ] ).toBe( 4 ); // emissiveCount

		} );

		it( 'creates a single leaf for exactly maxLeafSize triangles', () => {

			const tris = [];
			for ( let i = 0; i < 8; i ++ ) {

				tris.push( makeEmissiveTri( i, i, 0, 0 ) );

			}

			const { nodeCount, nodeData } = builder.build( tris );

			expect( nodeCount ).toBe( 1 );
			expect( nodeData[ 7 ] ).toBe( 1.0 );
			expect( nodeData[ 9 ] ).toBe( 8 );

		} );

	} );

	describe( 'count > maxLeafSize', () => {

		it( 'creates inner and leaf nodes for 20 triangles spread along X', () => {

			const tris = [];
			for ( let i = 0; i < 20; i ++ ) {

				tris.push( makeEmissiveTri( i, i * 10, 0, 0 ) );

			}

			const { nodeCount, nodeData } = builder.build( tris );

			// Must have more than one node (inner + leaves)
			expect( nodeCount ).toBeGreaterThan( 1 );

			// Root node at offset 0 should be an inner node
			expect( nodeData[ 7 ] ).toBe( 0.0 ); // isLeaf = false

			// All nodes must be 16 floats each
			expect( nodeData.length ).toBe( nodeCount * 16 );

		} );

		it( 'all leaf nodes have emissiveCount <= maxLeafSize', () => {

			const tris = [];
			for ( let i = 0; i < 20; i ++ ) {

				tris.push( makeEmissiveTri( i, i * 10, 0, 0 ) );

			}

			const { nodeCount, nodeData } = builder.build( tris );

			for ( let n = 0; n < nodeCount; n ++ ) {

				const offset = n * 16;
				const isLeaf = nodeData[ offset + 7 ];

				if ( isLeaf === 1.0 ) {

					const emissiveCount = nodeData[ offset + 9 ];
					expect( emissiveCount ).toBeLessThanOrEqual( 8 );
					expect( emissiveCount ).toBeGreaterThan( 0 );

				}

			}

		} );

	} );

	describe( 'AABB correctness', () => {

		it( 'root AABB encompasses all triangles', () => {

			const tris = [
				makeEmissiveTri( 0, - 10, 5, 20 ),
				makeEmissiveTri( 1, 30, - 15, 0 ),
				makeEmissiveTri( 2, 0, 100, - 50 ),
				makeEmissiveTri( 3, 50, 0, 10 ),
			];

			const { nodeData } = builder.build( tris );

			const rootMinX = nodeData[ 0 ];
			const rootMinY = nodeData[ 1 ];
			const rootMinZ = nodeData[ 2 ];
			const rootMaxX = nodeData[ 4 ];
			const rootMaxY = nodeData[ 5 ];
			const rootMaxZ = nodeData[ 6 ];

			for ( const tri of tris ) {

				expect( rootMinX ).toBeLessThanOrEqual( tri.bMinX );
				expect( rootMinY ).toBeLessThanOrEqual( tri.bMinY );
				expect( rootMinZ ).toBeLessThanOrEqual( tri.bMinZ );
				expect( rootMaxX ).toBeGreaterThanOrEqual( tri.bMaxX );
				expect( rootMaxY ).toBeGreaterThanOrEqual( tri.bMaxY );
				expect( rootMaxZ ).toBeGreaterThanOrEqual( tri.bMaxZ );

			}

		} );

		it( 'root AABB encompasses all triangles for large input', () => {

			const tris = [];
			for ( let i = 0; i < 30; i ++ ) {

				tris.push( makeEmissiveTri( i, i * 5 - 50, Math.sin( i ) * 20, i * 3 ) );

			}

			const { nodeData } = builder.build( tris );

			const rootMinX = nodeData[ 0 ];
			const rootMinY = nodeData[ 1 ];
			const rootMinZ = nodeData[ 2 ];
			const rootMaxX = nodeData[ 4 ];
			const rootMaxY = nodeData[ 5 ];
			const rootMaxZ = nodeData[ 6 ];

			for ( const tri of tris ) {

				expect( rootMinX ).toBeLessThanOrEqual( tri.bMinX + 1e-6 );
				expect( rootMinY ).toBeLessThanOrEqual( tri.bMinY + 1e-6 );
				expect( rootMinZ ).toBeLessThanOrEqual( tri.bMinZ + 1e-6 );
				expect( rootMaxX ).toBeGreaterThanOrEqual( tri.bMaxX - 1e-6 );
				expect( rootMaxY ).toBeGreaterThanOrEqual( tri.bMaxY - 1e-6 );
				expect( rootMaxZ ).toBeGreaterThanOrEqual( tri.bMaxZ - 1e-6 );

			}

		} );

	} );

	describe( 'totalPower', () => {

		it( 'root totalPower equals sum of all triangle powers', () => {

			const powers = [ 2.5, 3.0, 1.0, 0.5, 7.0, 4.0 ];
			const tris = powers.map( ( p, i ) => makeEmissiveTri( i, i, 0, 0, p ) );

			const { nodeData } = builder.build( tris );

			const expectedPower = powers.reduce( ( sum, p ) => sum + p, 0 );
			expect( nodeData[ 3 ] ).toBeCloseTo( expectedPower );

		} );

		it( 'root totalPower is correct for large tree with splitting', () => {

			const tris = [];
			let expectedPower = 0;

			for ( let i = 0; i < 20; i ++ ) {

				const power = ( i + 1 ) * 0.5;
				expectedPower += power;
				tris.push( makeEmissiveTri( i, i * 10, 0, 0, power ) );

			}

			const { nodeData } = builder.build( tris );

			expect( nodeData[ 3 ] ).toBeCloseTo( expectedPower );

		} );

	} );

	describe( 'sortedPerm is valid permutation', () => {

		it( 'has the same length as input', () => {

			const tris = [];
			for ( let i = 0; i < 15; i ++ ) {

				tris.push( makeEmissiveTri( i, i * 3, 0, 0 ) );

			}

			const { sortedPerm } = builder.build( tris );

			expect( sortedPerm.length ).toBe( tris.length );

		} );

		it( 'contains every index exactly once', () => {

			const tris = [];
			for ( let i = 0; i < 20; i ++ ) {

				tris.push( makeEmissiveTri( i, i * 10 - 100, Math.random() * 50, Math.random() * 50 ) );

			}

			const { sortedPerm } = builder.build( tris );

			const seen = new Set();
			for ( let i = 0; i < sortedPerm.length; i ++ ) {

				seen.add( sortedPerm[ i ] );

			}

			expect( seen.size ).toBe( tris.length );

			for ( let i = 0; i < tris.length; i ++ ) {

				expect( seen.has( i ) ).toBe( true );

			}

		} );

	} );

	describe( '_nthElement', () => {

		it( 'partitions correctly around median', () => {

			const tris = [
				makeEmissiveTri( 0, 50, 0, 0 ),
				makeEmissiveTri( 1, 10, 0, 0 ),
				makeEmissiveTri( 2, 30, 0, 0 ),
				makeEmissiveTri( 3, 40, 0, 0 ),
				makeEmissiveTri( 4, 20, 0, 0 ),
			];

			const indices = new Int32Array( [ 0, 1, 2, 3, 4 ] );
			const k = 2; // median position

			builder._nthElement( indices, tris, 0, 5, k, 'cx' );

			// The element at position k should be the median value (30)
			const medianCx = tris[ indices[ k ] ].cx;
			expect( medianCx ).toBe( 30 );

			// All elements before k should have cx <= medianCx
			for ( let i = 0; i < k; i ++ ) {

				expect( tris[ indices[ i ] ].cx ).toBeLessThanOrEqual( medianCx );

			}

			// All elements after k should have cx >= medianCx
			for ( let i = k + 1; i < 5; i ++ ) {

				expect( tris[ indices[ i ] ].cx ).toBeGreaterThanOrEqual( medianCx );

			}

		} );

		it( 'handles already sorted input', () => {

			const tris = [
				makeEmissiveTri( 0, 1, 0, 0 ),
				makeEmissiveTri( 1, 2, 0, 0 ),
				makeEmissiveTri( 2, 3, 0, 0 ),
				makeEmissiveTri( 3, 4, 0, 0 ),
				makeEmissiveTri( 4, 5, 0, 0 ),
			];

			const indices = new Int32Array( [ 0, 1, 2, 3, 4 ] );
			const k = 2;

			builder._nthElement( indices, tris, 0, 5, k, 'cx' );

			expect( tris[ indices[ k ] ].cx ).toBe( 3 );

		} );

		it( 'works with a subrange', () => {

			const tris = [
				makeEmissiveTri( 0, 100, 0, 0 ),
				makeEmissiveTri( 1, 30, 0, 0 ),
				makeEmissiveTri( 2, 10, 0, 0 ),
				makeEmissiveTri( 3, 50, 0, 0 ),
				makeEmissiveTri( 4, 20, 0, 0 ),
				makeEmissiveTri( 5, 200, 0, 0 ),
			];

			const indices = new Int32Array( [ 0, 1, 2, 3, 4, 5 ] );

			// Partition only indices [1..5) around k=2
			builder._nthElement( indices, tris, 1, 5, 2, 'cx' );

			// Index 0 and 5 should be untouched
			expect( indices[ 0 ] ).toBe( 0 );
			expect( indices[ 5 ] ).toBe( 5 );

			// The element at k=2 within the subrange [1..5) should be median of {30,10,50,20} = 20 or 30
			const valAtK = tris[ indices[ 2 ] ].cx;
			const subValues = [ 30, 10, 50, 20 ].sort( ( a, b ) => a - b );
			expect( valAtK ).toBe( subValues[ 1 ] ); // 20

		} );

	} );

} );
