/**
 * Shadow rays through glass pass the light a camera path through it carries. glTF's transmission is transmissionFactor ×
 * the texture's R channel, so where the map is black the surface is opaque and casts a shadow; each face tints the light
 * by the square root of the base colour and its map (Cycles: a way in and out takes the colour once); a volume absorbs
 * it per channel.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, float, vec3, vec4 } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { DataArrayTexture } from 'three';
import { describeGPU, createRenderer } from './gpu.js';

vi.mock( '@/core/bvh/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { traverseBVHShadow } from '@/core/shaders/BVHTraversal.js';
import { traceShadowRay } from '@/core/shaders/LightsDirect.js';
import { buildBucketTextureNodes } from '@/core/shaders/TextureSampling.js';
import { withSceneResources } from '@/core/shaders/SceneResources.js';
import { packMaterial } from '@/core/materials/MaterialPacking.js';
import { packTextureIndex } from '@/core/materials/TextureBuckets.js';
import { MATERIAL_DATA_LAYOUT, packNormalOct, packTriangleFlags } from '@/core/scene/BufferLayout.js';

const LANES = 20;
// The transmission map's R is 0, 128 and 255 in thirds across u; G, B and A hold its inverse, so a wrong channel shows.
// The albedo map is red, green and blue in thirds.
const MAP = packTextureIndex( 0, 0 );
const TINT = [ 1, 0.5, 0.25 ];
const ABSORB = [ 0.5, 0.25, 0.8 ];
const MATERIALS = [
	{ transmission: 1, transmissionMap: MAP, ior: 1.5, side: 2 },
	{ transmission: 0.5, transmissionMap: MAP, ior: 1.5, side: 2 },
	{ transmission: 1, ior: 1.5, side: 2 },
	{ transmission: 1, ior: 1.5, side: 2, color: TINT },
	{ transmission: 1, ior: 1.5, side: 2, color: [ 0.5, 1, 0.5 ], map: MAP },
	{ transmission: 1, ior: 1, side: 2, attenuationColor: ABSORB, attenuationDistance: 0.5 },
];
// One quad a material at z = 0, facing +z; the volume's back face 0.5 behind it, facing −z.
const QUADS = [ ...MATERIALS.map( ( _, q ) => ( { material: q, z: 0 } ) ), { material: 5, z: - 0.5, back: true } ];
// Normal incidence on ior 1.5: F = 0.04.
const PASS = 0.96;

function bytes( texels ) {

	const w = 96, h = 16, data = new Uint8Array( w * h * 4 );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) data.set( texels[ Math.floor( x / 32 ) ], ( y * w + x ) * 4 );
	const texture = new DataArrayTexture( data, w, h, 1 );
	texture.needsUpdate = true;
	return texture;

}

const transmissionMap = () => bytes( [ 0, 128, 255 ].map( ( r ) => [ r, 255 - r, 255 - r, 255 - r ] ) );
const albedoMap = () => bytes( [[ 255, 0, 0, 255 ], [ 0, 255, 0, 255 ], [ 0, 0, 255, 255 ]] );

// Side by side along x, u running 0 → 1 across each.
function scene() {

	const data = new Uint32Array( QUADS.length * 2 * LANES );
	const f = new Float32Array( data.buffer );
	QUADS.forEach( ( { material, z, back }, q ) => {

		const x = material * 3;
		const n = packNormalOct( 0, 0, back ? - 1 : 1 );
		const quad = [[[ 0, 0 ], [ 1, 0 ], [ 1, 1 ]], [[ 0, 0 ], [ 1, 1 ], [ 0, 1 ]]];
		quad.forEach( ( tri, t ) => {

			const base = ( q * 2 + t ) * LANES;
			const corners = back ? [ tri[ 0 ], tri[ 2 ], tri[ 1 ] ] : tri;
			corners.forEach( ( [ u, v ], i ) => {

				f.set( [ x + u * 2, v, z ], base + i * 4 );
				data[ base + i * 4 + 3 ] = n;

			} );
			f.set( [ ...corners[ 0 ], ...corners[ 1 ], ...corners[ 2 ] ], base + 12 );
			data[ base + 18 ] = packTriangleFlags( material, MATERIALS[ material ] );

		} );

	} );

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData, count: QUADS.length * 2 };

}

async function shadowTransmittance( renderer, { bvh, triangles, count }, xs ) {

	const bvhNode = storage( new StorageInstancedBufferAttribute( bvh, 4 ), 'vec4', bvh.length / 4 ).toReadOnly();
	const geo = new Uint32Array( count * 12 ), shade = new Uint32Array( count * 8 );
	for ( let i = 0; i < count; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	const tris = {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', count * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', count * 2 ).toReadOnly(),
	};

	const M = MATERIAL_DATA_LAYOUT;
	const materials = new Float32Array( MATERIALS.length * M.FLOATS_PER_MATERIAL );
	MATERIALS.forEach( ( material, i ) => packMaterial( materials, i * M.FLOATS_PER_MATERIAL, material ) );
	const materialNode = storage( new StorageInstancedBufferAttribute( materials, 4 ), 'vec4', materials.length / 4 ).toReadOnly();

	const origins = instancedArray( new Float32Array( xs.flatMap( x => [ x, 0.5, 1, 0 ] ) ), 'vec4' );
	const out = instancedArray( xs.length, 'vec4' );
	const resources = {
		linearBuckets: buildBucketTextureNodes( [ transmissionMap() ] ),
		shadowAlbedoMaps: buildBucketTextureNodes( [ albedoMap() ] ),
		alphaShadows: null,
	};
	const kernel = withSceneResources( Fn( () => {

		const transmittance = traceShadowRay(
			origins.element( instanceIndex ).xyz, vec3( 0, 0, - 1 ), float( 2 ),
			traverseBVHShadow, bvhNode, tris, materialNode,
		);
		out.element( instanceIndex ).assign( vec4( transmittance, 1 ) );

	} )(), resources ).compute( xs.length );

	await renderer.computeAsync( kernel );
	const rgba = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
	return xs.map( ( _, i ) => Array.from( rgba.subarray( i * 4, i * 4 + 3 ) ) );

}

describeGPU( 'shadow rays through glass', () => {

	let renderer, geometry;

	beforeAll( async () => {

		renderer = await createRenderer();
		geometry = scene();

	} );

	afterAll( () => renderer?.dispose() );

	// A ray through each third of a quad: u = 1/6, 1/2 and 5/6.
	const thirds = ( q ) => [ 1 / 3, 1, 5 / 3 ].map( ( x ) => q * 3 + x );
	const near = ( rgb ) => rgb.map( ( c ) => expect.closeTo( c, 4 ) );
	const grey = ( v ) => near( [ v, v, v ] );

	it( 'is opaque where the transmission map is black and passes the map\'s share of the light elsewhere', async () => {

		const [ black, half, white ] = await shadowTransmittance( renderer, geometry, thirds( 0 ) );
		expect( black ).toEqual( [ 0, 0, 0 ] );
		expect( half ).toEqual( grey( 128 / 255 * PASS ) );
		expect( white ).toEqual( grey( PASS ) );

	} );

	it( 'multiplies the transmission map by the factor', async () => {

		const [ black, half, white ] = await shadowTransmittance( renderer, geometry, thirds( 1 ) );
		expect( black ).toEqual( [ 0, 0, 0 ] );
		expect( half ).toEqual( grey( 0.5 * 128 / 255 * PASS ) );
		expect( white ).toEqual( grey( 0.5 * PASS ) );

	} );

	it( 'leaves white glass without maps at its factor', async () => {

		expect( await shadowTransmittance( renderer, geometry, thirds( 2 ) ) ).toEqual( Array( 3 ).fill( grey( PASS ) ) );

	} );

	it( 'tints the light by the base colour\'s square root a face', async () => {

		expect( await shadowTransmittance( renderer, geometry, thirds( 3 ) ) ).toEqual( Array( 3 ).fill( near( TINT.map( ( c ) => Math.sqrt( c ) * PASS ) ) ) );

	} );

	it( 'tints the light by the base colour times its map', async () => {

		const [ red, green, blue ] = await shadowTransmittance( renderer, geometry, thirds( 4 ) );
		expect( red ).toEqual( near( [ Math.SQRT1_2 * PASS, 0, 0 ] ) );
		expect( green ).toEqual( near( [ 0, PASS, 0 ] ) );
		expect( blue ).toEqual( near( [ 0, 0, Math.SQRT1_2 * PASS ] ) );

	} );

	it( 'absorbs each channel through a volume by its own attenuation colour', async () => {

		// attenuationDistance is the depth crossed, so each channel keeps its attenuation colour.
		const [ rgb ] = await shadowTransmittance( renderer, geometry, [ 5 * 3 + 1 ] );
		rgb.forEach( ( c, i ) => expect( c ).toBeCloseTo( ABSORB[ i ], 3 ) );

	} );

} );
