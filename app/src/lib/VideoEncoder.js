/**
 * VideoEncoderPipeline — WebCodecs VP9/VP8 encoding for video export.
 *
 * Two modes: with `onChunk` every frame's encoded chunks go to the caller (a VideoJob journals
 * them to disk and muxes at the end); without it the WebM is muxed in memory as before.
 */

import { Muxer, ArrayBufferTarget, StreamTarget } from 'webm-muxer';

const VP9_CODEC = 'vp09.00.10.08'; // Profile 0, Level 1.0, 8-bit
const VP8_CODEC = 'vp8';
const KEYFRAME_INTERVAL = 30;

export const muxerCodec = codec => ( codec.startsWith( 'vp09' ) ? 'V_VP9' : 'V_VP8' );

/**
 * Check if the WebCodecs VideoEncoder API is available and a codec is supported.
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ supported: boolean, codec: string|null }>}
 */
export async function checkCodecSupport( width, height ) {

	if ( typeof VideoEncoder === 'undefined' ) {

		return { supported: false, codec: null };

	}

	// Try VP9 first, fall back to VP8
	for ( const codec of [ VP9_CODEC, VP8_CODEC ] ) {

		try {

			const result = await VideoEncoder.isConfigSupported( {
				codec,
				width,
				height,
				bitrate: 10_000_000,
			} );

			if ( result.supported ) return { supported: true, codec };

		} catch {

			continue;

		}

	}

	return { supported: false, codec: null };

}

export class VideoEncoderPipeline {

	/**
	 * @param {number} width  - Video width in pixels
	 * @param {number} height - Video height in pixels
	 * @param {Object} [options]
	 * @param {number} [options.fps=30]             - Frame rate
	 * @param {number} [options.bitrate=10_000_000] - Target bitrate in bps
	 * @param {string} [options.codec]              - WebCodecs codec string (auto-detected if omitted)
	 * @param {function(EncodedVideoChunk, Object): void} [options.onChunk] - take chunks instead of muxing
	 */
	constructor( width, height, options = {} ) {

		const { fps = 30, bitrate = 10_000_000, codec = VP9_CODEC, onChunk = null } = options;

		this._frameDuration = Math.round( 1_000_000 / fps ); // microseconds
		this._finalized = false;
		this._error = null;

		this._muxer = onChunk ? null : new Muxer( {
			target: new ArrayBufferTarget(),
			video: { codec: muxerCodec( codec ), width, height },
		} );

		this._encoder = new VideoEncoder( {
			output: ( chunk, meta ) => ( onChunk ? onChunk( chunk, meta ) : this._muxer.addVideoChunk( chunk, meta ) ),
			error: ( e ) => {

				this._error = e;

			},
		} );

		this._encoder.configure( { codec, width, height, bitrate, framerate: fps } );

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
	 * @param {{keyFrame?: boolean, flush?: boolean}} [options] - keyFrame is forced every 30 frames
	 */
	async addFrame( imageBitmap, frameIndex, { keyFrame = false, flush = false } = {} ) {

		if ( this._finalized ) throw new Error( 'VideoEncoderPipeline: Cannot add frames after finalize()' );
		this._check();

		const frame = new VideoFrame( imageBitmap, { timestamp: frameIndex * this._frameDuration, duration: this._frameDuration } );
		this._encoder.encode( frame, { keyFrame: keyFrame || frameIndex % KEYFRAME_INTERVAL === 0 } );
		frame.close();

		if ( flush ) await this._encoder.flush();
		while ( this._encoder.encodeQueueSize > 5 ) await new Promise( r => setTimeout( r, 10 ) );
		this._check();

	}

	/**
	 * Flush the encoder; in muxing mode finalize the WebM too.
	 * @returns {Promise<?Blob>} the .webm when muxing in memory
	 */
	async finalize() {

		if ( this._finalized ) throw new Error( 'VideoEncoderPipeline: Already finalized' );
		this._finalized = true;

		await this._encoder.flush();
		this._encoder.close();
		this._check();
		if ( ! this._muxer ) return null;

		this._muxer.finalize();
		return new Blob( [ this._muxer.target.buffer ], { type: 'video/webm' } );

	}

	close() {

		try {

			this._encoder.close();

		} catch { /* already closed */ }

	}

}

/**
 * Muxes stored chunks into a WebM, streaming it out through `write( bytes, position )`.
 * @param {AsyncIterable<{data: Uint8Array, key: boolean, timestamp: number}>} chunks
 */
export async function muxChunks( chunks, { width, height, codec, fps, decoderConfig, write } ) {

	const pending = [];
	const muxer = new Muxer( {
		target: new StreamTarget( { onData: ( data, position ) => pending.push( write( data, position ) ), chunked: true } ),
		video: { codec: muxerCodec( codec ), width, height, frameRate: fps },
		firstTimestampBehavior: 'offset',
	} );

	let first = true;
	for await ( const chunk of chunks ) {

		muxer.addVideoChunkRaw( chunk.data, chunk.key ? 'key' : 'delta', chunk.timestamp, first && decoderConfig ? { decoderConfig } : undefined );
		first = false;
		if ( pending.length > 8 ) await Promise.all( pending.splice( 0 ) );

	}

	muxer.finalize();
	await Promise.all( pending );

}
