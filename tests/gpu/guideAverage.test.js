/**
 * The denoiser guide behind smooth glass follows the likelier branch only: Shade marks a guide whose path took the
 * other one (`writeGBuffer( …, unlikely )`, carried as the depth's sign) and FinalWrite averages the rest
 * (`guideWeights`). Both halves are checked here.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { bool, float, instanceIndex, instancedArray, select, uint, vec3, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { writeGBuffer, readGBuffer, gbDecodeNormalDepth, gbDecodeUnlikely } from '@/core/pathtracer/PackedRayBuffer.js';
import { guideWeights } from '@/core/shaders/kernels/FinalWriteKernel.js';

describeGPU( 'guide averaging behind glass', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'carries the unlikely mark without changing the depth', async () => {

		const depths = new Float32Array( [ 0, 1e-6, 0.3, 0.75, 1, 0, 1e-6, 0.3, 0.75, 1 ] );
		const marks = new Uint32Array( [ 0, 0, 0, 0, 0, 1, 1, 1, 1, 1 ] );
		const gBuffer = instancedArray( depths.length, 'uvec4' );
		const out = new Float32Array( await evaluate( renderer, depths.length, { depth: [ depths, 'float' ], mark: [ marks, 'uint' ] }, 'vec4', ( a ) => {

			writeGBuffer( gBuffer, instanceIndex, vec3( 0, 0.6, 0.8 ), a.depth, vec3( 0.5 ), float( 0.25 ), a.mark.equal( uint( 1 ) ) );
			const packed = readGBuffer( gBuffer, instanceIndex );
			const nd = gbDecodeNormalDepth( packed );
			return vec4( nd.w, select( gbDecodeUnlikely( packed ), float( 1 ), float( 0 ) ), nd.z, 0 );

		} ) );

		for ( let i = 0; i < depths.length; i ++ ) {

			const [ depth, unlikely, nz ] = out.subarray( i * 4, i * 4 + 3 );
			expect( unlikely ).toBe( marks[ i ] );
			// An unlikely depth that would round to 0 keeps its sign through a floor of 1/16384.
			expect( depth ).toBeCloseTo( marks[ i ] ? Math.max( depths[ i ], 1 / 16384 ) : depths[ i ], 4 );
			expect( nz ).toBeCloseTo( 0.9, 4 );

		}

	} );

	it( 'averages likely samples only, exactly as before for a pixel never marked', async () => {

		// unlikely, count of likely samples so far, the epoch's samples, its alpha → keepPrev, replace, alpha, count
		const cases = [
			[ 0, 5, 5, 1 / 6, 0, 0, 1 / 6, 6 ], // never marked: the epoch's own alpha
			[ 1, 5, 6, 1 / 7, 1, 0, 1 / 7, 5 ], // unlikely after likely ones: stays out
			[ 0, 4, 6, 1 / 7, 0, 0, 1 / 5, 5 ], // likely after an unlikely one: 1 / (likely so far + 1)
			[ 1, 0, 3, 1 / 4, 0, 0, 1 / 4, 0 ], // only unlikely so far: stands in at the epoch's alpha
			[ 0, 0, 3, 1 / 4, 0, 1, 1, 1 ], // first likely sample: replaces the stand-ins
		];
		const col = ( k ) => cases.map( ( c ) => c[ k ] );
		const inputs = {
			unlikely: [ new Uint32Array( col( 0 ) ), 'uint' ], prevCount: [ new Uint32Array( col( 1 ) ), 'uint' ],
			auxSamples: [ new Uint32Array( col( 2 ) ), 'uint' ], alpha: [ new Float32Array( col( 3 ) ), 'float' ],
		};
		const out = new Float32Array( await evaluate( renderer, cases.length, inputs, 'vec4', ( a ) => {

			const w = guideWeights( a.unlikely.equal( uint( 1 ) ), a.prevCount, a.auxSamples, a.alpha );
			return vec4( select( w.keepPrev, float( 1 ), float( 0 ) ), select( w.replace, float( 1 ), float( 0 ) ), select( w.replace, float( 1 ), w.alpha ), float( w.count ) );

		} ) );

		cases.forEach( ( c, i ) => {

			const [ keepPrev, replace, alpha, count ] = out.subarray( i * 4, i * 4 + 4 );
			expect( [ keepPrev, replace, count ] ).toEqual( [ c[ 4 ], c[ 5 ], c[ 7 ] ] );
			expect( alpha ).toBeCloseTo( c[ 6 ], 6 );

		} );

	} );

	it( 'gives a never-marked pixel the epoch alpha bit for bit', async () => {

		const alphas = new Float32Array( Array.from( { length: 64 }, ( _, n ) => 1 / ( n + 2 ) ) );
		const counts = new Uint32Array( alphas.map( ( _, n ) => n + 1 ) );
		const out = new Float32Array( await evaluate( renderer, alphas.length,
			{ count: [ counts, 'uint' ], alpha: [ alphas, 'float' ] }, 'float',
			( a ) => guideWeights( bool( false ), a.count, a.count, a.alpha ).alpha ) );
		expect( Array.from( out ) ).toEqual( Array.from( alphas ) );

	} );

} );
