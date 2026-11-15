import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { readNanoVDB, bloscReader } from '@/core/addons/archives/pbrt/NanoVDB.js';
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';
import { peakBlackbodyRGB } from '@/core/addons/archives/pbrt/PBRTMaterials.js';
import { encodeSceneGraph, SceneGraphUnsupported } from '@/core/addons/archives/SceneGraphCodec.js';

// Written and read back by nanovdb itself (fixtures/nanovdb/make.cpp): a fog sphere with constant tiles inside, over
// negative coordinates, and a temperature box, Zip.
const DIR = new URL( './fixtures/nanovdb/', import.meta.url );
const FILE = new Uint8Array( readFileSync( new URL( 'fog-zip.nvdb', DIR ) ) );
const NANOVDB = JSON.parse( readFileSync( new URL( 'fog-zip-nanovdb.json', DIR ), 'utf8' ) );
const enc = new TextEncoder();

const valueAt = ( r, [ x, y, z ] ) => {

	const i = x - r.min[ 0 ], j = y - r.min[ 1 ], k = z - r.min[ 2 ];
	if ( i < 0 || j < 0 || k < 0 || i >= r.width || j >= r.height || k >= r.depth ) return null;
	return r.data[ i + r.width * ( j + r.height * k ) ];

};

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

	const out = new Uint8Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
	let o = 0;
	for ( const p of parts ) {

		out.set( p, o );
		o += p.length;

	}

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

