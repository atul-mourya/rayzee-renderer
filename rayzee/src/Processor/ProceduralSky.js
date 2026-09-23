import {
	RGBAFormat, FloatType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
	EquirectangularReflectionMapping, LinearSRGBColorSpace, DataTexture
} from 'three';

/**
 * ProceduralSky
 *
 * CPU-based Preetham atmospheric scattering sky generator.
 * Produces a DataTexture directly — no render targets, no GPU readback,
 * no resource lifecycle issues with the WebGPU backend.
 *
 * For a 512×256 texture this takes ~5-10ms on CPU, which is negligible
 * since it only runs on parameter change (not per-frame).
 *
 * Public API matches ProceduralSkyRenderer: render(params) → texture.
 */

// ── Constants (from preetham_sky.glsl) ──

const PI = Math.PI;
const TWO_PI = Math.PI * 2;
const E = Math.E;

const TOTAL_RAYLEIGH = [ 5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5 ];
const MIE_CONST = [ 1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14 ];

const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE_CONST = 1000.0;

const RAYLEIGH_ZENITH_LENGTH = 8400.0;
const MIE_ZENITH_LENGTH = 1250.0;
const SUN_ANGULAR_DIAMETER_COS = 0.9999566769464484;

const THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
const ONE_OVER_FOUR_PI = 0.07957747154594767;

// ── CPU Math ──

function computeSunIntensity( zenithAngleCos ) {

	const clamped = Math.max( - 1.0, Math.min( 1.0, zenithAngleCos ) );
	return EE_CONST * Math.max( 0.0, 1.0 - Math.pow( E, - ( CUTOFF_ANGLE - Math.acos( clamped ) ) / STEEPNESS ) );

}

function totalMie( T ) {

	const c = ( 0.2 * T ) * 10e-18;
	return [ 0.434 * c * MIE_CONST[ 0 ], 0.434 * c * MIE_CONST[ 1 ], 0.434 * c * MIE_CONST[ 2 ] ];

}

function rayleighPhase( cosTheta ) {

	return THREE_OVER_SIXTEEN_PI * ( 1.0 + Math.pow( cosTheta, 2.0 ) );

}

function hgPhase( cosTheta, g ) {

	const g2 = g * g;
	return ONE_OVER_FOUR_PI * ( ( 1.0 - g2 ) / Math.pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 ) );

}

function dot3( a, b ) {

	return a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];

}

function normalize3( v ) {

	const len = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 1 ] * v[ 1 ] + v[ 2 ] * v[ 2 ] );
	if ( len === 0 ) return [ 0, 0, 0 ];
	return [ v[ 0 ] / len, v[ 1 ] / len, v[ 2 ] / len ];

}

