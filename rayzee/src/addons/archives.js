/**
 * Scene archives (.zip, .tar, .tar.gz) and the pbrt-v4 scenes in them — `rayzee/addons/archives`. PathTracerApp
 * installs it itself; on the renderer core, install it once:
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { ArchiveImporter } from 'rayzee/addons/archives';
 *
 * renderer.assetLoader.setArchiveImporter( new ArchiveImporter( renderer.assetLoader ) );
 * await renderer.loadFile( 'scene.tar' );
 */

export { ArchiveImporter, ARCHIVE_ELEMENT_PROMPT_BYTES } from '../Processor/ArchiveImporter.js';
export { openZip, readZipDirectory } from '../Processor/ZipReader.js';
