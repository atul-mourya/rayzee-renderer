/**
 * The bidirectional environment sampler draws each cell of its table exactly as often as the density it reports,
 * so NEE and light tracing over it are unbiased — the path tracer's interpolated inverse CDF is not.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataTexture, RedFormat, FloatType, Matrix4 } from 'three';
import { vec4, texture, uniform, vec2 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { sampleEnvironmentExact, environmentPdfExact } from '@/core/TSL/Environment.js';
import { buildExactEnvironmentTable, exactTableSize } from '@/core/Processor/EnvironmentExactTable.js';

const N = 1 << 19;

// A sky gradient with a small bright sun, RGBA, row 0 the nadir.
function makeSky( W, H ) {

	const data = new Float32Array( W * H * 4 );
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		const up = - Math.cos( ( y + 0.5 ) / H * Math.PI );
		const sun = Math.abs( x / W - 0.31 ) < 2 / W && Math.abs( y / H - 0.76 ) < 2 / H;
		const L = sun ? 400 : 0.2 + 0.8 * Math.max( 0, up );
		data.set( [ L, L * 0.9, L * 0.8, 1 ], ( y * W + x ) * 4 );

	}

	return data;

}

// The CDF texture as EnvironmentManager packs it: the exact table in the rows past the map's height.
function packTable( table, W, H ) {

	const texW = W + 1, ew = table.exactWidth, eh = table.exactHeight;
	const data = new Float32Array( texW * ( H + eh ) );
	for ( let y = 0; y < eh; y ++ ) {

		data.set( table.exactConditional.subarray( y * ew, y * ew + ew ), ( H + y ) * texW );
		data[ ( H + y ) * texW + ew ] = table.exactMarginal[ y ];

	}

	const t = new DataTexture( data, texW, H + eh, RedFormat, FloatType );
	t.needsUpdate = true;
	return t;

}

describeGPU( 'exact environment sampling', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	for ( const [ W, H ] of [[ 256, 128 ], [ 2048, 1024 ]] ) it( `draws a ${W}×${H} map's cells at the density it reports`, async () => {

		const pixels = makeSky( W, H );
		const table = buildExactEnvironmentTable( pixels, W, H );
		const { k, width: ew, height: eh } = exactTableSize( W, H );
		const cdf = packTable( table, W, H );
		const matrix = uniform( new Matrix4().makeRotationY( 0.7 ) );

		let s = 9; const rnd = () => ( ( s = ( s * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
		const xi = new Float32Array( N * 2 ).map( rnd );
		const inputs = { xi: [ xi, 'vec2' ] };
		const drawn = new Float32Array( await evaluate( renderer, N, inputs, 'vec4', ( { xi: r } ) => {

			const d = sampleEnvironmentExact( texture( cdf ), matrix, vec2( W, H ), r );
			return vec4( d.direction, d.pdf );

		} ) );
		const dirs = new Float32Array( N * 4 );
		for ( let i = 0; i < N; i ++ ) dirs.set( [ drawn[ i * 4 ], drawn[ i * 4 + 1 ], drawn[ i * 4 + 2 ], 0 ], i * 4 );
		const reported = new Float32Array( await evaluate( renderer, N, { d: [ dirs, 'vec4' ] }, 'float', ( { d } ) =>
			environmentPdfExact( texture( cdf ), matrix, vec2( W, H ), d.xyz ) ) );

		const below = ( a, j, b ) => ( j > 0 ? a[ b + j - 1 ] : 0 );
		const shares = new Float64Array( ew * eh );
		for ( let y = 0; y < eh; y ++ ) for ( let x = 0; x < ew; x ++ ) {

			shares[ y * ew + x ] = ( table.exactMarginal[ y ] - below( table.exactMarginal, y, 0 ) )
				* ( table.exactConditional[ y * ew + x ] - below( table.exactConditional, x, y * ew ) );

		}

		// The cells MIS compensation leaves weight in: E[ 1 / p ] over them is their solid angle.
		const kept = ( c ) => shares[ c ] >= 1e-5;

		// Directions back in the map's own frame, to find their texel and cell.
		const m = new Matrix4().makeRotationY( 0.7 ).elements;
		const counts = new Float64Array( ew * eh );
		let estimate = 0, mismatched = 0, keptCount = 0, upperHalf = 0, rightHalf = 0;
		for ( let i = 0; i < N; i ++ ) {

			const [ x0, y0, z0 ] = [ drawn[ i * 4 ], drawn[ i * 4 + 1 ], drawn[ i * 4 + 2 ] ];
			const dx = m[ 0 ] * x0 + m[ 4 ] * y0 + m[ 8 ] * z0, dy = m[ 1 ] * x0 + m[ 5 ] * y0 + m[ 9 ] * z0, dz = m[ 2 ] * x0 + m[ 6 ] * y0 + m[ 10 ] * z0;
			const u = Math.atan2( dz, dx ) / ( 2 * Math.PI ) + 0.5, v = 1 - Math.acos( Math.max( - 1, Math.min( 1, dy ) ) ) / Math.PI;
			const x = Math.min( W - 1, Math.floor( u * W ) ), y = Math.min( H - 1, Math.floor( v * H ) );
			const p = drawn[ i * 4 + 3 ];
			if ( Math.abs( reported[ i ] / p - 1 ) > 1e-3 ) mismatched ++;
			const cell = Math.floor( y / k ) * ew + Math.floor( x / k );
			counts[ cell ] ++;
			if ( kept( cell ) ) {

				// Uniform inside its cell, in uv, as the density says.
				estimate += 1 / p;
				keptCount ++;
				if ( ( v * eh ) % 1 >= 0.5 ) upperHalf ++;
				if ( ( u * ew ) % 1 >= 0.5 ) rightHalf ++;

			}

		}

		let solidAngle = 0;
		for ( let y = 0; y < eh; y ++ ) for ( let x = 0; x < ew; x ++ ) {

			if ( kept( y * ew + x ) ) solidAngle += ( 2 * Math.PI / ew ) * ( Math.cos( Math.PI * y / eh ) - Math.cos( Math.PI * ( y + 1 ) / eh ) );

		}

		expect( mismatched / N ).toBeLessThan( 1e-3 );
		expect( estimate / N / solidAngle ).toBeCloseTo( 1, 2 );
		expect( Math.abs( upperHalf / keptCount - 0.5 ) ).toBeLessThan( 0.01 );
		expect( Math.abs( rightHalf / keptCount - 0.5 ) ).toBeLessThan( 0.01 );

		let worst = 0;
		for ( let y = 0; y < eh; y ++ ) for ( let x = 0; x < ew; x ++ ) {

			const expected = shares[ y * ew + x ] * N;
			if ( expected >= 400 ) worst = Math.max( worst, Math.abs( counts[ y * ew + x ] - expected ) / Math.sqrt( expected ) );

		}

		expect( worst ).toBeLessThan( 6 );

	} );

} );
