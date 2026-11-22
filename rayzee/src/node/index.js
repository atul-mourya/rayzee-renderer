/**
 * Node-only helpers, kept out of the main entry so a browser bundle never sees `node:` imports.
 *
 *   import { configurePlatform, openHeadless } from 'rayzee';
 *   import { nodePlatform } from 'rayzee/node';
 *   configurePlatform( nodePlatform( { decodeImage } ) );   // Deno: denoPlatform( { decodeImage } )
 */
export { NodeWorker } from './NodeWorker.js';
export { nodePlatform, denoPlatform } from './NodePlatform.js';
export { XMLDOMParser } from './XMLDOMParser.js';
