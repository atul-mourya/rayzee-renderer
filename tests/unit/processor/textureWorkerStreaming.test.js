import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextureCreator, MEMORY_CONSTANTS } from '@/core/Processor/TextureCreator.js';
import { configurePlatform } from '@/core/Platform.js';

// A bitmap carries the pixels createImageBitmap would have produced for its source and options.
class FakeBitmap {

	constructor( source, { resizeWidth, resizeHeight, imageOrientation } ) {

		this.width = resizeWidth;
		this.height = resizeHeight;
		this.pixels = new Uint8ClampedArray( resizeWidth * resizeHeight * 4 );
		for ( let i = 0; i < this.pixels.length; i ++ ) this.pixels[ i ] = ( source.seed * 31 + i * 7 + ( imageOrientation === 'flipY' ? 101 : 0 ) ) & 255;

	}

	close() {}

}

class FakeContext {

	constructor( canvas ) {

		this.canvas = canvas;

	}

	clearRect() {

		this.pixels = new Uint8ClampedArray( this.canvas.width * this.canvas.height * 4 );

	}

	drawImage( bitmap ) {

		this.pixels.set( bitmap.pixels );

	}

	getImageData() {

		return { data: this.pixels.slice() };

	}

}

class FakeCanvas {

	constructor( width = 1, height = 1 ) {

		this.width = width;
		this.height = height;

	}

	getContext() {

		return ( this.context ??= new FakeContext( this ) );

	}

}

const textures = count => Array.from( { length: count }, ( _, i ) => ( { image: { seed: i + 1, width: 32, height: 16 }, flipY: i % 2 === 0 } ) );

// TexturesWorker's own handler, run in-process. Bitmaps are handed over as a transfer would.
const workerHandler = await ( async () => {

	const had = 'self' in globalThis;
	const previous = globalThis.self;
	globalThis.self = {};
	await import( '@/core/Processor/Workers/TexturesWorker.js' );
	const handler = globalThis.self.onmessage;
	if ( had ) globalThis.self = previous;
	else delete globalThis.self;
	return handler;

} )();

// One handler at a time, run to completion: they share `self` (and the module's canvas).
let handlerQueue = Promise.resolve();

class InProcessTexturesWorker {

	static instances = [];
	static holdAcks = false;

	constructor() {

		this.layers = 0;
		this.received = [];
		this.held = [];
		this.hold = InProcessTexturesWorker.holdAcks;
		InProcessTexturesWorker.instances.push( this );

	}

	postMessage( message ) {

		if ( message.stream === 'layer' ) this.layers ++;
		if ( message.layers ) this.received.push( ...message.layers.map( layer => layer.index ) );
		setTimeout( () => {

			handlerQueue = handlerQueue.then( () => this._run( message ) );

		} );

	}

	async _run( message ) {

		const had = 'self' in globalThis;
		const previous = globalThis.self;
		globalThis.self = { postMessage: data => this._reply( data ) };
		try {

			await workerHandler( { data: message } );

		} finally {

			if ( had ) globalThis.self = previous;
			else delete globalThis.self;

		}

	}

	_reply( data ) {

		if ( this.hold && data.stream === 'ack' ) this.held.push( data );
		else setTimeout( () => this.onmessage( { data } ) );

	}

	release() {

		this.hold = false;
		for ( const data of this.held.splice( 0 ) ) setTimeout( () => this.onmessage( { data } ) );

	}

	terminate() {}

}

const ticks = n => new Promise( resolve => {

	const step = left => ( left === 0 ? resolve() : setTimeout( () => step( left - 1 ) ) );
	step( n );

} );

describe( 'TextureCreator — streaming a large bucket through a worker', () => {

	beforeEach( () => {

		InProcessTexturesWorker.instances = [];
		InProcessTexturesWorker.holdAcks = false;
		vi.stubGlobal( 'createImageBitmap', vi.fn( async ( source, options ) => new FakeBitmap( source, options ) ) );
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );
		vi.stubGlobal( 'document', { createElement: () => new FakeCanvas() } );
		configurePlatform( { Worker: InProcessTexturesWorker } );

	} );

	afterEach( () => {

		configurePlatform( { Worker: null } );
		vi.unstubAllGlobals();

	} );

	it( 'packs the same bytes as the main-thread stream, every layer in its place', async () => {

		const list = textures( 7 );
		const onMain = await new TextureCreator().processOnMainThreadStreaming( list );
		const inWorker = await new TextureCreator().processInWorkerStreaming( list );

		expect( inWorker.image ).toMatchObject( { width: onMain.image.width, height: onMain.image.height, depth: 7 } );
		expect( Buffer.compare( Buffer.from( inWorker.image.data ), Buffer.from( onMain.image.data ) ) ).toBe( 0 );
		expect( InProcessTexturesWorker.instances[ 0 ].layers ).toBe( 7 );

	} );

	it( 'keeps at most a batch of layers waiting on the worker', async () => {

		InProcessTexturesWorker.holdAcks = true;
		const creator = new TextureCreator();
		const packing = creator.processInWorkerStreaming( textures( 9 ) );
		await ticks( 20 );
		const worker = InProcessTexturesWorker.instances[ 0 ];

		expect( worker.layers ).toBe( MEMORY_CONSTANTS.STREAM_BATCH_SIZE );

		worker.release();
		const packed = await packing;

		expect( packed.image.depth ).toBe( 9 );
		expect( creator.activeWorkers ).toBe( 0 );

	} );

	it( 'rejects when the worker fails', async () => {

		class BrokenWorker {

			postMessage( message ) {

				if ( message.stream === 'layer' ) setTimeout( () => this.onmessage( { data: { error: 'out of memory' } } ) );

			}

			terminate() {}

		}

		configurePlatform( { Worker: BrokenWorker } );
		const creator = new TextureCreator();

		await expect( creator.processInWorkerStreaming( textures( 3 ) ) ).rejects.toThrow( 'out of memory' );
		expect( creator.activeWorkers ).toBe( 0 );

	} );

	it( 'is chosen only for a set past the main-thread memory line', () => {

		vi.stubGlobal( 'Worker', InProcessTexturesWorker );
		const creator = new TextureCreator();
		const side = Math.ceil( Math.sqrt( MEMORY_CONSTANTS.MAX_TEXTURE_MEMORY / 4 ) ) + 1;

		expect( creator.selectProcessingStrategy( [ { image: { width: side, height: side } } ] ).method ).toBe( 'worker-streaming' );
		expect( creator.selectProcessingStrategy( [ { image: { width: 2048, height: 2048 } } ] ).method ).toBe( 'worker-direct' );

	} );

} );

