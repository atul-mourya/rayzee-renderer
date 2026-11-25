/**
 * Shadow rays through layers light passes. One walk keeps the nearest few and they are resolved after it, nearest
 * first; more layers take further walks, a surface that may block ends its walk, and past 16 resolved the light goes
 * through, as when every surface took a walk. Each scene mode (SceneResources' `seeThrough`) and each shadow ray is held
 * to what the layers let through.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, float, uniform, vec3, vec4 } from 'three/tsl';
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
import { traceShadowRay, traceShadowRayRefractiveOpaque, traceShadowRayCameraCulled } from '@/core/shaders/LightsDirect.js';
import { buildBucketTextureNodes } from '@/core/shaders/TextureSampling.js';
import { withSceneResources } from '@/core/shaders/SceneResources.js';
import { packMaterial } from '@/core/materials/MaterialPacking.js';
import { MATERIAL_DATA_LAYOUT, packNormalOct, packTriangleFlags } from '@/core/scene/BufferLayout.js';

const LANES = 20;
const ABSORB = [ 0.5, 0.25, 0.8 ];
const [ SHEER, WALL, HOLE, LEAF, GLASS, MEDIUM, FRONT ] = [ 0, 1, 2, 3, 4, 5, 6 ];
const MATERIALS = [
	{ transparent: 1, opacity: 0.25, side: 2 }, // passes 0.75
	{ side: 2 },
	{ alphaMode: 1, opacity: 0.2, side: 2 }, // alpha-tested, under its cutoff: passes all
	{ alphaMode: 1, side: 2 }, // alpha-tested, over it: blocks
	{ transmission: 1, ior: 1.5, side: 2 }, // passes 0.96 a face
	{ transmission: 1, ior: 1, side: 2, attenuationColor: ABSORB, attenuationDistance: 0.5 },
	{ side: 0 },
];

// A column is its layers, front to back: a material (at depth 1, 2, …) or { m, z, back }.
const layers = ( m, count ) => Array( count ).fill( m );
const COLUMNS = {
	three: layers( SHEER, 3 ),
	six: layers( SHEER, 6 ),
	twenty: layers( SHEER, 20 ),
	wallBehind: [ ...layers( SHEER, 5 ), WALL ],
	wallBetween: [ SHEER, SHEER, WALL, SHEER, SHEER ],
	holesThenSheer: [ HOLE, HOLE, HOLE, SHEER, SHEER ],
	leafBehind: [ SHEER, SHEER, LEAF ],
	mixed: [ SHEER, HOLE, SHEER, HOLE, SHEER, SHEER, SHEER ],
	// A sheer layer inside a medium: its far face absorbs over the stretch since that layer, 0.3.
	medium: [ SHEER, { m: MEDIUM, z: - 2 }, { m: SHEER, z: - 2.2 }, { m: MEDIUM, z: - 2.5, back: true } ],
	pane: [ GLASS, GLASS ],
	empty: [],
	holes: layers( HOLE, 3 ),
	holesThenLeaf: [ HOLE, HOLE, LEAF ],
	holesPastBudget: [ ...layers( HOLE, 17 ), LEAF ],
	wall: [ WALL ],
	facingRay: [ FRONT ],
	facingAway: [ { m: FRONT, z: - 1, back: true } ],
};
const NAMES = Object.keys( COLUMNS );

function scene() {

	const quads = NAMES.flatMap( ( name, c ) => COLUMNS[ name ].map( ( layer, i ) => ( { c, z: - ( i + 1 ), back: false, ...( typeof layer === 'number' ? { m: layer } : layer ) } ) ) );
	const data = new Uint32Array( quads.length * 2 * LANES );
	const f = new Float32Array( data.buffer );
	quads.forEach( ( { c, m, z, back }, q ) => {

		const n = packNormalOct( 0, 0, back ? - 1 : 1 );
		[[[ 0, 0 ], [ 1, 0 ], [ 1, 1 ]], [[ 0, 0 ], [ 1, 1 ], [ 0, 1 ]]].forEach( ( tri, t ) => {

			const base = ( q * 2 + t ) * LANES;
			const corners = back ? [ tri[ 0 ], tri[ 2 ], tri[ 1 ] ] : tri;
			corners.forEach( ( [ u, v ], i ) => {

				f.set( [ c * 3 + u * 2, v, z ], base + i * 4 );
				data[ base + i * 4 + 3 ] = n;

			} );
			f.set( [ ...corners[ 0 ], ...corners[ 1 ], ...corners[ 2 ] ], base + 12 );
			data[ base + 18 ] = packTriangleFlags( m, MATERIALS[ m ] );

		} );

	} );

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData, count: quads.length * 2 };

}

const white = () => {

	const texture = new DataArrayTexture( new Uint8Array( 4 * 4 * 4 ).fill( 255 ), 4, 4, 1 );
	texture.needsUpdate = true;
	return texture;

};

/** What gets down each named column, or `up` it from behind: [ r, g, b ]. */
async function transmittance( renderer, { bvh, triangles, count }, names, { seeThrough = 2, trace = traceShadowRay, up = false } = {} ) {

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

	const origins = instancedArray( new Float32Array( names.flatMap( ( name ) => [ NAMES.indexOf( name ) * 3 + 1, 0.5, up ? - 30 : 1, 0 ] ) ), 'vec4' );
	const out = instancedArray( names.length, 'vec4' );
	const resources = {
		linearBuckets: buildBucketTextureNodes( [ white() ] ),
		shadowAlbedoMaps: buildBucketTextureNodes( [ white() ] ),
		alphaShadows: uniform( 1, 'int' ),
		seeThrough,
	};
	const kernel = withSceneResources( Fn( () => {

		const light = trace( origins.element( instanceIndex ).xyz, vec3( 0, 0, up ? 1 : - 1 ), float( 100 ), bvhNode, tris, materialNode );
		out.element( instanceIndex ).assign( vec4( vec3( light ), 1 ) );

	} )(), resources ).compute( names.length );

	await renderer.computeAsync( kernel );
	const rgba = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
	return Object.fromEntries( names.map( ( name, i ) => [ name, Array.from( rgba.subarray( i * 4, i * 4 + 3 ) ) ] ) );

}

