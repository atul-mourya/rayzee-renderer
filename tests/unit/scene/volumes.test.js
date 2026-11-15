import { describe, it, expect } from 'vitest';
import { DataUtils, Group, Matrix4, Vector3, Box3 } from 'three';
import {
	Volume, VolumeGrid, collectVolumes, halveGrid, majorantGrid, packBoxes, packVolumes, writeVolumeHeaders, volumeUniformArray,
	expandByVolumes, unifyGrids,
} from '@/core/scene/Volumes.js';
import { VOLUME_LAYOUT } from '@/core/scene/BufferLayout.js';

const random = ( seed ) => () => ( ( seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0 ) / 4294967296 );

// Trilinear over voxel centres at index + 0.5 in grid space, zero past the grid: what the GPU reads.
const trilinear = ( { width: w, height: h, depth: d, data }, q ) => {

	const at = ( x, y, z ) => ( x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d ? 0 : data[ x + w * ( y + h * z ) ] );
	const [ x, y, z ] = q.map( ( v ) => v - 0.5 );
	const x0 = Math.floor( x ), y0 = Math.floor( y ), z0 = Math.floor( z );
	let v = 0;
	for ( let k = 0; k < 8; k ++ ) {

		const dx = k & 1, dy = ( k >> 1 ) & 1, dz = k >> 2;
		v += at( x0 + dx, y0 + dy, z0 + dz ) * ( dx ? x - x0 : 1 - x + x0 ) * ( dy ? y - y0 : 1 - y + y0 ) * ( dz ? z - z0 : 1 - z + z0 );

	}

	return v;

};

