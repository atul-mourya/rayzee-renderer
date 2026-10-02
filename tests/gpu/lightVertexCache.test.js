/** Bidirectional vertex records round-trip through the hit buffer: cache, pending records, tagged path lengths. */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, If, instanceIndex, instancedArray, float, vec2, vec3, vec4, uint, normalize } from 'three/tsl';
import { describeGPU, createRenderer } from './gpu.js';
import {
	PackedRayBuffer, cachedVertex, pendingVertex, writeVertexRecord, readVertexRecord,
	writeLightPathLength, readLightPathLength,
} from '@/core/Processor/PackedRayBuffer.js';

const PATHS = 4;
const SLOTS = 8;

describeGPU( 'light vertex cache', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'keeps every field of a record, apart from its neighbours, and dates path lengths by frame', async () => {

		const pb = new PackedRayBuffer( PATHS, null, SLOTS );
		const hit = pb.hitBuffer.rw;
		const out = instancedArray( SLOTS * 4, 'vec4' );

		const record = ( i ) => {

			const f = float( i );
			return {
				position: vec3( f, f.add( 0.5 ), - 2.25 ),
				tag: uint( 0 ),
				throughput: vec3( f.mul( 3 ), 1e4, 1e-3 ),
				V: normalize( vec3( 1, f, - 1 ) ),
				N: normalize( vec3( - 1, 2, f ) ),
				facetN: normalize( vec3( 0, - 1, f.add( 1 ) ) ),
				materialIndex: uint( i ).add( uint( 7 ) ),
				uv: vec2( f.mul( 0.125 ), 0.875 ),
				dVCM: f.mul( 1e12 ),
				dVC: f.add( 1 ).mul( 1e-12 ),
				extra: uint( i ).mul( uint( 3 ) ),
			};

		};

		await renderer.computeAsync( Fn( () => {

			const i = instanceIndex;
			writeVertexRecord( hit, cachedVertex( i ), record( i ) );
			// Pending records sit in the path regions, not over the cache.
			If( i.lessThan( uint( PATHS ) ), () => {

				writeVertexRecord( hit, pendingVertex( i ), record( 99 ) );

			} );

		} )().compute( SLOTS ) );

		await renderer.computeAsync( Fn( () => {

			// Path 1 owns slots 2-3; a stale tag must read as empty.
			writeLightPathLength( hit, cachedVertex( uint( 2 ) ), uint( 5 ), uint( 2 ) );
			writeLightPathLength( hit, cachedVertex( uint( 4 ) ), uint( 4 ), uint( 1 ) );

		} )().compute( 1 ) );

		await renderer.computeAsync( Fn( () => {

			const i = instanceIndex;
			const v = readVertexRecord( hit, cachedVertex( i ) );
			const base = i.mul( uint( 4 ) );
			out.element( base ).assign( vec4( v.position, float( v.materialIndex ) ) );
			out.element( base.add( uint( 1 ) ) ).assign( vec4( v.throughput, float( v.extra ) ) );
			out.element( base.add( uint( 2 ) ) ).assign( vec4( v.V.dot( normalize( vec3( 1, float( i ), - 1 ) ) ), v.N.dot( normalize( vec3( - 1, 2, float( i ) ) ) ), v.uv ) );
			out.element( base.add( uint( 3 ) ) ).assign( vec4(
				v.dVCM, v.dVC,
				float( readLightPathLength( hit, cachedVertex( uint( 2 ) ), uint( 5 ) ) ),
				float( readLightPathLength( hit, cachedVertex( uint( 4 ) ), uint( 5 ) ) ),
			) );

		} )().compute( SLOTS ) );

		const data = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
		for ( let i = 0; i < SLOTS; i ++ ) {

			const q = ( k ) => data.subarray( ( i * 4 + k ) * 4, ( i * 4 + k ) * 4 + 4 );
			expect( Array.from( q( 0 ) ) ).toEqual( [ i, i + 0.5, - 2.25, i + 7 ] );
			expect( q( 1 )[ 0 ] ).toBe( Math.fround( i * 3 ) );
			expect( q( 1 )[ 1 ] ).toBe( 1e4 );
			expect( q( 1 )[ 2 ] ).toBe( Math.fround( 1e-3 ) );
			expect( q( 1 )[ 3 ] ).toBe( i * 3 );
			expect( q( 2 )[ 0 ] ).toBeGreaterThan( 0.99999 );
			expect( q( 2 )[ 1 ] ).toBeGreaterThan( 0.99999 );
			expect( q( 2 )[ 2 ] ).toBe( i * 0.125 );
			expect( q( 2 )[ 3 ] ).toBe( 0.875 );
			expect( q( 3 )[ 0 ] ).toBe( Math.fround( i * 1e12 ) );
			expect( q( 3 )[ 1 ] ).toBe( Math.fround( Math.fround( i + 1 ) * Math.fround( 1e-12 ) ) );
			expect( q( 3 )[ 2 ] ).toBe( 2 );
			expect( q( 3 )[ 3 ] ).toBe( 0 );

		}

		pb.dispose();

	} );

} );
