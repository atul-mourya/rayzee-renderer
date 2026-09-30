/**
 * Node-only helpers, kept out of the main entry so a browser bundle never sees `node:` imports.
 *
 *   import { configurePlatform, openHeadless } from 'rayzee';
 *   import { nodePlatform } from 'rayzee/node';
 *   configurePlatform( nodePlatform( { decodeImage } ) );
 */
export { NodeWorker } from './NodeWorker.js';
export { nodePlatform } from './nodePlatform.js';
