import { describe, it, expect } from 'vitest';
import { Mesh } from 'three';
import { readPtexInfo, decodePtexFaces, readPtexBlocks, planPtexPages, writePtexFile, ptexUV, plyFaceIndices, ptexPower } from '@/core/addons/archives/pbrt/Ptex.js';
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';
import { USDFiles, loadUSDScene } from '@/core/addons/archives/usd/index.js';
import { holdImages, releaseImages } from '@/core/materials/TextureCreator.js';
import { writePtex, texelsOf, quantize, reader } from './ptexFixture.js';

const pattern = ( w, h, nc, seed ) => texelsOf( w, h, nc, ( x, y, c ) => ( ( x * 37 + y * 11 + c * 53 + seed * 7 ) % 97 ) / 96 );
const srgb = ( linear ) => Math.round( 255 * ( linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** ( 1 / 2.4 ) - 0.055 ) );
const pageTexel = ( page, size, x, y ) => Array.from( page.subarray( ( y * size + x ) * 4, ( y * size + x ) * 4 + 4 ) );

async function pagesFor( bytes, { pageSize = 64, maxTexels = 64 * 64, slotsOf = null, power = [ 1, 1, 1 ] } = {} ) {

	const info = await readPtexInfo( reader( bytes ) );
	const plan = planPtexPages( [ info ], { pageSize, maxTexels } );
	const slots = plan.files[ 0 ];
	slotsOf?.( slots, info );
	const pages = Array.from( { length: plan.pageCount }, () => new Uint8Array( pageSize * pageSize * 4 ) );
	writePtexFile( info, await readPtexBlocks( info, reader( bytes ), slots ), slots, pages, pageSize, power );
	return { info, plan, slots, pages };

}

describe( 'Ptex reader', () => {

	for ( const [ dataType, name ] of [[ 0, 'uint8' ], [ 1, 'uint16' ], [ 2, 'half' ], [ 3, 'float' ]] ) {

		it( `reads every face as stored (${name}): zipped, a tiled face and a constant face`, async () => {

			const faces = [
				{ ulog2: 2, vlog2: 1, values: pattern( 4, 2, 3, 1 ) },
				{ ulog2: 3, vlog2: 3, values: pattern( 8, 8, 3, 2 ), tile: [ 2, 1 ] },
				{ ulog2: 2, vlog2: 2, constant: [ 0.2, 0.4, 0.6 ] },
			];
			const bytes = writePtex( { dataType, faces } );
			const info = await readPtexInfo( reader( bytes ) );
			expect( info ).toMatchObject( { meshType: 'quad', dataType, channels: 3, faceCount: 3 } );
			expect( Array.from( info.ulog2 ) ).toEqual( [ 2, 3, 2 ] );
			const read = [];
			await decodePtexFaces( info, reader( bytes ), ( f, values, w, h ) => read.push( { f, values: Array.from( values ), w, h } ) );
			expect( read.map( ( r ) => [ r.w, r.h ] ) ).toEqual( [[ 4, 2 ], [ 8, 8 ], [ 1, 1 ]] );
			for ( const f of [ 0, 1 ] ) read[ f ].values.forEach( ( v, i ) => expect( v ).toBeCloseTo( quantize( faces[ f ].values, dataType )[ i ], 6 ) );
			read[ 2 ].values.forEach( ( v, i ) => expect( v ).toBeCloseTo( quantize( faces[ 2 ].constant, dataType )[ i ], 6 ) );

		} );

	}

	it( 'reads uint8 stored without differences, and a one-channel file', async () => {

		const values = pattern( 4, 4, 1, 3 );
		const bytes = writePtex( { channels: 1, diff: false, faces: [ { ulog2: 2, vlog2: 2, values } ] } );
		let got;
		await decodePtexFaces( await readPtexInfo( reader( bytes ) ), reader( bytes ), ( _, v ) => ( got = Array.from( v ) ) );
		got.forEach( ( v, i ) => expect( v ).toBeCloseTo( quantize( values, 0 )[ i ], 6 ) );

	} );

	it( 'rejects what is not a Ptex file', async () => {

		await expect( readPtexInfo( reader( new Uint8Array( 128 ) ) ) ).rejects.toThrow( /not a Ptex file/ );

	} );

	it( 'takes a face from the level that matches its slot, box-filtering only what is left', async () => {

		const values = pattern( 16, 8, 3, 4 );
		const bytes = writePtex( { faces: [ { ulog2: 4, vlog2: 3, values } ] } );
		for ( const [ tu, tv, level ] of [[ 2, 1, 2 ], [ 1, 1, 2 ], [ 4, 3, 0 ]] ) {

			const { slots, pages, info } = await pagesFor( bytes, { slotsOf: ( s ) => {

				s.tu[ 0 ] = tu;
				s.tv[ 0 ] = tv;

			} } );
			expect( ( await readPtexBlocks( info, reader( bytes ), slots ) ).level[ 0 ] ).toBe( level );
			const w = 1 << tu, h = 1 << tv, sx = 16 / w, sy = 8 / h;
			// Every texel the box mean of the full-size texels under it (stored levels are those means, rounded).
			for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) for ( let c = 0; c < 3; c ++ ) {

				let sum = 0;
				for ( let j = 0; j < sy; j ++ ) for ( let i = 0; i < sx; i ++ ) sum += quantize( values, 0 )[ ( ( y * sy + j ) * 16 + x * sx + i ) * 3 + c ];
				const got = pageTexel( pages[ 0 ], 64, slots.x[ 0 ] + x, slots.y[ 0 ] + y )[ c ];
				expect( Math.abs( got - srgb( sum / ( sx * sy ) ) ) ).toBeLessThanOrEqual( 3 );

			}

		}

	} );

} );

