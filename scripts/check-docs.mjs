// The docs site (docsify, rooted at docs/): checks it, or serves it locally.
//   node scripts/check-docs.mjs                       every sidebar entry, link, image and anchor; exit 1 on a problem
//   node scripts/check-docs.mjs --serve [--port 3000] a static server for docs/ on localhost

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const DOCS = join( ROOT, 'docs' );
const REPO_URL = /^https:\/\/github\.com\/atul-mourya\/rayzee-renderer\/(?:blob|tree)\/main\/([^?#]*)(?:#(.*))?$/;
// Working notes and private files: never part of the site.
const NOT_SITE = [ 'TODO.md', 'ROADMAP.md', '_sidebar.md' ];

const args = process.argv.slice( 2 );
const portArg = args.find( a => a.startsWith( '--port' ) );
const port = Number( portArg?.includes( '=' ) ? portArg.split( '=' )[ 1 ] : args[ args.indexOf( '--port' ) + 1 ] ) || 3000;

if ( args.includes( '--serve' ) ) serve( port );
else process.exit( check() ? 0 : 1 );

// Check

function check() {

	const problems = [];
	const counts = { pages: 0, sidebar: 0, links: 0, anchors: 0, images: 0, github: 0, external: 0 };
	const texts = new Map();
	const slugCache = new Map();

	const read = abs => {

		if ( ! texts.has( abs ) ) texts.set( abs, readFileSync( abs, 'utf8' ) );
		return texts.get( abs );

	};

	const slugsOf = abs => {

		if ( ! slugCache.has( abs ) ) slugCache.set( abs, headingSlugs( read( abs ) ) );
		return slugCache.get( abs );

	};

	const rel = abs => relative( ROOT, abs ).split( sep ).join( '/' );
	const inside = ( abs, dir ) => abs === dir || abs.startsWith( dir + sep );
	const isInternal = abs => inside( abs, join( DOCS, 'internal' ) );
	const fail = ( where, msg ) => problems.push( `${where}  ${msg}` );

	// A site path (docs-relative, '/'-rooted or relative to `fromDir`) → the file docsify fetches for it.
	const sitePage = ( target, fromDir ) => {

		const abs = target.startsWith( '/' ) ? join( DOCS, target ) : resolve( fromDir, target );
		if ( target.endsWith( '/' ) || ( existsSync( abs ) && statSync( abs ).isDirectory() ) ) return join( abs, 'README.md' );
		if ( ! extname( abs ) && ! existsSync( abs ) && existsSync( abs + '.md' ) ) return abs + '.md';
		return abs;

	};

	const checkAnchor = ( where, file, anchor ) => {

		if ( ! anchor ) return;
		counts.anchors ++;
		if ( ! slugsOf( file ).has( decodeURIComponent( anchor ) ) ) fail( where, `no heading #${anchor} in ${rel( file )}` );

	};

	// Links of one page. `site` pages follow docsify's rules; the READMEs outside docs/ only GitHub's.
	const checkPage = ( abs, site ) => {

		counts.pages ++;
		const fromDir = dirname( abs );
		for ( const { url, image, line } of linksOf( read( abs ) ) ) {

			const where = `${rel( abs )}:${line}`;
			const gh = url.match( REPO_URL );
			if ( gh ) {

				counts.github ++;
				const target = join( ROOT, decodeURIComponent( gh[ 1 ] ) );
				if ( ! existsSync( target ) ) fail( where, `GitHub link to a missing file: ${gh[ 1 ]}` );
				else if ( isInternal( target ) ) fail( where, 'links into docs/internal' );
				else if ( target.endsWith( '.md' ) ) checkAnchor( where, target, gh[ 2 ] );
				continue;

			}

			if ( /^([a-z][a-z\d+.-]*:|\/\/)/i.test( url ) ) {

				counts.external ++;
				continue;

			}

			if ( url.startsWith( '#' ) && ! url.startsWith( '#/' ) ) {

				checkAnchor( where, abs, url.slice( 1 ) );
				continue;

			}

			const [ path, anchor ] = ( url.startsWith( '#/' ) ? url.slice( 1 ) : url ).split( '#' );
			const decoded = decodeURI( path.split( '?' )[ 0 ] );
			if ( image ) counts.images ++;
			else counts.links ++;
			const target = site ? sitePage( decoded, fromDir ) : resolve( fromDir, decoded );

			if ( isInternal( target ) ) {

				fail( where, `links into docs/internal: ${url}` );
				continue;

			}

			if ( ! inside( target, ROOT ) || ! existsSync( target ) ) {

				fail( where, `${image ? 'image' : 'link'} to a missing file: ${url}` );
				continue;

			}

			if ( site && ! inside( target, DOCS ) && image ) fail( where, `image outside docs/ (the site cannot show it): ${url}` );
			if ( site && inside( target, DOCS ) && ! inside( realpathSync( target ), realpathSync( DOCS ) ) ) fail( where, `link leaves docs/ through a symlink: ${url}` );
			if ( target.endsWith( '.md' ) ) checkAnchor( where, target, anchor );

		}

	};

	// The sidebar: '/'-rooted entries (docsify's relativePath resolves anything else against the open page).
	const sidebarFile = join( DOCS, '_sidebar.md' );
	const listed = new Set();
	if ( ! existsSync( sidebarFile ) ) fail( 'docs/_sidebar.md', 'missing' );
	else {

		for ( const { url, line } of linksOf( read( sidebarFile ) ) ) {

			const where = `docs/_sidebar.md:${line}`;
			if ( /^([a-z][a-z\d+.-]*:|\/\/)/i.test( url ) ) continue;
			counts.sidebar ++;
			if ( ! url.startsWith( '/' ) ) fail( where, `entry must start with '/': ${url}` );
			const [ path, anchor ] = url.split( '#' );
			const page = sitePage( decodeURI( path ), DOCS );
			if ( isInternal( page ) || ! inside( page, DOCS ) ) fail( where, `entry outside the site: ${url}` );
			else if ( ! existsSync( page ) ) fail( where, `entry to a missing page: ${url}` );
			else {

				listed.add( page );
				checkAnchor( where, page, anchor );

			}

		}

	}

	// The navbar in index.html.
	const index = join( DOCS, 'index.html' );
	if ( ! existsSync( index ) ) fail( 'docs/index.html', 'missing' );
	else {

		for ( const m of read( index ).matchAll( /<a\s[^>]*href="#(\/[^"]*)"/g ) ) {

			const page = sitePage( m[ 1 ].split( '?' )[ 0 ], DOCS );
			if ( ! existsSync( page ) ) fail( 'docs/index.html', `nav link to a missing page: #${m[ 1 ]}` );

		}

	}

	if ( ! existsSync( join( DOCS, '.nojekyll' ) ) ) fail( 'docs/.nojekyll', 'missing (GitHub Pages would hide _sidebar.md)' );

	// Every page of the site, and every page the sidebar leaves out.
	const home = join( DOCS, 'README.md' );
	if ( ! existsSync( home ) ) fail( 'docs/README.md', 'missing' );
	for ( const page of new Set( [ home, ...listed ] ) ) if ( existsSync( page ) ) checkPage( page, true );
	for ( const page of markdownUnder( DOCS ) ) {

		if ( page !== home && ! listed.has( page ) ) fail( rel( page ), 'not in the sidebar' );

	}

	// The READMEs that link into the docs from outside the site.
	for ( const readme of [ 'README.md', 'rayzee/README.md' ] ) checkPage( join( ROOT, readme ), false );

	const c = counts;
	console.log( `docs: ${c.pages} pages, ${c.sidebar} sidebar entries, ${c.links} links, ${c.images} images, ${c.anchors} anchors, `
		+ `${c.github} GitHub links checked (${c.external} other external links not fetched)` );
	if ( problems.length ) console.log( problems.map( p => `  ${p}` ).join( '\n' ) );
	console.log( `${problems.length} problem${problems.length === 1 ? '' : 's'}` );
	return problems.length === 0;

}

function markdownUnder( dir, top = dir ) {

	const out = [];
	for ( const entry of readdirSync( dir, { withFileTypes: true } ) ) {

		const abs = join( dir, entry.name );
		if ( entry.isSymbolicLink() || entry.name.startsWith( '.' ) || ( dir === top && entry.name === 'internal' ) ) continue;
		if ( entry.isDirectory() ) out.push( ...markdownUnder( abs, top ) );
		else if ( entry.name.endsWith( '.md' ) && ! ( dir === top && NOT_SITE.includes( entry.name ) ) ) out.push( abs );

	}

	return out;

}

// Markdown outside code: fenced blocks blanked, inline code removed, line numbers kept.
function prose( markdown ) {

	let fence = null;
	return markdown.split( '\n' ).map( line => {

		const m = line.match( /^\s*(`{3,}|~{3,})/ );
		if ( fence ) {

			if ( m && m[ 1 ][ 0 ] === fence[ 0 ] && m[ 1 ].length >= fence.length ) fence = null;
			return '';

		}

		if ( m ) {

			fence = m[ 1 ];
			return '';

		}

		return line.replace( /(`+)[\s\S]*?\1/g, '' );

	} );

}

function linksOf( markdown ) {

	const out = [];
	prose( markdown ).forEach( ( text, i ) => {

		const line = i + 1;
		for ( const m of text.matchAll( /(!?)\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g ) ) out.push( { url: m[ 2 ], image: !! m[ 1 ], line } );
		const def = text.match( /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(\s.*)?$/ );
		if ( def ) out.push( { url: def[ 1 ], image: false, line } );
		for ( const m of text.matchAll( /<(img|a|source)\b[^>]*?\s(?:src|href)=["']([^"']+)["']/gi ) ) out.push( { url: m[ 2 ], image: m[ 1 ].toLowerCase() !== 'a', line } );

	} );

	return out;

}

// GitHub's heading ids (the site adds the same ones beside docsify's: see docs/index.html).
function headingSlugs( markdown ) {

	const slugs = new Set();
	const seen = new Map();
	let fence = null;
	for ( const line of markdown.split( '\n' ) ) {

		const f = line.match( /^\s*(`{3,}|~{3,})/ );
		if ( fence ) {

			if ( f && f[ 1 ][ 0 ] === fence[ 0 ] && f[ 1 ].length >= fence.length ) fence = null;
			continue;

		}

		if ( f ) {

			fence = f[ 1 ];
			continue;

		}

		const h = line.match( /^#{1,6}\s+(.*?)\s*#*\s*$/ );
		for ( const m of line.matchAll( /<a\s[^>]*(?:id|name)=["']([^"']+)["']/g ) ) slugs.add( m[ 1 ] );
		if ( ! h ) continue;
		const base = githubSlug( plainText( h[ 1 ] ) );
		const n = seen.get( base ) ?? 0;
		seen.set( base, n + 1 );
		slugs.add( n ? `${base}-${n}` : base );

	}

	return slugs;

}

function plainText( heading ) {

	return heading.split( /(`+[^`]*`+)/ ).map( ( part, i ) => i % 2 ? part.replace( /^`+|`+$/g, '' ) : part
		.replace( /!\[([^\]]*)\]\([^)]*\)/g, '$1' )
		.replace( /\[([^\]]*)\]\([^)]*\)/g, '$1' )
		.replace( /<[^>]+>/g, '' )
		.replace( /&amp;/g, '&' ).replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' ).replace( /&quot;/g, '"' ).replace( /&#39;/g, '\'' )
		.replace( /\*+|(?<!\w)_+|_+(?!\w)/g, '' ) ).join( '' );

}

