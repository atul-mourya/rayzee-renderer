import { describe, it, expect } from 'vitest';
import { gzipSync } from 'three/addons/libs/fflate.module.js';
import {
	detectArchiveKind, isGzip, isZip, isTar,
	readTar, readTarGz, elementFilter, listArchiveElements, MAX_TEXT_ENTRY_BYTES
} from '@/core/Processor/ArchiveReader.js';

const enc = new TextEncoder();
const BLOCK = 512;

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

const text = bytes => new TextDecoder().decode( bytes );

describe( 'archive format detection', () => {

	it( 'tells gzip, zip and tar apart', () => {

		expect( isGzip( new Uint8Array( [ 0x1f, 0x8b, 8, 0 ] ) ) ).toBe( true );
		expect( isZip( enc.encode( 'PK\x03\x04' ) ) ).toBe( true );
		expect( detectArchiveKind( new Uint8Array( [ 0x1f, 0x8b, 8, 0 ] ) ) ).toBe( 'gzip' );
		expect( detectArchiveKind( enc.encode( 'PK\x03\x04' ) ) ).toBe( 'zip' );
		expect( detectArchiveKind( new Uint8Array( 8 ) ) ).toBe( null );

	} );

	it( 'recognises a bare tar by its ustar magic', () => {

		const tar = tarBlocks( [ { name: 'a.txt', text: 'hi' } ] );
		expect( isTar( tar ) ).toBe( true );
		expect( detectArchiveKind( tar ) ).toBe( 'tar' );

	} );

} );

describe( 'tar reading', () => {

	it( 'reads regular files, sizes and contents', async () => {

		const tar = tarBlocks( [
			{ name: 'scene.pbrt', text: 'WorldBegin' },
			{ name: 'geo/mesh.ply', text: 'ply-bytes' },
			{ name: 'dir/', type: '5' }
		] );

		const { entries, listing } = await readTar( tar );

		expect( listing.map( e => e.path ) ).toEqual( [ 'scene.pbrt', 'geo/mesh.ply' ] );
		expect( text( entries[ 'scene.pbrt' ] ) ).toBe( 'WorldBegin' );
		expect( text( entries[ 'geo/mesh.ply' ] ) ).toBe( 'ply-bytes' );
		expect( entries[ 'dir/' ] ).toBeUndefined();

	} );

	it( 'joins a ustar prefix onto the name', async () => {

		const tar = tarBlocks( [ { name: 'leaf.pbrt', prefix: 'deep/nested/path', text: 'x' } ] );
		const { entries } = await readTar( tar );
		expect( Object.keys( entries ) ).toEqual( [ 'deep/nested/path/leaf.pbrt' ] );

	} );

	it( 'follows a GNU long name', async () => {

		const long = 'a/'.repeat( 60 ) + 'final.pbrt';
		const tar = tarBlocks( [
			{ name: '././@LongLink', type: 'L', text: long },
			{ name: long.slice( 0, 99 ), text: 'body' }
		] );

		const { entries } = await readTar( tar );
		expect( text( entries[ long ] ) ).toBe( 'body' );

	} );

	it( 'follows a PAX path record', async () => {

		const long = 'pax/' + 'z'.repeat( 140 ) + '.ply';
		const record = `${( `path=${long}\n`.length + 4 )} path=${long}\n`;
		const tar = tarBlocks( [
			{ name: 'PaxHeader', type: 'x', text: record },
			{ name: 'placeholder.ply', text: 'pbody' }
		] );

		const { entries } = await readTar( tar );
		expect( text( entries[ long ] ) ).toBe( 'pbody' );

	} );

	it( 'reassembles a body split across pushed chunks', async () => {

		// 3 KB of content spans several 512-byte blocks and lands mid-chunk.
		const big = 'x'.repeat( 3000 );
		const tar = tarBlocks( [ { name: 'a', text: 'first' }, { name: 'big.txt', text: big }, { name: 'b', text: 'last' } ] );
		const { entries } = await readTar( tar );
		expect( text( entries[ 'big.txt' ] ) ).toBe( big );
		expect( text( entries[ 'b' ] ) ).toBe( 'last' );

	} );

} );

