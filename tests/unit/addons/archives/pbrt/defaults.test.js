/**
 * A pbrt parameter left out has pbrt-v4's default. Each directive here is read twice — bare, and with every parameter
 * the importer reads written out at the default pbrt-v4's own Create() gives it (src/pbrt/materials.cpp, lights.cpp,
 * shapes.cpp, cameras.cpp, textures.cpp) — and the two scenes must be the same.
 */

import { describe, it, expect } from 'vitest';
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';

const enc = new TextEncoder();
const TRIANGLE = 'Shape "trianglemesh" "point3 P" [ -1 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0  1 0  0 1 ]';
const CAMERA = 'Camera "perspective" "float fov" 40';
const ILLUMINANT = '"spectrum %s" "stdillum-D65" "float scale" 1';

// [ where it goes: 'camera' | 'world', bare directive, the same with pbrt-v4's defaults written out ]
const CASES = {
	'Material diffuse': [ 'Material "diffuse"', 'Material "diffuse" "rgb reflectance" [ 0.5 0.5 0.5 ]' ],
	'Material coateddiffuse': [ 'Material "coateddiffuse"', 'Material "coateddiffuse" "rgb reflectance" [ 0.5 0.5 0.5 ] "float roughness" 0 "float thickness" 0.01 "float eta" 1.5 "integer maxdepth" 10 "integer nsamples" 1 "float g" 0 "rgb albedo" [ 0 0 0 ] "bool remaproughness" true' ],
	'Material coatedconductor': [ 'Material "coatedconductor"', 'Material "coatedconductor" "float interface.roughness" 0 "float thickness" 0.01 "float interface.eta" 1.5 "spectrum conductor.eta" "metal-Cu-eta" "spectrum conductor.k" "metal-Cu-k" "float conductor.roughness" 0 "integer maxdepth" 10 "integer nsamples" 1 "float g" 0 "rgb albedo" [ 0 0 0 ] "bool remaproughness" true' ],
	'Material conductor': [ 'Material "conductor"', 'Material "conductor" "spectrum eta" "metal-Cu-eta" "spectrum k" "metal-Cu-k" "float roughness" 0 "bool remaproughness" true' ],
	'Material dielectric': [ 'Material "dielectric"', 'Material "dielectric" "float eta" 1.5 "float roughness" 0 "bool remaproughness" true' ],
	'Material thindielectric': [ 'Material "thindielectric"', 'Material "thindielectric" "float eta" 1.5' ],
	'Material diffusetransmission': [ 'Material "diffusetransmission"', 'Material "diffusetransmission" "rgb reflectance" [ 0.25 0.25 0.25 ] "rgb transmittance" [ 0.25 0.25 0.25 ] "float scale" 1' ],
	'Material subsurface': [ 'Material "subsurface"', 'Material "subsurface" "float scale" 1 "float eta" 1.33 "float g" 0 "float roughness" 0 "bool remaproughness" true' ],
	'Material mix': [
		'MakeNamedMaterial "a" "string type" "diffuse"\nMakeNamedMaterial "b" "string type" "conductor"\nMaterial "mix" "string materials" [ "a" "b" ]',
		'MakeNamedMaterial "a" "string type" "diffuse"\nMakeNamedMaterial "b" "string type" "conductor"\nMaterial "mix" "string materials" [ "a" "b" ] "float amount" 0.5',
	],
	'LightSource point': [ 'LightSource "point"', `LightSource "point" ${ILLUMINANT.replace( '%s', 'I' )} "point3 from" [ 0 0 0 ]` ],
	'LightSource spot': [ 'LightSource "spot"', `LightSource "spot" ${ILLUMINANT.replace( '%s', 'I' )} "float coneangle" 30 "float conedeltaangle" 5 "point3 from" [ 0 0 0 ] "point3 to" [ 0 0 1 ]` ],
	'LightSource distant': [ 'LightSource "distant"', `LightSource "distant" ${ILLUMINANT.replace( '%s', 'L' )} "point3 from" [ 0 0 0 ] "point3 to" [ 0 0 1 ]` ],
	'LightSource infinite': [ 'LightSource "infinite"', `LightSource "infinite" ${ILLUMINANT.replace( '%s', 'L' )}` ],
	'AreaLightSource diffuse': [ 'AreaLightSource "diffuse"', `AreaLightSource "diffuse" ${ILLUMINANT.replace( '%s', 'L' )} "bool twosided" false` ],
	'Shape sphere': [ 'Shape "sphere"', 'Shape "sphere" "float radius" 1 "float zmin" -1 "float zmax" 1 "float phimax" 360' ],
	'Shape disk': [ 'Shape "disk"', 'Shape "disk" "float height" 0 "float radius" 1 "float innerradius" 0 "float phimax" 360' ],
	'Shape cylinder': [ 'Shape "cylinder"', 'Shape "cylinder" "float radius" 1 "float zmin" -1 "float zmax" 1 "float phimax" 360' ],
	'Camera perspective': [ 'Camera "perspective"', 'Camera "perspective" "float fov" 90 "float lensradius" 0 "float focaldistance" 1e6', 'camera' ],
	'Camera orthographic': [ 'Camera "orthographic"', 'Camera "orthographic" "float lensradius" 0 "float focaldistance" 1e6', 'camera' ],
	'Texture checkerboard': [
		'Texture "t" "spectrum" "checkerboard"\nMaterial "diffuse" "texture reflectance" "t"',
		'Texture "t" "spectrum" "checkerboard" "rgb tex1" [ 1 1 1 ] "rgb tex2" [ 0 0 0 ] "integer dimension" 2 "string mapping" "uv" "float uscale" 1 "float vscale" 1 "float udelta" 0 "float vdelta" 0\nMaterial "diffuse" "texture reflectance" "t"',
	],
	'Texture checkerboard (float)': [
		'Texture "t" "float" "checkerboard"\nMaterial "dielectric" "texture roughness" "t"',
		'Texture "t" "float" "checkerboard" "float tex1" 1 "float tex2" 0 "integer dimension" 2\nMaterial "dielectric" "texture roughness" "t"',
	],
	'Texture bilerp': [
		'Texture "t" "float" "bilerp"\nMaterial "dielectric" "texture roughness" "t"',
		'Texture "t" "float" "bilerp" "float v00" 0 "float v01" 1 "float v10" 0 "float v11" 1\nMaterial "dielectric" "texture roughness" "t"',
	],
	'Texture constant': [
		'Texture "t" "float" "constant"\nMaterial "dielectric" "texture roughness" "t"',
		'Texture "t" "float" "constant" "float value" 1\nMaterial "dielectric" "texture roughness" "t"',
	],
	'Texture constant (spectrum)': [
		'Texture "t" "spectrum" "constant"\nMaterial "diffuse" "texture reflectance" "t"',
		'Texture "t" "spectrum" "constant" "rgb value" [ 1 1 1 ]\nMaterial "diffuse" "texture reflectance" "t"',
	],
	'Texture scale': [
		'Texture "c" "float" "checkerboard"\nTexture "t" "float" "scale" "texture tex" "c"\nMaterial "dielectric" "texture roughness" "t"',
		'Texture "c" "float" "checkerboard"\nTexture "t" "float" "scale" "texture tex" "c" "float scale" 1\nMaterial "dielectric" "texture roughness" "t"',
	],
	'Texture mix': [
		'Texture "c" "float" "checkerboard"\nTexture "t" "spectrum" "mix" "texture amount" "c"\nMaterial "diffuse" "texture reflectance" "t"',
		'Texture "c" "float" "checkerboard"\nTexture "t" "spectrum" "mix" "texture amount" "c" "rgb tex1" [ 0 0 0 ] "rgb tex2" [ 1 1 1 ]\nMaterial "diffuse" "texture reflectance" "t"',
	],
};

