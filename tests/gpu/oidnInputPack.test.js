import { it, expect, beforeAll } from 'vitest';
import { describeGPU } from './gpu.js';
import { OIDNDenoiser } from '@/core/Passes/OIDNDenoiser.js';

const BORDER = 16;
const align = n => Math.ceil( ( n + 2 * BORDER ) / 16 ) * 16;
const mirror = ( i, n ) => {

	const m = Math.abs( i );
	return Math.min( Math.max( m >= n ? 2 * n - 2 - m : m, 0 ), n - 1 );

};

describeGPU( 'OIDN input copy', () => {

	let device;

	beforeAll( async () => {

		device = await ( await navigator.gpu.requestAdapter() ).requestDevice();

	} );

	async function read( buffer, size = buffer.size ) {

		const map = device.createBuffer( { size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer( buffer, 0, map, 0, size );
		device.queue.submit( [ encoder.finish() ] );
		await map.mapAsync( GPUMapMode.READ );
		const out = map.getMappedRange().slice( 0 );
		map.destroy();
		return out;

	}

	function texture( pixels, width, height ) {

		const tex = device.createTexture( {
			size: [ width + 3, height + 2 ], format: 'rgba32float',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
		} );
		device.queue.writeTexture( { texture: tex }, pixels, { bytesPerRow: width * 16, rowsPerImage: height }, [ width, height ] );
		return tex;

	}

	function pass( width, height ) {

		const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
		const size = align( width ) * align( height ) * 16;
		return Object.assign( Object.create( OIDNDenoiser.prototype ), {
			gpuDevice: device,
			_renderWidth: width,
			_renderHeight: height,
			_gpuInputBufferSize: { width, height },
			_gpuInputBuffers: Object.fromEntries( [ 'color', 'albedo', 'normal' ].map( name => [ name, device.createBuffer( { size, usage } ) ] ) ),
		} );

	}

	// 5 rows is less than the border, so its mirror folds back on itself and clamps.
	it.each( [[ 37, 5 ], [ 16, 3 ], [ 48, 32 ]] )( 'packs a %i×%i render inside a mirrored border', async ( width, height ) => {

		const names = [ 'color', 'albedo', 'normal' ];
		const pixels = names.map( ( _, k ) => Float32Array.from( { length: width * height * 4 }, ( _, i ) => ( i * 0.37 - 50 ) * ( k + 1 ) ) );
		const textures = Object.fromEntries( names.map( ( name, k ) => [ name, texture( pixels[ k ], width, height ) ] ) );

		const p = pass( width, height );
		p._copyInputs( device, textures, width, height );

		const W = align( width ), H = align( height );
		for ( const [ k, name ] of names.entries() ) {

			const expected = new Float32Array( W * H * 4 );
			for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

				const s = ( mirror( y - BORDER, height ) * width + mirror( x - BORDER, width ) ) * 4;
				expected.set( pixels[ k ].subarray( s, s + 4 ), ( y * W + x ) * 4 );

			}

			expect( new Uint32Array( await read( p._gpuInputBuffers[ name ] ) ) ).toEqual( new Uint32Array( expected.buffer ) );

		}

	} );

	it( 'meters exposure on the frame, not its border', async () => {

		const width = 21, height = 9;
		const W = align( width ), H = align( height );
		const p = pass( width, height );

		// The frame at luminance 2, the border at 1000: a metered border would move the scale.
		const color = new Float32Array( W * H * 4 ).fill( 1000 );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) color.set( [ 2, 2, 2, 1 ], ( ( y + BORDER ) * W + x + BORDER ) * 4 );
		device.queue.writeBuffer( p._gpuInputBuffers.color, 0, color );

		p._computeInputScale( device, width, height );

		const scale = new Float32Array( await read( p._inputScaleBuffer ) )[ 0 ];
		expect( scale ).toBeCloseTo( 0.18 / 2.0001, 5 );

	} );

	it( 'writes the denoised frame without its border', async () => {

		const width = 21, height = 9;
		const W = align( width ), H = align( height );
		const p = pass( width, height );

		const out = Float32Array.from( { length: W * H * 4 }, ( _, i ) => ( i >> 2 ) % 2048 );
		const src = device.createBuffer( { size: out.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
		device.queue.writeBuffer( src, 0, out );
		p._ensureScalePipelines( device );
		device.queue.writeBuffer( p._inputScaleBuffer, 0, new Float32Array( [ 1 ] ) );

		p._unpackToTexture( src, { x: 0, y: 0, width, height } );

		const rowBytes = 256;
		const map = device.createBuffer( { size: rowBytes * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer( { texture: p._outGPUTexture }, { buffer: map, bytesPerRow: rowBytes }, [ width, height ] );
		device.queue.submit( [ encoder.finish() ] );
		await map.mapAsync( GPUMapMode.READ );
		const half = new Uint16Array( map.getMappedRange().slice( 0 ) );
		map.destroy();

		const toFloat = h => {

			const e = ( h >> 10 ) & 31, f = h & 1023;
			return e ? ( 1 + f / 1024 ) * 2 ** ( e - 15 ) : f / 1024 * 2 ** - 14;

		};

		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			expect( toFloat( half[ y * rowBytes / 2 + x * 4 ] ) ).toBe( ( ( y + BORDER ) * W + x + BORDER ) % 2048 );

		}

	} );

} );
