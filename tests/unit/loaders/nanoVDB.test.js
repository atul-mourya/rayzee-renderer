import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { readNanoVDB, isNanoVDB } from '@/core/loaders/NanoVDB.js';
import { readVDB, volumeFromOpenVDB } from '@/core/loaders/OpenVDB.js';
import { volumeSequenceFromOpenVDB } from '@/core/loaders/OpenVDBSequence.js';

// Written and read back by nanovdb itself. fog-zip by pbrt-v4's copy (ABI 32.3, "NanoVDB0"; make-pbrt.cpp): a fog
// sphere with constant tiles inside, over negative coordinates, and a temperature box, Zip. types-zip and density-raw
// by OpenVDB's (32.11: "NanoVDB2" files, "NanoVDB1" grids; make.cpp): a fog sphere as every scalar type, Zip, and a
// smaller one as a raw grid buffer.
const fixture = ( name ) => new Uint8Array( readFileSync( new URL( `fixtures/nanovdb/${name}`, import.meta.url ) ) );
const truth = ( name ) => JSON.parse( new TextDecoder().decode( fixture( `${name}-nanovdb.json` ) ) );
const FILE = fixture( 'fog-zip.nvdb' );
const NANOVDB = truth( 'fog-zip' );
const TYPES = truth( 'types-zip' );
const enc = new TextEncoder();

const valueAt = ( r, [ x, y, z ] ) => {

	const i = x - r.min[ 0 ], j = y - r.min[ 1 ], k = z - r.min[ 2 ];
	if ( i < 0 || j < 0 || k < 0 || i >= r.width || j >= r.height || k >= r.depth ) return null;
	return r.data[ i + r.width * ( j + r.height * k ) ];

};

// Every seeded voxel nanovdb read, inside the active box, equals ours; outside it the box leaves out nanovdb's 0.
function expectAsNanoVDB( grid, expected ) {

	const r = grid.read();
	expect( [ r.width, r.height, r.depth ] ).toEqual( expected.max.map( ( v, a ) => v - expected.min[ a ] + 1 ) );
	let inside = 0;
	for ( const [ x, y, z, value ] of expected.values ) {

		const ours = valueAt( r, [ x, y, z ] );
		if ( ours === null ) expect( value ).toBe( 0 );
		else {

			expect( ours ).toBe( Math.fround( value ) );
			inside ++;

		}

	}

	expect( inside ).toBeGreaterThan( expected.values.length / 2 );
	const m = expected.matrix;
	expect( r.matrix.equals( new Matrix4().set( m[ 0 ], m[ 1 ], m[ 2 ], m[ 9 ], m[ 3 ], m[ 4 ], m[ 5 ], m[ 10 ], m[ 6 ], m[ 7 ], m[ 8 ], m[ 11 ], 0, 0, 0, 1 ) ) ).toBe( true );
	return r;

}

const concat = ( parts ) => {

	const out = new Uint8Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
	let o = 0;
	for ( const p of parts ) {

		out.set( p, o );
		o += p.length;

	}

	return out;

};

// Grids back to back as a raw buffer holds them (GridHandle::write), each saying which of how many it is.
function rawBuffer( grids ) {

	return concat( grids.map( ( grid, i ) => {

		const bytes = grid.buffer().slice();
		const view = new DataView( bytes.buffer );
		view.setUint32( 24, i, true );
		view.setUint32( 28, grids.length, true );
		return bytes;

	} ) );

}

// A Blosc frame holding its bytes as they are (memcpyed), as c-blosc writes data it cannot shrink.
function bloscStored( bytes ) {

	const frame = new Uint8Array( 16 + bytes.length );
	const view = new DataView( frame.buffer );
	frame.set( [ 2, 1, 0x2, 4 ] );
	view.setUint32( 4, bytes.length, true );
	view.setUint32( 8, bytes.length, true );
	view.setUint32( 12, frame.length, true );
	frame.set( bytes, 16 );
	const out = new Uint8Array( 8 + frame.length );
	new DataView( out.buffer ).setBigUint64( 0, BigInt( frame.length ), true );
	out.set( frame, 8 );
	return out;

}

function metaOf( name ) {

	// Metadata records follow the header back to back, each with its name.
	const view = new DataView( FILE.buffer, FILE.byteOffset );
	let at = 16;
	for ( let i = 0; i < view.getUint16( 12, true ); i ++ ) {

		const size = view.getUint32( at + 136, true );
		if ( new TextDecoder().decode( FILE.subarray( at + 176, at + 176 + size - 1 ) ) === name ) return FILE.slice( at, at + 176 );
		at += 176 + size;

	}

	throw new Error( name );

}