function computePreethamPixel( u, v, sunDir, sunIntensity, rayleighDensity, mieDensity, mieAnisotropy, turbidity ) {

	// Equirectangular → direction
	const theta = ( 1.0 - v ) * PI;
	const phi = ( u - 0.5 ) * TWO_PI;
	const sinTheta = Math.sin( theta );
	const direction = normalize3( [
		sinTheta * Math.sin( phi ),
		Math.cos( theta ),
		sinTheta * Math.cos( phi )
	] );

	const vSunDirection = normalize3( sunDir );

	// Sun intensity from zenith angle
	const vSunE = computeSunIntensity( vSunDirection[ 1 ] ) * sunIntensity;

	// Sun fade near horizon
	const vSunfade = 1.0 - Math.max( 0.0, Math.min( 1.0, 1.0 - Math.exp( vSunDirection[ 1 ] / 450000.0 ) ) );

	// Rayleigh coefficient
	const rayleighCoeff = rayleighDensity - ( 1.0 * ( 1.0 - vSunfade ) );
	const vBetaR = [ TOTAL_RAYLEIGH[ 0 ] * rayleighCoeff, TOTAL_RAYLEIGH[ 1 ] * rayleighCoeff, TOTAL_RAYLEIGH[ 2 ] * rayleighCoeff ];

	// Mie coefficient
	const mieCoeff = totalMie( turbidity );
	const vBetaM = [ mieCoeff[ 0 ] * mieDensity, mieCoeff[ 1 ] * mieDensity, mieCoeff[ 2 ] * mieDensity ];

	// Zenith angle and optical path length
	const fragZenithAngle = Math.acos( Math.max( 0.0, direction[ 1 ] ) );
	const cosZenith = Math.cos( fragZenithAngle );
	const zenithDeg = fragZenithAngle * ( 180.0 / PI );
	const inverseFactor = cosZenith + 0.15 * Math.pow( 93.885 - zenithDeg, - 1.253 );
	const sR = RAYLEIGH_ZENITH_LENGTH / inverseFactor;
	const sM = MIE_ZENITH_LENGTH / inverseFactor;

	// Extinction (Beer's law)
	const Fex = [
		Math.exp( - ( vBetaR[ 0 ] * sR + vBetaM[ 0 ] * sM ) ),
		Math.exp( - ( vBetaR[ 1 ] * sR + vBetaM[ 1 ] * sM ) ),
		Math.exp( - ( vBetaR[ 2 ] * sR + vBetaM[ 2 ] * sM ) )
	];

	// Scattering angle
	const cosViewSun = dot3( direction, vSunDirection );

	// Phase functions
	const rPhase = rayleighPhase( cosViewSun * 0.5 + 0.5 );
	const betaRTheta = [ vBetaR[ 0 ] * rPhase, vBetaR[ 1 ] * rPhase, vBetaR[ 2 ] * rPhase ];

	const mPhase = hgPhase( cosViewSun, mieAnisotropy );
	const betaMTheta = [ vBetaM[ 0 ] * mPhase, vBetaM[ 1 ] * mPhase, vBetaM[ 2 ] * mPhase ];

	// Inscattered light
	const betaSum = [ betaRTheta[ 0 ] + betaMTheta[ 0 ], betaRTheta[ 1 ] + betaMTheta[ 1 ], betaRTheta[ 2 ] + betaMTheta[ 2 ] ];
	const betaRplusM = [ vBetaR[ 0 ] + vBetaM[ 0 ], vBetaR[ 1 ] + vBetaM[ 1 ], vBetaR[ 2 ] + vBetaM[ 2 ] ];

	const Lin = [
		Math.pow( vSunE * ( betaSum[ 0 ] / betaRplusM[ 0 ] ) * ( 1.0 - Fex[ 0 ] ), 1.5 ),
		Math.pow( vSunE * ( betaSum[ 1 ] / betaRplusM[ 1 ] ) * ( 1.0 - Fex[ 1 ] ), 1.5 ),
		Math.pow( vSunE * ( betaSum[ 2 ] / betaRplusM[ 2 ] ) * ( 1.0 - Fex[ 2 ] ), 1.5 )
	];

	// Sunset mix
	const sunsetFactor = Math.max( 0.0, Math.min( 1.0, 1.0 - Math.pow( 1.0 - vSunDirection[ 1 ], 5.0 ) ) );
	const sunsetColor = [
		Math.sqrt( vSunE * ( betaSum[ 0 ] / betaRplusM[ 0 ] ) * Fex[ 0 ] ),
		Math.sqrt( vSunE * ( betaSum[ 1 ] / betaRplusM[ 1 ] ) * Fex[ 1 ] ),
		Math.sqrt( vSunE * ( betaSum[ 2 ] / betaRplusM[ 2 ] ) * Fex[ 2 ] )
	];

	const mixW = 1.0 - sunsetFactor;
	for ( let i = 0; i < 3; i ++ ) {

		const mixVal = 1.0 * ( 1.0 - mixW ) + sunsetColor[ i ] * mixW;
		Lin[ i ] *= mixVal;

	}

	// Base luminance + sun disk
	const L0 = [ 0.1 * Fex[ 0 ], 0.1 * Fex[ 1 ], 0.1 * Fex[ 2 ] ];
	const sundisk = smoothstep( SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, cosViewSun );
	for ( let i = 0; i < 3; i ++ ) {

		L0[ i ] += vSunE * 19000.0 * Fex[ i ] * sundisk;

	}

	// Final color — clamp to half-float max (65504) to avoid overflow
	// in the CDF builder's half-float conversion
	const MAX_HDR = 65504.0;
	return [
		Math.min( ( Lin[ 0 ] + L0[ 0 ] ) * 0.04, MAX_HDR ),
		Math.min( ( Lin[ 1 ] + L0[ 1 ] ) * 0.04 + 0.0003, MAX_HDR ),
		Math.min( ( Lin[ 2 ] + L0[ 2 ] ) * 0.04 + 0.00075, MAX_HDR ),
		1.0
	];

}

