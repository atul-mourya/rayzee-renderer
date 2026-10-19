/**
 * A point or spot light with a radius is a disc of it facing the lit point, as Cycles' Soft Falloff: on its axis it then
 * gives intensity / ( d² + r² ) where a point gives intensity / d², and a radius of 0 is the point exactly. A spot's
 * cone is read from its centre, so the disc's own spread does not move the cone's edge.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataArrayTexture } from 'three';
import { vec3, vec4, float, int, texture } from 'three/tsl';
import { createRenderer, evaluate } from './gpu.js';
import { samplePointLightWithAttenuation, sampleSpotLightWithRadius } from '@/core/TSL/LightsSampling.js';
import { PointLight, SpotLight, LightSample } from '@/core/TSL/LightsCore.js';

const D = 2, INTENSITY = 3, N = 64;
const uvs = new Float32Array( N * N * 2 );
for ( let i = 0; i < N; i ++ ) for ( let j = 0; j < N; j ++ ) uvs.set( [ ( i + 0.5 ) / N, ( j + 0.5 ) / N ], ( i * N + j ) * 2 );

// No gobo or IES on these spots; their lookups still need textures to build against.
const placeholder = () => texture( new DataArrayTexture( new Uint8Array( 4 ).fill( 255 ), 1, 1, 1 ) );

const point = ( radius ) => PointLight( {
	position: vec3( 0, D, 0 ), color: vec3( 1 ), intensity: float( INTENSITY ), distance: float( 0 ), decay: float( 2 ), radius: float( radius ),
} );
const spot = ( radius, angle ) => SpotLight( {
	position: vec3( 0, D, 0 ), direction: vec3( 0, - 1, 0 ), color: vec3( 1 ), intensity: float( INTENSITY ), angle: float( angle ),
	penumbra: float( 0 ), distance: float( 0 ), decay: float( 2 ), goboIndex: int( - 1 ), goboIntensity: float( 1 ),
	iesIndex: int( - 1 ), iesIntensity: float( 1 ), radius: float( radius ),
} );

describe( 'light radius', () => {

	let renderer, resources;

	beforeAll( async () => {

		renderer = await createRenderer();
		resources = { goboMaps: placeholder(), iesProfiles: placeholder() };

	} );

	afterAll( () => renderer?.dispose() );

	// Irradiance at `at` on a surface facing up, averaged over the disc's samples.
	const irradiance = async ( light, sampler, at = [ 0, 0, 0 ] ) => {

		const out = new Float32Array( await evaluate( renderer, N * N, { uv: [ uvs, 'vec2' ] }, 'vec4', ( a ) => {

			const s = LightSample.wrap( sampler( light, vec3( ...at ), float( 1 ), a.uv ) );
			return vec4( s.emission.x, s.direction.y, s.distance, float( s.valid ) );

		}, resources ) );
		let sum = 0;
		for ( let i = 0; i < N * N; i ++ ) sum += out[ i * 4 ] * out[ i * 4 + 1 ];
		return sum / ( N * N );

	};

	it( 'lights the point below a light of radius r with intensity / ( d² + r² ), and a point light\'s intensity / d² at 0', async () => {

		expect( await irradiance( point( 0 ), samplePointLightWithAttenuation ) ).toBeCloseTo( INTENSITY / D ** 2, 5 );
		for ( const r of [ 0.25, 1 ] ) {

			expect( await irradiance( point( r ), samplePointLightWithAttenuation ) / ( INTENSITY / ( D ** 2 + r ** 2 ) ) ).toBeCloseTo( 1, 3 );

		}

	} );

	it( 'gives a spot of radius r the same disc, its cone read from the centre', async () => {

		const r = 0.5;
		expect( await irradiance( spot( r, 0.5 ), sampleSpotLightWithRadius ) / ( INTENSITY / ( D ** 2 + r ** 2 ) ) ).toBeCloseTo( 1, 3 );
		// Just outside the cone from the centre: dark, though half the disc's points see the receiver inside the cone.
		const edge = D * Math.tan( 0.3 ) * 1.02;
		expect( await irradiance( spot( r, 0.3 ), sampleSpotLightWithRadius, [ edge, 0, 0 ] ) ).toBe( 0 );

	} );

} );
