/**
 * Diffuse roughness (EON, Portsmouth, Kutz & Hill 2025). The shader matches the paper's Listing 1, is reciprocal, and
 * returns all the light a white surface receives at any roughness — on the plain diffuse path and under a specular
 * layer alike — while a coloured one keeps the albedo the paper derives. Compiled out, it is Lambert.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, dot, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/shaders/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample, ExtMapResult } from '@/core/shaders/Struct.js';
import { applyExtensionMaps, buildBucketTextureNodes } from '@/core/shaders/TextureSampling.js';
import { DataArrayTexture } from 'three';
import { calculateBRDFWeightsFromMaterial } from '@/core/shaders/MaterialProperties.js';
import { generateSampledDirection } from '@/core/shaders/PathTracerCore.js';
import { evaluateMaterialResponse } from '@/core/shaders/MaterialEvaluation.js';
import { MATERIAL_LAYERS, ALL_MATERIAL_LAYERS } from '@/core/shaders/SceneResources.js';

const COUNT = 1 << 16;

// The paper's Listing 1, its ε clamps included.
const A1 = 0.5 - 2 / ( 3 * Math.PI );
const B1 = 2 / 3 - 28 / ( 15 * Math.PI );
const fonAlbedo = ( mu, r ) => {

	const c = 1 - mu;
	return ( 1 + r * c * ( 0.0571085289 + c * ( 0.491881867 + c * ( - 0.332181442 + c * 0.0714429953 ) ) ) ) / ( 1 + A1 * r );

};

function fEON( rho, r, muI, muO, cosIO ) {

	const s = cosIO - muI * muO;
	const A = 1 / ( 1 + A1 * r );
	const single = rho / Math.PI * A * ( 1 + r * ( s > 0 ? s / Math.max( muI, muO ) : s ) );
	const average = A * ( 1 + B1 * r );
	const rhoMs = rho * rho * average / ( 1 - rho * ( 1 - average ) );
	const eps = 1e-7;
	return single + rhoMs / Math.PI * Math.max( eps, 1 - fonAlbedo( muO, r ) ) * Math.max( eps, 1 - fonAlbedo( muI, r ) ) / Math.max( eps, 1 - average );

}

// Eq. 28 with the fit: what the BRDF integrates to at a view cosine.
function directionalAlbedo( rho, r, muO ) {

	const A = 1 / ( 1 + A1 * r );
	const average = A * ( 1 + B1 * r );
	const rhoMs = rho * rho * average / ( 1 - rho * ( 1 - average ) );
	return rho * fonAlbedo( muO, r ) + rhoMs * ( 1 - fonAlbedo( muO, r ) );

}

const rng = ( seed ) => () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );

// Stratified (xi.x, xi.y) per element on a 256 × 256 grid, with a scrambled lobe variate.
const variates = ( () => {

	const data = new Float32Array( COUNT * 4 );
	const rand = rng( 4242 );
	for ( let i = 0; i < COUNT; i ++ ) {

		data[ i * 4 ] = ( ( i & 255 ) + rand() ) / 256;
		data[ i * 4 + 1 ] = ( ( i >> 8 ) + rand() ) / 256;
		data[ i * 4 + 2 ] = rand();

	}

	return data;

} )();

const material = ( { roughness = 1, color = 1, diffuseRoughness } ) => {

	const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
	m.roughness.assign( roughness );
	m.color.assign( vec4( vec3( color ), 1.0 ) );
	m.diffuseRoughness.assign( diffuseRoughness );
	return m;

};

/** Mean throughput (value·cos/pdf) of the BSDF sampler at a view cosine, and how far its value strays from NEE's. */
async function albedo( renderer, { muO, ...look } ) {

	const sinO = Math.sqrt( 1 - muO * muO );
	const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

		const V = normalize( vec3( sinO, 0.0, muO ) );
		const N = vec3( 0, 0, 1 );
		const m = material( look );
		const mc = MaterialClassification.wrap( classifyMaterial( m.metalness, m.roughness, m.transmission, m.clearcoat, m.emissive, m.subsurface ) );
		const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( m ) ).toVar();
		const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0.5 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );
		const s = DirectionSample.wrap( generateSampledDirection(
			V, N, m, a.xi.xy, a.xi.z, uint( 1 ).toVar(),
			vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
			mc, tslBool( true ), weights, tslBool( false ), cache,
		) ).toVar();
		const cos = dot( N, s.direction ).max( 0.0 );
		const nee = evaluateMaterialResponse( V, s.direction, N, m );
		return vec4( s.value.x.mul( cos ).div( s.pdf ), s.value.x.sub( nee.x ).abs().div( nee.x.max( 1e-12 ) ), 0, 0 );

	} ) );

	let sum = 0, stray = 0;
	for ( let i = 0; i < COUNT; i ++ ) {

		sum += out[ i * 4 ];
		stray = Math.max( stray, out[ i * 4 + 1 ] );

	}

	return { albedo: sum / COUNT, stray };

}

// Random view and light pairs above the surface, cosines past 0.05, each with a roughness and an albedo.
const pairs = ( () => {

	const rand = rng( 99 );
	const dir = () => {

		const z = 0.05 + 0.95 * rand(), phi = 2 * Math.PI * rand(), s = Math.sqrt( 1 - z * z );
		return [ s * Math.cos( phi ), s * Math.sin( phi ), z ];

	};

	const v = new Float32Array( 4096 * 4 ), l = new Float32Array( 4096 * 4 );
	for ( let i = 0; i < 4096; i ++ ) {

		v.set( [ ...dir(), rand() ], i * 4 );
		l.set( [ ...dir(), rand() ], i * 4 );

	}

	return { v, l };

} )();

