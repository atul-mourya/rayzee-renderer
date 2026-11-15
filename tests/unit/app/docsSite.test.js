import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { siteFiles, sendSiteFile } from '../../../scripts/check-docs.mjs';

// The docs site the app ships at docs/ (app/vite.config.js copies siteFiles(), its dev server uses sendSiteFile()).
describe( 'docs site', () => {

	it( 'ships the pages, the sidebar and the images, never the working notes', () => {

		const files = siteFiles();
		for ( const file of [ 'index.html', 'README.md', '_sidebar.md', 'app/README.md', 'guide/api.md', 'images/app.jpg' ] ) expect( files ).toContain( file );
		for ( const file of [ 'TODO.md', 'ROADMAP.md' ] ) expect( files ).not.toContain( file );
		expect( files.filter( f => f.startsWith( 'internal/' ) || f.split( '/' ).some( part => part.startsWith( '.' ) ) ) ).toEqual( [] );

	} );

	function request( path ) {

		const res = new PassThrough();
		res.writeHead = vi.fn();
		sendSiteFile( res, path );
		res.resume();
		const [ status, headers ] = res.writeHead.mock.calls[ 0 ];
		return { status, type: headers[ 'content-type' ] };

	}

	it( 'serves the site and nothing else', () => {

		expect( request( '/' ) ).toEqual( { status: 200, type: 'text/html; charset=utf-8' } );
		expect( request( '/guide/api.md' ) ).toEqual( { status: 200, type: 'text/markdown; charset=utf-8' } );
		expect( request( '/_sidebar.md' ).status ).toBe( 200 );
		for ( const path of [ '/TODO.md', '/ROADMAP.md', '/internal/notes.md', '/.nojekyll', '/../package.json', '/%2e%2e/package.json', '/guide/', '/nope.md', '/%E0%A4%A' ] ) {

			expect( request( path ).status, path ).toBe( 404 );

		}

	} );

} );
