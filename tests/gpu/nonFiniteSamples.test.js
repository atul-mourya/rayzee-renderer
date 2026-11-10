/**
 * FinalWrite drops a NaN or infinite sample to black, as pbrt's film does (`dropNonFinite`), and counts it: averaged in,
 * one such sample stayed in its pixel for the rest of the render.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { vec3 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { dropNonFinite } from '@/core/shaders/kernels/FinalWriteKernel.js';

describeGPU( 'non-finite samples', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'drops a sample with any NaN or infinite channel and keeps every finite one exactly', async () => {

		const F32_MAX = 3.4028234663852886e38;
		const values = [ 0, - 0, 1, 0.5, - 2, 1e-45, 1.17549435e-38, 1e30, 1e38, F32_MAX, - F32_MAX, NaN, Infinity, - Infinity ];
		const samples = [];
		for ( const v of values ) for ( let channel = 0; channel < 3; channel ++ ) {

			const s = [ 0.25, 0.5, 0.75 ];
			s[ channel ] = v;
			samples.push( s );

		}

		const x = Float32Array.from( samples, s => s[ 0 ] );
		const y = Float32Array.from( samples, s => s[ 1 ] );
		const z = Float32Array.from( samples, s => s[ 2 ] );
		const out = new Float32Array( await evaluate( renderer, samples.length, { x: [ x, 'float' ], y: [ y, 'float' ], z: [ z, 'float' ] }, 'vec4',
			( a ) => dropNonFinite( vec3( a.x, a.y, a.z ) ) ) );

		samples.forEach( ( _, i ) => {

			const got = Array.from( out.subarray( i * 4, i * 4 + 4 ) );
			const stored = [ x[ i ], y[ i ], z[ i ] ];
			if ( stored.every( Number.isFinite ) ) expect( got ).toEqual( [ ...stored, 0 ] );
			else expect( got ).toEqual( [ 0, 0, 0, 1 ] );

		} );

	} );

} );
