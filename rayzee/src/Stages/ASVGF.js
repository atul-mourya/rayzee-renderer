import { Fn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, min, abs, mix, pow, exp, sqrt, select,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { HalfFloatType, FloatType, RGBAFormat, NearestFilter, LinearFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { luminance } from '../TSL/Common.js';
import { ALBEDO_EPS, MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';

// Replace NaN/±Inf with a bounded value so one firefly can't permanently poison the
// temporal EMA (mix() propagates NaN forever). Per-channel: NaN (x!=x) → 0, ±Inf → [0,1e7].
const sanitize1 = ( x ) => select( x.equal( x ), x, float( 0.0 ) ).clamp( 0.0, 1e7 );
const sanitizeRGB = ( c ) => vec3( sanitize1( c.x ), sanitize1( c.y ), sanitize1( c.z ) );

/**
 * ASVGF — SVGF temporal denoising with albedo demodulation + adaptive-α.
 *
 * Adaptive temporal gradient (the "A"): the gradient kernel compares this
 * frame's demodulated lighting against the reprojected accumulated history,
 * floored by a per-pixel σ (max(Δ − k·σ, 0)), max-normalised and squared
 * (Q2RTX get_gradient). gradientStrength scales it into effectiveAlpha =
 * mix(baseAlpha, 1, gradient·gradientStrength) — high change ⇒ drop history
 * (anti-lag). All quality presets enable it (gradientStrength > 0); a static
 * scene reads gradient ≈ 0, so convergence is unaffected.
 *
 * Reads:     pathtracer:color, pathtracer:albedo, pathtracer:normalDepth,
 *            pathtracer:prevNormalDepth, motionVector:screenSpace
 * Publishes: asvgf:output (modulated), asvgf:demodulated (lighting + history),
 *            asvgf:gradient
 */
export class ASVGF extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'ASVGF', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;

		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.0 );
		// > 0 is required for firefly rejection, not just anti-lag — see ENGINE_DEFAULTS.
		this.gradientStrength = uniform( options.gradientStrength ?? 1.0 );
		// σ multiplier for the per-pixel noise floor (NRD luminanceSigmaScale ≈ 2).
		this.gradientSigmaScale = uniform( options.gradientSigmaScale ?? 2.0 );
		// Secondary relative floor on the normalised gradient (0 = rely on σ alone).
		this.gradientNoiseFloor = uniform( options.gradientNoiseFloor ?? 0.0 );
		this.maxAccumFrames = uniform( options.maxAccumFrames ?? 32.0 );

		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		this.temporalEnabledU = uniform( 1.0 );
		// 1.0 for one frame after asvgf:reset → forces a fresh sample so stale pre-reset
		// (wrong-scene) history isn't blended in (mirrors Variance's _needsWarmReset).
		this.forceResetU = uniform( 0.0 );

		this._colorTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();
		this._normalDepthTexNode = new TextureNode();
		this._prevNormalDepthTexNode = new TextureNode();
		this._readTemporalTexNode = new TextureNode();
		this._gradientReadTexNode = new TextureNode();

		const w = options.width || 1;
		const h = options.height || 1;

		// FloatType for ping-pong: demodulated lighting on dark materials
		// (lighting ≈ color/0.01) exceeds HalfFloat's 65k cap on HDR.
		// LinearFilter is required for textureLoad codegen on StorageTextures.
		this._temporalTexA = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._temporalTexA.type = FloatType;
		this._temporalTexA.format = RGBAFormat;
		this._temporalTexA.minFilter = LinearFilter;
		this._temporalTexA.magFilter = LinearFilter;

		this._temporalTexB = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._temporalTexB.type = FloatType;
		this._temporalTexB.format = RGBAFormat;
		this._temporalTexB.minFilter = LinearFilter;
		this._temporalTexB.magFilter = LinearFilter;

		this._outputModulatedTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._outputModulatedTex.type = FloatType;
		this._outputModulatedTex.format = RGBAFormat;
		this._outputModulatedTex.minFilter = LinearFilter;
		this._outputModulatedTex.magFilter = LinearFilter;

		this._gradientStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._gradientStorageTex.type = HalfFloatType;
		this._gradientStorageTex.format = RGBAFormat;
		this._gradientStorageTex.minFilter = LinearFilter;
		this._gradientStorageTex.magFilter = LinearFilter;

		// Over-allocated StorageTextures are sampled by UV downstream; copy the
		// active region into right-sized RTs and publish those instead.
		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		this._demodulatedRT = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._outputRT = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._gradientRT = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this.currentMoments = 0; // 0 = write A, read B; 1 = write B, read A
		this._compiled = false;
		this._needsWarmReset = false;

		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildGradientCompute();
		this._buildTemporalCompute();

		this.showHeatmap = false;
		this.debugMode = uniform( 0, 'int' );

		this._heatmapStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._heatmapStorageTex.type = FloatType;
		this._heatmapStorageTex.format = RGBAFormat;
		this._heatmapStorageTex.minFilter = NearestFilter;
		this._heatmapStorageTex.magFilter = NearestFilter;

		this.heatmapTarget = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._heatmapRawColorTexNode = new TextureNode();
		this._heatmapColorTexNode = new TextureNode();
		this._heatmapTemporalTexNode = new TextureNode();
		this._heatmapNDTexNode = new TextureNode();
		this._heatmapMotionTexNode = new TextureNode();
		this._heatmapGradientTexNode = new TextureNode();

		this._buildHeatmapCompute();

	}

	// Adaptive temporal gradient: per pixel, compare this frame's DEMODULATED
	// lighting against the motion-reprojected accumulated history (low-noise),
	// floored by a per-pixel σ from the 5×5 spatial neighbourhood. The σ floor
	// is what the old fixed 0.15 constant couldn't give — on a static scene the
	// 1-SPP sample sits within ±k·σ of the converged estimate so the gradient
	// reads ~0 (no convergence penalty); only real change (moving light, anim,
	// disocclusion) exceeds it. Demodulation (vs raw color) keeps albedo/texture
	// edges from false-firing. Output .x feeds effectiveAlpha in the temporal pass.
	_buildGradientCompute() {

		const colorTex = this._colorTexNode;
		const albedoTex = this._albedoTexNode;
		const motionTex = this._motionTexNode;
		// Accumulated history (demodulated lighting in .xyz, history count in .w).
		// Same node the temporal pass reads; set to readTemporal before dispatch.
		const histTex = this._readTemporalTexNode;
		const noiseFloor = this.gradientNoiseFloor;
		const sigmaScale = this.gradientSigmaScale;
		const gradientStorageTex = this._gradientStorageTex;
		const resW = this.resW;
		const resH = this.resH;

		// 12×12 tile = 8×8 workgroup + 2px border for the 5×5 stencil.
		const TILE_W = 12;
		const TILE_BORDER = 2;
		const TILE_TOTAL = TILE_W * TILE_W; // 144
		const WG_SIZE = 8;
		const WG_THREADS = WG_SIZE * WG_SIZE; // 64

		const sharedCurLum = workgroupArray( 'float', TILE_TOTAL );
		const sharedHistLum = workgroupArray( 'float', TILE_TOTAL );

		const computeFn = Fn( () => {

			const lx = localId.x;
			const ly = localId.y;
			const linearIdx = ly.mul( WG_SIZE ).add( lx );

			// Hoisted outside loadEntry so all 3 load rounds reuse the same nodes.
			const tileOriginX = int( workgroupId.x ).mul( WG_SIZE ).sub( TILE_BORDER ).toVar();
			const tileOriginY = int( workgroupId.y ).mul( WG_SIZE ).sub( TILE_BORDER ).toVar();

			const loadEntry = ( k ) => {

				const sx = k.mod( uint( TILE_W ) );
				const sy = k.div( uint( TILE_W ) );
				const gxL = tileOriginX.add( int( sx ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const gyL = tileOriginY.add( int( sy ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				// Demodulated current lighting luminance (matches the temporal pass:
				// safeAlbedo = max(albedo, ALBEDO_EPS) keeps sky/dark-material round-trip).
				const curColor = textureLoad( colorTex, ivec2( gxL, gyL ) ).xyz;
				const curAlbedo = textureLoad( albedoTex, ivec2( gxL, gyL ) ).xyz;
				const curLighting = sanitizeRGB( curColor.div( max( curAlbedo, vec3( ALBEDO_EPS ) ) ) );
				const curLum = luminance( curLighting ).toVar();
				sharedCurLum.element( k ).assign( curLum );

				// Reproject the accumulated history to this pixel; read its lighting
				// luminance. Invalid motion → mirror current so the delta is 0
				// (disocclusion handled by the temporal pass's geometric gate).
				const motion = textureLoad( motionTex, ivec2( gxL, gyL ) );
				const prevXf = float( gxL ).sub( motion.x.mul( resW ) );
				const prevYf = float( gyL ).sub( motion.y.mul( resH ) );
				// Round-to-nearest (not truncate) — the gradient does a nearest-neighbour
				// history lookup; +0.5 removes the half-pixel floor bias vs the temporal tap.
				const prevX = int( prevXf.add( 0.5 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const prevY = int( prevYf.add( 0.5 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
				const motionValid = motion.w.greaterThan( 0.5 );
				const histLighting = textureLoad( histTex, ivec2( prevX, prevY ) ).xyz;
				const histLum = motionValid.select( luminance( histLighting ), curLum );
				sharedHistLum.element( k ).assign( histLum );

			};

			// 144 entries / 64 threads → 3 rounds, last partially populated.
			loadEntry( linearIdx );

			const idx2 = linearIdx.add( uint( WG_THREADS ) );
			If( idx2.lessThan( uint( TILE_TOTAL ) ), () => {

				loadEntry( idx2 );

			} );

			const idx3 = linearIdx.add( uint( WG_THREADS * 2 ) );
			If( idx3.lessThan( uint( TILE_TOTAL ) ), () => {

				loadEntry( idx3 );

			} );

			workgroupBarrier();

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( lx ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( ly ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Pass 1 — per-pixel noise σ from the 5×5 (demodulated) neighbourhood.
				const sumLum = float( 0.0 ).toVar();
				const sumLumSq = float( 0.0 ).toVar();

				for ( let dy = - TILE_BORDER; dy <= TILE_BORDER; dy ++ ) {

					for ( let dx = - TILE_BORDER; dx <= TILE_BORDER; dx ++ ) {

						const idx = ly.add( uint( TILE_BORDER + dy ) )
							.mul( uint( TILE_W ) )
							.add( lx.add( uint( TILE_BORDER + dx ) ) );
						const cL = sharedCurLum.element( idx );
						sumLum.addAssign( cL );
						sumLumSq.addAssign( cL.mul( cL ) );

					}

				}

				const meanLum = sumLum.div( 25.0 );
				const variance = max( sumLumSq.div( 25.0 ).sub( meanLum.mul( meanLum ) ), float( 0.0 ) );
				const sigmaFloor = sqrt( variance ).mul( sigmaScale ).toVar();

				// Pass 2 — 5×5 average of the squared, σ-floored, max-normalised
				// temporal change. Squaring (Q2RTX get_gradient) suppresses residual
				// MC noise while staying reactive in high contrast.
				const sumG = float( 0.0 ).toVar();

				for ( let dy = - TILE_BORDER; dy <= TILE_BORDER; dy ++ ) {

					for ( let dx = - TILE_BORDER; dx <= TILE_BORDER; dx ++ ) {

						const idx = ly.add( uint( TILE_BORDER + dy ) )
							.mul( uint( TILE_W ) )
							.add( lx.add( uint( TILE_BORDER + dx ) ) );
						const cL = sharedCurLum.element( idx );
						const hL = sharedHistLum.element( idx );
						const floored = max( abs( cL.sub( hL ) ).sub( sigmaFloor ), float( 0.0 ) );
						const g = floored.div( max( max( cL, hL ), float( 0.001 ) ) );
						// Optional secondary relative floor (noiseFloor=0 → no-op).
						const gf = max( g.sub( noiseFloor ), float( 0.0 ) )
							.div( max( float( 1.0 ).sub( noiseFloor ), float( 0.0001 ) ) );
						sumG.addAssign( gf.mul( gf ) );

					}

				}

				const gradientRaw = sumG.div( 25.0 ).clamp( 0.0, 1.0 ).toVar();

				// Trust the gradient only once enough history has accumulated at the
				// reprojected centre — early frames have noisy history → false fires.
				const cMotion = textureLoad( motionTex, ivec2( gx, gy ) );
				const cPrevX = int( float( gx ).sub( cMotion.x.mul( resW ) ).add( 0.5 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const cPrevY = int( float( gy ).sub( cMotion.y.mul( resH ) ).add( 0.5 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
				const histLen = cMotion.w.greaterThan( 0.5 )
					.select( textureLoad( histTex, ivec2( cPrevX, cPrevY ) ).w, float( 0.0 ) );
				const confidence = histLen.div( 4.0 ).clamp( 0.0, 1.0 );

				const gradient = gradientRaw.mul( confidence );

				textureStore(
					gradientStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					vec4( gradient, gradientRaw, sigmaFloor, 1.0 )
				).toWriteOnly();

			} );

		} );

		this._gradientNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// One temporal node per ping-pong direction.
	_buildTemporalCompute() {

		this._temporalNodeA = this._buildTemporalForDirection( this._temporalTexA );
		this._temporalNodeB = this._buildTemporalForDirection( this._temporalTexB );

	}

	_buildTemporalForDirection( writeTemporalTex ) {

		const NORMAL_POWER = 16.0; // pow(dot, p): smooth surfaces ≈ 1, real edges ≈ 0
		const DEPTH_SIGMA = 0.05; // exp(-relDelta/σ)
		const VALIDITY_THRESHOLD = 0.01; // wSum below → disocclusion → fresh sample

		const colorTex = this._colorTexNode;
		const albedoTex = this._albedoTexNode;
		const motionTex = this._motionTexNode;
		const ndTex = this._normalDepthTexNode;
		const prevNDTex = this._prevNormalDepthTexNode;
		const prevTemporalTex = this._readTemporalTexNode;
		const gradientTex = this._gradientReadTexNode;
		const outputModulatedTex = this._outputModulatedTex;

		const maxAccumFrames = this.maxAccumFrames;
		const temporalAlphaMin = this.temporalAlpha;
		const gradientStrength = this.gradientStrength;
		const temporalEnabledU = this.temporalEnabledU;
		const forceResetU = this.forceResetU;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const currentSample = textureLoad( colorTex, coord );
				const currentColor = currentSample.xyz;
				// Coverage from the path tracer — 0 on background rays when
				// transparentBackground is on. Forcing 1.0 here made the whole frame opaque,
				// so a transparent render composited as black.
				const currentAlpha = currentSample.w;
				const currentAlbedo = textureLoad( albedoTex, coord ).xyz;

				// Same safeAlbedo on both demod and re-mod sides → exact
				// round-trip for sky/miss rays where albedo=0.
				const safeAlbedo = max( currentAlbedo, vec3( ALBEDO_EPS ) );
				const currentLighting = sanitizeRGB( currentColor.div( safeAlbedo ) );

				// Defaults = fresh sample (no temporal blend).
				const demodResult = vec4( currentLighting, 1.0 ).toVar();
				const modulatedResult = vec4( currentColor, currentAlpha ).toVar();

				// forceResetU skips the blend for one frame after asvgf:reset → re-anchors
				// history to the current (post-reset) scene instead of the stale ping-pong.
				If( temporalEnabledU.greaterThan( 0.5 ).and( forceResetU.lessThan( 0.5 ) ), () => {

					const motion = textureLoad( motionTex, coord );
					const motionValid = motion.w.greaterThan( 0.5 );

					const prevXf = float( gx ).sub( motion.x.mul( resW ) );
					const prevYf = float( gy ).sub( motion.y.mul( resH ) );
					// Upper bound is the inclusive last pixel (< res, not < res-1): the 2×2 taps
					// already clamp to [0,res-1] and wSum gates bad taps, so res-1 wrongly
					// rejected the trailing column/row. Matches MotionVector's inclusive UV.
					const prevOnScreen = prevXf.greaterThanEqual( 0.0 )
						.and( prevXf.lessThan( float( resW ) ) )
						.and( prevYf.greaterThanEqual( 0.0 ) )
						.and( prevYf.lessThan( float( resH ) ) );

					If( motionValid.and( prevOnScreen ), () => {

						const ndCurrent = textureLoad( ndTex, coord );
						const nCurrent = ndCurrent.xyz.mul( 2.0 ).sub( 1.0 );
						const depthCurrent = ndCurrent.w;

						const x0 = int( prevXf );
						const y0 = int( prevYf );
						const x1 = x0.add( int( 1 ) );
						const y1 = y0.add( int( 1 ) );
						const fx = prevXf.sub( float( x0 ) );
						const fy = prevYf.sub( float( y0 ) );

						const x0c = x0.clamp( int( 0 ), int( resW ).sub( 1 ) );
						const x1c = x1.clamp( int( 0 ), int( resW ).sub( 1 ) );
						const y0c = y0.clamp( int( 0 ), int( resH ).sub( 1 ) );
						const y1c = y1.clamp( int( 0 ), int( resH ).sub( 1 ) );

						const w00 = float( 1.0 ).sub( fx ).mul( float( 1.0 ).sub( fy ) );
						const w10 = fx.mul( float( 1.0 ).sub( fy ) );
						const w01 = float( 1.0 ).sub( fx ).mul( fy );
						const w11 = fx.mul( fy );

						// SVGF soft per-tap weight: bilinear × normal × depth
						// (prev-frame normalDepth, geometric normals — stable).
						const tapValid = ( xi, yi, bilinearW ) => {

							const prevND = textureLoad( prevNDTex, ivec2( xi, yi ) );
							const nPrev = prevND.xyz.mul( 2.0 ).sub( 1.0 );
							const depthPrev = prevND.w;
							const normalDot = dot( nCurrent, nPrev ).clamp( 0.0, 1.0 );
							const normalW = pow( normalDot, float( NORMAL_POWER ) );
							const depthDelta = abs( depthCurrent.sub( depthPrev ) )
								.div( max( depthCurrent, float( 0.001 ) ) );
							const depthW = exp( depthDelta.div( float( DEPTH_SIGMA ) ).negate() );
							return bilinearW.mul( normalW ).mul( depthW );

						};

						const v00 = tapValid( x0c, y0c, w00 );
						const v10 = tapValid( x1c, y0c, w10 );
						const v01 = tapValid( x0c, y1c, w01 );
						const v11 = tapValid( x1c, y1c, w11 );

						const wSum = v00.add( v10 ).add( v01 ).add( v11 );

						If( wSum.greaterThan( float( VALIDITY_THRESHOLD ) ), () => {

							const p00 = textureLoad( prevTemporalTex, ivec2( x0c, y0c ) );
							const p10 = textureLoad( prevTemporalTex, ivec2( x1c, y0c ) );
							const p01 = textureLoad( prevTemporalTex, ivec2( x0c, y1c ) );
							const p11 = textureLoad( prevTemporalTex, ivec2( x1c, y1c ) );

							const invWSum = float( 1.0 ).div( wSum );
							const prevLighting = p00.xyz.mul( v00 )
								.add( p10.xyz.mul( v10 ) )
								.add( p01.xyz.mul( v01 ) )
								.add( p11.xyz.mul( v11 ) )
								.mul( invWSum );

							const prevHistory = p00.w.mul( v00 )
								.add( p10.w.mul( v10 ) )
								.add( p01.w.mul( v01 ) )
								.add( p11.w.mul( v11 ) )
								.mul( invWSum );

							// adaptive α — gradient·gradientStrength boosts toward 1 on change.
							const gradient = textureLoad( gradientTex, coord ).x;
							const adaptiveBoost = gradient.mul( gradientStrength ).clamp( 0.0, 1.0 );

							const baseAlpha = max(
								float( 1.0 ).div( prevHistory.add( 1.0 ) ),
								temporalAlphaMin
							);
							const effectiveAlpha = mix( baseAlpha, float( 1.0 ), adaptiveBoost );

							// Sanitize the blend too: a NaN already baked into prevLighting
							// would otherwise survive mix() and re-poison the write target.
							const blendedLighting = sanitizeRGB( mix( prevLighting, currentLighting, effectiveAlpha ) );
							const newHistory = min( prevHistory.add( 1.0 ), maxAccumFrames );

							demodResult.assign( vec4( blendedLighting, newHistory ) );
							modulatedResult.assign( vec4( blendedLighting.mul( safeAlbedo ), currentAlpha ) );

						} );

					} );

				} );

				textureStore(
					writeTemporalTex,
					uvec2( uint( gx ), uint( gy ) ),
					demodResult
				).toWriteOnly();

				textureStore(
					outputModulatedTex,
					uvec2( uint( gx ), uint( gy ) ),
					modulatedResult
				).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	_buildHeatmapCompute() {

		const rawColorTex = this._heatmapRawColorTexNode;
		const colorTex = this._heatmapColorTexNode;
		const temporalTex = this._heatmapTemporalTexNode;
		const ndTex = this._heatmapNDTexNode;
		const motionTex = this._heatmapMotionTexNode;
		const gradientTex = this._heatmapGradientTexNode;
		const heatmapOut = this._heatmapStorageTex;
		const mode = this.debugMode;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const result = vec4( 0.0, 0.0, 0.0, 1.0 ).toVar();

				// Chained If/ElseIf — separate If blocks let inactive-branch
				// texture samples contaminate the output.
				If( mode.equal( int( 0 ) ), () => {

					// 0: beauty (modulated ASVGF output)
					const c = textureLoad( colorTex, coord ).xyz;
					result.assign( vec4( c, 1.0 ) );

				} ).ElseIf( mode.equal( int( 1 ) ), () => {

					// 1: 3×3 luminance variance of raw PT input
					const meanLum = float( 0.0 ).toVar();
					const meanLumSq = float( 0.0 ).toVar();

					for ( let dy = - 1; dy <= 1; dy ++ ) {

						for ( let dx = - 1; dx <= 1; dx ++ ) {

							const sx = gx.add( dx ).clamp( int( 0 ), int( resW ).sub( 1 ) );
							const sy = gy.add( dy ).clamp( int( 0 ), int( resH ).sub( 1 ) );
							const s = textureLoad( rawColorTex, ivec2( sx, sy ) ).xyz;
							const lum = luminance( s );
							meanLum.addAssign( lum );
							meanLumSq.addAssign( lum.mul( lum ) );

						}

					}

					meanLum.divAssign( 9.0 );
					meanLumSq.divAssign( 9.0 );
					const variance = max( meanLumSq.sub( meanLum.mul( meanLum ) ), float( 0.0 ) );
					// Normalise by mean for HDR, scale to [0,1] for ramp.
					const relVar = variance.div( max( meanLum.mul( meanLum ), float( 0.0001 ) ) );
					const t = relVar.mul( 10.0 ).clamp( 0.0, 1.0 );

					// blue → cyan → green → yellow → red
					const r = t.sub( 0.5 ).mul( 4.0 ).clamp( 0.0, 1.0 );
					const g = t.mul( 4.0 ).clamp( 0.0, 1.0 ).sub(
						t.sub( 0.75 ).mul( 4.0 ).clamp( 0.0, 1.0 )
					);
					const b = float( 1.0 ).sub( t.sub( 0.25 ).mul( 4.0 ).clamp( 0.0, 1.0 ) );
					result.assign( vec4( r, g, b, 1.0 ) );

				} ).ElseIf( mode.equal( int( 2 ) ), () => {

					// 2: history length
					const historyLength = textureLoad( temporalTex, coord ).w;
					const t = historyLength.div( 32.0 ).clamp( 0.0, 1.0 );
					result.assign( vec4( float( 1.0 ).sub( t ), t, float( 0.2 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 3 ) ), () => {

					// 3: motion vectors
					const motion = textureLoad( motionTex, coord );
					const mx = abs( motion.x ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const my = abs( motion.y ).mul( 100.0 ).clamp( 0.0, 1.0 );
					const magnitude = mx.add( my ).clamp( 0.0, 1.0 );
					result.assign( vec4( mx, my, magnitude.mul( 0.3 ), 1.0 ) );

				} ).ElseIf( mode.equal( int( 4 ) ), () => {

					// 4: normals
					const nd = textureLoad( ndTex, coord );
					result.assign( vec4( nd.xyz, 1.0 ) );

				} ).Else( () => {

					// 5: temporal-luminance gradient
					const grad = textureLoad( gradientTex, coord ).x;
					const t = grad.mul( 5.0 ).clamp( 0.0, 1.0 );
					result.assign( vec4( t, t.mul( 0.5 ), float( 1.0 ).sub( t ), 1.0 ) );

				} );

				textureStore(
					heatmapOut,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

			} );

		} );

		this._heatmapComputeNode = computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	setupEventListeners() {

		this.on( 'asvgf:reset', () => this.resetTemporalData() );

		this.on( 'asvgf:updateParameters', ( data ) => this.updateParameters( data ) );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( 'pathtracer:color' );
		const albedoTex = context.getTexture( 'pathtracer:albedo' );
		const normalDepthTex = context.getTexture( 'pathtracer:normalDepth' );
		// First frame fallback — alias current ND.
		const prevNormalDepthTex = context.getTexture( 'pathtracer:prevNormalDepth' )
			|| normalDepthTex;
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! colorTex ) return;

		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			// Compare against an active-size RT, not the fixed-2048 StorageTexture.
			if ( img.width !== this._outputRT.width ||
				img.height !== this._outputRT.height ) {

				this.setSize( img.width, img.height );

			}

		}

		this._colorTexNode.value = colorTex;
		if ( albedoTex ) this._albedoTexNode.value = albedoTex;
		if ( motionTex ) this._motionTexNode.value = motionTex;
		if ( normalDepthTex ) this._normalDepthTexNode.value = normalDepthTex;
		if ( prevNormalDepthTex ) this._prevNormalDepthTexNode.value = prevNormalDepthTex;

		const readTemporal = this.currentMoments === 0
			? this._temporalTexB : this._temporalTexA;
		const writeNode = this.currentMoments === 0
			? this._temporalNodeA : this._temporalNodeB;
		const writeTemporal = this.currentMoments === 0
			? this._temporalTexA : this._temporalTexB;

		// First-frame compile while StorageTexture-typed nodes still hold
		// EmptyTexture, so textureLoad codegen emits the required `level`
		// parameter. Binding StorageTextures only AFTER compile keeps the
		// codegen path correct (otherwise reads would return zero at runtime).
		if ( ! this._compiled ) {

			this.renderer.compute( this._gradientNode );
			this.renderer.compute( this._temporalNodeA );
			this.renderer.compute( this._temporalNodeB );
			this._compiled = true;

		}

		this._readTemporalTexNode.value = readTemporal;
		this._gradientReadTexNode.value = this._gradientStorageTex;

		// Skip the gradient dispatch when nothing consumes it. The temporal
		// pass reads gradientTex unconditionally but multiplies by
		// gradientStrength=0 → the stale prior frame's gradient texture is
		// fine (the result is zeroed out anyway).
		const needsGradient = this.gradientStrength.value > 0 || this.showHeatmap;
		if ( needsGradient ) {

			this.renderer.compute( this._gradientNode );

		}

		// One-shot fresh re-anchor after asvgf:reset, threaded through the SINGLE
		// writeNode dispatch (a dual-node warmup would alias the read target — see setSize).
		this.forceResetU.value = this._needsWarmReset ? 1.0 : 0.0;
		this.renderer.compute( writeNode );
		this._needsWarmReset = false;

		// Copy active region out of the over-allocated StorageTextures into
		// right-sized RTs; downstream stages UV-sample these.
		this._srcRegion.max.set( this.resW.value, this.resH.value );

		this.renderer.copyTextureToTexture( writeTemporal, this._demodulatedRT.texture, this._srcRegion );
		this.renderer.copyTextureToTexture( this._outputModulatedTex, this._outputRT.texture, this._srcRegion );
		if ( needsGradient ) {

			this.renderer.copyTextureToTexture( this._gradientStorageTex, this._gradientRT.texture, this._srcRegion );

		}

		context.setTexture( 'asvgf:demodulated', this._demodulatedRT.texture );
		context.setTexture( 'asvgf:output', this._outputRT.texture );
		context.setTexture( 'asvgf:gradient', this._gradientRT.texture );

		this.currentMoments = 1 - this.currentMoments;

		if ( this.showHeatmap ) {

			// Mode 0 needs modulated for direct display; mode 2 needs the
			// ping-pong's history length in alpha.
			this._heatmapRawColorTexNode.value = colorTex;
			this._heatmapColorTexNode.value = this._outputModulatedTex;
			this._heatmapTemporalTexNode.value = writeTemporal;
			if ( normalDepthTex ) this._heatmapNDTexNode.value = normalDepthTex;
			if ( motionTex ) this._heatmapMotionTexNode.value = motionTex;
			this._heatmapGradientTexNode.value = this._gradientStorageTex;

			this.renderer.compute( this._heatmapComputeNode );
			this._srcRegion.max.set( this.heatmapTarget.width, this.heatmapTarget.height );
			this.renderer.copyTextureToTexture( this._heatmapStorageTex, this.heatmapTarget.texture, this._srcRegion );

		}

	}

	setHeatmapEnabled( enabled ) {

		this.showHeatmap = enabled;

	}

	setTemporalEnabled( enabled ) {

		this.temporalEnabledU.value = enabled ? 1.0 : 0.0;

	}

	updateParameters( params ) {

		if ( ! params ) return;
		if ( params.temporalAlpha !== undefined ) this.temporalAlpha.value = params.temporalAlpha;
		if ( params.gradientStrength !== undefined ) this.gradientStrength.value = params.gradientStrength;
		if ( params.gradientSigmaScale !== undefined ) this.gradientSigmaScale.value = params.gradientSigmaScale;
		if ( params.gradientNoiseFloor !== undefined ) this.gradientNoiseFloor.value = params.gradientNoiseFloor;
		if ( params.maxAccumFrames !== undefined ) this.maxAccumFrames.value = params.maxAccumFrames;
		if ( params.debugMode !== undefined ) this.debugMode.value = params.debugMode;

	}

	resetTemporalData() {

		this.currentMoments = 0;
		// Re-anchor history on the next frame — the ping-pong textures still hold
		// pre-reset (wrong-scene) lighting + history count, which would otherwise blend in.
		this._needsWarmReset = true;

	}

	// Reserved-storage change (e.g. 4K toggle): recreate the MAX-preallocated StorageTextures at the new live
	// reserved size + rebuild all compute nodes in place. Same stage object, so refs/wiring stay valid. Fresh
	// build ⇒ the first-render warmup re-runs (no aliasing — the nodes are new, matching initial construction).
	reallocateReservedStorage() {

		this._gradientNode?.dispose();
		this._temporalNodeA?.dispose();
		this._temporalNodeB?.dispose();
		this._heatmapComputeNode?.dispose();
		this._temporalTexA?.dispose();
		this._temporalTexB?.dispose();
		this._outputModulatedTex?.dispose();
		this._gradientStorageTex?.dispose();
		this._heatmapStorageTex?.dispose();

		const mk = ( type, filter ) => {

			const t = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
			t.type = type; t.format = RGBAFormat; t.minFilter = filter; t.magFilter = filter;
			return t;

		};

		this._temporalTexA = mk( FloatType, LinearFilter );
		this._temporalTexB = mk( FloatType, LinearFilter );
		this._outputModulatedTex = mk( FloatType, LinearFilter );
		this._gradientStorageTex = mk( HalfFloatType, LinearFilter );
		this._heatmapStorageTex = mk( FloatType, NearestFilter );

		this._buildGradientCompute();
		this._buildTemporalCompute();
		this._buildHeatmapCompute();
		this._compiled = false;
		this.currentMoments = 0;
		this._needsWarmReset = true;

	}

	setSize( width, height ) {

		// StorageTextures stay at max alloc — see resize crash fix (three.js #33061).
		this._demodulatedRT.setSize( width, height );
		this._demodulatedRT.texture.needsUpdate = true;
		this._outputRT.setSize( width, height );
		this._outputRT.texture.needsUpdate = true;
		this._gradientRT.setSize( width, height );
		this._gradientRT.texture.needsUpdate = true;
		this.heatmapTarget.setSize( width, height );
		this.heatmapTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._gradientNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._temporalNodeA.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._temporalNodeB.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._heatmapComputeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		// StorageTextures are over-allocated (never reallocated on resize), so the
		// compute kernels stay valid — do NOT reset _compiled. Re-running the warmup
		// would dispatch both temporal ping-pong nodes while _readTemporalTexNode still
		// aliases one node's write target, producing a "write-only storage +
		// TextureBinding in same synchronization scope" validation error.

	}

	reset() {

		// No-op: motion vectors handle camera moves; explicit asvgf:reset
		// clears history on scene/mode change.

	}

	// Free the over-allocated 2048² StorageTextures' GPU memory when the stage is disabled, so toggling
	// the denoiser off reclaims VRAM. The JS texture objects + compiled compute nodes are kept; three.js
	// lazily re-creates each GPUTexture on the next dispatch after re-enable. History re-anchors via the
	// warm reset (the RTs are render-res, not 2048² — left alone).
	releaseGPUMemory() {

		this._temporalTexA?.dispose();
		this._temporalTexB?.dispose();
		this._outputModulatedTex?.dispose();
		this._gradientStorageTex?.dispose();
		this._heatmapStorageTex?.dispose();
		// Render-res RT textures (sized to render resolution → meaningful VRAM at high res). Dispose the
		// .texture, not the RenderTarget (RT.dispose() doesn't free the backing GPUTexture here); these RTs
		// are copyTextureToTexture targets, so three.js reallocates on the next dispatch after re-enable.
		// Drop the published context outputs first so the Compositor fallback (reads asvgf:output) can't
		// sample a freed texture; render() re-publishes on re-enable.
		this.context?.removeTexture( 'asvgf:demodulated' );
		this.context?.removeTexture( 'asvgf:output' );
		this.context?.removeTexture( 'asvgf:gradient' );
		this._demodulatedRT?.texture?.dispose();
		this._outputRT?.texture?.dispose();
		this._gradientRT?.texture?.dispose();
		this.heatmapTarget?.texture?.dispose();
		this.resetTemporalData();

	}

	dispose() {

		this._gradientNode?.dispose();
		this._temporalNodeA?.dispose();
		this._temporalNodeB?.dispose();
		this._temporalTexA?.dispose();
		this._temporalTexB?.dispose();
		this._outputModulatedTex?.dispose();
		this._gradientStorageTex?.dispose();
		this._demodulatedRT?.dispose();
		this._outputRT?.dispose();
		this._gradientRT?.dispose();
		this._heatmapComputeNode?.dispose();
		this._heatmapStorageTex?.dispose();
		this.heatmapTarget?.dispose();

		this._colorTexNode?.dispose();
		this._albedoTexNode?.dispose();
		this._motionTexNode?.dispose();
		this._normalDepthTexNode?.dispose();
		this._prevNormalDepthTexNode?.dispose();
		this._readTemporalTexNode?.dispose();
		this._gradientReadTexNode?.dispose();

		this._heatmapRawColorTexNode?.dispose();
		this._heatmapColorTexNode?.dispose();
		this._heatmapTemporalTexNode?.dispose();
		this._heatmapNDTexNode?.dispose();
		this._heatmapMotionTexNode?.dispose();
		this._heatmapGradientTexNode?.dispose();

	}

}
