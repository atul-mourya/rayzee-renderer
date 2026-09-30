import { it, expect, beforeAll } from 'vitest';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/nodePlatform.js';

// dawn.node segfaults the process on these without nodePlatform()'s copy, so a failure here is a crash.
describeGPU( 'uploads from a SharedArrayBuffer', () => {

	let device;

	beforeAll( async () => {

		nodePlatform();
		device = await ( await navigator.gpu.requestAdapter() ).requestDevice();

	} );

	async function readBuffer( buffer, size ) {

		const read = device.createBuffer( { size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer( buffer, 0, read, 0, size );
		device.queue.submit( [ encoder.finish() ] );
		await read.mapAsync( GPUMapMode.READ );
		const out = new Uint32Array( read.getMappedRange().slice( 0 ) );
		read.destroy();
		return out;

	}

	it( 'writeBuffer takes an element offset and count', async () => {

		const shared = new Uint32Array( new SharedArrayBuffer( 64 ) ).map( ( _, i ) => i + 1 );
		const buffer = device.createBuffer( { size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC } );
		device.queue.writeBuffer( buffer, 0, shared, 4, 8 );

		expect( [ ...await readBuffer( buffer, 32 ) ] ).toEqual( [ 5, 6, 7, 8, 9, 10, 11, 12 ] );
		buffer.destroy();

	} );

	it( 'writeBuffer lands every piece of an upload larger than one copy', async () => {

		const size = 64 * 2 ** 20 + 256;
		const shared = new Uint32Array( new SharedArrayBuffer( size ) );
		const firstOfSecond = 2 ** 24;
		shared[ firstOfSecond - 1 ] = 1;
		shared[ firstOfSecond ] = 2;
		shared[ shared.length - 1 ] = 0xC0FFEE;
		const buffer = device.createBuffer( { size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC } );
		device.queue.writeBuffer( buffer, 0, shared );

		const out = await readBuffer( buffer, size );
		expect( [ out[ firstOfSecond - 1 ], out[ firstOfSecond ], out[ out.length - 1 ] ] ).toEqual( [ 1, 2, 0xC0FFEE ] );
		buffer.destroy();

	} );

	it( 'writeTexture too', async () => {

		const texture = device.createTexture( { size: [ 4, 4 ], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC } );
		const shared = new Uint8Array( new SharedArrayBuffer( 64 ) ).map( ( _, i ) => i );
		device.queue.writeTexture( { texture }, shared, { bytesPerRow: 16 }, [ 4, 4 ] );

		const read = device.createBuffer( { size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer( { texture }, { buffer: read, bytesPerRow: 256 }, [ 4, 4 ] );
		device.queue.submit( [ encoder.finish() ] );
		await read.mapAsync( GPUMapMode.READ );
		const bytes = new Uint8Array( read.getMappedRange() );
		expect( [ ...bytes.subarray( 256 * 3, 256 * 3 + 16 ) ] ).toEqual( [ ...shared.subarray( 48, 64 ) ] );
		read.destroy();
		texture.destroy();

	} );

} );
