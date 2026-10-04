import { Fn, wgslFn, vec4, float, int, uint, ivec2, uvec2, uniform, If, max,
	textureLoad, textureStore, workgroupBarrier, localId, workgroupId,
	attributeArray, atomicAdd, atomicStore, atomicLoad, Loop } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture, ReadbackBuffer } from 'three/webgpu';
import { FloatType, RGBAFormat, NearestFilter } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { luminance } from '../TSL/Common.js';

// ── Histogram constants ────────────────────────────────────
export const AUTO_EXPOSURE_DEFAULTS = {
	autoExposure: false,
	autoExposureKeyValue: 0.18,
	autoExposureMinExposure: 0.1,
	autoExposureMaxExposure: 20.0,
	autoExposureAdaptSpeedBright: 3.0,
	autoExposureAdaptSpeedDark: 0.5,
};

const NUM_BINS = 256;
const MIN_LOG_LUM = - 8.0; // ln(~0.00034)  — very dark
const MAX_LOG_LUM = 6.0; // ln(~403)     — bright specular
const LOG_LUM_RANGE = MAX_LOG_LUM - MIN_LOG_LUM; // 14 nats ≈ 20 stops
const BIN_WIDTH = LOG_LUM_RANGE / NUM_BINS;
const WEIGHT_SCALE = 10000; // float → uint quantisation for metering weights

// ── Metering ────────────────────────────────────────────────
// Centre-weighted Gaussian is the only mode — spot and uniform
// are unnecessary given the percentile clipping already handles
// extreme highlights/shadows. The centerWeight uniform controls
// the Gaussian falloff steepness.

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Temporal adaptation: map luminance → target exposure, smooth asymmetrically.
 *
 * Returns vec4f(exposure, luminance, targetExposure, 1.0).
 */
const adaptExposure = /*@__PURE__*/ wgslFn( `
	fn adaptExposure(
		geoMean: f32,
		prevExposure: f32,
		keyValue: f32,
		minExp: f32,
		maxExp: f32,
		speedBright: f32,
		speedDark: f32,
		dt: f32,
		isFirstFrame: f32
	) -> vec4f {

		let targetExp = clamp( keyValue / max( geoMean, 0.001 ), minExp, maxExp );
		var newExposure = targetExp;

		// Temporal smoothing (skip on first frame)
		if ( isFirstFrame < 0.5 ) {

			// Asymmetric speed: brighter scenes adapt faster
			let speed = select( speedDark, speedBright, targetExp < prevExposure );
			let alpha = 1.0 - exp( -dt * speed );
			newExposure = mix( prevExposure, targetExp, alpha );

		}

		return vec4f( newExposure, geoMean, targetExp, 1.0 );

	}
` );

/**
 * WebGPU Auto-Exposure Stage — Histogram-Based with Centre-Weighted Metering
 *
 * GPU-based automatic exposure control with human eye-like adaptation.
 * Uses histogram-based luminance analysis with percentile clipping
 * and centre-weighted spatial metering for robust exposure estimation.
 *
 * Algorithm:
 *   1. Downsample (compute): full res → 64×64 log-luminance grid
 *   2. Histogram (compute): build 256-bin weighted histogram from the 64×64
 *      grid. Single workgroup of 256 threads; each loads 16 texels, applies
 *      centre-weighted Gaussian, and scatters via atomicAdd into a storage buffer.
 *   3. Analyze (compute): single thread reads the histogram, computes CDF,
 *      extracts percentile-clipped weighted mean (ignoring bottom/top
 *      extremes), and writes the geometric mean to a 1×1 storage texture.
 *   4. Adaptation (compute): temporal smoothing with prev exposure; writes
 *      vec4(exposure, luminance, targetExposure, 1) into a 1-element buffer.
 *   5. Async readback via `renderer.getArrayBufferAsync(attr, ReadbackBuffer)`.
 *
 * Execution: ALWAYS
 *
 * Events listened:
 *   pipeline:reset              — soft reset (keeps the exposure, discards an in-flight readback)
 *   pipeline:lightingChanged    — a new model or environment: start the exposure history over
 *
 * Textures published:  (none — publishes state, not textures)
 * Textures read:       edgeFiltering:output > asvgf:output > pathtracer:color
 * State published:     autoexposure:value, autoexposure:avgLuminance
 */
