/** The active list's bookkeeping kernels and the pixel freeze, against a JavaScript reading of the same rules. */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, instancedArray, uniform, uint } from 'three/tsl';
import { describeGPU, createRenderer } from './gpu.js';
import { COUNTER } from '@/core/pathtracer/QueueManager.js';
import {
	LIST_WG_SIZE, writeListSizes, buildCopybackKernel, buildSnapshotKernel, recordSurvivors,
} from '@/core/shaders/kernels/CompactKernel.js';
import {
	buildFreezeMaskKernel, buildActivePixelsKernel, buildCountConvergedKernel,
} from '@/core/shaders/kernels/FinalWriteKernel.js';

const W = 5, H = 4;
const CONVERGED = 0x80000000, GEOMETRY = 0x40000000;
// One at each side of the frame: a neighbour test that wraps into the next or previous row reaches them.
const LOW = new Set( [ 5, 14 ] );

const counterBuffer = ( values = {} ) => {

	const data = new Uint32Array( 16 );
	for ( const [ name, value ] of Object.entries( values ) ) data[ COUNTER[ name ] ] = value;
	return instancedArray( data, 'uint' ).toAtomic();

};

const neighbours = ( p, visit ) => {

	const x = p % W, y = Math.floor( p / W );
	for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

		const nx = x + dx, ny = y + dy;
		if ( ( dx || dy ) && nx >= 0 && nx < W && ny >= 0 && ny < H ) visit( ny * W + nx );

	}

};