describeGPU( 'shadow rays through layers light passes', () => {

	let renderer, geometry;

	beforeAll( async () => {

		renderer = await createRenderer();
		geometry = scene();

	} );

	afterAll( () => renderer?.dispose() );

	const grey = ( v ) => [ v, v, v ].map( ( c ) => expect.closeTo( c, 5 ) );

	it( 'multiplies what each layer passes, within one walk and over several', async () => {

		const got = await transmittance( renderer, geometry, [ 'three', 'six', 'pane', 'empty' ] );
		expect( got.three ).toEqual( grey( 0.75 ** 3 ) );
		expect( got.six ).toEqual( grey( 0.75 ** 6 ) );
		expect( got.pane ).toEqual( grey( 0.96 ** 2 ) );
		expect( got.empty ).toEqual( [ 1, 1, 1 ] );

	} );

	it( 'lets the light through past 16 layers', async () => {

		const got = await transmittance( renderer, geometry, [ 'twenty', 'holesPastBudget' ] );
		expect( got.twenty ).toEqual( grey( 0.75 ** 16 ) );
		expect( got.holesPastBudget ).toEqual( [ 1, 1, 1 ] );

	} );

	it( 'is blocked by a wall behind or between the layers', async () => {

		const got = await transmittance( renderer, geometry, [ 'wallBehind', 'wallBetween', 'leafBehind' ] );
		expect( got ).toEqual( { wallBehind: [ 0, 0, 0 ], wallBetween: [ 0, 0, 0 ], leafBehind: [ 0, 0, 0 ] } );

	} );

	it( 'passes alpha-tested layers among the others', async () => {

		const got = await transmittance( renderer, geometry, [ 'holesThenSheer', 'mixed' ] );
		expect( got.holesThenSheer ).toEqual( grey( 0.75 ** 2 ) );
		expect( got.mixed ).toEqual( grey( 0.75 ** 5 ) );

	} );

	it( 'resolves the layers nearest first: a medium absorbs over the stretch since the layer before', async () => {

		const { medium } = await transmittance( renderer, geometry, [ 'medium' ] );
		medium.forEach( ( c, i ) => expect( c ).toBeCloseTo( 0.75 ** 2 * ABSORB[ i ] ** ( 0.3 / 0.5 ), 4 ) );
		// From behind the layers come the other way round, whatever order the walk met them in: the stretch is 0.2.
		const back = await transmittance( renderer, geometry, [ 'medium', 'six' ], { up: true } );
		back.medium.forEach( ( c, i ) => expect( c ).toBeCloseTo( 0.75 ** 2 * ABSORB[ i ] ** ( 0.2 / 0.5 ), 4 ) );
		expect( back.six ).toEqual( grey( 0.75 ** 6 ) );

	} );

	it( 'resolves a scene of alpha-tested surfaces alone one a walk', async () => {

		const got = await transmittance( renderer, geometry, [ 'holes', 'holesThenLeaf', 'holesPastBudget', 'wall', 'empty' ], { seeThrough: 1 } );
		expect( got ).toEqual( { holes: [ 1, 1, 1 ], holesThenLeaf: [ 0, 0, 0 ], holesPastBudget: [ 1, 1, 1 ], wall: [ 0, 0, 0 ], empty: [ 1, 1, 1 ] } );

	} );

	it( 'takes any hit for a blocker in a scene light passes nothing of', async () => {

		const got = await transmittance( renderer, geometry, [ 'wall', 'empty' ], { seeThrough: 0 } );
		expect( got ).toEqual( { wall: [ 0, 0, 0 ], empty: [ 1, 1, 1 ] } );

	} );

	it( 'has glass block where light paths carry what refracts, and still passes the other layers', async () => {

		const got = await transmittance( renderer, geometry, [ 'six', 'mixed', 'pane', 'medium', 'wallBehind' ], { trace: traceShadowRayRefractiveOpaque } );
		expect( got.six ).toEqual( grey( 0.75 ** 6 ) );
		expect( got.mixed ).toEqual( grey( 0.75 ** 5 ) );
		expect( got ).toMatchObject( { pane: [ 0, 0, 0 ], medium: [ 0, 0, 0 ], wallBehind: [ 0, 0, 0 ] } );

	} );

	it( 'passes the faces a camera ray back along it would cull, in every scene mode', async () => {

		for ( const seeThrough of [ 0, 1, 2 ] ) {

			const culled = await transmittance( renderer, geometry, [ 'facingRay', 'facingAway', 'wall' ], { seeThrough, trace: traceShadowRayCameraCulled } );
			expect( culled ).toEqual( { facingRay: [ 1, 1, 1 ], facingAway: [ 0, 0, 0 ], wall: [ 0, 0, 0 ] } );
			const plain = await transmittance( renderer, geometry, [ 'facingRay', 'facingAway' ], { seeThrough, trace: traceShadowRayRefractiveOpaque } );
			expect( plain ).toEqual( { facingRay: [ 0, 0, 0 ], facingAway: [ 0, 0, 0 ] } );

		}

	} );

} );
