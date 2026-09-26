import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Three.js dependencies before importing AnimationManager
vi.mock( 'three', () => {

	const LoopRepeat = 2201;
	const LoopOnce = 2200;

	class Clock {

		constructor( autoStart ) {

			this.running = autoStart !== false;
			this._delta = 1 / 60;

		}

		start() {

			this.running = true;

		}
		stop() {

			this.running = false;

		}
		getDelta() {

			return this._delta;

		}

	}

	class Timer {

		constructor() {

			this._delta = 1 / 60;

		}

		reset() {}
		update() {}
		getDelta() {

			return this._delta;

		}

	}

	class Vector3 {

		constructor( x = 0, y = 0, z = 0 ) {

			this.x = x; this.y = y; this.z = z;

		}

		applyMatrix4() {

			return this;

		}

	}

	class AnimationMixer {

		constructor() {

			this.time = 0;
			this.timeScale = 1;
			this._actions = [];
			this._listeners = {};

		}

		addEventListener( type, fn ) {

			if ( ! this._listeners[ type ] ) this._listeners[ type ] = [];
			this._listeners[ type ].push( fn );

		}

		removeEventListener( type, fn ) {

			if ( ! this._listeners[ type ] ) return;
			this._listeners[ type ] = this._listeners[ type ].filter( l => l !== fn );

		}

		clipAction( clip ) {

			const action = {
				_clip: clip,
				_loop: LoopRepeat,
				paused: false,
				clampWhenFinished: false,
				play: vi.fn( function () {

					this.paused = false; return this;

				} ),
				stop: vi.fn().mockReturnThis(),
				isRunning: vi.fn( () => true ),
				getClip: () => clip,
				setLoop: vi.fn( function ( mode ) {

					this._loop = mode;

				} ),
			};
			this._actions.push( action );
			return action;

		}

		update( delta ) {

			this.time += delta * this.timeScale;

		}
		setTime( t ) {

			this.time = 0; this._actions.forEach( a => {

				a.time = 0;

			} ); this.update( t );

		}
		stopAllAction() {

			this._actions.forEach( a => a.stop() );

		}
		uncacheRoot() {}

	}

	class EventDispatcher {

		constructor() {

			this._listeners = {};

		}
		addEventListener( type, fn ) {

			( this._listeners[ type ] ??= [] ).push( fn );

		}
		removeEventListener( type, fn ) {

			const a = this._listeners[ type ]; if ( a ) {

				const i = a.indexOf( fn ); if ( i >= 0 ) a.splice( i, 1 );

			}

		}
		dispatchEvent( event ) {

			( this._listeners[ event.type ] || [] ).forEach( fn => fn( event ) );

		}

	}

	const PropertyBinding = {
		parseTrackName( name ) {

			const dot = name.lastIndexOf( '.' );
			return { nodeName: name.slice( 0, dot ), propertyName: name.slice( dot + 1 ) };

		}
	};

	return { AnimationMixer, Clock, Timer, Vector3, LoopRepeat, LoopOnce, EventDispatcher, PropertyBinding };

} );

vi.mock( '@/core/EngineEvents.js', () => ( {
	EngineEvents: {
		ANIMATION_STARTED: 'ANIMATION_STARTED',
		ANIMATION_PAUSED: 'ANIMATION_PAUSED',
		ANIMATION_STOPPED: 'ANIMATION_STOPPED',
	}
} ) );

const { AnimationManager } = await import( '@/core/managers/AnimationManager.js' );

