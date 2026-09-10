import { describe, it, expect } from 'vitest';
import { TONE_MAP_FNS, SRGB_GAMMA, applySaturation, effectiveExposure } from '@/core/Processor/ToneMapCPU.js';

// Three.js tone mapping constants (same values as Three.js exports)
const NoToneMapping = 0;
const LinearToneMapping = 1;
const ReinhardToneMapping = 2;
const CineonToneMapping = 3;
const ACESFilmicToneMapping = 4;
const AgXToneMapping = 6;
const NeutralToneMapping = 7;

// ── TONE_MAP_FNS registry ───────────────────────────────────────

describe( 'TONE_MAP_FNS', () => {

	it( 'contains all 7 tone mapping methods', () => {

		expect( TONE_MAP_FNS.size ).toBe( 7 );

	} );

	it( 'maps correct Three.js constants', () => {

		expect( TONE_MAP_FNS.has( NoToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( LinearToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( ReinhardToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( CineonToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( ACESFilmicToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( AgXToneMapping ) ).toBe( true );
		expect( TONE_MAP_FNS.has( NeutralToneMapping ) ).toBe( true );

	} );

} );

// ── SRGB_GAMMA ──────────────────────────────────────────────────

describe( 'SRGB_GAMMA', () => {

	it( 'is approximately 0.4545 (1/2.2)', () => {

		expect( SRGB_GAMMA ).toBeCloseTo( 1 / 2.2, 5 );

	} );

} );

// ── NoToneMapping ───────────────────────────────────────────────

describe( 'noToneMap', () => {

	const fn = TONE_MAP_FNS.get( NoToneMapping );

	it( 'clamps to [0,1] without modifying values in range', () => {

		const out = new Float32Array( 3 );
		fn( 0.5, 0.3, 0.8, 1.0, out );
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );
		expect( out[ 1 ] ).toBeCloseTo( 0.3 );
		expect( out[ 2 ] ).toBeCloseTo( 0.8 );

	} );

	it( 'clamps negative values to 0', () => {

		const out = new Float32Array( 3 );
		fn( - 1, - 0.5, - 2, 1.0, out );
		expect( out[ 0 ] ).toBe( 0 );
		expect( out[ 1 ] ).toBe( 0 );
		expect( out[ 2 ] ).toBe( 0 );

	} );

	it( 'clamps values above 1 to 1', () => {

		const out = new Float32Array( 3 );
		fn( 2, 5, 100, 1.0, out );
		expect( out[ 0 ] ).toBe( 1 );
		expect( out[ 1 ] ).toBe( 1 );
		expect( out[ 2 ] ).toBe( 1 );

	} );

	it( 'ignores exposure parameter', () => {

		const out = new Float32Array( 3 );
		fn( 0.5, 0.5, 0.5, 100, out );
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );

	} );

} );

// ── LinearToneMapping ───────────────────────────────────────────

describe( 'linearToneMap', () => {

	const fn = TONE_MAP_FNS.get( LinearToneMapping );

	it( 'scales by exposure', () => {

		const out = new Float32Array( 3 );
		fn( 0.5, 0.5, 0.5, 2.0, out );
		expect( out[ 0 ] ).toBeCloseTo( 1.0 );
		expect( out[ 1 ] ).toBeCloseTo( 1.0 );
		expect( out[ 2 ] ).toBeCloseTo( 1.0 );

	} );

	it( 'exposure 1.0 passes through', () => {

		const out = new Float32Array( 3 );
		fn( 0.3, 0.6, 0.9, 1.0, out );
		expect( out[ 0 ] ).toBeCloseTo( 0.3 );
		expect( out[ 1 ] ).toBeCloseTo( 0.6 );
		expect( out[ 2 ] ).toBeCloseTo( 0.9 );

	} );

	it( 'clamps result to [0,1]', () => {

		const out = new Float32Array( 3 );
		fn( 1.0, 1.0, 1.0, 5.0, out );
		expect( out[ 0 ] ).toBe( 1 );
		expect( out[ 1 ] ).toBe( 1 );
		expect( out[ 2 ] ).toBe( 1 );

	} );

} );

// ── ReinhardToneMapping ─────────────────────────────────────────

describe( 'reinhardToneMap', () => {

	const fn = TONE_MAP_FNS.get( ReinhardToneMapping );

	it( 'maps 1.0 to 0.5 with exposure 1.0', () => {

		const out = new Float32Array( 3 );
		fn( 1.0, 1.0, 1.0, 1.0, out );
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );
		expect( out[ 1 ] ).toBeCloseTo( 0.5 );
		expect( out[ 2 ] ).toBeCloseTo( 0.5 );

	} );

	it( 'maps 0.0 to 0.0', () => {

		const out = new Float32Array( 3 );
		fn( 0, 0, 0, 1.0, out );
		expect( out[ 0 ] ).toBe( 0 );

	} );

	it( 'asymptotically approaches 1.0 for large values', () => {

		const out = new Float32Array( 3 );
		fn( 1000, 1000, 1000, 1.0, out );
		expect( out[ 0 ] ).toBeGreaterThan( 0.99 );
		expect( out[ 0 ] ).toBeLessThanOrEqual( 1.0 );

	} );

	it( 'applies exposure before mapping', () => {

		const out = new Float32Array( 3 );
		fn( 0.5, 0.5, 0.5, 2.0, out );
		// 0.5 * 2 = 1.0 → 1/(1+1) = 0.5
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );

	} );

} );

// ── CineonToneMapping ───────────────────────────────────────────

describe( 'cineonToneMap', () => {

	const fn = TONE_MAP_FNS.get( CineonToneMapping );

	it( 'outputs values in [0,1] for typical HDR input', () => {

		const out = new Float32Array( 3 );
		fn( 1.0, 0.5, 2.0, 1.0, out );
		for ( let i = 0; i < 3; i ++ ) {

			expect( out[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( out[ i ] ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'maps very small values near zero', () => {

		const out = new Float32Array( 3 );
		fn( 0.001, 0.001, 0.001, 1.0, out );
		expect( out[ 0 ] ).toBeCloseTo( 0, 1 );

	} );

} );

// ── ACESFilmicToneMapping ───────────────────────────────────────

describe( 'acesFilmicToneMap', () => {

	const fn = TONE_MAP_FNS.get( ACESFilmicToneMapping );

	it( 'outputs values in [0,1] for typical input', () => {

		const out = new Float32Array( 3 );
		fn( 1.0, 1.0, 1.0, 1.0, out );
		for ( let i = 0; i < 3; i ++ ) {

			expect( out[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( out[ i ] ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'maps black to near-black', () => {

		const out = new Float32Array( 3 );
		fn( 0, 0, 0, 1.0, out );
		for ( let i = 0; i < 3; i ++ ) {

			expect( out[ i ] ).toBeCloseTo( 0, 2 );

		}

	} );

	it( 'applies exposure scaling', () => {

		const out1 = new Float32Array( 3 );
		const out2 = new Float32Array( 3 );
		fn( 0.5, 0.5, 0.5, 1.0, out1 );
		fn( 0.5, 0.5, 0.5, 2.0, out2 );
		// Higher exposure should produce brighter output
		expect( out2[ 0 ] ).toBeGreaterThan( out1[ 0 ] );

	} );

} );

// ── AgXToneMapping ──────────────────────────────────────────────

describe( 'agxToneMap', () => {

	const fn = TONE_MAP_FNS.get( AgXToneMapping );

	it( 'outputs values in [0,1] for typical input', () => {

		const out = new Float32Array( 3 );
		fn( 1.0, 0.8, 0.6, 1.0, out );
		for ( let i = 0; i < 3; i ++ ) {

			expect( out[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( out[ i ] ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'handles very bright HDR values', () => {

		const out = new Float32Array( 3 );
		fn( 10, 10, 10, 1.0, out );
		for ( let i = 0; i < 3; i ++ ) {

			expect( out[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( out[ i ] ).toBeLessThanOrEqual( 1 );

		}

	} );

} );

// ── NeutralToneMapping ──────────────────────────────────────────

describe( 'neutralToneMap', () => {

	const fn = TONE_MAP_FNS.get( NeutralToneMapping );

	it( 'passes through low values unmodified', () => {

		const out = new Float32Array( 3 );
		fn( 0.1, 0.1, 0.1, 1.0, out );
		// Below StartCompression (0.76), should pass through after offset
		expect( out[ 0 ] ).toBeGreaterThan( 0 );
		expect( out[ 0 ] ).toBeLessThan( 0.2 );

	} );

	it( 'compresses highlights', () => {

		const out = new Float32Array( 3 );
		fn( 2.0, 2.0, 2.0, 1.0, out );
		// Should compress but stay below 1.0
		expect( out[ 0 ] ).toBeGreaterThan( 0.5 );
		expect( out[ 0 ] ).toBeLessThanOrEqual( 1.0 );

	} );

	it( 'applies exposure before compression', () => {

		const out1 = new Float32Array( 3 );
		const out2 = new Float32Array( 3 );
		fn( 0.5, 0.5, 0.5, 1.0, out1 );
		fn( 0.5, 0.5, 0.5, 3.0, out2 );
		expect( out2[ 0 ] ).toBeGreaterThan( out1[ 0 ] );

	} );

} );

// ── applySaturation ─────────────────────────────────────────────

describe( 'applySaturation', () => {

	it( 'saturation 1.0 is a no-op', () => {

		const out = new Float32Array( [ 0.5, 0.3, 0.8 ] );
		applySaturation( out, 1.0 );
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );
		expect( out[ 1 ] ).toBeCloseTo( 0.3 );
		expect( out[ 2 ] ).toBeCloseTo( 0.8 );

	} );

	it( 'saturation 0.0 produces grayscale (luminance)', () => {

		const out = new Float32Array( [ 1.0, 0.0, 0.0 ] );
		applySaturation( out, 0.0 );
		// Luminance of pure red = 0.2126
		const expectedLuma = 0.2126;
		expect( out[ 0 ] ).toBeCloseTo( expectedLuma );
		expect( out[ 1 ] ).toBeCloseTo( expectedLuma );
		expect( out[ 2 ] ).toBeCloseTo( expectedLuma );

	} );

	it( 'saturation > 1.0 increases color difference from gray', () => {

		const out = new Float32Array( [ 0.8, 0.2, 0.2 ] );
		const original = [ ...out ];
		applySaturation( out, 2.0 );
		// Red channel should be pushed further from gray
		expect( Math.abs( out[ 0 ] - 0.5 ) ).toBeGreaterThan( Math.abs( original[ 0 ] - 0.5 ) );

	} );

	it( 'uses Rec.709 luminance coefficients', () => {

		// White (equal channels) should not change regardless of saturation
		const out = new Float32Array( [ 0.5, 0.5, 0.5 ] );
		applySaturation( out, 0.0 );
		expect( out[ 0 ] ).toBeCloseTo( 0.5 );
		expect( out[ 1 ] ).toBeCloseTo( 0.5 );
		expect( out[ 2 ] ).toBeCloseTo( 0.5 );

	} );

} );

// ── effectiveExposure ───────────────────────────────────────────

describe( 'effectiveExposure', () => {

	it( 'drops exposure under NoToneMapping', () => {

		// ToneMappingNode returns the colour untouched for NoToneMapping, so the GPU never
		// applies toneMappingExposure there. A readback that does paints brighter than the
		// viewport it replaces.
		expect( effectiveExposure( 2.0, NoToneMapping ) ).toBe( 1.0 );

	} );

	it( 'passes exposure through for every tone-mapped configuration', () => {

		for ( const tm of [ LinearToneMapping, ReinhardToneMapping, CineonToneMapping,
			ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping ] ) {

			expect( effectiveExposure( 2.0, tm ) ).toBe( 2.0 );

		}

	} );

} );

// ── negative-input clamp ────────────────────────────────────────

describe( 'negative channel clamping', () => {

	// Three.js clamps the fragment output with `.max( 0 )` before tone mapping, and the
	// Compositor's saturation grade routinely drives complementary channels negative.
	// AgX and Neutral mix negatives across channels rather than clipping them, so an
	// unclamped readback diverges from the viewport by several levels in shadow.
	const NEGATIVE = [ - 0.4, 0.3, - 0.05 ];
	const CLAMPED = [ 0, 0.3, 0 ];

	for ( const [ name, tm ] of [
		[ 'NoToneMapping', NoToneMapping ],
		[ 'Linear', LinearToneMapping ],
		[ 'Reinhard', ReinhardToneMapping ],
		[ 'Cineon', CineonToneMapping ],
		[ 'ACESFilmic', ACESFilmicToneMapping ],
		[ 'AgX', AgXToneMapping ],
		[ 'Neutral', NeutralToneMapping ],
	] ) {

		it( `${name} treats a negative channel as zero`, () => {

			const fn = TONE_MAP_FNS.get( tm );
			const withNeg = new Float32Array( 3 );
			const preClamped = new Float32Array( 3 );

			fn( ...NEGATIVE, 1.0, withNeg );
			fn( ...CLAMPED, 1.0, preClamped );

			for ( let c = 0; c < 3; c ++ ) expect( withNeg[ c ] ).toBeCloseTo( preClamped[ c ], 6 );

		} );

	}

	it( 'never emits a negative channel', () => {

		for ( const fn of TONE_MAP_FNS.values() ) {

			const out = new Float32Array( 3 );
			fn( - 1.5, - 0.2, - 0.001, 1.0, out );
			for ( let c = 0; c < 3; c ++ ) expect( out[ c ] ).toBeGreaterThanOrEqual( 0 );

		}

	} );

} );
