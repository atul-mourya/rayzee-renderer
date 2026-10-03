/**
 * A BVH with its small leaves folded into their parents must trace exactly as the same BVH
 * unfolded: the same closest triangle at the same distance, and the same shadow answers.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, vec4, float } from 'three/tsl';
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
import { foldLeaves } from '@/core/Processor/BVHLeafFold.js';
import { traverseBVH, traverseBVHShadow } from '@/core/TSL/BVHTraversal.js';
import { Ray } from '@/core/TSL/Struct.js';
import { withSceneResources } from '@/core/TSL/SceneResources.js';
import { TRI_SIDE_SHIFT } from '@/core/EngineDefaults.js';

const LANES = 20;
const TRIANGLES = 4000;
const RAYS = 4096;

let seed = 3;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function scene() {

	const data = new Uint32Array( TRIANGLES * LANES );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		const x = rand() * 20, y = rand() * 20, z = rand() * 20;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + rand(), y + rand() * 0.2, z ], i * LANES + 4 );
		f.set( [ x, y + rand(), z + rand() ], i * LANES + 8 );
		data[ i * LANES + 18 ] = 2 << TRI_SIDE_SHIFT;

	}

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData };

}

function rays() {

	const origins = new Float32Array( RAYS * 4 ), dirs = new Float32Array( RAYS * 4 );
	for ( let i = 0; i < RAYS; i ++ ) {

		origins.set( [ rand() * 30 - 5, rand() * 30 - 5, - 10 ], i * 4 );
		const d = [ rand() - 0.5, rand() - 0.5, 1 ];
		const l = Math.hypot( ...d );
		dirs.set( d.map( v => v / l ), i * 4 );

	}

	return { origins, dirs };

}

async function trace( renderer, bvhNodes, folded, triangles, { origins, dirs } ) {

	const attr = new StorageInstancedBufferAttribute( bvhNodes, 4 );
	attr.foldedLeaves = folded;
	const bvh = storage( attr, 'vec4', bvhNodes.length / 4 ).toReadOnly();

	const geo = new Uint32Array( TRIANGLES * 12 ), shade = new Uint32Array( TRIANGLES * 8 );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	const tris = {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', TRIANGLES * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', TRIANGLES * 2 ).toReadOnly(),
	};

	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( RAYS, 'vec4' );
	// No textures: alpha-cutout shadows off.
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = traverseBVH( ray, bvh, tris ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( 25 ) ).toVar();
		out.element( instanceIndex ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( shadow.get( 'didHit' ) ), float( 0 ) ) );

	} )(), { alphaShadows: null } ).compute( RAYS );

	await renderer.computeAsync( kernel );
	return new Float32Array( await renderer.getArrayBufferAsync( out.value ) );

}

describeGPU( 'folded BVH traversal', () => {

	let renderer, plain, folded, nodeCounts;

	beforeAll( async () => {

		renderer = await createRenderer();
		const { bvh, triangles } = scene();
		const light = rays();
		const packed = foldLeaves( bvh );
		nodeCounts = [ bvh.length / 16, packed.length / 16 ];
		plain = await trace( renderer, bvh, false, triangles, light );
		folded = await trace( renderer, packed, true, triangles, light );

	} );

	afterAll( () => renderer?.dispose() );

	it( 'finds the same closest hits and shadow answers', () => {

		expect( nodeCounts[ 1 ] ).toBeLessThan( nodeCounts[ 0 ] * 0.6 );

		let hits = 0, shadowed = 0;
		for ( let i = 0; i < RAYS; i ++ ) {

			if ( plain[ i * 4 ] < 1e19 ) hits ++;
			if ( plain[ i * 4 + 2 ] > 0.5 ) shadowed ++;

		}

		expect( hits ).toBeGreaterThan( RAYS * 0.2 );
		expect( shadowed ).toBeGreaterThan( 0 );
		expect( Array.from( folded ) ).toEqual( Array.from( plain ) );

	} );

	it( 'reads a folded tree only with the folded code', async () => {

		// The unfolded code takes a folded left child's reference for a leaf tag and loses geometry.
		const { bvh, triangles } = scene();
		const light = rays();
		const packed = foldLeaves( bvh );
		const wrong = await trace( renderer, packed, false, triangles, light );
		const right = await trace( renderer, packed, true, triangles, light );
		expect( Array.from( wrong ) ).not.toEqual( Array.from( right ) );

	} );

} );
