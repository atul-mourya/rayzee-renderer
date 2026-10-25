/**
 * The renderer core (`rayzee/core`) imports nothing from the layers above it. Walks the static imports
 * from its entry and fails on any module the viewer or a capability owns. See docs/CORE_AND_ADDONS.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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

const ABOVE_THE_CORE = [
	/^viewer\//,
	/^addons\//,
	/^(environment\/(PhysicalSky|AtmosphereModel)|shaders\/(Atmosphere|EnvironmentCDF))\.js$/,
	/^loaders\/archives\/(ArchiveImporter|ArchiveReader|ArchiveCache|ZipReader)\.js$/,
	/^loaders\/FileFormats\.js$/,
	/^loaders\/(pbrt|usd)\//,
	/^storage\/SceneGraphCodec\.js$/,
	/^pathtracer\/BidirectionalIntegrator\.js$/,
	/^color\/(ColorManagement|OcioViews|OcioRuntime|LutBake|ColorSpaces|InputColorSpaces|BakedViews|Displays)\.js$/,
	/^shaders\/(Bidirectional|BidirectionalLamps|LightGuide)\.js$/,
	/^shaders\/kernels\/(LightGenerateKernel|ConnectKernel|LightSplatKernel|MergeKernel)\.js$/,
	/^storage\/(StorageManager|StorageOps|StorageWorker|openStorage|transport|inlineTransport|locks|events)\.js$/,
];

// What a capability may not reach: the viewer, or another capability.
const VIEWER = ABOVE_THE_CORE.slice( 0, 1 );

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

	it( 'leaves the physical sky to its add-on, which reaches no viewer code', () => {

		const sky = reachable( 'addons/physicalSky.js' );
		expect( sky ).toContain( 'environment/PhysicalSky.js' );
		expect( sky.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

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

	it( 'leaves the other file formats to their add-on, which reaches no viewer code', () => {

		const formats = reachable( 'addons/formats.js' );
		expect( formats ).toContain( 'loaders/FileFormats.js' );
		expect( formats.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'exports the archive formats, so a host can install that add-on to load on first use', () => {

		const core = readFileSync( resolve( SRC, 'core.js' ), 'utf8' );
		expect( core ).toMatch( /export \{ ARCHIVE_FORMATS\b[^}]*\} from '\.\/loaders\/archives\/archiveFormats\.js'/ );

	} );

	it( 'leaves archives and pbrt to their add-on, which reaches no viewer code', () => {

		const archives = reachable( 'addons/archives.js' );
		expect( archives ).toEqual( expect.arrayContaining( [ 'loaders/archives/ArchiveImporter.js', 'loaders/pbrt/index.js' ] ) );
		expect( archives.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves bidirectional and vertex merging to their add-on, which reaches no viewer code', () => {

		const bidirectional = reachable( 'addons/bidirectional.js' );
		expect( bidirectional ).toEqual( expect.arrayContaining( [ 'pathtracer/BidirectionalIntegrator.js', 'shaders/kernels/ConnectKernel.js' ] ) );
		expect( bidirectional.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves the OCIO pipeline to its add-on, which reaches no viewer code', () => {

		const color = reachable( 'addons/color.js' );
		expect( color ).toEqual( expect.arrayContaining( [ 'color/ColorManagement.js', 'color/OcioRuntime.js' ] ) );
		expect( color.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves on-disk storage to its add-on, which reaches no viewer code', () => {

		const storage = reachable( 'addons/storage.js' );
		expect( storage ).toEqual( expect.arrayContaining( [ 'storage/StorageManager.js', 'storage/openStorage.js' ] ) );
		expect( storage.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'keeps every module only the full entry reaches under viewer/', () => {

		const below = new Set( [ ...modules, ...[ 'archives', 'bidirectional', 'color', 'formats', 'physicalSky', 'storage' ].flatMap( a => reachable( `addons/${a}.js` ) ) ] );
		const viewerOnly = reachable( 'index.js' ).filter( m => ! below.has( m ) && ! /^(index|storage\/index)\.js$/.test( m ) );
		expect( viewerOnly.length ).toBeGreaterThan( 0 );
		expect( viewerOnly.filter( m => ! m.startsWith( 'viewer/' ) ) ).toEqual( [] );

	} );

	it( 'is what the full entry builds on', () => {

		expect( reachable( 'index.js' ) ).toEqual( expect.arrayContaining( [ 'RayzeeRenderer.js', 'viewer/PathTracerApp.js' ] ) );

	} );

} );
