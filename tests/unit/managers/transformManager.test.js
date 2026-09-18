import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock TransformControls (from three/addons)
vi.mock( 'three/addons/controls/TransformControls.js', () => {

	class MockTransformControls {

		constructor() {

			this._listeners = {};
			this._mode = 'translate';
			this._space = 'world';
			this._attached = null;

		}

		addEventListener( type, fn ) {

			if ( ! this._listeners[ type ] ) this._listeners[ type ] = [];
			this._listeners[ type ].push( fn );

		}

		removeEventListener( type, fn ) {

			if ( ! this._listeners[ type ] ) return;
			const idx = this._listeners[ type ].indexOf( fn );
			if ( idx > - 1 ) this._listeners[ type ].splice( idx, 1 );

		}

		attach( obj ) {

			this._attached = obj;

		}

		detach() {

			this._attached = null;

		}

		setMode( mode ) {

			this._mode = mode;

		}

		setSpace( space ) {

			this._space = space;

		}

		getHelper() {

			return { isObject3D: true };

		}

		dispose() {}

		// Test helper: fire an event
		_fire( type, data ) {

			if ( this._listeners[ type ] ) {

				for ( const fn of this._listeners[ type ] ) fn( data );

			}

		}

	}

	return { TransformControls: MockTransformControls };

} );

