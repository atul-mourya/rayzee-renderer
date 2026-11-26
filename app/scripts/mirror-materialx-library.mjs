/**
 * Copy AMD's MaterialX Library (https://matlib.gpuopen.com, MIT) for the Materials tab: its API and files answer only
 * its own site's origin, so the app reads a copy on the asset host. Writes <out>/catalog.json, previews/<id>.jpg (400 px)
 * and packages/<id>/<size>.zip (a .mtlx and its textures, 8-bit); a rerun downloads only what is missing.
 *
 *   npm run materialx:mirror -- --out <dir> [--sizes 1k,2k] [--limit 20]
 *
 * Then upload <dir> to the asset host as `MaterialXLibrary/`. All 454 materials: 1k 1.9 GB, 2k 7.3 GB more.
 */

import { mkdirSync, existsSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.matlib.gpuopen.com/api';
const SITE = 'https://matlib.gpuopen.com';
const PARALLEL = 6;

/** `--name value` arguments. */
export function parseArgs( argv ) {

	const args = { sizes: [ '1k' ], limit: Infinity, out: null };
	for ( let i = 0; i < argv.length; i += 2 ) {

		const [ key, value ] = [ argv[ i ], argv[ i + 1 ] ];
		if ( key === '--out' ) args.out = value;
		else if ( key === '--sizes' ) args.sizes = value.split( ',' ).map( s => s.trim() ).filter( Boolean );
		else if ( key === '--limit' ) args.limit = Number( value );
		else throw new Error( `unknown argument ${key}` );

	}

	if ( ! args.out ) throw new Error( 'pass --out <dir>' );
	if ( ! ( args.limit > 0 ) ) throw new Error( '--limit takes a number above 0' );
	return args;

}

/** "1k 8b" → "1k"; 16-bit packages are left out (the packer reads 8 bits a channel). */
export function sizeOf( label ) {

	const [ size, depth ] = String( label ).split( ' ' );
	return depth === '8b' ? size : null;

}

/**
 * Every published material from the API's lists: its category and tag names, its first render as the preview, and every
 * 8-bit package it has. Ordered by name.
 */
export function buildCatalog( { materials, categories, tags, packages } ) {

	const categoryName = new Map( categories.map( c => [ c.id, c.title ] ) );
	const tagName = new Map( tags.map( t => [ t.id, t.title ] ) );
	const packageOf = new Map( packages.map( p => [ p.id, p ] ) );

	const items = materials.filter( m => m.status === 'Published' ).map( m => {

		const files = {};
		for ( const id of m.packages ?? [] ) {

			const p = packageOf.get( id );
			const size = p && sizeOf( p.label );
			if ( size ) files[ size ] = { id, path: `packages/${m.id}/${size}.zip` };

		}

		return {
			id: m.id,
			name: m.title.trim(),
			category: categoryName.get( m.category ) ?? 'Other',
			tags: ( m.tags ?? [] ).map( t => tagName.get( t ) ).filter( t => t && ! /^\d+(\.\d+)*$/.test( t ) ),
			render: ( m.renders_order?.length ? m.renders_order : m.renders ?? [] )[ 0 ] ?? null,
			preview: `previews/${m.id}.jpg`,
			packages: files,
			page: `${SITE}/main/materials/all?material=${m.id}`,
		};

	} ).filter( m => Object.keys( m.packages ).length );

	return items.sort( ( a, b ) => a.name.localeCompare( b.name ) );

}

/**
 * catalog.json from what is on disk: each material with the sizes whose zip is there (`bytes( path )`, null when
 * missing), its preview if there; a material with none left out. `sizes` lists the sizes some material has.
 */
export function catalogFrom( items, bytes ) {

	const materials = [];
	for ( const { render, packages, ...item } of items ) {

		const kept = {};
		for ( const [ size, p ] of Object.entries( packages ) ) {

			const n = bytes( p.path );
			if ( n ) kept[ size ] = { path: p.path, bytes: n };

		}

		if ( Object.keys( kept ).length ) materials.push( { ...item, preview: bytes( item.preview ) ? item.preview : null, packages: kept } );

	}

	const sizes = [ ...new Set( materials.flatMap( m => Object.keys( m.packages ) ) ) ].sort( ( a, b ) => parseInt( a ) - parseInt( b ) );
	return { source: 'AMD GPUOpen MaterialX Library', url: SITE, license: 'MIT (as AMD lists each material)', sizes, materials };

}

const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) );

