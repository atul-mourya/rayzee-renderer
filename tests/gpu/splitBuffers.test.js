/**
 * A BVH or triangle store past one binding's limit is split into parts (StorageParts, splitStorage). Traced over
 * parts small enough that nodes, instances and triangles all land across boundaries, every ray must hit what it hits
 * over single buffers.
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
import { StorageParts } from '@/core/TSL/patches.js';
import { splitStorage } from '@/core/TSL/Common.js';
import { traverseBVH, traverseBVHShadow } from '@/core/TSL/BVHTraversal.js';
import { Ray } from '@/core/TSL/Struct.js';
import { withSceneResources } from '@/core/TSL/SceneResources.js';
import { TRI_SIDE_SHIFT } from '@/core/Processor/BufferLayout.js';

const LANES = 20;
const TRIANGLES = 5000;
const RAYS = 4096;

let seed = 5;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function scene() {

	const data = new Uint32Array( TRIANGLES * LANES );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		const x = rand() * 20, y = rand() * 20, z = rand() * 20;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + rand(), y + rand() * 0.2, z ], i * LANES + 4 );
		f.set( [ x, y + rand(), z + rand() ], i * LANES + 8 );
		data[ i * LANES + 18 ] = ( i % 3 ) << TRI_SIDE_SHIFT;
		data[ i * LANES + 19 ] = i;
		f.set( [ rand(), rand(), rand(), rand() ], i * LANES + 12 );

	}

	const builder = new BVHBuilder();
	return { bvh: builder.flattenBVH( builder.buildSync( data ) ), triangles: builder.reorderedTriangleData };

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

function splitTriangles( triangles ) {

	const geo = new Uint32Array( TRIANGLES * 12 ), shade = new Uint32Array( TRIANGLES * 8 );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	return { geo, shade };

}

/** Read nodes over `data`: one buffer, or StorageParts of at most `partBytes` written through the backend. */
function upload( renderer, data, recordLanes, type, partBytes, folded = false ) {

	if ( ! partBytes ) {

		const attr = new StorageInstancedBufferAttribute( data, 4 );
		attr.foldedLeaves = folded;
		return { node: storage( attr, type, data.length / 4 ).toReadOnly(), count: 1 };

	}

	const parts = new StorageParts( data.length, recordLanes, partBytes, data.constructor );
	parts.create( renderer.backend );
	parts.write( renderer.backend, 0, data, 0, data.length );
	parts.attrs[ 0 ].foldedLeaves = folded;
	return { node: splitStorage( parts.attrs.map( a => storage( a, type, a.count ).toReadOnly() ), parts.elementsPerPart, type ), count: parts.attrs.length };

}

async function trace( renderer, bvh, tris, { origins, dirs }, last = 'uv' ) {

	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( RAYS, 'vec4' );
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = traverseBVH( ray, bvh, tris ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( 25 ) ).toVar();
		out.element( instanceIndex ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( shadow.get( 'didHit' ) ), last === 'uv' ? hit.get( 'uv' ).x : float( hit.get( 'meshIndex' ) ) ) );

	} )(), { alphaShadows: null } ).compute( RAYS );

	await renderer.computeAsync( kernel );
	return new Float32Array( await renderer.getArrayBufferAsync( out.value ) );

}