describe( 'TextureCreator — one bucket across several workers', () => {

	// A layer at its stored size: the bitmap prepareTexturesForWorkerDirect would hand over.
	const layer = ( seed, width, height ) => ( { bitmap: new FakeBitmap( { seed }, { resizeWidth: width, resizeHeight: height } ), width, height, isDirect: true } );
	const layers = () => [ layer( 1, 64, 4 ), layer( 2, 64, 16 ), layer( 3, 64, 4 ), layer( 4, 64, 16 ), layer( 5, 64, 4 ) ];

	beforeEach( () => {

		InProcessTexturesWorker.instances = [];
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );
		vi.stubGlobal( 'createImageBitmap', vi.fn( async ( source, options ) => new FakeBitmap( source, options ) ) );
		vi.stubGlobal( 'Worker', InProcessTexturesWorker );
		vi.stubGlobal( 'crossOriginIsolated', true );
		configurePlatform( { Worker: InProcessTexturesWorker } );

	} );

	afterEach( () => {

		configurePlatform( { Worker: null } );
		vi.unstubAllGlobals();

	} );

	it( 'packs the same bytes as one worker, every layer in its place', async () => {

		const creator = new TextureCreator();
		creator.prepareTexturesForWorkerDirect = async () => layers();
		creator._sharedPackSlots = () => 0;
		const alone = await creator.processWithWorkerDirect( [] );
		const shared = await new TextureCreator()._packAcrossWorkers( layers(), 3 );

		expect( shared ).toMatchObject( { width: 64, height: 16, depth: 5 } );
		expect( shared.data ).toBeInstanceOf( SharedArrayBuffer );
		expect( Buffer.compare( Buffer.from( new Uint8Array( shared.data ) ), Buffer.from( alone.image.data ) ) ).toBe( 0 );

	} );

	it( 'gives each worker one of the large layers', async () => {

		await new TextureCreator()._packAcrossWorkers( layers(), 2 );

		const received = InProcessTexturesWorker.instances.map( worker => worker.received.sort( ( a, b ) => a - b ) );
		expect( received ).toEqual( [[ 0, 1, 4 ], [ 2, 3 ]] );

	} );

	it( 'rejects when a worker fails', async () => {

		class BrokenWorker {

			postMessage() {

				setTimeout( () => this.onmessage( { data: { error: 'out of memory' } } ) );

			}

			terminate() {}

		}

		configurePlatform( { Worker: BrokenWorker } );

		await expect( new TextureCreator()._packAcrossWorkers( layers(), 2 ) ).rejects.toThrow( 'out of memory' );

	} );

	it( 'takes extra workers only for a large bucket, within the free slots', () => {

		const creator = new TextureCreator();
		const big = Array.from( { length: 6 }, () => ( { width: 4096, height: 4096 } ) );

		expect( creator._sharedPackSlots( big ) ).toBe( 3 );
		expect( creator._sharedPackSlots( [ { width: 8192, height: 8192 }, { width: 8192, height: 8192 } ] ) ).toBe( 1 );
		expect( creator._sharedPackSlots( [ { width: 4096, height: 4096 }, { width: 2048, height: 2048 } ] ) ).toBe( 0 );

		creator.activeWorkers = creator.maxConcurrentWorkers - 1;
		expect( creator._sharedPackSlots( big ) ).toBe( 1 );
		creator.activeWorkers = creator.maxConcurrentWorkers;
		expect( creator._sharedPackSlots( big ) ).toBe( 0 );

		vi.stubGlobal( 'crossOriginIsolated', false );
		creator.activeWorkers = 1;
		expect( creator._sharedPackSlots( big ) ).toBe( 0 );

	} );

} );
