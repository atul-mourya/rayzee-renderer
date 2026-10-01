import { it, expect, beforeAll } from 'vitest';
import { describeGPU } from './gpu.js';
import { OIDNDenoiser } from '@/core/Passes/OIDNDenoiser.js';

describeGPU( 'OIDN input copy', () => {

	let device;

	beforeAll( async () => {

		device = await ( await navigator.gpu.requestAdapter() ).requestDevice();

	} );

	async function read( buffer ) {

		const map = device.createBuffer( { size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer( buffer, 0, map, 0, buffer.size );
		device.queue.submit( [ encoder.finish() ] );
		await map.mapAsync( GPUMapMode.READ );
		const out = new Uint32Array( map.getMappedRange().slice( 0 ) );
		map.destroy();
		return out;

	}

	// 37 px rows are 592 bytes, which copyTextureToBuffer refuses; 16 px rows are exactly 256.
	it.each( [[ 37, 5 ], [ 16, 3 ]] )( 'packs a %i×%i render bit for bit', async ( width, height ) => {

		const names = [ 'color', 'albedo', 'normal' ];
		const pixels = names.map( ( _, k ) => Float32Array.from( { length: width * height * 4 }, ( _, i ) => ( i * 0.37 - 50 ) * ( k + 1 ) ) );
		const textures = Object.fromEntries( names.map( ( name, k ) => {

			const texture = device.createTexture( {
				size: [ width + 3, height + 2 ], format: 'rgba32float',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
			} );
			device.queue.writeTexture( { texture }, pixels[ k ], { bytesPerRow: width * 16, rowsPerImage: height }, [ width, height ] );
			return [ name, texture ];

		} ) );

		const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
		const pass = Object.assign( Object.create( OIDNDenoiser.prototype ), {
			_gpuInputBuffers: Object.fromEntries( names.map( name => [ name, device.createBuffer( { size: width * height * 16, usage } ) ] ) ),
		} );

		pass._copyInputs( device, textures, width, height );

		for ( const [ k, name ] of names.entries() ) {

			expect( await read( pass._gpuInputBuffers[ name ] ) ).toEqual( new Uint32Array( pixels[ k ].buffer ) );

		}

	} );

} );
