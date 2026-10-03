/**
 * An emitter's side test sees the same sides at any size: the density re-walks and the emitter-hit test once took
 * a raw cross product, which a small triangle's is under sideAccepts' threshold — a 3 cm bulb's density read 0 and
 * bidirectional counted its light twice.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, vec3, vec4, float, int, normalize, select } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { describeGPU, createRenderer } from './gpu.js';
import { TRI_SIDE_SHIFT, packNormalOct } from '@/core/EngineDefaults.js';
import { MATERIAL_SLOTS, MATERIAL_SLOT } from '@/core/TSL/Common.js';
import { calculateEmissiveLightPdf } from '@/core/TSL/EmissiveSampling.js';
import { sideAccepts } from '@/core/TSL/BVHTraversal.js';
import { windingNormal } from '@/core/TSL/HitFacet.js';

const LANES = 20;
const SIDES = [ 0, 1, 2 ];
const SCALES = [ 1, 1e-3 ];
const CASES = SCALES.flatMap( ( scale ) => SIDES.map( ( side ) => ( { scale, side } ) ) );

describeGPU( 'emitter sides', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'accepts the sides a triangle emits from, however small it is', async () => {

		// One triangle a case in the z = 0 plane, wound towards +z, `scale` on a side.
		const data = new Uint32Array( CASES.length * LANES );
		const f = new Float32Array( data.buffer );
		const n = packNormalOct( 0, 0, 1 );
		CASES.forEach( ( { scale, side }, i ) => {

			const x = i * 10;
			[[ x, 0 ], [ x + scale, 0 ], [ x, scale ]].forEach( ( [ px, py ], v ) => {

				f.set( [ px, py, 0 ], i * LANES + v * 4 );
				data[ i * LANES + v * 4 + 3 ] = n;

			} );
			data[ i * LANES + 18 ] = side << TRI_SIDE_SHIFT;

		} );

		const geo = new Uint32Array( CASES.length * 12 ), shade = new Uint32Array( CASES.length * 8 );
		for ( let i = 0; i < CASES.length; i ++ ) {

			geo.set( data.subarray( i * LANES, i * LANES + 12 ), i * 12 );
			shade.set( data.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

		}

		const tris = {
			geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', CASES.length * 3 ).toReadOnly(),
			shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', CASES.length * 2 ).toReadOnly(),
		};
		const material = new Float32Array( MATERIAL_SLOTS * 4 );
		material[ MATERIAL_SLOT.IOR_TRANSMISSION * 4 + 3 ] = 1;
		material.set( [ 1, 1, 1 ], MATERIAL_SLOT.EMISSIVE_ROUGHNESS * 4 );
		const materials = storage( new StorageInstancedBufferAttribute( material, 4 ), 'vec4', MATERIAL_SLOTS ).toReadOnly();
		const bvh = storage( new StorageInstancedBufferAttribute( new Float32Array( 16 ), 4 ), 'vec4', 4 ).toReadOnly();

		// Per case: seen from the front (+z), then from the back.
		const out = instancedArray( CASES.length * 2, 'vec4' );
		await renderer.computeAsync( Fn( () => {

			const tri = int( instanceIndex.div( 2 ) );
			const back = instanceIndex.mod( 2 ).equal( 1 );
			const scale = float( CASES.map( ( c ) => c.scale )[ 0 ] ).toVar();
			for ( let i = 1; i < CASES.length; i ++ ) scale.assign( select( tri.equal( int( i ) ), float( CASES[ i ].scale ), scale ) );
			const centre = vec3( float( tri ).mul( 10 ).add( scale.div( 3 ) ), scale.div( 3 ), 0 );
			const from = centre.add( vec3( 0, 0, select( back, float( - 2 ), float( 2 ) ).mul( scale ) ) ).toVar();
			// No placement: a runtime −1, as a constant one folds the unused transform's index out of bounds.
			const noLeaf = int( instanceIndex ).mul( 0 ).sub( 1 ).toVar();
			const toLight = normalize( centre.sub( from ) ).toVar();
			const pdf = calculateEmissiveLightPdf( tri, scale.mul( 2 ), toLight, from, tris, materials, float( 1 ), bvh, noLeaf );
			const shell = windingNormal( tris, bvh, tri, noLeaf );
			out.element( instanceIndex ).assign( vec4( pdf, float( sideAccepts( int( CASES[ 0 ].side ), toLight.dot( shell ) ) ), float( 0 ), float( 0 ) ) );

		} )().compute( CASES.length * 2 ) );

		const result = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
		CASES.forEach( ( { scale, side }, i ) => {

			const emits = [ side !== 1, side !== 0 ];
			emits.forEach( ( yes, back ) => {

				const pdf = result[ ( i * 2 + back ) * 4 ];
				if ( yes ) expect( pdf, `side ${side} at ${scale}, ${back ? 'back' : 'front'}` ).toBeGreaterThan( 0 );
				else expect( pdf, `side ${side} at ${scale}, ${back ? 'back' : 'front'}` ).toBe( 0 );

			} );
			// windingNormal is unit length: the front-side test it feeds flips with the view at any size.
			expect( result[ ( i * 2 ) * 4 + 1 ], `front of ${scale}` ).toBe( 1 );
			expect( result[ ( i * 2 + 1 ) * 4 + 1 ], `back of ${scale}` ).toBe( 0 );

		} );

	} );

} );
