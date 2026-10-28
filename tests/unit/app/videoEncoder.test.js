import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Input, BufferSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { pickVideoCodec, muxerCodec, encodedSize, VideoEncoderPipeline, muxChunks } from '@/lib/VideoEncoder';
import { videoBitrate } from '@/lib/exporter';

const SPS = [ 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x40, 0x04, 0x1b, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x83, 0x19, 0x60 ];
const PPS = [ 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0 ];
const AVCC = new Uint8Array( [ 1, 0x64, 0, 0x28, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS ] );

let encoders, frames, supported;

class FakeEncoder {

	static isConfigSupported = vi.fn( async config => {

		const answer = supported( config );
		if ( answer instanceof Error ) throw answer;
		return { supported: answer, config };

	} );

	constructor( { output, error } ) {

		Object.assign( this, { output, error, encodeQueueSize: 0, chunkMeta: null } );
		this.configure = vi.fn();
		this.encode = vi.fn( ( frame, { keyFrame } ) => {

			const chunk = new FakeChunk( { type: keyFrame ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration, data: new Uint8Array( [ 0, 0, 0, 2, 0x65, frames.length - 1 ] ) } );
			this.output( chunk, this.chunkMeta?.( chunk ) );

		} );
		this.flush = vi.fn( async () => {} );
		this.close = vi.fn();
		encoders.push( this );

	}

}

class FakeFrame {

	constructor( source, init ) {

		Object.assign( this, init, { source, close: vi.fn() } );
		frames.push( this );

	}

}

class FakeChunk {

	constructor( { type, timestamp, duration, data } ) {

		Object.assign( this, { type, timestamp, duration, data, byteLength: data.byteLength } );

	}

	copyTo( target ) {

		target.set( this.data );

	}

}

async function readVideo( bytes ) {

	const input = new Input( { source: new BufferSource( bytes ), formats: ALL_FORMATS } );
	const track = await input.getPrimaryVideoTrack();
	const packets = [];
	for await ( const packet of new EncodedPacketSink( track ).packets() ) packets.push( { type: packet.type, timestamp: packet.timestamp, data: Array.from( packet.data ) } );
	return { mimeType: await input.getMimeType(), width: track.codedWidth, height: track.codedHeight, codec: await track.getCodecParameterString(), packets };

}

beforeEach( () => {

	encoders = [];
	frames = [];
	supported = () => true;
	FakeEncoder.isConfigSupported.mockClear();
	vi.stubGlobal( 'VideoEncoder', FakeEncoder );
	vi.stubGlobal( 'VideoFrame', FakeFrame );
	vi.stubGlobal( 'EncodedVideoChunk', FakeChunk );

} );

afterEach( () => {

	vi.useRealTimers();
	vi.unstubAllGlobals();

} );

