import { describe, it, expect } from 'vitest';
import { openTar } from '@/core/Processor/ArchiveReader.js';

const BLOCK = 512;
const enc = new TextEncoder();

/** Minimal ustar writer: enough to exercise the index. */
function makeTar( files ) {

	const blocks = [];
	for ( const { path, body } of files ) {

		const header = new Uint8Array( BLOCK );
		header.set( enc.encode( path ), 0 );
		header.set( enc.encode( '0000644\0' ), 100 ); // mode
		header.set( enc.encode( '0000000\0' ), 108 ); // uid
		header.set( enc.encode( '0000000\0' ), 116 ); // gid
		header.set( enc.encode( body.length.toString( 8 ).padStart( 11, '0' ) + '\0' ), 124 );
		header.set( enc.encode( '00000000000\0' ), 136 ); // mtime
		header[ 156 ] = 0x30; // type '0'
		header.set( enc.encode( 'ustar\0' ), 257 );
		header.set( enc.encode( '00' ), 263 );
		// checksum: spaces while summing, then the octal value
		header.set( enc.encode( '        ' ), 148 );
		let sum = 0;
		for ( const b of header ) sum += b;
		header.set( enc.encode( sum.toString( 8 ).padStart( 6, '0' ) + '\0 ' ), 148 );

		blocks.push( header );
		const padded = new Uint8Array( Math.ceil( body.length / BLOCK ) * BLOCK );
		padded.set( body );
		blocks.push( padded );

	}

	blocks.push( new Uint8Array( BLOCK * 2 ) ); // end marker

	let total = 0;
	for ( const b of blocks ) total += b.length;
	const out = new Uint8Array( total );
	let o = 0;
	for ( const b of blocks ) {

		out.set( b, o );
		o += b.length;

	}

	return out;

}

const FILES = [
	{ path: 'scene.pbrt', body: enc.encode( 'WorldBegin\nInclude "geo/a.ply"\n' ) },
	{ path: 'geo/a.ply', body: enc.encode( 'PLY-AAA'.repeat( 200 ) ) },
	{ path: 'geo/b.ply', body: enc.encode( 'PLY-BBB'.repeat( 500 ) ) },
	{ path: 'notes.txt', body: enc.encode( 'hello' ) },
];

const asBlob = bytes => new Blob( [ bytes ] );

describe( 'openTar', () => {

	it( 'indexes every entry while retaining none', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), { retain: () => false } );

		expect( tar.retainedBytes ).toBe( 0 );
		expect( Object.keys( tar.entries ) ).toHaveLength( 0 );
		expect( tar.indexed ).toBe( FILES.length );
		expect( tar.listing.map( e => e.path ) ).toEqual( FILES.map( f => f.path ) );

	} );

	it( 'reads any entry back byte-for-byte from the source', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), { retain: () => false } );

		for ( const f of FILES ) {

			const got = await tar.read( f.path );
			expect( got ).toBeInstanceOf( Uint8Array );
			expect( Array.from( got ) ).toEqual( Array.from( f.body ) );

		}

	} );

	it( 'reads correctly after a partial retain, mixing memory and seek', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), { retain: p => p.endsWith( '.pbrt' ) } );

		expect( Object.keys( tar.entries ) ).toEqual( [ 'scene.pbrt' ] );
		expect( tar.retainedBytes ).toBe( FILES[ 0 ].body.length );

		// retained one comes from memory, the rest from the source
		expect( Array.from( await tar.read( 'scene.pbrt' ) ) ).toEqual( Array.from( FILES[ 0 ].body ) );
		expect( Array.from( await tar.read( 'geo/b.ply' ) ) ).toEqual( Array.from( FILES[ 2 ].body ) );

	} );

	it( 'can be read repeatedly, so a file included twice still resolves', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), { retain: () => false } );
		const a = await tar.read( 'geo/a.ply' );
		const b = await tar.read( 'geo/a.ply' );
		expect( Array.from( b ) ).toEqual( Array.from( a ) );
		expect( b ).not.toBe( a ); // a fresh read each time, nothing cached

	} );

	it( 'returns null for a path that is not in the archive', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), { retain: () => false } );
		expect( await tar.read( 'missing.ply' ) ).toBeNull();

	} );

	it( 'honours filter: a skipped entry is neither retained nor indexed', async () => {

		const tar = await openTar( asBlob( makeTar( FILES ) ), {
			filter: p => p.endsWith( '.ply' ),
			retain: () => false,
		} );

		expect( tar.indexed ).toBe( 2 );
		expect( await tar.read( 'notes.txt' ) ).toBeNull();
		expect( Array.from( await tar.read( 'geo/b.ply' ) ) ).toEqual( Array.from( FILES[ 2 ].body ) );

	} );

} );
