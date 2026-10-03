/**
 * The light guide draws each start on the disc at the density it reports there, so lights at infinity stay
 * unbiased however their light paths are steered.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataTexture, FloatType, RedFormat, Vector3 } from 'three';
import { texture, uniform, vec4, vec3 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import {
	sampleGuidedDisc, guidedDiscPdf, GUIDE_BINS, GUIDE_CELLS, GUIDE_CELL_SIDE, GUIDE_TEXTURE_WIDTH, GUIDE_UNIFORM_SHARE,
} from '@/core/TSL/LightGuide.js';

const N = 1 << 18;

describeGPU( 'light guide', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'draws starts at the density it reports', async () => {

		// Every bin: a few bright cells and a dim background, as a window would learn.
		const counts = new Float64Array( GUIDE_CELLS );
		for ( let c = 0; c < GUIDE_CELLS; c ++ ) counts[ c ] = ( c % 97 === 3 ) ? 500 : ( c % 5 === 0 ? 1 : 0 );
		const total = counts.reduce( ( a, b ) => a + b, 0 );
		const data = new Float32Array( GUIDE_TEXTURE_WIDTH * GUIDE_BINS );
		for ( let b = 0; b < GUIDE_BINS; b ++ ) {

			let run = 0;
			for ( let c = 0; c < GUIDE_CELLS; c ++ ) {

				run += counts[ c ];
				data[ b * GUIDE_TEXTURE_WIDTH + c ] = c === GUIDE_CELLS - 1 ? 1 : run / total;

			}

			data[ b * GUIDE_TEXTURE_WIDTH + GUIDE_CELLS ] = total;

		}

		const guideTex = new DataTexture( data, GUIDE_TEXTURE_WIDTH, GUIDE_BINS, RedFormat, FloatType );
		guideTex.needsUpdate = true;
		const bdpt = { sceneCenter: uniform( new Vector3( 1, - 2, 0.5 ) ), sceneRadius: uniform( 3.0 ), guide: uniform( 1, 'uint' ) };
		const toLight = vec3( 0.3, 0.8, - 0.52 ).normalize();

		let s = 7; const rnd = () => ( ( s = ( s * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
		const xi = new Float32Array( N * 4 ).map( rnd );
		const out = new Float32Array( await evaluate( renderer, N, { xi: [ xi, 'vec4' ] }, 'vec4', ( { xi: r } ) => {

			const guide = texture( guideTex );
			const start = sampleGuidedDisc( bdpt, guide, toLight, r.z, r.xy ).toVar();
			return vec4( start, guidedDiscPdf( bdpt, guide, toLight, start ) );

		} ) );

		// Back to disc coordinates (the shader's frame) to find each start's cell.
		const d = new Vector3( 0.3, 0.8, - 0.52 ).normalize();
		const u = new Vector3().crossVectors( Math.abs( d.x ) > 0.9 ? new Vector3( 0, 1, 0 ) : new Vector3( 1, 0, 0 ), d ).normalize();
		const v = new Vector3().crossVectors( d, u );
		const c = new Vector3( 1, - 2, 0.5 ), R = 3;
		const drawn = new Float64Array( GUIDE_CELLS );
		let estimate = 0, outside = 0;
		const p = new Vector3();
		for ( let i = 0; i < N; i ++ ) {

			p.set( out[ i * 4 ], out[ i * 4 + 1 ], out[ i * 4 + 2 ] ).sub( c );
			const st = [ p.dot( u ) / R, p.dot( v ) / R ];
			const gx = Math.floor( ( st[ 0 ] * 0.5 + 0.5 ) * GUIDE_CELL_SIDE ), gy = Math.floor( ( st[ 1 ] * 0.5 + 0.5 ) * GUIDE_CELL_SIDE );
			if ( gx >= 0 && gy >= 0 && gx < GUIDE_CELL_SIDE && gy < GUIDE_CELL_SIDE ) drawn[ gy * GUIDE_CELL_SIDE + gx ] ++;
			else outside ++;
			estimate += 1 / out[ i * 4 + 3 ];

		}

		// E[ 1 / p ] is the area that can be drawn: the disc, plus the counted cells outside it.
		const cellArea = ( 2 * R / GUIDE_CELL_SIDE ) ** 2;
		let area = Math.PI * R * R;
		for ( let cell = 0; cell < GUIDE_CELLS; cell ++ ) {

			if ( ! counts[ cell ] ) continue;
			const x = ( ( cell % GUIDE_CELL_SIDE ) + 0.5 ) / GUIDE_CELL_SIDE * 2 - 1, y = ( Math.floor( cell / GUIDE_CELL_SIDE ) + 0.5 ) / GUIDE_CELL_SIDE * 2 - 1;
			if ( x * x + y * y > 1 ) area += cellArea;

		}

		expect( outside ).toBe( 0 );
		expect( estimate / N / area ).toBeCloseTo( 1, 1 );

		// Each counted cell is drawn as often as its share says (uniform share aside).
		let worst = 0;
		for ( let cell = 0; cell < GUIDE_CELLS; cell ++ ) {

			if ( counts[ cell ] < 500 ) continue;
			const expected = N * ( ( 1 - GUIDE_UNIFORM_SHARE ) * counts[ cell ] / total );
			worst = Math.max( worst, Math.abs( drawn[ cell ] - expected ) / Math.sqrt( expected ) );

		}

		expect( worst ).toBeLessThan( 6 );

	} );

} );