function scene( directive, where ) {

	const camera = where === 'camera' ? directive : CAMERA;
	const world = where === 'camera' ? '' : directive;
	const area = directive.startsWith( 'AreaLightSource' );
	return `LookAt 0 0 5  0 0 0  0 1 0\n${camera}\nFilm "rgb"\nWorldBegin\nAttributeBegin\n${world}\n${area || ! directive.startsWith( 'Shape' ) ? TRIANGLE : ''}\nAttributeEnd\n`;

}

const load = async text => loadPBRTScene( { vfs: { 'scene.pbrt': enc.encode( text ) }, plyParser: () => null, imageFromBytes: async () => null } );

// What a scene renders from, rounded: objects, lights, materials (a texture by its pixels), camera, environment.
function summary( built ) {

	const round = v => ( typeof v === 'number' ? + v.toPrecision( 5 ) : v );
	const pixels = image => {

		const data = image?.data;
		if ( ! data ) return image ? `${image.width}x${image.height}` : null;
		let h = 0;
		for ( let i = 0; i < data.length; i ++ ) h = ( h * 31 + Math.round( data[ i ] * 1000 ) ) | 0;
		return `${image.width}x${image.height}:${h}`;

	};

	const plain = ( value, depth = 0 ) => {

		if ( value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string' ) return value;
		if ( typeof value === 'number' ) return round( value );
		if ( ArrayBuffer.isView( value ) ) return value.length > 64 ? `${value.length} values` : Array.from( value, round );
		if ( Array.isArray( value ) ) return value.map( v => plain( v, depth + 1 ) );
		if ( value.isColor ) return [ value.r, value.g, value.b ].map( round );
		if ( value.isVector2 || value.isVector3 || value.isEuler || value.isQuaternion ) return value.toArray().filter( v => typeof v === 'number' ).map( round );
		if ( value.isTexture ) return { pixels: pixels( value.image ), wrapS: value.wrapS, wrapT: value.wrapT, colorSpace: value.colorSpace, offset: plain( value.offset ), repeat: plain( value.repeat ), rotation: round( value.rotation ) };
		if ( depth > 2 || typeof value !== 'object' ) return undefined;
		return Object.fromEntries( Object.entries( value )// three keeps some material weights behind getters (_clearcoat, _sheen, _transmission, …): read them by name.
			.filter( ( [ k ] ) => k !== '_listeners' && k !== 'uuid' && k !== 'version' && k !== 'name' ).map( ( [ k, v ] ) => [ k.replace( /^_/, '' ), plain( v, depth + 1 ) ] ).filter( ( [ , v ] ) => v !== undefined ) );

	};

	const objects = [];
	built.group.updateMatrixWorld( true );
	built.group.traverse( o => {

		const entry = { type: o.type, matrix: plain( o.matrixWorld.elements ), userData: plain( o.userData ) };
		if ( o.isLight ) Object.assign( entry, { intensity: round( o.intensity ), color: plain( o.color ), width: round( o.width ), height: round( o.height ), angle: round( o.angle ), penumbra: round( o.penumbra ), distance: round( o.distance ), decay: round( o.decay ), target: o.target ? plain( o.target.position ) : null } );
		if ( o.isMesh ) {

			o.geometry.computeBoundingBox();
			const b = o.geometry.boundingBox;
			const position = o.geometry.getAttribute( 'position' );
			let sum = 0;
			for ( let i = 0; i < position.array.length; i ++ ) sum = ( sum * 31 + Math.round( position.array[ i ] * 1e4 ) ) | 0;
			Object.assign( entry, { vertices: position.count, positions: sum, bounds: [ ...b.min.toArray(), ...b.max.toArray() ].map( round ), material: plain( o.material ) } );

		}

		objects.push( entry );

	} );

	const c = built.camera;
	return {
		objects,
		camera: c ? { type: c.type, fov: round( c.fov ), near: round( c.near ), far: round( c.far ), zoom: round( c.zoom ), userData: plain( c.userData ) } : null,
		environment: built.environment ? { texture: plain( built.environment.texture ), rotation: plain( built.environment.rotation ), intensity: round( built.environment.intensity ) } : null,
		render: plain( built.render ),
	};

}

describe( 'pbrt defaults are pbrt-v4\'s', () => {

	// It was read as a number: a named or blackbody spectrum came out NaN.
	it( 'reads a constant texture given as a spectrum', async () => {

		const colour = async value => {

			const built = await load( scene( `Texture "t" "spectrum" "constant" ${value}\nMaterial "diffuse" "texture reflectance" "t"`, 'world' ) );
			let c;
			built.group.traverse( o => o.isMesh && ( c = o.material.color.toArray() ) );
			return c;

		};

		for ( const value of [ '"blackbody value" 3000', '"spectrum value" [ 300 0.4 800 0.4 ]' ] ) {

			const c = await colour( value );
			expect( c.every( Number.isFinite ), value ).toBe( true );

		}

		expect( ( await colour( '"spectrum value" [ 300 0.4 800 0.4 ]' ) )[ 1 ] ).toBeCloseTo( 0.4, 2 );

	} );

	it.each( Object.keys( CASES ) )( '%s', async ( name ) => {

		const [ bare, explicit, where = 'world' ] = CASES[ name ];
		expect( summary( await load( scene( bare, where ) ) ) ).toEqual( summary( await load( scene( explicit, where ) ) ) );

	} );

} );
