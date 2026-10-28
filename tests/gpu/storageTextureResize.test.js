/**
 * A compute kernel's StorageTexture resized in place, as the path tracer's MRT would be: the same kernel node (no
 * rebuild) writes the new size, the copy into a resized RenderTarget reads it, and a second kernel samples that.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, If, instanceIndex, instancedArray, ivec2, textureLoad, textureStore, uniform, uvec2, vec4, float } from 'three/tsl';
import { RenderTarget, StorageTexture } from 'three/webgpu';
import { FloatType, LinearFilter, NearestFilter, RGBAFormat } from 'three';
import { describeGPU, createRenderer } from './gpu.js';

const MAX = 128;

describeGPU( 'StorageTexture resized under a live kernel', () => {

	let renderer, errors;

	beforeAll( async () => {

		renderer = await createRenderer();
		errors = [];
		renderer.backend.device.addEventListener( 'uncapturederror', e => errors.push( e.error.message ) );

	} );

	afterAll( () => renderer?.dispose() );

	it( 'writes, copies and reads back every pixel at each new size', async () => {

		const storageTex = new StorageTexture( 64, 48 );
		storageTex.type = FloatType;
		storageTex.format = RGBAFormat;
		storageTex.minFilter = storageTex.magFilter = LinearFilter;

		const readTarget = new RenderTarget( 64, 48, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false } );
		const width = uniform( 64, 'uint' ), height = uniform( 48, 'uint' ), stamp = uniform( 0 );

		const write = Fn( () => {

			If( instanceIndex.lessThan( width.mul( height ) ), () => {

				const x = instanceIndex.mod( width ), y = instanceIndex.div( width );
				textureStore( storageTex, uvec2( x, y ), vec4( float( x ), float( y ), stamp, 1 ) ).toWriteOnly();

			} );

		} )().compute( MAX * MAX );

		const out = instancedArray( MAX * MAX, 'vec4' );
		const read = Fn( () => {

			If( instanceIndex.lessThan( width.mul( height ) ), () => {

				const x = instanceIndex.mod( width ), y = instanceIndex.div( width );
				out.element( instanceIndex ).assign( textureLoad( readTarget.texture, ivec2( x, y ) ) );

			} );

		} )().compute( MAX * MAX );

		const sizes = [[ 64, 48, 1 ], [ 96, 80, 2 ], [ 32, 16, 3 ], [ 128, 128, 4 ], [ 64, 48, 5 ]];
		for ( const [ w, h, s ] of sizes ) {

			storageTex.setSize( w, h );
			readTarget.setSize( w, h );
			readTarget.texture.needsUpdate = true;
			width.value = w;
			height.value = h;
			stamp.value = s;

			renderer.compute( write );
			renderer.copyTextureToTexture( storageTex, readTarget.texture );
			renderer.compute( read );

			const pixels = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
			let wrong = 0;
			for ( let i = 0; i < w * h; i ++ ) {

				const x = i % w, y = Math.floor( i / w );
				if ( pixels[ i * 4 ] !== x || pixels[ i * 4 + 1 ] !== y || pixels[ i * 4 + 2 ] !== s ) wrong ++;

			}

			const { width: gpuWidth, height: gpuHeight } = renderer.backend.get( storageTex ).texture;
			expect( { size: `${w}x${h}`, wrong, gpu: `${gpuWidth}x${gpuHeight}` } ).toEqual( { size: `${w}x${h}`, wrong: 0, gpu: `${w}x${h}` } );

		}

		expect( errors ).toEqual( [] );

	} );

} );