function githubSlug( text ) {

	return text.trim().toLowerCase().replace( /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '' ).replace( / /g, '-' );

}

// Serve

function serve( listenPort ) {

	const TYPES = {
		'.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
		'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
	};
	const root = realpathSync( DOCS );

	createServer( ( req, res ) => {

		let file = null;
		try {

			let path = decodeURIComponent( new URL( req.url, 'http://localhost' ).pathname );
			if ( path.endsWith( '/' ) ) path += 'index.html';
			const real = realpathSync( resolve( DOCS, '.' + path ) );
			// docs/internal is private (and a symlink out of docs/ in worktrees): never served.
			const top = relative( root, real ).split( sep )[ 0 ];
			if ( real.startsWith( root + sep ) && top !== 'internal' && statSync( real ).isFile() ) file = real;

		} catch {

			file = null;

		}

		if ( ! file ) {

			res.writeHead( 404, { 'content-type': 'text/plain; charset=utf-8' } );
			res.end( 'Not found' );
			return;

		}

		res.writeHead( 200, { 'content-type': TYPES[ extname( file ).toLowerCase() ] ?? 'application/octet-stream', 'cache-control': 'no-cache' } );
		createReadStream( file ).pipe( res );

	} ).listen( listenPort, 'localhost', () => console.log( `Docs at http://localhost:${listenPort}/  (Ctrl+C to stop)` ) );

}