describe( 'NanoVDB reader', () => {

	it( 'lists a file\'s grids as nanovdb does', () => {

		const { grids } = readNanoVDB( FILE );
		expect( grids.map( ( g ) => [ g.name, g.type, g.gridClass, g.voxelCount ] ) ).toEqual( [
			[ 'density', 'float', 'fog volume', NANOVDB.density.voxels ],
			[ 'temperature', 'float', 'unknown', NANOVDB.temperature.voxels ], // GridBuilder writes no class; pbrt takes either
		] );
		expect( grids[ 0 ].indexBox ).toEqual( { min: NANOVDB.density.min, max: NANOVDB.density.max } );

	} );

	it( 'reads every voxel nanovdb\'s getValue reads, tiles and negative coordinates included', () => {

		expect( NANOVDB.density.lowerTiles ).toBeGreaterThan( 0 );
		for ( const grid of readNanoVDB( FILE ).grids ) {

			const r = grid.read();
			const truth = NANOVDB[ grid.name ];
			expect( [ r.width, r.height, r.depth ] ).toEqual( truth.max.map( ( v, a ) => v - truth.min[ a ] + 1 ) );
			let inside = 0;
			for ( const [ x, y, z, value ] of truth.values ) {

				const ours = valueAt( r, [ x, y, z ] );
				// Past the active box nanovdb holds the background, which the box leaves out.
				if ( ours === null ) expect( value ).toBe( 0 );
				else {

					expect( ours ).toBe( Math.fround( value ) );
					inside ++;

				}

			}

			expect( inside ).toBeGreaterThan( truth.values.length / 2 );
			const m = truth.matrix;
			expect( r.matrix.equals( new Matrix4().set( m[ 0 ], m[ 1 ], m[ 2 ], m[ 9 ], m[ 3 ], m[ 4 ], m[ 5 ], m[ 10 ], m[ 6 ], m[ 7 ], m[ 8 ], m[ 11 ], 0, 0, 0, 1 ) ) ).toBe( true );

		}

	} );

	it( 'reads raw and Blosc grids in segments of their own as the zipped ones', async () => {

		const zipped = readNanoVDB( FILE ).grids;
		const blosc = await bloscReader();
		expect( readNanoVDB( rawSegments( 2 ) ).blosc ).toBe( true );
		expect( () => readNanoVDB( rawSegments( 2 ) ).grids[ 0 ].read() ).toThrow( /Blosc-compressed and no Blosc reader was given/ );
		for ( const codec of [ 0, 2 ] ) {

			const grids = readNanoVDB( rawSegments( codec ), { blosc } ).grids;
			expect( grids.map( ( g ) => g.name ) ).toEqual( [ 'density', 'temperature' ] );
			for ( let i = 0; i < 2; i ++ ) expect( grids[ i ].read().data ).toEqual( zipped[ i ].read().data );

		}

		// A frame of the wrong size is refused, as nanovdb refuses it.
		const short = rawSegments( 2 );
		const view = new DataView( short.buffer );
		const sizeAt = 16 + 176 + 'density'.length + 1 + 8 + 4;
		view.setUint32( sizeAt, view.getUint32( sizeAt, true ) - 4, true );
		expect( () => readNanoVDB( short, { blosc } ).grids[ 0 ].read() ).toThrow( /inflates to \d+ bytes, \d+ expected/ );

	} );

	it( 'places a voxel\'s centre through its map and the given parent', () => {

		const grid = readNanoVDB( FILE ).grids[ 0 ];
		const parent = new Matrix4().makeRotationX( Math.PI / 2 ).premultiply( new Matrix4().makeScale( 1, 1, 1.6 ) );
		const volumeGrid = grid.toVolumeGrid( parent );
		const { min } = NANOVDB.density;
		const m = NANOVDB.density.matrix;
		// Dense voxel ( 2, 3, 4 ) is nanovdb's min + ( 2, 3, 4 ): world = M · ijk + t, then the parent.
		const ijk = [ min[ 0 ] + 2, min[ 1 ] + 3, min[ 2 ] + 4 ];
		const world = new Vector3( ...[ 0, 1, 2 ].map( ( r ) => m[ r * 3 ] * ijk[ 0 ] + m[ r * 3 + 1 ] * ijk[ 1 ] + m[ r * 3 + 2 ] * ijk[ 2 ] + m[ 9 + r ] ) ).applyMatrix4( parent );
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

				let sum = 0;
				for ( let z = k * f; z < k * f + f; z ++ ) for ( let y = j * f; y < j * f + f; y ++ ) for ( let x = i * f; x < i * f + f; x ++ ) {

					if ( x < full.width && y < full.height && z < full.depth ) sum += full.data[ x + full.width * ( y + full.height * z ) ];

				}

				worst = Math.max( worst, Math.abs( coarse.data[ i + coarse.width * ( j + coarse.height * k ) ] - sum / f ** 3 ) );

			}

			expect( worst ).toBeLessThan( 1e-5 );

		}

		const f = 4;

		// A coarse voxel's centre is the centre of its block.
		const block = grid.toVolumeGrid( new Matrix4(), { maxVoxels: 3000 } );
		const fine = grid.toVolumeGrid();
		const a = new Vector3( 2, 3, 4 ).applyMatrix4( block.transform ), b = new Vector3( 2 * f + 1.5, 3 * f + 1.5, 4 * f + 1.5 ).applyMatrix4( fine.transform );
		expect( a.distanceTo( b ) ).toBeLessThan( 1e-12 );
		expect( grid.read( { maxSide: 16 } ).factor ).toBe( 4 );

	} );

	it( 'refuses what it cannot read', () => {

		expect( () => readNanoVDB( enc.encode( 'NotNanoVDB-------' ) ) ).toThrow( /no file header/ );
		expect( () => readNanoVDB( FILE.subarray( 0, 100 ) ) ).toThrow( /ends at byte 100/ );
		const old = FILE.slice();
		new DataView( old.buffer ).setUint32( 8, 31 << 21, true );
		expect( () => readNanoVDB( old ) ).toThrow( /version 31/ );
		const double = FILE.slice();
		new DataView( double.buffer ).setUint32( 16 + 32, 2, true );
		const grid = readNanoVDB( double ).grids[ 0 ];
		expect( grid.type ).toBe( 'double' );
		expect( () => grid.read() ).toThrow( /double grid \(float grids only\)/ );

	} );

} );

