/**
 * Shadow rays through a transmissive surface read its transmission map, as camera rays do: glTF's transmission is
 * transmissionFactor × the texture's R channel, so where the map is black the surface is opaque and casts a shadow.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, float, vec3 } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { DataArrayTexture } from 'three';
import { describeGPU, createRenderer } from './gpu.js';

vi.mock( '@/core/Processor/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';
import { traverseBVHShadow } from '@/core/TSL/BVHTraversal.js';
import { traceShadowRay } from '@/core/TSL/LightsDirect.js';
import { buildBucketTextureNodes } from '@/core/TSL/TextureSampling.js';
import { withSceneResources } from '@/core/TSL/SceneResources.js';
import { packMaterial } from '@/core/Processor/MaterialPacking.js';
import { packTextureIndex } from '@/core/Processor/TextureBuckets.js';
import { MATERIAL_DATA_LAYOUT, packNormalOct, packTriangleFlags } from '@/core/Processor/BufferLayout.js';

const LANES = 20;
// The map's R is 0, 128 and 255 in thirds across u; G, B and A hold its inverse, so a wrong channel shows.
const MAP = packTextureIndex( 0, 0 );
const MATERIALS = [
	{ transmission: 1, transmissionMap: MAP, ior: 1.5, side: 2 },
	{ transmission: 0.5, transmissionMap: MAP, ior: 1.5, side: 2 },
	{ transmission: 1, ior: 1.5, side: 2 },
];
// Normal incidence on ior 1.5: F = 0.04.
const PASS = 0.96;

function mapTexture() {

	const w = 96, h = 16, data = new Uint8Array( w * h * 4 );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const r = [ 0, 128, 255 ][ Math.floor( x / 32 ) ];
		data.set( [ r, 255 - r, 255 - r, 255 - r ], ( y * w + x ) * 4 );

	}

	const texture = new DataArrayTexture( data, w, h, 1 );
	texture.needsUpdate = true;
	return texture;

}

// One quad a material in the z = 0 plane, side by side along x, u running 0 → 1 across each.
function scene() {

	const data = new Uint32Array( MATERIALS.length * 2 * LANES );
	const f = new Float32Array( data.buffer );
	const n = packNormalOct( 0, 0, 1 );
	MATERIALS.forEach( ( material, q ) => {

		const x = q * 3;
		const quad = [[[ 0, 0 ], [ 1, 0 ], [ 1, 1 ]], [[ 0, 0 ], [ 1, 1 ], [ 0, 1 ]]];
		quad.forEach( ( tri, t ) => {

			const base = ( q * 2 + t ) * LANES;
			tri.forEach( ( [ u, v ], i ) => {

				f.set( [ x + u * 2, v, 0 ], base + i * 4 );
				data[ base + i * 4 + 3 ] = n;

			} );
			f.set( [ ...tri[ 0 ], ...tri[ 1 ], ...tri[ 2 ] ], base + 12 );
			data[ base + 18 ] = packTriangleFlags( q, material );

		} );

	} );

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData, count: MATERIALS.length * 2 };

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
	const out = instancedArray( xs.length, 'float' );
	const resources = { linearBuckets: buildBucketTextureNodes( [ mapTexture() ] ), shadowAlbedoMaps: null, alphaShadows: null };
	const kernel = withSceneResources( Fn( () => {

		const transmittance = traceShadowRay(
			origins.element( instanceIndex ).xyz, vec3( 0, 0, - 1 ), float( 2 ),
			traverseBVHShadow, bvhNode, tris, materialNode,
		);
		out.element( instanceIndex ).assign( transmittance );

	} )(), resources ).compute( xs.length );

	await renderer.computeAsync( kernel );
	return Array.from( new Float32Array( await renderer.getArrayBufferAsync( out.value ) ) );

}

describeGPU( 'transmission map on shadow rays', () => {

	let renderer, geometry;

	beforeAll( async () => {

		renderer = await createRenderer();
		geometry = scene();

	} );

	afterAll( () => renderer?.dispose() );

	// A ray through each third of a quad: u = 1/6, 1/2 and 5/6.
	const thirds = ( q ) => [ 1 / 3, 1, 5 / 3 ].map( ( x ) => q * 3 + x );

	it( 'is opaque where the map is black and passes the map\'s share of the light elsewhere', async () => {

		const [ black, grey, white ] = await shadowTransmittance( renderer, geometry, thirds( 0 ) );
		expect( black ).toBe( 0 );
		expect( grey ).toBeCloseTo( 128 / 255 * PASS, 4 );
		expect( white ).toBeCloseTo( PASS, 4 );

	} );

	it( 'multiplies the map by the factor', async () => {

		const [ black, grey, white ] = await shadowTransmittance( renderer, geometry, thirds( 1 ) );
		expect( black ).toBe( 0 );
		expect( grey ).toBeCloseTo( 0.5 * 128 / 255 * PASS, 4 );
		expect( white ).toBeCloseTo( 0.5 * PASS, 4 );

	} );

	it( 'leaves a surface without a map at its factor', async () => {

		expect( await shadowTransmittance( renderer, geometry, thirds( 2 ) ) ).toEqual( Array( 3 ).fill( expect.closeTo( PASS, 4 ) ) );

	} );

} );
