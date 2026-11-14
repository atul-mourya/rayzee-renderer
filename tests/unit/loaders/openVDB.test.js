import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { readOpenVDB, bloscDecompress, volumeFromOpenVDB, upAxisOf } from '@/core/loaders/OpenVDB.js';
import { volumeSequenceFromOpenVDB } from '@/core/loaders/OpenVDBSequence.js';

// Written and read back by OpenVDB 13 (Blender 5.1): fixtures/vdb/make.py.
const fixture = ( name ) => readFileSync( new URL( `fixtures/vdb/${name}`, import.meta.url ) );

describe( 'OpenVDB files', () => {

	for ( const name of [ 'fog', 'half', 'affine', 'grids', 'mixed', 'mantaflow', 'seq_0004', 'fire_0003' ] ) {

		it( `reads ${name}.vdb as OpenVDB does`, () => {

			const file = readOpenVDB( fixture( `${name}.vdb` ) );
			const expected = JSON.parse( fixture( `${name}-openvdb.json` ) );
			expect( file.version ).toBeGreaterThanOrEqual( 224 );
			expect( file.grids.map( ( g ) => g.name ).sort() ).toEqual( expected.map( ( g ) => g.name ).sort() );

			for ( const want of expected ) {

				const grid = file.grids.find( ( g ) => g.name === want.name );
				expect( grid.valueType ).toBe( want.type );
				expect( grid.gridClass.replace( ' ', '' ).toLowerCase() ).toBe( want.class.replace( /[ _]/g, '' ).toLowerCase().replace( 'gridclass.', '' ) );
				[[ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ], [ 0, 0, 0 ]].forEach( ( p, i ) => {

					new Vector3( ...p ).applyMatrix4( grid.transform ).toArray().forEach( ( v, k ) => expect( v ).toBeCloseTo( want.indexToWorld[ i ][ k ], 6 ) );

				} );
				if ( ! want.box ) {

					expect( grid.scalar ).toBe( false );
					continue;

				}

				const dense = grid.toVolumeGrid();
				const [ lo, hi ] = want.box;
				expect( [ dense.width, dense.height, dense.depth ] ).toEqual( [ 0, 1, 2 ].map( ( k ) => hi[ k ] - lo[ k ] + 1 ) );
				// Dense ( 0, 0, 0 ) is the box's first voxel.
				new Vector3().applyMatrix4( dense.transform ).toArray().forEach( ( v, k ) => {

					expect( v ).toBeCloseTo( new Vector3( ...lo ).applyMatrix4( grid.transform ).getComponent( k ), 6 );

				} );

				let count = 0, sum = 0, weighted = 0;
				const at = ( i, j, k ) => dense.data[ i + dense.width * ( j + dense.height * k ) ];
				for ( let k = 0; k < dense.depth; k ++ ) for ( let j = 0; j < dense.height; j ++ ) for ( let i = 0; i < dense.width; i ++ ) {

					const v = at( i, j, k );
					if ( v === 0 ) continue;
					count ++;
					sum += v;
					weighted += v * ( ( 7 * i + 13 * j + 31 * k ) % 97 ) / 97;

				}

				expect( count ).toBe( want.count );
				expect( sum ).toBeCloseTo( want.sum, 3 );
				expect( weighted ).toBeCloseTo( want.weighted, 3 );
				for ( const [ i, j, k, v ] of want.sample ) expect( at( i, j, k ) ).toBeCloseTo( v, 5 );

			}

		} );

	}

	it( 'reads a run of frames as one volume, each frame as OpenVDB reads it, its slot and extent holding every frame', async () => {

		const names = [ 1, 2, 3, 4 ].map( ( n ) => `seq_000${n}` );
		const group = await volumeSequenceFromOpenVDB( names.map( ( n ) => async () => fixture( `${n}.vdb` ) ), { name: 'ball', fps: 12 } );
		const [ volume ] = group.children;
		const { sequence } = volume;
		expect( [ group.name, sequence.frameCount, sequence.duration, sequence.current ] ).toEqual( [ 'ball', 4, 4 / 12, 0 ] );

		const sumOf = ( grid ) => grid.data.reduce( ( a, b ) => a + b, 0 );
		const sums = [ sumOf( volume.grid ) ];
		for ( let k = 1; k < 4; k ++ ) {

			const shown = await sequence.seek( k / 12 );
			expect( shown.index ).toBe( k );
			volume.setFrame( shown.frame );
			sums.push( sumOf( volume.grid ) );
			[ volume.grid.width, volume.grid.height, volume.grid.depth ].forEach( ( n, a ) => expect( n ).toBeLessThanOrEqual( volume.reserve[ a ] ) );
			expect( volume.extent.containsBox( volume.grid.getBounds() ) ).toBe( true );
			// The frame sits where the file puts it: its first voxel at the box's first index.
			const box = JSON.parse( fixture( `${names[ k ]}-openvdb.json` ) )[ 0 ].box;
			const origin = new Vector3().applyMatrix4( volume.grid.transform ).toArray();
			origin.forEach( ( v, a ) => expect( v ).toBeCloseTo( box[ 0 ][ a ] * 0.1, 6 ) );

		}

		names.forEach( ( n, k ) => expect( sums[ k ] ).toBeCloseTo( JSON.parse( fixture( `${n}-openvdb.json` ) )[ 0 ].sum, 3 ) );

	} );

	it( 'reads a fire with no smoke as glow alone, stood upright when the file is Z-up', () => {

		const [ volume ] = volumeFromOpenVDB( fixture( 'fire_0003.vdb' ) ).children;
		const temperature = JSON.parse( fixture( 'fire_0003-openvdb.json' ) ).find( ( g ) => g.name === 'temperature' );
		expect( volume.grid.data.every( ( v ) => v === 0 ) ).toBe( true );
		expect( volume.emissionGrid.data.reduce( ( a, b ) => a + b, 0 ) ).toBeCloseTo( temperature.sum, 3 );
		// Its hottest voxel, 1.25, at 2500 K; Blender's fire (peak 2.98) keeps Blender's 1000 K a unit.
		expect( [ volume.blackbody, volume.temperature ] ).toEqual( [ true, 2000 ] );
		expect( volumeFromOpenVDB( fixture( 'mantaflow.vdb' ) ).children[ 0 ].temperature ).toBe( 1000 );
		// Blender and EmberGen name no creator and write Z-up; Houdini says so and writes Y-up.
		expect( [ upAxisOf( {} ), upAxisOf( { creator: 'Houdini 18.0.499/GEO_VDBTranslator' } ) ] ).toEqual( [ 'z', 'y' ] );
		// The file's Z, rising from index 0, is the world's Y.
		volume.updateMatrixWorld();
		const box = volume.getLocalBounds().applyMatrix4( volume.matrixWorld );
		[ box.min.toArray(), box.max.toArray() ].flat().forEach( ( v, k ) => expect( v ).toBeCloseTo( [ - 0.35, - 0.05, - 0.35, 0.35, 1.15, 0.35 ][ k ], 6 ) );

	} );

	it( 'plays a fire that starts unlit, opening on its first lit frame, read and placed for the frames to come', async () => {

		const group = await volumeSequenceFromOpenVDB( [ 1, 2, 3 ].map( ( n ) => async () => fixture( `fire_000${n}.vdb` ) ), { name: 'fire' } );
		const [ volume ] = group.children;
		const glow = ( k ) => JSON.parse( fixture( `fire_000${k + 1}-openvdb.json` ) ).find( ( g ) => g.name === 'temperature' ).sum ?? 0;
		const sum = ( grid ) => grid.data.reduce( ( a, b ) => a + b, 0 );
		expect( [ volume.sequence.current, volume.temperature, volume.rotation.x ] ).toEqual( [ 1, 2000, - Math.PI / 2 ] );
		expect( sum( volume.emissionGrid ) ).toBeCloseTo( glow( 1 ), 3 );
		expect( await volume.sequence.seek( 1 / 24 ) ).toBeNull();
		for ( const k of [ 2, 0 ] ) {

			volume.setFrame( ( await volume.sequence.seek( k / 24 ) ).frame );
			[ volume.grid.width, volume.grid.height, volume.grid.depth ].forEach( ( n, a ) => expect( n ).toBeLessThanOrEqual( volume.reserve[ a ] ) );
			expect( volume.extent.containsBox( volume.grid.getBounds() ) ).toBe( true );
			expect( sum( volume.emissionGrid ) ).toBeCloseTo( glow( k ), 3 );

		}

	} );

	it( 'halves a grid past its voxel budget into means that keep its sum', () => {

		const grid = readOpenVDB( fixture( 'fog.vdb' ) ).grids[ 0 ];
		const full = grid.toVolumeGrid();
		const half = grid.toVolumeGrid( { maxVoxels: full.data.length / 4 } );
		expect( half.width ).toBe( Math.ceil( full.width / 2 ) );
		const total = ( g ) => g.data.reduce( ( a, b ) => a + b, 0 );
		expect( total( half ) * 8 ).toBeCloseTo( total( full ), 2 );
		// Its first voxel's centre sits between the first two of the full grid's.
		const a = new Vector3().applyMatrix4( half.transform ), b = new Vector3( 0.5, 0.5, 0.5 ).applyMatrix4( full.transform );
		expect( a.distanceTo( b ) ).toBeLessThan( 1e-9 );

	} );

	it( 'unpacks a stored Blosc frame and refuses what is not one', () => {

		const payload = Uint8Array.from( { length: 40 }, ( _, i ) => i * 3 );
		const frame = new Uint8Array( 16 + payload.length );
		frame.set( [ 2, 1, 0x2, 4 ] );
		new DataView( frame.buffer ).setUint32( 4, payload.length, true );
		new DataView( frame.buffer ).setUint32( 8, payload.length, true );
		new DataView( frame.buffer ).setUint32( 12, frame.length, true );
		frame.set( payload, 16 );
		expect( Array.from( bloscDecompress( frame ) ) ).toEqual( Array.from( payload ) );
		expect( () => readOpenVDB( new Uint8Array( 64 ) ) ).toThrow( 'not an OpenVDB file' );

	} );

} );
