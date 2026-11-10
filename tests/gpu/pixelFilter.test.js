/**
 * pbrt's pixel filter (`pixelFilter`, `pixelFilterRadius`): each camera sample lands where the filter is drawn, at
 * weight 1 (pbrt's TriangleFilter::Sample). Checked on the tent's inverse CDF, then on a render of a sharp edge, whose
 * pixels next to it take the filter's share of the far side: a box of 0.5 none, a triangle of 1 exactly 1/8.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Scene, Mesh, PlaneGeometry, MeshPhysicalMaterial, Color } from 'three';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { tentOffset, gaussianOffset } from '@/core/shaders/kernels/GenerateKernel.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';

const ROOT = new URL( '../../', import.meta.url );

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

// pbrt-v4's SampleTent at radius 1.
const tent = u => ( u < 0.5 ? Math.sqrt( 2 * u ) - 1 : 1 - Math.sqrt( 2 - 2 * u ) );

// pbrt-v4's Gaussian filter along one axis: its CDF by Simpson's rule, inverted by bisection.
function gaussianInverse( radius, sigma ) {

	const h = x => Math.max( 0, Math.exp( - x * x / ( 2 * sigma * sigma ) ) - Math.exp( - radius * radius / ( 2 * sigma * sigma ) ) );
	const steps = 20000, dx = 2 * radius / steps;
	const cdf = new Float64Array( steps + 1 );
	for ( let i = 1; i <= steps; i ++ ) {

		const a = - radius + ( i - 1 ) * dx;
		cdf[ i ] = cdf[ i - 1 ] + dx / 6 * ( h( a ) + 4 * h( a + dx / 2 ) + h( a + dx ) );

	}

	return u => {

		const goal = u * cdf[ steps ];
		let lo = 0, hi = steps;
		while ( hi - lo > 1 ) {

			const mid = ( lo + hi ) >> 1;
			if ( cdf[ mid ] < goal ) lo = mid; else hi = mid;

		}

		return - radius + ( lo + ( goal - cdf[ lo ] ) / ( cdf[ hi ] - cdf[ lo ] ) ) * dx;

	};

}

describeGPU( 'the pixel filter', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'draws the tent by its inverse CDF: ends at ±1, the middle at 0, a quarter of the samples beyond ±0.5 … 1/8 each side', async () => {

		const n = 4096;
		const u = Float32Array.from( { length: n }, ( _, i ) => ( i + 0.5 ) / n );
		const out = new Float32Array( await evaluate( renderer, n, { u: [ u, 'float' ] }, 'float', ( a ) => tentOffset( a.u ) ) );

		let worst = 0;
		for ( let i = 0; i < n; i ++ ) worst = Math.max( worst, Math.abs( out[ i ] - tent( u[ i ] ) ) );
		expect( worst ).toBeLessThan( 1e-6 );
		expect( out.every( x => x > - 1 && x < 1 ) ).toBe( true );
		// The tent's CDF at -0.5 and 0.5.
		expect( out.filter( x => x < - 0.5 ).length / n ).toBeCloseTo( 0.125, 3 );
		expect( out.filter( x => x > 0.5 ).length / n ).toBeCloseTo( 0.125, 3 );

	} );

	it( 'draws pbrt\'s Gaussian by its inverse CDF, its radius and σ as given', async () => {

		const n = 2048;
		const u = Float32Array.from( { length: n }, ( _, i ) => ( i + 0.5 ) / n );
		for ( const [ radius, sigma ] of [[ 1.5, 0.5 ], [ 2, 2 / 3 ], [ 0.75, 0.25 ]] ) {

			const out = new Float32Array( await evaluate( renderer, n, { u: [ u, 'float' ] }, 'float', ( a ) => gaussianOffset( a.u, radius, sigma ) ) );
			const exact = gaussianInverse( radius, sigma );
			let worst = 0;
			for ( let i = 0; i < n; i ++ ) worst = Math.max( worst, Math.abs( out[ i ] - exact( u[ i ] ) ) );
			expect( worst, `radius ${radius}` ).toBeLessThan( 2e-5 );
			expect( out.every( x => Math.abs( x ) < radius ) ).toBe( true );

		}

	} );

	it( 'renders an edge as the filter spreads it, the box as before', async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		const SIZE = 16;
		const app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );
		try {

			// A black metal (reflects nothing) over the left half, a white sky behind; the edge on a pixel boundary.
			const black = new Mesh( new PlaneGeometry( 4, 4 ), new MeshPhysicalMaterial( { color: 0x000000, metalness: 1, roughness: 1 } ) );
			black.position.set( - 2, 0, 0 );
			await app.loadObject3D( new Scene().add( black ), 'edge' );
			app.environmentManager.params.solidSkyColor.copy( new Color( 1, 1, 1 ) );
			await app.environmentManager.setMode( 'color' );
			app.settings.set( 'cameraProjection', 'orthographic' );
			// The shares below are exact for stratified jitter (Sobol').
			app.settings.set( 'samplingTechnique', 2 );
			app.camera.orthoHalfHeight = 1;
			app.camera.position.set( 0, 0, 5 );
			app.camera.lookAt( 0, 0, 0 );
			app.camera.updateProjectionMatrix();

			const row = async ( samples = 64 ) => {

				await app.renderFrames( samples );
				const { data } = await app.renderToBuffer( { colorSpace: 'linear' } );
				const y = SIZE / 2;
				return Array.from( { length: SIZE }, ( _, x ) => data[ ( y * SIZE + x ) * 4 + 1 ] );

			};

			const box = await row();
			const at = SIZE / 2;
			expect( box[ at - 1 ] ).toBeLessThan( 0.002 );
			expect( box[ at ] ).toBeGreaterThan( 0.998 );

			app.settings.setMany( { pixelFilter: 'triangle', pixelFilterRadius: 1 } );
			const triangle = await row();
			expect( triangle[ at - 2 ] ).toBeLessThan( 0.002 );
			expect( triangle[ at - 1 ] ).toBeCloseTo( 0.125, 2 );
			expect( triangle[ at ] ).toBeCloseTo( 0.875, 2 );
			expect( triangle[ at + 1 ] ).toBeGreaterThan( 0.998 );

			// Radius 2: the share two pixels out is the tent's tail beyond 1.5 of 2, 1/32.
			app.settings.set( 'pixelFilterRadius', 2 );
			const wide = await row();
			expect( wide[ at - 2 ] ).toBeCloseTo( 1 / 32, 2 );
			expect( wide[ at - 1 ] ).toBeCloseTo( 9 / 32, 2 );

			// pbrt's Gaussian, its default (1.5, σ 0.5) and 2 (σ 2/3): pbrt-v4 renders this edge as 0.1526 / 0.8472 and
			// 0.0077 / 0.2216 / 0.7783 / 0.9922 (4096 samples).
			app.settings.setMany( { pixelFilter: 'gaussian', pixelFilterRadius: 1.5 } );
			const gaussian = await row();
			expect( gaussian[ at - 2 ] ).toBeLessThan( 0.002 );
			expect( gaussian[ at - 1 ] ).toBeCloseTo( 0.1526, 2 );
			expect( gaussian[ at ] ).toBeCloseTo( 0.8472, 2 );
			// Its tails hold under 1 % of the samples: enough of them to see it.
			app.settings.set( 'pixelFilterRadius', 2 );
			const wideGaussian = await row( 1024 );
			expect( wideGaussian[ at - 2 ] ).toBeCloseTo( 0.0077, 2 );
			expect( wideGaussian[ at - 1 ] ).toBeCloseTo( 0.2216, 2 );
			expect( wideGaussian[ at + 1 ] ).toBeCloseTo( 0.9922, 2 );

			// A box of radius 1: a quarter of each neighbour's samples cross.
			app.settings.setMany( { pixelFilter: 'box', pixelFilterRadius: 1 } );
			const wideBox = await row();
			expect( wideBox[ at - 1 ] ).toBeCloseTo( 0.25, 2 );
			expect( wideBox[ at ] ).toBeCloseTo( 0.75, 2 );
			expect( wideBox[ at - 2 ] ).toBeLessThan( 0.002 );

			// Back to the box: the plain pixel again, compiled out.
			app.settings.setMany( { pixelFilter: 'box', pixelFilterRadius: 0.5 } );
			expect( await row() ).toEqual( box );

		} finally {

			app.dispose();

		}

	}, 60000 );

} );
