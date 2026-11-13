import { afterAll, beforeAll, expect, it } from 'vitest';
import { int, uint, vec2, float } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { getRandomSample2D, getRandomSample1D, samplingTechniqueUniform } from '@/core/shaders/Random.js';

// The sampler seed scrambles each pixel's sequence: seed 0 is the unseeded sampler bit for bit, another seed another
// sequence, the same seed the same one.
const W = 64, H = 16, N = W * H;
const px = new Float32Array( N ), py = new Float32Array( N );
for ( let i = 0; i < N; i ++ ) {

	px[ i ] = ( i % W ) + 0.5;
	py[ i ] = Math.floor( i / W ) + 0.5;

}

const inputs = { x: [ px, 'float' ], y: [ py, 'float' ] };
const draw = ( { x, y } ) => {

	const pixel = vec2( x, y );
	const resolution = vec2( float( W ), float( H ) );
	const rng = uint( 1 ).toVar();
	// Sample 1000: early Halton points have few digits, and two scrambles of them often agree by chance.
	const xy = getRandomSample2D( pixel, int( 0 ), int( 3 ), rng, resolution, int( 1000 ) );
	const z = getRandomSample1D( pixel, int( 0 ), int( 7 ), rng, resolution, int( 1000 ) );
	return vec2( xy.x.add( z ), xy.y );

};

describeGPU( 'sampler seed', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => {

		samplingTechniqueUniform.value = 0;
		renderer?.dispose();

	} );

	for ( const [ technique, name ] of [[ 2, 'Sobol' ], [ 1, 'Halton' ]] ) {

		it( `${name}: seed 0 is the unseeded sampler, another seed another sequence`, async () => {

			samplingTechniqueUniform.value = technique;
			const run = async ( samplerSeed ) => new Float32Array( await evaluate( renderer, N, inputs, 'vec2', draw, samplerSeed === null ? null : { samplerSeed } ) );
			const [ none, zero, seven, sevenAgain ] = [ await run( null ), await run( 0 ), await run( 7 ), await run( 7 ) ];

			expect( zero ).toEqual( none );
			expect( sevenAgain ).toEqual( seven );
			let same = 0;
			for ( let i = 0; i < seven.length; i ++ ) if ( seven[ i ] === zero[ i ] ) same ++;
			// Halton's base-2 scramble has two sequences in all, so two seeds agree often by chance.
			expect( same / seven.length ).toBeLessThan( technique === 2 ? 0.01 : 0.5 );
			for ( let i = 1; i < seven.length; i += 2 ) expect( seven[ i ] >= 0 && seven[ i ] < 1 ).toBe( true );

		} );

	}

} );
