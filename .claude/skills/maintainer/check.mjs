#!/usr/bin/env node
// The mechanical half of docs/design/CONVENTIONS.md. Reports; changes nothing.
// node .claude/skills/maintainer/check.mjs [--since <ref>]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../..' );
const git = ( ...args ) => execFileSync( 'git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 } );
const read = f => readFileSync( join( ROOT, f ), 'utf8' );
const arg = name => {

	const i = process.argv.indexOf( name );
	return i > 0 ? process.argv[ i + 1 ] : null;

};

const since = arg( '--since' );
const tracked = git( 'ls-files' ).split( '\n' ).filter( f => f && existsSync( join( ROOT, f ) ) );
const SRC = 'rayzee/src/';
const engine = tracked.filter( f => f.startsWith( SRC ) ).map( f => f.slice( SRC.length ) );
const engineJS = engine.filter( f => f.endsWith( '.js' ) );

// Items the user accepted stay out of the report: the ```accepted block in CONVENTIONS.md.
const CONVENTIONS = 'docs/design/CONVENTIONS.md';
const accepted = new Set( existsSync( join( ROOT, CONVENTIONS ) )
	? ( /```accepted\n([\s\S]*?)```/.exec( read( CONVENTIONS ) )?.[ 1 ] ?? '' ).split( '\n' ).map( l => l.trim() ).filter( Boolean ) : [] );
let skipped = 0;

const report = [];
const add = ( title, severity, items ) => {

	const shown = items.filter( i => ! accepted.has( i ) );
	skipped += items.length - shown.length;
	report.push( { title, severity, items: shown } );

};

// Layout

const ROOT_FILES = [ 'AssetConfig.js', 'EngineDefaults.js', 'EngineEvents.js', 'EngineIssues.js', 'HeadlessCanvas.js',
	'Logger.js', 'Platform.js', 'Portable.js', 'RayzeeRenderer.js', 'RenderSettings.js', 'Version.js', 'core.js', 'index.js' ];
const FOLDERS = [ 'addons', 'bvh', 'color', 'environment', 'lights', 'loaders', 'materials', 'memory', 'node', 'output',
	'pathtracer', 'pipeline', 'scene', 'shaders', 'storage', 'viewer' ];
add( 'rayzee/src root: a file or folder not in the agreed list', 'rule',
	[ ...new Set( engine.map( f => f.split( '/' )[ 0 ] ) ) ].filter( n => ! ROOT_FILES.includes( n ) && ! FOLDERS.includes( n ) ) );

const dirsOf = list => [ ...new Set( list.flatMap( f => f.split( '/' ).slice( 0, - 1 ).map( ( _, i, a ) => a.slice( 0, i + 1 ).join( '/' ) ) ) ) ];
const CATCH_ALL = /^(utils?|helpers?|managers?|misc|common|shared|processors?|stuff|other)$/i;
const testDirs = dirsOf( tracked.filter( f => f.startsWith( 'tests/unit/' ) ).map( f => f.slice( 11 ) ) ).filter( d => ! /(^|\/)(fixtures|__snapshots__)(\/|$)/.test( d ) );
add( 'Folder not lowercase, or a catch-all name', 'rule', [
	...dirsOf( engine ).filter( d => ! /^[a-z][a-z0-9-]*$/.test( basename( d ) ) || CATCH_ALL.test( basename( d ) ) ).map( d => SRC + d ),
	...testDirs.filter( d => ! /^[a-z][a-z0-9-]*$/.test( basename( d ) ) ).map( d => 'tests/unit/' + d ),
	...dirsOf( tracked.filter( f => f.startsWith( 'app/src/' ) ).map( f => f.slice( 8 ) ) ).filter( d => CATCH_ALL.test( basename( d ) ) ).map( d => 'app/src/' + d ),
] );

const ENTRY = f => f === 'index.js' || f === 'core.js' || f === 'addons/formats.js' || basename( f ) === 'index.js';
add( 'Engine module not PascalCase (entries are index.js / core.js / addons/formats.js)', 'rule',
	engineJS.filter( f => ! ENTRY( f ) && ! /^[A-Z][A-Za-z0-9]*\.js$/.test( basename( f ) ) ).map( f => SRC + f ) );

add( 'App: hook not named useX.js (use-toast.js keeps the UI kit\'s name)', 'rule',
	tracked.filter( f => f.startsWith( 'app/src/hooks/' ) && ! /^use[A-Z]\w*\.jsx?$/.test( basename( f ) ) && basename( f ) !== 'use-toast.js' ) );
add( 'App: a store file holding more than one store (ui.js keeps the general store and its small siblings)', 'rule',
	tracked.filter( f => /^app\/src\/store\/\w+\.js$/.test( f ) && f !== 'app/src/store/ui.js' ).filter( f => ( read( f ).match( /=\s*create\s*\(/g ) || [] ).length > 1 ) );

// Case-only renames hide on macOS: a path git tracks must match the disk letter for letter.
const listing = new Map();
const entriesOf = d => {

	if ( ! listing.has( d ) ) listing.set( d, new Set( readdirSync( join( ROOT, d ) ) ) );
	return listing.get( d );

};

add( 'Tracked path whose letter case differs from the disk', 'rule', tracked.filter( f => {

	const parts = f.split( '/' );
	return parts.some( ( p, i ) => ! entriesOf( parts.slice( 0, i ).join( '/' ) || '.' ).has( p ) );

} ) );

// Tests laid out like the source

const unitTests = tracked.filter( f => f.startsWith( 'tests/unit/' ) && /\.test\.jsx?$/.test( f ) );
const misplaced = [];
const relativeIntoSrc = [];
for ( const t of unitTests ) {

	const dir = posix.dirname( t.slice( 11 ) );
	if ( /^(app|bench)(\/|$)/.test( dir ) ) continue;
	const text = read( t );
	if ( /from\s+['"](\.\.\/)+rayzee\/src\//.test( text ) ) relativeIntoSrc.push( t );
	if ( dir !== 'core' && ! existsSync( join( ROOT, SRC, dir ) ) ) {

		misplaced.push( `${t} (no rayzee/src/${dir}/)` );
		continue;

	}

	const named = basename( t ).replace( /\.test\.jsx?$/, '' );
	const module = named[ 0 ].toUpperCase() + named.slice( 1 ) + '.js';
	if ( existsSync( join( ROOT, SRC, dir === 'core' ? '' : dir, module ) ) ) continue;
	const homes = new Set( [ ...text.matchAll( /['"]@\/core\/([^'"?]+)['"]/g ) ].map( m => {

		const d = posix.dirname( m[ 1 ] );
		return d === '.' ? 'core' : d;

	} ) );
	if ( homes.size && ! homes.has( dir ) ) misplaced.push( `${t} (imports from ${[ ...homes ].join( ', ' )})` );

}

add( 'Unit test not in the folder of the code it imports', 'watch', misplaced );
add( 'Unit test importing rayzee/src by relative path instead of @/core', 'rule', relativeIntoSrc );

// Exports

const ENTRY_FILES = engineJS.filter( f => ENTRY( f ) || f === 'output/ImageEncoders.js' || f.startsWith( 'node/' ) );
const exportedNames = text => {

	const names = new Set();
	for ( const m of text.matchAll( /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm ) ) names.add( m[ 1 ] );
	for ( const m of text.matchAll( /^export\s*\{([^}]*)\}\s*(from\b)?/gm ) ) {

		if ( m[ 2 ] ) continue;
		for ( const part of m[ 1 ].split( ',' ) ) {

			const name = part.trim().split( /\s+as\s+/ ).pop();
			if ( name && name !== 'default' ) names.add( name );

		}

	}

	return names;

};

const publicNames = new Set();
for ( const f of ENTRY_FILES ) {

	const text = read( SRC + f );
	for ( const n of exportedNames( text ) ) publicNames.add( n );
	for ( const m of text.matchAll( /export\s*\{([^}]*)\}\s*from/g ) ) for ( const p of m[ 1 ].split( ',' ) ) publicNames.add( p.trim().split( /\s+as\s+/ )[ 0 ] );

}

const corpus = tracked.filter( f => /\.(m?js|jsx)$/.test( f ) && /^(rayzee\/(src|examples)|app\/src|tests|bench)\//.test( f ) );
const tokens = new Map( corpus.map( f => [ f, read( f ) ] ) );
const usersOf = ( name, self ) => {

	const re = new RegExp( `(^|[^\\w$])${name.replace( /\$/g, '\\$' )}([^\\w$]|$)` );
	const users = [];
	for ( const [ f, text ] of tokens ) if ( f !== self && re.test( text ) ) users.push( f );
	return users;

};

const unused = [], ownFileOnly = [], testsOnly = [];
for ( const f of engineJS ) {

	if ( ENTRY_FILES.includes( f ) ) continue;
	const text = tokens.get( SRC + f );
	for ( const name of exportedNames( text ) ) {

		if ( publicNames.has( name ) ) continue;
		const users = usersOf( name, SRC + f );
		const where = `${SRC}${f}: ${name}`;
		if ( users.length === 0 ) {

			const own = ( text.match( new RegExp( `(^|[^\\w$])${name.replace( /\$/g, '\\$' )}([^\\w$]|$)`, 'g' ) ) || [] ).length;
			( own > 1 ? ownFileOnly : unused ).push( where );

		} else if ( users.every( u => u.startsWith( 'tests/' ) ) && ( text.match( new RegExp( `(^|[^\\w$])${name.replace( /\$/g, '\\$' )}([^\\w$]|$)`, 'g' ) ) || [] ).length === 1 ) testsOnly.push( where );

	}

}

add( 'Exported and used nowhere: remove', 'rule', unused );
add( 'Exported but used only in its own file: un-export', 'rule', ownFileOnly );
add( 'Exported, and used only by tests: dead code a test keeps alive, unless a deliberate seam', 'watch', testsOnly );

// Docs

const DOCS = tracked.filter( f => f.endsWith( '.md' ) && ! f.startsWith( 'docs/internal/' ) && f !== 'docs/design/CONVENTIONS.md'
	&& ( /^(CLAUDE|CONTRIBUTING|README)\.md$/.test( f ) || /^(docs|bench|rayzee|\.github|\.claude\/agents|\.claude\/skills\/(check-tsl|debug-pipeline|review-stage|maintainer))\//.test( f ) ) );
const byBase = new Map();
for ( const f of tracked ) {

	const b = basename( f );
	if ( ! byBase.has( b ) ) byBase.set( b, [] );
	byBase.get( b ).push( f );

}

const resolves = ( p, doc ) => {

	if ( ! p.includes( '/' ) ) return byBase.has( p );
	const bases = [ '', SRC, 'rayzee/', 'app/src/', 'docs/', 'bench/', 'tests/', dirname( doc ) + '/' ];
	if ( bases.some( b => existsSync( join( ROOT, b, p ) ) ) ) return true;
	return tracked.some( f => f.endsWith( '/' + p ) );

};

const stale = [];
for ( const doc of DOCS ) {

	const lines = read( doc ).split( '\n' );
	lines.forEach( ( line, i ) => {

		for ( const m of line.matchAll( /`([^`\s]+)`|\]\(([^)\s#]+)/g ) ) {

			let p = ( m[ 1 ] || m[ 2 ] ).replace( /^\.\//, '' ).replace( /[:#].*$/, '' ).replace( /\?.*$/, '' );
			if ( ! /^[\w@./-]+\.(js|jsx|mjs|md)$/.test( p ) || /^(https?:|dist\/|three\/|node_modules|@\/|\/)/.test( p ) || /\.(es|umd)\.js$/.test( p ) || p.includes( '*' ) ) continue;
			if ( /(^|\/)([\w-]+)\/\2\//.test( p ) || ! resolves( p, doc ) ) stale.push( `${doc}:${i + 1} ${p}` );

		}

	} );

}

add( 'Doc names a file that does not exist', 'rule', stale );

const claudeChars = read( 'CLAUDE.md' ).length;
add( `CLAUDE.md is ${( claudeChars / 1000 ).toFixed( 1 )}k characters (limit 150k; move detail to docs/design/ past 135k)`,
	claudeChars > 150000 ? 'rule' : claudeChars > 135000 ? 'watch' : 'ok', [] );
const allDocs = tracked.filter( f => f.endsWith( '.md' ) ).map( f => [ f, read( f ) ] );
add( 'Design note no other doc links', 'watch', tracked.filter( f => /^docs\/design\/[^/]+\.md$/.test( f ) )
	.filter( f => ! allDocs.some( ( [ d, text ] ) => d !== f && text.includes( basename( f ) ) ) ) );
for ( const [ f, max ] of [ [ 'rayzee/README.md', 150 ], [ 'bench/README.md', 300 ] ] ) {

	const n = read( f ).split( '\n' ).length;
	add( `${f} is ${n} lines (a how-to; detail goes to docs/)`, n > max ? 'watch' : 'ok', [] );

}

// Size, and what changed since the last audit

const lineCount = f => read( f ).split( '\n' ).length;
const big = tracked.filter( f => /^(rayzee\/src|app\/src)\/.*\.jsx?$/.test( f ) ).map( f => [ f, lineCount( f ) ] ).filter( ( [ , n ] ) => n > 2000 );
const before = f => {

	try {

		return git( 'show', `${since}:${f}` ).split( '\n' ).length;

	} catch {

		return 0;

	}

};

add( 'Files over 2,000 lines' + ( since ? ` (lines at ${since} → now)` : '' ), 'watch',
	big.sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).map( ( [ f, n ] ) => since ? `${f}: ${before( f )} → ${n}` : `${f}: ${n}` ) );

if ( since ) {

	add( `Files added since ${since}`, 'watch', git( 'diff', '--name-only', '--diff-filter=A', `${since}..HEAD`, '--', 'rayzee/src', 'app/src', 'tests', 'bench/harness', 'bench/tools', 'docs', '.claude' )
		.split( '\n' ).filter( f => f && ! f.endsWith( '.png' ) && ! f.includes( '/fixtures/' ) ) );

	const log = git( 'log', '--no-merges', '--format=%h%x09%s', `${since}..HEAD` ).split( '\n' ).filter( l => l && ! /\tchore\(release\):/.test( l ) );
	add( 'Commit subject without a conventional type', 'rule', log.filter( l => ! /^\w+\t(feat|fix|refactor|perf|docs|test|chore|build|ci|style|revert)(\([\w./-]+\))?!?: /.test( l ) ) );
	add( 'Commit marked breaking (only for a public API change)', 'watch',
		git( 'log', '--no-merges', '--format=%h%x09%s%x09%b%x00', `${since}..HEAD` ).split( '\0' ).map( s => s.trim() ).filter( s => ! /^\w+\tchore\(release\):/.test( s ) && /BREAKING CHANGE|^\w+\t\w+(\([^)]*\))?!:/.test( s ) ).map( s => s.split( '\t' ).slice( 0, 2 ).join( ' ' ) ) );

	const blocks = [];
	let file = null, run = 0, start = 0, line = 0;
	const flush = () => {

		if ( run >= 5 ) blocks.push( `${file}:${start} (${run} comment lines)` );
		run = 0;

	};

	for ( const l of git( 'diff', '-U0', `${since}..HEAD`, '--', 'rayzee/src', 'app/src' ).split( '\n' ) ) {

		if ( l.startsWith( '+++ ' ) ) {

			flush();
			file = l.slice( 6 );

		} else if ( l.startsWith( '@@' ) ) {

			flush();
			line = Number( /\+(\d+)/.exec( l )[ 1 ] );

		} else if ( l.startsWith( '+' ) ) {

			if ( /^\+\s*(\/\/|\/\*|\*)/.test( l ) ) {

				if ( run === 0 ) start = line;
				run ++;

			} else flush();
			line ++;

		}

	}

	flush();
	add( 'Added comment blocks of 5+ lines: keep API docs and tables, cut stories and measurements', 'watch', blocks );

}

// Print

let rules = 0;
for ( const { title, severity, items } of report ) {

	if ( severity === 'ok' || ( severity !== 'ok' && items.length === 0 && ! title.startsWith( 'CLAUDE.md' ) && ! title.includes( 'README' ) ) ) {

		console.log( `ok     ${title}` );
		continue;

	}

	if ( severity === 'rule' ) rules += Math.max( 1, items.length );
	console.log( `${severity === 'rule' ? 'RULE ' : 'watch'}  ${title}${items.length ? ` — ${items.length}` : ''}` );
	for ( const item of items ) console.log( `         ${item}` );

}

if ( skipped ) console.log( `\n${skipped} accepted item(s) left out (${CONVENTIONS}, "Accepted exceptions")` );
process.exitCode = rules ? 1 : 0;