describeGPU( 'active list and pixel freeze', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const run = ( fn, threads ) => renderer.computeAsync( fn().compute( threads ) );
	const read = async ( buffer ) => new Uint32Array( await renderer.getArrayBufferAsync( buffer.value ) );

	it( 'sizes a list in rows of LIST_WG_SIZE, spills past the per-dimension limit into y, and never sizes none', async () => {

		const maxGroups = 4;
		for ( const count of [ 0, 1, LIST_WG_SIZE, LIST_WG_SIZE + 1, LIST_WG_SIZE * 9 + 3 ] ) {

			const sizes = instancedArray( 3, 'uint' );
			await run( Fn( () => writeListSizes( sizes, uint( count ), maxGroups ) ), 1 );
			const groups = Math.max( 1, Math.ceil( count / LIST_WG_SIZE ) );
			expect( Array.from( await read( sizes ) ), `count ${count}` ).toEqual( [ Math.min( groups, maxGroups ), Math.ceil( groups / maxGroups ), 1 ] );

		}

	} );

	it( 'freezes a pixel once its streak reaches the stability, and dilated, only while every neighbour in the frame has', async () => {

		const stability = 3;
		const streaks = Uint32Array.from( { length: W * H }, ( _, p ) => ( LOW.has( p ) ? 1 : stability + p % 2 ) | ( p % 3 === 0 ? CONVERGED : 0 ) );
		for ( const [ frame, dilate ] of [[ 0, 1 ], [ 2, 0 ], [ 2, 1 ]] ) {

			const mask = instancedArray( W * H, 'uint' );
			await run( buildFreezeMaskKernel( {
				streak: instancedArray( streaks, 'uint' ), frozenMask: mask, frame: uniform( frame, 'uint' ),
				stability: uniform( stability, 'int' ), dilate: uniform( dilate, 'int' ),
				renderWidth: uniform( W, 'int' ), renderHeight: uniform( H, 'int' ),
			} ), W * H );

			const reached = p => ( streaks[ p ] & 0x3FFFFFFF ) >= stability;
			const expected = Array.from( { length: W * H }, ( _, p ) => {

				let frozen = frame > 0 && reached( p );
				if ( frozen && dilate ) neighbours( p, n => frozen &&= reached( n ) );
				return frozen ? 1 : 0;

			} );
			expect( Array.from( await read( mask ) ), `frame ${frame}, dilate ${dilate}` ).toEqual( expected );

		}

	} );

	it( 'lists a row band\'s unfrozen pixels by their slot in the band', async () => {

		const frozen = Uint32Array.from( { length: W * H }, ( _, p ) => ( p % 4 === 1 ? 1 : 0 ) );
		const rowBase = 1, rows = 2;
		const list = instancedArray( W * rows, 'uint' );
		const counters = counterBuffer();
		await run( buildActivePixelsKernel( {
			frozenMask: instancedArray( frozen, 'uint' ), activeIndicesRW: list, counters, maxRayCount: uniform( W * rows, 'uint' ),
			chunkRowBase: uniform( rowBase, 'int' ), renderWidth: uniform( W, 'int' ),
		} ), W * rows );

		const expected = [];
		for ( let slot = 0; slot < W * rows; slot ++ ) if ( ! frozen[ rowBase * W + slot ] ) expected.push( slot );
		const active = ( await read( counters ) )[ COUNTER.ACTIVE_RAY_COUNT ];
		expect( active ).toBe( expected.length );
		expect( Array.from( ( await read( list ) ).slice( 0, active ) ).sort( ( a, b ) => a - b ) ).toEqual( expected );

	} );

	it( 'counts a pixel converged only when it and every neighbour in the frame are, over all pixels and over geometry', async () => {

		const words = Uint32Array.from( { length: W * H }, ( _, p ) => ( LOW.has( p ) ? 0 : CONVERGED ) | ( p % 2 ? GEOMETRY : 0 ) | 2 );
		const counters = counterBuffer();
		await run( buildCountConvergedKernel( {
			streak: instancedArray( words, 'uint' ), counters, renderWidth: uniform( W, 'int' ), renderHeight: uniform( H, 'int' ),
		} ), W * H );

		let converged = 0, geometry = 0, convergedGeometry = 0;
		for ( let p = 0; p < W * H; p ++ ) {

			let all = ( words[ p ] & CONVERGED ) !== 0;
			neighbours( p, n => all &&= ( words[ n ] & CONVERGED ) !== 0 );
			const isGeometry = ( words[ p ] & GEOMETRY ) !== 0;
			converged += all; geometry += isGeometry; convergedGeometry += all && isGeometry;

		}

		const c = await read( counters );
		expect( [ c[ COUNTER.CONVERGED_COUNT ], c[ COUNTER.GEOMETRY_COUNT ], c[ COUNTER.CONVERGED_GEOMETRY_COUNT ] ] )
			.toEqual( [ converged, geometry, convergedGeometry ] );
		expect( converged ).toBeGreaterThan( 0 );
		expect( converged ).toBeLessThan( W * H );

	} );

	it( 'copies the survivors back and records them, also when none survived', async () => {

		for ( const survivors of [ 0, 3 ] ) {

			const counters = counterBuffer( { ACTIVE_RAY_COUNT: survivors, ACTIVE_ENERGY: 40 + survivors } );
			const curve = instancedArray( 8, 'uint' );
			const listB = instancedArray( Uint32Array.of( 9, 8, 7, 6 ), 'uint' );
			const listA = instancedArray( Uint32Array.of( 1, 1, 1, 1 ), 'uint' );
			const record = ( active ) => recordSurvivors( counters, curve, uint( 2 ), uint( 6 ), active );
			await run( buildCopybackKernel( { counters, survivors: listB, activeIndicesRW: listA, record } ), 4 );

			const c = await read( counters ), k = await read( curve );
			expect( Array.from( await read( listA ) ) ).toEqual( [ 9, 8, 7, 6 ].map( ( v, i ) => ( i < survivors ? v : 1 ) ) );
			expect( [ k[ 2 ], k[ 6 ], c[ COUNTER.ENTERING_COUNT ] ] ).toEqual( [ survivors, 40 + survivors, survivors ] );

		}

	} );

	it( 'records a snapshot from one thread', async () => {

		const counters = counterBuffer( { ACTIVE_RAY_COUNT: 5, ACTIVE_ENERGY: 77 } );
		const curve = instancedArray( 4, 'uint' );
		await run( buildSnapshotKernel( { counters, record: active => recordSurvivors( counters, curve, uint( 0 ), uint( 3 ), active ) } ), 1 );
		const c = await read( counters ), k = await read( curve );
		expect( [ k[ 0 ], k[ 3 ], c[ COUNTER.ENTERING_COUNT ] ] ).toEqual( [ 5, 77, 5 ] );

	} );

} );
