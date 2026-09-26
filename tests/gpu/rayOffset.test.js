/**
 * `offsetRayOrigin` is Cycles' classic ray_offset: within 1 unit of the origin a ray starts 1e-5
 * along n, beyond it 32 float steps per axis toward n. A fixed distance either leaks out of fine
 * grooves or self-intersects far from the origin.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { offsetRayOrigin } from '@/core/TSL/Common.js';

const f32 = new Float32Array( 1 );
const i32 = new Int32Array( f32.buffer );
const bits = x => ( f32[ 0 ] = x, i32[ 0 ] );
const fromBits = b => ( i32[ 0 ] = b, f32[ 0 ] );

// `steps` representable floats toward +∞ (up) or −∞.
function stepFloat( x, steps, up ) {

	let b = bits( x );
	for ( let i = 0; i < steps; i ++ ) b += ( b >= 0 ) === up ? 1 : - 1;
	return fromBits( b );

}

const P = [ 0, 1e-7, 0.5, 0.999, 1, 1.5, 3.7, 1234.5, 1e6 ].flatMap( v => ( v ? [ v, - v ] : [ v ] ) );
const NORMAL = [ 1, - 1, 0, 0.3, - 0.7 ];

const ps = [], ns = [];
for ( const p of P ) for ( const n of NORMAL ) {

	ps.push( p, - p, p * 0.5, 0 );
	ns.push( n, - n, n * 0.5, 0 );

}

const p32 = new Float32Array( ps );
const n32 = new Float32Array( ns );
const count = p32.length / 4;

describeGPU( 'ray spawn offset', () => {

	let renderer, out;

	beforeAll( async () => {

		renderer = await createRenderer();
		out = new Float32Array( await evaluate( renderer, count, { p: [ p32, 'vec4' ], n: [ n32, 'vec4' ] }, 'vec4',
			a => vec4( offsetRayOrigin( a.p.xyz, a.n.xyz ), 0 ) ) );

	} );

	afterAll( () => renderer?.dispose() );

	const axes = () => Array.from( { length: count * 3 }, ( _, k ) => {

		const i = ( k / 3 | 0 ) * 4 + k % 3;
		return { p: p32[ i ], n: n32[ i ], got: out[ i ] };

	} );

	it( 'moves 1e-5 along the normal within one unit of the origin', () => {

		for ( const { p, n, got } of axes().filter( a => Math.abs( a.p ) < 1 ) ) {

			// One float step either way: the GPU may fuse the multiply-add.
			expect( Math.abs( bits( got ) - bits( Math.fround( p + n * 1e-5 ) ) ), `p ${p}, n ${n}` ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'moves exactly 32 float steps toward the normal beyond it', () => {

		for ( const { p, n, got } of axes().filter( a => Math.abs( a.p ) >= 1 ) ) {

			expect( got, `p ${p}, n ${n}` ).toBe( stepFloat( p, 32, n >= 0 ) );

		}

	} );

} );
