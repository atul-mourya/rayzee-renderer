/**
 * AnimationManager — Drives GLTF skeletal/morph animations for BVH refit.
 *
 * Owns the Three.js AnimationMixer, advances clips each frame,
 * extracts deformed vertex positions via CPU skinning, and returns
 * a per-mesh reader in the shape PathTracerApp.refitBVH() accepts.
 */

import { AnimationMixer, EventDispatcher, Timer, Vector3, LoopRepeat, LoopOnce } from 'three';
import { EngineEvents } from '../EngineEvents.js';

export class AnimationManager extends EventDispatcher {

	constructor() {

		super();

		this.mixer = null;
		this.timer = new Timer();
		this.actions = [];
		this.isPlaying = false;

		this._scene = null; // scene root (for matrixWorld updates)
		this._mixerRoot = null; // mixer target (GLTF model root for track resolution)
		this._meshes = null;
		this._meshTriRanges = null; // { start, count, uniqueVerts, indices }[]
		this._meshPositions = null; // per-mesh Float32Array(triCount * 9), allocated on first use
		this._tempVec = new Vector3();
		this._skinnedCache = null; // per-mesh Float32Array for skinned vertex positions
		this._clipsCache = null;
		this._savedTimeScale = 1;
		this.onFinished = null; // callback when a non-looping clip ends

		/** Injected by PathTracerApp — wakes the render loop after play/resume. */
		this.wakeCallback = null;

	}

	/**
	 * Initialize with scene data and animation clips.
	 * Call after loadSceneData() completes.
	 *
	 * @param {Object3D} scene - Top-level scene (for full matrixWorld updates)
	 * @param {Object3D} mixerRoot - GLTF model root (for animation track name resolution)
	 * @param {Mesh[]} meshes - SceneProcessor.meshes (extraction order)
	 * @param {AnimationClip[]} animations - GLTF animation clips
	 */
	init( scene, mixerRoot, meshes, animations ) {

		this.dispose();

		if ( ! animations || animations.length === 0 ) return;

		this._scene = scene;
		this._mixerRoot = mixerRoot;
		this._meshes = meshes;

		// Try mixerRoot (GLTF model root) first for track resolution.
		// Fall back to scene if no tracks bind successfully.
		this.mixer = new AnimationMixer( mixerRoot );
		let actions = animations.map( clip => this.mixer.clipAction( clip ) );

		// Check if any tracks actually bind to nodes in the mixer root hierarchy.
		// If not, retry with the top-level scene as mixer root.
		const findNode = ( root, name ) =>
			root.name === name || root.getObjectByName( name ) !== undefined;

		const hasBoundTracks = actions.some( action => {

			const clip = action.getClip();
			return clip.tracks.some( track => {

				const nodeName = track.name.split( '.' )[ 0 ];
				return findNode( mixerRoot, nodeName );

			} );

		} );

		if ( ! hasBoundTracks && mixerRoot !== scene ) {

			console.log( '[AnimationManager] Tracks did not resolve from model root, retrying with scene root' );
			this.mixer = new AnimationMixer( scene );
			this._mixerRoot = scene;
			actions = animations.map( clip => this.mixer.clipAction( clip ) );

		}

		this.actions = actions;

		// Listen for non-looping clip completion
		this.mixer.addEventListener( 'finished', () => {

			this.isPlaying = false;
			this.timer.reset();
			if ( this.onFinished ) this.onFinished();

		} );

		// Precompute per-mesh triangle ranges (must match GeometryExtractor traversal order)
		this._meshTriRanges = [];
		this._skinnedCache = [];
		let offset = 0;

		for ( const mesh of meshes ) {

			const geometry = mesh.geometry;
			const positions = geometry.attributes.position;
			const indices = geometry.index ? geometry.index.array : null;
			const count = indices ? indices.length / 3 : positions.count / 3;
			const uniqueVerts = positions.count;

			this._meshTriRanges.push( { start: offset, count, uniqueVerts, indices } );
			offset += count;

		}

		// Scratch is per mesh and allocated on first use. One scene-wide output buffer would be
		// 9 floats × every triangle — 1,030 MB at 30M, past what a renderer can allocate.
		this._skinnedCache = [];
		this._meshPositions = [];

		const skinnedCount = meshes.filter( m => m.isSkinnedMesh ).length;
		console.debug( `[AnimationManager] Init: ${animations.length} clips, ${meshes.length} meshes (${skinnedCount} skinned), ${offset} triangles` );

	}