describe( 'Ptex pages', () => {

	const fileOf = ( sides ) => ( { faceCount: sides.length, ulog2: Uint8Array.from( sides, ( s ) => s[ 0 ] ), vlog2: Uint8Array.from( sides, ( s ) => s[ 1 ] ), flags: new Uint8Array( sides.length ) } );

	/** Each page's texels claimed by more than one face (borders included), or outside the page. */
	function overlaps( plan, infos ) {

		const size = plan.pageSize, owner = new Map();
		let clashes = 0;
		plan.files.forEach( ( slots, i ) => {

			for ( let f = 0; f < infos[ i ].faceCount; f ++ ) {

				const w = 1 << slots.tu[ f ], h = 1 << slots.tv[ f ];
				for ( let y = slots.y[ f ] - 1; y <= slots.y[ f ] + h; y ++ ) for ( let x = slots.x[ f ] - 1; x <= slots.x[ f ] + w; x ++ ) {

					const key = `${slots.page[ f ]}|${x}|${y}`;
					if ( x < 0 || y < 0 || x >= size || y >= size || owner.has( key ) ) clashes ++;
					owner.set( key, true );

				}

			}

		} );
		return clashes;

	}

	it( 'places every face of every file once, inside a page, small files sharing one', () => {

		const infos = [ fileOf( [[ 2, 2 ], [ 3, 1 ], [ 0, 0 ]] ), fileOf( [[ 1, 1 ], [ 2, 3 ]] ), fileOf( [[ 2, 2 ]] ) ];
		const plan = planPtexPages( infos, { pageSize: 64, maxTexels: 64 * 64 * 4 } );
		expect( plan.reduction ).toBe( 0 );
		expect( plan.pageCount ).toBe( 1 );
		expect( overlaps( plan, infos ) ).toBe( 0 );
		expect( Array.from( plan.files[ 0 ].tu ) ).toEqual( [ 2, 3, 0 ] );

	} );

	it( 'halves faces until all fit the memory, keeping constant faces at 2 × 2 or less', () => {

		const info = fileOf( [[ 5, 5 ], [ 4, 2 ], [ 1, 0 ], [ 4, 4 ]] );
		info.flags[ 3 ] = 1;
		const plan = planPtexPages( [ info ], { pageSize: 64, maxTexels: 1200 } );
		expect( plan.reduction ).toBeGreaterThan( 0 );
		expect( plan.texels ).toBeLessThanOrEqual( 1200 * 0.85 );
		expect( plan.files[ 0 ].tu[ 0 ] ).toBe( 5 - plan.reduction );
		expect( plan.files[ 0 ].tu[ 2 ] ).toBe( Math.max( 0, 1 - plan.reduction ) );
		expect( [ plan.files[ 0 ].tu[ 3 ], plan.files[ 0 ].tv[ 3 ] ] ).toEqual( [ 1, 1 ] );
		expect( overlaps( plan, [ info ] ) ).toBe( 0 );

	} );

	it( 'spreads a file larger than a page over pages of its own', () => {

		const big = fileOf( Array.from( { length: 40 }, () => [ 4, 4 ] ) );
		const small = fileOf( [[ 2, 2 ]] );
		const plan = planPtexPages( [ small, big ], { pageSize: 64, maxTexels: 64 * 64 * 16 } );
		expect( plan.files[ 1 ].pages.length ).toBeGreaterThan( 1 );
		expect( plan.files[ 0 ].pages.length ).toBe( 1 );
		expect( overlaps( plan, [ small, big ] ) ).toBe( 0 );

	} );

	it( 'borders a face with its neighbour\'s texels at the shared edge, and its own at the mesh\'s edge', async () => {

		// A | B, A's right edge (1) against B's left (3).
		const a = pattern( 4, 4, 3, 5 ), b = pattern( 4, 4, 3, 6 );
		const bytes = writePtex( { faces: [
			{ ulog2: 2, vlog2: 2, values: a, adjFaces: [ - 1, 1, - 1, - 1 ], adjEdges: [ 0, 3, 0, 0 ] },
			{ ulog2: 2, vlog2: 2, values: b, adjFaces: [ - 1, - 1, - 1, 0 ], adjEdges: [ 0, 0, 0, 1 ] },
		] } );
		const { slots, pages } = await pagesFor( bytes );
		const at = ( f, x, y ) => pageTexel( pages[ slots.page[ f ] ], 64, slots.x[ f ] + x, slots.y[ f ] + y );
		for ( let k = 0; k < 4; k ++ ) {

			expect( at( 0, 4, k ) ).toEqual( at( 1, 0, k ) );
			expect( at( 1, - 1, k ) ).toEqual( at( 0, 3, k ) );
			expect( at( 0, - 1, k ) ).toEqual( at( 0, 0, k ) );
			expect( at( 0, k, - 1 ) ).toEqual( at( 0, k, 0 ) );

		}

		const corner = at( 0, - 1, - 1 );
		for ( let c = 0; c < 3; c ++ ) expect( corner[ c ] ).toBe( ( at( 0, 0, - 1 )[ c ] + at( 0, - 1, 0 )[ c ] + 1 ) >> 1 );

	} );

	it( 'resamples a neighbour of another size along the shared edge, and borders black or periodic as the file says', async () => {

		const a = pattern( 2, 2, 3, 7 ), b = pattern( 8, 8, 3, 8 );
		const bytes = writePtex( { vBorder: 1, uBorder: 2, faces: [
			{ ulog2: 1, vlog2: 1, values: a, adjFaces: [ - 1, 1, - 1, - 1 ], adjEdges: [ 0, 3, 0, 0 ] },
			{ ulog2: 3, vlog2: 3, values: b, adjFaces: [ - 1, - 1, - 1, 0 ], adjEdges: [ 0, 0, 0, 1 ] },
		] } );
		const { slots, pages } = await pagesFor( bytes );
		const at = ( f, x, y ) => pageTexel( pages[ slots.page[ f ] ], 64, slots.x[ f ] + x, slots.y[ f ] + y );
		for ( let k = 0; k < 2; k ++ ) for ( let c = 0; c < 3; c ++ ) {

			const mean = ( at( 1, 0, 4 * k )[ c ] + at( 1, 0, 4 * k + 1 )[ c ] + at( 1, 0, 4 * k + 2 )[ c ] + at( 1, 0, 4 * k + 3 )[ c ] ) / 4;
			expect( Math.abs( at( 0, 2, k )[ c ] - mean ) ).toBeLessThanOrEqual( 0.5 );

		}

		expect( at( 0, 0, - 1 ).slice( 0, 3 ) ).toEqual( [ 0, 0, 0 ] );
		expect( at( 0, - 1, 1 ) ).toEqual( at( 0, 1, 1 ) );

	} );

	it( 'stores colour as sRGB from the file\'s encoding', async () => {

		const bytes = writePtex( { faces: [ { ulog2: 0, vlog2: 0, values: Float32Array.of( 0.5, 0.25, 1 ) } ] } );
		const { slots, pages } = await pagesFor( bytes, { power: ptexPower( 'gamma 2.2' ) } );
		const got = pageTexel( pages[ 0 ], 64, slots.x[ 0 ], slots.y[ 0 ] );
		expect( got ).toEqual( [ srgb( ( 128 / 255 ) ** 2.2 ), srgb( ( 64 / 255 ) ** 2.2 ), 255, 255 ] );
		expect( ptexPower( 'sRGB' ) ).toBe( 'srgb' );
		expect( ptexPower( 'linear' ) ).toEqual( [ 1, 1, 1 ] );
		expect( ptexPower( 'gamma 1.8' ) ).toEqual( [ 1.8, 1.8, 1.8 ] );
		expect( ptexPower( 'whatever' ) ).toBeNull();

	} );

	it( 'moves uvs into each face\'s rectangle, copying a vertex two faces share', () => {

		const slots = { page: Uint16Array.of( 0, 1 ), x: Uint16Array.of( 1, 9 ), y: Uint16Array.of( 1, 5 ), tu: Uint8Array.of( 2, 1 ), tv: Uint8Array.of( 2, 1 ) };
		// Two quads sharing vertices 1 and 2: face 0 then face 1, two triangles each.
		const index = Uint32Array.of( 0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2 );
		const uv = Float32Array.of( 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1 );
		const out = ptexUV( index, uv, Int32Array.of( 0, 0, 1, 1 ), slots, 16 );
		expect( Array.from( out.pages ) ).toEqual( [ 0, 0, 1, 1 ] );
		expect( Array.from( out.copies ) ).toEqual( [ 1, 2 ] );
		expect( Array.from( out.index ) ).toEqual( [ 0, 1, 2, 0, 2, 3, 6, 4, 5, 6, 5, 7 ] );
		const at = ( v ) => [ out.uv[ v * 2 ] * 16, out.uv[ v * 2 + 1 ] * 16 ];
		expect( at( 2 ) ).toEqual( [ 5, 5 ] );
		expect( at( 6 ) ).toEqual( [ 9 + 2, 5 ] );
		expect( at( 4 ) ).toEqual( [ 9 + 2, 5 ] );

	} );

} );

