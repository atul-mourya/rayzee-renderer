import { describe, it, expect, afterEach, vi } from 'vitest';
import { DataTexture, FloatType, HalfFloatType, RedFormat, DataUtils, LinearSRGBColorSpace, SRGBColorSpace } from 'three';
import { TextureCreator, rgba8Pixels, setImageReader, holdImages, releaseImages } from '@/core/materials/TextureCreator.js';
import { resampleRGBA8 } from '@/core/materials/ResampleRGBA8.js';
import { IssueLog } from '@/core/EngineIssues.js';
import { configurePlatform } from '@/core/Platform.js';

// Rows 0..h-1, each filled with its own index, so orientation is visible.
function rows( width, height, { flipY = false } = {} ) {

	const data = new Uint8Array( width * height * 4 );
	for ( let y = 0; y < height; y ++ ) data.fill( y * 10, y * width * 4, ( y + 1 ) * width * 4 );
	const texture = new DataTexture( data, width, height );
	texture.flipY = flipY;
	return texture;

}

const layerRow = ( array, layer, row ) => {

	const { width, height } = array.image;
	return array.image.data[ ( layer * height + row ) * width * 4 ];

};

describe( 'TextureCreator — packing without a browser', () => {

	afterEach( () => configurePlatform( { Worker: null } ) );

	it( 'copies a layer that already fits its bucket exactly', async () => {

		const creator = new TextureCreator();
		const packed = await creator.processOnCPU( [ rows( 64, 4 ), rows( 64, 4 ) ] );

		expect( packed.image ).toMatchObject( { width: 64, height: 4, depth: 2 } );
		expect( [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 1, y ) ) ).toEqual( [ 0, 10, 20, 30 ] );

	} );

	it( 'puts the last row first for a flipY texture', async () => {

		const packed = await new TextureCreator().processOnCPU( [ rows( 64, 4, { flipY: true } ) ] );
		expect( [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 0, y ) ) ).toEqual( [ 30, 20, 10, 0 ] );

	} );

	it( 'resamples a smaller layer into the bucket', async () => {

		const packed = await new TextureCreator().processOnCPU( [ rows( 64, 4 ), rows( 64, 2 ) ] );
		const column = [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 1, y ) );

		expect( column[ 0 ] ).toBe( 0 );
		expect( column[ 3 ] ).toBe( 10 );
		expect( column[ 1 ] ).toBeGreaterThanOrEqual( column[ 0 ] );
		expect( column[ 2 ] ).toBeLessThanOrEqual( column[ 3 ] );

	} );

	it( 'keeps the slot of an image it cannot read, and says so', async () => {

		const issues = new IssueLog();
		const creator = new TextureCreator( { issues } );
		const packed = await creator.processOnCPU( [ { image: { width: 4, height: 4 } }, rows( 64, 4 ) ] );

		expect( packed.image.depth ).toBe( 2 );
		expect( layerRow( packed, 1, 3 ) ).toBe( 30 );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'texture.build_failed', detail: { layer: 0 } } );

	} );

	it( 'packs a large bucket in a worker, to the same pixels', async () => {

		const layers = [ noise( 1024, 1024, 1, true ), noise( 700, 900, 2, false ), noise( 1024, 1024, 3, false ) ];
		layers[ 2 ].image.data = Uint8Array.from( layers[ 2 ].image.data );

		const onMain = await new TextureCreator().processOnCPU( layers );
		configurePlatform( { Worker: InProcessPackWorker } );
		const issues = new IssueLog();
		const inWorker = await new TextureCreator( { issues } ).processOnCPU( layers );

		expect( InProcessPackWorker.messages ).toBe( 1 );
		expect( issues.list ).toEqual( [] );
		expect( inWorker.image ).toMatchObject( { width: onMain.image.width, height: onMain.image.height, depth: 3 } );
		expect( Buffer.compare( Buffer.from( inWorker.image.data ), Buffer.from( onMain.image.data ) ) ).toBe( 0 );
		expect( layers[ 2 ].image.data.byteLength ).toBe( 1024 * 1024 * 4 );

	} );

	it( 'packs on the main thread when the worker fails, and says so', async () => {

		configurePlatform( { Worker: FailingWorker } );
		const issues = new IssueLog();
		const packed = await new TextureCreator( { issues } ).processOnCPU( [ noise( 2048, 1024, 4, false ) ] );

		expect( packed.image ).toMatchObject( { width: 2048, height: 1024, depth: 1 } );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'texture.processing_fallback', detail: { cause: 'no threads here' } } );

	} );

	it( 'hands a large bucket to the layer sink a group at a time, with the bytes it packs whole', async () => {

		// Four layers at the bucket size, then three smaller ones resampled up: the last group holds only those.
		const layers = [ 1, 2, 3, 4 ].map( ( seed ) => noise( 256, 128, seed, seed % 2 === 0 ) );
		layers.push( noise( 64, 32, 5, false ), noise( 100, 50, 6, true ), noise( 128, 64, 7, false ) );
		layers[ 1 ].colorSpace = LinearSRGBColorSpace;

		const whole = await new TextureCreator().createTexturesToDataTexture( layers, { srgbPool: true } );

		let received = null;
		const writes = [];
		const layerSink = {
			allocate: ( texture ) => {

				received = new Uint8Array( texture.image.width * texture.image.height * texture.image.depth * 4 );

			},
			write: async ( texture, first, data, count ) => {

				writes.push( [ first, count ] );
				received.set( data, first * texture.image.width * texture.image.height * 4 );

			},
		};
		const grouped = await new TextureCreator( { layerSink, groupBytes: 3 * 256 * 128 * 4 } ).createTexturesToDataTexture( layers, { srgbPool: true } );

		expect( writes ).toEqual( [[ 0, 3 ], [ 3, 3 ], [ 6, 1 ]] );
		expect( grouped.image ).toMatchObject( { width: 256, height: 128, depth: 7, data: null } );
		expect( grouped.source.dataReady ).toBe( false );
		expect( grouped.colorSpace ).toBe( SRGBColorSpace );
		expect( Buffer.compare( Buffer.from( received ), Buffer.from( whole.image.data ) ) ).toBe( 0 );

	} );

	it( 'packs a bucket under the group size whole, sink or not', async () => {

		const layerSink = { allocate: () => {

			throw new Error( 'not grouped' );

		}, write: async () => {} };
		const packed = await new TextureCreator( { layerSink } ).createTexturesToDataTexture( [ noise( 64, 32, 1, false ) ] );
		expect( packed.image.data.byteLength ).toBe( 64 * 32 * 4 );

	} );

} );