function smoothstep( edge0, edge1, x ) {

	const t = Math.max( 0.0, Math.min( 1.0, ( x - edge0 ) / ( edge1 - edge0 ) ) );
	return t * t * ( 3.0 - 2.0 * t );

}

// ── Renderer Class ──

export class ProceduralSky {

	constructor( width = 512, height = 256 ) {

		this.width = width;
		this.height = height;
		this.lastRenderTime = 0;

		// Pre-allocate pixel buffer and DataTexture (reused across renders)
		this._pixels = new Float32Array( width * height * 4 );
		this._texture = new DataTexture( this._pixels, width, height, RGBAFormat, FloatType );
		this._texture.mapping = EquirectangularReflectionMapping;
		this._texture.colorSpace = LinearSRGBColorSpace;
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.wrapS = RepeatWrapping;
		this._texture.wrapT = ClampToEdgeWrapping;
		this._texture.generateMipmaps = false;

	}

	/**
	 * Generate Preetham sky into a reusable DataTexture.
	 * @param {Object} params - Sky parameters
	 * @returns {DataTexture} Equirectangular sky texture with CPU data
	 */
	render( params ) {

		const startTime = performance.now();

		const sunDir = [ params.sunDirection.x, params.sunDirection.y, params.sunDirection.z ];
		const sunIntensity = params.sunIntensity || 1.0;
		const rayleighDensity = params.rayleighDensity || 2.0;
		const mieDensity = params.mieDensity || 0.005;
		const mieAnisotropy = params.mieAnisotropy || 0.8;
		const turbidity = params.turbidity || 2.0;

		const { width, height } = this;
		const pixels = this._pixels;

		for ( let y = 0; y < height; y ++ ) {

			const v = ( y + 0.5 ) / height;

			for ( let x = 0; x < width; x ++ ) {

				const u = ( x + 0.5 ) / width;
				const color = computePreethamPixel( u, v, sunDir, sunIntensity, rayleighDensity, mieDensity, mieAnisotropy, turbidity );

				const idx = ( y * width + x ) * 4;
				pixels[ idx ] = color[ 0 ];
				pixels[ idx + 1 ] = color[ 1 ];
				pixels[ idx + 2 ] = color[ 2 ];
				pixels[ idx + 3 ] = color[ 3 ];

			}

		}

		this._texture.needsUpdate = true;
		// Fresh linear Rec.709 pixels in a reused texture. Colour management records which space a
		// texture's pixels hold so it never converts them twice; left in place, that record would
		// claim these were already converted and they never would be.
		delete this._texture.userData?.__rayzeeColorSpace;
		this.lastRenderTime = performance.now() - startTime;

		return this._texture;

	}

	setResolution( width, height ) {

		if ( this.width === width && this.height === height ) return;
		this.width = width;
		this.height = height;
		this._pixels = new Float32Array( width * height * 4 );
		this._texture.dispose();
		this._texture = new DataTexture( this._pixels, width, height, RGBAFormat, FloatType );
		this._texture.mapping = EquirectangularReflectionMapping;
		this._texture.colorSpace = LinearSRGBColorSpace;
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.wrapS = RepeatWrapping;
		this._texture.wrapT = ClampToEdgeWrapping;
		this._texture.generateMipmaps = false;

	}

	getLastRenderTime() {

		return this.lastRenderTime;

	}

	dispose() {

		this._texture.dispose();

	}

}
