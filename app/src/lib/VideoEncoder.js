/**
 * VideoEncoderPipeline — WebCodecs encodes the frames, Mediabunny writes the MP4 or WebM around them.
 *
 * Two modes: with `onChunk` every frame's encoded chunks go to the caller (a VideoJob journals
 * them to disk and muxes at the end); without it the file is muxed in memory.
 */

import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, StreamTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';
import { VIDEO_CONTAINERS, videoBitrate } from '@/lib/exporter';

const KEYFRAME_SECONDS = 1;

// H.264 levels: [ level, most macroblocks a frame, most a second ].
const AVC_LEVELS = [[ 31, 3600, 108000 ], [ 40, 8192, 245760 ], [ 42, 8704, 522240 ], [ 51, 36864, 983040 ], [ 52, 36864, 2073600 ], [ 60, 139264, 4177920 ], [ 61, 139264, 8355840 ], [ 62, 139264, 16711680 ]];

function avcCodec( width, height, fps ) {

	const blocks = Math.ceil( width / 16 ) * Math.ceil( height / 16 );
	const level = AVC_LEVELS.find( ( [ , frame, rate ] ) => blocks <= frame && blocks * fps <= rate )?.[ 0 ] ?? 62;
	return `avc1.6400${level.toString( 16 ).toUpperCase()}`;

}

const vp9Codec = ( width, height ) => `vp09.00.${width * height <= 8912896 ? 51 : 61}.08`;

/** WebCodecs codec string → Mediabunny's codec name. */
export const muxerCodec = codec => ( codec.startsWith( 'avc' ) ? 'avc' : codec.startsWith( 'vp09' ) ? 'vp9' : codec.startsWith( 'av01' ) ? 'av1' : 'vp8' );

/** What the encoder is given: H.264 needs even sides, so its last column and row are dropped when odd. */
export const encodedSize = ( codec, width, height ) => ( codec.startsWith( 'avc' ) ? { width: width & ~ 1, height: height & ~ 1 } : { width, height } );

/**
 * The first codec this browser can encode at this size for the container: H.264 in MP4, VP9 then VP8 in WebM.
 * @returns {Promise<?string>} null when none can
 */
export async function pickVideoCodec( container, width, height, fps, bitrate ) {

	if ( typeof VideoEncoder === 'undefined' ) return null;
	const candidates = container === 'mp4' ? [ avcCodec( width, height, fps ) ] : [ vp9Codec( width, height ), 'vp8' ];

	for ( const codec of candidates ) {

		try {

			const result = await VideoEncoder.isConfigSupported( { codec, ...encodedSize( codec, width, height ), bitrate, framerate: fps } );
			if ( result.supported ) return codec;

		} catch {

			continue;

		}

	}

	return null;

}

function createOutput( container, target ) {

	// MP4: index first, so a browser can play it while it downloads; the track says how many frames to reserve room for.
	const format = container === 'mp4' ? new Mp4OutputFormat( { fastStart: target instanceof BufferTarget ? 'in-memory' : 'reserve' } ) : new WebMOutputFormat();
	return new Output( { format, target } );

}

export class VideoEncoderPipeline {

	/**
	 * @param {number} width  - Video width in pixels
	 * @param {number} height - Video height in pixels
	 * @param {Object} options
	 * @param {string} options.codec                - WebCodecs codec string, from pickVideoCodec
	 * @param {'mp4'|'webm'} [options.container='webm']
	 * @param {number} [options.fps=30]             - Frame rate
	 * @param {number} [options.bitrate]            - Target bitrate in bps
	 * @param {number} [options.totalFrames]        - frames the file will hold
	 * @param {function(EncodedVideoChunk, Object): void} [options.onChunk] - take chunks instead of muxing
	 */
	constructor( width, height, options ) {

		const { codec, container = 'webm', fps = 30, bitrate = videoBitrate( width, height, fps ), totalFrames = 0, onChunk = null } = options;

		this._frameDuration = Math.round( 1_000_000 / fps ); // microseconds
		this._keyInterval = Math.max( 1, Math.round( fps * KEYFRAME_SECONDS ) );
		this._size = encodedSize( codec, width, height );
		this._container = container;
		this._finalized = false;
		this._error = null;
		this._pending = Promise.resolve();

		if ( ! onChunk ) {

			this._target = new BufferTarget();
			this._output = createOutput( container, this._target );
			this._source = new EncodedVideoPacketSource( muxerCodec( codec ) );
			this._output.addVideoTrack( this._source, { frameRate: fps, maximumPacketCount: totalFrames || undefined } );
			this._pending = this._output.start();

		}

		this._encoder = new VideoEncoder( {
			output: ( chunk, meta ) => {

				if ( onChunk ) return onChunk( chunk, meta );
				const packet = EncodedPacket.fromEncodedChunk( chunk );
				this._pending = this._pending.then( () => this._source.add( packet, meta ) ).catch( e => {

					this._error ??= e;

				} );

			},
			error: ( e ) => {

				this._error = e;

			},
		} );

		this._encoder.configure( { codec, ...this._size, bitrate, framerate: fps, ...( codec.startsWith( 'avc' ) ? { avc: { format: 'avc' } } : {} ) } );

	}