const scene = ( media, shapes ) => enc.encode( `LookAt 0 0 30  0 0 0  0 1 0\nCamera "perspective" "float fov" 40\nWorldBegin\n${media}\n${shapes}\n` +
	'Material "diffuse"\nShape "trianglemesh" "point3 P" [ -50 -20 -50 50 -20 -50 0 -20 50 ] "integer indices" [ 0 1 2 ]\n' );

const volumesOf = ( group ) => {

	const out = [];
	group.traverse( ( o ) => o.isVolume && out.push( o ) );
	return out;

};

const meshesOf = ( group ) => {

	const out = [];
	group.traverse( ( o ) => o.isMesh && out.push( o ) );
	return out;

};

const SMOKE = 'MakeNamedMedium "smoke" "string type" "nanovdb" "string filename" "fog.nvdb" "rgb sigma_a" [ 1 1 1 ] ' +
	'"rgb sigma_s" [ 3 3 3 ] "float g" 0.4 "float Lescale" 2 "float temperaturecutoff" 1 "float temperaturescale" 500';
const inSphere = ( radius ) => `AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nShape "sphere" "float radius" ${radius}\nAttributeEnd`;
const load = ( text, files = {} ) => loadPBRTScene( { vfs: { 'scene.pbrt': text, 'fog.nvdb': FILE, ...files }, plyParser: () => null, imageFromBytes: async () => null } );

describe( 'pbrt\'s blackbody as its film reads it', () => {

	// Independent of the engine's tables: Planck's curve over its peak, Wyman, Sloan and Shirley's fit of the CIE 1931
	// functions (JCGT 2013), then XYZ → linear Rec.709. pbrt's film integrates x̄ȳz̄ × L without dividing by ∫ȳ
	// (film.h, PixelSensor::ToSensorRGB): a blackbody at peak 1 reads ~100, which scenes' Lescale is set against.
	const lobe = ( l, mu, s1, s2 ) => Math.exp( - 0.5 * ( ( l - mu ) / ( l < mu ? s1 : s2 ) ) ** 2 );
	const cie = ( l ) => [
		1.056 * lobe( l, 599.8, 37.9, 31.0 ) + 0.362 * lobe( l, 442.0, 16.0, 26.7 ) - 0.065 * lobe( l, 501.1, 20.4, 26.2 ),
		0.821 * lobe( l, 568.8, 46.9, 40.5 ) + 0.286 * lobe( l, 530.9, 16.3, 31.1 ),
		1.217 * lobe( l, 437.0, 11.8, 36.0 ) + 0.681 * lobe( l, 459.0, 26.0, 13.8 ),
	];
	const reference = ( kelvin ) => {

		const planck = ( l ) => 1 / ( l ** 5 * Math.expm1( 1.4387769e7 / ( l * kelvin ) ) );
		const peak = planck( 2.8977721e6 / kelvin );
		const xyz = [ 0, 0, 0 ];
		for ( let l = 360; l <= 830; l ++ ) cie( l ).forEach( ( w, k ) => ( xyz[ k ] += w * planck( l ) / peak ) );
		const [ X, Y, Z ] = xyz;
		return [ 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, - 0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z ];

	};

	it.each( [ 1500, 3000, 6500, 12000 ] )( 'at %i K', ( kelvin ) => {

		const ours = peakBlackbodyRGB( kelvin ), theirs = reference( kelvin );
		const luminance = ( c ) => 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
		expect( luminance( ours ) / luminance( theirs ) ).toBeCloseTo( 1, 1 );
		// The fit is good to a few per cent; negative (out of gamut) channels are clipped.
		for ( let c = 0; c < 3; c ++ ) expect( Math.abs( ours[ c ] - Math.max( 0, theirs[ c ] ) ) ).toBeLessThan( 0.05 * Math.max( ...theirs ) );

	} );

} );

