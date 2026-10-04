/**
 * Single-sided faces are culled only where the caller asks (the camera's view): a bounce that
 * culled them saw through hollow models, while shadow rays were blocked by the same faces.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, vec4, float, bool as tslBool } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
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
import { traverseBVH, traverseBVHShadow } from '@/core/TSL/BVHTraversal.js';
import { Ray } from '@/core/TSL/Struct.js';
import { withSceneResources } from '@/core/TSL/SceneResources.js';
import { TRI_SIDE_SHIFT, packNormalOct } from '@/core/Processor/BufferLayout.js';

const LANES = 20;
const SIDES = [ 0, 1, 2 ];

// One quad per side in the z = 0 plane, normal +z, side-by-side along x.
function scene() {

	const data = new Uint32Array( SIDES.length * 2 * LANES );
	const f = new Float32Array( data.buffer );
	const n = packNormalOct( 0, 0, 1 );
	SIDES.forEach( ( side, q ) => {

		const x = q * 2;
		const quad = [[[ x, 0 ], [ x + 1, 0 ], [ x + 1, 1 ]], [[ x, 0 ], [ x + 1, 1 ], [ x, 1 ]]];
		quad.forEach( ( tri, t ) => {

			const base = ( q * 2 + t ) * LANES;
			tri.forEach( ( [ px, py ], v ) => {

				f.set( [ px, py, 0 ], base + v * 4 );
				data[ base + v * 4 + 3 ] = n;

			} );
			data[ base + 18 ] = side << TRI_SIDE_SHIFT;

		} );

	} );

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData, count: SIDES.length * 2 };

}

// Per quad: a ray onto its front (from +z), then one onto its back (from -z).
function rays() {

	const origins = [], dirs = [];
	SIDES.forEach( ( side, q ) => {

		origins.push( q * 2 + 0.5, 0.5, 5, 0, q * 2 + 0.5, 0.5, - 5, 0 );
		dirs.push( 0, 0, - 1, 0, 0, 0, 1, 0 );

	} );
	return { origins: new Float32Array( origins ), dirs: new Float32Array( dirs ) };

}

async function trace( renderer, { bvh, triangles, count }, { origins, dirs }, insideMedium, cullBackFaces ) {

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

	const rayCount = origins.length / 4;
	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( rayCount, 'vec4' );
	// No textures: alpha-cutout shadows off.
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = ( cullBackFaces === undefined
			? traverseBVH( ray, bvhNode, tris )
			: traverseBVH( ray, bvhNode, tris, tslBool( insideMedium ), tslBool( cullBackFaces ) ) ).toVar();
		const shadow = traverseBVHShadow( ray, bvhNode, tris, float( 25 ) ).toVar();
		out.element( instanceIndex ).assign( vec4( float( hit.get( 'didHit' ) ), float( shadow.get( 'didHit' ) ), float( 0 ), float( 0 ) ) );

	} )(), { alphaShadows: null } ).compute( rayCount );

	await renderer.computeAsync( kernel );
	const result = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
	const pick = ( lane ) => Array.from( { length: rayCount }, ( _, i ) => result[ i * 4 + lane ] > 0.5 );
	return { hit: pick( 0 ), shadow: pick( 1 ) };

}

describeGPU( 'side culling', () => {

	let renderer, geometry, light;

	beforeAll( async () => {

		renderer = await createRenderer();
		geometry = scene();
		light = rays();

	} );

	afterAll( () => renderer?.dispose() );

	// [ front, back ] hit pairs for sides 0, 1 and 2.
	it( 'culls the unauthored side by default', async () => {

		const { hit } = await trace( renderer, geometry, light );
		expect( hit ).toEqual( [ true, false, false, true, true, true ] );

	} );

	it( 'hits either side when culling is off, or inside a medium', async () => {

		expect( ( await trace( renderer, geometry, light, false, false ) ).hit ).toEqual( [ true, true, true, true, true, true ] );
		expect( ( await trace( renderer, geometry, light, true, true ) ).hit ).toEqual( [ true, true, true, true, true, true ] );
		expect( ( await trace( renderer, geometry, light, false, true ) ).hit ).toEqual( [ true, false, false, true, true, true ] );

	} );

	it( 'blocks shadow rays from either side', async () => {

		expect( ( await trace( renderer, geometry, light ) ).shadow ).toEqual( [ true, true, true, true, true, true ] );

	} );

} );
