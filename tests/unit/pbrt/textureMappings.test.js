import { describe, it, expect } from 'vitest';
import { BufferGeometry, DataTexture, Float32BufferAttribute, Mesh } from 'three';
import { loadPBRTScene } from '@/core/Processor/PBRT/index.js';
import { generateUV } from '@/core/Processor/PBRT/PBRTTextureBake.js';

const enc = new TextEncoder();
const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
const image = ( ...values ) => new DataTexture( new Uint8Array( values.flatMap( ( v ) => [ v, v, v, 255 ] ) ), values.length, 1 );

async function build( scene, images = {}, ply = null ) {

	const vfs = { 'scene.pbrt': enc.encode( 'WorldBegin\n' + scene ) };
	for ( const name of Object.keys( images ) ) vfs[ name ] = enc.encode( 'x' );
	if ( ply ) vfs[ 'm.ply' ] = enc.encode( 'ply' );
	const result = await loadPBRTScene( {
		vfs, plyParser: ply ?? ( () => null ), imageFromBytes: async ( bytes, name ) => images[ name ] ?? null
	} );
	return { ...result, meshes: result.group.children.filter( ( c ) => c instanceof Mesh ) };

}

const uvOf = ( mesh ) => Array.from( mesh.geometry.getAttribute( 'uv' ).array );
const expectClose = ( actual, expected ) => {

	expect( actual ).toHaveLength( expected.length );
	actual.forEach( ( v, i ) => expect( v ).toBeCloseTo( expected[ i ], 5 ) );

};