describe( 'volumes', () => {

	it( 'bounds every lookup inside a majorant cell by that cell', () => {

		const rand = random( 3 );
		const grid = new VolumeGrid( { width: 23, height: 17, depth: 9, data: Float32Array.from( { length: 23 * 17 * 9 }, () => ( rand() < 0.2 ? rand() * 5 : 0 ) ) } );
		for ( const cell of [ 1, 3, 4 ] ) {

			const m = majorantGrid( grid, cell );
			expect( [ m.width, m.height, m.depth ] ).toEqual( [ Math.ceil( 23 / cell ), Math.ceil( 17 / cell ), Math.ceil( 9 / cell ) ] );
			for ( let i = 0; i < 20000; i ++ ) {

				const q = [ rand() * 23, rand() * 17, rand() * 9 ];
				const c = q.map( ( v, a ) => Math.min( Math.floor( v / cell ), [ m.width, m.height, m.depth ][ a ] - 1 ) );
				expect( trilinear( grid, q ) ).toBeLessThanOrEqual( m.data[ c[ 0 ] + m.width * ( c[ 1 ] + m.height * c[ 2 ] ) ] + 1e-6 );

			}

		}

	} );

	it( 'halves a grid to the means of its voxels, where it was', () => {

		const grid = VolumeGrid.fromFunction( [ 5, 4, 3 ], ( x, y, z ) => 1 + x + 2 * y - z );
		const half = halveGrid( grid );
		expect( [ half.width, half.height, half.depth ] ).toEqual( [ 3, 2, 2 ] );
		expect( half.data[ 0 ] ).toBeCloseTo( [ 0, 1 ].flatMap( ( z ) => [ 0, 1 ].flatMap( ( y ) => [ 0, 1 ].map( ( x ) => grid.data[ x + 5 * ( y + 4 * z ) ] ) ) ).reduce( ( a, b ) => a + b ) / 8, 6 );
		expect( half.getBounds().min.toArray().map( ( v ) => + v.toFixed( 6 ) ) ).toEqual( grid.getBounds().min.toArray().map( ( v ) => + v.toFixed( 6 ) ) );

	} );

	it( 'packs boxes without overlap inside the limit', () => {

		const rand = random( 9 );
		const boxes = Array.from( { length: 40 }, () => [ 1 + Math.floor( rand() * 90 ), 1 + Math.floor( rand() * 60 ), 1 + Math.floor( rand() * 70 ) ] );
		const { size, origins } = packBoxes( boxes, 256 );
		expect( Math.max( ...size ) ).toBeLessThanOrEqual( 256 );
		boxes.forEach( ( b, i ) => {

			b.forEach( ( v, a ) => expect( origins[ i ][ a ] + v ).toBeLessThanOrEqual( size[ a ] ) );
			for ( let j = 0; j < i; j ++ ) {

				const apart = [ 0, 1, 2 ].some( ( a ) => origins[ i ][ a ] + b[ a ] <= origins[ j ][ a ] || origins[ j ][ a ] + boxes[ j ][ a ] <= origins[ i ][ a ] );
				expect( apart ).toBe( true );

			}

		} );

	} );

	it( 'packs voxels as half floats with a zero border, majorants rounded up, and emission beside them', () => {

		const rand = random( 5 );
		const density = new VolumeGrid( { width: 6, height: 5, depth: 4, data: Float32Array.from( { length: 120 }, () => rand() * 3 ) } );
		const emission = new VolumeGrid( { width: 6, height: 5, depth: 4, data: Float32Array.from( { length: 120 }, () => rand() ) } );
		const packed = packVolumes( [ new Volume( density, { emissionGrid: emission, emissionStrength: 1 } ) ] );
		expect( packed.channels ).toBe( 2 );
		const [ W, H ] = packed.size;
		const entry = packed.entries[ 0 ];
		const texel = ( x, y, z, c ) => DataUtils.fromHalfFloat( packed.data[ ( x + W * ( y + H * z ) ) * 2 + c ] );
		const [ gx, gy, gz ] = entry.atlas;
		expect( texel( gx - 1, gy, gz, 0 ) ).toBe( 0 );
		for ( let i = 0; i < 120; i ++ ) {

			const x = i % 6, y = Math.floor( i / 6 ) % 5, z = Math.floor( i / 30 );
			expect( texel( gx + x, gy + y, gz + z, 0 ) ).toBeCloseTo( density.data[ i ], 2 );
			expect( texel( gx + x, gy + y, gz + z, 1 ) ).toBeCloseTo( emission.data[ i ], 2 );

		}

		const m = majorantGrid( density, entry.cell );
		const [ mx, my, mz ] = entry.majorant;
		for ( let i = 0; i < m.data.length; i ++ ) {

			const x = i % m.width, y = Math.floor( i / m.width ) % m.height, z = Math.floor( i / ( m.width * m.height ) );
			expect( texel( mx + x, my + y, mz + z, 0 ) ).toBeGreaterThanOrEqual( m.data[ i ] );

		}

	} );

	it( 'resamples an emission grid of another box onto one covering both', () => {

		const density = VolumeGrid.fromFunction( 8, () => 1 );
		const heat = new VolumeGrid( { width: 4, height: 4, depth: 4, data: new Float32Array( 64 ).fill( 2 ), transform: density.transform.clone().multiply( new Matrix4().makeTranslation( 6, 2, 2 ) ) } );
		const { entries } = packVolumes( [ new Volume( density, { emissionGrid: heat, emissionStrength: 1 } ) ] );
		const { grid, emission } = entries[ 0 ];
		expect( grid.width ).toBe( 10 );
		const local = new Vector3( 7, 3, 3 ).applyMatrix4( density.transform );
		const index = local.applyMatrix4( grid.transform.clone().invert() ).round();
		expect( emission.data[ index.x + grid.width * ( index.y + grid.height * index.z ) ] ).toBeCloseTo( 2, 6 );
		expect( grid.data[ index.x + grid.width * ( index.y + grid.height * index.z ) ] ).toBe( 1 );

	} );

	it( 'keeps an emission that shows only with density on the density\'s box, however large its own', () => {

		const density = VolumeGrid.fromFunction( 8, () => 1 );
		const heat = new VolumeGrid( { width: 64, height: 64, depth: 64, data: new Float32Array( 64 ** 3 ).fill( 2 ), transform: density.transform.clone().multiply( new Matrix4().makeTranslation( - 28, - 28, - 28 ) ) } );
		const { grid, emission } = unifyGrids( density, heat, { grow: false } );
		expect( grid ).toBe( density );
		expect( [ emission.width, emission.height, emission.depth ] ).toEqual( [ 8, 8, 8 ] );
		expect( emission.data.every( ( v ) => Math.abs( v - 2 ) < 1e-6 ) ).toBe( true );
		expect( unifyGrids( density, heat ).grid.width ).toBe( 64 );

	} );

	it( 'keeps a sequence\'s room to grow within the texture, and refuses a box past it', () => {

		const volume = new Volume( VolumeGrid.fromFunction( [ 40, 8, 8 ], () => 1 ) );
		volume.reserve = [ 5000, 10, 10 ];
		const { size, entries } = packVolumes( [ volume ], { maxDimension: 64 } );
		expect( entries[ 0 ].slot ).toEqual( [ 62, 10, 10 ] );
		expect( size[ 0 ] ).toBeLessThanOrEqual( 64 );
		expect( () => packBoxes( [[ 65, 1, 1 ]], 64 ) ).toThrow( RangeError );

	} );

	it( 'halves the largest grids past the voxel budget, and says which', () => {

		const big = new Volume( VolumeGrid.fromFunction( 40, () => 1 ) );
		big.name = 'big';
		const small = new Volume( VolumeGrid.fromFunction( 8, () => 1 ) );
		const packed = packVolumes( [ big, small ], { maxVoxels: 20000 } );
		expect( packed.halved ).toEqual( [ 'big' ] );
		expect( packed.entries[ 0 ].grid.width ).toBe( 20 );
		expect( packed.entries[ 1 ].grid.width ).toBe( 8 );

	} );

	it( 'writes world → grid rows that put the grid where its object is', () => {

		const volume = new Volume( VolumeGrid.fromFunction( [ 10, 6, 4 ], () => 1 ), { density: 2, anisotropy: 0.4, color: 0x808080 } );
		volume.position.set( 1, 2, 3 );
		volume.rotation.set( 0.3, 1.1, - 0.2 );
		volume.scale.set( 2, 1, 3 );
		const parent = new Group().add( volume );
		parent.position.set( - 5, 0, 0 );
		const { entries } = packVolumes( [ volume ] );
		const out = volumeUniformArray();
		writeVolumeHeaders( out, entries );
		const toGrid = ( p ) => [ 0, 1, 2 ].map( ( r ) => out[ r ].x * p.x + out[ r ].y * p.y + out[ r ].z * p.z + out[ r ].w );
		const box = expandByVolumes( new Box3(), parent );
		const corners = [ box.min, box.max ];
		// The world box's centre maps to the grid's, and every corner of the grid's world box lies on or past its faces.
		const centre = toGrid( box.getCenter( new Vector3() ) );
		expect( centre.map( ( v ) => + v.toFixed( 4 ) ) ).toEqual( [ 5, 3, 2 ] );
		expect( corners.length ).toBe( 2 );
		expect( out[ 3 ].w ).toBe( 2 );
		expect( out[ 4 ].toArray() ).toEqual( [ 10, 6, 4, 0.4 ] );

		volume.visible = false;
		writeVolumeHeaders( out, entries );
		expect( out[ 3 ].w ).toBe( - 1 );
		volume.visible = true;
		parent.visible = false;
		writeVolumeHeaders( out, entries );
		expect( out[ 3 ].w ).toBe( - 1 );

	} );

	it( 'ramps blackbody emission with temperature, and colour emission with the grid', () => {

		const grid = VolumeGrid.fromFunction( 4, () => 1 );
		const fire = new Volume( grid, { emissionGrid: VolumeGrid.fromFunction( 4, () => 2 ), emissionStrength: 1, blackbody: true, temperature: 1000 } );
		const glow = new Volume( grid, { emissionGrid: VolumeGrid.fromFunction( 4, () => 2 ), emissionStrength: 3, emissionColor: 0xff0000 } );
		const { entries } = packVolumes( [ fire, glow ] );
		const out = volumeUniformArray();
		writeVolumeHeaders( out, entries );
		const { VEC4S, RAMP, MAX } = VOLUME_LAYOUT;
		const ramp = ( v, k ) => out[ MAX * VEC4S + v * RAMP + k ];
		expect( out[ 7 ].w ).toBeCloseTo( ( RAMP - 1 ) / 2, 6 );
		// Hotter is brighter and bluer.
		const warm = ramp( 0, RAMP / 2 ), hot = ramp( 0, RAMP - 1 );
		expect( hot.x + hot.y + hot.z ).toBeGreaterThan( 4 * ( warm.x + warm.y + warm.z ) );
		expect( hot.z / hot.x ).toBeGreaterThan( warm.z / warm.x );
		expect( ramp( 1, RAMP - 1 ).toArray() ).toEqual( [ 6, 0, 0, 0 ] );
		expect( ramp( 1, 0 ).toArray() ).toEqual( [ 0, 0, 0, 0 ] );

	} );

	it( 'is found under its parents, cloned with its grids shared', () => {

		const volume = new Volume( VolumeGrid.fromFunction( 4, () => 1 ), { density: 5, color: 0x336699 } );
		const root = new Group().add( new Group().add( volume ) );
		const copy = root.clone();
		const [ found ] = collectVolumes( copy );
		expect( found ).not.toBe( volume );
		expect( found.isVolume ).toBe( true );
		expect( found.grid ).toBe( volume.grid );
		expect( found.density ).toBe( 5 );
		expect( found.color.equals( volume.color ) ).toBe( true );

	} );

} );
