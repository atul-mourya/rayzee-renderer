/**
 * triangleUVTangent gives a triangle's tangent frame in the normal map's transformed UV space. The reference is the
 * frame of the transformed UVs themselves, worked out on the CPU. A mirrored transform (a flipped KHR_texture_transform)
 * or one turned past 90° reversed the frame before.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Matrix3 } from 'three';
import { instanceIndex, instancedArray, int } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { triangleUVTangent } from '@/core/TSL/TextureSampling.js';
import { arrayToMat3 } from '@/core/TSL/Common.js';

const uvTransform = ( ox, oy, sx, sy, rotation ) => new Matrix3().setUvTransform( ox, oy, sx, sy, rotation, 0, 0 ).elements;
const affine = ( a, b, c, d, ox, oy ) => [ a, c, 0, b, d, 0, ox, oy, 1 ]; // u' = a·u + b·v + ox, v' = c·u + d·v + oy

const TRANSFORMS = {
	identity: uvTransform( 0, 0, 1, 1, 0 ),
	repeat: uvTransform( 0.25, 0.1, 2, 3, 0 ),
	turned30: uvTransform( 0, 0, 1, 1, Math.PI / 6 ),
	turned120: uvTransform( 0, 0, 1, 1, 2 * Math.PI / 3 ),
	turned200: uvTransform( 0.3, 0.6, 1.5, 0.7, 200 * Math.PI / 180 ),
	mirroredV: uvTransform( 0, 1, 1, - 1, 0 ),
	mirroredU: uvTransform( 1, 0, - 1, 1, 0 ),
	mirroredTurned: uvTransform( 0.25, 0.9, 2, - 3, 0.5 ),
	sheared: affine( 1.2, 0.7, - 0.3, 0.9, 0.1, 0.2 ),
	shearedMirrored: affine( 0.4, 1.1, 1.3, - 0.2, 0.5, 0.5 ),
};

const TRIANGLES = 64;

function random( seed ) {

	return () => {

		seed = ( seed + 0x6D2B79F5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), seed | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
const cross = ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const normalize = ( a ) => {

	const l = Math.hypot( ...a );
	return a.map( ( v ) => v / l );

};

const apply = ( e, [ u, v ] ) => [ e[ 0 ] * u + e[ 3 ] * v + e[ 6 ], e[ 1 ] * u + e[ 4 ] * v + e[ 7 ] ];

// The standard per-triangle tangent and bitangent (dP/du, dP/dv) of the given UVs.
function frame( [ pA, pB, pC ], [ tA, tB, tC ] ) {

	const e1 = sub( pB, pA ), e2 = sub( pC, pA );
	const d1 = [ tB[ 0 ] - tA[ 0 ], tB[ 1 ] - tA[ 1 ] ], d2 = [ tC[ 0 ] - tA[ 0 ], tC[ 1 ] - tA[ 1 ] ];
	const r = 1 / ( d1[ 0 ] * d2[ 1 ] - d1[ 1 ] * d2[ 0 ] );
	return {
		T: [ 0, 1, 2 ].map( ( i ) => ( e1[ i ] * d2[ 1 ] - e2[ i ] * d1[ 1 ] ) * r ),
		B: [ 0, 1, 2 ].map( ( i ) => ( e2[ i ] * d1[ 0 ] - e1[ i ] * d2[ 0 ] ) * r ),
	};

}

function buildCases() {

	const rand = random( 7 );
	const cases = [];

	for ( const [ name, e ] of Object.entries( TRANSFORMS ) ) for ( let k = 0; k < TRIANGLES; k ++ ) {

		let positions, uvs;
		do {

			positions = [ 0, 1, 2 ].map( () => [ rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1 ] );
			uvs = [ 0, 1, 2 ].map( () => [ rand(), rand() ] );

		} while ( Math.hypot( ...cross( sub( positions[ 1 ], positions[ 0 ] ), sub( positions[ 2 ], positions[ 0 ] ) ) ) < 0.2
			|| Math.abs( ( uvs[ 1 ][ 0 ] - uvs[ 0 ][ 0 ] ) * ( uvs[ 2 ][ 1 ] - uvs[ 0 ][ 1 ] ) - ( uvs[ 1 ][ 1 ] - uvs[ 0 ][ 1 ] ) * ( uvs[ 2 ][ 0 ] - uvs[ 0 ][ 0 ] ) ) < 0.05 );

		const face = normalize( cross( sub( positions[ 1 ], positions[ 0 ] ), sub( positions[ 2 ], positions[ 0 ] ) ) );
		const N = k % 2 ? face.map( ( v ) => - v ) : face;
		const { T, B } = frame( positions, uvs.map( ( uv ) => apply( e, uv ) ) );
		cases.push( { name, e, positions, uvs, N, T: normalize( T ), w: Math.sign( dot( cross( N, T ), B ) ) } );

	}

	return cases;

}

describeGPU( 'UV tangent frame under a texture transform', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'matches the frame of the transformed UVs, mirrored and turned transforms included', async () => {

		const cases = buildCases();
		const count = cases.length;

		const geo = new Float32Array( count * 12 ), shade = new Float32Array( count * 8 );
		const d1 = new Float32Array( count * 4 ), d2 = new Float32Array( count * 4 ), n = new Float32Array( count * 4 );
		cases.forEach( ( c, i ) => {

			c.positions.forEach( ( p, row ) => geo.set( p, i * 12 + row * 4 ) );
			shade.set( [ ...c.uvs[ 0 ], ...c.uvs[ 1 ], ...c.uvs[ 2 ] ], i * 8 );
			d1.set( c.e.slice( 0, 4 ), i * 4 );
			d2.set( c.e.slice( 4, 8 ), i * 4 );
			n.set( c.N, i * 4 );

		} );

		const tris = {
			geo: instancedArray( new Uint32Array( geo.buffer ), 'uvec4' ),
			shade: instancedArray( new Uint32Array( shade.buffer ), 'uvec4' ),
		};
		// Not an instance: the leaf comes in as data, since a literal -1 folds into an out-of-bounds read of the BVH.
		const bvh = instancedArray( new Float32Array( 16 ), 'vec4' );

		const out = new Float32Array( await evaluate( renderer, count,
			{ d1: [ d1, 'vec4' ], d2: [ d2, 'vec4' ], n: [ n, 'vec4' ], leaf: [ new Int32Array( count ).fill( - 1 ), 'int' ] }, 'vec4',
			( a ) => triangleUVTangent( tris, int( instanceIndex ), a.n.xyz, arrayToMat3( { data1: a.d1, data2: a.d2 } ), bvh, a.leaf ) ) );

		const worst = {};
		cases.forEach( ( c, i ) => {

			const t = out.subarray( i * 4, i * 4 + 4 );
			const angle = Math.acos( Math.min( 1, dot( normalize( [ ...t.subarray( 0, 3 ) ] ), c.T ) ) ) * 180 / Math.PI;
			worst[ c.name ] = Math.max( worst[ c.name ] ?? 0, angle );
			expect( t[ 3 ], `${c.name} #${i % TRIANGLES} handedness` ).toBe( c.w );

		} );

		for ( const [ name, angle ] of Object.entries( worst ) ) expect( angle, `${name} tangent, degrees` ).toBeLessThan( 0.01 );

	} );

} );