describe( 'TextureCreator — images read again', () => {

	// `noise` without its pixels, and a reader that hands back a copy of them.
	function deferred( width, height, seed, flipY ) {

		const pixels = noise( width, height, seed, flipY ).image.data;
		const texture = new DataTexture( null, width, height );
		texture.flipY = flipY;
		const read = vi.fn( async () => ( { data: pixels.slice(), width, height } ) );
		setImageReader( texture, read, { resident: false } );
		return { texture, read };

	}

	it( 'packs an image read again to the bytes it packs held, and lets it go after', async () => {

		const sizes = [[ 64, 32, 1, false ], [ 64, 32, 2, true ], [ 32, 16, 3, false ]];
		const whole = await new TextureCreator().createTexturesToDataTexture( sizes.map( ( a ) => noise( ...a ) ) );
		const lazy = sizes.map( ( a ) => deferred( ...a ) );

		expect( lazy[ 0 ].texture.image ).toMatchObject( { width: 64, height: 32, data: null } );
		const packed = await new TextureCreator().createTexturesToDataTexture( lazy.map( ( l ) => l.texture ) );

		expect( Buffer.compare( Buffer.from( packed.image.data ), Buffer.from( whole.image.data ) ) ).toBe( 0 );
		for ( const { texture, read } of lazy ) {

			expect( read ).toHaveBeenCalledOnce();
			expect( texture.image ).toMatchObject( { width: texture.image.width, data: null } );

		}

	} );

	it( 'holds only a group\'s images at a time when a bucket goes to the layer sink', async () => {

		const lazy = [ 1, 2, 3, 4, 5, 6, 7 ].map( ( seed ) => deferred( 128, 64, seed, false ) );
		const seen = [];
		const layerSink = {
			allocate: () => {},
			write: async ( texture, first, data, count ) => {

				seen.push( [ first + count, lazy.filter( ( l ) => l.read.mock.calls.length ).length, lazy.filter( ( l ) => l.texture.image.data ).length ] );

			},
		};
		await new TextureCreator( { layerSink, groupBytes: 2 * 128 * 64 * 4 } ).createTexturesToDataTexture( lazy.map( ( l ) => l.texture ) );

		// [ layers written, images read so far, images held ] at each write
		expect( seen ).toEqual( [[ 2, 2, 0 ], [ 4, 4, 0 ], [ 6, 6, 0 ], [ 7, 7, 0 ]] );
		expect( lazy.every( ( l ) => l.read.mock.calls.length === 1 ) ).toBe( true );

	} );

	it( 'reads an image once for overlapping holds, and lets it go after the last release', async () => {

		const { texture, read } = deferred( 8, 8, 1, false );
		const copy = texture.clone();
		await Promise.all( [ holdImages( [ texture, copy ] ), holdImages( [ copy ] ) ] );

		expect( read ).toHaveBeenCalledOnce();
		releaseImages( [ copy ] );
		expect( copy.image.data ).not.toBeNull();
		releaseImages( [ texture, copy ] );
		expect( texture.image ).toMatchObject( { width: 8, height: 8, data: null } );
		releaseImages( [ texture ] );

		await holdImages( [ texture ] );
		expect( read ).toHaveBeenCalledTimes( 2 );
		releaseImages( [ texture ] );

	} );

	it( 'lets go of an image held from the start once it is packed, and reads it again for the next pack', async () => {

		const texture = noise( 32, 16, 4, false );
		const pixels = texture.image.data;
		const read = vi.fn( async () => ( { data: pixels.slice(), width: 32, height: 16 } ) );
		setImageReader( texture, read );

		const creator = new TextureCreator();
		const first = await creator.createTexturesToDataTexture( [ texture ] );
		expect( read ).not.toHaveBeenCalled();
		expect( texture.image ).toMatchObject( { width: 32, height: 16, data: null } );

		creator.textureCache.dispose();
		const second = await creator.createTexturesToDataTexture( [ texture ] );
		expect( read ).toHaveBeenCalledOnce();
		expect( Buffer.compare( Buffer.from( second.image.data ), Buffer.from( first.image.data ?? pixels ) ) ).toBe( 0 );

	} );

	it( 'packs a white layer in place of an image that cannot be read again, and says so', async () => {

		const issues = new IssueLog();
		const good = deferred( 16, 16, 1, false );
		const bad = deferred( 16, 16, 2, false );
		bad.read.mockRejectedValue( new Error( 'file moved' ) );

		const packed = await new TextureCreator( { issues } ).createTexturesToDataTexture( [ good.texture, bad.texture ] );

		const layer = packed.image.width * packed.image.height * 4;
		expect( packed.image.depth ).toBe( 2 );
		expect( packed.image.data.subarray( layer, 2 * layer ).every( ( v ) => v === 255 ) ).toBe( true );
		expect( issues.list.map( ( i ) => i.code ) ).toContain( 'texture.build_failed' );
		expect( bad.texture.image ).toMatchObject( { width: 16, height: 16, data: null } );

	} );

	it( 'lets go of what it held when a strict host refuses an image that cannot be read again', async () => {

		const issues = new IssueLog( { strict: true } );
		const good = deferred( 16, 16, 1, false );
		const bad = deferred( 16, 16, 2, false );
		bad.read.mockRejectedValue( new Error( 'file moved' ) );

		await expect( new TextureCreator( { issues } ).createTexturesToDataTexture( [ good.texture, bad.texture ] ) ).rejects.toThrow( /read again/ );
		expect( good.texture.image.data ).toBeNull();
		await holdImages( [ good.texture ] );
		releaseImages( [ good.texture ] );
		expect( good.texture.image.data ).toBeNull();

	} );

	it( 'keeps a thumbnail of a bitmap it lets go, then closes the bitmap', async () => {

		const bitmap = { width: 512, height: 256, close: vi.fn() };
		const thumbnail = { width: 128, height: 64 };
		const createImageBitmap = vi.fn( async () => thumbnail );
		vi.stubGlobal( 'createImageBitmap', createImageBitmap );
		try {

			const texture = new DataTexture( null, 1, 1 );
			texture.image = bitmap;
			setImageReader( texture, async () => bitmap );
			await holdImages( [ texture ] );
			releaseImages( [ texture ] );
			await vi.waitFor( () => expect( bitmap.close ).toHaveBeenCalled() );

			expect( createImageBitmap.mock.calls[ 0 ][ 1 ] ).toMatchObject( { resizeWidth: 128, resizeHeight: 64 } );
			expect( texture.image ).toMatchObject( { width: 512, height: 256, data: null, thumbnail } );

		} finally {

			vi.unstubAllGlobals();

		}

	} );

} );

