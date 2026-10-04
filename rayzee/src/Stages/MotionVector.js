import { Fn, vec2, vec3, vec4, float, int, uint, ivec2, uvec2, uniform, If,
	textureLoad, textureStore, workgroupId, localId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { MAX_STORAGE_TEXTURE_SIZE } from '../Processor/StorageTexturePool.js';
import { cameraRayPoint, cameraRayUniforms } from '../TSL/CameraRay.js';

/**
 * WebGPU Motion Vector Stage (Compute Shader)
 *
 * Computes per-pixel screen-space and world-space motion vectors by
 * reconstructing world positions from linear ray depth and reprojecting
 * to the previous frame.
 *
 * Architecture (copy approach — proven working in PathTracer):
 *   1. Two compute shaders write to StorageTextures via textureStore
 *   2. After dispatch, copyTextureToTexture transfers StorageTexture → RenderTarget
 *   3. RenderTarget textures are published to context (NOT StorageTextures —
 *      cross-dispatch reads from StorageTexture return zeros in Three.js WebGPU)
 *
 * Algorithm:
 *   1. Read normalDepth from NormalDepth (linear depth in alpha)
 *   2. Reconstruct the camera ray NormalDepth traced for the pixel
 *   3. World position = rayOrigin + rayDir * linearDepth
 *   4. Project to previous frame:  prevVP * worldPos
 *   5. Motion = currentUV - prevUV
 *
 * Output formats (RGBA Float → copied to RGBA HalfFloat RenderTarget):
 *   screenSpace — xy=motion (UV-space), z=depth, w=validity
 *   worldSpace  — xyz=world velocity, w=validity
 *
 * Critical design decisions:
 *   - matricesInitialized is NOT reset on pipeline:reset.
 *     This preserves motion detection across camera-triggered resets.
 *   - Camera uniforms are synced from PathTracer (same source as
 *     NormalDepth) to guarantee exact matrix consistency for world
 *     position reconstruction. Using the camera object directly can produce
 *     subtly different matrices due to update timing differences.
 *
 * Execution: ALWAYS — motion vectors are needed every frame.
 *
 * Events listened:
 *   pipeline:reset  — reset frame counter (but NOT matrices)
 *
 * Textures published:
 *   motionVector:screenSpace (from RenderTarget, not StorageTexture)
 *   motionVector:worldSpace  (from RenderTarget, not StorageTexture)
 *   motionVector:motion      (alias for screenSpace)
 *
 * Textures read:
 *   pathtracer:normalDepth — linear depth for world position reconstruction
 */
export class MotionVector extends RenderStage {

	constructor( renderer, camera, options = {} ) {

		super( 'MotionVector', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.camera = camera;
		this.pathTracer = options.pathTracer || null;

		const width = options.width || 1;
		const height = options.height || 1;

		// Camera matrix history (for prevVP tracking)
		this.prevViewProjectionMatrix = new Matrix4();
		this.currentViewProjectionMatrix = new Matrix4();

		this.matricesInitialized = false;
		this.isFirstFrame = true;
		this.frameCount = 0;

		// Camera uniforms for world position reconstruction
		// Synced from PathTracer each frame (same source as NormalDepth)
		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.cameraRay = cameraRayUniforms();
		this.prevVP = uniform( new Matrix4(), 'mat4' );
		this.isFirstFrameU = uniform( 1.0 ); // 1.0 = true, 0.0 = false
		this.deltaTime = uniform( 1.0 / 60.0 );
		this.velocityScale = uniform( 1.0 );

		// Resolution uniforms (for compute pixel coords)
		this.resolutionWidth = uniform( width );
		this.resolutionHeight = uniform( height );

		// Input texture node (swappable — no shader recompile)
		this._normalDepthTexNode = new TextureNode();

		// Write-only StorageTextures (compute output).
		// Pre-allocate at max — StorageTexture.setSize() destroys the GPU texture
		// while the compute bind group keeps the stale view (three.js #33061).
		this._screenSpaceStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._screenSpaceStorageTex.type = HalfFloatType;
		this._screenSpaceStorageTex.format = RGBAFormat;
		this._screenSpaceStorageTex.minFilter = NearestFilter;
		this._screenSpaceStorageTex.magFilter = NearestFilter;

		this._worldSpaceStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._worldSpaceStorageTex.type = HalfFloatType;
		this._worldSpaceStorageTex.format = RGBAFormat;
		this._worldSpaceStorageTex.minFilter = NearestFilter;
		this._worldSpaceStorageTex.magFilter = NearestFilter;

		// Reused per-copy: copy only the active region out of the over-alloc texs.
		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Readable RenderTargets (copy destinations — published to context)
		const rtOpts = {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};

		this.screenSpaceTarget = new RenderTarget( width, height, rtOpts );
		this.worldSpaceTarget = new RenderTarget( width, height, rtOpts );

		// Dispatch dimensions (8x8 workgroups)
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );

		// Build compute nodes
		this._buildScreenSpaceCompute();
		this._buildWorldSpaceCompute();

	}

	// ──────────────────────────────────────────────────
	// TSL compute shader builders
	// ──────────────────────────────────────────────────

	/**
	 * Screen-space motion vector compute shader.
	 *
	 * Reconstructs world position from camera ray + linear depth
	 * (matching NormalDepth's ray generation), then reprojects
	 * through the previous frame's VP matrix.
	 */
	_buildScreenSpaceCompute() {

		const normalDepthTex = this._normalDepthTexNode;
		const camWorldMat = this.cameraWorldMatrix;
		const camProjInvMat = this.cameraProjectionMatrixInverse;
		const prevVP = this.prevVP;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._screenSpaceStorageTex;

		const WG_SIZE = 16;

		const computeFn = Fn( ( [ cwm, cpi ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const nd = textureLoad( normalDepthTex, ivec2( gx, gy ) );
				const linearDepth = nd.w;

				// Current pixel UV (for motion = currentUV - prevUV)
				const currentUV = vec2(
					float( gx ).add( 0.5 ).div( resW ),
					float( gy ).add( 0.5 ).div( resH )
				);

				const result = vec4( 0.0, 0.0, linearDepth, 1.0 ).toVar();

				// Sky / background (depth >= 65504 sentinel) — no motion
				If( linearDepth.lessThan( float( 6e4 ) ), () => {

					const worldPos = cameraRayPoint( currentUV, linearDepth, cwm, cpi, this.cameraRay );

					// Project to previous frame
					const prevClip = prevVP.mul( vec4( worldPos, 1.0 ) );
					// Flip prevUV.y to match WebGPU convention
					// (NDC Y=+1 → UV Y=0 at top of screen)
					const prevNDC = prevClip.xy.div( prevClip.w );
					const prevUV = vec2(
						prevNDC.x.mul( 0.5 ).add( 0.5 ),
						prevNDC.y.mul( - 0.5 ).add( 0.5 )
					);

					// Motion vector = current - prev (in UV space)
					const motion = currentUV.sub( prevUV );

					// Validity check: prev UV must be on screen
					const valid = prevUV.x.greaterThanEqual( 0.0 )
						.and( prevUV.x.lessThanEqual( 1.0 ) )
						.and( prevUV.y.greaterThanEqual( 0.0 ) )
						.and( prevUV.y.lessThanEqual( 1.0 ) );

					result.assign( valid.select(
						vec4( motion, linearDepth, 1.0 ),
						vec4( float( 1000.0 ), float( 1000.0 ), linearDepth, 0.0 )
					) );

				} );

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._screenSpaceComputeNode = computeFn( camWorldMat, camProjInvMat ).compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	/**
	 * World-space velocity compute shader.
	 *
	 * Approximates world-space velocity from UV displacement,
	 * scaled by deltaTime and velocityScale.
	 */
	_buildWorldSpaceCompute() {

		const normalDepthTex = this._normalDepthTexNode;
		const camWorldMat = this.cameraWorldMatrix;
		const camProjInvMat = this.cameraProjectionMatrixInverse;
		const prevVP = this.prevVP;
		const isFirstFrameU = this.isFirstFrameU;
		const deltaTime = this.deltaTime;
		const velocityScale = this.velocityScale;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._worldSpaceStorageTex;

		const WG_SIZE = 16;

		const computeFn = Fn( ( [ cwm, cpi ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const nd = textureLoad( normalDepthTex, ivec2( gx, gy ) );
				const linearDepth = nd.w;

				const result = vec4( 0.0, 0.0, 0.0, 0.0 ).toVar();

				// Skip first frame and sky (depth >= 65504 sentinel)
				If( isFirstFrameU.lessThan( 0.5 ).and( linearDepth.lessThan( float( 6e4 ) ) ), () => {

					// Current pixel UV
					const currentUV = vec2(
						float( gx ).add( 0.5 ).div( resW ),
						float( gy ).add( 0.5 ).div( resH )
					);
					const worldPos = cameraRayPoint( currentUV, linearDepth, cwm, cpi, this.cameraRay );

					// Project to previous frame
					const prevClip = prevVP.mul( vec4( worldPos, 1.0 ) );
					// Flip prevUV.y to match WebGPU convention
					const prevNDC = prevClip.xy.div( prevClip.w );
					const prevUV = vec2(
						prevNDC.x.mul( 0.5 ).add( 0.5 ),
						prevNDC.y.mul( - 0.5 ).add( 0.5 )
					);

					const valid = prevUV.x.greaterThanEqual( 0.0 )
						.and( prevUV.x.lessThanEqual( 1.0 ) )
						.and( prevUV.y.greaterThanEqual( 0.0 ) )
						.and( prevUV.y.lessThanEqual( 1.0 ) );

					// World-space velocity approximation from UV displacement
					const motionUV = currentUV.sub( prevUV );
					const worldVelocity = vec3(
						motionUV.x.div( deltaTime ).mul( velocityScale ),
						motionUV.y.div( deltaTime ).mul( velocityScale ),
						0.0
					);

					result.assign( valid.select(
						vec4( worldVelocity, 1.0 ),
						vec4( 0.0, 0.0, 0.0, 0.5 )
					) );

				} );

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._worldSpaceComputeNode = computeFn( camWorldMat, camProjInvMat ).compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// ──────────────────────────────────────────────────
	// Camera matrix management
	// ──────────────────────────────────────────────────

	/**
	 * Sync camera matrices from PathTracer and update prevVP.
	 *
	 * Camera uniforms (cameraWorldMatrix, cameraProjectionMatrixInverse) are
	 * sourced from PathTracer — the SAME source NormalDepth uses.
	 * This guarantees the ray reconstruction matches the depth values exactly.
	 *
	 * The view-projection matrix for prevVP tracking is also derived from
	 * PathTracer's projection and view matrices for consistency.
	 */
	_updateCameraMatrices() {

		const pt = this.pathTracer;

		// Source camera matrices — prefer PathTracer, fall back to camera
		let worldMatrix, viewMatrix, projMatrix, projMatrixInverse;

		if ( pt && pt.uniforms ) {

			// Sync from PathTracer (same source as NormalDepth)
			this.cameraRay.sync( pt.uniforms );
			worldMatrix = pt.uniforms.get( 'cameraWorldMatrix' ).value;
			viewMatrix = pt.uniforms.get( 'cameraViewMatrix' ).value;
			projMatrix = pt.uniforms.get( 'cameraProjectionMatrix' ).value;
			projMatrixInverse = pt.uniforms.get( 'cameraProjectionMatrixInverse' ).value;

		} else {

			// Fallback: read directly from camera object
			const camera = this.camera;
			if ( ! camera ) return;
			worldMatrix = camera.matrixWorld;
			viewMatrix = camera.matrixWorldInverse;
			projMatrix = camera.projectionMatrix;
			projMatrixInverse = camera.projectionMatrixInverse;

		}

		// Store previous VP
		if ( this.matricesInitialized ) {

			this.prevViewProjectionMatrix.copy( this.currentViewProjectionMatrix );

		} else {

			// First init: prev = current
			this.currentViewProjectionMatrix.multiplyMatrices(
				projMatrix,
				viewMatrix
			);
			this.prevViewProjectionMatrix.copy( this.currentViewProjectionMatrix );
			this.matricesInitialized = true;

		}

		// Update current VP from PathTracer's matrices
		this.currentViewProjectionMatrix.multiplyMatrices(
			projMatrix,
			viewMatrix
		);

		// Update shader uniforms
		this.cameraWorldMatrix.value.copy( worldMatrix );
		this.cameraProjectionMatrixInverse.value.copy( projMatrixInverse );
		this.prevVP.value.copy( this.prevViewProjectionMatrix );

	}

	// ──────────────────────────────────────────────────
	// Pipeline lifecycle
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => {

			this.reset();

		} );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		// Get normalDepth from context (RenderTarget texture from NormalDepth)
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		if ( ! normalDepthTex ) return;

		// Update camera matrices (CPU-side) — synced from PathTracer
		this._updateCameraMatrices();

		// Update isFirstFrame uniform
		this.isFirstFrameU.value = this.isFirstFrame ? 1.0 : 0.0;

		this.frameCount ++;

		// Auto-size to match normalDepth
		const img = normalDepthTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this.screenSpaceTarget.width ||
				img.height !== this.screenSpaceTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		// Swap input texture (no shader recompile, just swap value)
		this._normalDepthTexNode.value = normalDepthTex;

		// Dispatch screen-space motion vector compute
		this.renderer.compute( this._screenSpaceComputeNode );

		// Dispatch world-space velocity compute
		this.renderer.compute( this._worldSpaceComputeNode );

		// Copy StorageTextures → RenderTargets (cross-dispatch reads from
		// StorageTexture return zeros — must use RenderTarget for downstream stages).
		// srcRegion = active size; StorageTextures are over-allocated at 2048.
		this._srcRegion.max.set( this.screenSpaceTarget.width, this.screenSpaceTarget.height );
		this.renderer.copyTextureToTexture( this._screenSpaceStorageTex, this.screenSpaceTarget.texture, this._srcRegion );
		this.renderer.copyTextureToTexture( this._worldSpaceStorageTex, this.worldSpaceTarget.texture, this._srcRegion );

		// Publish RenderTarget textures to context
		context.setTexture( 'motionVector:screenSpace', this.screenSpaceTarget.texture );
		context.setTexture( 'motionVector:worldSpace', this.worldSpaceTarget.texture );
		context.setTexture( 'motionVector:motion', this.screenSpaceTarget.texture );

		// Emit
		this.emit( 'motionvector:computed', {
			frame: this.frameCount,
			isFirstFrame: this.isFirstFrame
		} );

		this.isFirstFrame = false;

	}

	/**
	 * Reset — intentionally does NOT reset matricesInitialized.
	 * Motion vectors must track camera motion across pipeline resets.
	 */
	// Free the 2048² StorageTextures when disabled (no consumer); three.js re-creates them on the next
	// dispatch after re-enable. _syncGBufferStages additionally reseeds camera history on re-enable.
	releaseGPUMemory() {

		this._screenSpaceStorageTex?.dispose();
		this._worldSpaceStorageTex?.dispose();
		this.reset();

	}

	reset() {

		if ( ! this.matricesInitialized ) {

			this.isFirstFrame = true;

		}

		this.frameCount = 0;

	}

	setSize( width, height ) {

		// StorageTextures stay at their max allocation (see constructor).
		this.screenSpaceTarget.setSize( width, height );
		this.screenSpaceTarget.texture.needsUpdate = true;
		this.worldSpaceTarget.setSize( width, height );
		this.worldSpaceTarget.texture.needsUpdate = true;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		if ( this._screenSpaceComputeNode ) {

			this._screenSpaceComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

		if ( this._worldSpaceComputeNode ) {

			this._worldSpaceComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

	}

	setVelocityScale( scale ) {

		this.velocityScale.value = scale;

	}

	setDeltaTime( dt ) {

		this.deltaTime.value = dt;

	}

	// Reserved-storage change (e.g. 4K toggle): recreate the MAX-preallocated StorageTextures at the new live
	// reserved size + rebuild the compute nodes in place. Same stage object, so refs/wiring stay valid.
	reallocateReservedStorage() {

		this._screenSpaceComputeNode?.dispose();
		this._worldSpaceComputeNode?.dispose();
		this._screenSpaceStorageTex?.dispose();
		this._worldSpaceStorageTex?.dispose();
		const mk = () => {

			const t = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
			t.type = HalfFloatType; t.format = RGBAFormat; t.minFilter = NearestFilter; t.magFilter = NearestFilter;
			return t;

		};

		this._screenSpaceStorageTex = mk();
		this._worldSpaceStorageTex = mk();
		this._buildScreenSpaceCompute();
		this._buildWorldSpaceCompute();

	}

	dispose() {

		this._screenSpaceComputeNode?.dispose();
		this._worldSpaceComputeNode?.dispose();
		this._screenSpaceStorageTex?.dispose();
		this._worldSpaceStorageTex?.dispose();
		this.screenSpaceTarget?.dispose();
		this.worldSpaceTarget?.dispose();
		this._normalDepthTexNode?.dispose();

	}

}