describe( 'pbrt grid media as volumes', () => {

	it( 'reads a nanovdb medium as pbrt shades it, and builds no surface for its interface', async () => {

		const { group, parameters, warnings } = await load( scene( SMOKE, inSphere( 100 ) ) );
		const [ volume ] = volumesOf( group );
		expect( volumesOf( group ) ).toHaveLength( 1 );
		expect( meshesOf( group ) ).toHaveLength( 1 ); // the floor; the sphere bounds the medium and is not drawn
		expect( volume.density ).toBeCloseTo( 4, 6 );
		expect( volume.color.toArray().map( ( c ) => Number( c.toFixed( 6 ) ) ) ).toEqual( [ 0.75, 0.75, 0.75 ] );
		expect( volume.anisotropy ).toBe( 0.4 );
		expect( volume.emissionFromAbsorption ).toBe( true );
		// Le = Lescale × the blackbody peaking at 1, at ( value − cutoff ) × scale; none at 100 K and below.
		expect( volume.emissionRamp( 1.2 ) ).toEqual( [ 0, 0, 0 ] );
		expect( volume.emissionRamp( 9 ) ).toEqual( peakBlackbodyRGB( 4000 ).map( ( c ) => c * 2 ) );
		expect( volume.emissionGrid.width ).toBe( volume.grid.width );
		// The sphere holds the whole grid: nothing is cleared, and every parameter was read.
		const sum = ( data ) => data.reduce( ( s, v ) => s + v, 0 );
		const density = readNanoVDB( FILE ).grids[ 0 ].read();
		expect( sum( volume.grid.data ) ).toBeCloseTo( sum( density.data ), 2 );
		expect( parameters.unused ).toEqual( {} );
		expect( warnings.join( '\n' ) ).not.toMatch( /smoke/ );
		// A stored graph would drop it: such a scene is not stored.
		expect( () => encodeSceneGraph( group ) ).toThrow( SceneGraphUnsupported );

	} );

	it( 'clears the voxels outside the shape the medium is inside of', async () => {

		const { group } = await load( scene( SMOKE, inSphere( 6 ) ) );
		const { grid } = volumesOf( group )[ 0 ];
		const p = new Vector3();
		let kept = 0;
		for ( let z = 0; z < grid.depth; z ++ ) for ( let y = 0; y < grid.height; y ++ ) for ( let x = 0; x < grid.width; x ++ ) {

			const value = grid.data[ x + grid.width * ( y + grid.height * z ) ];
			const r = p.set( x, y, z ).applyMatrix4( grid.transform ).length();
			if ( r > 6.01 ) expect( value ).toBe( 0 );
			else if ( value > 0 ) kept ++;

		}

		expect( kept ).toBeGreaterThan( 1000 );
		expect( grid.max ).toBe( 1 );

	} );

	it( 'leaves the grid whole where its shape is not closed', async () => {

		const disk = 'AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nShape "disk" "float radius" 50\nAttributeEnd';
		const { group, warnings } = await load( scene( SMOKE, disk ) );
		const density = readNanoVDB( FILE ).grids[ 0 ].read();
		expect( volumesOf( group )[ 0 ].grid.data.filter( ( v ) => v > 0 ).length ).toBe( density.data.filter( ( v ) => v > 0 ).length );
		expect( warnings.join( '\n' ) ).toMatch( /medium "smoke": its shapes are not closed/ );

	} );

	it( 'leaves a medium in glass to the glass, drawn clear: volumes are traced outside glass only', async () => {

		const glass = 'AttributeBegin\nMediumInterface "smoke" ""\nMaterial "dielectric"\nShape "sphere" "float radius" 100\nAttributeEnd';
		const { group, warnings } = await load( scene( SMOKE, glass ) );
		expect( volumesOf( group ) ).toHaveLength( 0 );
		expect( meshesOf( group ) ).toHaveLength( 2 );
		expect( warnings.join( '\n' ) ).toMatch( /medium "smoke" \(nanovdb\) is not supported — "smoke" glass left clear/ );

	} );

	it( 'carves the holes a shape with the medium outside it makes', async () => {

		const hole = 'AttributeBegin\nMediumInterface "" "smoke"\nMaterial "interface"\nShape "sphere" "float radius" 4\nAttributeEnd';
		const { group } = await load( scene( SMOKE, inSphere( 100 ) + '\n' + hole ) );
		const { grid } = volumesOf( group )[ 0 ];
		expect( meshesOf( group ) ).toHaveLength( 1 );
		const p = new Vector3();
		let between = 0;
		for ( let z = 0; z < grid.depth; z ++ ) for ( let y = 0; y < grid.height; y ++ ) for ( let x = 0; x < grid.width; x ++ ) {

			const value = grid.data[ x + grid.width * ( y + grid.height * z ) ];
			const r = p.set( x, y, z ).applyMatrix4( grid.transform ).length();
			if ( r < 3.9 ) expect( value ).toBe( 0 );
			else if ( r > 4.1 && value > 0 ) between ++;

		}

		expect( between ).toBeGreaterThan( 1000 );

	} );

	it( 'counts a .ply that only bounds a medium as used, so its last merge frees it', async () => {

		const triangle = new BufferGeometry();
		triangle.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ) );
		const bound = 'AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nShape "plymesh" "string filename" "shared.ply"\nAttributeEnd';
		const copies = Array.from( { length: 4 }, ( _, i ) => `AttributeBegin Translate ${i} 0 0 Shape "plymesh" "string filename" "shared.ply" AttributeEnd` ).join( '\n' );
		const { group } = await loadPBRTScene( {
			vfs: { 'scene.pbrt': scene( SMOKE, `${bound}\n${copies}` ), 'fog.nvdb': FILE, 'shared.ply': enc.encode( 'ply' ) },
			plyParser: () => triangle, imageFromBytes: async () => null, mergeShapesAbove: 2,
		} );
		expect( volumesOf( group ) ).toHaveLength( 1 );
		expect( triangle.getAttribute( 'position' ).array.byteLength ).toBe( 0 );

	} );

	it( 'keeps a medium outside its only shape everywhere but in it', async () => {

		const { group } = await load( scene( SMOKE, 'AttributeBegin\nMediumInterface "" "smoke"\nMaterial "interface"\nShape "sphere" "float radius" 4\nAttributeEnd' ) );
		const { grid } = volumesOf( group )[ 0 ];
		const raw = readNanoVDB( FILE ).grids[ 0 ].read().data;
		expect( grid.data.length ).toBe( raw.length );
		const p = new Vector3();
		let kept = 0;
		for ( let z = 0; z < grid.depth; z ++ ) for ( let y = 0; y < grid.height; y ++ ) for ( let x = 0; x < grid.width; x ++ ) {

			const at = x + grid.width * ( y + grid.height * z );
			const r = p.set( x, y, z ).applyMatrix4( grid.transform ).length();
			if ( r < 3.9 ) expect( grid.data[ at ] ).toBe( 0 );
			else if ( r > 4.1 ) {

				expect( grid.data[ at ] ).toBe( raw[ at ] );
				if ( raw[ at ] > 0 ) kept ++;

			}

		}

		expect( kept ).toBeGreaterThan( 1000 );

	} );

	it.each( [ false, true ] )( 'clips a turned, stretched medium to its shape where the shape is (handedness converted: %s)', async ( convertHandedness ) => {

		const media = `AttributeBegin\nRotate 90 1 0 0\nScale 1 1 1.6\n${SMOKE}\nAttributeEnd`;
		const sphere = 'AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nTranslate 2 1 3\nShape "sphere" "float radius" 6\nAttributeEnd';
		const { group } = await loadPBRTScene( { vfs: { 'scene.pbrt': scene( media, sphere ), 'fog.nvdb': FILE }, plyParser: () => null, imageFromBytes: async () => null, convertHandedness } );
		const { grid } = volumesOf( group )[ 0 ];
		const centre = new Vector3( 2, 1, convertHandedness ? - 3 : 3 );
		const raw = readNanoVDB( FILE ).grids[ 0 ].read().data;
		const p = new Vector3();
		let kept = 0;
		for ( let z = 0; z < grid.depth; z ++ ) for ( let y = 0; y < grid.height; y ++ ) for ( let x = 0; x < grid.width; x ++ ) {

			const value = grid.data[ x + grid.width * ( y + grid.height * z ) ];
			const r = p.set( x, y, z ).applyMatrix4( grid.transform ).distanceTo( centre );
			if ( r > 6.01 ) expect( value ).toBe( 0 );
			else if ( r < 5.9 ) {

				// Inside the sphere's triangles (they sit up to a hair within its radius), every voxel as read.
				expect( value ).toBe( raw[ x + grid.width * ( y + grid.height * z ) ] );
				if ( value > 0 ) kept ++;

			}

		}

		expect( kept ).toBeGreaterThan( 500 );

	} );

	it( 'clips the few columns a stray triangle leaves undecided as their neighbours', async () => {

		const cube = 'Shape "trianglemesh" "point3 P" [ -6 -6 -6  6 -6 -6  6 6 -6  -6 6 -6  -6 -6 6  6 -6 6  6 6 6  -6 6 6 ] ' +
			'"integer indices" [ 0 2 1 0 3 2  4 5 6 4 6 7  0 1 5 0 5 4  2 3 7 2 7 6  1 2 6 1 6 5  0 4 7 0 7 3 ]\n' +
			'Shape "trianglemesh" "point3 P" [ 0.1 0.1 0  1.3 0.1 0  0.1 1.3 1 ] "integer indices" [ 0 1 2 ]';
		const shapes = `AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\n${cube}\nAttributeEnd`;
		const { group, warnings } = await load( scene( SMOKE, shapes ) );
		const { grid } = volumesOf( group )[ 0 ];
		const p = new Vector3();
		let outside = 0;
		for ( let z = 0; z < grid.depth; z ++ ) for ( let y = 0; y < grid.height; y ++ ) for ( let x = 0; x < grid.width; x ++ ) {

			p.set( x, y, z ).applyMatrix4( grid.transform );
			if ( grid.data[ x + grid.width * ( y + grid.height * z ) ] > 0 && Math.max( Math.abs( p.x ), Math.abs( p.y ), Math.abs( p.z ) ) > 6.01 ) outside ++;

		}

		expect( outside ).toBe( 0 );
		expect( warnings.join( '\n' ) ).toMatch( /medium "smoke": [1-9]\d* of \d+ columns cross its shapes an odd number of times; each is clipped as a neighbour is/ );

	} );

	it( 'clips nothing, and says so, where a shape bounding the medium builds no surface', async () => {

		const shapes = inSphere( 6 ) + '\nAttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nShape "plymesh" "string filename" "gone.ply"\nAttributeEnd';
		const { group, warnings } = await load( scene( SMOKE, shapes ) );
		const density = readNanoVDB( FILE ).grids[ 0 ].read();
		expect( volumesOf( group )[ 0 ].grid.data.filter( ( v ) => v > 0 ).length ).toBe( density.data.filter( ( v ) => v > 0 ).length );
		expect( warnings.join( '\n' ) ).toMatch( /medium "smoke": a shape bounding it builds no surface/ );

	} );

	it( 'reports a g past the engine\'s ±0.95, and refuses a level set as pbrt does', async () => {

		const { parameters } = await load( scene( SMOKE.replace( '"float g" 0.4', '"float g" 0.99' ), inSphere( 100 ) ) );
		expect( parameters.approximated ).toEqual( { 'MakeNamedMedium nanovdb: g': 1 } );
		const levelSet = FILE.slice();
		new DataView( levelSet.buffer ).setUint32( 16 + 36, 1, true );
		const { group, warnings } = await load( scene( SMOKE, inSphere( 100 ) ), { 'fog.nvdb': levelSet } );
		expect( volumesOf( group ) ).toHaveLength( 0 );
		expect( warnings.join( '\n' ) ).toMatch( /"density" is a level set grid, not a fog volume/ );

	} );

	it( 'stops on uniformgrid arrays of another size than the density, as pbrt does', async () => {

		const media = 'MakeNamedMedium "smoke" "string type" "uniformgrid" "integer nx" 2 "float density" [ 0.5 1 ] "float Lescale" [ 1 2 3 ] "rgb Le" [ 1 1 1 ]';
		const { group, warnings } = await load( scene( media, inSphere( 40 ) ) );
		expect( volumesOf( group ) ).toHaveLength( 0 );
		expect( warnings.join( '\n' ) ).toMatch( /medium "smoke" \(uniformgrid\): 3 Lescale values for 2 density values/ );

	} );

	it( 'reports a missing file or grid and builds no volume', async () => {

		const missing = await load( scene( SMOKE.replace( 'fog.nvdb', 'none.nvdb' ), inSphere( 100 ) ) );
		expect( volumesOf( missing.group ) ).toHaveLength( 0 );
		expect( missing.warnings.join( '\n' ) ).toMatch( /nanovdb file "none.nvdb" not found/ );
		const unnamed = await load( scene( SMOKE.replace( '"float g"', '"string gridname" "smoke" "float g"' ), inSphere( 100 ) ) );
		expect( volumesOf( unnamed.group ) ).toHaveLength( 0 );
		expect( unnamed.warnings.join( '\n' ) ).toMatch( /has no "smoke" grid \(its grids: density, temperature\)/ );

	} );

	it( 'reads a uniformgrid on its box, Lescale\'s default a tent as pbrt reads its 1³ grid', async () => {

		const media = 'Translate 1 0 0\nMakeNamedMedium "smoke" "string type" "uniformgrid" "integer nx" 2 "integer ny" 1 "integer nz" 1 ' +
			'"float density" [ 0.5 1 ] "point3 p0" [ 0 0 0 ] "point3 p1" [ 2 1 1 ] "rgb Le" [ 1 0.5 0.25 ] "rgb sigma_a" [ 2 2 2 ] "rgb sigma_s" [ 0 0 0 ]\nIdentity';
		const box = 'AttributeBegin\nMediumInterface "smoke" ""\nMaterial "interface"\nShape "sphere" "float radius" 40\nAttributeEnd';
		const { group, parameters } = await load( scene( media, box ) );
		const [ volume ] = volumesOf( group );
		expect( Array.from( volume.grid.data ) ).toEqual( [ 0.5, 1 ] );
		// Voxel i's centre at p0 + ( i + ½ ) / n × ( p1 − p0 ), moved by the transform where it was made.
		const centre = ( i ) => new Vector3( i, 0, 0 ).applyMatrix4( volume.grid.transform ).toArray().map( ( v ) => Number( v.toFixed( 9 ) ) );
		expect( centre( 0 ) ).toEqual( [ 1.5, 0.5, 0.5 ] );
		expect( centre( 1 ) ).toEqual( [ 2.5, 0.5, 0.5 ] );
		expect( Array.from( volume.emissionGrid.data ) ).toEqual( [ 0.75, 0.75 ] );
		expect( volume.emissionRamp( 0.5 ) ).toEqual( [ 0.5, 0.25, 0.125 ] );
		expect( volume.color.r ).toBe( 0 );
		expect( parameters.unused ).toEqual( {} );

	} );

} );
