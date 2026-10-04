/**
 * File formats beyond glTF and .hdr — `rayzee/addons/formats`: FBX, OBJ, STL, PLY, Collada, 3MF and USD models, and
 * EXR environments. PathTracerApp registers all of them itself; on the renderer core, register the ones you read (each
 * three.js loader is downloaded the first time its format is read, and a bundler drops the formats you leave out):
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { objFormat, exrFormat } from 'rayzee/addons/formats';
 *
 * renderer.assetLoader.registerFormat( objFormat, exrFormat );
 * await renderer.loadFile( objFile );
 */

export {
	fbxFormat, objFormat, stlFormat, plyFormat, colladaFormat, threeMFFormat, usdFormat, exrFormat, allFormats,
} from '../Processor/FileFormats.js';
