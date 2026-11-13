import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, int, uint, vec2 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { getRandomSample1D, samplingTechniqueUniform } from '@/core/shaders/Random.js';

// Each pixel scrambles Halton's digits its own way, base 2 included.
const W = 64, H = 16, N = W * H;
const px = new Float32Array( N ), py = new Float32Array( N );
for ( let i = 0; i < N; i ++ ) {

	px[ i ] = ( i % W ) + 0.5;
	py[ i ] = Math.floor( i / W ) + 0.5;

}

describeGPU( 'Halton scramble', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => {

		samplingTechniqueUniform.value = 0;
		renderer?.dispose();

	} );

	it( 'gives pixels different base-2 sequences', async () => {

		samplingTechniqueUniform.value = 1;
		const out = new Float32Array( await evaluate( renderer, N, { x: [ px, 'float' ], y: [ py, 'float' ] }, 'float', ( { x, y } ) =>
			getRandomSample1D( vec2( x, y ), int( 0 ), int( 3 ), uint( 1 ).toVar(), vec2( float( W ), float( H ) ), int( 1000 ) ) ) );

		// Sample 1000 has ten base-2 digits: up to 1024 values, ~650 distinct over 1024 random scrambles.
		expect( new Set( out ).size ).toBeGreaterThan( 400 );
		for ( const v of out ) expect( v >= 0 && v < 1 ).toBe( true );

	} );

} );