	/**
	 * Start playing an animation clip.
	 * @param {number} [clipIndex=0] - Index into the actions array, or -1 for all
	 */
	play( clipIndex = 0 ) {

		if ( ! this.mixer || this.actions.length === 0 ) return;

		this.mixer.stopAllAction();

		if ( clipIndex === - 1 ) {

			for ( const action of this.actions ) action.play();

		} else if ( clipIndex >= 0 && clipIndex < this.actions.length ) {

			this.actions[ clipIndex ].play();

		}

		this.timer.reset();
		this.isPlaying = true;
		this.wakeCallback?.();
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STARTED } );

	}

	/**
	 * Pause animation — preserves current time position.
	 */
	pause() {

		if ( ! this.mixer ) return;

		this.mixer.timeScale = 0;
		this.timer.reset();
		this.isPlaying = false;
		this.dispatchEvent( { type: EngineEvents.ANIMATION_PAUSED } );

	}

	/**
	 * Resume animation from paused state.
	 */
	resume() {

		if ( ! this.mixer ) return;

		this.mixer.timeScale = this._savedTimeScale || 1;
		this.timer.reset();
		this.isPlaying = true;
		this.wakeCallback?.();
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STARTED } );

	}

	/**
	 * Stop animation — resets to beginning.
	 */
	stop() {

		if ( ! this.mixer ) return;

		this.mixer.stopAllAction();
		this.mixer.timeScale = this._savedTimeScale || 1;
		this.timer.reset();
		this.isPlaying = false;
		this.dispatchEvent( { type: EngineEvents.ANIMATION_STOPPED } );

	}

	/**
	 * Set playback speed.
	 * @param {number} speed - Multiplier (1.0 = normal, 0.5 = half, 2.0 = double)
	 */
	setSpeed( speed ) {

		this._savedTimeScale = speed;
		if ( this.mixer && this.isPlaying ) this.mixer.timeScale = speed;

	}

	/**
	 * Set loop mode for all actions.
	 * @param {boolean} loop - true for LoopRepeat, false for LoopOnce
	 */
	setLoop( loop ) {

		const mode = loop ? LoopRepeat : LoopOnce;
		for ( const action of this.actions ) {

			action.setLoop( mode );
			action.clampWhenFinished = ! loop;

		}

	}

	/**
	 * Seek to an absolute time and prepare deformed vertex positions.
	 * Does not require playback — works from any state (stopped, paused, playing).
	 *
	 * @param {number} time - Absolute time in seconds
	 * @param {number} [clipIndex=0] - Clip to evaluate, or -1 for all active
	 * @returns {function(number): Float32Array|null} Per-mesh reader for refitBVH, or null if no mixer
	 */
	seekTo( time, clipIndex = 0 ) {

		if ( ! this.mixer || this.actions.length === 0 ) return null;

		// Ensure the target action(s) are active so setTime evaluates them.
		// Actions must NOT be paused — setTime() calls update() internally,
		// which skips paused actions entirely.
		this.mixer.stopAllAction();

		if ( clipIndex === - 1 ) {

			for ( const action of this.actions ) action.play();

		} else if ( clipIndex >= 0 && clipIndex < this.actions.length ) {

			this.actions[ clipIndex ].play();

		}

		// setTime() resets mixer.time to 0, resets all action times to 0,
		// then calls update(time) to evaluate at the absolute time position
		this.mixer.setTime( time );

		// Pause after evaluation to prevent further time advancement
		for ( const action of this.actions ) {

			if ( action.isRunning() ) action.paused = true;

		}

		return this._poseReader();

	}

	/**
	 * Get the current playback time of the mixer.
	 * @returns {number}
	 */
	get currentTime() {

		return this.mixer?.time || 0;

	}

	/**
	 * Advance animation and prepare deformed positions.
	 * Call once per frame from the animate loop.
	 *
	 * @returns {function(number): Float32Array|null} Per-mesh reader for refitBVH, or null if not playing
	 */
	update() {

		if ( ! this.isPlaying || ! this.mixer ) return null;

		this.timer.update();
		const delta = this.timer.getDelta();
		this.mixer.update( delta );

		return this._poseReader();

	}

	/** A reusable per-mesh buffer, grown only when that mesh is first skinned. @private */
	_scratch( cache, index, length ) {

		const have = cache[ index ];
		return have && have.length === length ? have : ( cache[ index ] = new Float32Array( length ) );

	}

	/**
	 * Settle the pose, then hand back a reader that skins one mesh at a time. The refit pulls each
	 * mesh as it needs it, so only one mesh's worth of deformed positions exists at any moment.
	 * @private
	 */
	_poseReader() {

		// Bones live outside mesh subtrees so per-mesh updateMatrixWorld() misses them. Doing it
		// once here, on mixerRoot rather than the scene, keeps unrelated static objects out of it.
		this._mixerRoot.updateMatrixWorld( true );

		return m => this._computeMeshPositions( m );

	}

	/**
	 * Skin one mesh into its own buffer. Two phases for indexed geometry: skin the unique
	 * vertices, then assemble triangles from the index buffer.
	 * @private
	 */
	_computeMeshPositions( m ) {

		const tempVec = this._tempVec;
		const mesh = this._meshes[ m ];
		const { count, uniqueVerts, indices } = this._meshTriRanges[ m ];
		const skinned = this._scratch( this._skinnedCache, m, uniqueVerts * 3 );
		const output = this._scratch( this._meshPositions, m, count * 9 );

		const worldMatrix = mesh.matrixWorld;

		// Phase 1: Compute world-space positions for all unique vertices
		for ( let v = 0; v < uniqueVerts; v ++ ) {

			// getVertexPosition handles morph targets + bone transforms (local space)
			mesh.getVertexPosition( v, tempVec );
			// Transform to world space (matches GeometryExtractor behavior)
			tempVec.applyMatrix4( worldMatrix );

			skinned[ v * 3 ] = tempVec.x;
			skinned[ v * 3 + 1 ] = tempVec.y;
			skinned[ v * 3 + 2 ] = tempVec.z;

		}

		// Phase 2: Assemble triangles
		if ( indices ) {

			for ( let t = 0; t < count; t ++ ) {

				const t3 = t * 3;
				const i0 = indices[ t3 ] * 3;
				const i1 = indices[ t3 + 1 ] * 3;
				const i2 = indices[ t3 + 2 ] * 3;
				const o = t * 9;

				output[ o ] = skinned[ i0 ];
				output[ o + 1 ] = skinned[ i0 + 1 ];
				output[ o + 2 ] = skinned[ i0 + 2 ];
				output[ o + 3 ] = skinned[ i1 ];
				output[ o + 4 ] = skinned[ i1 + 1 ];
				output[ o + 5 ] = skinned[ i1 + 2 ];
				output[ o + 6 ] = skinned[ i2 ];
				output[ o + 7 ] = skinned[ i2 + 1 ];
				output[ o + 8 ] = skinned[ i2 + 2 ];

			}

		} else {

			// Non-indexed: vertices are sequential triplets
			for ( let t = 0; t < count; t ++ ) {

				const v0 = ( t * 3 ) * 3;
				const v1 = ( t * 3 + 1 ) * 3;
				const v2 = ( t * 3 + 2 ) * 3;
				const o = t * 9;

				output[ o ] = skinned[ v0 ];
				output[ o + 1 ] = skinned[ v0 + 1 ];
				output[ o + 2 ] = skinned[ v0 + 2 ];
				output[ o + 3 ] = skinned[ v1 ];
				output[ o + 4 ] = skinned[ v1 + 1 ];
				output[ o + 5 ] = skinned[ v1 + 2 ];
				output[ o + 6 ] = skinned[ v2 ];
				output[ o + 7 ] = skinned[ v2 + 1 ];
				output[ o + 8 ] = skinned[ v2 + 2 ];

			}

		}

		return output;

	}

	/**
	 * Whether animation clips are available.
	 */
	get hasAnimations() {

		return this.actions.length > 0;

	}

	/**
	 * Get info about available animation clips.
	 * @returns {{ index: number, name: string, duration: number }[]}
	 */
	get clips() {

		if ( ! this._clipsCache ) {

			this._clipsCache = this.actions.map( ( action, index ) => {

				const clip = action.getClip();
				return { index, name: clip.name || `Clip ${index}`, duration: clip.duration };

			} );

		}

		return this._clipsCache;

	}

	dispose() {

		if ( this.mixer ) {

			this.mixer.stopAllAction();
			this.mixer.uncacheRoot( this._mixerRoot );
			this.mixer = null;

		}

		this.actions = [];
		this.isPlaying = false;
		this.timer.reset();
		this._scene = null;
		this._mixerRoot = null;
		this._meshes = null;
		this._meshTriRanges = null;
		this._meshPositions = null;
		this._skinnedCache = null;
		this._clipsCache = null;

	}

}