// Add Matrix3 and Scene to the three mock
vi.mock( 'three', async ( importOriginal ) => {

	const actual = await importOriginal();
	return {
		...actual,
		Matrix3: class Matrix3 {

			constructor() {

				// Identity 3x3
				this.elements = new Float32Array( [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );

			}

			getNormalMatrix() {

				// For identity worldMatrix, normalMatrix is identity
				return this;

			}

		},
		Scene: class Scene {

			constructor() {

				this.children = [];

			}

			add( obj ) {

				this.children.push( obj );

			}

			remove( obj ) {

				const idx = this.children.indexOf( obj );
				if ( idx > - 1 ) this.children.splice( idx, 1 );

			}

		},
	};

} );

import { TransformManager } from '@/core/managers/TransformManager.js';
import { EngineEvents } from '@/core/EngineEvents.js';

// Helper: create a mock mesh with geometry
function makeMockMesh( vertexPositions, indices = null, parent = null ) {

	const posArray = new Float32Array( vertexPositions );
	const normalArray = new Float32Array( vertexPositions.length ); // zeros

	return {
		isMesh: true,
		parent,
		matrixWorld: {
			elements: new Float32Array( [
				1, 0, 0, 0,
				0, 1, 0, 0,
				0, 0, 1, 0,
				0, 0, 0, 1,
			] )
		},
		updateMatrixWorld: vi.fn(),
		getVertexPosition( idx, target ) {

			target.x = posArray[ idx * 3 ];
			target.y = posArray[ idx * 3 + 1 ];
			target.z = posArray[ idx * 3 + 2 ];
			return target;

		},
		geometry: {
			attributes: {
				position: {
					count: posArray.length / 3,
					array: posArray,
				},
				normal: {
					getX: ( i ) => normalArray[ i * 3 ],
					getY: ( i ) => normalArray[ i * 3 + 1 ],
					getZ: ( i ) => normalArray[ i * 3 + 2 ],
				}
			},
			index: indices ? { array: new Uint16Array( indices ) } : null,
		}
	};

}

function makeMockApp() {

	return {
		needsReset: false,
		wake: vi.fn(),
		refitBLASes: vi.fn(),
		updateMeshTransforms: vi.fn(),
		dispatchEvent: vi.fn(),
		refreshFrame: vi.fn(),
	};

}

describe( 'TransformManager', () => {

	let tm, app, mockCanvas, mockCamera, mockOrbitControls;

	beforeEach( () => {

		app = makeMockApp();
		mockCamera = {};
		mockCanvas = {};
		mockOrbitControls = { enabled: true };

		tm = new TransformManager( {
			camera: mockCamera,
			canvas: mockCanvas,
			orbitControls: mockOrbitControls,
			app,
		} );

	} );

	describe( 'attach / detach', () => {

		it( 'attaches gizmo to object', () => {

			const obj = { name: 'cube' };
			tm.attach( obj );

			expect( tm.attachedObject ).toBe( obj );

		} );

		it( 'skips re-attach if same object', () => {

			const obj = { name: 'cube' };
			tm.attach( obj );
			tm.attach( obj ); // no-op

			expect( tm.attachedObject ).toBe( obj );

		} );

		it( 'detaches gizmo', () => {

			const obj = { name: 'cube' };
			tm.attach( obj );
			tm.detach();

			expect( tm.attachedObject ).toBeNull();

		} );

		it( 'detach is no-op when nothing attached', () => {

			tm.detach(); // should not throw
			expect( tm.attachedObject ).toBeNull();

		} );

	} );

	describe( 'setMode / setSpace', () => {

		it( 'delegates setMode to controls', () => {

			tm.setMode( 'rotate' );
			expect( tm.controls._mode ).toBe( 'rotate' );

		} );

		it( 'delegates setSpace to controls', () => {

			tm.setSpace( 'local' );
			expect( tm.controls._space ).toBe( 'local' );

		} );

	} );

	describe( 'dragging events', () => {

		it( 'disables orbit controls on drag start', () => {

			tm.controls._fire( 'dragging-changed', { value: true } );

			expect( mockOrbitControls.enabled ).toBe( false );
			expect( tm.isDragging ).toBe( true );

		} );

		it( 're-enables orbit controls on drag end', () => {

			tm.controls._fire( 'dragging-changed', { value: true } );
			tm.controls._fire( 'dragging-changed', { value: false } );

			expect( mockOrbitControls.enabled ).toBe( true );
			expect( tm.isDragging ).toBe( false );

		} );

		it( 'dispatches OBJECT_TRANSFORM_START on drag start', () => {

			tm.controls._fire( 'dragging-changed', { value: true } );

			expect( app.dispatchEvent ).toHaveBeenCalledWith(
				expect.objectContaining( { type: EngineEvents.OBJECT_TRANSFORM_START } )
			);

		} );

		it( 'dispatches OBJECT_TRANSFORM_END on drag end', () => {

			tm.controls._fire( 'dragging-changed', { value: false } );

			expect( app.dispatchEvent ).toHaveBeenCalledWith(
				expect.objectContaining( { type: EngineEvents.OBJECT_TRANSFORM_END } )
			);

		} );

		it( 'sets needsReset and wakes app on objectChange', () => {

			tm.controls._fire( 'objectChange', {} );

			expect( app.needsReset ).toBe( true );
			expect( app.wake ).toHaveBeenCalled();

		} );

	} );

	describe( 'setMeshData', () => {

		it( 'keeps the mesh list and nothing per-vertex', () => {

			const mesh = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );

			tm.setMeshData( [ mesh ] );

			// A move never reads vertices, so a scene of any size costs one array reference.
			expect( tm._meshes ).toEqual( [ mesh ] );
			expect( tm._meshPositions ).toBeUndefined();
			expect( tm._skinnedCache ).toBeUndefined();

		} );

	} );

	describe( 'moving an object', () => {

		it( 'updates transforms instead of rewriting geometry', () => {

			const mesh = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );
			tm.setMeshData( [ mesh ] );
			mesh.updateMatrixWorld = vi.fn();
			tm.attach( mesh );

			tm.controls._fire( 'dragging-changed', { value: true } );
			tm.controls._fire( 'dragging-changed', { value: false } );

			expect( app.updateMeshTransforms ).toHaveBeenCalledWith( [ 0 ] );
			// The geometry path would drag every other object sharing this mesh's triangles.
			expect( app.refitBLASes ).not.toHaveBeenCalled();

		} );

		it( 'moves every mesh under the attached group', () => {

			const parent = { name: 'group', parent: null, updateMatrixWorld: vi.fn() };
			const meshA = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ], parent );
			const meshB = makeMockMesh( [ 2, 2, 2, 3, 2, 2, 2, 3, 2 ], [ 0, 1, 2 ], parent );
			const meshC = makeMockMesh( [ 4, 4, 4, 5, 4, 4, 4, 5, 4 ], [ 0, 1, 2 ], null );
			tm.setMeshData( [ meshA, meshB, meshC ] );
			tm.attach( parent );

			tm.controls._fire( 'dragging-changed', { value: true } );
			tm.controls._fire( 'dragging-changed', { value: false } );

			expect( app.updateMeshTransforms ).toHaveBeenCalledWith( [ 0, 1 ] );

		} );

		it( 'does nothing when the attached object owns no mesh', () => {

			const mesh = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );
			tm.setMeshData( [ mesh ] );
			tm.attach( { name: 'unrelated', updateMatrixWorld: vi.fn() } );

			tm.controls._fire( 'dragging-changed', { value: true } );
			tm.controls._fire( 'dragging-changed', { value: false } );

			expect( app.updateMeshTransforms ).not.toHaveBeenCalled();

		} );

	} );

	describe( '_findAffectedMeshIndices', () => {

		it( 'finds the object itself in mesh list', () => {

			const meshA = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );
			const meshB = makeMockMesh( [ 2, 2, 2, 3, 2, 2, 2, 3, 2 ], [ 0, 1, 2 ] );
			tm._meshes = [ meshA, meshB ];

			const indices = tm._findAffectedMeshIndices( meshA );
			expect( indices ).toEqual( [ 0 ] );

		} );

		it( 'finds descendants of the attached object', () => {

			const parent = { name: 'group', parent: null };
			const meshA = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ], parent );
			const meshB = makeMockMesh( [ 2, 2, 2, 3, 2, 2, 2, 3, 2 ], [ 0, 1, 2 ], null );
			tm._meshes = [ meshA, meshB ];

			const indices = tm._findAffectedMeshIndices( parent );
			expect( indices ).toEqual( [ 0 ] ); // meshA is descendant, meshB is not

		} );

		it( 'returns empty for unrelated object', () => {

			const meshA = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );
			tm._meshes = [ meshA ];

			const indices = tm._findAffectedMeshIndices( { name: 'unrelated' } );
			expect( indices ).toEqual( [] );

		} );

	} );

	describe( 'dispose', () => {

		it( 'detaches and clears all state', () => {

			const obj = { name: 'cube' };
			tm.attach( obj );

			const mesh = makeMockMesh( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], [ 0, 1, 2 ] );
			tm.setMeshData( [ mesh ] );

			tm.dispose();

			expect( tm.attachedObject ).toBeNull();
			expect( tm._meshes ).toBeNull();

		} );

	} );

	describe( 'render', () => {

		it( 'skips render when nothing attached', () => {

			const renderer = {
				autoClear: true,
				clearDepth: vi.fn(),
				setRenderTarget: vi.fn(),
				render: vi.fn(),
			};

			tm.render( renderer );

			expect( renderer.render ).not.toHaveBeenCalled();

		} );

		it( 'renders gizmo scene when attached', () => {

			const renderer = {
				autoClear: true,
				clearDepth: vi.fn(),
				setRenderTarget: vi.fn(),
				render: vi.fn(),
			};

			tm.attach( { name: 'cube' } );
			tm.render( renderer );

			expect( renderer.clearDepth ).toHaveBeenCalled();
			expect( renderer.setRenderTarget ).toHaveBeenCalledWith( null );
			expect( renderer.render ).toHaveBeenCalled();
			expect( renderer.autoClear ).toBe( true ); // restored

		} );

	} );

} );