describe( 'codec choice', () => {

	it( 'finds no codec without WebCodecs', async () => {

		vi.unstubAllGlobals();
		expect( await pickVideoCodec( 'mp4', 1920, 1080, 30, 1e7 ) ).toBeNull();

	} );

	it( 'picks the lowest H.264 level that holds the frame size and rate', async () => {

		const level = ( width, height, fps ) => pickVideoCodec( 'mp4', width, height, fps, 1e7 );

		expect( await level( 640, 360, 30 ) ).toBe( 'avc1.64001F' );
		expect( await level( 1920, 1080, 30 ) ).toBe( 'avc1.640028' );
		expect( await level( 1921, 1081, 30 ) ).toBe( 'avc1.640028' );
		expect( await level( 1920, 1080, 60 ) ).toBe( 'avc1.64002A' );
		expect( await level( 3840, 2160, 30 ) ).toBe( 'avc1.640033' );
		expect( await level( 3840, 2160, 60 ) ).toBe( 'avc1.640034' );
		expect( await level( 7680, 4320, 30 ) ).toBe( 'avc1.64003C' );
		expect( await level( 7680, 4320, 120 ) ).toBe( 'avc1.64003E' );
		expect( await level( 16384, 16384, 30 ) ).toBe( 'avc1.64003E' );

	} );

	it( 'asks the browser about H.264 at even sides, with the bitrate and frame rate', async () => {

		await pickVideoCodec( 'mp4', 1919, 1079, 24, 5e6 );

		expect( FakeEncoder.isConfigSupported ).toHaveBeenCalledWith( { codec: 'avc1.640028', width: 1918, height: 1078, bitrate: 5e6, framerate: 24 } );

	} );

	it( 'has nothing for MP4 when the browser cannot encode its H.264 level', async () => {

		supported = () => false;
		expect( await pickVideoCodec( 'mp4', 1920, 1080, 30, 1e7 ) ).toBeNull();

	} );

	it( 'tries VP9, at a level by picture size, then VP8 for WebM', async () => {

		expect( await pickVideoCodec( 'webm', 4096, 2176, 30, 1e7 ) ).toBe( 'vp09.00.51.08' );
		expect( await pickVideoCodec( 'webm', 4096, 2304, 30, 1e7 ) ).toBe( 'vp09.00.61.08' );
		expect( FakeEncoder.isConfigSupported.mock.calls[ 0 ][ 0 ] ).toMatchObject( { width: 4096, height: 2176 } );

		supported = ( { codec } ) => codec === 'vp8';
		expect( await pickVideoCodec( 'webm', 1279, 719, 30, 1e7 ) ).toBe( 'vp8' );
		expect( FakeEncoder.isConfigSupported.mock.lastCall[ 0 ] ).toMatchObject( { codec: 'vp8', width: 1279, height: 719 } );

	} );

	it( 'moves past a codec the browser throws on, and finds none when every one fails', async () => {

		supported = ( { codec } ) => ( codec === 'vp8' ? true : new TypeError( 'bad codec' ) );
		expect( await pickVideoCodec( 'webm', 640, 480, 30, 1e6 ) ).toBe( 'vp8' );

		supported = () => new TypeError( 'bad codec' );
		expect( await pickVideoCodec( 'webm', 640, 480, 30, 1e6 ) ).toBeNull();

	} );

	it( 'names each codec as the muxer does', () => {

		expect( [ 'avc1.640028', 'vp09.00.51.08', 'av01.0.08M.08', 'vp8' ].map( muxerCodec ) ).toEqual( [ 'avc', 'vp9', 'av1', 'vp8' ] );

	} );

	it( 'drops an odd last column and row for H.264 only', () => {

		expect( encodedSize( 'avc1.640028', 1921, 1081 ) ).toEqual( { width: 1920, height: 1080 } );
		expect( encodedSize( 'avc1.640028', 1920, 1080 ) ).toEqual( { width: 1920, height: 1080 } );
		expect( encodedSize( 'vp8', 1921, 1081 ) ).toEqual( { width: 1921, height: 1081 } );

	} );

} );

