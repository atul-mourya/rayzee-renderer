import { it, expect, beforeAll, afterAll } from 'vitest';
import { RenderTarget, FloatType, RGBAFormat, NearestFilter, DataTexture } from 'three';
import { QuadMesh, NodeMaterial } from 'three/webgpu';
import { vec4, screenCoordinate } from 'three/tsl';
import { describeGPU, createRenderer } from './gpu.js';
import { readPixels, TextureReadback } from '@/core/Processor/TextureReadback.js';

describeGPU( 'readPixels', () => {

	let renderer;

	beforeAll( async () => {

		renderer = await createRenderer();

	} );

	afterAll( () => renderer?.dispose() );

	// 37 px of rgba32float is 592 bytes a row, which WebGPU copies out padded to 768.
	it.each( [[ 37, 5 ], [ 16, 3 ]] )( 'reads a %i×%i target with tight rows', async ( width, height ) => {

		const target = new RenderTarget( width, height, { type: FloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } );
		const material = new NodeMaterial();
		material.outputNode = vec4( screenCoordinate.xy, 0, 1 );
		renderer.setRenderTarget( target );
		new QuadMesh( material ).render( renderer );
		renderer.setRenderTarget( null );

		const data = await readPixels( renderer, target, width, height );

		expect( data.length ).toBe( width * height * 4 );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			expect( [ data[ ( y * width + x ) * 4 ], data[ ( y * width + x ) * 4 + 1 ] ] ).toEqual( [ x + 0.5, y + 0.5 ] );

		}

		target.dispose();
		material.dispose();

	} );

	it( 'reads a published texture back as it holds it', async () => {

		const width = 37, height = 5;
		const pixels = Float32Array.from( { length: width * height * 4 }, ( _, i ) => i );
		const source = new DataTexture( pixels, width, height, RGBAFormat, FloatType );
		source.needsUpdate = true;

		const readback = new TextureReadback( renderer );
		expect( Array.from( await readback.read( source, width, height ) ) ).toEqual( Array.from( pixels ) );
		readback.dispose();
		source.dispose();

	} );

} );
