import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { vec4 } from 'three/tsl';
import { iorFromWavelength, sampleWavelengthForDispersion, SpectralSample } from '@/core/shaders/MaterialTransmission.js';

// glTF's dispersion is 20 / the Abbe number ( n_d − 1 ) / ( n_F − n_C ), `ior` being n_d: KHR_materials_dispersion.
const F = 486.134, D = 587.562, C = 656.281;
const CASES = [[ 1.5, 1 ], [ 1.62, 0.4 ], [ 2.4, 0.5 ], [ 3.389, 0.407 ], [ 1.5, 0 ]];
const LINES = [ F, D, C ];
const ior = new Float32Array( CASES.flatMap( ( [ n ] ) => LINES.map( () => n ) ) );
const dispersion = new Float32Array( CASES.flatMap( ( [ , d ] ) => LINES.map( () => d ) ) );
const wavelength = new Float32Array( CASES.flatMap( () => LINES ) );

describeGPU( 'dispersion on the GPU', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'gives the IOR at the d line and spreads the F and C lines by ( ior − 1 ) · dispersion / 20', async () => {

		const n = new Float32Array( await evaluate( renderer, ior.length, {
			ior: [ ior, 'float' ], dispersion: [ dispersion, 'float' ], wavelength: [ wavelength, 'float' ],
		}, 'float', a => iorFromWavelength( a.ior, a.dispersion, a.wavelength ) ) );

		CASES.forEach( ( [ nd, d ], i ) => {

			const [ nF, nD, nC ] = n.slice( i * 3, i * 3 + 3 );
			expect( nD ).toBeCloseTo( nd, 5 );
			expect( nF - nC ).toBeCloseTo( ( nd - 1 ) * d / 20, 5 );
			if ( d > 0 ) expect( nF ).toBeGreaterThan( nC );

		} );

	} );

	it( 'draws wavelengths whose colour weights average to white, with the variance the lobes were fitted to', async () => {

		// Evenly spread draws stand in for the stratified ones a pixel takes over its samples.
		const N = 4096;
		const random = Float32Array.from( { length: N }, ( _, i ) => ( i + 0.5 ) / N );
		const out = new Float32Array( await evaluate( renderer, N, { random: [ random, 'float' ] }, 'vec4', a => {

			const drawn = SpectralSample.wrap( sampleWavelengthForDispersion( 1.5, 0.5, a.random ) );
			return vec4( drawn.colorWeight, drawn.wavelength );

		} ) );

		const mean = [ 0, 0, 0 ], square = [ 0, 0, 0 ];
		for ( let i = 0; i < N; i ++ ) for ( let c = 0; c < 3; c ++ ) {

			const w = out[ i * 4 + c ];
			expect( Number.isFinite( w ) && w >= 0 ).toBe( true );
			mean[ c ] += w / N;
			square[ c ] += w * w / N;

		}

		mean.forEach( ( m ) => expect( m ).toBeCloseTo( 1, 2 ) );
		// 7.53 together when drawn evenly over 380–700 nm.
		[ 1.461, 1.423, 1.707 ].forEach( ( v, c ) => expect( Math.abs( square[ c ] - mean[ c ] ** 2 - v ) ).toBeLessThan( 0.05 ) );

	} );

} );
