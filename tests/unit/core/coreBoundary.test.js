/**
 * The renderer core (`rayzee/core`) imports nothing from the layers above it. Walks the static imports
 * from its entry and fails on any module the viewer or a capability owns. See docs/CORE_AND_ADDONS.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../../rayzee/src' );

// Static `import … from '…'` and `export … from '…'`, not `import( … )`.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function reachable( entry ) {

	const seen = new Set();
	const queue = [ resolve( SRC, entry ) ];
	while ( queue.length ) {

		const file = queue.pop();
		if ( seen.has( file ) ) continue;
		seen.add( file );
		const text = readFileSync( file, 'utf8' );
		for ( const [ , spec ] of text.matchAll( STATIC_IMPORT ) ) {

			if ( ! spec.startsWith( '.' ) ) continue;
			let target = resolve( dirname( file ), spec.split( '?' )[ 0 ] );
			if ( ! existsSync( target ) && existsSync( target + '.js' ) ) target += '.js';
			queue.push( target );

		}

	}

	return [ ...seen ].map( f => relative( SRC, f ) );

}

// Everything else in rayzee/src is the core.
const ABOVE_THE_CORE = [ /^viewer\//, /^addons\// ];

const ADDONS = {
	archives: 'addons/archives/index.js',
	bidirectional: 'addons/bidirectional/index.js',
	color: 'addons/color/index.js',
	formats: 'addons/formats.js',
	physicalSky: 'addons/physicalSky/index.js',
	storage: 'addons/storage/index.js',
};

const listFiles = dir => readdirSync( resolve( SRC, dir ), { recursive: true } )
	.filter( f => f.endsWith( '.js' ) ).map( f => `${dir}/${f}` );

describe( 'the renderer core', () => {

	const modules = reachable( 'core.js' );

	it( 'reaches the path tracer and the compositor', () => {

		expect( modules ).toContain( 'RayzeeRenderer.js' );
		expect( modules ).toContain( 'pathtracer/PathTracer.js' );
		expect( modules ).toContain( 'pipeline/Compositor.js' );

	} );

	it( 'imports no denoiser, camera controls, gizmo, overlay, timeline or viewer', () => {

		const leaks = modules.filter( m => ABOVE_THE_CORE.some( rule => rule.test( m ) ) );
		expect( leaks ).toEqual( [] );

	} );

	it( 'reads glTF and .hdr itself, and imports the glTF decoders only for a file that uses them', () => {

		const THREE_ADDON = /^three\/(addons|examples\/jsm)\//;
		const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
		const statics = new Set(), dynamics = new Set();
		for ( const module of modules ) {

			const text = readFileSync( resolve( SRC, module ), 'utf8' );
			for ( const [ , spec ] of text.matchAll( STATIC_IMPORT ) ) if ( THREE_ADDON.test( spec ) && spec.includes( '/loaders/' ) ) statics.add( spec.split( '/' ).pop() );
			for ( const [ , spec ] of text.matchAll( DYNAMIC_IMPORT ) ) if ( THREE_ADDON.test( spec ) ) dynamics.add( spec.split( '/' ).pop() );

		}

		expect( [ ...statics ].sort() ).toEqual( [ 'GLTFLoader.js', 'HDRLoader.js' ] );
		expect( [ ...dynamics ].sort() ).toEqual( [ 'DRACOLoader.js', 'KTX2Loader.js', 'meshopt_decoder.module.js' ] );

	} );

	it( 'exports the archive formats, so a host can install that add-on to load on first use', () => {

		const core = readFileSync( resolve( SRC, 'core.js' ), 'utf8' );
		expect( core ).toMatch( /export \{ ARCHIVE_FORMATS\b[^}]*\} from '\.\/loaders\/archiveFormats\.js'/ );

	} );

	for ( const [ name, entry ] of Object.entries( ADDONS ) ) {

		it( `keeps the ${name} add-on in its own folder, out of the viewer and the other add-ons`, () => {

			const home = entry.replace( /\/index\.js$/, '' );
			const own = reachable( entry ).filter( m => ! modules.includes( m ) );
			expect( own.filter( m => m !== home && ! m.startsWith( `${home}/` ) ) ).toEqual( [] );
			if ( home !== entry ) expect( listFiles( home ).filter( f => ! own.includes( f ) ) ).toEqual( [] );

		} );

	}

	it( 'keeps every module only the full entry reaches under viewer/', () => {

		const below = new Set( [ ...modules, ...Object.values( ADDONS ).flatMap( reachable ) ] );
		const viewerOnly = reachable( 'index.js' ).filter( m => ! below.has( m ) && m !== 'index.js' );
		expect( viewerOnly.length ).toBeGreaterThan( 0 );
		expect( viewerOnly.filter( m => ! m.startsWith( 'viewer/' ) ) ).toEqual( [] );

	} );

	it( 'is what the full entry builds on', () => {

		expect( reachable( 'index.js' ) ).toEqual( expect.arrayContaining( [ 'RayzeeRenderer.js', 'viewer/PathTracerApp.js' ] ) );

	} );

} );