describe( 'PLY face ids', () => {

	it( 'reads face_indices a triangle, binary and ascii, as three\'s PLYLoader triangulates', () => {

		const header = ( format ) => `ply\nformat ${format} 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\n` +
			'element face 3\nproperty list uchar int vertex_indices\nproperty int face_indices\nend_header\n';
		const ascii = new TextEncoder().encode( header( 'ascii' ) + '0 0 0 1\n1 0 0 1\n1 1 0 1\n0 1 0 1\n2 2 0 1\n3 0 1 2 5\n4 0 1 2 3 7\n5 0 1 2 3 4 9\n' );
		expect( Array.from( plyFaceIndices( ascii ) ) ).toEqual( [ 5, 7, 7 ] );

		const head = new TextEncoder().encode( header( 'binary_little_endian' ) );
		const body = new Uint8Array( 5 * 13 + ( 1 + 12 + 4 ) + ( 1 + 16 + 4 ) + ( 1 + 20 + 4 ) );
		const view = new DataView( body.buffer );
		let at = 5 * 13;
		for ( const [ n, id ] of [[ 3, 5 ], [ 4, 7 ], [ 5, 9 ]] ) {

			body[ at ++ ] = n;
			for ( let k = 0; k < n; k ++, at += 4 ) view.setInt32( at, k, true );
			view.setInt32( at, id, true );
			at += 4;

		}

		const binary = new Uint8Array( head.length + body.length );
		binary.set( head );
		binary.set( body, head.length );
		expect( Array.from( plyFaceIndices( binary ) ) ).toEqual( [ 5, 7, 7 ] );
		expect( plyFaceIndices( new TextEncoder().encode( 'ply\nformat ascii 1.0\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n' ) ) ).toBeNull();

	} );

} );