	get frameDuration() {

		return this._frameDuration;

	}

	_check() {

		if ( this._error ) throw this._error;

	}

	/**
	 * Encode one frame. With `flush` the frame's chunks have all been handed out when this resolves.
	 * @param {ImageBitmap} imageBitmap
	 * @param {number} frameIndex - position in the video; sets the timestamp
	 * @param {{keyFrame?: boolean, flush?: boolean}} [options] - keyFrame is forced once a second
	 */
	async addFrame( imageBitmap, frameIndex, { keyFrame = false, flush = false } = {} ) {

		if ( this._finalized ) throw new Error( 'VideoEncoderPipeline: Cannot add frames after finalize()' );
		this._check();

		const frame = new VideoFrame( imageBitmap, {
			timestamp: frameIndex * this._frameDuration,
			duration: this._frameDuration,
			visibleRect: { x: 0, y: 0, ...this._size },
		} );
		this._encoder.encode( frame, { keyFrame: keyFrame || frameIndex % this._keyInterval === 0 } );
		frame.close();

		if ( flush ) await this._encoder.flush();
		while ( this._encoder.encodeQueueSize > 5 ) await new Promise( r => setTimeout( r, 10 ) );
		this._check();

	}

	/**
	 * Flush the encoder; in muxing mode finalize the file too.
	 * @returns {Promise<?Blob>} the video when muxing in memory
	 */
	async finalize() {

		if ( this._finalized ) throw new Error( 'VideoEncoderPipeline: Already finalized' );
		this._finalized = true;

		await this._encoder.flush();
		this._encoder.close();
		this._check();
		if ( ! this._output ) return null;

		await this._pending;
		this._check();
		await this._output.finalize();
		return new Blob( [ this._target.buffer ], { type: VIDEO_CONTAINERS[ this._container ].mimeType } );

	}

	close() {

		try {

			this._encoder.close();

		} catch { /* already closed */ }

		this._output?.cancel().catch( () => {} );

	}

}

/**
 * Muxes stored chunks into an MP4 or WebM, streaming it out through `write( bytes, position )`.
 * @param {AsyncIterable<{data: Uint8Array, key: boolean, timestamp: number}>} chunks - timestamps in microseconds
 */
export async function muxChunks( chunks, { width, height, codec, fps, container = 'webm', totalFrames = 0, decoderConfig, write } ) {

	const writable = new WritableStream( { write: ( { data, position } ) => write( data, position ) } );
	const output = createOutput( container, new StreamTarget( writable, { chunked: true } ) );
	const source = new EncodedVideoPacketSource( muxerCodec( codec ) );
	output.addVideoTrack( source, { frameRate: fps, maximumPacketCount: totalFrames || undefined } );
	await output.start();

	const size = encodedSize( codec, width, height );
	const config = { codec, codedWidth: size.width, codedHeight: size.height, ...decoderConfig };
	const duration = 1 / fps;
	let first = true;
	for await ( const chunk of chunks ) {

		const packet = new EncodedPacket( chunk.data, chunk.key ? 'key' : 'delta', chunk.timestamp / 1e6, duration );
		await source.add( packet, first ? { decoderConfig: config } : undefined );
		first = false;

	}

	await output.finalize();

}