describe( 'VideoEncoderPipeline handing out chunks', () => {

	it( 'configures the encoder at the encoded size, defaulting the bitrate from the picture', () => {

		const chunks = [];
		const pipeline = new VideoEncoderPipeline( 1281, 721, { codec: 'avc1.64001F', fps: 30, onChunk: chunk => chunks.push( chunk ) } );

		expect( encoders[ 0 ].configure ).toHaveBeenCalledWith( { codec: 'avc1.64001F', width: 1280, height: 720, bitrate: videoBitrate( 1281, 721, 30 ), framerate: 30, avc: { format: 'avc' } } );
		expect( pipeline.frameDuration ).toBe( 33333 );

		new VideoEncoderPipeline( 641, 361, { codec: 'vp8', fps: 25, bitrate: 2e6, onChunk: () => {} } );
		expect( encoders[ 1 ].configure ).toHaveBeenCalledWith( { codec: 'vp8', width: 641, height: 361, bitrate: 2e6, framerate: 25 } );

	} );

	it( 'times each frame by its index and forces a key frame every second', async () => {

		const chunks = [];
		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', fps: 4, onChunk: ( chunk, meta ) => chunks.push( { chunk, meta } ) } );
		const encoder = encoders[ 0 ];

		for ( const index of [ 0, 1, 3, 4, 5 ] ) await pipeline.addFrame( { bitmap: index }, index );
		await pipeline.addFrame( { bitmap: 6 }, 6, { keyFrame: true } );

		expect( frames.map( f => f.timestamp ) ).toEqual( [ 0, 250000, 750000, 1000000, 1250000, 1500000 ] );
		expect( frames[ 0 ] ).toMatchObject( { duration: 250000, visibleRect: { x: 0, y: 0, width: 64, height: 32 }, source: { bitmap: 0 } } );
		expect( encoder.encode.mock.calls.map( ( [ , options ] ) => options.keyFrame ) ).toEqual( [ true, false, false, true, false, true ] );
		expect( frames.every( f => f.close.mock.calls.length === 1 ) ).toBe( true );
		expect( chunks.map( c => c.chunk.type ) ).toEqual( [ 'key', 'delta', 'delta', 'key', 'delta', 'key' ] );
		expect( encoder.flush ).not.toHaveBeenCalled();

		await pipeline.addFrame( { bitmap: 7 }, 7, { flush: true } );
		expect( encoder.flush ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'waits while the encoder is more than five frames behind', async () => {

		vi.useFakeTimers();
		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', onChunk: () => {} } );
		const encoder = encoders[ 0 ];
		encoder.encodeQueueSize = 7;

		let done = false;
		const adding = pipeline.addFrame( {}, 0 ).then( () => {

			done = true;

		} );
		await vi.advanceTimersByTimeAsync( 50 );
		expect( done ).toBe( false );

		encoder.encodeQueueSize = 5;
		await vi.advanceTimersByTimeAsync( 10 );
		await adding;
		expect( done ).toBe( true );

	} );

	it( 'reports the encoder\'s error at the next frame and at the end', async () => {

		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', onChunk: () => {} } );
		const failure = new Error( 'encoder crashed' );
		encoders[ 0 ].error( failure );

		await expect( pipeline.addFrame( {}, 0 ) ).rejects.toBe( failure );
		expect( frames ).toEqual( [] );
		await expect( pipeline.finalize() ).rejects.toBe( failure );

	} );

	it( 'flushes and closes on finalize, returning no file, and takes nothing after', async () => {

		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', onChunk: () => {} } );

		expect( await pipeline.finalize() ).toBeNull();
		expect( encoders[ 0 ].flush ).toHaveBeenCalledTimes( 1 );
		expect( encoders[ 0 ].close ).toHaveBeenCalledTimes( 1 );
		await expect( pipeline.finalize() ).rejects.toThrow( 'Already finalized' );
		await expect( pipeline.addFrame( {}, 0 ) ).rejects.toThrow( 'Cannot add frames after finalize()' );

	} );

	it( 'closes quietly when the encoder is already closed', () => {

		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', onChunk: () => {} } );
		encoders[ 0 ].close.mockImplementation( () => {

			throw new Error( 'InvalidStateError' );

		} );

		expect( () => pipeline.close() ).not.toThrow();

	} );

} );

describe( 'VideoEncoderPipeline muxing in memory', () => {

	async function encode( width, height, options, meta ) {

		const pipeline = new VideoEncoderPipeline( width, height, { fps: 30, totalFrames: 3, ...options } );
		encoders[ 0 ].chunkMeta = meta;
		for ( let i = 0; i < 3; i ++ ) await pipeline.addFrame( {}, i );
		return pipeline.finalize();

	}

	it( 'writes a WebM the browser can play', async () => {

		const blob = await encode( 63, 31, { codec: 'vp8', container: 'webm' }, chunk => ( chunk.type === 'key' ? { decoderConfig: { codec: 'vp8', codedWidth: 63, codedHeight: 31 } } : undefined ) );

		expect( blob.type ).toBe( 'video/webm' );
		const video = await readVideo( new Uint8Array( await blob.arrayBuffer() ) );
		expect( video ).toMatchObject( { width: 63, height: 31, codec: 'vp8' } );
		expect( video.packets.map( p => p.type ) ).toEqual( [ 'key', 'delta', 'delta' ] );
		expect( video.packets.map( p => p.timestamp ) ).toEqual( [ 0, 0.033, 0.067 ] );

	} );

	it( 'writes an MP4 of H.264 at the even size, needing no frame count up front', async () => {

		const blob = await encode( 65, 33, { codec: 'avc1.640028', container: 'mp4', totalFrames: 0 }, chunk => ( chunk.type === 'key' ? { decoderConfig: { codec: 'avc1.640028', codedWidth: 64, codedHeight: 32, description: AVCC } } : undefined ) );

		expect( blob.type ).toBe( 'video/mp4' );
		const video = await readVideo( new Uint8Array( await blob.arrayBuffer() ) );
		expect( video ).toMatchObject( { mimeType: 'video/mp4; codecs="avc1.640028"', width: 64, height: 32 } );
		expect( video.packets.map( p => p.data[ 5 ] ) ).toEqual( [ 0, 1, 2 ] );
		expect( frames[ 0 ].visibleRect ).toEqual( { x: 0, y: 0, width: 64, height: 32 } );

	} );

	it( 'fails the file when the muxer refuses a chunk', async () => {

		await expect( encode( 64, 32, { codec: 'vp8', container: 'webm' }, () => undefined ) ).rejects.toThrow( 'metadata must be provided' );

	} );

	it( 'cancels the file on close', async () => {

		const pipeline = new VideoEncoderPipeline( 64, 32, { codec: 'vp8', container: 'webm' } );
		const cancel = vi.spyOn( pipeline._output, 'cancel' );

		pipeline.close();

		expect( encoders[ 0 ].close ).toHaveBeenCalled();
		expect( cancel ).toHaveBeenCalledTimes( 1 );

	} );

} );

describe( 'muxChunks', () => {

	async function* stored( count ) {

		for ( let i = 0; i < count; i ++ ) yield { data: new Uint8Array( [ 0, 0, 0, 2, 0x65, i ] ), key: i === 0, timestamp: Math.round( i * 1e6 / 30 ) };

	}

	async function mux( options, count = 3 ) {

		let bytes = new Uint8Array( 0 );
		await muxChunks( stored( count ), {
			fps: 30,
			totalFrames: count,
			...options,
			write: ( data, position ) => {

				if ( position + data.length > bytes.length ) {

					const grown = new Uint8Array( position + data.length );
					grown.set( bytes );
					bytes = grown;

				}

				bytes.set( data, position );

			},
		} );
		return readVideo( bytes );

	}

	it( 'streams stored chunks out as a WebM, key and delta frames in time order', async () => {

		const video = await mux( { width: 63, height: 31, codec: 'vp8', container: 'webm' } );

		expect( video ).toMatchObject( { mimeType: 'video/webm; codecs="vp8"', width: 63, height: 31 } );
		expect( video.packets ).toEqual( [
			{ type: 'key', timestamp: 0, data: [ 0, 0, 0, 2, 0x65, 0 ] },
			{ type: 'delta', timestamp: 0.033, data: [ 0, 0, 0, 2, 0x65, 1 ] },
			{ type: 'delta', timestamp: 0.067, data: [ 0, 0, 0, 2, 0x65, 2 ] },
		] );

	} );

	it( 'streams an MP4 with the stored decoder config, at the even size', async () => {

		const video = await mux( { width: 65, height: 33, codec: 'avc1.640028', container: 'mp4', decoderConfig: { description: AVCC } }, 4 );

		expect( video ).toMatchObject( { mimeType: 'video/mp4; codecs="avc1.640028"', width: 64, height: 32 } );
		expect( video.packets.map( p => p.type ) ).toEqual( [ 'key', 'delta', 'delta', 'delta' ] );
		expect( video.packets[ 3 ].timestamp ).toBeCloseTo( 0.1, 6 );

	} );

	it( 'streams an MP4 whose frame count was never recorded', async () => {

		const video = await mux( { width: 64, height: 32, codec: 'avc1.640028', container: 'mp4', totalFrames: 0, decoderConfig: { description: AVCC } } );

		expect( video.packets.map( p => p.data[ 5 ] ) ).toEqual( [ 0, 1, 2 ] );

	} );

} );
