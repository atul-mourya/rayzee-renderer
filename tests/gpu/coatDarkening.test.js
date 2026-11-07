/**
 * OpenPBR's coat darkening: under a coat the base albedo E becomes E · lerp( 1, ( 1 − K ) / ( 1 − E·K ), coat · δ ), K the
 * coat's internal reflectance — the exact Fresnel's over a rough base, F0 over a smooth one. Compiled out, nothing moves.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { int, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { getMaterial } from '@/core/shaders/Common.js';
import { RayTracingMaterial } from '@/core/shaders/Struct.js';
import { coatDarkenedColor, COAT_INTERNAL_REFLECTANCE } from '@/core/shaders/Clearcoat.js';
import { ALL_MATERIAL_LAYERS } from '@/core/shaders/SceneResources.js';
import { MATERIAL_DATA_LAYOUT as M } from '@/core/scene/BufferLayout.js';
import { packMaterial } from '@/core/materials/MaterialPacking.js';

function internalReflectance( eta ) {

	let external = 0;
	const n = 4096;
	for ( let i = 0; i < n; i ++ ) {

		const cosI = ( i + 0.5 ) / n;
		const cosT = Math.sqrt( 1 - ( 1 - cosI * cosI ) / ( eta * eta ) );
		const rs = ( cosI - eta * cosT ) / ( cosI + eta * cosT );
		const rp = ( eta * cosI - cosT ) / ( eta * cosI + cosT );
		external += ( rs * rs + rp * rp ) * cosI / n;

	}

	return 1 - ( 1 - external ) / ( eta * eta );

}

function darkened( { color, clearcoat, coatDarkening, metalness, roughness } ) {

	const rough = 1 + ( roughness - 1 ) * metalness;
	const k = COAT_INTERNAL_REFLECTANCE.smooth + ( COAT_INTERNAL_REFLECTANCE.rough - COAT_INTERNAL_REFLECTANCE.smooth ) * rough;
	return color.map( ( e ) => e * ( 1 + ( ( 1 - k ) / ( 1 - e * k ) - 1 ) * clearcoat * coatDarkening ) );

}

const MATERIALS = [];
for ( let i = 0; i < 64; i ++ ) {

	const r = ( k ) => ( ( i * 7919 + k * 104729 ) % 997 ) / 996;
	MATERIALS.push( {
		color: [ r( 1 ), r( 2 ), r( 3 ) ], clearcoat: i % 8 === 0 ? 0 : r( 4 ), coatDarkening: i % 5 === 0 ? 1 : r( 5 ),
		metalness: i % 3 === 0 ? 0 : r( 6 ), roughness: r( 7 ),
	} );

}

describeGPU( 'coat darkening', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );
	afterAll( () => renderer?.dispose() );

	it( 'takes K over a rough base from the exact Fresnel at IOR 1.5', () => {

		expect( COAT_INTERNAL_REFLECTANCE.rough ).toBeCloseTo( internalReflectance( 1.5 ), 4 );
		expect( COAT_INTERNAL_REFLECTANCE.smooth ).toBeCloseTo( ( 0.5 / 2.5 ) ** 2, 6 );

	} );

	const run = async ( layers ) => {

		const data = new Float32Array( MATERIALS.length * M.FLOATS_PER_MATERIAL );
		MATERIALS.forEach( ( m, i ) => packMaterial( data, i * M.FLOATS_PER_MATERIAL, m ) );
		const buffer = storage( new StorageInstancedBufferAttribute( data, 4 ), 'vec4', data.length / 4 ).toReadOnly();
		const out = await evaluate( renderer, MATERIALS.length, { index: [ new Int32Array( MATERIALS.map( ( _, i ) => i ) ), 'int' ] }, 'vec4', ( { index } ) => {

			const material = RayTracingMaterial.wrap( getMaterial( int( index ), buffer ) ).toVar();
			return coatDarkenedColor( material, int( index ), buffer );

		}, { materialLayers: layers } );
		return new Float32Array( out );

	};

	it( 'deepens the base by what the coat sends back down', async () => {

		const out = await run( ALL_MATERIAL_LAYERS );
		MATERIALS.forEach( ( m, i ) => {

			const want = darkened( m );
			for ( let c = 0; c < 3; c ++ ) expect( out[ i * 4 + c ], `material ${i} channel ${c}` ).toBeCloseTo( want[ c ], 5 );

		} );

	} );

	it( 'leaves the colour alone when no material darkens', async () => {

		const out = await run( { ...ALL_MATERIAL_LAYERS, coatDarkening: false } );
		MATERIALS.forEach( ( m, i ) => {

			for ( let c = 0; c < 3; c ++ ) expect( out[ i * 4 + c ] ).toBe( Math.fround( m.color[ c ] ) );

		} );

	} );

} );