function noise( width, height, seed, flipY ) {

	const data = new Uint8Array( new SharedArrayBuffer( width * height * 4 ) );
	let x = seed;
	for ( let i = 0; i < data.length; i ++ ) data[ i ] = ( x = ( x * 1103515245 + 12345 ) >>> 0 ) >>> 24;
	const texture = new DataTexture( data, width, height );
	texture.flipY = flipY;
	return texture;

}

// PackWorker's own handler, with messages cloned and transferred as a thread would receive them.
const packHandler = await ( async () => {

	const had = 'self' in globalThis;
	const previous = globalThis.self;
	globalThis.self = {};
	await import( '@/core/materials/PackWorker.js' );
	const handler = globalThis.self.onmessage;
	if ( had ) globalThis.self = previous;
	else delete globalThis.self;
	return handler;

} )();

class InProcessPackWorker {

	static messages = 0;

	postMessage( message, transfer = [] ) {

		InProcessPackWorker.messages ++;
		const received = structuredClone( message, { transfer } );
		setTimeout( () => {

			const had = 'self' in globalThis;
			const previous = globalThis.self;
			globalThis.self = { postMessage: ( data, back = [] ) => setTimeout( () => this.onmessage( { data: structuredClone( data, { transfer: back } ) } ) ) };
			try {

				packHandler( { data: received } );

			} finally {

				if ( had ) globalThis.self = previous;
				else delete globalThis.self;

			}

		} );

	}

