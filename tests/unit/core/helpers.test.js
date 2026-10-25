import { describe, it, expect, vi } from 'vitest';
import { setStatusCallback, resetLoading, updateLoading, updateStats } from '@/core/EngineEvents.js';
import { timeSlicer } from '@/core/Platform.js';
import { getDisplaySamples } from '@/core/pipeline/CompletionTracker.js';
import { disposeMaterial, disposeMaterialTextures, computeInstanceBoundingBoxes } from '@/core/loaders/AssetLoader.js';
import { BoxGeometry, BufferGeometry, Euler, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';

// ── getDisplaySamples ───────────────────────────────────────

describe( 'getDisplaySamples', () => {

	it( 'returns frameCount directly in progressive mode (renderMode=0 or undefined)', () => {

		const stage = { frameCount: 10 };
		expect( getDisplaySamples( stage ) ).toBe( 10 );

	} );

	it( 'returns 0 for zero frameCount', () => {

		expect( getDisplaySamples( {} ) ).toBe( 0 );

	} );

} );

// ── status callbacks ────────────────────────────────────────

describe( 'status callbacks', () => {

	it( 'setStatusCallback wires up resetLoading/updateLoading/updateStats', () => {

		const cb = vi.fn();
		setStatusCallback( cb );

		resetLoading();
		expect( cb ).toHaveBeenCalledTimes( 1 );

		updateLoading( { progress: 50 } );
		expect( cb ).toHaveBeenCalledTimes( 2 );

		updateStats( { triangles: 1000 } );
		expect( cb ).toHaveBeenCalledTimes( 3 );

		// Clean up
		setStatusCallback( null );

	} );

	it( 'callbacks are safe when no callback set', () => {

		setStatusCallback( null );
		expect( () => resetLoading() ).not.toThrow();
		expect( () => updateLoading( {} ) ).not.toThrow();
		expect( () => updateStats( {} ) ).not.toThrow();

	} );

} );

// ── disposeMaterial ─────────────────────────────────────────

describe( 'disposeMaterial', () => {

	it( 'disposes a single material', () => {

		const mat = { dispose: vi.fn(), userData: {} };
		disposeMaterial( mat );
		expect( mat.dispose ).toHaveBeenCalled();

	} );

	it( 'disposes array of materials', () => {

		const mat1 = { dispose: vi.fn(), userData: {} };
		const mat2 = { dispose: vi.fn(), userData: {} };
		disposeMaterial( [ mat1, mat2 ] );
		expect( mat1.dispose ).toHaveBeenCalled();
		expect( mat2.dispose ).toHaveBeenCalled();

	} );

	it( 'skips fallback materials', () => {

		const mat = { dispose: vi.fn(), userData: { isFallback: true } };
		disposeMaterial( mat );
		expect( mat.dispose ).not.toHaveBeenCalled();

	} );

} );

// ── disposeMaterialTextures ─────────────────────────────────

describe( 'disposeMaterialTextures', () => {

	it( 'disposes all texture types', () => {

		const tex = { dispose: vi.fn() };
		const mat = { map: tex, normalMap: { dispose: vi.fn() } };
		disposeMaterialTextures( mat );
		expect( tex.dispose ).toHaveBeenCalled();
		expect( mat.map ).toBeNull();
		expect( mat.normalMap ).toBeNull();

	} );

	it( 'handles null material safely', () => {

		expect( () => disposeMaterialTextures( null ) ).not.toThrow();

	} );

} );

// ── timeSlicer ───────────────────────────────────────────────────

describe( 'timeSlicer', () => {

	it( 'gives a turn once its slice has passed, and starts the next slice after that turn', async () => {

		let now = 1000;
		const clock = vi.spyOn( performance, 'now' ).mockImplementation( () => now );
		try {

			const slice = timeSlicer( 50 );
			expect( slice() ).toBeNull();
			now += 49;
			expect( slice() ).toBeNull();
			now += 1;
			const turn = slice();
			expect( turn ).toBeInstanceOf( Promise );
			await turn;
			expect( slice() ).toBeNull();
			now += 50;
			expect( slice() ).toBeInstanceOf( Promise );

		} finally {

			clock.mockRestore();

		}

	} );

} );

// ── computeInstanceBoundingBoxes ─────────────────────────────────

describe( 'computeInstanceBoundingBoxes', () => {

	let seed = 3;
	const rnd = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	const instanced = ( geometry, n, count = n ) => {

		const mesh = new InstancedMesh( geometry, new MeshBasicMaterial(), n );
		const m = new Matrix4(), q = new Quaternion(), s = new Vector3();
		for ( let i = 0; i < n; i ++ ) {

			q.setFromEuler( new Euler( rnd() * 6, rnd() * 6, rnd() * 6 ) );
			const k = 0.01 + rnd() * 30;
			s.set( rnd() < 0.2 ? - k : k, k * ( 0.5 + rnd() ), k );
			mesh.setMatrixAt( i, m.compose( new Vector3( ( rnd() - 0.5 ) * 1e4, rnd() * 1e3, ( rnd() - 0.5 ) * 1e4 ), q, s ) );

		}

		mesh.count = count;
		return mesh;

	};

	const same = ( a, b ) => [ 'x', 'y', 'z' ].every( k => Object.is( a.min[ k ], b.min[ k ] ) && Object.is( a.max[ k ], b.max[ k ] ) );

	it( 'matches InstancedMesh.computeBoundingBox bit for bit', () => {

		const cases = [[ new BoxGeometry( 1, 2, 3 ), 1000 ], [ new SphereGeometry( 2 ), 500, 310 ], [ new BoxGeometry( 0, 0, 0 ), 10 ], [ new BufferGeometry(), 5 ], [ new BoxGeometry(), 4, 0 ]];
		for ( const [ geometry, n, count ] of cases ) {

			const three = instanced( geometry, n, count );
			const ours = new InstancedMesh( geometry, three.material, n );
			ours.instanceMatrix = three.instanceMatrix;
			ours.count = three.count;
			three.computeBoundingBox();
			computeInstanceBoundingBoxes( new Group().add( ours ) );
			expect( same( ours.boundingBox, three.boundingBox ) ).toBe( true );

		}

	} );

	it( 'leaves an instanced mesh that has a box alone', () => {

		const mesh = instanced( new BoxGeometry(), 8 );
		mesh.computeBoundingBox();
		const box = mesh.boundingBox;
		computeInstanceBoundingBoxes( mesh );
		expect( mesh.boundingBox ).toBe( box );

	} );

} );
