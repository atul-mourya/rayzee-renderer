import { describe, it, expect } from 'vitest';
import { gzipSync } from 'three/addons/libs/fflate.module.js';
import { AssetLoader, ARCHIVE_ELEMENT_PROMPT_BYTES } from '@/core/Processor/AssetLoader.js';
import { IssueLog, ISSUE_CODES, EngineIssueError } from '@/core/EngineIssues.js';

const BLOCK = 512;
const enc = new TextEncoder();

/** Minimal ustar writer, enough to exercise the reader the way GNU tar would. */
function tarBlocks( entries ) {

	const blocks = [];

	const header = ( name, size, type, prefix = '' ) => {

		const h = new Uint8Array( BLOCK );
		h.set( enc.encode( name.slice( 0, 100 ) ), 0 );
		h.set( enc.encode( '0000644\0' ), 100 );
		h.set( enc.encode( '0000000\0' ), 108 );
		h.set( enc.encode( '0000000\0' ), 116 );
		h.set( enc.encode( size.toString( 8 ).padStart( 11, '0' ) + '\0' ), 124 );
		h.set( enc.encode( '00000000000\0' ), 136 );
		h[ 156 ] = type.charCodeAt( 0 );
		h.set( enc.encode( 'ustar\0' ), 257 );
		h.set( enc.encode( '00' ), 263 );
		if ( prefix ) h.set( enc.encode( prefix.slice( 0, 155 ) ), 345 );

		// Checksum: spaces in the field, then the octal sum.
		for ( let i = 148; i < 156; i ++ ) h[ i ] = 0x20;
		let sum = 0;
		for ( let i = 0; i < BLOCK; i ++ ) sum += h[ i ];
		h.set( enc.encode( sum.toString( 8 ).padStart( 6, '0' ) + '\0 ' ), 148 );
		return h;

	};

	const body = bytes => {

		const padded = new Uint8Array( Math.ceil( bytes.length / BLOCK ) * BLOCK );
		padded.set( bytes );
		return padded;

	};

	for ( const e of entries ) {

		const bytes = e.bytes ?? enc.encode( e.text ?? '' );
		blocks.push( header( e.name, bytes.length, e.type ?? '0', e.prefix ) );
		if ( bytes.length ) blocks.push( body( bytes ) );

	}

	blocks.push( new Uint8Array( BLOCK ), new Uint8Array( BLOCK ) );

	const total = blocks.reduce( ( n, b ) => n + b.length, 0 );
	const out = new Uint8Array( total );
	let off = 0;
	for ( const b of blocks ) {

		out.set( b, off ); off += b.length;

	}

	return out;

}


/** A listing shaped like a pbrt scene archive: a root scene file plus `n` element folders. */
function islandListing( n, bytesEach ) {

	const listing = [
		{ path: 'island.pbrt', size: 1000 },
		{ path: 'materials.pbrt', size: 1000 },
	];

	for ( let i = 0; i < n; i ++ ) {

		listing.push( { path: `isThing${i}/isThing${i}.pbrt`, size: 1000 } );
		listing.push( { path: `isThing${i}/geo.ply`, size: bytesEach } );

	}

	return listing;

}

const total = listing => listing.reduce( ( n, e ) => n + e.size, 0 );

describe( 'choosing parts of a large scene archive', () => {

	const loader = Object.create( AssetLoader.prototype );
	const ask = ( listing, promptBytes ) =>
		loader._requireElementChoice( 'island.tar', listing, total( listing ), promptBytes );

	it( 'asks which parts to load when the archive is large and has several', () => {

		const listing = islandListing( 15, 5e8 );

		let thrown = null;
		try {

			ask( listing );

		} catch ( error ) {

			thrown = error;

		}

		expect( thrown?.code ).toBe( 'ARCHIVE_NEEDS_ELEMENT' );
		expect( thrown.elements ).toHaveLength( 15 );
		expect( thrown.elements[ 0 ].prefix ).toBe( 'isThing0' );
		expect( thrown.totalBytes ).toBeGreaterThan( ARCHIVE_ELEMENT_PROMPT_BYTES );

	} );

	it( 'loads a small archive without asking, however many parts it has', () => {

		expect( () => ask( islandListing( 15, 1e6 ) ) ).not.toThrow();

	} );

	it( 'does not ask when there is nothing to choose between', () => {

		// One giant element: picking it is the same as loading everything.
		expect( () => ask( islandListing( 1, 9e9 ) ) ).not.toThrow();

	} );

	it( 'honours a caller-supplied threshold', () => {

		const listing = islandListing( 4, 1e6 );

		expect( () => ask( listing, 1e9 ) ).not.toThrow();
		expect( () => ask( listing, 1000 ) ).toThrow( /Choose which to load/ );

	} );

	it( 'still tells a strict host which parts it could choose', () => {

		// record() throws on its own in strict mode. Raising the refusal as an error there
		// replaced the typed one, so the host got no list and could not offer the choice.
		const strict = Object.create( AssetLoader.prototype );
		strict._issues = new IssueLog( { strict: true } );

		const listing = islandListing( 15, 5e8 );
		let thrown = null;
		try {

			strict._requireElementChoice( 'island.tar', listing, total( listing ) );

		} catch ( error ) {

			thrown = error;

		}

		expect( thrown ).not.toBeInstanceOf( EngineIssueError );
		expect( thrown?.code ).toBe( 'ARCHIVE_NEEDS_ELEMENT' );
		expect( thrown.elements ).toHaveLength( 15 );
		expect( strict._issues.list.map( e => e.code ) ).toContain( ISSUE_CODES.ASSET_ARCHIVE_TOO_LARGE );

	} );

} );

describe( 'reading a compressed archive that runs past the read budget', () => {

	/** A gzipped tar shaped like a scene archive: a root file and two element folders. */
	const island = () => gzipSync( tarBlocks( [
		{ name: 'island.pbrt', text: 'root' },
		{ name: 'isPalm/isPalm.pbrt', text: 'x'.repeat( 4096 ) },
		{ name: 'isBeach/isBeach.pbrt', text: 'y'.repeat( 4096 ) },
	] ) );

	const loader = () => {

		const l = Object.create( AssetLoader.prototype );
		l._issues = new IssueLog();
		return l;

	};

	it( 'stops and asks when nobody chose, and says which parts there are', async () => {

		let thrown = null;
		try {

			await loader()._readStreamedArchive( island(), 'island.tar.gz', 'gzip', null, 100 );

		} catch ( error ) {

			thrown = error;

		}

		expect( thrown?.code ).toBe( 'ARCHIVE_NEEDS_ELEMENT' );
		expect( thrown.elements.map( e => e.name ).sort() ).toEqual( [ 'isBeach', 'isPalm' ] );

	} );

	it( 'loads what was chosen even though it is past the budget', async () => {

		// Choosing every part is a valid answer to the question above. Re-applying the read
		// budget to the answer made that choice impossible to act on.
		const entries = await loader()._readStreamedArchive(
			island(), 'island.tar.gz', 'gzip', [ 'isPalm', 'isBeach' ], 100
		);

		expect( Object.keys( entries ) ).toContain( 'island.pbrt' );

	} );

} );
