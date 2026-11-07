import { it, expect, beforeAll } from 'vitest';
import { describeGPU } from './gpu.js';
import { OIDNDenoiser } from '@/core/viewer/denoise/OIDNDenoiser.js';
import { DENOISE_BLEND } from '@/core/viewer/denoise/DenoiserSettings.js';

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
			_frameWidth: width,
			_frameHeight: height,
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

	it( 'zeroes NaN and infinity and counts each broken frame pixel once', async () => {

		const width = 20, height = 6;
		const names = [ 'color', 'albedo', 'normal' ];
		const pixels = names.map( () => new Float32Array( width * height * 4 ).fill( 0.5 ) );
		pixels[ 0 ][ 0 ] = NaN;
		pixels[ 0 ][ ( 3 * width + 7 ) * 4 + 1 ] = Infinity;
		pixels[ 0 ][ ( 5 * width + 19 ) * 4 + 3 ] = - Infinity;
		pixels[ 2 ][ ( 2 * width + 2 ) * 4 + 2 ] = NaN;
		const textures = Object.fromEntries( names.map( ( name, k ) => [ name, texture( pixels[ k ], width, height ) ] ) );

		const p = pass( width, height );
		const reported = new Promise( resolve => p.addEventListener( 'nonFinite', resolve ) );
		p._copyInputs( device, textures, width, height );
		const { color, albedo, normal } = await reported;
		expect( [ color, albedo, normal ] ).toEqual( [ 3, 0, 1 ] );

		const W = align( width );
		const packed = new Float32Array( await read( p._gpuInputBuffers.color ) );
		expect( packed.every( Number.isFinite ) ).toBe( true );
		const at = ( x, y ) => Array.from( packed.subarray( ( ( y + BORDER ) * W + x + BORDER ) * 4, ( ( y + BORDER ) * W + x + BORDER ) * 4 + 4 ) );
		expect( at( 0, 0 ) ).toEqual( [ 0, 0.5, 0.5, 0.5 ] );
		expect( at( 7, 3 ) ).toEqual( [ 0.5, 0, 0.5, 0.5 ] );
		expect( at( 19, 5 ) ).toEqual( [ 0.5, 0.5, 0.5, 0 ] );

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

	function readHalfTexture( tex, width, height ) {

		const rowBytes = Math.ceil( width * 8 / 256 ) * 256;
		const map = device.createBuffer( { size: rowBytes * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer( { texture: tex }, { buffer: map, bytesPerRow: rowBytes }, [ width, height ] );
		device.queue.submit( [ encoder.finish() ] );
		return map.mapAsync( GPUMapMode.READ ).then( () => {

			const half = new Uint16Array( map.getMappedRange().slice( 0 ) );
			map.destroy();
			const toFloat = h => {

				const e = ( h >> 10 ) & 31, f = h & 1023;
				return e ? ( 1 + f / 1024 ) * 2 ** ( e - 15 ) : f / 1024 * 2 ** - 14;

			};

			return ( x, y ) => toFloat( half[ y * rowBytes / 2 + x * 4 ] );

		} );

	}

	it( 'puts each pixel\'s variance of the mean in the albedo\'s fourth channel', async () => {

		const width = 21, height = 9, samples = 40;
		const W = align( width );
		const p = pass( width, height );
		const color = new Float32Array( W * align( height ) * 4 );
		const m2 = new Float32Array( width * height );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			const c = 0.1 + x * 0.05, i = ( ( y + BORDER ) * W + x + BORDER ) * 4;
			color.set( [ c, c, c, 1 ], i );
			m2[ y * width + x ] = c * c + 0.001 * ( y + 1 );

		}

		device.queue.writeBuffer( p._gpuInputBuffers.color, 0, color );
		const buffer = device.createBuffer( { size: m2.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
		device.queue.writeBuffer( buffer, 0, m2 );

		expect( p._writeVariance( device, { buffer, samples, width }, width, height ) ).toEqual( { weight: 1, radius: DENOISE_BLEND.radius } );

		const albedo = new Float32Array( await read( p._gpuInputBuffers.albedo ) );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			expect( albedo[ ( ( y + BORDER ) * W + x + BORDER ) * 4 + 3 ] ).toBeCloseTo( 0.001 * ( y + 1 ) / ( samples - 1 ), 6 );

		}

		expect( p._writeVariance( device, { buffer, samples: 8, width }, width, height ) ).toBe( null );

	} );

	it( 'leans the denoised frame back to its input where it moved more than the input\'s noise', async () => {

		const width = 24, height = 9;
		const W = align( width ), H = align( height );
		const p = pass( width, height );
		p._ensureScalePipelines( device );
		device.queue.writeBuffer( p._inputScaleBuffer, 0, new Float32Array( [ 1 ] ) );

		// Left: the denoiser moved every pixel 0.5 against a variance of 1e-4, a bias. Right: 0.01 against 1, noise.
		const input = new Float32Array( W * H * 4 ), albedo = new Float32Array( W * H * 4 ), denoised = new Float32Array( W * H * 4 );
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

			const i = ( y * W + x ) * 4, left = x - BORDER < width / 2;
			input.set( [ 0.3, 0.3, 0.3, 1 ], i );
			albedo.set( [ 0.5, 0.5, 0.5, left ? 1e-4 : 1 ], i );
			const d = left ? 0.8 : 0.31;
			denoised.set( [ d, d, d, 1 ], i );

		}

		device.queue.writeBuffer( p._gpuInputBuffers.color, 0, input );
		device.queue.writeBuffer( p._gpuInputBuffers.albedo, 0, albedo );
		const src = device.createBuffer( { size: denoised.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
		device.queue.writeBuffer( src, 0, denoised );

		p._unpackToTexture( src, { x: 0, y: 0, width, height }, true, { weight: 1, radius: 2 } );
		const blended = await readHalfTexture( p._outGPUTexture, width, height );
		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < 9; x ++ ) expect( blended( x, y ) ).toBeCloseTo( 0.3, 3 );
			for ( let x = 15; x < width; x ++ ) expect( blended( x, y ) ).toBeCloseTo( 0.31, 3 );

		}

		p._unpackToTexture( src, { x: 0, y: 0, width, height }, true, null );
		const plain = await readHalfTexture( p._outGPUTexture, width, height );
		expect( plain( 0, 0 ) ).toBeCloseTo( 0.8, 3 );

	} );

} );