describe( 'selective retention', () => {

	const ARCHIVE = [
		{ name: 'root/scene.pbrt', text: 'WorldBegin' },
		{ name: 'root/materials.pbrt', text: 'MakeNamedMaterial "m"' },
		{ name: 'root/textures/sky.png', text: 'png' },
		{ name: 'root/elemA/elemA.pbrt', text: 'WorldBegin A' },
		{ name: 'root/elemA/geo.ply', text: 'A-geo' },
		{ name: 'root/elemB/elemB.pbrt', text: 'WorldBegin B' },
		{ name: 'root/elemB/big.ply', text: 'B-geo' }
	];

	it( 'keeps only what the filter asks for, but lists everything', async () => {

		const { entries, listing } = await readTar( tarBlocks( ARCHIVE ), {
			filter: path => path.endsWith( '.pbrt' )
		} );

		expect( listing ).toHaveLength( 7 );
		expect( Object.keys( entries ).sort() ).toEqual( [
			'root/elemA/elemA.pbrt', 'root/elemB/elemB.pbrt', 'root/materials.pbrt', 'root/scene.pbrt'
		] );

	} );

	it( 'element filter keeps the element, its ancestors and their textures', async () => {

		const { entries } = await readTar( tarBlocks( ARCHIVE ), { filter: elementFilter( 'root/elemA' ) } );

		expect( Object.keys( entries ).sort() ).toEqual( [
			'root/elemA/elemA.pbrt', 'root/elemA/geo.ply',
			'root/materials.pbrt', 'root/scene.pbrt', 'root/textures/sky.png'
		] );

	} );

	it( 'element filter keeps several elements at once', async () => {

		const { entries } = await readTar( tarBlocks( ARCHIVE ), {
			filter: elementFilter( [ 'root/elemA', 'root/elemB' ] )
		} );

		expect( Object.keys( entries ).sort() ).toEqual( [
			'root/elemA/elemA.pbrt', 'root/elemA/geo.ply',
			'root/elemB/big.ply', 'root/elemB/elemB.pbrt',
			'root/materials.pbrt', 'root/scene.pbrt', 'root/textures/sky.png'
		] );

	} );

	it( 'element filter given one prefix in an array matches the bare string', async () => {

		const asArray = await readTar( tarBlocks( ARCHIVE ), { filter: elementFilter( [ 'root/elemA' ] ) } );
		const asString = await readTar( tarBlocks( ARCHIVE ), { filter: elementFilter( 'root/elemA' ) } );

		expect( Object.keys( asArray.entries ).sort() ).toEqual( Object.keys( asString.entries ).sort() );

	} );

	it( 'element filter with nothing chosen keeps the whole archive', async () => {

		const { entries } = await readTar( tarBlocks( ARCHIVE ), { filter: elementFilter( [] ) } );

		expect( Object.keys( entries ) ).toHaveLength( ARCHIVE.length );

	} );

	it( 'stops retaining at the byte budget and says so', async () => {

		const { entries, listing, truncated } = await readTar( tarBlocks( ARCHIVE ), { byteBudget: 12 } );

		expect( truncated ).toBe( true );
		expect( listing ).toHaveLength( 7 );
		expect( Object.keys( entries ).length ).toBeLessThan( 7 );

	} );

	it( 'is not truncated when everything fits', async () => {

		const { truncated, retainedBytes } = await readTar( tarBlocks( ARCHIVE ) );
		expect( truncated ).toBe( false );
		expect( retainedBytes ).toBeGreaterThan( 0 );

	} );

} );

describe( 'gzip streaming', () => {

	it( 'reads a gzipped tar the same as a plain one', async () => {

		const tar = tarBlocks( [
			{ name: 'root/scene.pbrt', text: 'WorldBegin' },
			{ name: 'root/elemA/geo.ply', text: 'geo' }
		] );

		const plain = await readTar( tar );
		const zipped = await readTarGz( gzipSync( tar ) );

		expect( Object.keys( zipped.entries ).sort() ).toEqual( Object.keys( plain.entries ).sort() );
		expect( text( zipped.entries[ 'root/scene.pbrt' ] ) ).toBe( 'WorldBegin' );

	} );

	it( 'reports progress as bytes come through', async () => {

		const tar = tarBlocks( [ { name: 'a.pbrt', text: 'WorldBegin' } ] );
		let seen = 0;
		await readTarGz( gzipSync( tar ), { onProgress: p => ( seen = p.bytes ) } );
		expect( seen ).toBeGreaterThan( 0 );

	} );

} );

describe( 'element listing', () => {

	it( 'roots at the shallowest scene file and lists child scenes by size', () => {

		const { root, elements } = listArchiveElements( [
			{ path: 'is/pbrt/scene.pbrt', size: 100 },
			{ path: 'is/pbrt/materials.pbrt', size: 50 },
			{ path: 'is/pbrt/textures/sky.png', size: 900 },
			{ path: 'is/pbrt/big/big.pbrt', size: 10 },
			{ path: 'is/pbrt/big/a.ply', size: 5000 },
			{ path: 'is/pbrt/small/small.pbrt', size: 10 },
			{ path: 'is/pbrt/small/a.ply', size: 20 }
		] );

		expect( root ).toBe( 'is/pbrt' );
		expect( elements.map( e => e.name ) ).toEqual( [ 'small', 'big' ] );
		expect( elements[ 0 ].prefix ).toBe( 'is/pbrt/small' );
		expect( elements[ 1 ].bytes ).toBe( 5010 );

	} );

	it( 'ignores directories that hold no scene of their own', () => {

		const { elements } = listArchiveElements( [
			{ path: 'root/scene.pbrt', size: 10 },
			{ path: 'root/textures/a.png', size: 10 },
			{ path: 'root/el/el.pbrt', size: 10 }
		] );

		expect( elements.map( e => e.name ) ).toEqual( [ 'el' ] );

	} );

	it( 'returns nothing for an archive with no scene file', () => {

		expect( listArchiveElements( [ { path: 'a/b.ply', size: 1 } ] ) ).toEqual( { root: null, elements: [] } );

	} );

} );

describe( 'text entry limit', () => {

	it( 'sits at the largest string V8 will build', () => {

		expect( MAX_TEXT_ENTRY_BYTES ).toBe( 2 ** 29 - 24 );

	} );

} );
