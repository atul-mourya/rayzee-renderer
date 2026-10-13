/**
 * refineDisplacedIntersection: the displaced normal tilts by the height field's slope in world units (through a
 * texture transform too), and the point it returns is never behind the base triangle, where every ray spawned from
 * it would hit that triangle. Points in front of it lie on the ray, on the height field.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataArrayTexture, LinearFilter, Matrix3, RepeatWrapping } from 'three';
import { instancedArray, int, float, vec3, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { refineDisplacedIntersection, DisplacementResult } from '@/core/TSL/Displacement.js';
import { buildBucketTextureNodes } from '@/core/TSL/TextureSampling.js';
import { arrayToMat3 } from '@/core/TSL/Common.js';
import { Ray, HitInfo } from '@/core/TSL/Struct.js';

// Height = map · displacementScale + displacementBias, in scene units, as three.js.
const SCALE = 0.2;

function heightTexture( size, height ) {

	const data = new Uint8Array( size * size * 4 );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) data.fill( Math.round( height( x, y ) * 255 ), ( y * size + x ) * 4, ( y * size + x ) * 4 + 4 );
	const t = new DataArrayTexture( data, size, size, 1 );
	t.minFilter = t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = RepeatWrapping;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return { texture: t, data, size };

}

// Bilinear and repeating, as the sampler reads it.
function sampleHeight( { data, size }, u, v ) {

	const x = u * size - 0.5, y = v * size - 0.5;
	const x0 = Math.floor( x ), y0 = Math.floor( y ), fx = x - x0, fy = y - y0;
	const at = ( i, j ) => data[ ( ( ( j % size ) + size ) % size * size + ( ( i % size ) + size ) % size ) * 4 ] / 255;
	return ( at( x0, y0 ) * ( 1 - fx ) + at( x0 + 1, y0 ) * fx ) * ( 1 - fy ) + ( at( x0, y0 + 1 ) * ( 1 - fx ) + at( x0 + 1, y0 + 1 ) * fx ) * fy;

}

// One triangle in z = 0 covering [-1, 1]², with uv = ( p + 1 ) / 2: dP/du = ( 2, 0, 0 ), dP/dv = ( 0, 2, 0 ).
function plane() {

	const geo = new Float32Array( [ - 1, - 1, 0, 0, 3, - 1, 0, 0, - 1, 3, 0, 0 ] );
	const shade = new Float32Array( [ 0, 0, 2, 0, 0, 2, 0, 0 ] );
	return {
		geo: instancedArray( new Uint32Array( geo.buffer ), 'uvec4' ),
		shade: instancedArray( new Uint32Array( shade.buffer ), 'uvec4' ),
	};

}

const HIT_DISTANCE = 2;

// Each ray starts HIT_DISTANCE before its hit on the plane.
function inputs( rays ) {

	const count = rays.length;
	const origin = new Float32Array( count * 4 ), dir = new Float32Array( count * 4 );
	rays.forEach( ( r, i ) => {

		dir.set( r.dir, i * 4 );
		origin.set( r.hit.map( ( h, k ) => h - HIT_DISTANCE * r.dir[ k ] ), i * 4 );

	} );
	return {
		origin: [ origin, 'vec4' ], dir: [ dir, 'vec4' ],
		// Not an instance: the leaf comes in as data, since a literal -1 folds into an out-of-bounds read of the BVH.
		leaf: [ new Int32Array( count ).fill( - 1 ), 'int' ],
	};

}

function refine( a, tris, bvh, field, { transform = new Matrix3(), scale = SCALE, bias = 0 } = {} ) {

	const e = transform.elements;
	const material = {
		displacementScale: float( scale ),
		displacementBias: float( bias ),
		displacementMapIndex: int( 0 ),
		displacementTransform: arrayToMat3( { data1: vec4( ...e.slice( 0, 4 ) ), data2: vec4( ...e.slice( 4, 8 ) ) } ),
	};
	const ray = Ray( { origin: a.origin.xyz, direction: a.dir.xyz } );
	const hitPoint = a.origin.xyz.add( a.dir.xyz.mul( HIT_DISTANCE ) );
	const hit = HitInfo( {
		didHit: true, dst: float( HIT_DISTANCE ), hitPoint, normal: vec3( 0, 0, 1 ), uv: hitPoint.xy.add( 1 ).mul( 0.5 ),
		materialIndex: int( 0 ), meshIndex: int( 0 ), instanceLeaf: a.leaf, triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
	} );
	return DisplacementResult.wrap( refineDisplacedIntersection( ray, hit, tris, material, int( 0 ), bvh, a.leaf ) )[ field ];

}

describeGPU( 'displacement', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const tris = plane();
	const bvh = instancedArray( new Float32Array( 16 ), 'vec4' );

	it( 'tilts the normal by the height field slope in world units, through a texture transform', async () => {

		// h rises one level a texel along u: dh/du = 256 / 255 in texture space.
		const ramp = heightTexture( 256, ( x ) => x / 255 );
		const resources = { linearBuckets: buildBucketTextureNodes( [ ramp.texture ] ) };

		for ( const repeat of [ 1, 2 ] ) {

			const rays = [ - 0.5, - 0.3, - 0.1 ].map( ( x ) => ( { dir: [ 0, 0, - 1, 0 ], hit: [ x, 0.1, 0, 0 ] } ) );
			const transform = new Matrix3().setUvTransform( 0, 0, repeat, 1, 0, 0, 0 );
			const out = new Float32Array( await evaluate( renderer, rays.length, inputs( rays ), 'vec4',
				( a ) => vec4( refine( a, tris, bvh, 'normal', { transform, bias: - 0.1 } ), 0 ), resources ) );

			// World slope = dh/du ÷ |dP/du|.
			const slope = SCALE * repeat * ( 256 / 255 ) / 2;
			rays.forEach( ( _, i ) => {

				const n = out.subarray( i * 4, i * 4 + 3 );
				expect( Math.abs( - n[ 0 ] / n[ 2 ] / slope - 1 ), `repeat ${repeat}, ray ${i}` ).toBeLessThan( 0.01 );
				expect( Math.abs( n[ 1 ] ) ).toBeLessThan( 1e-4 );

			} );

		}

	} );

	it.each( [
		[ 'centred', SCALE, - SCALE / 2 ],
		[ 'raised', SCALE, 0 ],
		[ 'inverted', - SCALE, SCALE / 4 ],
	] )( 'never returns a point behind the base triangle; one in front is on the ray and on the height field (%s)', async ( _, scale, bias ) => {

		const bumps = heightTexture( 64, ( x, y ) => 0.5 + 0.5 * Math.sin( 2 * Math.PI * 4 * x / 64 ) * Math.sin( 2 * Math.PI * 4 * y / 64 ) );
		const resources = { linearBuckets: buildBucketTextureNodes( [ bumps.texture ] ) };

		let seed = 11;
		const rand = () => ( ( seed = ( seed * 1103515245 + 12345 ) >>> 0 ) / 4294967296 );
		const rays = [];
		for ( let k = 0; k < 512; k ++ ) {

			const above = k % 2 === 0; // half arrive from under the surface
			const elevation = ( 10 + 70 * rand() ) * Math.PI / 180, azimuth = 2 * Math.PI * rand();
			const dir = [ Math.cos( elevation ) * Math.cos( azimuth ), Math.cos( elevation ) * Math.sin( azimuth ), above ? - Math.sin( elevation ) : Math.sin( elevation ) ];
			const hit = [ rand() - 0.5, rand() - 0.5, 0 ];
			rays.push( { above, dir: [ ...dir, 0 ], hit: [ ...hit, 0 ], origin: hit.map( ( h, i ) => h - HIT_DISTANCE * dir[ i ] ) } );

		}

		const ins = inputs( rays );
		const opts = { scale, bias };
		const points = new Float32Array( await evaluate( renderer, rays.length, ins, 'vec4', ( a ) => vec4( refine( a, tris, bvh, 'hitPoint', opts ), 0 ), resources ) );
		const uvs = new Float32Array( await evaluate( renderer, rays.length, ins, 'vec4', ( a ) => vec4( refine( a, tris, bvh, 'uv', opts ), 0, 0 ), resources ) );

		let inFront = 0;
		rays.forEach( ( r, i ) => {

			const p = points.subarray( i * 4, i * 4 + 3 );
			const z = r.above ? p[ 2 ] : - p[ 2 ];
			expect( z, `ray ${i}: behind the base triangle` ).toBeGreaterThan( - 1e-6 );
			if ( z < 1e-4 ) return;

			inFront ++;
			const d = [ p[ 0 ] - r.origin[ 0 ], p[ 1 ] - r.origin[ 1 ], p[ 2 ] - r.origin[ 2 ] ];
			const t = d[ 0 ] * r.dir[ 0 ] + d[ 1 ] * r.dir[ 1 ] + d[ 2 ] * r.dir[ 2 ];
			expect( Math.hypot( d[ 0 ] - t * r.dir[ 0 ], d[ 1 ] - t * r.dir[ 1 ], d[ 2 ] - t * r.dir[ 2 ] ), `ray ${i}: off the ray` ).toBeLessThan( 1e-4 );
			const surface = sampleHeight( bumps, uvs[ i * 4 ], uvs[ i * 4 + 1 ] ) * scale + bias;
			expect( Math.abs( p[ 2 ] - surface ), `ray ${i}: off the height field` ).toBeLessThan( Math.abs( scale ) * 0.02 );

		} );

		expect( inFront ).toBeGreaterThan( rays.length / 4 );

	} );

} );