// pbrt-v4 textures.h / textures.cpp, worked by hand at each vertex's world position.
describe( 'pbrt position texture mappings', () => {

	it( 'maps planar: s = udelta + p·v1, t = vdelta + p·v2 at the shape\'s world position, uscale unused', async () => {

		const { meshes, warnings } = await build( `
			Texture "pages" "spectrum" "imagemap" "string filename" "p.png" "string mapping" "planar"
				"vector3 v1" [ 0 .25 0 ] "vector3 v2" [ 0 0 -.025 ] "float udelta" .55 "float vdelta" -.2 "float uscale" 5
			Material "diffuse" "texture reflectance" "pages"
			Translate 0 2 0
			Shape "trianglemesh" "point3 P" [ 0 0 0  1 4 0  0 0 40 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ]
		`, { 'p.png': image( 128 ) } );

		expect( warnings ).toEqual( [] );
		expectClose( uvOf( meshes[ 0 ] ), [ 1.05, - 0.2, 2.05, - 0.2, 1.05, - 1.2 ] );
		const map = meshes[ 0 ].material.map;
		expect( [ map.repeat.x, map.repeat.y, map.offset.x, map.offset.y ] ).toEqual( [ 1, 1, 0, 0 ] );

	} );

	it( 'maps spherical in the space the texture was declared in: s = θ / π, t = φ / 2π', async () => {

		const { meshes } = await build( `
			AttributeBegin
				Translate 10 0 0
				Rotate 90 0 1 0
				Texture "wood" "spectrum" "imagemap" "string filename" "w.png" "string mapping" "spherical"
			AttributeEnd
			Material "diffuse" "texture reflectance" "wood"
			Shape "trianglemesh" "point3 P" [ 10.8 -.6 0  10.8 0 .6  10 0 1 ] "integer indices" [ 0 1 2 ]
		`, { 'w.png': image( 128 ) } );

		// Texture space (0, −.6, .8), (−.6, 0, .8), (−1, 0, 0): θ = acos .8, acos .8, π/2; φ = 3π/2, π, π.
		expectClose( uvOf( meshes[ 0 ] ), [ Math.acos( 0.8 ) / Math.PI, 0.75, Math.acos( 0.8 ) / Math.PI, 0.5, 0.5, 0.5 ] );

	} );

	it( 'maps cylindrical: s = ( π + atan2( y, x ) ) / 2π, t = z, in the texture\'s scaled space', async () => {

		const { meshes } = await build( `
			AttributeBegin
				Translate 0 0 5
				Scale 1 1 2
				Texture "cup" "spectrum" "imagemap" "string filename" "c.png" "string mapping" "cylindrical"
			AttributeEnd
			Material "coateddiffuse" "texture reflectance" "cup"
			Shape "trianglemesh" "point3 P" [ 1 0 7  0 1 5  0 -1 6 ] "integer indices" [ 0 1 2 ]
		`, { 'c.png': image( 128 ) } );

		expectClose( uvOf( meshes[ 0 ] ), [ 0.5, 1, 0.75, 0, 0.25, 0.5 ] );

	} );

	it( 'unwraps a triangle across the seam on copies of its vertices, leaving their other triangles alone', () => {

		const at = ( degrees, z ) => [ Math.cos( degrees * Math.PI / 180 ), Math.sin( degrees * Math.PI / 180 ), z ];
		const positions = new Float32Array( [ ...at( 170, 0 ), ...at( - 170, 0 ), ...at( 170, 1 ), ...at( - 150, 0 ), ...at( - 150, 1 ) ] );
		const { uv, index, extra } = generateUV( positions, [ 0, 1, 2, 1, 3, 4 ], IDENTITY, { type: 'cylindrical' } );

		expect( Array.from( extra ) ).toEqual( [ 1 ] );
		expect( Array.from( index ) ).toEqual( [ 0, 5, 2, 1, 3, 4 ] );
		// 170° is s 35/36; −170° is 1/36 in its own triangle and 37/36, a turn on, beside 170°.
		expectClose( Array.from( uv ), [ 35 / 36, 0, 1 / 36, 0, 35 / 36, 1, 1 / 12, 0, 1 / 12, 1, 37 / 36, 0 ] );

	} );

	it( 'gives a vertex on the axis its triangle\'s mean angle, one copy a triangle', () => {

		const at = ( degrees ) => [ Math.cos( degrees * Math.PI / 180 ), Math.sin( degrees * Math.PI / 180 ), 0 ];
		const positions = new Float32Array( [ 0, 0, 0, ...at( 30 ), ...at( 90 ), ...at( 150 ) ] );
		const { uv, index, extra } = generateUV( positions, [ 0, 1, 2, 0, 2, 3 ], IDENTITY, { type: 'cylindrical' } );

		expect( Array.from( extra ) ).toEqual( [ 0, 0 ] );
		expect( Array.from( index ) ).toEqual( [ 4, 1, 2, 5, 2, 3 ] );
		expect( uv[ 8 ] ).toBeCloseTo( ( 210 / 360 + 270 / 360 ) / 2, 5 );
		expect( uv[ 10 ] ).toBeCloseTo( ( 270 / 360 + 330 / 360 ) / 2, 5 );

	} );

	it( 'wraps no triangle of a mapped sphere across the whole texture, at its seam or its poles', async () => {

		// Turned so the texture's seam runs through the sphere's triangles, not along its own seam.
		const { meshes } = await build( `
			AttributeBegin
				Rotate 45 0 0 1
				Texture "wood" "spectrum" "imagemap" "string filename" "w.png" "string mapping" "spherical"
			AttributeEnd
			Material "diffuse" "texture reflectance" "wood"
			Shape "sphere" "float radius" 2
		`, { 'w.png': image( 128 ) } );

		const { geometry } = meshes[ 0 ];
		const uv = geometry.getAttribute( 'uv' ).array, tri = geometry.index.array;
		let widest = 0;
		for ( let t = 0; t < tri.length; t += 3 ) {

			const ts = [ 0, 1, 2 ].map( ( c ) => uv[ tri[ t + c ] * 2 + 1 ] );
			widest = Math.max( widest, Math.max( ...ts ) - Math.min( ...ts ) );

		}

		expect( widest ).toBeLessThan( 0.1 );
		expect( geometry.getAttribute( 'position' ).count ).toBe( geometry.getAttribute( 'normal' ).count );

	} );

	it( 'maps each copy of a template where it stands', async () => {

		const { meshes, group } = await build( `
			Texture "pages" "spectrum" "imagemap" "string filename" "p.png" "string mapping" "planar" "vector3 v1" [ 0 .25 0 ]
			AttributeBegin
				ObjectBegin "book"
					Material "diffuse" "texture reflectance" "pages"
					Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
				ObjectEnd
			AttributeEnd
			AttributeBegin Translate 0 4 0 ObjectInstance "book" AttributeEnd
			AttributeBegin Translate 0 8 0 ObjectInstance "book" AttributeEnd
		`, { 'p.png': image( 128 ) } );

		expect( group.children.filter( ( c ) => c.isInstancedMesh ) ).toHaveLength( 0 );
		expect( meshes ).toHaveLength( 2 );
		expectClose( uvOf( meshes[ 0 ] ).filter( ( _, i ) => i % 2 === 0 ), [ 1, 1, 1.25 ] );
		expectClose( uvOf( meshes[ 1 ] ).filter( ( _, i ) => i % 2 === 0 ), [ 2, 2, 2.25 ] );
		expect( meshes[ 1 ].position.y ).toBe( 8 );

	} );

	it( 'bakes a scaled position-mapped texture in its own uv set (kroken\'s book covers)', async () => {

		const { meshes } = await build( `
			Texture "proj" "float" "imagemap" "string filename" "b.png" "string mapping" "planar" "vector3 v1" [ 1 0 0 ] "vector3 v2" [ 0 1 0 ]
			Texture "cover" "spectrum" "scale" "rgb tex" [ .4 .3 .3 ] "texture scale" "proj"
			Material "diffuse" "texture reflectance" "cover"
			Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 5 5 5 5 5 5 ]
		`, { 'b.png': image( 0, 255 ) } );

		const map = meshes[ 0 ].material.map;
		expect( map.userData.pbrtUV.type ).toBe( 'planar' );
		expectClose( uvOf( meshes[ 0 ] ), [ 0, 0, 1, 0, 0, 1 ] );

	} );

	it( 'bakes inputs in the first image\'s uv set, one in another as its mean', async () => {

		const { meshes, warnings } = await build( `
			Texture "a" "spectrum" "imagemap" "string filename" "a.png"
			Texture "b" "spectrum" "imagemap" "string filename" "b.png" "string mapping" "planar"
			Texture "m" "spectrum" "mix" "texture tex1" "a" "texture tex2" "b" "float amount" .5
			Material "diffuse" "texture reflectance" "m"
			Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ]
		`, { 'a.png': image( 0, 255 ), 'b.png': image( 255, 255, 255, 255 ) } );

		const map = meshes[ 0 ].material.map;
		expect( map.userData.pbrtUV ).toBeUndefined();
		// ( 0 + 1 ) / 2 and ( 1 + 1 ) / 2, linear, in sRGB bytes.
		expect( Array.from( map.image.data.filter( ( _, i ) => i % 4 === 0 ) ) ).toEqual( [ 188, 255 ] );
		expect( uvOf( meshes[ 0 ] ) ).toEqual( [ 0, 0, 1, 0, 0, 1 ] );
		expect( warnings.filter( ( w ) => /read as their mean/.test( w ) ) ).toHaveLength( 1 );

	} );

	it( 'reads a surface in its base colour\'s uv set, a roughness in another as its mean, said once', async () => {

		const { meshes, warnings } = await build( `
			Texture "color" "spectrum" "imagemap" "string filename" "c.png"
			Texture "rough" "float" "imagemap" "string filename" "r.png" "string encoding" "linear" "string mapping" "planar"
			Material "conductor" "texture reflectance" "color" "texture roughness" "rough"
			Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ]
			Shape "trianglemesh" "point3 P" [ 0 0 1  1 0 1  0 1 1 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ]
			Material "conductor" "texture roughness" "rough"
			Shape "trianglemesh" "point3 P" [ 0 3 0  1 3 0  0 4 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ]
		`, { 'c.png': image( 128 ), 'r.png': image( 0, 255 ) } );

		const [ textured, , metal ] = meshes;
		expect( textured.material.roughnessMap ).toBeNull();
		expect( textured.material.roughness ).toBeCloseTo( 0.5, 2 );
		expect( uvOf( textured ) ).toEqual( [ 0, 0, 1, 0, 0, 1 ] );
		expect( warnings.filter( ( w ) => /one uv set/.test( w ) ) ).toHaveLength( 1 );

		// No base colour: the roughness's own mapping is the surface's.
		expect( metal.material.roughnessMap.userData.pbrtUV.type ).toBe( 'planar' );
		expectClose( uvOf( metal ), [ 0, 3, 1, 3, 0, 4 ] );

	} );

	it( 'leaves a shape that reads its own uv on the geometry it shares', async () => {

		const ply = () => {

			const g = new BufferGeometry();
			g.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ) );
			g.setAttribute( 'uv', new Float32BufferAttribute( [ 0, 0, 1, 0, 0, 1 ], 2 ) );
			return g;

		};

		const { meshes } = await build( `
			Texture "plain" "spectrum" "imagemap" "string filename" "a.png"
			Texture "pages" "spectrum" "imagemap" "string filename" "a.png" "string mapping" "planar" "float udelta" 3
			AttributeBegin Material "diffuse" "texture reflectance" "plain" Shape "plymesh" "string filename" "m.ply" AttributeEnd
			AttributeBegin Material "diffuse" "texture reflectance" "pages" Shape "plymesh" "string filename" "m.ply" AttributeEnd
			AttributeBegin Material "diffuse" "texture reflectance" "plain" Shape "plymesh" "string filename" "m.ply" AttributeEnd
		`, { 'a.png': image( 128 ) }, ply );

		const [ a, mapped, b ] = meshes;
		expect( a.geometry ).toBe( b.geometry );
		expect( uvOf( a ) ).toEqual( [ 0, 0, 1, 0, 0, 1 ] );
		expect( mapped.geometry ).not.toBe( a.geometry );
		expect( mapped.geometry.getAttribute( 'position' ) ).toBe( a.geometry.getAttribute( 'position' ) );
		expectClose( uvOf( mapped ), [ 3, 0, 4, 0, 3, 1 ] );
		expect( a.material.map.userData.pbrtUV ).toBeUndefined();

	} );

} );
