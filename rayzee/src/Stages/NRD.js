import { Fn, vec2, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, select, mix, max, min, dot, sqrt, exp2, pow, floor, fract, round, atan, normalize,
	saturate, smoothstep, textureLoad, textureStore, localId, workgroupId, Return } from 'three/tsl';
import { RenderTarget, TextureNode } from 'three/webgpu';
import { DataTexture, HalfFloatType, FloatType, RGBAFormat, LinearFilter, Matrix4, Vector2, Vector3, Vector4, Box2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { createStorageTexture } from '../Processor/StorageTexturePool.js';
import { sanitizeRGB, sanitize1, FP16_MAX } from '../TSL/Common.js';
import { cameraRayDirection } from '../TSL/CameraRay.js';
import {
	ALBEDO_EPS, GBUFFER_MISS_THRESHOLD as MISS_THRESHOLD, NRD_DEFAULTS,
	NRD_HIT_DIST_A, NRD_HIT_DIST_B,
} from '../EngineDefaults.js';

const NRD_EPS = 1e-6;
const NORMAL_ENCODING_ERROR = 1.5 / 255.0;
const ROUGHNESS_SENSITIVITY = 0.01;
const EXP_WEIGHT_SCALE = 3.0;
const HISTORY_FIX_RADIUS = 2;
const FAST_CLAMP_RADIUS = 2;
const ANTI_FIREFLY_RADIUS = 3; // NRD's performance-mode value; its default is 4

const ANTI_FIREFLY_SIGMA_SCALE = 2.0;
const FIREFLY_MAX_RELATIVE_INTENSITY = 38.0;
const FIREFLY_RADIUS_SCALE = 0.1;
const FIREFLY_FAST_RELATIVE_INTENSITY = 4.0;
const ALMOST_ZERO_ANGLE_COS = Math.cos( 89.0 * Math.PI / 180.0 );
const CATROM_SHARPNESS = 0.5;
const WG_SIZE = 16;

const PASS = {
	pre: { radiusScale: 1.0, fractionScale: 2.0 },
	blur: { radiusScale: 1.0, fractionScale: 1.0 },
	post: { radiusScale: 2.0, fractionScale: 0.5 },
};

// NRD g_Special8; .z scales the Gaussian weight.
const Q = 0.25 * Math.SQRT2;
const SPECIAL8 = [
	[ - 1.0, 0.0, 1.0 ], [ 0.0, 1.0, 1.0 ], [ 1.0, 0.0, 1.0 ], [ 0.0, - 1.0, 1.0 ],
	[ - Q, Q, 0.5 ], [ Q, Q, 0.5 ], [ Q, - Q, 0.5 ], [ - Q, - Q, 0.5 ],
];

// NRD ComputeNonExponentialWeight / ComputeExponentialWeight.
const weightSmooth = ( x, px, py ) => smoothstep( 0.0, 1.0, float( 1.0 ).sub( x.mul( px ).add( py ).abs() ) );
const weightExp = ( x, px, py ) => {

	const t = x.mul( px ).add( py ).abs().mul( - EXP_WEIGHT_SCALE );
	return float( 1.0 ).div( t.mul( t ).sub( t ).add( 1.0 ) );

};

const acosApproxPositive = ( x ) =>
	mix( float( 1.570796 ), float( 1.395402 ), saturate( x ) ).mul( sqrt( saturate( float( 1.0 ).sub( x ) ) ) );
const specMagicCurve = ( r, power ) =>
	float( 1.0 ).sub( exp2( r.mul( r ).mul( - 200.0 ) ) ).mul( pow( saturate( r ), power ) );
const lobeTanHalfAngle = ( r, percentOfVolume ) =>
	saturate( r ).mul( sqrt( percentOfVolume.div( float( 1.0 ).sub( percentOfVolume ).add( NRD_EPS ) ) ) );
const normalWeightParam = ( nonLinearAccumSpeed, lobeAngleFraction, roughness, maxPercentOfLobeVolume ) => {

	const pov = maxPercentOfLobeVolume.mul( mix( saturate( lobeAngleFraction ), float( 1.0 ), nonLinearAccumSpeed ) );
	const angle = max( atan( lobeTanHalfAngle( roughness, pov ) ), float( NORMAL_ENCODING_ERROR ) );
	return float( 1.0 ).div( angle );

};

const roughnessWeightParams = ( roughness, fraction ) => {

	const a = float( 1.0 ).div( mix( float( ROUGHNESS_SENSITIVITY ), float( 1.0 ), saturate( roughness.mul( fraction ) ) ) );
	return vec2( a, roughness.mul( a ).negate() );

};

const relaxedRoughnessWeightParams = ( m, fraction, sensitivity ) => {

	const a = float( 1.0 ).div( mix( float( sensitivity ), float( 1.0 ), mix( m.mul( m ), m, saturate( fraction ) ) ) );
	return vec2( a, m.mul( a ).negate() );

};

const hitDistWeightParams = ( normHitDist, nonLinearAccumSpeed ) => {

	const a = float( 1.0 ).div( nonLinearAccumSpeed );
	return vec2( a, normHitDist.mul( a ).negate() );

};

const geometryWeightParams = ( sensitivity, frustumSize, X, N ) => {

	const a = float( 1.0 ).div( sensitivity.mul( frustumSize ) );
	return vec2( a, dot( N, X ).mul( a ).negate() );

};

const mirrorUv = ( uv ) =>
	vec2( 1.0 ).sub( vec2( 1.0 ).sub( fract( uv.mul( 0.5 ) ).mul( 2.0 ) ).abs() ).min( 0.99999 );
const linearToYCoCg = ( c ) => vec3(
	dot( c, vec3( 0.25, 0.5, 0.25 ) ),
	dot( c, vec3( 0.5, 0.0, - 0.5 ) ),
	dot( c, vec3( - 0.25, 0.5, - 0.25 ) )
);
const yCoCgToLinear = ( c ) => {

	const t = c.x.sub( c.z );
	return max( vec3( t.add( c.y ), c.x.add( c.z ), t.sub( c.y ) ), vec3( 0.0 ) );

};

const lumaScale = ( current, next ) => next.add( NRD_EPS ).div( current.add( NRD_EPS ) );
const changeLuma = ( v, newLuma ) => vec4( v.xyz.mul( lumaScale( v.x, newLuma ) ), v.w );
const clampNegativeToZero = ( v ) => vec4( linearToYCoCg( yCoCgToLinear( v.xyz ) ), saturate( v.w ) );
const stdDev = ( m1, m2 ) => sqrt( m2.sub( m1.mul( m1 ) ).abs() );
// rotator = (cos, sin, -sin, cos)
const rotate2 = ( rot, v ) => vec2( rot.x.mul( v.x ).add( rot.y.mul( v.y ) ), rot.z.mul( v.x ).add( rot.w.mul( v.y ) ) );
const denanify = ( w, s ) => select( w.equal( 0.0 ), vec4( 0.0 ), s );

function hash01( n ) {

	let x = Math.imul( n | 0, 0x9E3779B1 ) >>> 0;
	x ^= x >>> 15; x = Math.imul( x, 0x85EBCA6B ) >>> 0;
	x ^= x >>> 13; x = Math.imul( x, 0xC2B2AE35 ) >>> 0;
	x ^= x >>> 16;
	return x / 4294967296;

}

/**
 * NRD — port of NVIDIA Real-Time Denoisers' ReBLUR to TSL compute. Six passes per frame, as in
 * nrd::REBLUR_DIFFUSE: PrePass → TemporalAccumulation → HistoryFix → Blur → PostBlur →
 * TemporalStabilization. Internal signal is NRD's own: YCoCg demodulated lighting + normalized
 * hit distance. See docs/NRD_DENOISER.md for the deviations from NRD and the measured ratios.
 *
 * Reads:     pathtracer:color, pathtracer:albedo (.w = normHitDist), pathtracer:normalDepth,
 *            pathtracer:shadingNormal (.w = roughness), motionVector:screenSpace
 * Publishes: nrd:output
 * Events:    denoiser:reset
 */
export class NRD extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'NRD', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;
		this.pathTracer = options.pathTracer || null;
		this.settings = { ...NRD_DEFAULTS, ...( options.settings || {} ) };

		const w = options.width || 1;
		const h = options.height || 1;

		this.resW = uniform( w );
		this.resH = uniform( h );
		this.minRectDimMulUnproject = uniform( 1.0 );
		this.inputFrames = uniform( 0.0 );
		this.resetU = uniform( 0.0 );
		this.debugMode = uniform( 0, 'int' );

		this.rotPre = uniform( new Vector4( 1, 0, 0, 1 ), 'vec4' );
		this.rotBlur = uniform( new Vector4( 1, 0, 0, 1 ), 'vec4' );
		this.rotPost = uniform( new Vector4( 1, 0, 0, 1 ), 'vec4' );

		this.camWorld = uniform( new Matrix4(), 'mat4' );
		this.camProjInv = uniform( new Matrix4(), 'mat4' );
		this.camView = uniform( new Matrix4(), 'mat4' );
		this.prevCamView = uniform( new Matrix4(), 'mat4' );
		this.camPos = uniform( new Vector3(), 'vec3' );
		this.prevCamPos = uniform( new Vector3(), 'vec3' );
		this.cameraProjection = uniform( 0, 'int' );
		this.panoLonRange = uniform( new Vector2(), 'vec2' );
		this.panoLatRange = uniform( new Vector2(), 'vec2' );
		this.panoLevelHorizon = uniform( 1, 'int' );

		// Declared here, valued by _syncUniforms below — which is the only place a setting becomes a
		// uniform, so there is no second copy of the defaults to keep in step.
		this.u = {};
		for ( const name of [
			'maxAccum', 'maxFast', 'stabilizationStrength', 'historyFixFrameNum', 'historyFixStride',
			'prepassBlurRadius', 'minBlurRadius', 'maxBlurRadius', 'lobeAngleFraction', 'roughnessFraction',
			'planeDistSensitivity', 'minHitDistanceWeight', 'fastClampSigmaScale', 'fireflyMinRelativeScale',
			'antiFirefly', 'disocclusionThreshold', 'lobeVolumePercent', 'handoverFrames',
		] ) this.u[ name ] = uniform( 0.0 );
		this.u.antilag = uniform( new Vector2(), 'vec2' );
		this.u.convergence = uniform( new Vector3(), 'vec3' );
		this._syncUniforms();

		this._colorTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._ndTexNode = new TextureNode();
		this._snTexNode = new TextureNode();
		this._motionTexNode = new TextureNode();

		// Each deferred StorageTexture read needs its OWN sampled placeholder: TSL shares texture bindings
		// by uuid, so nodes sharing EmptyTexture collapse into one binding that reads whatever bound last.
		this._placeholders = new Map();
		const readNode = () => {

			const placeholder = new DataTexture( new Float32Array( 4 ), 1, 1, RGBAFormat, FloatType );
			placeholder.needsUpdate = true;
			const node = new TextureNode( placeholder );
			this._placeholders.set( node, placeholder );
			return node;

		};

		this._nTmpA = readNode();
		this._nTmpB = readNode();
		this._nHist = readNode();
		this._nFast = readNode();
		this._nInternal = readNode();
		this._nGeom = readNode();
		this._nData = readNode();
		this._nStabRead = readNode();

		this._allocStorage();

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );
		this.outputTarget = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._compiled = false;
		this._needsReset = true;
		this._stabPing = 0;
		this._camInitialized = false;

		this._dispatchX = Math.ceil( w / WG_SIZE );
		this._dispatchY = Math.ceil( h / WG_SIZE );

		this._buildKernels();

	}

	// ── Storage ───────────────────────────────────────────────────────────────

	_allocStorage() {

		const tex = () => createStorageTexture( HalfFloatType );
		this._tmpA = tex();
		this._tmpB = tex();
		this._hist = tex(); // recurrent history (PostBlur output)
		this._fastHist = tex(); // .x fast luma
		this._internal = tex(); // .x accumSpeed for next frame
		// .xyz prev normal, .w prev viewZ. Half-float: the plane test's tolerance is orders above its error.
		this._geomPrev = tex();
		this._stabA = tex(); // .x stabilized luma
		this._stabB = tex();
		this._dataT = tex(); // .x fast luma, .y accumSpeed, .z occlusion bits, .w catrom ok

	}

	_disposeStorage() {

		for ( const t of [ this._tmpA, this._tmpB, this._hist, this._fastHist, this._internal, this._geomPrev, this._stabA, this._stabB, this._dataT ] ) t?.dispose();

	}

	_disposeKernels() {

		for ( const k of this._kernels ?? [] ) k?.dispose();

	}

	// ── Settings ──────────────────────────────────────────────────────────────

	updateParameters( params ) {

		if ( ! params ) return;
		for ( const key of Object.keys( params ) ) {

			if ( key === 'debugMode' ) this.debugMode.value = params.debugMode | 0;
			else if ( key in NRD_DEFAULTS ) this.settings[ key ] = params[ key ];

		}

		this._syncUniforms();

	}

	// Derivations follow nrd::InstanceImpl::AddSharedConstants_Reblur.
	_syncUniforms() {

		const s = this.settings;
		const u = this.u;
		const maxAccum = Math.min( s.maxAccumulatedFrameNum, 63 );
		const maxStab = Math.min( s.maxStabilizedFrameNum, maxAccum );
		const maxBlur = Math.max( s.maxBlurRadius, s.minBlurRadius );

		u.maxAccum.value = maxAccum;
		u.maxFast.value = s.maxFastAccumulatedFrameNum;
		u.stabilizationStrength.value = maxStab / ( 1.0 + maxStab );
		u.historyFixFrameNum.value = s.historyFixFrameNum;
		u.historyFixStride.value = s.historyFixBasePixelStride;
		u.prepassBlurRadius.value = s.prepassBlurRadius;
		u.minBlurRadius.value = s.minBlurRadius;
		u.maxBlurRadius.value = maxBlur;
		u.lobeAngleFraction.value = s.lobeAngleFraction * s.lobeAngleFraction;
		u.roughnessFraction.value = s.roughnessFraction;
		u.planeDistSensitivity.value = s.planeDistanceSensitivity;
		u.minHitDistanceWeight.value = s.minHitDistanceWeight;
		const t = Math.min( 1, Math.max( 0, maxBlur / 2 ) );
		u.fastClampSigmaScale.value = 3.0 + ( s.fastHistoryClampingSigmaScale - 3.0 ) * t;
		u.fireflyMinRelativeScale.value = s.fireflySuppressorMinRelativeScale;
		u.antiFirefly.value = s.enableAntiFirefly ? 1.0 : 0.0;
		u.antilag.value.set( s.antilagLuminanceSigmaScale, s.antilagLuminanceSensitivity );
		u.disocclusionThreshold.value = s.disocclusionThreshold;
		u.convergence.value.set( s.convergenceS, s.convergenceB, s.convergenceP );
		u.lobeVolumePercent.value = s.lobeVolumePercent;
		u.handoverFrames.value = s.handoverFrames > 0 ? s.handoverFrames : 2 * maxAccum;

	}

	// ── Shared TSL pieces ─────────────────────────────────────────────────────

	// Same ray the depth was measured along — NormalDepth generates it with this helper too.
	_worldPosAt( uv, dist, cwm, cpi ) {

		const dir = cameraRayDirection(
			uv, cwm, cpi,
			this.cameraProjection, this.panoLonRange, this.panoLatRange, this.panoLevelHorizon
		);
		return vec3( cwm[ 3 ] ).add( dir.mul( dist ) );

	}

	_pixelUv( gx, gy ) {

		return vec2( float( gx ).add( 0.5 ).div( this.resW ), float( gy ).add( 0.5 ).div( this.resH ) );

	}

	_clampCoord( x, y ) {

		return ivec2(
			x.clamp( int( 0 ), int( this.resW ).sub( 1 ) ),
			y.clamp( int( 0 ), int( this.resH ).sub( 1 ) )
		);

	}

	_uvToCoord( uv ) {

		return this._clampCoord( int( uv.x.mul( this.resW ) ), int( uv.y.mul( this.resH ) ) );

	}

	// NRD GetAdvancedNonLinearAccumSpeed.
	_advancedNonLinear( accumSpeed ) {

		const c = this.u.convergence;
		const f = saturate( accumSpeed.div( float( 1.0 ).add( this.u.maxAccum.mul( c.z ) ) ) );
		const e = c.x.mul( mix( c.y, float( 1.0 ), f ) );
		return float( 1.0 ).div( float( 1.0 ).add( e.mul( accumSpeed ) ) );

	}

	// 0 for a fresh input, 1 once it carries `handoverFrames` samples. Every history and spatial term is
	// scaled by (1 − this) so a converged render is handed back untouched.
	_handover( k ) {

		return saturate( k.div( max( this.u.handoverFrames, 1.0 ) ) );

	}

	_bilinear( uv ) {

		const t = uv.mul( vec2( this.resW, this.resH ) ).sub( 0.5 );
		const origin = floor( t );
		const f = saturate( t.sub( origin ) );
		const ox = int( origin.x );
		const oy = int( origin.y );
		const inScreen = ( x, y ) => select(
			x.greaterThanEqual( int( 0 ) ).and( y.greaterThanEqual( int( 0 ) ) )
				.and( x.lessThan( int( this.resW ) ) ).and( y.lessThan( int( this.resH ) ) ),
			float( 1.0 ), float( 0.0 )
		);
		return {
			f,
			taps: [
				this._clampCoord( ox, oy ),
				this._clampCoord( ox.add( 1 ), oy ),
				this._clampCoord( ox, oy.add( 1 ) ),
				this._clampCoord( ox.add( 1 ), oy.add( 1 ) ),
			],
			inScreen: [
				inScreen( ox, oy ), inScreen( ox.add( 1 ), oy ),
				inScreen( ox, oy.add( 1 ) ), inScreen( ox.add( 1 ), oy.add( 1 ) ),
			],
			customWeights: ( occ ) => [
				occ[ 0 ].mul( float( 1.0 ).sub( f.x ) ).mul( float( 1.0 ).sub( f.y ) ),
				occ[ 1 ].mul( f.x ).mul( float( 1.0 ).sub( f.y ) ),
				occ[ 2 ].mul( float( 1.0 ).sub( f.x ) ).mul( f.y ),
				occ[ 3 ].mul( f.x ).mul( f.y ),
			],
			filter: ( s ) => mix( mix( s[ 0 ], s[ 1 ], f.x ), mix( s[ 2 ], s[ 3 ], f.x ), f.y ),
		};

	}

	// NRD Filtering::ApplyBilinearCustomWeights.
	_applyCustomWeights( samples, weights, zero ) {

		const acc = samples[ 0 ].mul( weights[ 0 ] )
			.add( samples[ 1 ].mul( weights[ 1 ] ) )
			.add( samples[ 2 ].mul( weights[ 2 ] ) )
			.add( samples[ 3 ].mul( weights[ 3 ] ) );
		const sum = weights[ 0 ].add( weights[ 1 ] ).add( weights[ 2 ] ).add( weights[ 3 ] );
		return select( sum.lessThan( 1e-4 ), zero, acc.div( max( sum, 1e-4 ) ) );

	}

	// NRD BicubicFilterNoCornersWithFallbackToBilinearFilterWithCustomWeights.
	_sampleHistory( read, uv, bil, weights, allowCatRom ) {

		const out = vec4( 0.0 ).toVar();

		If( allowCatRom, () => {

			const samplePos = saturate( uv ).mul( vec2( this.resW, this.resH ) );
			const centerPos = floor( samplePos.sub( 0.5 ) ).add( 0.5 );
			const f = saturate( samplePos.sub( centerPos ) );
			const S = CATROM_SHARPNESS;
			const w0 = f.mul( f.mul( f.mul( - S ).add( 2.0 * S ) ).sub( S ) );
			const w1 = f.mul( f.mul( f.mul( 2.0 - S ).sub( 3.0 - S ) ) ).add( 1.0 );
			const w2 = f.mul( f.mul( f.mul( - ( 2.0 - S ) ).add( 3.0 - 2.0 * S ) ).add( S ) );
			const w3 = f.mul( f.mul( f.mul( S ).sub( S ) ) );
			const wx = [ w0.x, w1.x, w2.x, w3.x ];
			const wy = [ w0.y, w1.y, w2.y, w3.y ];
			const bx = int( centerPos.x ).sub( 1 );
			const by = int( centerPos.y ).sub( 1 );

			const acc = vec4( 0.0 ).toVar();
			const sum = float( 0.0 ).toVar();

			for ( let j = 0; j < 4; j ++ ) {

				for ( let i = 0; i < 4; i ++ ) {

					if ( ( i === 0 || i === 3 ) && ( j === 0 || j === 3 ) ) continue;
					const w = wx[ i ].mul( wy[ j ] );
					acc.addAssign( read( this._clampCoord( bx.add( i ), by.add( j ) ) ).mul( w ) );
					sum.addAssign( w );

				}

			}

			out.assign( select( sum.lessThan( 1e-4 ), vec4( 0.0 ), acc.div( max( sum, 1e-4 ) ) ) );

		} ).Else( () => {

			out.assign( this._applyCustomWeights( bil.taps.map( ( c ) => read( c ) ), weights, vec4( 0.0 ) ) );

		} );

		return out;

	}

	// ── Kernels ───────────────────────────────────────────────────────────────

	_buildKernels() {

		this._kPre = this._buildSpatial( 'pre' );
		this._kTa = this._buildTemporalAccumulation();
		this._kHf = this._buildHistoryFix();
		this._kBlur = this._buildSpatial( 'blur' );
		this._kPost = this._buildSpatial( 'post' );
		this._kTsA = this._buildTemporalStabilization( this._stabA );
		this._kTsB = this._buildTemporalStabilization( this._stabB );
		this._kernels = [ this._kPre, this._kTa, this._kHf, this._kBlur, this._kPost, this._kTsA, this._kTsB ];

	}

	_dispatchOf( fn ) {

		return fn( this.camWorld, this.camProjInv ).compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// REBLUR_Common_SpatialFilter. The pre-pass also runs the front end: demodulate, YCoCg, normHitDist.
	_buildSpatial( kind ) {

		const isPre = kind === 'pre';
		const { radiusScale, fractionScale } = PASS[ kind ];
		const u = this.u;
		const colorTex = this._colorTexNode;
		const albedoTex = this._albedoTexNode;
		const ndTex = this._ndTexNode;
		const snTex = this._snTexNode;
		const dataTex = this._nData;
		const inputTex = kind === 'blur' ? this._nTmpA : this._nTmpB;
		const outputTex = kind === 'blur' ? this._tmpB : isPre ? this._tmpA : this._hist;
		const geomOut = this._geomPrev;
		const rotator = isPre ? this.rotPre : kind === 'blur' ? this.rotBlur : this.rotPost;
		const maxRadiusU = isPre ? u.prepassBlurRadius : u.maxBlurRadius;
		const camView = this.camView;
		const camPos = this.camPos;
		const resW = this.resW;
		const resH = this.resH;
		const inputFrames = this.inputFrames;

		const readSignal = isPre
			? ( c ) => {

				const col = textureLoad( colorTex, c );
				const alb = textureLoad( albedoTex, c );
				const lighting = sanitizeRGB( col.xyz.div( max( alb.xyz, vec3( ALBEDO_EPS ) ) ) );
				return vec4( linearToYCoCg( lighting ), sanitize1( alb.w, FP16_MAX ).min( 1.0 ) );

			}
			: ( c ) => textureLoad( inputTex, c );

		const computeFn = Fn( ( [ cwm, cpi ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const uvec = uvec2( uint( gx ), uint( gy ) );
				const dist = textureLoad( ndTex, coord ).w.toVar();
				const isSky = dist.greaterThanEqual( MISS_THRESHOLD );
				const sn = textureLoad( snTex, coord ).toVar();
				const N = normalize( sn.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
				const roughness = sn.w.clamp( 0.05, 1.0 ).toVar();
				const viewZ = float( MISS_THRESHOLD ).toVar();

				const result = readSignal( coord ).toVar();

				If( isSky.not(), () => {

					const pixelUv = this._pixelUv( gx, gy );
					const X = this._worldPosAt( pixelUv, dist, cwm, cpi ).toVar();
					viewZ.assign( camView.mul( vec4( X, 1.0 ) ).z.abs() );

					If( maxRadiusU.greaterThan( 0.0 ), () => {

						const V = normalize( camPos.sub( X ) );
						const NoV = dot( N, V ).abs().toVar();
						const frustumSize = this.minRectDimMulUnproject.mul( viewZ ).toVar();

						const k = inputFrames.add( 1.0 );
						const accumSpeedEff = isPre
							? max( inputFrames, float( 10.0 ) )
							: textureLoad( dataTex, coord ).y.add( inputFrames );
						const nonLinear = ( isPre
							? float( 1.0 ).div( accumSpeedEff.add( 1.0 ) )
							: this._advancedNonLinear( accumSpeedEff ) ).toVar();

						const smc = specMagicCurve( roughness, 0.5 ).toVar();
						const hitDistScale = viewZ.mul( NRD_HIT_DIST_B ).add( NRD_HIT_DIST_A );
						const centerH = result.w.toVar();
						const hitDist = centerH.mul( hitDistScale );
						const hitDistFactor = saturate( hitDist.div( frustumSize ) );
						// NRD sizes the pre-pass for 1 spp; k samples carry 1/k of that variance.
						const fade = float( 1.0 ).sub( this._handover( k ) );
						const areaFactor = ( isPre ? hitDistFactor.div( k ) : hitDistFactor.mul( nonLinear ) ).mul( fade );

						// NRD's 1px floor fights 1-spp boiling, which an accumulated input does not have.
						const minRadius = u.minBlurRadius.mul( saturate( float( 2.0 ).sub( accumSpeedEff.div( max( u.maxAccum, 1.0 ) ) ) ) );
						const blurRadius = max(
							saturate( sqrt( saturate( areaFactor ) ).mul( radiusScale ) ).mul( maxRadiusU ).mul( smc ),
							minRadius.mul( smc )
						).toVar();

						const geomParams = geometryWeightParams( u.planeDistSensitivity, frustumSize, X, N ).toVar();
						const normalParam = normalWeightParam( nonLinear, u.lobeAngleFraction, roughness, u.lobeVolumePercent ).div( fractionScale ).toVar();
						const roughParams = roughnessWeightParams( roughness, u.roughnessFraction.mul( fractionScale ) ).toVar();
						const hdParams = hitDistWeightParams( centerH, nonLinear ).toVar();
						let minHitDistWeight = u.minHitDistanceWeight.mul( fractionScale ).mul( smc );
						if ( ! isPre ) minHitDistWeight = minHitDistWeight.mul( nonLinear );
						minHitDistWeight = minHitDistWeight.toVar();

						let skew = vec2( 1.0 );
						if ( ! isPre ) {

							const Nv = camView.mul( vec4( N, 0.0 ) ).xy;
							skew = mix( vec2( 1.0 ).sub( Nv.abs() ), vec2( 1.0 ), NoV );
							skew = skew.div( max( skew.x, skew.y ) );

						}

						const skewPx = skew.mul( vec2( float( 1.0 ).div( resW ), float( 1.0 ).div( resH ) ) ).mul( blurRadius ).toVar();

						const sum = float( 1.0 ).toVar();

						for ( let n = 0; n < SPECIAL8.length; n ++ ) {

							const off = SPECIAL8[ n ];
							const uvS = pixelUv.add( rotate2( rotator, vec2( off[ 0 ], off[ 1 ] ) ).mul( skewPx ) );
							const muv = mirrorUv( uvS );
							const mirrored = muv.x.notEqual( uvS.x ).or( muv.y.notEqual( uvS.y ) );
							const w = select( mirrored, float( 1.0 ), float( Math.exp( - 0.66 * off[ 2 ] * off[ 2 ] ) ) ).toVar();

							const pos = this._uvToCoord( muv );
							const zs = textureLoad( ndTex, pos ).w;
							const Xs = this._worldPosAt( muv, zs, cwm, cpi );
							const sns = textureLoad( snTex, pos );
							const Ns = normalize( sns.xyz.mul( 2.0 ).sub( 1.0 ) );

							const angle = acosApproxPositive( dot( N, Ns ) );
							w.mulAssign( weightSmooth( angle, normalParam, float( 0.0 ) ) );
							w.mulAssign( weightSmooth( sns.w, roughParams.x, roughParams.y ) );
							w.mulAssign( weightSmooth( dot( N, Xs ), geomParams.x, geomParams.y ) );
							w.assign( select( zs.greaterThanEqual( MISS_THRESHOLD ), float( 0.0 ), w ) );

							const s = denanify( w, readSignal( pos ) );
							w.mulAssign( minHitDistWeight.add( weightExp( s.w, hdParams.x, hdParams.y ) ) );

							sum.addAssign( w );
							result.addAssign( s.mul( w ) );

						}

						result.divAssign( max( sum, 1e-6 ) );
						// NRD keeps hit distance unfiltered past the pre-pass (self-inference).
						if ( ! isPre ) result.assign( vec4( result.xyz, centerH ) );

					} );

				} );

				textureStore( outputTex, uvec, result ).toWriteOnly();

				if ( kind === 'post' ) {

					textureStore( geomOut, uvec, vec4( N, viewZ ) ).toWriteOnly();

				}

			} );

		} );

		return this._dispatchOf( computeFn );

	}

	// REBLUR_TemporalAccumulation, diffuse branch (no specular virtual motion).
	_buildTemporalAccumulation() {

		const u = this.u;
		const ndTex = this._ndTexNode;
		const snTex = this._snTexNode;
		const motionTex = this._motionTexNode;
		const preTex = this._nTmpA;
		const histTex = this._nHist;
		const fastTex = this._nFast;
		const internalTex = this._nInternal;
		const geomTex = this._nGeom;
		const outTex = this._tmpB;
		const dataOut = this._dataT;
		const camView = this.camView;
		const prevCamView = this.prevCamView;
		const camPos = this.camPos;
		const prevCamPos = this.prevCamPos;
		const resW = this.resW;
		const resH = this.resH;
		const inputFrames = this.inputFrames;
		const resetU = this.resetU;

		const computeFn = Fn( ( [ cwm, cpi ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const uvec = uvec2( uint( gx ), uint( gy ) );
				const dist = textureLoad( ndTex, coord ).w;
				const current = textureLoad( preTex, coord ).toVar();

				If( dist.greaterThanEqual( MISS_THRESHOLD ), () => {

					textureStore( outTex, uvec, current ).toWriteOnly();
					textureStore( dataOut, uvec, vec4( 0.0 ) ).toWriteOnly();
					Return();

				} );

				const maxAccumEff = u.maxAccum.mul( float( 1.0 ).sub( resetU ) ).toVar();
				const maxFastEff = u.maxFast.mul( float( 1.0 ).sub( resetU ) ).toVar();

				const sn = textureLoad( snTex, coord );
				const N = normalize( sn.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
				const roughness = sn.w.clamp( 0.05, 1.0 ).toVar();

				const pixelUv = this._pixelUv( gx, gy );
				const X = this._worldPosAt( pixelUv, dist, cwm, cpi ).toVar();
				const viewZ = camView.mul( vec4( X, 1.0 ) ).z.abs().toVar();
				const V = normalize( camPos.sub( X ) );
				const NoV = dot( N, V ).abs().toVar();
				const frustumSize = this.minRectDimMulUnproject.mul( viewZ ).toVar();

				// Unnormalized, as NRD requires — its length carries the normal variance. A miss neighbour's
				// shadingNormal is a literal (0,0,0), which decodes to a fixed fake direction, so substitute
				// the centre normal instead of letting it skew the reprojection test along every silhouette.
				const Navg = vec3( 0.0 ).toVar();
				Navg.addAssign( N.mul( 0.25 ) ); // the centre; the sky early-out above proves it is a hit
				for ( let j = - 1; j <= 0; j ++ ) {

					for ( let i = - 1; i <= 0; i ++ ) {

						if ( i === 0 && j === 0 ) continue;
						const at = this._clampCoord( gx.add( i ), gy.add( j ) );
						const n = normalize( textureLoad( snTex, at ).xyz.mul( 2.0 ).sub( 1.0 ) );
						const isHit = textureLoad( ndTex, at ).w.lessThan( MISS_THRESHOLD );
						Navg.addAssign( select( isHit, n, N ).mul( 0.25 ) );

					}

				}

				// MotionVector publishes (current − previous) uv; static geometry ⇒ Xprev = X.
				const mv = textureLoad( motionTex, coord );
				const smbUv = pixelUv.sub( mv.xy ).toVar();
				const prevViewZc = prevCamView.mul( vec4( X, 1.0 ) ).z.abs().toVar();

				const bil = this._bilinear( smbUv );
				const threshold = frustumSize.mul( saturate( u.disocclusionThreshold.div( max( NoV, 0.05 ) ) ) ).sub( NRD_EPS ).toVar();
				const noReset = float( 1.0 ).sub( resetU );

				const occ = [];
				const prevAccum = [];
				for ( let k = 0; k < 4; k ++ ) {

					const g = textureLoad( geomTex, bil.taps[ k ] );
					const normalOk = select( dot( g.xyz, Navg ).greaterThan( ALMOST_ZERO_ANGLE_COS ), float( 1.0 ), float( 0.0 ) );
					const planeOk = select( g.w.sub( prevViewZc ).abs().lessThanEqual( threshold ), float( 1.0 ), float( 0.0 ) );
					const inRange = select( g.w.lessThan( MISS_THRESHOLD ), float( 1.0 ), float( 0.0 ) );
					occ.push( normalOk.mul( planeOk ).mul( inRange ).mul( bil.inScreen[ k ] ).mul( noReset ).toVar() );
					prevAccum.push( textureLoad( internalTex, bil.taps[ k ] ).x );

				}

				const occW = bil.customWeights( occ ).map( ( w ) => w.toVar() );
				const occSum = occ[ 0 ].add( occ[ 1 ] ).add( occ[ 2 ] ).add( occ[ 3 ] );
				const allowCatRom = occSum.greaterThan( 3.5 ).toVar();
				const fbits = occ[ 0 ].add( occ[ 1 ].mul( 2.0 ) ).add( occ[ 2 ].mul( 4.0 ) ).add( occ[ 3 ].mul( 8.0 ) );

				const accumSpeed = this._applyCustomWeights( prevAccum, occW, float( 0.0 ) ).toVar();

				const Vprev = normalize( prevCamPos.sub( X ) );
				const NoVprev = dot( N, Vprev ).abs();
				const sizeQuality = NoVprev.add( 1e-3 ).div( NoV.add( 1e-3 ) ).toVar();
				sizeQuality.assign( mix( float( 0.1 ), float( 1.0 ), saturate( sizeQuality.mul( sizeQuality ) ) ) );
				const footprint = sqrt( saturate( bil.filter( occ ) ) ).mul( sizeQuality ).toVar();
				accumSpeed.assign( accumSpeed.mul( mix( footprint, float( 1.0 ), float( 1.0 ).div( accumSpeed.add( 1.0 ) ) ) ) );
				accumSpeed.assign( min( accumSpeed, maxAccumEff ) );

				const history = clampNegativeToZero(
					this._sampleHistory( ( c ) => textureLoad( histTex, c ), smbUv, bil, occW, allowCatRom )
				).toVar();
				const fastHistory = max( this._applyCustomWeights( bil.taps.map( ( c ) => textureLoad( fastTex, c ).x ), occW, float( 0.0 ) ), 0.0 ).toVar();

				// Inverse-variance blend: k samples in the input against accumSpeed frames of history.
				const k = inputFrames.add( 1.0 );
				const handover = this._handover( k ).toVar();
				const historyFrames = accumSpeed.mul( float( 1.0 ).sub( handover ) );
				const nonLinear = k.div( k.add( historyFrames ) ).toVar();
				const minHitDistNonLinear = float( 1.0 ).div( float( 1.0 ).add( specMagicCurve( roughness, 0.25 ).mul( 0.5 ).mul( maxAccumEff ) ) );
				const result = vec4(
					mix( history.xyz, current.xyz, nonLinear ),
					mix( history.w, current.w, max( nonLinear, minHitDistNonLinear ) )
				).toVar();

				const maxRel = u.fireflyMinRelativeScale.add( float( FIREFLY_MAX_RELATIVE_INTENSITY ).div( accumSpeed.add( 1.0 ) ) ).toVar();
				const aff = accumSpeed.mul( u.maxBlurRadius ).mul( FIREFLY_RADIUS_SCALE ).toVar();
				aff.assign( aff.div( aff.add( 1.0 ) ).mul( float( 1.0 ).sub( handover ) ) );
				const lumaClamped = mix( result.x, min( result.x, history.x.mul( maxRel ) ), aff );
				result.assign( changeLuma( result, lumaClamped ) );
				const hdMaxRel = float( 1.2 ).add( float( 1.0 ).div( accumSpeed.add( 1.0 ) ) );
				result.assign( vec4( result.xyz, mix( result.w, min( result.w, history.w.mul( hdMaxRel ) ), aff ) ) );

				textureStore( outTex, uvec, result ).toWriteOnly();

				const fastAccum = min( accumSpeed, maxFastEff ).mul( float( 1.0 ).sub( handover ) );
				const fastNonLinear = k.div( k.add( fastAccum ) );
				const fast = mix( fastHistory, current.x, fastNonLinear ).toVar();
				const fastClamped = min( fast, history.x.mul( maxRel ).mul( FIREFLY_FAST_RELATIVE_INTENSITY ) );
				fast.assign( mix( fast, fastClamped, aff ) );

				textureStore( dataOut, uvec, vec4( fast, accumSpeed, fbits, select( allowCatRom, float( 1.0 ), float( 0.0 ) ) ) ).toWriteOnly();

			} );

		} );

		return this._dispatchOf( computeFn );

	}

	// REBLUR_HistoryFix.
	_buildHistoryFix() {

		const u = this.u;
		const ndTex = this._ndTexNode;
		const snTex = this._snTexNode;
		const inTex = this._nTmpB;
		const dataTex = this._nData;
		const outTex = this._tmpA;
		const fastOut = this._fastHist;
		const camView = this.camView;
		const resW = this.resW;
		const resH = this.resH;
		const inputFrames = this.inputFrames;

		const computeFn = Fn( ( [ cwm, cpi ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const uvec = uvec2( uint( gx ), uint( gy ) );
				const dist = textureLoad( ndTex, coord ).w;

				// Pass the sky's own signal through rather than zeroing it: it reaches `hist` unchanged
				// (the spatial passes skip sky too), and the Catmull-Rom history tap has no per-tap gate,
				// so a 0 here is a black sample for any foreground pixel whose 4×4 footprint touches it.
				If( dist.greaterThanEqual( MISS_THRESHOLD ), () => {

					const passThrough = textureLoad( inTex, coord );
					textureStore( outTex, uvec, passThrough ).toWriteOnly();
					textureStore( fastOut, uvec, vec4( passThrough.x, 0.0, 0.0, 0.0 ) ).toWriteOnly();
					Return();

				} );

				const data = textureLoad( dataTex, coord ).toVar();
				const frameNum = data.y.toVar();
				const frameNumEff = frameNum.add( inputFrames );
				// The luma clamps below guard history lag, which the handover retires.
				const handover = this._handover( inputFrames.add( 1.0 ) ).toVar();

				const sn = textureLoad( snTex, coord );
				const N = normalize( sn.xyz.mul( 2.0 ).sub( 1.0 ) ).toVar();
				const roughness = sn.w.clamp( 0.05, 1.0 ).toVar();
				const pixelUv = this._pixelUv( gx, gy );
				const X = this._worldPosAt( pixelUv, dist, cwm, cpi ).toVar();
				const viewZ = camView.mul( vec4( X, 1.0 ) ).z.abs();
				const frustumSize = this.minRectDimMulUnproject.mul( viewZ ).toVar();

				const diff = textureLoad( inTex, coord ).toVar();
				const nonLinear = float( 1.0 ).div( frameNumEff.add( 1.0 ) ).toVar();

				const hitDistScale = viewZ.mul( NRD_HIT_DIST_B ).add( NRD_HIT_DIST_A );
				const hitDistFactor = saturate( diff.w.mul( hitDistScale ).div( frustumSize ) );
				const centerH = diff.w.toVar();

				// Halved to match RELAX's frame count, then shrunk near contact (NRD).
				const stride = select( frameNumEff.lessThan( u.historyFixFrameNum ), float( 1.0 ), float( 0.0 ) )
					.mul( 0.5 ).mul( 2.0 / HISTORY_FIX_RADIUS ).mul( u.historyFixStride )
					.mul( mix( float( 0.25 ).add( sqrt( hitDistFactor ).mul( 0.75 ) ), float( 1.0 ), nonLinear ) );
				const strideR = round( stride ).toVar();

				If( strideR.notEqual( 0.0 ), () => {

					const normalParam = normalWeightParam( nonLinear, u.lobeAngleFraction, roughness, u.lobeVolumePercent ).toVar();
					const geomParams = geometryWeightParams( u.planeDistSensitivity, frustumSize, X, N ).toVar();
					const hdParams = hitDistWeightParams( centerH, nonLinear ).toVar();
					const relaxedRough = relaxedRoughnessWeightParams( roughness.mul( roughness ), sqrt( u.roughnessFraction ), ROUGHNESS_SENSITIVITY ).toVar();

					const sumd = float( 1.0 ).add( frameNum ).toVar();
					diff.mulAssign( sumd );

					for ( let j = - HISTORY_FIX_RADIUS; j <= HISTORY_FIX_RADIUS; j ++ ) {

						for ( let i = - HISTORY_FIX_RADIUS; i <= HISTORY_FIX_RADIUS; i ++ ) {

							if ( i === 0 && j === 0 ) continue;
							if ( Math.abs( i ) + Math.abs( j ) === HISTORY_FIX_RADIUS * 2 ) continue;

							const uvS = pixelUv.add( vec2( i, j ).mul( strideR ).mul( vec2( float( 1.0 ).div( resW ), float( 1.0 ).div( resH ) ) ) );
							const muv = mirrorUv( uvS );
							const pos = this._uvToCoord( muv );

							const zs = textureLoad( ndTex, pos ).w;
							const Xs = this._worldPosAt( muv, zs, cwm, cpi );
							const sns = textureLoad( snTex, pos );
							const Ns = normalize( sns.xyz.mul( 2.0 ).sub( 1.0 ) );
							const angle = acosApproxPositive( dot( Ns, N ) );

							const w = weightExp( angle, normalParam, float( 0.0 ) ).toVar();
							w.mulAssign( weightExp( sns.w.mul( sns.w ), relaxedRough.x, relaxedRough.y ) );
							w.mulAssign( float( 1.0 ).add( textureLoad( dataTex, pos ).y ) );
							w.mulAssign( weightSmooth( dot( N, Xs ), geomParams.x, geomParams.y ) );
							w.assign( select( zs.greaterThanEqual( MISS_THRESHOLD ), float( 0.0 ), w ) );

							const s = denanify( w, textureLoad( inTex, pos ) );
							w.mulAssign( weightExp( s.w, hdParams.x, hdParams.y ) );

							sumd.addAssign( w );
							diff.addAssign( s.mul( w ) );

						}

					}

					diff.divAssign( max( sumd, 1e-6 ) );

				} );

				const diffLuma = diff.x.toVar();

				const f = saturate( frameNum.div( max( u.historyFixFrameNum, NRD_EPS ) ) );
				const fastCenter = mix( diffLuma, data.x, f ).toVar();
				textureStore( fastOut, uvec, vec4( fastCenter, 0.0, 0.0, 0.0 ) ).toWriteOnly();

				// 5×5 moments for the clamp, the outer ring only for anti-firefly.
				const fastM1 = fastCenter.toVar();
				const fastM2 = fastCenter.mul( fastCenter ).toVar();
				const afM1 = float( 0.0 ).toVar();
				const afM2 = float( 0.0 ).toVar();

				const ringTap = ( i, j, onAF ) => {

					const pos = this._clampCoord( gx.add( i ), gy.add( j ) );
					const zs = textureLoad( ndTex, pos ).w;
					const d = select( zs.greaterThanEqual( MISS_THRESHOLD ), fastCenter, textureLoad( dataTex, pos ).x );

					if ( Math.abs( i ) <= FAST_CLAMP_RADIUS && Math.abs( j ) <= FAST_CLAMP_RADIUS ) {

						fastM1.addAssign( d );
						fastM2.addAssign( d.mul( d ) );

					}

					if ( onAF ) {

						afM1.addAssign( d );
						afM2.addAssign( d.mul( d ) );

					}

				};

				const antiFireflyOn = u.antiFirefly.greaterThan( 0.5 );

				for ( let j = - FAST_CLAMP_RADIUS; j <= FAST_CLAMP_RADIUS; j ++ ) {

					for ( let i = - FAST_CLAMP_RADIUS; i <= FAST_CLAMP_RADIUS; i ++ ) {

						if ( i === 0 && j === 0 ) continue;
						ringTap( i, j, Math.abs( i ) > 1 || Math.abs( j ) > 1 );

					}

				}

				// The outer ring only feeds the anti-firefly moments — skip it when the gate is off.
				If( antiFireflyOn, () => {

					for ( let j = - ANTI_FIREFLY_RADIUS; j <= ANTI_FIREFLY_RADIUS; j ++ ) {

						for ( let i = - ANTI_FIREFLY_RADIUS; i <= ANTI_FIREFLY_RADIUS; i ++ ) {

							if ( Math.abs( i ) <= FAST_CLAMP_RADIUS && Math.abs( j ) <= FAST_CLAMP_RADIUS ) continue;
							ringTap( i, j, true );

						}

					}

				} );

				If( antiFireflyOn, () => {

					const invNorm = 1.0 / ( ( ANTI_FIREFLY_RADIUS * 2 + 1 ) ** 2 - 9 );
					const m1 = afM1.mul( invNorm );
					const m2 = afM2.mul( invNorm );
					const sigma = stdDev( m1, m2 ).mul( ANTI_FIREFLY_SIGMA_SCALE );
					diffLuma.assign( mix( diffLuma.clamp( m1.sub( sigma ), m1.add( sigma ) ), diffLuma, handover ) );

				} );

				{

					const invNorm = 1.0 / ( ( FAST_CLAMP_RADIUS * 2 + 1 ) ** 2 );
					const m1 = fastM1.mul( invNorm );
					const m2 = fastM2.mul( invNorm );
					const sigma = stdDev( m1, m2 ).mul( u.fastClampSigmaScale );
					const clamped = diffLuma.clamp( m1.sub( sigma ), m1.add( sigma ) );
					const fastEnabled = select( u.maxFast.lessThan( u.maxAccum ), float( 1.0 ), float( 0.0 ) );
					const keep = mix( float( 1.0 ).div( float( 1.0 ).add( fastEnabled.mul( frameNum ).mul( 2.0 ) ) ), float( 1.0 ), handover );
					diffLuma.assign( mix( clamped, diffLuma, keep ) );

				}

				textureStore( outTex, uvec, changeLuma( diff, diffLuma ) ).toWriteOnly();

			} );

		} );

		return this._dispatchOf( computeFn );

	}

	// REBLUR_TemporalStabilization, plus remodulation and the debug views.
	_buildTemporalStabilization( stabWrite ) {

		const u = this.u;
		const colorTex = this._colorTexNode;
		const albedoTex = this._albedoTexNode;
		const ndTex = this._ndTexNode;
		const snTex = this._snTexNode;
		const motionTex = this._motionTexNode;
		const histTex = this._nHist;
		const dataTex = this._nData;
		const stabRead = this._nStabRead;
		const internalOut = this._internal;
		const outTex = this._tmpA;
		const resW = this.resW;
		const resH = this.resH;
		const inputFrames = this.inputFrames;
		const resetU = this.resetU;
		const debugMode = this.debugMode;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const uvec = uvec2( uint( gx ), uint( gy ) );
				const dist = textureLoad( ndTex, coord ).w;
				const color = textureLoad( colorTex, coord ).toVar();

				If( dist.greaterThanEqual( MISS_THRESHOLD ), () => {

					// NRD leaves sky to the app. The stabilized luma still carries the sky's own value —
					// see HistoryFix: a 0 would be a black Catmull-Rom tap on the silhouette next frame.
					textureStore( outTex, uvec, color ).toWriteOnly();
					textureStore( stabWrite, uvec, vec4( textureLoad( histTex, coord ).x, 0.0, 0.0, 0.0 ) ).toWriteOnly();
					textureStore( internalOut, uvec, vec4( 0.0, 1.0, 0.0, 0.0 ) ).toWriteOnly();
					Return();

				} );

				const roughness = textureLoad( snTex, coord ).w.clamp( 0.05, 1.0 );
				const pixelUv = this._pixelUv( gx, gy );
				const mv = textureLoad( motionTex, coord );
				const smbUv = pixelUv.sub( mv.xy ).toVar();

				const data = textureLoad( dataTex, coord ).toVar();
				const accumSpeed = data.y.toVar();
				const bits = uint( data.z.add( 0.5 ) ).toVar();
				const allowCatRom = data.w.greaterThan( 0.5 );

				const bil = this._bilinear( smbUv );
				const occ = [ 1, 2, 4, 8 ].map( ( m ) =>
					select( bits.bitAnd( uint( m ) ).notEqual( uint( 0 ) ), float( 1.0 ), float( 0.0 ) ) );
				const occW = bil.customWeights( occ ).map( ( w ) => w.toVar() );
				const footprint = sqrt( saturate( bil.filter( occ ) ) ).toVar();

				const diff = textureLoad( histTex, coord ).toVar();
				const diffLuma = diff.x.toVar();

				const m1 = diffLuma.toVar();
				const m2 = diffLuma.mul( diffLuma ).toVar();
				for ( let j = - 1; j <= 1; j ++ ) {

					for ( let i = - 1; i <= 1; i ++ ) {

						if ( i === 0 && j === 0 ) continue;
						const pos = this._clampCoord( gx.add( i ), gy.add( j ) );
						const zs = textureLoad( ndTex, pos ).w;
						const l = select( zs.greaterThanEqual( MISS_THRESHOLD ), diffLuma, textureLoad( histTex, pos ).x );
						m1.addAssign( l );
						m2.addAssign( l.mul( l ) );

					}

				}

				m1.divAssign( 9.0 );
				m2.divAssign( 9.0 );
				const sigma = stdDev( m1, m2 ).toVar();

				If( accumSpeed.lessThan( u.historyFixFrameNum ), () => {

					diffLuma.assign( min( diffLuma, m1.mul( float( 1.2 ).add( float( 1.0 ).div( accumSpeed.add( 1.0 ) ) ) ) ) );

				} );

				const lumaHistory = max(
					this._sampleHistory( ( c ) => textureLoad( stabRead, c ), smbUv, bil, occW, allowCatRom ).x,
					0.0
				).toVar();

				// NRD ComputeAntilag, REBLUR_ANTILAG_MODE 2, frame-rate scale 1.
				const s = sigma.mul( u.antilag.x );
				const magic = u.antilag.y.mul( 4.0 );
				const hc = lumaHistory.clamp( m1.sub( s ), m1.add( s ) );
				const d = lumaHistory.sub( hc ).abs().div( max( lumaHistory, hc ).add( NRD_EPS ) );
				const antilag = float( 1.0 ).div( float( 1.0 ).add( d.mul( accumSpeed.mul( footprint ) ).div( magic ) ) ).toVar();

				const minAccum = min( accumSpeed, u.historyFixFrameNum );
				accumSpeed.assign( mix( minAccum, accumSpeed, antilag ) );

				// NRD GetTemporalAccumulationParams.
				const k = inputFrames.add( 1.0 );
				const handover = this._handover( k );
				const wHist = footprint.mul( float( 1.0 ).sub( this._advancedNonLinear( accumSpeed.mul( float( 1.0 ).sub( handover ) ).div( k ) ) ) ).mul( antilag ).toVar();
				const sigmaScale = float( 1.0 ).add( wHist.mul( 6.0 ) );
				const stabStrength = u.stabilizationStrength.mul( float( 1.0 ).sub( resetU ) );

				const clampedHistory = lumaHistory.clamp( m1.sub( sigma.mul( sigmaScale ) ), m1.add( sigma.mul( sigmaScale ) ) );
				const stabilized = mix( diffLuma, clampedHistory, min( wHist, stabStrength ) ).toVar();
				diff.assign( changeLuma( diff, stabilized ) );

				textureStore( stabWrite, uvec, vec4( stabilized, 0.0, 0.0, 0.0 ) ).toWriteOnly();
				const maxAccumEff = u.maxAccum.mul( float( 1.0 ).sub( resetU ) );
				textureStore( internalOut, uvec, vec4( min( accumSpeed.add( 1.0 ), maxAccumEff ), roughness, 0.0, 0.0 ) ).toWriteOnly();

				// Alpha stays the path tracer's coverage — Compositor reads it under transparentBackground.
				const albedo = textureLoad( albedoTex, coord );
				const lighting = yCoCgToLinear( diff.xyz ).mul( max( albedo.xyz, vec3( ALBEDO_EPS ) ) );
				const out = vec4( lighting, color.w ).toVar();

				If( debugMode.equal( int( 1 ) ), () => {

					const t = saturate( accumSpeed.div( max( u.maxAccum, 1.0 ) ) );
					out.assign( vec4( float( 1.0 ).sub( t ), t, 0.2, 1.0 ) );

				} ).ElseIf( debugMode.equal( int( 2 ) ), () => {

					out.assign( vec4( vec3( diff.w ), 1.0 ) );

				} ).ElseIf( debugMode.equal( int( 3 ) ), () => {

					out.assign( vec4( vec3( roughness ), 1.0 ) );

				} ).ElseIf( debugMode.equal( int( 4 ) ), () => {

					const l = data.x.div( data.x.add( 1.0 ) );
					out.assign( vec4( vec3( l ), 1.0 ) );

				} ).ElseIf( debugMode.equal( int( 5 ) ), () => {

					out.assign( vec4( vec3( data.z.div( 15.0 ) ), 1.0 ) );

				} );

				textureStore( outTex, uvec, out ).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'denoiser:reset', () => this.resetHistory() );

	}

	resetHistory() {

		this._needsReset = true;

	}

	_updateCamera() {

		const pt = this.pathTracer;
		if ( ! pt?.uniforms ) return;

		const world = pt.uniforms.get( 'cameraWorldMatrix' ).value;
		const view = pt.uniforms.get( 'cameraViewMatrix' ).value;
		const projInv = pt.uniforms.get( 'cameraProjectionMatrixInverse' ).value;
		const proj = pt.uniforms.get( 'cameraProjectionMatrix' ).value;

		if ( this._camInitialized ) {

			this.prevCamView.value.copy( this.camView.value );
			this.prevCamPos.value.copy( this.camPos.value );

		}

		this.camWorld.value.copy( world );
		this.camProjInv.value.copy( projInv );
		this.camView.value.copy( view );
		this.camPos.value.setFromMatrixPosition( world );
		this.cameraProjection.value = pt.uniforms.get( 'cameraProjection' ).value;
		this.panoLonRange.value.copy( pt.uniforms.get( 'panoLonRange' ).value );
		this.panoLatRange.value.copy( pt.uniforms.get( 'panoLatRange' ).value );
		this.panoLevelHorizon.value = pt.uniforms.get( 'panoLevelHorizon' ).value;

		if ( ! this._camInitialized ) {

			this.prevCamView.value.copy( view );
			this.prevCamPos.value.copy( this.camPos.value );
			this._camInitialized = true;

		}

		// NRD gUnproject; frustum size follows the shorter edge.
		const projY = proj.elements[ 5 ] || 1;
		const unproject = 1 / ( 0.5 * this.resH.value * projY );
		this.minRectDimMulUnproject.value = Math.min( this.resW.value, this.resH.value ) * unproject;

	}

	_updateRotators( frameKey ) {

		const set = ( u, salt ) => {

			const a = hash01( frameKey * 3 + salt ) * Math.PI * 2;
			u.value.set( Math.cos( a ), Math.sin( a ), - Math.sin( a ), Math.cos( a ) );

		};

		set( this.rotPre, 0 );
		set( this.rotBlur, 1 );
		set( this.rotPost, 2 );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( 'pathtracer:color' );
		const albedoTex = context.getTexture( 'pathtracer:albedo' );
		const ndTex = context.getTexture( 'pathtracer:normalDepth' );
		const snTex = context.getTexture( 'pathtracer:shadingNormal' );
		const motionTex = context.getTexture( 'motionVector:screenSpace' );

		if ( ! colorTex ) return;

		// No guides ⇒ no guidance. Pass through rather than blur blind.
		if ( ! albedoTex || ! ndTex || ! snTex || ! motionTex ) {

			context.setTexture( 'nrd:output', colorTex );
			return;

		}

		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 &&
			( img.width !== this.outputTarget.width || img.height !== this.outputTarget.height ) ) {

			this.setSize( img.width, img.height );

		}

		// Past the handover the input is the better estimate: republish it and skip the six dispatches.
		// The geometry history and prev camera freeze here, so mark them stale: a camera move is a SOFT
		// reset, and a 1-frame motion vector into a stale G-buffer would keep whatever taps passed.
		const inputFrames = context.getState( 'pathtracer:samples' ) ?? this.pathTracer?.frameCount ?? 0;
		if ( inputFrames + 1 >= this.u.handoverFrames.value ) {

			context.setTexture( 'nrd:output', colorTex );
			this._needsReset = true;
			return;

		}

		this._colorTexNode.value = colorTex;
		this._albedoTexNode.value = albedoTex;
		this._ndTexNode.value = ndTex;
		this._snTexNode.value = snTex;
		this._motionTexNode.value = motionTex;
		this._updateCamera();
		this.inputFrames.value = inputFrames;
		this._updateRotators( this.pathTracer?.uniforms?.get( 'seedFrame' )?.value ?? context.getState( 'frame' ) ?? 0 );
		this.resetU.value = this._needsReset ? 1.0 : 0.0;

		// Compile while the read nodes still hold their placeholders, so textureLoad carries the `level`
		// argument StorageTexture reads require.
		if ( ! this._compiled ) {

			for ( const k of this._kernels ) this.renderer.compute( k );
			this._compiled = true;

		}

		this._nTmpA.value = this._tmpA;
		this._nTmpB.value = this._tmpB;
		this._nHist.value = this._hist;
		this._nFast.value = this._fastHist;
		this._nInternal.value = this._internal;
		this._nGeom.value = this._geomPrev;
		this._nData.value = this._dataT;
		this._nStabRead.value = this._stabPing === 0 ? this._stabB : this._stabA;

		this.renderer.compute( this._kPre );
		this.renderer.compute( this._kTa );
		this.renderer.compute( this._kHf );
		this.renderer.compute( this._kBlur );
		this.renderer.compute( this._kPost );
		this.renderer.compute( this._stabPing === 0 ? this._kTsA : this._kTsB );

		this._srcRegion.max.set( this.outputTarget.width, this.outputTarget.height );
		this.renderer.copyTextureToTexture( this._tmpA, this.outputTarget.texture, this._srcRegion );
		context.setTexture( 'nrd:output', this.outputTarget.texture );

		this._stabPing = 1 - this._stabPing;
		this._needsReset = false;
		this._needsReset = false;

	}

	setSize( width, height ) {

		this.outputTarget.setSize( width, height );
		this.outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / WG_SIZE );
		this._dispatchY = Math.ceil( height / WG_SIZE );
		const size = [ this._dispatchX, this._dispatchY, 1 ];
		for ( const k of this._kernels ) {

			if ( k ) k.dispatchSize = size;

		}

		// StorageTextures stay at max; history from another size is meaningless.
		this._needsReset = true;

	}

	// three.js recreates the textures on the next dispatch after re-enable.
	releaseGPUMemory() {

		this._disposeStorage();
		this.context?.removeTexture( 'nrd:output' );
		this.outputTarget?.texture?.dispose();
		this._needsReset = true;

	}

	reallocateReservedStorage() {

		this._disposeKernels();
		this._disposeStorage();
		// Restore the placeholders — the rebuilt kernels compile against them (see constructor).
		for ( const [ node, placeholder ] of this._placeholders ) node.value = placeholder;
		this._allocStorage();
		this._buildKernels();
		this._compiled = false;
		this._needsReset = true;
		this._stabPing = 0;

	}

	dispose() {

		this._disposeKernels();
		this._disposeStorage();
		this.outputTarget?.dispose();
		for ( const n of [
			this._colorTexNode, this._albedoTexNode, this._ndTexNode, this._snTexNode, this._motionTexNode,
		] ) n?.dispose();
		// The read nodes are exactly the placeholder map's keys.
		for ( const [ node, placeholder ] of this._placeholders ) {

			node.dispose();
			placeholder.dispose();

		}

		this._placeholders.clear();

	}

}
