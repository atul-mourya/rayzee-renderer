/**
 * A push past the end of the traversal stack is dropped — the nearer child, and with it the geometry the ray should
 * have hit. A tree is walked with the stack its own need asks for (bvh/TraversalStack.js).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, vec4, float } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { describeGPU, createRenderer } from './gpu.js';
import { traverseBVH, traverseBVHShadow } from '@/core/shaders/BVHTraversal.js';
import { Ray } from '@/core/shaders/Struct.js';
import { withSceneResources } from '@/core/shaders/SceneResources.js';
import { traversalStackNeed, traversalStackSize } from '@/core/bvh/TraversalStack.js';
import { BVH_LEAF_MARKERS, TRI_SIDE_SHIFT } from '@/core/scene/BufferLayout.js';

// Inner nodes 0..depth−1, each over a side leaf further along the ray (a triangle beside it) and the rest of the
// chain; node `depth` holds the triangle the ray crosses. Every level enters both children, nearer last.
function chain( depth ) {

	const u = new Uint32Array( ( 2 * depth + 1 ) * 16 ), f = new Float32Array( u.buffer );
	for ( let i = 0; i < depth; i ++ ) {

		const o = i * 16;
		f.set( [ - 1, - 1, 5 ], o ); u[ o + 3 ] = depth + 1 + i;
		f.set( [ 1, 1, 6 ], o + 4 ); u[ o + 7 ] = i + 1;
		f.set( [ - 1, - 1, 0 ], o + 8 ); f.set( [ 1, 1, 1 ], o + 12 );

	}

	const leaf = ( n, tri ) => [ u[ n * 16 ], u[ n * 16 + 1 ], u[ n * 16 + 3 ] ] = [ tri, 1, BVH_LEAF_MARKERS.TRIANGLE_LEAF ];
	leaf( depth, 0 );
	for ( let i = 0; i < depth; i ++ ) leaf( depth + 1 + i, 1 );
	return f;

}

const TRIS = [
	[[ - 0.5, - 0.5, 0.5 ], [ 0.5, - 0.5, 0.5 ], [ 0, 0.5, 0.5 ]], // across the ray, 5.5 along it
	[[ 0.8, 0.8, 5.5 ], [ 0.9, 0.8, 5.5 ], [ 0.8, 0.9, 5.5 ]], // beside it
];

async function trace( renderer, nodes, stack ) {

	const attr = new StorageInstancedBufferAttribute( nodes, 4 );
	if ( stack ) attr.traversalStack = stack;
	const bvh = storage( attr, 'vec4', nodes.length / 4 ).toReadOnly();

	const geo = new Uint32Array( TRIS.length * 12 ), shade = new Uint32Array( TRIS.length * 8 );
	const fg = new Float32Array( geo.buffer );
	TRIS.forEach( ( t, i ) => {

		t.forEach( ( p, k ) => fg.set( p, i * 12 + k * 4 ) );
		shade[ i * 8 + 6 ] = 2 << TRI_SIDE_SHIFT;

	} );
	const tris = {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', TRIS.length * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', TRIS.length * 2 ).toReadOnly(),
	};

	const out = instancedArray( 1, 'vec4' );
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: vec4( 0, 0, - 5, 0 ).xyz, direction: vec4( 0, 0, 1, 0 ).xyz } );
		const hit = traverseBVH( ray, bvh, tris ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( 25 ) ).toVar();
		out.element( instanceIndex ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( shadow.get( 'didHit' ) ), float( 0 ) ) );

	} )(), { alphaShadows: null } ).compute( 1 );

	await renderer.computeAsync( kernel );
	return Array.from( new Float32Array( await renderer.getArrayBufferAsync( out.value ) ) );

}

describeGPU( 'traversal stack sized for the tree', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );

	afterAll( () => renderer?.dispose() );

	it( 'loses the triangle at the bottom of a 50-deep chain with the old 40, and finds it with the size it needs', async () => {

		const nodes = chain( 50 );
		expect( traversalStackNeed( nodes ) ).toBe( 51 );

		const old = await trace( renderer, nodes, null );
		expect( old[ 0 ] ).toBeGreaterThan( 1e19 );
		expect( old[ 2 ] ).toBe( 0 );

		const sized = await trace( renderer, nodes, traversalStackSize( nodes ) );
		expect( sized[ 0 ] ).toBeCloseTo( 5.5, 4 );
		expect( sized[ 1 ] ).toBe( 0 );
		expect( sized[ 2 ] ).toBe( 1 );

	} );

	it( 'reaches the bottom of a chain within 40 either way', async () => {

		const nodes = chain( 38 );
		expect( traversalStackSize( nodes ) ).toBe( 40 );
		expect( ( await trace( renderer, nodes, null ) )[ 0 ] ).toBeCloseTo( 5.5, 4 );

	} );

} );
