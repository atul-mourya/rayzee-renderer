import { afterAll, beforeAll, expect, it } from 'vitest';
import { Vector3, Vector4 } from 'three';
import { uniform, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { PhysicalSky } from '@/core/Processor/PhysicalSky.js';
import { EquirectHDRInfo } from '@/core/Processor/EquirectHDRInfo.js';
import { atmosphereCoefficients, coneSolidAngle, LAMBDA_COUNT } from '@/core/Processor/AtmosphereModel.js';
import { sunRadianceToward, sampleSunDisc } from '@/core/TSL/Sun.js';
import { depthTable, referenceRadiance, singleScattering, spectrumToEngineRGB } from './skyReference.js';

const AIR = { turbidity: 2, ozone: 300, airDensity: 1, groundAlbedo: [ 0.3, 0.3, 0.3 ] };
const BINS = Array.from( { length: LAMBDA_COUNT }, ( _, k ) => k );
const degrees = d => d * Math.PI / 180;

// Engine azimuth convention (EnvironmentManager / the app's sliders).
const dirOf = ( az, el ) => [ Math.cos( degrees( el ) ) * Math.sin( degrees( az ) ), Math.sin( degrees( el ) ), Math.cos( degrees( el ) ) * Math.cos( degrees( az ) ) ];

// The engine's equirect lookup (TSL/Environment.js equirectDirectionToUv), bilinear.
function sampleSky( { data, width: W, height: H }, d ) {

	const u = Math.atan2( d[ 2 ], d[ 0 ] ) / ( 2 * Math.PI ) + 0.5;
	const v = 1 - Math.acos( Math.min( 1, Math.max( - 1, d[ 1 ] ) ) ) / Math.PI;
	const fx = u * W - 0.5, fy = Math.min( Math.max( v * H - 0.5, 0 ), H - 1.001 );
	const x0 = Math.floor( fx ), y0 = Math.floor( fy ), tx = fx - x0, ty = fy - y0;
	const at = ( x, y, c ) => data[ ( y * W + ( ( x % W ) + W ) % W ) * 4 + c ];
	return [ 0, 1, 2 ].map( c => ( at( x0, y0, c ) * ( 1 - tx ) + at( x0 + 1, y0, c ) * tx ) * ( 1 - ty ) + ( at( x0, y0 + 1, c ) * ( 1 - tx ) + at( x0 + 1, y0 + 1, c ) * tx ) * ty );

}

describeGPU( 'physical sky', () => {

	let renderer;
	const coefficients = atmosphereCoefficients( AIR );
	const depth = depthTable( 256, 2048 );

	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const bake = ( sky, sunEl, sunAz = 0 ) => sky.bake( renderer, { ...AIR, sunDirection: dirOf( sunAz, sunEl ), altitude: 50, sunAngularDiameter: degrees( 0.53 ) } );
	const image = async sky => ( { data: ( await sky.readBack( renderer ) ).pixels, width: sky.width, height: sky.height } );

	it( 'puts the sun where the engine looks it up', async () => {

		const sky = new PhysicalSky( 512, 256 );
		const sun = dirOf( 90, 30 );
		bake( sky, 30, 90 );
		const { data, width, height } = await image( sky );
		let best = 0, at = 0;
		for ( let i = 0; i < width * height; i ++ ) if ( data[ i * 4 + 1 ] > best ) [ best, at ] = [ data[ i * 4 + 1 ], i ];

		const u = ( at % width + 0.5 ) / width, v = ( Math.floor( at / width ) + 0.5 ) / height;
		const theta = ( u - 0.5 ) * 2 * Math.PI, phi = ( 1 - v ) * Math.PI;
		const brightest = [ Math.sin( phi ) * Math.cos( theta ), Math.cos( phi ), Math.sin( phi ) * Math.sin( theta ) ];
		// Same azimuth as the sun; a little below it, where the haze-lit path is longer.
		expect( Math.abs( Math.atan2( brightest[ 0 ], brightest[ 2 ] ) - Math.atan2( sun[ 0 ], sun[ 2 ] ) ) ).toBeLessThan( degrees( 1.5 ) );
		expect( Math.asin( brightest[ 1 ] ) ).toBeGreaterThan( degrees( 30 - 6 ) );
		expect( Math.asin( brightest[ 1 ] ) ).toBeLessThan( degrees( 30 + 1 ) );
		sky.dispose( renderer );

	} );

	it( 'computes single scattering exactly', async () => {

		const sky = new PhysicalSky( 1024, 512, { sky: { multipleScattering: false } } );
		for ( const sunEl of [ 20, 1 ] ) {

			const sun = dirOf( 0, sunEl );
			bake( sky, sunEl );
			const pixels = await image( sky );
			for ( const [ az, el ] of [[ 0, 89.5 ], [ 0, sunEl + 10 ], [ 90, 10 ], [ 180, 5 ], [ 0, 3 ]] ) {

				const view = dirOf( az, el );
				// Clamped like the bake: a saturated sunset colour can fall outside Rec.709.
				const truth = spectrumToEngineRGB( singleScattering( { coefficients, sun, view, altitude: 0.05, bins: BINS, depth } ) ).map( v => Math.max( v, 0 ) );
				const peak = Math.max( ...truth );
				sampleSky( pixels, view ).forEach( ( v, c ) => expect( Math.abs( v - truth[ c ] ) / peak, `sun ${sunEl}°, view ${az}/${el}, channel ${c}` ).toBeLessThan( 0.015 ) );

			}

		}

		sky.dispose( renderer );

	} );

	it( 'matches a Monte Carlo reference with every order of scattering and the ground', async () => {

		const sky = new PhysicalSky( 1024, 512 );
		const cases = [[ 20, 0, 89.5 ], [ 20, 90, 10 ], [ 20, 180, 5 ], [ 20, 90, - 30 ], [ 2, 90, 10 ], [ 2, 0, 3 ]];
		let baked = null, pixels;
		for ( const [ sunEl, az, el ] of cases ) {

			if ( baked !== sunEl ) {

				bake( sky, sunEl );
				pixels = await image( sky );

			}

			baked = sunEl;
			const view = dirOf( az, el );
			const truth = spectrumToEngineRGB( referenceRadiance( { coefficients, sun: dirOf( 0, sunEl ), view, altitude: 0.05, bins: BINS, paths: 12000, depth } ) ).map( v => Math.max( v, 0 ) );
			const peak = Math.max( ...truth );
			sampleSky( pixels, view ).forEach( ( v, c ) => {

				const error = ( v - truth[ c ] ) / peak;
				expect( error, `sun ${sunEl}°, view ${az}/${el}, channel ${c}` ).toBeGreaterThan( - 0.12 );
				expect( error, `sun ${sunEl}°, view ${az}/${el}, channel ${c}` ).toBeLessThan( 0.08 );

			} );

		}

		sky.dispose( renderer );

	}, 120000 );

	it( 'stays finite and non-negative from noon to night and in extreme air', async () => {

		const sky = new PhysicalSky( 256, 128 );
		for ( const [ sunEl, air ] of [[ 90, AIR ], [ - 20, AIR ], [ 5, { ...AIR, turbidity: 10, ozone: 0, airDensity: 3 } ], [ 5, { ...AIR, turbidity: 1, ozone: 600, airDensity: 0, groundAlbedo: [ 1, 1, 1 ] } ]] ) {

			sky.bake( renderer, { ...air, sunDirection: dirOf( 0, sunEl ), altitude: 8000, sunAngularDiameter: degrees( 5 ) } );
			const bad = ( await image( sky ) ).data.filter( v => ! Number.isFinite( v ) || v < 0 ).length;
			expect( bad, `sun ${sunEl}°` ).toBe( 0 );

		}

		sky.dispose( renderer );

	} );

	it( 'builds the importance-sampling table the CPU builder would', async () => {

		const sky = new PhysicalSky( 512, 256 );
		for ( const sunEl of [ 30, 2, - 20 ] ) {

			const { stats } = bake( sky, sunEl );
			const { totalSum, compensationDelta } = await stats;
			const { pixels, cdf, cdfStride } = await sky.readBack( renderer );
			const cpu = EquirectHDRInfo.computeCDF( pixels, sky.width, sky.height );
			expect( totalSum / cpu.totalSum, `sun ${sunEl}°` ).toBeCloseTo( 1, 4 );
			expect( compensationDelta / cpu.compensationDelta, `sun ${sunEl}°` ).toBeCloseTo( 1, 4 );

			// f32 against f64 sums can land a search one texel over at a tie. The whole-row target is
			// skipped: the CPU's normalised sums can end short of 1 and pick the last texel.
			let off = 0, worst = 0;
			const compare = ( gpu, ref, n ) => {

				const d = Math.abs( gpu - ref ) * n;
				if ( d > 0.01 ) off ++;
				worst = Math.max( worst, d );

			};

			for ( let y = 0; y < sky.height; y ++ ) {

				if ( y < sky.height - 1 ) compare( cdf[ y * cdfStride + sky.width ], cpu.marginalData[ y ], sky.height );
				for ( let x = 0; x < sky.width - 1; x ++ ) compare( cdf[ y * cdfStride + x ], cpu.conditionalData[ y * sky.width + x ], sky.width );

			}

			expect( off / ( sky.width * sky.height ), `sun ${sunEl}°` ).toBeLessThan( 1e-3 );
			expect( worst, `sun ${sunEl}°` ).toBeLessThan( 1.01 );

		}

		sky.dispose( renderer );

	} );

	it( 'draws a limb-darkened disc whose mean is the light the sun NEE uses', async () => {

		const halfAngle = degrees( 0.265 );
		const sunDirection = uniform( new Vector3( 0.3, 0.8, 0.2 ).normalize() );
		const sunRadiance = uniform( new Vector3( 2, 3, 4 ) );
		const sunParams = uniform( new Vector4( Math.cos( halfAngle ), coneSolidAngle( halfAngle ), 1 / Math.sin( halfAngle ) ** 2, 0 ) );

		const n = 64 * 64;
		const xi = new Float32Array( n * 2 );
		for ( let i = 0; i < n; i ++ ) {

			xi[ i * 2 ] = ( ( i % 64 ) + 0.5 ) / 64;
			xi[ i * 2 + 1 ] = ( Math.floor( i / 64 ) + 0.5 ) / 64;

		}

		const out = new Float32Array( await evaluate( renderer, n, { xi: [ xi, 'vec2' ] }, 'vec4', a => {

			const d = sampleSunDisc( sunDirection, sunParams, a.xi );
			return vec4( sunRadianceToward( d, sunDirection, sunRadiance, sunParams ), 0 );

		} ) );

		const mean = [ 0, 1, 2 ].map( c => {

			let s = 0;
			for ( let i = 0; i < n; i ++ ) s += out[ i * 4 + c ];
			return s / n;

		} );
		[ 2, 3, 4 ].forEach( ( v, c ) => expect( mean[ c ] / v ).toBeCloseTo( 1, 2 ) );

		// Nothing outside the disc, nor below the sky's horizon.
		const outside = await evaluate( renderer, 2, { d: [ new Float32Array( [ 0.35, 0.8, 0.2, 0, - 0.01, 1 ] ), 'vec3' ] }, 'vec4', a => vec4( sunRadianceToward( a.d.normalize(), sunDirection, sunRadiance, sunParams ), 0 ) );
		expect( [ ...new Float32Array( outside ) ].every( v => v === 0 ) ).toBe( true );

	} );

} );