describe( 'AnimationManager', () => {

	let manager;
	let mockScene;
	let mockMixerRoot;
	let mockMeshes;
	let mockAnimations;

	beforeEach( () => {

		manager = new AnimationManager();

		mockScene = {
			name: 'Scene',
			updateMatrixWorld: vi.fn(),
			getObjectByName: vi.fn( () => null ),
		};

		mockMixerRoot = {
			name: 'ModelRoot',
			getObjectByName: vi.fn( ( name ) => name === 'Bone1' ? {} : undefined ),
			updateMatrixWorld: vi.fn(),
		};

		// Mock mesh with geometry
		const positions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		const indices = new Uint16Array( [ 0, 1, 2 ] );
		// Skinned, so clips deform and positions come back for a refit.
		mockMeshes = [ {
			isSkinnedMesh: true,
			matrixWorld: { elements: new Float32Array( 16 ) },
			geometry: {
				attributes: {
					position: { array: positions, count: 3, itemSize: 3 },
				},
				index: { array: indices },
			},
			getVertexPosition: vi.fn( function ( idx, target ) {

				target.x = positions[ idx * 3 ];
				target.y = positions[ idx * 3 + 1 ];
				target.z = positions[ idx * 3 + 2 ];
				return target;

			} ),
			updateMatrixWorld: vi.fn(),
		} ];

		mockAnimations = [
			{ name: 'Walk', duration: 2.0, tracks: [ { name: 'Bone1.position' } ] },
			{ name: 'Run', duration: 1.5, tracks: [ { name: 'Bone1.quaternion' } ] },
		];

	} );

	describe( 'init', () => {

		it( 'creates actions for all clips', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			expect( manager.actions ).toHaveLength( 2 );
			expect( manager.hasAnimations ).toBe( true );

		} );

		it( 'precomputes mesh triangle ranges', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			expect( manager._meshTriRanges ).toHaveLength( 1 );
			expect( manager._meshTriRanges[ 0 ].start ).toBe( 0 );
			expect( manager._meshTriRanges[ 0 ].count ).toBe( 1 );
			expect( manager._meshTriRanges[ 0 ].uniqueVerts ).toBe( 3 );

		} );

		it( 'allocates no position storage until a mesh is skinned', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			expect( manager._meshPositions ).toEqual( [] );
			expect( manager._skinnedCache ).toEqual( [] );

			manager._computeMeshPositions( 0 );
			expect( manager._meshPositions[ 0 ] ).toBeInstanceOf( Float32Array );
			expect( manager._meshPositions[ 0 ].length ).toBe( 9 ); // that mesh alone

		} );

		it( 'skips init for empty animations', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, [] );
			expect( manager.hasAnimations ).toBe( false );
			expect( manager.mixer ).toBeNull();

		} );

		it( 'falls back to scene root if tracks do not resolve from mixerRoot', () => {

			mockMixerRoot.getObjectByName = vi.fn( () => undefined );
			mockMixerRoot.name = 'NoMatch';

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			expect( manager._mixerRoot ).toBe( mockScene );

		} );

	} );

	describe( 'play / pause / resume / stop', () => {

		it( 'starts playback and sets isPlaying', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			expect( manager.isPlaying ).toBe( true );
			expect( manager.actions[ 0 ].play ).toHaveBeenCalled();

		} );

		it( 'pauses playback', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			manager.pause();
			expect( manager.isPlaying ).toBe( false );
			expect( manager.mixer.timeScale ).toBe( 0 );

		} );

		it( 'resumes from pause', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			manager.pause();
			manager.resume();
			expect( manager.isPlaying ).toBe( true );

		} );

		it( 'stops playback', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			manager.stop();
			expect( manager.isPlaying ).toBe( false );

		} );

		it( 'plays all clips with clipIndex -1', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( - 1 );
			expect( manager.actions[ 0 ].play ).toHaveBeenCalled();
			expect( manager.actions[ 1 ].play ).toHaveBeenCalled();

		} );

	} );

	describe( 'setSpeed / setLoop', () => {

		it( 'sets saved timeScale', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.setSpeed( 2.0 );
			expect( manager._savedTimeScale ).toBe( 2.0 );

		} );

		it( 'applies timeScale when playing', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			manager.setSpeed( 2.0 );
			expect( manager.mixer.timeScale ).toBe( 2.0 );

		} );

		it( 'sets loop mode on all actions', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.setLoop( false );
			expect( manager.actions[ 0 ].setLoop ).toHaveBeenCalledWith( 2200 ); // LoopOnce
			expect( manager.actions[ 0 ].clampWhenFinished ).toBe( true );

		} );

	} );

	describe( 'clips', () => {

		it( 'returns clip info array', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			const clips = manager.clips;
			expect( clips ).toHaveLength( 2 );
			expect( clips[ 0 ] ).toEqual( { index: 0, name: 'Walk', duration: 2.0 } );
			expect( clips[ 1 ] ).toEqual( { index: 1, name: 'Run', duration: 1.5 } );

		} );

	} );

	describe( 'update', () => {

		it( 'returns null when not playing', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			expect( manager.update() ).toBeNull();

		} );

		it( 'returns position buffer when playing', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			const result = manager.update();
			// A per-mesh reader, not one buffer for the scene.
			expect( typeof result ).toBe( 'function' );
			expect( result( 0 ) ).toBeInstanceOf( Float32Array );
			expect( result( 0 ).length ).toBe( 9 );

		} );

		it( 'calls mixerRoot.updateMatrixWorld', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.play( 0 );
			manager.update();
			expect( mockMixerRoot.updateMatrixWorld ).toHaveBeenCalledWith( true );

		} );

	} );

	describe( 'seekTo', () => {

		it( 'returns null when no mixer', () => {

			expect( manager.seekTo( 1.0 ) ).toBeNull();

		} );

		it( 'seeks to the given time and returns positions', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			const result = manager.seekTo( 1.0, 0 );
			expect( typeof result ).toBe( 'function' );
			expect( result( 0 ) ).toHaveLength( 9 );
			expect( manager.mixer.time ).toBe( 1.0 );

		} );

		it( 'activates the correct clip action', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.seekTo( 0.5, 1 );
			expect( manager.actions[ 1 ].play ).toHaveBeenCalled();

		} );

		it( 'pauses actions after seeking to prevent further advancement', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.seekTo( 1.0, 0 );
			expect( manager.actions[ 0 ].paused ).toBe( true );

		} );

		it( 'plays all clips with clipIndex -1', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.seekTo( 0.5, - 1 );
			expect( manager.actions[ 0 ].play ).toHaveBeenCalled();
			expect( manager.actions[ 1 ].play ).toHaveBeenCalled();

		} );

		it( 'works from stopped state', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.stop();
			const result = manager.seekTo( 0.5 );
			expect( typeof result ).toBe( 'function' );

		} );

	} );

	describe( 'rigid clips', () => {

		// A root with two meshes: `mover` is animated through its parent group, `still` is not.
		function rigidScene() {

			const node = ( name, extra = {} ) => ( {
				name, uuid: `uuid-${name}`, visible: true, parent: null, children: [],
				matrixWorld: { elements: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] },
				traverse( fn ) {

					fn( this );
					this.children.forEach( c => c.traverse( fn ) );

				},
				getObjectByName( n ) {

					let hit;
					this.traverse( o => {

						if ( ! hit && o !== this && o.name === n ) hit = o;

					} );
					return hit;

				},
				...extra
			} );

			const geometry = { attributes: { position: { count: 3 } }, index: null };
			const root = node( 'Root', { updateMatrixWorld: vi.fn() } );
			const group = node( 'Group' );
			const mover = node( 'Mover', { geometry } );
			const still = node( 'Still', { geometry } );
			const camera = node( 'Cam', { isCamera: true } );
			const link = ( parent, child ) => {

				child.parent = parent;
				parent.children.push( child );

			};

			link( root, group );
			link( group, mover );
			link( root, still );
			link( root, camera );

			const clips = [ {
				name: 'Move', duration: 1,
				tracks: [ { name: 'Group.position' }, { name: 'Group.visible' }, { name: 'Cam.quaternion' } ]
			} ];

			return { root, group, mover, still, camera, clips, meshes: [ still, mover ] };

		}

		it( 'returns no positions and hands the moved meshes to applyPoseCallback', () => {

			const { root, mover, clips, meshes, camera } = rigidScene();
			const poses = [];
			manager.applyPoseCallback = pose => poses.push( pose );
			manager.init( root, root, meshes, clips );

			manager.play( 0 );
			expect( manager.update() ).toBeNull();

			// The first pose sends every animated mesh, whatever the renderer held before.
			expect( poses ).toHaveLength( 1 );
			expect( poses[ 0 ].meshIndices ).toEqual( [ 1 ] );
			expect( poses[ 0 ].visibilityChanged ).toBe( true );
			expect( poses[ 0 ].cameras ).toEqual( [ camera ] );

			// Unchanged since: nothing to move.
			manager.update();
			expect( poses[ 1 ].meshIndices ).toEqual( [] );
			expect( poses[ 1 ].visibilityChanged ).toBe( false );

			mover.matrixWorld.elements = mover.matrixWorld.elements.map( ( v, i ) => i === 12 ? 5 : v );
			manager.update();
			expect( poses[ 2 ].meshIndices ).toEqual( [ 1 ] );

		} );

		it( 'reports a visibility change inherited from an ancestor', () => {

			const { root, group, clips, meshes } = rigidScene();
			const poses = [];
			manager.applyPoseCallback = pose => poses.push( pose );
			manager.init( root, root, meshes, clips );
			manager.seekTo( 0 );

			group.visible = false;
			manager.seekTo( 0.5 );
			expect( poses[ 1 ].visibilityChanged ).toBe( true );

		} );

		it( 'seekTo returns null and applies the pose', () => {

			const { root, clips, meshes } = rigidScene();
			const poses = [];
			manager.applyPoseCallback = pose => poses.push( pose );
			manager.init( root, root, meshes, clips );

			expect( manager.seekTo( 0.5, 0 ) ).toBeNull();
			expect( poses ).toHaveLength( 1 );

		} );

		it( 're-applies the restored pose on stop', () => {

			const { root, mover, clips, meshes } = rigidScene();
			const poses = [];
			manager.applyPoseCallback = pose => poses.push( pose );
			manager.init( root, root, meshes, clips );
			manager.play( 0 );
			manager.update();

			mover.matrixWorld.elements = mover.matrixWorld.elements.map( ( v, i ) => i === 13 ? 2 : v );
			manager.stop();
			expect( poses.at( - 1 ).meshIndices ).toEqual( [ 1 ] );

		} );

		it( 'stays deforming when a mesh is skinned', () => {

			const { root, clips, meshes } = rigidScene();
			meshes[ 0 ].isSkinnedMesh = true;
			meshes[ 0 ].getVertexPosition = ( i, t ) => t;
			manager.init( root, root, meshes, clips );
			manager.play( 0 );
			expect( typeof manager.update() ).toBe( 'function' );

		} );

	} );

	describe( 'dispose', () => {

		it( 'clears all state', () => {

			manager.init( mockScene, mockMixerRoot, mockMeshes, mockAnimations );
			manager.dispose();
			expect( manager.mixer ).toBeNull();
			expect( manager.actions ).toHaveLength( 0 );
			expect( manager.isPlaying ).toBe( false );
			expect( manager._meshPositions ).toBeNull();

		} );

	} );

} );