describe( 'Ptex in the loaders', () => {

	const enc = new TextEncoder();
	const twoFaces = () => writePtex( { faces: [
		{ ulog2: 1, vlog2: 1, values: texelsOf( 2, 2, 3, () => 1 ) },
		{ ulog2: 1, vlog2: 1, constant: [ 0.5, 0.5, 0.5 ] },
	] } );
	const meshesOf = ( group ) => {

		const out = [];
		group.traverse( ( o ) => o instanceof Mesh && out.push( o ) );
		return out;

	};

	/** Each triangle's uvs, in page texels. */
	const triangleUVs = ( mesh, size ) => {

		const uv = mesh.geometry.getAttribute( 'uv' ), index = mesh.geometry.index;
		return Array.from( { length: index.count / 3 }, ( _, t ) => [ 0, 1, 2 ].map( ( k ) => [ uv.getX( index.getX( t * 3 + k ) ) * size, uv.getY( index.getX( t * 3 + k ) ) * size ] ) );

	};

	async function pbrt( scene, files, options = {} ) {

		const vfs = { 'scene.pbrt': enc.encode( 'WorldBegin\n' + scene ), ...files };
		return loadPBRTScene( { vfs, plyParser: () => null, imageFromBytes: async () => null, ptexPageSize: 64, ...options } );

	}

	const quads = `Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 1 1 0 0 1 0 1 0 0 2 0 0 2 1 0 1 1 0 ]
		"integer indices" [ 0 1 2 0 2 3 4 5 6 4 6 7 ] "point2 uv" [ 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 ] "integer faceIndices" [ 0 0 1 1 ]`;

	it( 'pbrt: a ptex texture is a page map and each triangle\'s uvs land in its face\'s rectangle', async () => {

		const built = await pbrt( `Texture "rock" "spectrum" "ptex" "string filename" "rock.ptx"\nMaterial "diffuse" "texture reflectance" "rock"\n${quads}`, { 'rock.ptx': twoFaces() } );
		expect( built.ptex ).toMatchObject( { files: 1, pages: 1, pageSize: 64, reduction: 0 } );
		const [ mesh ] = meshesOf( built.group );
		const map = mesh.material.map;
		expect( map.image.width ).toBe( 64 );
		// Written when it is packed, not by the build.
		expect( map.image.data ).toBeNull();
		await holdImages( [ map ] );
		const page = map.image.data;
		const uvs = triangleUVs( mesh, 64 );
		// Each triangle's centre reads its own face: white for face 0, 0.5^2.2 for the constant face 1.
		const centre = ( t ) => [ 0, 1 ].map( ( c ) => Math.floor( ( uvs[ t ][ 0 ][ c ] + uvs[ t ][ 1 ][ c ] + uvs[ t ][ 2 ][ c ] ) / 3 ) );
		const red = ( t ) => page[ ( centre( t )[ 1 ] * 64 + centre( t )[ 0 ] ) * 4 ];
		expect( [ red( 0 ), red( 1 ) ] ).toEqual( [ 255, 255 ] );
		expect( red( 2 ) ).toBe( srgb( ( 128 / 255 ) ** 2.2 ) );
		expect( built.warnings.filter( ( w ) => /ptex/i.test( w ) ) ).toEqual( [] );

		// Once packed a page lets its pixels go; a later pack writes the same page again from the file.
		const written = page.slice();
		releaseImages( [ map ] );
		expect( map.image.data ).toBeNull();
		await holdImages( [ map ] );
		expect( map.image.data ).toEqual( written );

	} );

	it( 'pbrt: a file larger than a page splits its mesh a page at a time, each part reading its own page', async () => {

		// 24 faces of 4 × 4 (36 texels with borders) on 16² pages: several pages. Face f's texels are f / 32.
		const faces = Array.from( { length: 24 }, ( _, f ) => ( { ulog2: 2, vlog2: 2, values: texelsOf( 4, 4, 3, () => f / 32 ) } ) );
		const P = [], indices = [], uv = [], ids = [];
		faces.forEach( ( _, f ) => {

			const v = P.length / 3;
			P.push( f, 0, 0, f + 1, 0, 0, f + 1, 1, 0, f, 1, 0 );
			uv.push( 0, 0, 1, 0, 1, 1, 0, 1 );
			indices.push( v, v + 1, v + 2, v, v + 2, v + 3 );
			ids.push( f, f );

		} );
		const scene = `Texture "rock" "spectrum" "ptex" "string filename" "rock.ptx" "string encoding" "linear"\nMaterial "diffuse" "texture reflectance" "rock"
			Shape "trianglemesh" "point3 P" [ ${P.join( ' ' )} ] "integer indices" [ ${indices.join( ' ' )} ] "point2 uv" [ ${uv.join( ' ' )} ] "integer faceIndices" [ ${ids.join( ' ' )} ]`;
		const built = await pbrt( scene, { 'rock.ptx': writePtex( { faces } ) }, { ptexPageSize: 16, ptexMemory: 16 * 16 * 4 * 64 } );
		expect( built.ptex.pages ).toBeGreaterThan( 1 );
		const parts = meshesOf( built.group );
		expect( parts.length ).toBe( built.ptex.pages );
		expect( new Set( parts.map( ( m ) => m.material.map.source ) ).size ).toBe( parts.length );
		let triangles = 0;
		for ( const mesh of parts ) {

			await holdImages( [ mesh.material.map ] );
			const page = mesh.material.map.image.data, position = mesh.geometry.getAttribute( 'position' );
			triangleUVs( mesh, 16 ).forEach( ( tri, t ) => {

				const [ x, y ] = [ 0, 1 ].map( ( c ) => Math.floor( ( tri[ 0 ][ c ] + tri[ 1 ][ c ] + tri[ 2 ][ c ] ) / 3 ) );
				// Each triangle's first corner sits at x = its face; the page's encoding table rounds within a level.
				const f = Math.round( position.getX( mesh.geometry.index.getX( t * 3 ) ) );
				expect( Math.abs( page[ ( y * 16 + x ) * 4 ] - srgb( Math.round( f / 32 * 255 ) / 255 ) ) ).toBeLessThanOrEqual( 1 );
				triangles ++;

			} );

		}

		expect( triangles ).toBe( 48 );

	} );

	it( 'pbrt: with no Ptex memory, or no file, a ptex texture is a colour', async () => {

		const scene = `Texture "rock" "spectrum" "ptex" "string filename" "rock.ptx"\nMaterial "diffuse" "texture reflectance" "rock"\n${quads}`;
		const [ mesh ] = meshesOf( ( await pbrt( scene, { 'rock.ptx': twoFaces() }, { ptexMemory: 0 } ) ).group );
		expect( mesh.material.map ).toBeNull();
		// The texels' mean, each face weighed by its texels, in linear light.
		expect( mesh.material.color.r ).toBeCloseTo( ( ( 1 + 128 / 255 ) / 2 ) ** 2.2, 2 );

		const missing = await pbrt( scene, {} );
		expect( meshesOf( missing.group )[ 0 ].material.map ).toBeNull();
		expect( missing.warnings.filter( ( w ) => /Ptex file\(s\) not found or unreadable \(rock\.ptx\)/.test( w ) ) ).toHaveLength( 1 );

	} );

	it( 'USD: a PxrPtexture through PxrColorCorrect maps a mesh by Ptex\'s face ids, a polygon split a corner at a time', async () => {

		// A quad (face 0) and a triangle (faces 1-3): the file's 4 faces, face 2 white, the rest black.
		const ptx = writePtex( { faces: [ 0, 1, 2, 3 ].map( ( f ) => ( { ulog2: 0, vlog2: 0, constant: f === 2 ? [ 1, 1, 1 ] : [ 0, 0, 0 ] } ) ) } );
		const layers = { 'root.usda': `#usda 1.0
def Material "rock"
{
    token outputs:ri:surface.connect = </rock/bsdf.outputs:bxdf_out>
    def Shader "bsdf"
    {
        uniform token info:id = "PxrDisneyBsdf"
        color3f inputs:baseColor.connect = </rock/cc.outputs:resultRGB>
    }
    def Shader "cc"
    {
        uniform token info:id = "PxrColorCorrect"
        normal3f inputs:gamma = (0.45454547, 0.45454547, 0.45454547)
        color3f inputs:inputRGB.connect = </rock/tex.outputs:resultRGB>
    }
    def Shader "tex"
    {
        uniform token info:id = "PxrPtexture"
        asset inputs:filename = @rock.ptx@
        int inputs:linearize = 0
    }
}
def Mesh "m" (
    prepend apiSchemas = ["MaterialBindingAPI"]
)
{
    int[] faceVertexCounts = [4, 3]
    int[] faceVertexIndices = [0, 1, 2, 3, 1, 4, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 0.5, 0)]
    rel material:binding = </rock>
}
` };
		const files = new USDFiles( [ 'root.usda', 'rock.ptx' ], async ( path ) => ( path === 'rock.ptx' ? ptx : layers[ path ] && enc.encode( layers[ path ] ) ) );
		const built = await loadUSDScene( {
			files, entryPath: 'root.usda', resolveImage: async () => null, resolveEnvironment: async () => null,
			resolvePtex: async ( path ) => ( path === 'rock.ptx' ? { read: reader( ptx ) } : null ), ptexPageSize: 64,
		} );
		const [ mesh ] = meshesOf( built.group );
		expect( mesh.material.map ).toBeTruthy();
		expect( mesh.geometry.index.count / 3 ).toBe( 2 + 3 * 2 );
		await holdImages( [ mesh.material.map ] );
		const page = mesh.material.map.image.data;
		const uvs = triangleUVs( mesh, 64 );
		const reds = uvs.map( ( tri ) => {

			const [ x, y ] = [ 0, 1 ].map( ( c ) => Math.floor( ( tri[ 0 ][ c ] + tri[ 1 ][ c ] + tri[ 2 ][ c ] ) / 3 ) );
			return page[ ( y * 64 + x ) * 4 ];

		} );
		// The triangle's second corner-quad (sub-face 1, Ptex face 2) is the white one; its colour went through 2.2.
		expect( reds ).toEqual( [ 0, 0, 0, 0, 255, 255, 0, 0 ] );
		// The quad's corners keep its winding and positions.
		const position = mesh.geometry.getAttribute( 'position' );
		expect( [ 0, 1, 2 ].map( ( k ) => position.getX( mesh.geometry.index.getX( k ) ) ) ).toEqual( [ 0, 1, 1 ] );

		// Normals given a corner at a time: the same faces, every vertex inside the mesh and on its plane's normal.
		const cornered = layers[ 'root.usda' ].replace( 'rel material:binding', 'normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (\n        interpolation = "faceVarying"\n    )\n    rel material:binding' );
		const again = await loadUSDScene( {
			files: new USDFiles( [ 'root.usda', 'rock.ptx' ], async ( path ) => ( path === 'rock.ptx' ? ptx : enc.encode( cornered ) ) ),
			entryPath: 'root.usda', resolveImage: async () => null, resolveEnvironment: async () => null,
			resolvePtex: async ( path ) => ( path === 'rock.ptx' ? { read: reader( ptx ) } : null ), ptexPageSize: 64,
		} );
		const [ other ] = meshesOf( again.group );
		expect( other.geometry.index.count / 3 ).toBe( 8 );
		other.geometry.computeBoundingBox();
		expect( other.geometry.boundingBox.min.toArray() ).toEqual( [ 0, 0, 0 ] );
		expect( other.geometry.boundingBox.max.toArray() ).toEqual( [ 2, 1, 0 ] );
		const normal = other.geometry.getAttribute( 'normal' );
		for ( let v = 0; v < normal.count; v ++ ) expect( normal.getZ( v ) ).toBeCloseTo( 1, 3 );

	} );

} );