	terminate() {}

}

class FailingWorker {

	postMessage() {

		setTimeout( () => this.onerror( { error: new Error( 'no threads here' ) } ) );

	}

	terminate() {}

}

// The resampler before its column taps were hoisted; the hoisted one must match it bit for bit.
function referenceResample( { data: src, width: sw, height: sh, flipY }, dst, offset, dw, dh ) {

	for ( let y = 0; y < dh; y ++ ) {

		const row = flipY ? dh - 1 - y : y;
		const out = offset + row * dw * 4;

		if ( sw === dw && sh === dh ) {

			dst.set( src.subarray( y * sw * 4, ( y + 1 ) * sw * 4 ), out );
			continue;

		}

		const fy = Math.min( Math.max( ( y + 0.5 ) * sh / dh - 0.5, 0 ), sh - 1 );
		const y0 = Math.floor( fy ), y1 = Math.min( y0 + 1, sh - 1 ), ty = fy - y0;

		for ( let x = 0; x < dw; x ++ ) {

			const fx = Math.min( Math.max( ( x + 0.5 ) * sw / dw - 0.5, 0 ), sw - 1 );
			const x0 = Math.floor( fx ), x1 = Math.min( x0 + 1, sw - 1 ), tx = fx - x0;
			const a = ( y0 * sw + x0 ) * 4, b = ( y0 * sw + x1 ) * 4, c = ( y1 * sw + x0 ) * 4, d = ( y1 * sw + x1 ) * 4;

			for ( let ch = 0; ch < 4; ch ++ ) {

				const top = src[ a + ch ] + ( src[ b + ch ] - src[ a + ch ] ) * tx;
				const bottom = src[ c + ch ] + ( src[ d + ch ] - src[ c + ch ] ) * tx;
				dst[ out + x * 4 + ch ] = Math.round( top + ( bottom - top ) * ty );

			}

		}

	}

}

