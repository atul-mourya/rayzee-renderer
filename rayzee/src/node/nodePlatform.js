import { NodeWorker } from './NodeWorker.js';

// three.js's FileLoader constructs one on every chunk of a streamed download.
class NodeProgressEvent extends Event {

	constructor( type, { lengthComputable = false, loaded = 0, total = 0 } = {} ) {

		super( type );
		this.lengthComputable = lengthComputable;
		this.loaded = loaded;
		this.total = total;

	}

}

/**
 * Everything the engine needs from Node, for `configurePlatform( nodePlatform( { decodeImage } ) )`:
 * the worker class and the host's image decoder — the engine carries none. It also defines
 * `ProgressEvent` where the runtime lacks it, the one browser class three.js's loaders construct.
 * WebGPU itself is the host's: install it as `navigator.gpu` (the `webgpu` package).
 *
 * @param {Object} [options]
 * @param {( bytes: Uint8Array, mimeType: string ) => Promise<{data: Uint8Array, width: number, height: number}>} [options.decodeImage]
 *   PNG/JPEG/WebP bytes to RGBA8 pixels, top row first. Without it a model's textures cannot load.
 */
export function nodePlatform( { decodeImage } = {} ) {

	globalThis.ProgressEvent ??= NodeProgressEvent;
	return { Worker: NodeWorker, decodeImage: decodeImage ?? null };

}
