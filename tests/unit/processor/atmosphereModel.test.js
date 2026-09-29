import { describe, it, expect } from 'vitest';
import {
	SOLAR_SPECTRUM, WAVELENGTHS, SKY_RADIANCE_SCALE, LIMB_DARKENING_EXPONENT, LAMBDA_COUNT,
	spectrumToXYZ, xyzToRec709, spectrumToRec709, atmosphereCoefficients, angstromBeta,
	opticalDepth, sunLight, horizonDipSin, coneSolidAngle, phaseCellWeights,
} from '@/core/Processor/AtmosphereModel.js';

const bin = nm => WAVELENGTHS.findIndex( l => Math.abs( l - nm ) <= 12.5 );
const luminance = ( [ r, g, b ] ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const degrees = d => d * Math.PI / 180;
const sunAt = el => [ Math.cos( degrees( el ) ), Math.sin( degrees( el ) ), 0 ];

describe( 'atmosphere spectra', () => {

	it( 'puts the sun above the atmosphere at its measured illuminance and colour', () => {

		const [ X, Y, Z ] = spectrumToXYZ( SOLAR_SPECTRUM );
		expect( Y * 683 ).toBeGreaterThan( 128000 );
		expect( Y * 683 ).toBeLessThan( 135000 );
		expect( X / ( X + Y + Z ) ).toBeCloseTo( 0.322, 2 );
		expect( Y / ( X + Y + Z ) ).toBeCloseTo( 0.331, 2 );

	} );

	it( 'converts a spectrum to Rec.709 the same way through XYZ and through the matrix', () => {

		const m = spectrumToRec709();
		const direct = [ 0, 1, 2 ].map( c => SOLAR_SPECTRUM.reduce( ( s, v, k ) => s + v * m[ c * LAMBDA_COUNT + k ], 0 ) );
		xyzToRec709( spectrumToXYZ( SOLAR_SPECTRUM ) ).forEach( ( v, c ) => expect( direct[ c ] / v ).toBeCloseTo( 1, 6 ) );

	} );

} );

describe( 'atmosphere coefficients', () => {

	const c = atmosphereCoefficients( { turbidity: 2, ozone: 300 } );
	const [ tr, tm, to ] = opticalDepth( 0, 1 );

	it( 'integrates the density profiles straight up to their closed forms', () => {

		expect( tr ).toBeCloseTo( 8 * ( 1 - Math.exp( - 60 / 8 ) ), 3 );
		expect( tm ).toBeCloseTo( 1.2, 3 );
		expect( to ).toBeCloseTo( 15, 2 );

	} );

	it( 'gives the standard atmosphere its measured Rayleigh depth (Bodhaine 1999: 0.0973 at 550 nm)', () => {

		// The 530–555 nm bin averages to 0.103; the 555–580 nm one to 0.085.
		expect( c.rayleigh[ bin( 542.5 ) ] * tr ).toBeCloseTo( 0.103, 2 );
		expect( c.rayleigh[ bin( 567.5 ) ] * tr ).toBeCloseTo( 0.085, 2 );

	} );

	it( 'puts 300 DU of ozone at its Chappuis-band depth', () => {

		expect( c.ozone[ bin( 600 ) ] * to ).toBeGreaterThan( 0.03 );
		expect( c.ozone[ bin( 600 ) ] * to ).toBeLessThan( 0.045 );

	} );

	it( 'maps turbidity to aerosol depth: 1 is clean air, 2 a clear day', () => {

		expect( angstromBeta( 1 ) ).toBeLessThan( 0.001 );
		const aod = c.mieExtinction[ bin( 555 ) ] * tm;
		expect( aod ).toBeGreaterThan( 0.08 );
		expect( aod ).toBeLessThan( 0.12 );
		expect( c.mieExtinction[ bin( 440 ) ] ).toBeGreaterThan( c.mieExtinction[ bin( 680 ) ] );

	} );

	it( 'keeps a grey ground grey in every bin', () => {

		const { albedo } = atmosphereCoefficients( { groundAlbedo: [ 0.3, 0.3, 0.3 ] } );
		albedo.forEach( a => expect( a ).toBeCloseTo( 0.3, 6 ) );

	} );

	it( 'refuses a path into the ground', () => {

		expect( opticalDepth( 0.05, - 0.5 ) ).toBeNull();

	} );

} );

describe( 'sunLight', () => {

	const coefficients = atmosphereCoefficients( { turbidity: 2 } );
	const light = el => sunLight( { direction: sunAt( el ), altitude: 0.05, angularDiameter: degrees( 0.53 ), coefficients } );
	const irradiance = s => s.radiance.map( v => v * s.solidAngle * s.visibleFraction / SKY_RADIANCE_SCALE );

	it( 'lands near 100 klux of direct sun at noon', () => {

		const klux = luminance( irradiance( light( 70 ) ) ) * 683 / 1000;
		expect( klux ).toBeGreaterThan( 90 );
		expect( klux ).toBeLessThan( 110 );

	} );

	it( 'grows warmer and dimmer as it sinks', () => {

		const elevations = [ 60, 20, 5, 1 ];
		const suns = elevations.map( el => irradiance( light( el ) ) );
		for ( let i = 1; i < suns.length; i ++ ) {

			expect( luminance( suns[ i ] ) ).toBeLessThan( luminance( suns[ i - 1 ] ) );
			expect( suns[ i ][ 2 ] / suns[ i ][ 0 ] ).toBeLessThan( suns[ i - 1 ][ 2 ] / suns[ i - 1 ][ 0 ] );

		}

	} );

	it( 'is gone once the whole disc is below the horizon', () => {

		const s = light( - 1 );
		expect( s.visibleFraction ).toBe( 0 );
		expect( s.radiance ).toEqual( [ 0, 0, 0 ] );

	} );

	it( 'counts only the part of a setting disc above the horizon', () => {

		const s = sunLight( { direction: sunAt( - 0.227 ), altitude: 0.05, angularDiameter: degrees( 0.53 ), coefficients } );
		expect( s.visibleFraction ).toBeGreaterThan( 0.3 );
		expect( s.visibleFraction ).toBeLessThan( 0.7 );

	} );

} );

describe( 'geometry helpers', () => {

	it( 'dips the horizon by the planet-curvature angle', () => {

		expect( horizonDipSin( 0 ) ).toBe( 0 );
		expect( Math.asin( horizonDipSin( 1 ) ) * 180 / Math.PI ).toBeCloseTo( 1.015, 2 );

	} );

	it( 'computes small solid angles without cancellation', () => {

		const r = degrees( 0.265 );
		expect( coneSolidAngle( r ) / ( Math.PI * r * r ) ).toBeCloseTo( 1, 5 );

	} );

	it( 'orders the limb darkening exponents red < green < blue', () => {

		const [ r, g, b ] = LIMB_DARKENING_EXPONENT;
		expect( r ).toBeLessThan( g );
		expect( g ).toBeLessThan( b );
		expect( r ).toBeGreaterThan( 0.4 );
		expect( b ).toBeLessThan( 0.65 );

	} );

} );

describe( 'phaseCellWeights', () => {

	const views = 4, phis = 3, bands = 8, sectors = 4;
	const w = phaseCellWeights( views, phis, bands, sectors, 4 );
	const cells = bands * sectors;

	it( 'normalises every row', () => {

		for ( let row = 0; row < 2 * views * phis; row ++ ) {

			const sum = w.slice( row * cells, ( row + 1 ) * cells ).reduce( ( a, b ) => a + b, 0 );
			expect( sum ).toBeCloseTo( 1, 5 );

		}

	} );

	it( 'weights Mie toward the cell the view looks along', () => {

		// Straight up: all of the forward lobe sits in the top band.
		const row = ( views * phis + ( views - 1 ) * phis ) * cells;
		const topBand = w.slice( row + ( bands - 1 ) * sectors, row + bands * sectors ).reduce( ( a, b ) => a + b, 0 );
		const bottomBand = w.slice( row, row + sectors ).reduce( ( a, b ) => a + b, 0 );
		expect( topBand ).toBeGreaterThan( 5 * bottomBand );

	} );

} );
