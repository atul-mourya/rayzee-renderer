/**
 * A stored pbrt scene graph is reused while PBRT_BUILD_REVISION and SCENE_GRAPH_FORMAT stay the same, so a change that
 * builds or stores a different graph from the same files must bump one. This fails on any change to the pbrt loader's
 * or the graph codec's code (comment lines and spacing aside), so that bumping is a decision rather than something to
 * remember. Releases change the key anyway (the package version is in it): this guards stores made between them.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PBRT_BUILD_REVISION } from '@/core/addons/archives/pbrt/index.js';
import { SCENE_GRAPH_FORMAT } from '@/core/addons/archives/SceneGraphCodec.js';

// Updated together: the two numbers in the stored graph's key, and the code that builds and stores it.
const RECORDED = { revision: 35, format: 3, code: '42bd616d65399e29' };

const ARCHIVES = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../../../../rayzee/src/addons/archives' );
const SOURCES = [ 'pbrt', 'SceneGraphCodec.js' ];

// The code without comment lines, blank lines or a change of spacing.
function codeOf( text ) {

	const lines = [];
	let inComment = false;
	for ( const raw of text.split( '\n' ) ) {

		const line = raw.trim();
		if ( inComment ) {

			if ( line.includes( '*/' ) ) inComment = false;
			continue;

		}

		if ( line.startsWith( '/*' ) ) {

			inComment = ! line.includes( '*/' );
			continue;

		}

		if ( line !== '' && ! line.startsWith( '//' ) ) lines.push( line.replace( /\s+/g, ' ' ) );

	}

	return lines.join( '\n' );

}

function sourceFiles() {

	return SOURCES.flatMap( ( source ) => source.endsWith( '.js' ) ? [ resolve( ARCHIVES, source ) ]
		: readdirSync( resolve( ARCHIVES, source ), { recursive: true } )
			.filter( ( file ) => file.endsWith( '.js' ) ).map( ( file ) => resolve( ARCHIVES, source, file ) ) )
		.map( ( file ) => relative( ARCHIVES, file ).split( '\\' ).join( '/' ) ).sort();

}

function loaderCode() {

	const hash = createHash( 'sha256' );
	for ( const name of sourceFiles() ) hash.update( `${name}\0${codeOf( readFileSync( resolve( ARCHIVES, name ), 'utf8' ) )}\0` );
	return hash.digest( 'hex' ).slice( 0, 16 );

}

describe( 'PBRT_BUILD_REVISION', () => {

	it( 'is reconsidered whenever the pbrt loader\'s or the graph codec\'s code changes', () => {

		const now = { revision: PBRT_BUILD_REVISION, format: SCENE_GRAPH_FORMAT, code: loaderCode() };
		expect( now, 'the pbrt loader or the scene graph codec changed. If the same scene files now build a different ' +
			'graph, bump PBRT_BUILD_REVISION (PBRTSceneBuilder.js); if a stored graph now reads differently, ' +
			'SCENE_GRAPH_FORMAT (SceneGraphCodec.js). Either way record ' +
			`{ revision: ${now.revision}, format: ${now.format}, code: '${now.code}' } in this test.` ).toEqual( RECORDED );

	} );

	it( 'hashes the pbrt loader, its subfolders included, and the graph codec', () => {

		const files = sourceFiles();
		expect( files ).toContain( 'SceneGraphCodec.js' );
		expect( files ).toContain( 'pbrt/PBRTSceneBuilder.js' );
		expect( files.every( ( file ) => file === 'SceneGraphCodec.js' || file.startsWith( 'pbrt/' ) ) ).toBe( true );

	} );

	it( 'reads past comments, blank lines and spacing', () => {

		const plain = 'const a = 1;\nb( a );';
		const commented = '// a note\n\tconst  a = 1;   \r\n\n/**\n * More.\n */\n/* one line */\nb( a );\n';
		expect( codeOf( commented ) ).toBe( codeOf( plain ) );
		expect( codeOf( 'const a = 2;\nb( a );' ) ).not.toBe( codeOf( plain ) );

	} );

} );
