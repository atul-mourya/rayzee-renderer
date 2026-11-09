import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { vec2, vec3, vec4, float, int, uint, normalize, bool as tslBool } from 'three/tsl';
import { iorFromWavelength, sampleWavelengthForDispersion, SpectralSample } from '@/core/shaders/MaterialTransmission.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/shaders/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample } from '@/core/shaders/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/shaders/MaterialProperties.js';
import { generateSampledDirection } from '@/core/shaders/PathTracerCore.js';
import { evaluateMaterialResponse } from '@/core/shaders/MaterialEvaluation.js';
import { ALL_MATERIAL_LAYERS } from '@/core/shaders/SceneResources.js';

// glTF's dispersion is 20 / the Abbe number ( n_d − 1 ) / ( n_F − n_C ), `ior` being n_d: KHR_materials_dispersion.
const F = 486.134, D = 587.562, C = 656.281;
const CASES = [[ 1.5, 1 ], [ 1.62, 0.4 ], [ 2.4, 0.5 ], [ 3.389, 0.407 ], [ 1.5, 0 ]];
const LINES = [ F, D, C ];
const ior = new Float32Array( CASES.flatMap( ( [ n ] ) => LINES.map( () => n ) ) );
const dispersion = new Float32Array( CASES.flatMap( ( [ , d ] ) => LINES.map( () => d ) ) );
const wavelength = new Float32Array( CASES.flatMap( () => LINES ) );

describeGPU( 'dispersion on the GPU', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	// It moves the IOR of what refracts, by wavelength; what reflects keeps the base colour (a saturation boost was here).
	it( 'leaves the reflection alone: a part-transmissive coloured material\'s BSDF and reflected samples are the same with and without it', async () => {

		const COUNT = 1 << 12;
		let seed = 99;
		const xi = Float32Array.from( { length: COUNT * 4 }, () => ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
		// Per element: the sampled value (r) and direction (z), the BSDF towards a fixed light (r, b).
		const shade = async ( dispersion ) => new Float32Array( await evaluate( renderer, COUNT, { xi: [ xi, 'vec4' ] }, 'vec4', ( a ) => {

			const V = normalize( vec3( a.xi.w.sub( 0.5 ), 0.3, 1.0 ) );
			const N = vec3( 0, 0, 1 );
			const L = normalize( vec3( 0.3, a.xi.z.sub( 0.5 ), 0.8 ) );
			const material = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
			material.color.assign( vec4( 0.9, 0.3, 0.1, 1 ) );
			material.roughness.assign( 0.5 );
			material.metalness.assign( 0 );
			material.transmission.assign( 0.7 );
			material.ior.assign( 1.5 );
			material.dispersion.assign( dispersion );
			const mc = MaterialClassification.wrap( classifyMaterial(
				material.metalness, material.roughness, material.transmission,
				material.clearcoat, material.emissive, material.subsurface,
			) );
			const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) ).toVar();
			const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );
			const s = DirectionSample.wrap( generateSampledDirection(
				V, N, material, a.xi.xy, a.xi.z, uint( 1 ).toVar(),
				vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
				mc, tslBool( true ), weights, tslBool( false ), cache,
			) ).toVar();
			const bsdf = evaluateMaterialResponse( V, L, N, material );
			return vec4( s.value.x, s.direction.z, bsdf.x, bsdf.z );

		}, { materialLayers: ALL_MATERIAL_LAYERS } ) );

		const without = await shade( 0 ), withIt = await shade( 3 );
		let bsdf = 0, reflected = 0, compared = 0;
		for ( let i = 0; i < without.length; i += 4 ) {

			if ( ! Object.is( without[ i + 2 ], withIt[ i + 2 ] ) || ! Object.is( without[ i + 3 ], withIt[ i + 3 ] ) ) bsdf ++;
			if ( without[ i + 1 ] > 0 && Object.is( without[ i + 1 ], withIt[ i + 1 ] ) ) {

				compared ++;
				if ( ! Object.is( without[ i ], withIt[ i ] ) ) reflected ++;

			}

		}

		expect( without.every( Number.isFinite ) && withIt.every( Number.isFinite ) ).toBe( true );
		expect( [ bsdf, reflected ] ).toEqual( [ 0, 0 ] );
		expect( compared ).toBeGreaterThan( COUNT / 4 );

	} );

	it( 'gives the IOR at the d line and spreads the F and C lines by ( ior − 1 ) · dispersion / 20', async () => {

		const n = new Float32Array( await evaluate( renderer, ior.length, {
			ior: [ ior, 'float' ], dispersion: [ dispersion, 'float' ], wavelength: [ wavelength, 'float' ],
		}, 'float', a => iorFromWavelength( a.ior, a.dispersion, a.wavelength ) ) );

		CASES.forEach( ( [ nd, d ], i ) => {

			const [ nF, nD, nC ] = n.slice( i * 3, i * 3 + 3 );
			expect( nD ).toBeCloseTo( nd, 5 );
			expect( nF - nC ).toBeCloseTo( ( nd - 1 ) * d / 20, 5 );
			if ( d > 0 ) expect( nF ).toBeGreaterThan( nC );

		} );

	} );

	it( 'draws wavelengths whose colour weights average to white, with the variance the lobes were fitted to', async () => {

		// Evenly spread draws stand in for the stratified ones a pixel takes over its samples.
		const N = 4096;
		const random = Float32Array.from( { length: N }, ( _, i ) => ( i + 0.5 ) / N );
		const out = new Float32Array( await evaluate( renderer, N, { random: [ random, 'float' ] }, 'vec4', a => {

			const drawn = SpectralSample.wrap( sampleWavelengthForDispersion( 1.5, 0.5, a.random ) );
			return vec4( drawn.colorWeight, drawn.wavelength );

		} ) );

		const mean = [ 0, 0, 0 ], square = [ 0, 0, 0 ];
		for ( let i = 0; i < N; i ++ ) for ( let c = 0; c < 3; c ++ ) {

			const w = out[ i * 4 + c ];
			expect( Number.isFinite( w ) && w >= 0 ).toBe( true );
			mean[ c ] += w / N;
			square[ c ] += w * w / N;

		}

		mean.forEach( ( m ) => expect( m ).toBeCloseTo( 1, 2 ) );
		// 7.53 together when drawn evenly over 380–700 nm.
		[ 1.461, 1.423, 1.707 ].forEach( ( v, c ) => expect( Math.abs( square[ c ] - mean[ c ] ** 2 - v ) ).toBeLessThan( 0.05 ) );

	} );

} );
