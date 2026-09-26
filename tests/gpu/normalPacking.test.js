/**
 * Triangle normals are packed on the CPU (`EngineDefaults.packNormalOct`) and unpacked in WGSL
 * (`unpackTriangleNormal`); the hit record packs in WGSL too. Both directions are checked.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { packNormalOct, unpackNormalOct } from '@/core/EngineDefaults.js';
import { packNormalOct as packNormalOctGPU, unpackTriangleNormal } from '@/core/TSL/Common.js';

const MAX_ERROR_DEG = 0.03;

// A Fibonacci sphere plus the octahedron's vertices and seams, where the fold is decided.
const dirs = [];
const N = 16384;
for ( let i = 0; i < N; i ++ ) {

	const z = 1 - 2 * ( i + 0.5 ) / N, r = Math.sqrt( 1 - z * z ), phi = i * Math.PI * ( 3 - Math.sqrt( 5 ) );
	dirs.push( [ r * Math.cos( phi ), r * Math.sin( phi ), z ] );

}

for ( const [ x, y, z ] of [[ 1, 0, 0 ], [ - 1, 0, 0 ], [ 0, 1, 0 ], [ 0, - 1, 0 ], [ 0, 0, 1 ], [ 0, 0, - 1 ], [ 1, 1, 0 ], [ - 1, 1, 0 ], [ 1, - 1, 0 ], [ - 1, - 1, 0 ], [ 1, 1, - 1e-4 ], [ - 1, 1, - 1e-4 ]] ) {

	const len = Math.hypot( x, y, z );
	dirs.push( [ x / len, y / len, z / len ] );

}

const directions = new Float32Array( dirs.flat().flatMap( ( v, i ) => ( i % 3 === 2 ? [ v, 0 ] : [ v ] ) ) );

const angleDeg = ( a, b ) => Math.acos( Math.min( 1, a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ] ) ) * 180 / Math.PI;
const lanes = p => [ ( p << 16 ) >> 16, p >> 16 ];

describeGPU( 'octahedral normal packing', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'CPU-packed normals decode on the GPU', async () => {

		const packed = new Uint32Array( dirs.map( d => packNormalOct( ...d ) ) );
		const out = new Float32Array( await evaluate( renderer, dirs.length, { p: [ packed, 'uint' ] }, 'vec4',
			a => vec4( unpackTriangleNormal( a.p ), 0 ) ) );

		let worst = 0;
		dirs.forEach( ( d, i ) => void ( worst = Math.max( worst, angleDeg( d, out.subarray( i * 4, i * 4 + 3 ) ) ) ) );
		expect( worst ).toBeLessThan( MAX_ERROR_DEG );

	} );

	it( 'GPU-packed normals decode on the CPU and match the CPU encoding', async () => {

		const gpu = new Uint32Array( await evaluate( renderer, dirs.length, { d: [ directions, 'vec4' ] }, 'uint',
			a => packNormalOctGPU( a.d.xyz ) ) );

		const out = [ 0, 0, 0 ];
		let worst = 0, identical = 0;
		dirs.forEach( ( d, i ) => {

			worst = Math.max( worst, angleDeg( d, unpackNormalOct( gpu[ i ], out ) ) );

			const cpu = packNormalOct( ...d );
			const [ gu, gv ] = lanes( gpu[ i ] ), [ cu, cv ] = lanes( cpu );
			expect( Math.max( Math.abs( gu - cu ), Math.abs( gv - cv ) ), `normal ${d}` ).toBeLessThanOrEqual( 1 );
			if ( gpu[ i ] === cpu ) identical ++;

		} );

		expect( worst ).toBeLessThan( MAX_ERROR_DEG );

		// Ties round differently (WGSL to even, Math.round up) and f32 differs from f64: 0.13 % measured.
		expect( identical / dirs.length ).toBeGreaterThan( 0.99 );

	} );

	it( 'decodes a degenerate normal as +Z on both sides', async () => {

		const packed = new Uint32Array( [ packNormalOct( 0, 0, 0 ) ] );
		const out = new Float32Array( await evaluate( renderer, 1, { p: [ packed, 'uint' ] }, 'vec4', a => vec4( unpackTriangleNormal( a.p ), 0 ) ) );
		const [ zero ] = new Uint32Array( await evaluate( renderer, 1, { d: [ new Float32Array( 4 ), 'vec4' ] }, 'uint', a => packNormalOctGPU( a.d.xyz ) ) );

		expect( [ ...out.subarray( 0, 3 ) ] ).toEqual( [ 0, 0, 1 ] );
		expect( zero ).toBe( packed[ 0 ] );

	} );

} );
