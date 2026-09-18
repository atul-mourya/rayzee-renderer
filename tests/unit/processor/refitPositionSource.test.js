import { describe, it, expect } from 'vitest';
import { TRIANGLE_DATA_LAYOUT } from '@/core/EngineDefaults.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

// Two meshes with different triangle counts, the second reordered by its BLAS build, and the
// second placed under a non-identity matrix so the world-to-object step actually does something.
const MESHES = [
	{ triCount: 3, expandedStart: 0, triOffset: 0, originalToBvh: null, matrix: null },
	{
		triCount: 4, expandedStart: 3, triOffset: 3,
		originalToBvh: Uint32Array.from( [ 2, 0, 3, 1 ] ),
		// translate (10, 20, 30), scale 2
		matrix: Float32Array.from( [ 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 20, 30, 1 ] ),
	},
];

const TOTAL_TRIS = MESHES.reduce( ( n, m ) => n + m.triCount, 0 );

/** A SceneProcessor with only the fields the refit path touches. */
function makeProcessor( chunkBytes ) {

	const sp = Object.create( SceneProcessor.prototype );

	const records = new ChunkedRecords( TOTAL_TRIS, FPT, Uint32Array, chunkBytes );
	sp.triangles = records;
	sp.triangleFloatChunks = records.viewAs( Float32Array );
	sp.triangleData = records.single;
	sp.triangleFloats = sp.triangleFloatChunks.single;
	sp.triangleCount = TOTAL_TRIS;
	sp.expandedTriangleCount = TOTAL_TRIS;

	const table = new InstanceTable();
	table.allocate( MESHES.length, MESHES.length );

	MESHES.forEach( ( m, i ) => {

		table.setEntry( {
			meshIndex: i, blasNodeCount: 1,
			triOffset: m.triOffset, triCount: m.triCount,
			originalToBvhMap: m.originalToBvh, bvhData: null,
			matrixWorld: m.matrix, expandedStart: m.expandedStart,
		} );

		// The inverse map is what the refit walks; build it the way the loader does.
		const inverse = new Uint32Array( m.triCount );
		for ( let k = 0; k < m.triCount; k ++ ) inverse[ m.originalToBvh ? m.originalToBvh[ k ] : k ] = k;
		table.bvhToOriginal.set( i, inverse );

	} );

	sp.instanceTable = table;
	return sp;

}

/** Distinct, traceable values so a misplaced triangle is obvious. */
function sceneWidePositions() {

	const p = new Float32Array( TOTAL_TRIS * 9 );
	for ( let t = 0; t < TOTAL_TRIS; t ++ ) {

		for ( let k = 0; k < 9; k ++ ) p[ t * 9 + k ] = t * 100 + k;

	}

	return p;

}

const dump = sp => {

	const out = [];
	for ( let t = 0; t < TOTAL_TRIS; t ++ ) {

		const c = sp.triangles.chunkFor( t ), b = sp.triangles.baseOf( t );
		out.push( ...Array.from( c.subarray( b, b + FPT ) ) );

	}

	return out;

};

/** The same positions, handed over one mesh at a time. */
const perMeshReader = scene => i => {

	const m = MESHES[ i ];
	return scene.subarray( m.expandedStart * 9, ( m.expandedStart + m.triCount ) * 9 );

};

describe( 'refit position sources', () => {

	it( 'scatters identically whether given the whole scene or one mesh at a time', () => {

		const scene = sceneWidePositions();
		const a = makeProcessor();
		const b = makeProcessor();

		const runA = a._meshSource( scene, 'position' );
		const runB = b._meshSource( perMeshReader( scene ), 'position' );

		for ( let i = 0; i < MESHES.length; i ++ ) {

			a._updateMeshTrianglePositions( i, runA( i ) );
			b._updateMeshTrianglePositions( i, runB( i ) );

		}

		expect( dump( b ) ).toEqual( dump( a ) );

	} );

	it( 'puts each triangle where the reorder map says, through the instance inverse', () => {

		const sp = makeProcessor();
		const read = sp._meshSource( sceneWidePositions(), 'position' );
		for ( let i = 0; i < MESHES.length; i ++ ) sp._updateMeshTrianglePositions( i, read( i ) );

		const f = sp.triangleFloatChunks;
		const posA = t => {

			const c = f.chunkFor( t ), b = f.baseOf( t );
			return Array.from( c.subarray( b, b + 3 ) );

		};

		// Mesh 0 is identity and unreordered: stored triangle 0 is scene triangle 0.
		expect( posA( 0 ) ).toEqual( [ 0, 1, 2 ] );

		// Mesh 1: originalToBvh says original 0 → stored 2, so stored slot 3+2 holds scene
		// triangle 3, pushed back through translate(10,20,30) + scale 2.
		expect( posA( 5 ) ).toEqual( [ ( 300 - 10 ) / 2, ( 301 - 20 ) / 2, ( 302 - 30 ) / 2 ] );

	} );

	it( 'gives the same answer when the triangles are split across chunks', () => {

		const flat = makeProcessor();
		const chunked = makeProcessor( FPT * 4 * 2 ); // 2 triangles per chunk

		expect( flat.triangles.chunkCount ).toBe( 1 );
		expect( chunked.triangles.chunkCount ).toBeGreaterThan( 1 );

		const scene = sceneWidePositions();
		for ( const sp of [ flat, chunked ] ) {

			const read = sp._meshSource( scene, 'position' );
			for ( let i = 0; i < MESHES.length; i ++ ) sp._updateMeshTrianglePositions( i, read( i ) );

		}

		expect( dump( chunked ) ).toEqual( dump( flat ) );

	} );

	it( 'patches smooth normals identically from either shape', () => {

		const scene = sceneWidePositions();
		const normals = new Float32Array( TOTAL_TRIS * 9 );
		for ( let k = 0; k < normals.length; k ++ ) normals[ k ] = ( k % 7 ) - 3;

		const a = makeProcessor(), b = makeProcessor();
		for ( const [ sp, nSrc ] of [[ a, normals ], [ b, perMeshReader( normals ) ]] ) {

			const readP = sp._meshSource( scene, 'position' );
			const readN = sp._meshSource( nSrc, 'normal' );
			for ( let i = 0; i < MESHES.length; i ++ ) {

				sp._updateMeshTrianglePositions( i, readP( i ) );
				sp._patchMeshSmoothNormals( i, readN( i ) );

			}

		}

		expect( dump( b ) ).toEqual( dump( a ) );

	} );

	it( 'rejects a short scene-wide array instead of writing NaN through the bounds', () => {

		const sp = makeProcessor();
		expect( () => sp._meshSource( new Float32Array( ( TOTAL_TRIS - 1 ) * 9 ), 'position' ) )
			.toThrow( /expected 63 position floats/ );

	} );

	it( 'rejects a mesh slice of the wrong length', () => {

		const sp = makeProcessor();
		// Right for mesh 0 (3 triangles), short for mesh 1 (4).
		const read = sp._meshSource( () => new Float32Array( 27 ), 'position' );
		expect( read( 0 ) ).toHaveLength( 27 );
		expect( () => read( 1 ) ).toThrow( /must be 36 floats/ );

	} );

	it( 'skips a mesh whose reader returns nothing', () => {

		const sp = makeProcessor();
		const before = dump( sp );
		const read = sp._meshSource( i => ( i === 0 ? null : undefined ), 'position' );
		expect( read( 0 ) ).toBeNull();
		expect( dump( sp ) ).toEqual( before );

	} );

} );
