import { readFile } from 'node:fs/promises';
import { NodeWorker } from './NodeWorker.js';
import { XMLDOMParser } from './XMLDOMParser.js';

// three.js's FileLoader constructs one on every chunk of a streamed download.
class NodeProgressEvent extends Event {

	constructor( type, { lengthComputable = false, loaded = 0, total = 0 } = {} ) {

		super( type );
		this.lengthComputable = lengthComputable;
		this.loaded = loaded;
		this.total = total;

	}

}

const SHARED_UPLOAD_CHUNK = 64 * 2 ** 20;
const WRAPPED = Symbol.for( 'rayzee.sharedUploads' );

function sharedBytes( data, elementOffset = 0, elementCount = undefined ) {

	const isView = ArrayBuffer.isView( data );
	const backing = isView ? data.buffer : data;
	if ( ! ( backing instanceof SharedArrayBuffer ) ) return null;

	const size = isView ? data.BYTES_PER_ELEMENT ?? 1 : 1;
	const start = ( isView ? data.byteOffset : 0 ) + elementOffset * size;
	const length = elementCount !== undefined ? elementCount * size : ( isView ? data.byteLength : backing.byteLength ) - elementOffset * size;
	return new Uint8Array( backing, start, length );

}

// dawn.node (webgpu 0.6.1) segfaults writing from a SharedArrayBuffer, which WebGPU allows and the
// engine's triangle and BVH stores are. Such uploads are copied out first, 64 MB at a time.
function copySharedUploads() {

	const Queue = globalThis.GPUQueue;
	if ( ! Queue ) throw new Error( 'nodePlatform(): install the webgpu globals first — Object.assign( globalThis, globals )' );
	if ( Queue.prototype[ WRAPPED ] ) return;

	const { writeBuffer, writeTexture } = Queue.prototype;

	Queue.prototype.writeBuffer = function ( ...args ) {

		const [ buffer, bufferOffset, data, dataOffset, size ] = args;
		const bytes = sharedBytes( data, dataOffset ?? 0, size );
		if ( ! bytes ) return writeBuffer.apply( this, args );

		for ( let at = 0; at < bytes.length; at += SHARED_UPLOAD_CHUNK ) {

			writeBuffer.call( this, buffer, bufferOffset + at, bytes.slice( at, at + SHARED_UPLOAD_CHUNK ) );

		}

	};

	Queue.prototype.writeTexture = function ( ...args ) {

		const bytes = sharedBytes( args[ 1 ] );
		if ( bytes ) args[ 1 ] = bytes.slice();
		return writeTexture.apply( this, args );

	};

	Queue.prototype[ WRAPPED ] = true;

}

/**
 * Everything the engine needs from Node, for `configurePlatform( nodePlatform( { decodeImage } ) )`:
 * the worker class, the host's image decoder — the engine carries none — a reader for `file:` URLs, so
 * what the engine downloads itself (OIDN weights, IES profiles) can come from disk, and a DOMParser for the XML
 * formats (Collada, 3MF). It also defines
 * `ProgressEvent` where the runtime lacks it, the one browser class three.js's loaders construct.
 * WebGPU itself is the host's: install the `webgpu` package's globals and `navigator.gpu` first, since
 * its queue is wrapped here to copy uploads out of shared memory.
 *
 * @param {Object} [options]
 * @param {( bytes: Uint8Array, mimeType: string ) => Promise<{data: Uint8Array, width: number, height: number}>} [options.decodeImage]
 *   PNG/JPEG/WebP bytes to RGBA8 pixels, top row first. Without it a model's textures cannot load.
 * @param {?number} [options.threads] - threads each worker pool may use (`configurePlatform`'s `threads`); left as it is when not given
 */
export function nodePlatform( { decodeImage, threads } = {} ) {

	globalThis.ProgressEvent ??= NodeProgressEvent;
	copySharedUploads();
	return { Worker: NodeWorker, decodeImage: decodeImage ?? null, readFile, DOMParser: XMLDOMParser, ...( threads !== undefined && { threads } ) };

}

/**
 * {@link nodePlatform} for Deno (its WebGPU is wgpu's), and the globals
 * Deno lacks or half-has: no-op animation frames (three.js stops its frame loop through them, and the kernels then
 * compile in the background), {@link NodeWorker} as the global `Worker` (Deno's takes modules only, and three's Draco
 * and KTX2 decoders start classic ones), and no `createImageBitmap` / `OffscreenCanvas` (Deno has both but no 2D
 * context, so textures pack on the CPU, as in Node). Sets those globals.
 *
 * @param {Object} [options] - as nodePlatform's
 */
export function denoPlatform( options ) {

	globalThis.requestAnimationFrame ??= () => 0;
	globalThis.cancelAnimationFrame ??= () => {};

	for ( const name of [ 'createImageBitmap', 'OffscreenCanvas' ] ) Object.defineProperty( globalThis, name, { value: undefined, configurable: true, writable: true } );
	globalThis.Worker = NodeWorker;
	return nodePlatform( options );

}
