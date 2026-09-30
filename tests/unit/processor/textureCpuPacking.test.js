import { describe, it, expect, afterEach } from 'vitest';
import { DataTexture } from 'three';
import { TextureCreator } from '@/core/Processor/TextureCreator.js';
import { resampleRGBA8 } from '@/core/Processor/ResampleRGBA8.js';
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
	await import( '@/core/Processor/Workers/PackWorker.js' );
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
