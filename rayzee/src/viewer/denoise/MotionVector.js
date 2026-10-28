import { Fn, vec2, vec4, float, int, uint, ivec2, uvec2, uniform, If,
	textureLoad, textureStore, workgroupId, localId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4 } from 'three';
import { RenderStage, StageExecutionMode } from '../../pipeline/RenderStage.js';
import { cameraRayPoint, cameraRayUniforms } from '../../shaders/CameraRay.js';

/**
 * WebGPU Motion Vector Stage (Compute Shader)
 *
 * Computes per-pixel screen-space motion vectors by reconstructing world
 * positions from linear ray depth and reprojecting to the previous frame.
 *
 * Architecture (copy approach — proven working in PathTracer):
 *   1. A compute shader writes to a StorageTexture via textureStore
 *   2. After dispatch, copyTextureToTexture transfers StorageTexture → RenderTarget
 *   3. The RenderTarget texture is published to context (NOT the StorageTexture —
 *      cross-dispatch reads from StorageTexture return zeros in Three.js WebGPU)
 *
 * Algorithm:
 *   1. Read normalDepth from NormalDepth (linear depth in alpha)
 *   2. Reconstruct the camera ray NormalDepth traced for the pixel
 *   3. World position = rayOrigin + rayDir * linearDepth
 *   4. Project to previous frame:  prevVP * worldPos
 *   5. Motion = currentUV - prevUV
 *
 * Output format (RGBA Float → copied to RGBA HalfFloat RenderTarget):
 *   screenSpace — xy=motion (UV-space), z=depth, w=validity
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
 * Textures published:
 *   motionVector:screenSpace (from RenderTarget, not StorageTexture)
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

		// Camera uniforms for world position reconstruction
		// Synced from PathTracer each frame (same source as NormalDepth)
		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.cameraRay = cameraRayUniforms();
		this.prevVP = uniform( new Matrix4(), 'mat4' );

		// Resolution uniforms (for compute pixel coords)
		this.resolutionWidth = uniform( width );
		this.resolutionHeight = uniform( height );

		// Input texture node (swappable — no shader recompile)
		this._normalDepthTexNode = new TextureNode();

		// Write-only StorageTexture (compute output).
		this._screenSpaceStorageTex = new StorageTexture( width, height );
		this._screenSpaceStorageTex.type = HalfFloatType;
		this._screenSpaceStorageTex.format = RGBAFormat;
		this._screenSpaceStorageTex.minFilter = NearestFilter;
		this._screenSpaceStorageTex.magFilter = NearestFilter;

		// Readable RenderTarget (copy destination — published to context)
		this.screenSpaceTarget = new RenderTarget( width, height, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		// Dispatch dimensions (16x16 workgroups)
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );

		this._buildScreenSpaceCompute();

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

	render( context ) {

		if ( ! this.enabled ) return;

		// Get normalDepth from context (RenderTarget texture from NormalDepth)
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		if ( ! normalDepthTex ) return;

		// Update camera matrices (CPU-side) — synced from PathTracer
		this._updateCameraMatrices();

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

		this.renderer.compute( this._screenSpaceComputeNode );

		// Copy StorageTexture → RenderTarget (cross-dispatch reads from
		// StorageTexture return zeros — must use RenderTarget for downstream stages).
		this.renderer.copyTextureToTexture( this._screenSpaceStorageTex, this.screenSpaceTarget.texture );

		context.setTexture( 'motionVector:screenSpace', this.screenSpaceTarget.texture );

	}

	// Free the StorageTexture when disabled (no consumer); three.js re-creates it on the next
	// dispatch after re-enable. _syncGBufferStages additionally reseeds camera history on re-enable.
	releaseGPUMemory() {

		this._screenSpaceStorageTex?.dispose();

	}

	setSize( width, height ) {

		// In place: the kernel keeps the texture object, and three.js rebinds it on its next dispatch.
		this._screenSpaceStorageTex.setSize( width, height );
		this.screenSpaceTarget.setSize( width, height );
		this.screenSpaceTarget.texture.needsUpdate = true;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		if ( this._screenSpaceComputeNode ) {

			this._screenSpaceComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

	}

	dispose() {

		this._screenSpaceComputeNode?.dispose();
		this._screenSpaceStorageTex?.dispose();
		this.screenSpaceTarget?.dispose();
		this._normalDepthTexNode?.dispose();

	}

}