async function evaluatePairs( renderer, swap = false, materialLayers = null ) {

	return new Float32Array( await evaluate( renderer, 4096, { v: [ pairs.v, 'vec4' ], l: [ pairs.l, 'vec4' ] }, 'vec4', ( a ) => {

		const m = material( { color: a.l.w, diffuseRoughness: a.v.w } );
		const V = swap ? a.l.xyz : a.v.xyz;
		const L = swap ? a.v.xyz : a.l.xyz;
		return vec4( evaluateMaterialResponse( V, L, vec3( 0, 0, 1 ), m ), 0 );

	}, materialLayers ? { materialLayers } : null ) );

}

describeGPU( 'diffuse roughness (EON)', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'is the paper\'s BRDF', async () => {

		const out = await evaluatePairs( renderer );
		let worst = 0;
		for ( let i = 0; i < 4096; i ++ ) {

			const [ vx, vy, vz, r ] = pairs.v.subarray( i * 4, i * 4 + 4 );
			const [ lx, ly, lz, rho ] = pairs.l.subarray( i * 4, i * 4 + 4 );
			const expected = fEON( rho, r, lz, vz, vx * lx + vy * ly + vz * lz );
			worst = Math.max( worst, Math.abs( out[ i * 4 ] - expected ) / expected );

		}

		expect( worst ).toBeLessThan( 1e-5 );

	} );

	it( 'is reciprocal', async () => {

		const forward = await evaluatePairs( renderer );
		const backward = await evaluatePairs( renderer, true );
		let worst = 0;
		for ( let i = 0; i < 4096; i ++ ) worst = Math.max( worst, Math.abs( forward[ i * 4 ] - backward[ i * 4 ] ) / forward[ i * 4 ] );
		expect( worst ).toBeLessThan( 1e-5 );

	} );

	it( 'returns all the light a white surface receives, and the sampler agrees with NEE', async () => {

		for ( const muO of [ 0.95, 0.6, 0.25 ] ) for ( const diffuseRoughness of [ 0.5, 1 ] ) {

			const { albedo: e, stray } = await albedo( renderer, { muO, diffuseRoughness } );
			expect( Math.abs( e - 1 ), JSON.stringify( { muO, diffuseRoughness } ) ).toBeLessThan( 2e-3 );
			expect( stray ).toBeLessThan( 1e-5 );

		}

	} );

	it( 'keeps a specular layer\'s energy: rough diffuse under it reflects what Lambert did', async () => {

		for ( const muO of [ 0.95, 0.4 ] ) {

			const lambert = await albedo( renderer, { muO, roughness: 0.5, diffuseRoughness: 0 } );
			const rough = await albedo( renderer, { muO, roughness: 0.5, diffuseRoughness: 1 } );
			expect( Math.abs( rough.albedo - lambert.albedo ), `muO ${muO}` ).toBeLessThan( 3e-3 );

		}

	} );

	it( 'darkens a coloured surface as the paper derives', async () => {

		for ( const muO of [ 0.95, 0.5 ] ) {

			const { albedo: e } = await albedo( renderer, { muO, color: 0.5, diffuseRoughness: 1 } );
			const expected = directionalAlbedo( 0.5, 1, muO );
			expect( expected ).toBeLessThan( 0.5 );
			expect( Math.abs( e - expected ), `muO ${muO}` ).toBeLessThan( 1e-3 );

		}

	} );

	it( 'is Lambert once compiled out', async () => {

		const none = Object.fromEntries( MATERIAL_LAYERS.map( ( layer ) => [ layer, false ] ) );
		const off = await evaluatePairs( renderer, false, none );
		const on = await evaluatePairs( renderer, false, ALL_MATERIAL_LAYERS );
		let lambert = 0, differs = 0;
		for ( let i = 0; i < 4096; i ++ ) {

			const rho = pairs.l[ i * 4 + 3 ] / Math.PI;
			if ( Math.abs( off[ i * 4 ] - rho ) / rho < 1e-5 ) lambert ++;
			if ( off[ i * 4 ] !== on[ i * 4 ] ) differs ++;

		}

		expect( lambert ).toBe( 4096 );
		expect( differs ).toBeGreaterThan( 4000 );

	} );

	it( 'takes its map\'s red channel times the factor, and leaves the factor alone compiled out', async () => {

		const data = new Uint8Array( 4 * 4 * 4 );
		for ( let i = 0; i < 16; i ++ ) data.set( [ 64, 255, 255, 255 ], i * 4 );
		const map = new DataArrayTexture( data, 4, 4, 1 );
		map.needsUpdate = true;
		const buckets = buildBucketTextureNodes( [ map ] );

		const fold = async ( layers ) => new Float32Array( await evaluate( renderer, 1, { uv: [ new Float32Array( [ 0.5, 0.5, 0, 0 ] ), 'vec4' ] }, 'float', ( { uv } ) => {

			const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
			m.diffuseRoughness.assign( 0.8 );
			m.diffuseRoughnessMapIndex.assign( int( 0 ) );
			return ExtMapResult.wrap( applyExtensionMaps( m, uv.xy ) ).diffuseRoughness;

		}, { linearBuckets: buckets, srgbBuckets: buckets, materialLayers: layers } ) )[ 0 ];

		expect( await fold( ALL_MATERIAL_LAYERS ) ).toBeCloseTo( 0.8 * 64 / 255, 6 );
		expect( await fold( { ...ALL_MATERIAL_LAYERS, diffuseRoughness: false } ) ).toBeCloseTo( 0.8, 6 );

	} );

} );
