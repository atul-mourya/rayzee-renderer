/**
 * Path regularization (`pathRegularization`, pbrt-v4's `regularize`): pbrt's Regularize on the engine's roughness, and the
 * samplers' word on whether the lobe they drew is smooth, which Shade marks a path rough from.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, int, uint, normalize, instanceIndex, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial, regularizeRoughness } from '@/core/shaders/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample, Ray, HitInfo } from '@/core/shaders/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/shaders/MaterialProperties.js';
import { generateSampledDirection } from '@/core/shaders/PathTracerCore.js';
import { sampleClearcoat, ClearcoatResult } from '@/core/shaders/Clearcoat.js';

// pbrt-v4's TrowbridgeReitzDistribution::Regularize, on α.
const pbrtRegularize = ( alpha ) => ( alpha < 0.3 ? Math.min( Math.max( 2 * alpha, 0.1 ), 0.3 ) : alpha );

const REGULARIZING = { regularize: true };
const V = [ 0.3, 0, 1 ];

// One lobe draw per case: [ roughness, metalness, where in the lobe bands (0 diffuse, 1 specular), 0 ]. An invalid kernel
// returns zeros without throwing, so each also returns its pdf.
async function drawn( renderer, cases, resources ) {

	const data = new Float32Array( cases.flat() );
	const out = new Float32Array( await evaluate( renderer, cases.length, { c: [ data, 'vec4' ] }, 'vec2', ( a ) => {

		const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		m.roughness.assign( a.c.x );
		m.metalness.assign( a.c.y );
		const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( m ) ).toVar();
		const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0.5 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );
		const mc = MaterialClassification.wrap( classifyMaterial( m.metalness, m.roughness, m.transmission, m.clearcoat, m.emissive, m.subsurface ) );
		const band = a.c.z.greaterThan( 0.5 ).select( weights.diffuse.add( weights.specular.mul( 0.5 ) ), weights.diffuse.mul( 0.5 ) );
		const s = DirectionSample.wrap( generateSampledDirection(
			normalize( vec3( ...V ) ), vec3( 0, 0, 1 ), m, vec2( 0.3, 0.7 ), band, uint( 1 ).toVar(),
			vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
			mc, tslBool( true ), weights, tslBool( false ), cache,
		) ).toVar();
		return vec2( s.isSmooth.select( float( 1 ), float( 0 ) ), s.pdf );

	}, resources ) );

	for ( let i = 0; i < cases.length; i ++ ) expect( out[ i * 2 + 1 ] ).toBeGreaterThan( 0 );
	return cases.map( ( _, i ) => out[ i * 2 ] );

}

describeGPU( 'path regularization', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'roughens as pbrt-v4 does: an α under 0.3 doubles, within [0.1, 0.3]', async () => {

		const roughness = Float32Array.from( { length: 65 }, ( _, i ) => i / 64 );
		const out = new Float32Array( await evaluate( renderer, roughness.length, { r: [ roughness, 'float' ] }, 'float', ( a ) => regularizeRoughness( a.r ) ) );
		roughness.forEach( ( r, i ) => expect( out[ i ] ** 2 ).toBeCloseTo( pbrtRegularize( r * r ), 6 ) );

	} );

	it( 'says a draw is smooth for a mirror or a lobe at the roughness floor, and never while it is off', async () => {

		const cases = [[ 0, 1, 1, 0 ], [ 0.05, 1, 1, 0 ], [ 0.3, 1, 1, 0 ], [ 0, 0, 0, 0 ], [ 0, 0, 1, 0 ]];
		expect( await drawn( renderer, cases, REGULARIZING ) ).toEqual( [ 1, 1, 0, 0, 1 ] );
		expect( await drawn( renderer, cases, null ) ).toEqual( [ 0, 0, 0, 0, 0 ] );

	} );

	it( 'says a smooth coat\'s own draws are smooth, and none of a rough coat\'s or of the diffuse base', async () => {

		const COUNT = 1 << 16;
		const coat = async ( roughness ) => {

			const out = new Float32Array( await evaluate( renderer, COUNT, {}, 'vec2', () => {

				const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
				m.clearcoat.assign( 1 );
				m.clearcoatRoughness.assign( roughness );
				const N = vec3( 0, 0, 1 );
				const pixel = vec2( float( instanceIndex.mod( 256 ) ), float( instanceIndex.div( 256 ) ) );
				const cc = ClearcoatResult.wrap( sampleClearcoat(
					Ray( { origin: vec3( 0 ), direction: normalize( vec3( ...V ) ).negate() } ),
					HitInfo( {
						didHit: true, dst: float( 1 ), hitPoint: vec3( 0 ), normal: N, uv: vec2( 0 ),
						materialIndex: int( 0 ), meshIndex: int( 0 ), triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
					} ),
					m, pixel.div( 256 ), uint( instanceIndex ).add( 7 ).toVar(), pixel, vec2( 256 ), uint( 0 ), int( 0 ),
				) ).toVar();
				return vec2( cc.isSmooth.select( float( 1 ), float( 0 ) ), BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( m ) ).clearcoat );

			}, REGULARIZING ) );

			let smooth = 0;
			for ( let i = 0; i < COUNT; i ++ ) smooth += out[ i * 2 ];
			return { share: smooth / COUNT, weight: out[ 1 ] };

		};

		const smooth = await coat( 0 );
		expect( smooth.weight ).toBeGreaterThan( 0.02 );
		expect( Math.abs( smooth.share - smooth.weight ) ).toBeLessThan( 4 * Math.sqrt( smooth.weight / COUNT ) );
		const rough = await coat( 0.5 );
		expect( [ rough.share, rough.weight > 0.02 ] ).toEqual( [ 0, true ] );

	} );

} );
