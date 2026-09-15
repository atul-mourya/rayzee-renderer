import { describe, it, expect } from 'vitest';
import { BVH_LEAF_MARKERS, bvhIndexView } from '@/core/EngineDefaults.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { EmissiveTriangleBuilder } from '@/core/Processor/EmissiveTriangleBuilder.js';

// A triangle record is 20 uint lanes; 160 bytes per chunk therefore holds exactly 2 of them,
// so any scene here splits and every access crosses a boundary.
const FPT = 20;
const TWO_PER_CHUNK = FPT * 4 * 2;

function writeTriangle( u, f, base, ax, ay, az, bx, by, bz, cx, cy, cz, material = 0 ) {

	f[ base + 0 ] = ax; f[ base + 1 ] = ay; f[ base + 2 ] = az;
	f[ base + 4 ] = bx; f[ base + 5 ] = by; f[ base + 6 ] = bz;
	f[ base + 8 ] = cx; f[ base + 9 ] = cy; f[ base + 10 ] = cz;
	u[ base + 18 ] = material;
	u[ base + 19 ] = 0;

}

/** The same triangles as one flat array and as a multi-chunk ChunkedRecords. */
function bothForms( tris ) {

	const flat = new ChunkedRecords( tris.length, FPT, Uint32Array );
	const chunked = new ChunkedRecords( tris.length, FPT, Uint32Array, TWO_PER_CHUNK );

	for ( const records of [ flat, chunked ] ) {

		const floats = records.viewAs( Float32Array );
		tris.forEach( ( t, i ) => writeTriangle(
			records.chunkFor( i ), floats.chunkFor( i ), records.baseOf( i ), ...t
		) );

	}

	expect( flat.chunkCount ).toBe( 1 );
	expect( chunked.chunkCount ).toBeGreaterThan( 1 );
	return { flat, chunked };

}

const TRIS = [
	[ 0, 0, 0, 2, 0, 0, 0, 2, 0 ],
	[ 10, 10, 10, 12, 10, 10, 10, 12, 10 ],
	[ - 5, 1, 3, - 3, 1, 3, - 5, 4, 3 ],
	[ 7, - 2, 8, 9, - 2, 8, 7, 1, 8 ],
	[ 20, 20, 20, 21, 20, 20, 20, 21, 20 ],
];

describe( 'chunked triangle storage behaves identically to a flat array', () => {

	it( 'computes the same object-space AABB from a triangle scan', () => {

		const { flat, chunked } = bothForms( TRIS );

		const bounds = records => {

			// A leaf root sends computeAABBs down the triangle-scan path.
			const root = new Float32Array( 16 );
			bvhIndexView( root )[ 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;

			const table = new InstanceTable();
			table.allocate( 1 );
			table.setEntry( {
				meshIndex: 0, blasNodeCount: 1, triOffset: 1, triCount: 3,
				originalToBvhMap: null, bvhData: root
			} );
			table.computeAABBs( records );
			return Array.from( table.tplObjectAABB.slice( 0, 6 ) );

		};

		expect( bounds( chunked ) ).toEqual( bounds( flat ) );
		// spans triangles 1..3
		expect( bounds( flat ) ).toEqual( [ - 5, - 2, 3, 12, 12, 10 ] );

	} );

	it( 'refits a BVH to the same bounds', () => {

		const { flat, chunked } = bothForms( TRIS );

		// root inner → two triangle leaves, covering triangles 0..1 and 2..4
		const build = () => {

			const data = new Float32Array( 3 * 16 );
			const idx = bvhIndexView( data );
			idx[ 3 ] = 1; idx[ 7 ] = 2;
			idx[ 16 ] = 0; idx[ 17 ] = 2; idx[ 19 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
			idx[ 32 ] = 2; idx[ 33 ] = 3; idx[ 35 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
			return data;

		};

		const a = build(), b = build();
		new BVHRefitter().refit( a, flat, 3 );
		new BVHRefitter().refit( b, chunked, 3 );

		expect( Array.from( b ) ).toEqual( Array.from( a ) );
		expect( a[ 0 ] ).toBe( 0 ); // left child min.x from triangle 0
		expect( a[ 8 ] ).toBe( - 5 ); // right child min.x from triangle 2

	} );

	it( 'writes refit positions to the same place', () => {

		const { flat, chunked } = bothForms( TRIS );

		// bvh order is identity here, so triangle i reads positions i
		const bvhToOriginal = new Uint32Array( TRIS.length );
		for ( let i = 0; i < TRIS.length; i ++ ) bvhToOriginal[ i ] = i;

		const positions = new Float32Array( TRIS.length * 9 );
		for ( let i = 0; i < positions.length; i ++ ) positions[ i ] = i * 0.5;

		new BVHRefitter().updateTrianglePositions( flat, positions, bvhToOriginal );
		new BVHRefitter().updateTrianglePositions( chunked, positions, bvhToOriginal );

		for ( let i = 0; i < TRIS.length; i ++ ) {

			const fa = flat.viewAs( Float32Array ), fb = chunked.viewAs( Float32Array );
			const ea = Array.from( fa.chunkFor( i ).subarray( fa.baseOf( i ), fa.baseOf( i ) + FPT ) );
			const eb = Array.from( fb.chunkFor( i ).subarray( fb.baseOf( i ), fb.baseOf( i ) + FPT ) );
			expect( eb ).toEqual( ea );

		}

		// and the positions really landed
		const f = chunked.viewAs( Float32Array );
		expect( f.chunkFor( 0 )[ f.baseOf( 0 ) ] ).toBe( 0 );
		expect( f.chunkFor( 4 )[ f.baseOf( 4 ) ] ).toBe( 18 ); // triangle 4, position A.x = 36*0.5

	} );

	it( 'finds the same emissive triangles', () => {

		const { flat, chunked } = bothForms( TRIS );
		const materials = [
			{ emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0, side: 0 },
			{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5, side: 0 },
		];

		// mark triangles 1 and 3 emissive, so the emissive ones straddle chunks
		for ( const records of [ flat, chunked ] ) {

			for ( const i of [ 1, 3 ] ) records.chunkFor( i )[ records.baseOf( i ) + 18 ] = 1;

		}

		const run = records => {

			const b = new EmissiveTriangleBuilder();
			const count = b.extractEmissiveTriangles( records, materials, TRIS.length );
			return { count, indices: b.emissiveTriangles.map( t => t.triangleIndex ) };

		};

		const a = run( flat ), c = run( chunked );
		expect( c ).toEqual( a );
		expect( a.indices ).toEqual( [ 1, 3 ] );

	} );

	it( 'reads and writes a record that sits exactly on a chunk boundary', () => {

		const { chunked } = bothForms( TRIS );
		// 2 records per chunk, so record 2 is the first of chunk 1 and record 1 the last of chunk 0.
		expect( chunked.chunkFor( 1 ) ).not.toBe( chunked.chunkFor( 2 ) );
		expect( chunked.baseOf( 2 ) ).toBe( 0 );

		const src = chunked.copyOf( 1, 2 ); // straddles
		expect( src ).toHaveLength( 2 * FPT );
		chunked.setRecords( 3, src );

		expect( Array.from( chunked.copyOf( 3, 2 ) ) ).toEqual( Array.from( src ) );

	} );

} );
