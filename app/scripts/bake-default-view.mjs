/**
 * Bake the default colour config's default view to the file the app shows at startup, so the first
 * frame needs neither the OCIO runtime nor the config. Rerun whenever either changes, and upload the
 * result beside the config.
 *
 *   npm run color:bake [-- <config dir>]    (default .cdn-upload/ocio/<id>)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureAssets } from '../../rayzee/src/AssetConfig.js';
import { ColorManagement } from '../../rayzee/src/Color/ColorManagement.js';
import { DEFAULT_COLOR_IDENTITY } from '../src/lib/colorDefaults.js';

const { id, view, bakedView } = DEFAULT_COLOR_IDENTITY;
const dir = process.argv[ 2 ] ?? join( '.cdn-upload', 'ocio', id );

configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

// Exactly the files the app mounts: the fingerprint covers them.
const manifest = JSON.parse( readFileSync( join( dir, 'manifest.json' ), 'utf8' ) );
const files = manifest.files.map( relativePath => ( { relativePath, data: new Uint8Array( readFileSync( join( dir, relativePath ) ) ) } ) );

const cm = new ColorManagement();
await cm.loadConfig( { files, configPath: manifest.config, id, registerViews: false } );
const entry = cm.setView( view );
const bytes = await cm.saveBakedView( entry.id );

const out = join( dir, bakedView );
writeFileSync( out, bytes );
console.log( `${out}: ${entry.name}, ${( bytes.length / 1024 ).toFixed( 0 )} KB, ` +
	`table error mean ${entry.error.mean.toFixed( 2 )} / p95 ${entry.error.p95.toFixed( 2 )} code values` );