// The same grids, each in a segment of its own, raw (codec 0) or in a Blosc frame (codec 2).
function rawSegments( codec = 0 ) {

	const parts = [];
	for ( const grid of readNanoVDB( FILE ).grids ) {

		const buffer = codec === 2 ? bloscStored( grid.buffer() ) : grid.buffer();
		const name = enc.encode( grid.name + '\0' );
		const head = new Uint8Array( 16 + 176 + name.length );
		head.set( FILE.subarray( 0, 16 ) );
		const view = new DataView( head.buffer );
		view.setUint16( 12, 1, true );
		view.setUint16( 14, codec, true );
		// Its metadata as the file wrote it, the stored size and codec made these.
		head.set( metaOf( grid.name ), 16 );
		view.setBigUint64( 16 + 8, BigInt( buffer.length ), true );
		view.setUint16( 16 + 168, codec, true );
		head.set( name, 16 + 176 );
		parts.push( head, buffer );

	}

	return concat( parts );

}

const sum = ( data ) => data.reduce( ( s, v ) => s + v, 0 );

describe( 'NanoVDB files', () => {

	it( 'lists a file\'s grids as nanovdb does, pbrt-v4\'s and OpenVDB 12\'s', () => {

		const { grids } = readNanoVDB( FILE );
		expect( grids.map( ( g ) => [ g.name, g.valueType, g.gridClass, g.voxelCount ] ) ).toEqual( [
			[ 'density', 'float', 'fog volume', NANOVDB.density.voxels ],
			[ 'temperature', 'float', 'unknown', NANOVDB.temperature.voxels ], // GridBuilder writes no class; pbrt takes either
		] );
		expect( grids[ 0 ].recordedBox ).toEqual( { min: NANOVDB.density.min, max: NANOVDB.density.max } );
		expect( String.fromCharCode( ...fixture( 'types-zip.nvdb' ).subarray( 0, 8 ) ) ).toBe( 'NanoVDB2' );
		expect( readNanoVDB( fixture( 'types-zip.nvdb' ) ).grids.map( ( g ) => [ g.name, g.valueType, g.gridClass, g.voxelCount, g.scalar ] ) )
			.toEqual( Object.entries( TYPES ).map( ( [ name, t ] ) => [ name, name, 'fog volume', t.voxels, true ] ) );

	} );

	it( 'reads every voxel nanovdb\'s getValue reads, tiles and negative coordinates included', () => {

		expect( NANOVDB.density.lowerTiles ).toBeGreaterThan( 0 );
		for ( const grid of readNanoVDB( FILE ).grids ) expectAsNanoVDB( grid, NANOVDB[ grid.name ] );

	} );

	it( 'reads float, double, half and quantised grids as nanovdb\'s getValue reads them, bit for bit', () => {

		const grids = readNanoVDB( fixture( 'types-zip.nvdb' ) ).grids;
		const reads = Object.fromEntries( grids.map( ( grid ) => [ grid.name, expectAsNanoVDB( grid, TYPES[ grid.name ] ) ] ) );
		// The quantised grids are read as their codes say, not as the floats they came from.
		for ( const name of [ 'fp4', 'fp8', 'fp16', 'fpN' ] ) {

			expect( reads[ name ].data ).not.toEqual( reads.float.data );
			expect( Math.max( ...reads[ name ].data.map( ( v, i ) => Math.abs( v - reads.float.data[ i ] ) ) ) ).toBeLessThan( name === 'fp4' ? 0.04 : 0.01 );

		}

		expect( grids.find( ( g ) => g.name === 'fp4' ).maxValue() ).toBe( Math.max( ...reads.fp4.data ) );

	} );

	it( 'reads a raw grid buffer, one grid or several, under either magic number', () => {

		const raw = fixture( 'density-raw.nvdb' );
		const expected = truth( 'density-raw' ).density;
		const read = ( bytes ) => readNanoVDB( bytes ).grids.map( ( g ) => [ g.name, g.recordedBox ] );
		expect( read( raw ) ).toEqual( [[ 'density', { min: expected.min, max: expected.max } ]] );
		const data = expectAsNanoVDB( readNanoVDB( raw ).grids[ 0 ], expected ).data;

		// 32.6 wrote a grid "NanoVDB0" with "NanoVDB1" at its end; before, "NanoVDB0" alone, told from a file by its fields.
		for ( const tail of [ 'NanoVDB1', '\0\0\0\0\0\0\0\0' ] ) {

			const old = raw.slice();
			old.set( enc.encode( 'NanoVDB0' ), 0 );
			old.set( enc.encode( tail ), 664 );
			expect( readNanoVDB( old ).grids[ 0 ].read().data ).toEqual( data );

		}

		const both = rawBuffer( readNanoVDB( FILE ).grids );
		const zipped = readNanoVDB( FILE ).grids;
		const grids = readNanoVDB( both ).grids;
		expect( grids.map( ( g ) => g.name ) ).toEqual( [ 'density', 'temperature' ] );
		grids.forEach( ( grid, i ) => expect( grid.read().data ).toEqual( zipped[ i ].read().data ) );
		expect( () => readNanoVDB( raw.subarray( 0, 1000 ) ) ).toThrow( /ends at byte 1000/ );

	} );

	it( 'reads raw and Blosc grids in segments of their own as the zipped ones', () => {

		const zipped = readNanoVDB( FILE ).grids;
		expect( () => readNanoVDB( rawSegments( 2 ) ).grids[ 0 ].read() ).toThrow( /Blosc-compressed and no Blosc reader was given/ );
		for ( const codec of [ 0, 2 ] ) {

			const grids = readVDB( rawSegments( codec ) ).grids;
			expect( grids.map( ( g ) => g.name ) ).toEqual( [ 'density', 'temperature' ] );
			for ( let i = 0; i < 2; i ++ ) expect( grids[ i ].read().data ).toEqual( zipped[ i ].read().data );

		}

		// A frame of the wrong size is refused, as nanovdb refuses it.
		const short = rawSegments( 2 );
		const view = new DataView( short.buffer );
		const sizeAt = 16 + 176 + 'density'.length + 1 + 8 + 4;
		view.setUint32( sizeAt, view.getUint32( sizeAt, true ) - 4, true );
		expect( () => readVDB( short ).grids[ 0 ].read() ).toThrow( /inflates to \d+ bytes, \d+ expected/ );

	} );

	it( 'places a voxel\'s centre through its map', () => {

		const volumeGrid = readNanoVDB( FILE ).grids[ 0 ].toVolumeGrid();
		const { min } = NANOVDB.density;
		const m = NANOVDB.density.matrix;
		// Dense voxel ( 2, 3, 4 ) is nanovdb's min + ( 2, 3, 4 ): world = M · ijk + t.
		const ijk = [ min[ 0 ] + 2, min[ 1 ] + 3, min[ 2 ] + 4 ];
		const world = new Vector3( ...[ 0, 1, 2 ].map( ( r ) => m[ r * 3 ] * ijk[ 0 ] + m[ r * 3 + 1 ] * ijk[ 1 ] + m[ r * 3 + 2 ] * ijk[ 2 ] + m[ 9 + r ] ) );
		expect( new Vector3( 2, 3, 4 ).applyMatrix4( volumeGrid.transform ).distanceTo( world ) ).toBeLessThan( 1e-12 );

	} );

	it( 'reads past a voxel budget as the mean of f³ voxels, each value where its block\'s centre is', () => {

		const grid = readNanoVDB( FILE ).grids[ 0 ];
		const full = grid.read();
		// Every coarse voxel, the constant tiles inside the sphere included, at two factors.
		for ( const [ maxVoxels, factor ] of [[ 3000, 4 ], [ 40000, 2 ]] ) {

			const coarse = grid.read( { maxVoxels } );
			expect( coarse.factor ).toBe( factor );
			const f = factor;
			expect( [ coarse.width, coarse.height, coarse.depth ] ).toEqual( [ full.width, full.height, full.depth ].map( ( v ) => Math.ceil( v / f ) ) );
			let worst = 0;
			for ( let k = 0; k < coarse.depth; k ++ ) for ( let j = 0; j < coarse.height; j ++ ) for ( let i = 0; i < coarse.width; i ++ ) {

				let total = 0;
				for ( let z = k * f; z < k * f + f; z ++ ) for ( let y = j * f; y < j * f + f; y ++ ) for ( let x = i * f; x < i * f + f; x ++ ) {

					if ( x < full.width && y < full.height && z < full.depth ) total += full.data[ x + full.width * ( y + full.height * z ) ];

				}

				worst = Math.max( worst, Math.abs( coarse.data[ i + coarse.width * ( j + coarse.height * k ) ] - total / f ** 3 ) );

			}

			expect( worst ).toBeLessThan( 1e-5 );

		}

		// A coarse voxel's centre is the centre of its block; a factor asked for is kept.
		const f = 4;
		const block = grid.toVolumeGrid( { maxVoxels: 3000 } );
		const fine = grid.toVolumeGrid();
		const a = new Vector3( 2, 3, 4 ).applyMatrix4( block.transform ), b = new Vector3( 2 * f + 1.5, 3 * f + 1.5, 4 * f + 1.5 ).applyMatrix4( fine.transform );
		expect( a.distanceTo( b ) ).toBeLessThan( 1e-12 );
		expect( grid.read( { maxSide: 16 } ).factor ).toBe( 4 );
		expect( grid.read( { factor: 2 } ).factor ).toBe( 2 );

	} );

	it( 'refuses what it cannot read', () => {

		expect( () => readNanoVDB( enc.encode( 'NotNanoVDB-------' ) ) ).toThrow( /not a NanoVDB file/ );
		expect( () => readNanoVDB( FILE.subarray( 0, 100 ) ) ).toThrow( /ends at byte 100/ );
		const old = FILE.slice();
		new DataView( old.buffer ).setUint32( 8, 31 << 21, true );
		expect( () => readNanoVDB( old ) ).toThrow( /version 31/ );
		// A vector grid is listed, and left out where scalars are read.
		const vector = FILE.slice();
		new DataView( vector.buffer ).setUint32( 16 + 32, 6, true );
		const grid = readNanoVDB( vector ).grids[ 0 ];
		expect( [ grid.valueType, grid.scalar ] ).toEqual( [ 'vec3f', false ] );
		expect( () => grid.read() ).toThrow( /holds vec3f values; scalar grids only/ );
		// A grid whose own header disagrees with its file's metadata.
		const mismatch = FILE.slice();
		new DataView( mismatch.buffer ).setUint32( 16 + 32, 2, true );
		expect( () => readNanoVDB( mismatch ).grids[ 0 ].read() ).toThrow( /is a float grid where its file says double/ );

	} );

	it( 'opens as a volume as an OpenVDB file does: the density, a temperature glowing as a black body, kept Y-up', () => {

		expect( [ isNanoVDB( FILE ), isNanoVDB( fixture( 'density-raw.nvdb' ) ), isNanoVDB( enc.encode( ' BDV\0\0\0\0' ) ) ] ).toEqual( [ true, true, false ] );
		const [ volume ] = volumeFromOpenVDB( FILE, { name: 'fog.nvdb' } ).children;
		const [ density, temperature ] = readNanoVDB( FILE ).grids;
		expect( [ volume.name, volume.grid.name, volume.emissionGrid.name, volume.blackbody ] ).toEqual( [ 'fog.nvdb', 'density', 'temperature', true ] );
		expect( sum( volume.grid.data ) ).toBeCloseTo( sum( density.read().data ), 1 );
		// Its hottest voxel, 3 + 0.25 · 9 + 0.1 · 12² + 0.05 · 8, would be 20,050 K at Blender's 1000 K a unit: 4500 K.
		const peak = temperature.maxValue();
		expect( peak ).toBe( Math.max( ...temperature.read().data ) );
		expect( peak ).toBeCloseTo( 20.05, 5 );
		expect( volume.temperature * peak ).toBeCloseTo( 4500, 6 );
		// A NanoVDB file names no creator; those in circulation are Houdini's, Y-up, as the engine is.
		expect( volume.rotation.x ).toBe( 0 );

	} );

	it( 'plays numbered frames as one volume, zipped and raw alike', async () => {

		const frames = [ FILE, rawBuffer( readNanoVDB( FILE ).grids ), FILE ];
		const group = await volumeSequenceFromOpenVDB( frames.map( ( bytes ) => async () => bytes ), { name: 'fog', fps: 10 } );
		const [ volume ] = group.children;
		const first = [ sum( volume.grid.data ), sum( volume.emissionGrid.data ) ];
		expect( [ volume.sequence.frameCount, volume.blackbody ] ).toEqual( [ 3, true ] );
		for ( let k = 1; k < 3; k ++ ) {

			volume.setFrame( ( await volume.sequence.seek( k / 10 ) ).frame );
			expect( [ sum( volume.grid.data ), sum( volume.emissionGrid.data ) ] ).toEqual( first );
			expect( volume.extent.containsBox( volume.grid.getBounds() ) ).toBe( true );

		}

	} );

} );