async function json( url ) {

	for ( let attempt = 1; ; attempt ++ ) {

		try {

			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `${response.status} ${url}` );
			return await response.json();

		} catch ( error ) {

			if ( attempt === 3 ) throw error;
			await wait( attempt * 2000 );

		}

	}

}

async function all( path ) {

	const out = [];
	for ( let url = `${API}/${path}/?limit=1000`; url; ) {

		const page = await json( url );
		out.push( ...page.results );
		url = page.next;

	}

	return out;

}

// A zip starts "PK", a JPEG FF D8: anything else is an error page served as a file.
const MAGIC = { zip: [ 0x50, 0x4b ], jpg: [ 0xff, 0xd8 ] };

// Written beside, then renamed: an interrupted run leaves no half file to skip next time.
async function download( url, file ) {

	if ( existsSync( file ) && statSync( file ).size > 0 ) return false;
	const magic = MAGIC[ file.split( '.' ).pop() ];
	for ( let attempt = 1; ; attempt ++ ) {

		try {

			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `${response.status} ${url}` );
			const bytes = new Uint8Array( await response.arrayBuffer() );
			if ( magic && ! magic.every( ( b, i ) => bytes[ i ] === b ) ) throw new Error( `not a ${file.split( '.' ).pop()}: ${url}` );
			writeFileSync( `${file}.part`, bytes );
			renameSync( `${file}.part`, file );
			return true;

		} catch ( error ) {

			rmSync( `${file}.part`, { force: true } );
			if ( attempt === 3 ) throw error;
			await wait( attempt * 2000 );

		}

	}

}

async function main() {

	const { out, sizes, limit } = parseArgs( process.argv.slice( 2 ) );
	const [ materials, categories, tags, packages ] = await Promise.all( [ 'materials', 'categories', 'tags', 'packages' ].map( all ) );
	const items = buildCatalog( { materials, categories, tags, packages } ).slice( 0, limit );

	mkdirSync( join( out, 'previews' ), { recursive: true } );
	const jobs = [];
	for ( const item of items ) {

		if ( item.render ) jobs.push( [ `${API}/renders/${item.render}/download_thumbnail/`, join( out, item.preview ) ] );
		for ( const [ size, { id, path } ] of Object.entries( item.packages ) ) {

			if ( ! sizes.includes( size ) ) continue;
			mkdirSync( join( out, 'packages', item.id ), { recursive: true } );
			jobs.push( [ `${API}/packages/${id}/download/`, join( out, path ) ] );

		}

	}

	let done = 0, fetched = 0;
	const failed = [];
	await Promise.all( Array.from( { length: PARALLEL }, async () => {

		while ( jobs.length ) {

			const [ url, file ] = jobs.shift();
			try {

				if ( await download( url, file ) ) fetched ++;

			} catch ( error ) {

				failed.push( `${file}: ${error.message}` );

			}

			if ( ++ done % 50 === 0 ) console.log( `${done} files, ${fetched} downloaded` );

		}

	} ) );

	const catalog = catalogFrom( items, path => ( existsSync( join( out, path ) ) ? statSync( join( out, path ) ).size || null : null ) );
	writeFileSync( join( out, 'catalog.json' ), JSON.stringify( catalog ) );
	console.log( `${catalog.materials.length} of ${items.length} materials (${catalog.sizes.join( ', ' )}) in ${join( out, 'catalog.json' )}; ${fetched} files downloaded` );
	if ( failed.length ) {

		console.log( `failed:\n${failed.join( '\n' )}` );
		process.exitCode = 1;

	}

}

if ( import.meta.url === pathToFileURL( process.argv[ 1 ] ?? '' ).href ) main().catch( error => {

	console.error( error );
	process.exit( 1 );

} );
