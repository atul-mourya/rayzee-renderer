import { afterAll, beforeAll, expect, it } from 'vitest';
import { float } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { DistributionGGX } from '@/core/TSL/MaterialProperties.js';
import { MIN_ROUGHNESS } from '@/core/TSL/Common.js';

describeGPU( 'GGX distribution on the GPU', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	// Flooring the denominator at EPSILON once cut this peak 8000×: smooth dielectrics lost 22 %.
	it( 'keeps its full peak at MIN_ROUGHNESS', async () => {

		const [ D ] = new Float32Array( await evaluate( renderer, 1, { NoH: [ new Float32Array( [ 1 ] ), 'float' ] }, 'float',
			a => DistributionGGX( a.NoH, float( MIN_ROUGHNESS ) ) ) );

		const alpha2 = MIN_ROUGHNESS ** 4;
		expect( D * Math.PI * alpha2 ).toBeCloseTo( 1, 2 );

	} );

	it.each( [ 0.1, 0.3, 0.6, 1 ] )( 'projects to unit area at roughness %s', async ( roughness ) => {

		const N = 1 << 17;
		const dTheta = Math.PI / 2 / N;
		const NoH = new Float32Array( N );
		for ( let i = 0; i < N; i ++ ) NoH[ i ] = Math.cos( ( i + 0.5 ) * dTheta );

		const D = new Float32Array( await evaluate( renderer, N, { NoH: [ NoH, 'float' ] }, 'float',
			a => DistributionGGX( a.NoH, float( roughness ) ) ) );

		let integral = 0;
		for ( let i = 0; i < N; i ++ ) {

			const theta = ( i + 0.5 ) * dTheta;
			integral += D[ i ] * Math.cos( theta ) * Math.sin( theta );

		}

		expect( integral * 2 * Math.PI * dTheta ).toBeCloseTo( 1, 3 );

	} );

} );