describe( 'resampleRGBA8', () => {

	it( 'matches the reference bilinear bit for bit, up, down, uneven and flipped', () => {

		const sizes = [[ 1, 1 ], [ 3, 5 ], [ 64, 64 ], [ 100, 37 ], [ 257, 129 ]];
		let seed = 7;
		const random = () => ( seed = ( seed * 1103515245 + 12345 ) >>> 0 ) >>> 24;

		for ( const [ sw, sh ] of sizes ) for ( const [ dw, dh ] of sizes ) for ( const flipY of [ false, true ] ) {

			const layer = { data: Uint8Array.from( { length: sw * sh * 4 }, random ), width: sw, height: sh, flipY };
			const expected = new Uint8Array( 8 + dw * dh * 4 );
			const actual = new Uint8Array( 8 + dw * dh * 4 );
			referenceResample( layer, expected, 8, dw, dh );
			resampleRGBA8( layer, actual, 8, dw, dh );
			expect( Buffer.compare( Buffer.from( actual ), Buffer.from( expected ) ), `${sw}x${sh} → ${dw}x${dh} flipY ${flipY}` ).toBe( 0 );

		}

	} );

} );

// An archive's EXR, HDR or PFM map arrives as float pixels; the arrays hold 8 bits.
describe( 'TextureCreator — float maps', () => {

	it( 'clamps float, half-float and one-channel pixels into RGBA8, and passes 8-bit ones through untouched', () => {

		const float = new DataTexture( new Float32Array( [ 0, 0.5, 1, 1, 2, - 1, 0.25, 0 ] ), 2, 1, undefined, FloatType );
		expect( Array.from( rgba8Pixels( float ) ) ).toEqual( [ 0, 128, 255, 255, 255, 0, 64, 0 ] );

		const half = new DataTexture( new Uint16Array( [ 0.5, 0.25, 1, 1 ].map( DataUtils.toHalfFloat ) ), 1, 1, undefined, HalfFloatType );
		expect( Array.from( rgba8Pixels( half ) ) ).toEqual( [ 128, 64, 255, 255 ] );

		const red = new DataTexture( new Float32Array( [ 0.5, 1 ] ), 2, 1, RedFormat, FloatType );
		expect( Array.from( rgba8Pixels( red ) ) ).toEqual( [ 128, 128, 128, 255, 255, 255, 255, 255 ] );

		const bytes = rows( 4, 1 );
		expect( rgba8Pixels( bytes ).buffer ).toBe( bytes.image.data.buffer );

	} );

	it( 'packs a float map as its values, where reading its buffer as bytes gave noise', async () => {

		const height = new DataTexture( new Float32Array( 64 * 2 * 4 ).fill( 0.5 ), 64, 2, undefined, FloatType );
		const packed = await new TextureCreator().processOnCPU( [ height ] );
		expect( layerRow( packed, 0, 0 ) ).toBe( 128 );
		expect( layerRow( packed, 0, 1 ) ).toBe( 128 );

	} );

} );
