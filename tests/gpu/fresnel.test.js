import { afterAll, beforeAll, expect, it } from 'vitest';
import { float } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { fresnelDielectric, dielectricFresnelWeight, iorToFresnel0 } from '@/core/TSL/Fresnel.js';

// Unpolarised Fresnel reflectance of a smooth dielectric, eta = n_t / n_i.
function exactFresnel( cosI, eta ) {

	const c = Math.min( Math.max( cosI, 0 ), 1 );
	const g2 = eta * eta - 1 + c * c;
	if ( g2 <= 0 ) return 1;
	const g = Math.sqrt( g2 );
	const A = ( g - c ) / ( g + c );
	const B = ( c * ( g + c ) - 1 ) / ( c * ( g - c ) + 1 );
	return 0.5 * A * A * ( 1 + B * B );

}

const ETAS = [ 1 / 2.4, 1 / 1.5, 1 / 1.33, 1, 1.33, 1.5, 2.4 ];
const STEPS = 257;
const cosI = new Float32Array( ETAS.length * STEPS );
const eta = new Float32Array( ETAS.length * STEPS );
ETAS.forEach( ( e, j ) => {

	for ( let i = 0; i < STEPS; i ++ ) {

		cosI[ j * STEPS + i ] = i / ( STEPS - 1 );
		eta[ j * STEPS + i ] = e;

	}

} );

const inputs = { cosI: [ cosI, 'float' ], eta: [ eta, 'float' ] };

describeGPU( 'dielectric Fresnel on the GPU', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'fresnelDielectric is the exact curve, total internal reflection included', async () => {

		const F = new Float32Array( await evaluate( renderer, cosI.length, inputs, 'float', a => fresnelDielectric( a.cosI, a.eta ) ) );

		for ( let i = 0; i < F.length; i ++ ) {

			expect( F[ i ], `cos ${cosI[ i ]}, eta ${eta[ i ]}` ).toBeCloseTo( exactFresnel( cosI[ i ], eta[ i ] ), 5 );

		}

	} );

	it( 'dielectricFresnelWeight rebuilds the exact curve as mix( F0, 1, weight )', async () => {

		const count = cosI.length;
		const [ w, f0 ] = await Promise.all( [
			evaluate( renderer, count, inputs, 'float', a => dielectricFresnelWeight( a.cosI, a.eta ) ),
			evaluate( renderer, count, inputs, 'float', a => iorToFresnel0( a.eta, float( 1 ) ) ),
		] ).then( buffers => buffers.map( b => new Float32Array( b ) ) );

		for ( let i = 0; i < count; i ++ ) {

			if ( eta[ i ] === 1 ) continue; // F0 = 1 - F0 = 0: the weight is undefined there

			const rebuilt = f0[ i ] + ( 1 - f0[ i ] ) * w[ i ];
			expect( rebuilt, `cos ${cosI[ i ]}, eta ${eta[ i ]}` ).toBeCloseTo( exactFresnel( cosI[ i ], eta[ i ] ), 5 );

		}

		expect( w[ STEPS - 1 + 5 * STEPS ] ).toBeCloseTo( 0, 6 ); // eta 1.5, head-on
		expect( w[ 5 * STEPS ] ).toBeCloseTo( 1, 6 ); // eta 1.5, grazing

	} );

} );