describeGPU( 'BVH and triangles split over buffers', () => {

	let renderer, built, light, split;

	beforeAll( async () => {

		renderer = await createRenderer();
		renderer.backend.device.addEventListener( 'uncapturederror', ( e ) => {

			throw new Error( e.error.message );

		} );
		built = scene();
		light = rays();
		split = splitTriangles( built.triangles );

	} );

	afterAll( () => renderer?.dispose() );

	// Parts as a fraction of each store; the test device grants eight storage buffers, three of them the kernel's own.
	const SPLITS = [
		{ name: 'the BVH in three parts', bvh: 2.5, geo: 0, shade: 0, counts: [ 3, 1, 1 ] },
		{ name: 'the triangle positions in three parts', bvh: 0, geo: 2.5, shade: 0, counts: [ 1, 3, 1 ] },
		{ name: 'the shading rows in two parts', bvh: 0, geo: 0, shade: 1.5, counts: [ 1, 1, 2 ] },
	];

	for ( const folded of [ false, true ] ) {

		for ( const { name, bvh: b, geo: g, shade: h, counts } of SPLITS ) {

			it( `traces ${folded ? 'a folded' : 'an unfolded'} tree identically with ${name}`, async () => {

				const nodes = folded ? foldLeaves( built.bvh ) : built.bvh;
				const single = await trace(
					renderer, upload( renderer, nodes, 16, 'vec4', 0, folded ).node,
					{ geo: upload( renderer, split.geo, 12, 'uvec4', 0 ).node, shade: upload( renderer, split.shade, 8, 'uvec4', 0 ).node },
					light
				);

				const size = ( data, f ) => ( f ? Math.ceil( data.byteLength / f ) : 0 );
				const bvh = upload( renderer, nodes, 16, 'vec4', size( nodes, b ), folded );
				const geo = upload( renderer, split.geo, 12, 'uvec4', size( split.geo, g ) );
				const shade = upload( renderer, split.shade, 8, 'uvec4', size( split.shade, h ) );
				expect( [ bvh.count, geo.count, shade.count ] ).toEqual( counts );
				const parted = await trace( renderer, bvh.node, { geo: geo.node, shade: shade.node }, light );

				let hits = 0;
				for ( let i = 0; i < RAYS * 4; i ++ ) expect( parted[ i ] ).toBe( single[ i ] );
				for ( let i = 0; i < RAYS; i ++ ) if ( single[ i * 4 ] < 1e19 ) hits ++;
				expect( hits ).toBeGreaterThan( RAYS / 4 );

			} );

		}

	}

	it( 'traces identically without texture coordinates, its UVs reading as zero', async () => {

		const bvh = upload( renderer, built.bvh, 16, 'vec4', 0 ).node;
		const geo = upload( renderer, split.geo, 12, 'uvec4', 0 ).node;
		const flagsMesh = new Uint32Array( TRIANGLES * 2 );
		for ( let i = 0; i < TRIANGLES; i ++ ) flagsMesh.set( built.triangles.subarray( i * LANES + 18, i * LANES + 20 ), i * 2 );
		const parts = new StorageParts( flagsMesh.length, 2, Math.ceil( flagsMesh.byteLength / 1.5 ), Uint32Array, 2 );
		parts.create( renderer.backend );
		parts.write( renderer.backend, 0, flagsMesh, 0, flagsMesh.length );
		expect( parts.attrs.length ).toBe( 2 );
		const lean = { geo, shade: splitStorage( parts.attrs.map( a => storage( a, 'uvec2', a.count ).toReadOnly() ), parts.elementsPerPart, 'uvec2' ), withoutUV: true };
		const full = { geo, shade: upload( renderer, split.shade, 8, 'uvec4', 0 ).node };

		for ( const last of [ 'uv', 'mesh' ] ) {

			const a = await trace( renderer, bvh, full, light, last );
			const b = await trace( renderer, bvh, lean, light, last );
			for ( let i = 0; i < RAYS; i ++ ) {

				expect( b[ i * 4 ] ).toBe( a[ i * 4 ] );
				expect( b[ i * 4 + 1 ] ).toBe( a[ i * 4 + 1 ] );
				expect( b[ i * 4 + 2 ] ).toBe( a[ i * 4 + 2 ] );
				if ( last === 'mesh' ) expect( b[ i * 4 + 3 ] ).toBe( a[ i * 4 + 3 ] );
				else if ( a[ i * 4 ] < 1e19 ) expect( b[ i * 4 + 3 ] ).toBe( 0 );

			}

		}

	} );

	it( 'keeps whole records in each part and writes across a boundary', () => {

		const parts = new StorageParts( 100 * 12, 12, 30 * 48, Uint32Array );
		expect( parts.lanesPerPart ).toBe( 30 * 12 );
		expect( parts.attrs.map( a => a.count ) ).toEqual( [ 90, 90, 90, 30 ] );

		const writes = [];
		const backend = {
			createStorageAttribute() {},
			get: ( attr ) => ( { buffer: parts.attrs.indexOf( attr ) } ),
			device: { queue: { writeBuffer: ( buffer, offset, src, srcOffset, n ) => writes.push( [ buffer, offset, srcOffset, n ] ) } },
		};
		parts.write( backend, 350, new Uint32Array( 40 ), 0, 40 );
		expect( writes ).toEqual( [[ 0, 350 * 4, 0, 10 ], [ 1, 0, 10, 30 ]] );

	} );

} );