export class AutoExposure extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'AutoExposure', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// Reduction constant
		this.REDUCTION_SIZE = 64;

		// ── Adaptation uniforms ──────────────────────────

		this.keyValueU = uniform( options.keyValue ?? AUTO_EXPOSURE_DEFAULTS.autoExposureKeyValue );
		this.minExposureU = uniform( options.minExposure ?? AUTO_EXPOSURE_DEFAULTS.autoExposureMinExposure );
		this.maxExposureU = uniform( options.maxExposure ?? AUTO_EXPOSURE_DEFAULTS.autoExposureMaxExposure );
		this.adaptSpeedBrightU = uniform( options.adaptSpeedBright ?? AUTO_EXPOSURE_DEFAULTS.autoExposureAdaptSpeedBright );
		this.adaptSpeedDarkU = uniform( options.adaptSpeedDark ?? AUTO_EXPOSURE_DEFAULTS.autoExposureAdaptSpeedDark );
		this.epsilonU = uniform( options.epsilon ?? 0.0001 );
		this.deltaTimeU = uniform( 1.0 / 60.0 );
		this.isFirstFrameU = uniform( 1.0 ); // 1.0 = true
		this.previousExposureU = uniform( options.initialExposure ?? 1.0 );

		// ── Histogram & metering uniforms ────────────────

		this.lowPercentileU = uniform( options.lowPercentile ?? 0.10 );
		this.highPercentileU = uniform( options.highPercentile ?? 0.90 );
		this.centerWeightU = uniform( options.centerWeight ?? 8.0 );

		// ── Input resolution uniforms (for downsample compute) ──

		this.inputResW = uniform( 1 );
		this.inputResH = uniform( 1 );

		// ── Input texture nodes (swap .value, no recompile) ──

		this._inputTexNode = new TextureNode();
		this._reductionReadTexNode = new TextureNode();

		// ── CPU-side state ───────────────────────────────

		this.currentExposure = options.initialExposure ?? 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this.isFirstFrame = true;
		this._pendingReadback = false;
		this._readbackGeneration = 0;

		// ── Render targets & storage textures ────────────

		this._initRenderTargets();
		this._buildCompute();

	}

	_initRenderTargets() {

		const rtOpts = {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};

		// Downsample RenderTarget (64×64) — copy destination from compute StorageTexture
		this._downsampleTarget = new RenderTarget( this.REDUCTION_SIZE, this.REDUCTION_SIZE, rtOpts );

		// Downsample StorageTexture (64×64) — compute writes here
		this._downsampleStorageTex = new StorageTexture( this.REDUCTION_SIZE, this.REDUCTION_SIZE );
		this._downsampleStorageTex.type = FloatType;
		this._downsampleStorageTex.format = RGBAFormat;
		this._downsampleStorageTex.minFilter = NearestFilter;
		this._downsampleStorageTex.magFilter = NearestFilter;

		// 1×1 StorageTexture for histogram analysis output
		this._reductionStorageTex = new StorageTexture( 1, 1 );
		this._reductionStorageTex.type = FloatType;
		this._reductionStorageTex.format = RGBAFormat;
		this._reductionStorageTex.minFilter = NearestFilter;
		this._reductionStorageTex.magFilter = NearestFilter;

		// 1×1 RenderTarget — readable copy of analysis output (cross-dispatch reads
		// from StorageTexture return zeros — must copy to RenderTarget first)
		this._reductionReadTarget = new RenderTarget( 1, 1, rtOpts );

		// Adaptation result — 1×vec4 storage buffer attribute. Compute writes
		// vec4(exposure, luminance, targetExposure, 1) here; CPU reads via
		// getArrayBufferAsync + a pooled ReadbackBuffer (16 bytes).
		this._adaptationResult = attributeArray( 1, 'vec4' );
		this._readbackBuffer = new ReadbackBuffer( 16 );
		this._readbackBuffer.name = 'AutoExposureAdaptation';

		// ── Histogram storage buffer (atomic uint, 256 bins) ─────
		this._histogramBuffer = attributeArray( NUM_BINS, 'uint' ).toAtomic();

	}

	// ──────────────────────────────────────────────────
	// TSL shader builders
	// ──────────────────────────────────────────────────

	_buildCompute() {

		this._buildDownsampleCompute();
		this._buildHistogramCompute();
		this._buildHistogramAnalyzeCompute();
		this._buildAdaptationCompute();

	}

	/**
	 * Downsample (compute): full resolution → 64×64
	 *
	 * Dispatch: [8, 8, 1] workgroups of [8, 8, 1] = 64×64 threads total.
	 * Each thread (one output pixel) samples a NxN grid from the input texture.
	 *
	 * Output: R = Σ log(L + ε), G = valid pixel count
	 */
	_buildDownsampleCompute() {

		const inputTex = this._inputTexNode;
		const outputTex = this._downsampleStorageTex;
		const epsilon = this.epsilonU;
		const resW = this.inputResW;
		const resH = this.inputResH;

		const SAMPLES = 4;
		const OUT_SIZE = 64;
		const WG_SIZE = 8;

		const computeFn = Fn( () => {

			// Global thread ID → output pixel coordinate
			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			// Block size in input pixels: how many input pixels each output pixel covers
			const blockW = resW.div( float( OUT_SIZE ) );
			const blockH = resH.div( float( OUT_SIZE ) );

			// Block origin in input pixel space
			const blockOriginX = float( gx ).mul( blockW );
			const blockOriginY = float( gy ).mul( blockH );

			const logLumSum = float( 0.0 ).toVar();
			const validCount = float( 0.0 ).toVar();

			// Sample a SAMPLES×SAMPLES grid within the block
			for ( let sy = 0; sy < SAMPLES; sy ++ ) {

				for ( let sx = 0; sx < SAMPLES; sx ++ ) {

					// Offset within block: (sx+0.5)/SAMPLES normalised to block size
					const inputX = int( blockOriginX.add( float( ( sx + 0.5 ) / SAMPLES ).mul( blockW ) ) );
					const inputY = int( blockOriginY.add( float( ( sy + 0.5 ) / SAMPLES ).mul( blockH ) ) );

					const sample = textureLoad( inputTex, ivec2( inputX, inputY ) );
					const lum = luminance( sample.xyz );

					If( lum.greaterThan( epsilon ), () => {

						logLumSum.addAssign( lum.add( epsilon ).log() );
						validCount.addAssign( 1.0 );

					} );

				}

			}

			textureStore(
				outputTex,
				uvec2( uint( gx ), uint( gy ) ),
				vec4( logLumSum, validCount, 0.0, 1.0 )
			).toWriteOnly();

		} );

		this._downsampleComputeNode = computeFn().compute(
			[ OUT_SIZE / WG_SIZE, OUT_SIZE / WG_SIZE, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	/**
	 * Histogram Build (compute): 64×64 downsample → 256-bin weighted histogram
	 *
	 * Single workgroup of 256 threads. Each thread processes 16 texels from
	 * the downsample grid, applies spatial metering weight, and atomically
	 * scatters into the histogram storage buffer.
	 *
	 * Phase 1: Clear all 256 bins (one per thread)
	 * Phase 2: Build histogram with metering-weighted atomic scatter
	 */
	_buildHistogramCompute() {

		const downsampleTex = this._downsampleTarget.texture;
		const histogram = this._histogramBuffer;
		const centerWeight = this.centerWeightU;

		const WGSIZE = 256;
		const TEXELS_PER_THREAD = 16; // 4096 / 256
		const TEX_SIZE = 64;

		const computeFn = Fn( () => {

			const tid = localId.x;

			// ── Phase 1: Clear histogram ──────────────────
			atomicStore( histogram.element( tid ), uint( 0 ) );
			workgroupBarrier();

			// ── Phase 2: Build histogram ──────────────────
			for ( let t = 0; t < TEXELS_PER_THREAD; t ++ ) {

				const linearIdx = tid.mul( TEXELS_PER_THREAD ).add( t );
				const px = linearIdx.mod( TEX_SIZE );
				const py = linearIdx.div( TEX_SIZE );

				const data = textureLoad( downsampleTex, ivec2( int( px ), int( py ) ) );
				const logLumSum = data.x;
				const validCount = data.y;

				If( validCount.greaterThan( 0.0 ), () => {

					// Per-cell average log-luminance (natural log, matches downsample output)
					const avgLogLum = logLumSum.div( validCount );

					// Map to histogram bin [0, NUM_BINS-1]
					const normalized = avgLogLum.sub( float( MIN_LOG_LUM ) ).div( float( LOG_LUM_RANGE ) );
					const bin = uint( normalized.mul( float( NUM_BINS ) ).floor().clamp( 0.0, float( NUM_BINS - 1 ) ) );

					// ── Centre-weighted metering ──────────
					const uvx = float( px ).add( 0.5 ).div( float( TEX_SIZE ) );
					const uvy = float( py ).add( 0.5 ).div( float( TEX_SIZE ) );
					const dx = uvx.sub( 0.5 );
					const dy = uvy.sub( 0.5 );
					const dist2 = dx.mul( dx ).add( dy.mul( dy ) );

					// Gaussian falloff: 1.0 at centre, ~0.02 at corners
					const weight = dist2.mul( centerWeight ).negate().exp();

					const weightUint = uint( weight.mul( float( WEIGHT_SCALE ) ) );
					atomicAdd( histogram.element( bin ), weightUint );

				} );

			}

		} );

		this._histogramComputeNode = computeFn().compute( [ 1, 1, 1 ], [ WGSIZE, 1, 1 ] );

	}

	/**
	 * Histogram Analysis (compute): extract percentile-clipped geometric mean
	 *
	 * Single thread. Reads the 256-bin histogram, computes the CDF, clips
	 * the bottom and top percentiles, and computes the weighted geometric
	 * mean of luminance within the accepted range.
	 *
	 * Output: StorageTexture(1×1) = vec4(geometricMean, totalCount, avgLogLum, 1)
	 */
	_buildHistogramAnalyzeCompute() {

		const histogram = this._histogramBuffer;
		const outputTex = this._reductionStorageTex;
		const lowPercentile = this.lowPercentileU;
		const highPercentile = this.highPercentileU;

		const computeFn = Fn( () => {

			// ── Pass 1: compute total weight ──────────────
			const totalWeight = float( 0.0 ).toVar();

			Loop( NUM_BINS, ( { i } ) => {

				totalWeight.addAssign( float( atomicLoad( histogram.element( i ) ) ) );

			} );

			// Percentile thresholds (in quantised weight units)
			const lowThreshold = totalWeight.mul( lowPercentile );
			const highThreshold = totalWeight.mul( highPercentile );

			// ── Pass 2: percentile-clipped weighted mean ──
			const cumWeight = float( 0.0 ).toVar();
			const logLumAccum = float( 0.0 ).toVar();
			const validWeight = float( 0.0 ).toVar();
			const prevCum = float( 0.0 ).toVar();

			Loop( NUM_BINS, ( { i } ) => {

				const binWeight = float( atomicLoad( histogram.element( i ) ) );
				prevCum.assign( cumWeight );
				cumWeight.addAssign( binWeight );

				// Include bin if it overlaps the [lowThreshold, highThreshold] range
				If( prevCum.lessThan( highThreshold ).and( cumWeight.greaterThan( lowThreshold ) ), () => {

					// Bin centre in log-luminance space
					const binCenter = float( MIN_LOG_LUM ).add(
						float( i ).add( 0.5 ).mul( float( BIN_WIDTH ) )
					);
					logLumAccum.addAssign( binCenter.mul( binWeight ) );
					validWeight.addAssign( binWeight );

				} );

			} );

			const safeWeight = max( validWeight, float( 1.0 ) );
			const avgLogLum = logLumAccum.div( safeWeight );
			const geometricMean = avgLogLum.exp();

			textureStore(
				outputTex,
				uvec2( uint( 0 ), uint( 0 ) ),
				vec4( geometricMean, totalWeight, avgLogLum, 1.0 )
			).toWriteOnly();

		} );

		this._histogramAnalyzeNode = computeFn().compute( 1, [ 1, 1, 1 ] );

	}

	/**
	 * Adaptation (compute): temporal smoothing
	 *
	 * Single-thread compute dispatch [1, 1, 1], workgroup [1, 1, 1].
	 * Reads geometric mean from analysis RenderTarget, applies asymmetric
	 * temporal smoothing using the previous-exposure uniform, and writes
	 * vec4(exposure, luminance, targetExposure, 1) into a 1-element storage
	 * buffer which the CPU reads via getArrayBufferAsync + ReadbackBuffer.
	 */
	_buildAdaptationCompute() {

		const reductionTex = this._reductionReadTexNode;
		const resultBuf = this._adaptationResult;
		const keyValue = this.keyValueU;
		const minExp = this.minExposureU;
		const maxExp = this.maxExposureU;
		const speedBright = this.adaptSpeedBrightU;
		const speedDark = this.adaptSpeedDarkU;
		const dt = this.deltaTimeU;
		const isFirst = this.isFirstFrameU;
		const prevExposure = this.previousExposureU;

		const computeFn = Fn( () => {

			// Read geometric mean from histogram analysis result (1×1 RenderTarget)
			const geoMean = textureLoad( reductionTex, ivec2( int( 0 ), int( 0 ) ) ).x;

			const result = adaptExposure(
				geoMean, prevExposure, keyValue,
				minExp, maxExp, speedBright, speedDark,
				dt, isFirst
			);

			resultBuf.element( uint( 0 ) ).assign( result );

		} );

		this._adaptationComputeNode = computeFn().compute( 1, [ 1, 1, 1 ] );

	}

	// ──────────────────────────────────────────────────
	// Event listeners
	// ──────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this.reset() );
		this.on( 'pipeline:lightingChanged', () => this.resetHistory() );

	}

	// ──────────────────────────────────────────────────
	// Render
	// ──────────────────────────────────────────────────

	render( context ) {

		if ( ! this.enabled ) return;

		// Resolve input texture (fallback chain)
		const inputTex = context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );

		if ( ! inputTex ) return;

		// Delta time
		const now = performance.now();
		const dt = Math.min( ( now - this.lastTime ) / 1000, 0.1 );
		this.lastTime = now;
		this.deltaTimeU.value = this.isFirstFrame ? 1.0 : dt;
		this.isFirstFrameU.value = this.isFirstFrame ? 1.0 : 0.0;
		this.previousExposureU.value = this.currentExposure;

		// Update input resolution uniforms for downsample compute
		this.inputResW.value = inputTex.image?.width || 1;
		this.inputResH.value = inputTex.image?.height || 1;

		// ── Pass 1: Downsample full res → 64×64 (compute) ──

		this._inputTexNode.value = inputTex;
		this.renderer.compute( this._downsampleComputeNode );
		this.renderer.copyTextureToTexture( this._downsampleStorageTex, this._downsampleTarget.texture );

		// ── Pass 2: Histogram build (compute) ───────────────

		this.renderer.compute( this._histogramComputeNode );

		// ── Pass 3: Histogram analysis → 1×1 result ─────────

		this.renderer.compute( this._histogramAnalyzeNode );
		this.renderer.copyTextureToTexture( this._reductionStorageTex, this._reductionReadTarget.texture );

		// ── Pass 4: Temporal adaptation (compute) ───────────

		this._reductionReadTexNode.value = this._reductionReadTarget.texture;
		this.renderer.compute( this._adaptationComputeNode );

		// ── Async readback via pooled ReadbackBuffer ─────
		// getArrayBufferAsync reuses the ReadbackBuffer's internal staging
		// GPUBuffer across frames. ReadbackBuffer.release() must be called
		// before it can be reused — the _pendingReadback flag gates reentry.

		if ( ! this._pendingReadback ) {

			this._pendingReadback = true;
			const generation = this._readbackGeneration;

			this.renderer.getArrayBufferAsync(
				this._adaptationResult.value, this._readbackBuffer
			).then( ( readback ) => {

				// Copy the 4 floats out of the mapped buffer before release(),
				// because release() nulls readback.buffer and unmaps the GPU buffer.
				const data = readback && readback.buffer
					? new Float32Array( readback.buffer.slice( 0 ) )
					: null;
				this._readbackBuffer.release();
				this._pendingReadback = false;

				// Discard stale readback from before a reset
				if ( data && generation === this._readbackGeneration ) {

					this._applyReadback( data );

				}

			} ).catch( () => {

				try {

					this._readbackBuffer.release();

				} catch { /* buffer may not be mapped on error */ }

				this._pendingReadback = false;

			} );

		}

		// ── Publish state ────────────────────────────────

		context.setState( 'autoexposure:value', this.currentExposure );
		context.setState( 'autoexposure:avgLuminance', this.currentLuminance );

		this.emit( 'autoexposure:updated', {
			exposure: this.currentExposure,
			luminance: this.currentLuminance,
			targetExposure: this.targetExposure
		} );

		this.isFirstFrame = false;

	}

	/**
	 * Process async readback data from 1×1 adaptation target.
	 */
	_applyReadback( data ) {

		if ( ! this.enabled || ! data || data.length < 3 ) return;

		let exposure = data[ 0 ];
		let luminance = data[ 1 ];
		let targetExp = data[ 2 ];

		// Validate
		if ( ! isFinite( exposure ) || exposure <= 0 ) exposure = 1.0;
		if ( ! isFinite( luminance ) || luminance <= 0 ) luminance = 0.18;
		if ( ! isFinite( targetExp ) || targetExp <= 0 ) targetExp = exposure;

		this.currentExposure = exposure;
		this.currentLuminance = luminance;
		this.targetExposure = targetExp;

		// Apply to renderer
		this.renderer.toneMappingExposure = exposure;

	}

	// ──────────────────────────────────────────────────
	// Lifecycle
	// ──────────────────────────────────────────────────

	/**
	 * Soft reset: preserve exposure state, let temporal smoothing adapt.
	 * Called on pipeline:reset (camera moves, parameter changes).
	 */
	reset() {

		this.lastTime = performance.now();
		// Bump generation so any in-flight readback is discarded
		this._readbackGeneration ++;
		this._pendingReadback = false;

	}

	/**
	 * Hard reset: wipe exposure history for a clean start.
	 * Called on scene/environment changes where previous exposure is meaningless.
	 */
	resetHistory() {

		this.isFirstFrame = true;
		this.currentExposure = 1.0;
		this.currentLuminance = 0.18;
		this.targetExposure = 1.0;
		this.lastTime = performance.now();
		this._readbackGeneration ++;
		this._pendingReadback = false;

	}

	setSize( /* width, height */ ) {

		// Downsample and histogram targets are fixed-size (64×64 → 256 bins → 1×1)
		// No resizing needed — the downsample compute shader reads input
		// resolution from uniforms and computes block sizes dynamically.

	}

	setExposure( value ) {

		this.currentExposure = value;
		this.previousExposureU.value = value;
		this.renderer.toneMappingExposure = value;

	}

	getExposure() {

		return this.currentExposure;

	}

	getLuminance() {

		return this.currentLuminance;

	}

	updateParameters( params ) {

		if ( params.keyValue !== undefined ) this.keyValueU.value = params.keyValue;
		if ( params.minExposure !== undefined ) this.minExposureU.value = params.minExposure;
		if ( params.maxExposure !== undefined ) this.maxExposureU.value = params.maxExposure;
		if ( params.adaptSpeedBright !== undefined ) this.adaptSpeedBrightU.value = params.adaptSpeedBright;
		if ( params.adaptSpeedDark !== undefined ) this.adaptSpeedDarkU.value = params.adaptSpeedDark;
		if ( params.lowPercentile !== undefined ) this.lowPercentileU.value = params.lowPercentile;
		if ( params.highPercentile !== undefined ) this.highPercentileU.value = params.highPercentile;
		if ( params.centerWeight !== undefined ) this.centerWeightU.value = params.centerWeight;

	}

	dispose() {

		this._downsampleComputeNode?.dispose();
		this._histogramComputeNode?.dispose();
		this._histogramAnalyzeNode?.dispose();
		this._adaptationComputeNode?.dispose();
		this._downsampleTarget?.dispose();
		this._downsampleStorageTex?.dispose();
		this._reductionStorageTex?.dispose();
		this._reductionReadTarget?.dispose();
		this._readbackBuffer?.dispose();
		this._inputTexNode?.dispose();
		this._reductionReadTexNode?.dispose();

	}

}
