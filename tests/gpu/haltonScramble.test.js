import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, int, uint, vec2 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { getRandomSample, getRandomSample1D, getRandomSample2D, samplingTechniqueUniform } from '@/core/shaders/Random.js';

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

	// One pixel's first 256 samples on two dimensions (frame i in element i).
	const frames = Float32Array.from( { length: 256 }, ( _, i ) => i );
	const pixel = vec2( float( 5.5 ), float( 3.5 ) ), size = vec2( float( W ), float( H ) );
	const draw = ( sample ) => evaluate( renderer, 256, { f: [ frames, 'float' ] }, 'float', ( { f } ) => sample( int( f ) ) ).then( b => Array.from( new Float32Array( b ) ) );
	const strata = ( values, n ) => new Set( values.map( v => Math.floor( v * n ) ) ).size;

	it( 'takes each dimension through the sequence in its own order, each still stratified', async () => {

		samplingTechniqueUniform.value = 1;
		const a = await draw( f => getRandomSample1D( pixel, int( 0 ), int( 3 ), uint( 1 ).toVar(), size, f ) );
		const b = await draw( f => getRandomSample1D( pixel, int( 0 ), int( 40 ), uint( 1 ).toVar(), size, f ) );
		const xy = await draw( f => getRandomSample2D( pixel, int( 0 ), int( 7 ), uint( 1 ).toVar(), size, f ).x );
		const yz = await draw( f => getRandomSample2D( pixel, int( 0 ), int( 7 ), uint( 1 ).toVar(), size, f ).y );
		const nd = await draw( f => getRandomSample( pixel, int( 0 ), int( 9 ), uint( 1 ).toVar(), int( - 1 ), size, f ).y );
		const sameIndex = await draw( f => getRandomSample1D( pixel, int( 0 ), int( 7 ), uint( 1 ).toVar(), size, f ) );

		// 256 samples of a base-2 dimension fill all 256 strata; any 256 consecutive points of base 3 fill all 243.
		expect( strata( a, 256 ) ).toBe( 256 );
		expect( strata( b, 256 ) ).toBe( 256 );
		expect( strata( xy, 256 ) ).toBe( 256 );
		expect( strata( yz, 243 ) ).toBe( 243 );
		expect( strata( nd, 243 ) ).toBe( 243 );
		for ( const v of [ ...a, ...b, ...xy, ...yz, ...nd ] ) expect( v >= 0 && v < 1 ).toBe( true );
		// A 1D dimension is not the x of the 2D dimension with the same index.
		expect( sameIndex.filter( ( v, i ) => v === xy[ i ] ).length ).toBeLessThan( 8 );

		// Against each other: in lockstep (one order, digits offset) the pairs fill 16 cells of a 16 × 16 grid; shuffled
		// apart, about 1 − 1/e of them (162).
		const cells = new Set( a.map( ( v, i ) => Math.floor( v * 16 ) * 16 + Math.floor( b[ i ] * 16 ) ) ).size;
		expect( cells ).toBeGreaterThan( 120 );

	} );

} );
