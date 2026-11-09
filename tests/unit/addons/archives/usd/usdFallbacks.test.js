/**
 * A USD attribute left unauthored has its schema's fallback. Each prim here is read twice — bare, and with every
 * attribute the translator reads written out at OpenUSD 25.08's fallback (Blender 5.1's pxr: the UsdLux, UsdGeom and
 * Sdr registries) — and the two scenes must be the same.
 */

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import { USDFiles, loadUSDScene } from '@/core/addons/archives/usd/index.js';

const LIGHT = 'float inputs:intensity = 1\n\t\tfloat inputs:exposure = 0\n\t\tcolor3f inputs:color = (1, 1, 1)\n\t\tbool inputs:normalize = 0\n\t\tbool inputs:enableColorTemperature = 0\n\t\tfloat inputs:colorTemperature = 6500\n\t\tfloat inputs:diffuse = 1\n\t\tfloat inputs:specular = 1';

// [ prim header, attributes at OpenUSD's fallbacks, lines both carry ]
const PRIMS = {
	SphereLight: [ 'def SphereLight "L"', `${LIGHT}\n\t\tfloat inputs:radius = 0.5\n\t\tbool treatAsPoint = 0` ],
	RectLight: [ 'def RectLight "L"', `${LIGHT}\n\t\tfloat inputs:width = 1\n\t\tfloat inputs:height = 1` ],
	DiskLight: [ 'def DiskLight "L"', `${LIGHT}\n\t\tfloat inputs:radius = 0.5` ],
	DistantLight: [ 'def DistantLight "L"', LIGHT.replace( 'inputs:intensity = 1', 'inputs:intensity = 50000' ) + '\n\t\tfloat inputs:angle = 0.53' ],
	CylinderLight: [ 'def CylinderLight "L"', `${LIGHT}\n\t\tfloat inputs:radius = 0.5\n\t\tfloat inputs:length = 1\n\t\tbool treatAsLine = 0` ],
	ShapedLight: [ 'def SphereLight "L" ( prepend apiSchemas = ["ShapingAPI"] )', `${LIGHT}\n\t\tfloat inputs:radius = 0.5\n\t\tfloat inputs:shaping:cone:angle = 90\n\t\tfloat inputs:shaping:cone:softness = 0\n\t\tfloat inputs:shaping:focus = 0` ],
	// clippingRange and the apertures are left out: a clip start and a picture shape are taken only where the file
	// authors one (CLAUDE.md, Clip start; docs/guide/scenes.md).
	Camera: [ 'def Camera "C"', 'float focalLength = 50\n\t\tfloat horizontalApertureOffset = 0\n\t\tfloat verticalApertureOffset = 0\n\t\tfloat fStop = 0\n\t\tfloat focusDistance = 0\n\t\ttoken projection = "perspective"' ],
	Sphere: [ 'def Sphere "G"', 'double radius = 1\n\t\tbool doubleSided = 0' ],
	Cube: [ 'def Cube "G"', 'double size = 2\n\t\tbool doubleSided = 0' ],
	Cylinder: [ 'def Cylinder "G"', 'double radius = 1\n\t\tdouble height = 2\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 0' ],
	Cone: [ 'def Cone "G"', 'double radius = 1\n\t\tdouble height = 2\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 0' ],
	Capsule: [ 'def Capsule "G"', 'double radius = 0.5\n\t\tdouble height = 1\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 0' ],
	Plane: [ 'def Plane "G"', 'double width = 2\n\t\tdouble length = 2\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 1' ],
	DomeLight: [ 'def DomeLight "D"', `${LIGHT}\n\t\ttoken inputs:texture:format = "automatic"`, 'asset inputs:texture:file = @sky.hdr@' ],
	Cylinder_1: [ 'def Cylinder_1 "G"', 'double radiusTop = 1\n\t\tdouble radiusBottom = 1\n\t\tdouble height = 2\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 0' ],
	Capsule_1: [ 'def Capsule_1 "G"', 'double radiusTop = 0.5\n\t\tdouble radiusBottom = 0.5\n\t\tdouble height = 1\n\t\ttoken axis = "Z"\n\t\tbool doubleSided = 0' ],
	DomeLight_1: [ 'def DomeLight_1 "D"', `${LIGHT}\n\t\ttoken inputs:texture:format = "automatic"\n\t\tuniform token poleAxis = "scene"`, 'asset inputs:texture:file = @sky.hdr@' ],
};

const PREVIEW = [
	'color3f inputs:diffuseColor = (0.18, 0.18, 0.18)', 'color3f inputs:emissiveColor = (0, 0, 0)', 'int inputs:useSpecularWorkflow = 0',
	'color3f inputs:specularColor = (0, 0, 0)', 'float inputs:metallic = 0', 'float inputs:roughness = 0.5', 'float inputs:clearcoat = 0',
	'float inputs:clearcoatRoughness = 0.01', 'float inputs:opacity = 1', 'token inputs:opacityMode = "transparent"', 'float inputs:opacityThreshold = 0',
	'float inputs:ior = 1.5', 'normal3f inputs:normal = (0, 0, 1)', 'float inputs:displacement = 0', 'float inputs:occlusion = 1',
];

const TEXTURE = [
	'float4 inputs:scale = (1, 1, 1, 1)', 'float4 inputs:bias = (0, 0, 0, 0)', 'float4 inputs:fallback = (0, 0, 0, 1)',
	'token inputs:sourceColorSpace = "auto"', 'token inputs:wrapS = "useMetadata"', 'token inputs:wrapT = "useMetadata"',
];

// MaterialX surfaces' inputs at their defaults, from OpenUSD's Sdr registry (its MaterialX standard library).
const MTLX = {
	ND_open_pbr_surface_surfaceshader: [
		'color3f inputs:base_color = (0.800000011920929, 0.800000011920929, 0.800000011920929)',
		'float inputs:base_diffuse_roughness = 0.0',
		'float inputs:base_metalness = 0.0',
		'float inputs:base_weight = 1.0',
		'color3f inputs:coat_color = (1.0, 1.0, 1.0)',
		'float inputs:coat_darkening = 1.0',
		'float inputs:coat_ior = 1.600000023841858',
		'float inputs:coat_roughness = 0.0',
		'float inputs:coat_roughness_anisotropy = 0.0',
		'float inputs:coat_weight = 0.0',
		'color3f inputs:emission_color = (1.0, 1.0, 1.0)',
		'float inputs:emission_luminance = 0.0',
		'color3f inputs:fuzz_color = (1.0, 1.0, 1.0)',
		'float inputs:fuzz_roughness = 0.5',
		'float inputs:fuzz_weight = 0.0',
		'float inputs:geometry_opacity = 1.0',
		'bool inputs:geometry_thin_walled = 0',
		'color3f inputs:specular_color = (1.0, 1.0, 1.0)',
		'float inputs:specular_ior = 1.5',
		'float inputs:specular_roughness = 0.30000001192092896',
		'float inputs:specular_roughness_anisotropy = 0.0',
		'float inputs:specular_weight = 1.0',
		'color3f inputs:subsurface_color = (0.800000011920929, 0.800000011920929, 0.800000011920929)',
		'float inputs:subsurface_radius = 1.0',
		'color3f inputs:subsurface_radius_scale = (1.0, 0.5, 0.25)',
		'float inputs:subsurface_scatter_anisotropy = 0.0',
		'float inputs:subsurface_weight = 0.0',
		'float inputs:thin_film_ior = 1.399999976158142',
		'float inputs:thin_film_thickness = 0.5',
		'float inputs:thin_film_weight = 0.0',
		'color3f inputs:transmission_color = (1.0, 1.0, 1.0)',
		'float inputs:transmission_depth = 0.0',
		'float inputs:transmission_dispersion_abbe_number = 20.0',
		'float inputs:transmission_dispersion_scale = 0.0',
		'color3f inputs:transmission_scatter = (0.0, 0.0, 0.0)',
		'float inputs:transmission_scatter_anisotropy = 0.0',
		'float inputs:transmission_weight = 0.0',
	],
	ND_standard_surface_surfaceshader: [
		'float inputs:base = 1.0',
		'color3f inputs:base_color = (0.800000011920929, 0.800000011920929, 0.800000011920929)',
		'float inputs:coat = 0.0',
		'float inputs:coat_IOR = 1.5',
		'float inputs:coat_affect_color = 0.0',
		'float inputs:coat_affect_roughness = 0.0',
		'float inputs:coat_anisotropy = 0.0',
		'color3f inputs:coat_color = (1.0, 1.0, 1.0)',
		'float inputs:coat_rotation = 0.0',
		'float inputs:coat_roughness = 0.10000000149011612',
		'float inputs:diffuse_roughness = 0.0',
		'float inputs:emission = 0.0',
		'color3f inputs:emission_color = (1.0, 1.0, 1.0)',
		'float inputs:metalness = 0.0',
		'color3f inputs:opacity = (1.0, 1.0, 1.0)',
		'float inputs:sheen = 0.0',
		'color3f inputs:sheen_color = (1.0, 1.0, 1.0)',
		'float inputs:sheen_roughness = 0.30000001192092896',
		'float inputs:specular = 1.0',
		'float inputs:specular_IOR = 1.5',
		'float inputs:specular_anisotropy = 0.0',
		'color3f inputs:specular_color = (1.0, 1.0, 1.0)',
		'float inputs:specular_rotation = 0.0',
		'float inputs:specular_roughness = 0.20000000298023224',
		'float inputs:subsurface = 0.0',
		'float inputs:subsurface_anisotropy = 0.0',
		'color3f inputs:subsurface_color = (1.0, 1.0, 1.0)',
		'color3f inputs:subsurface_radius = (1.0, 1.0, 1.0)',
		'float inputs:subsurface_scale = 1.0',
		'float inputs:thin_film_IOR = 1.5',
		'float inputs:thin_film_thickness = 0.0',
		'bool inputs:thin_walled = 0',
		'float inputs:transmission = 0.0',
		'color3f inputs:transmission_color = (1.0, 1.0, 1.0)',
		'float inputs:transmission_depth = 0.0',
		'float inputs:transmission_dispersion = 0.0',
		'float inputs:transmission_extra_roughness = 0.0',
		'color3f inputs:transmission_scatter = (0.0, 0.0, 0.0)',
		'float inputs:transmission_scatter_anisotropy = 0.0',
	],
	ND_gltf_pbr_surfaceshader: [
		'float inputs:alpha = 1.0',
		'float inputs:alpha_cutoff = 0.5',
		'int inputs:alpha_mode = 0',
		'float inputs:anisotropy_rotation = 0.0',
		'float inputs:anisotropy_strength = 0.0',
		'color3f inputs:attenuation_color = (1.0, 1.0, 1.0)',
		'color3f inputs:base_color = (1.0, 1.0, 1.0)',
		'float inputs:clearcoat = 0.0',
		'float inputs:clearcoat_roughness = 0.0',
		'color3f inputs:emissive = (0.0, 0.0, 0.0)',
		'float inputs:emissive_strength = 1.0',
		'float inputs:ior = 1.5',
		'float inputs:iridescence = 0.0',
		'float inputs:iridescence_ior = 1.2999999523162842',
		'float inputs:iridescence_thickness = 100.0',
		'float inputs:metallic = 1.0',
		'float inputs:occlusion = 1.0',
		'float inputs:roughness = 1.0',
		'color3f inputs:sheen_color = (0.0, 0.0, 0.0)',
		'float inputs:sheen_roughness = 0.0',
		'float inputs:specular = 1.0',
		'color3f inputs:specular_color = (1.0, 1.0, 1.0)',
		'float inputs:thickness = 0.0',
		'float inputs:transmission = 0.0',
	],
};

// [ surface, its weights turned on ]
const WEIGHTED = {
	'OpenPBR transmission': [ 'ND_open_pbr_surface_surfaceshader', [ 'float inputs:transmission_weight = 1' ]],
	'OpenPBR transmission, deep': [ 'ND_open_pbr_surface_surfaceshader', [ 'float inputs:transmission_weight = 1', 'float inputs:transmission_depth = 0.5' ]],
	'OpenPBR subsurface': [ 'ND_open_pbr_surface_surfaceshader', [ 'float inputs:subsurface_weight = 1' ]],
	'OpenPBR coat, fuzz, thin film': [ 'ND_open_pbr_surface_surfaceshader', [ 'float inputs:coat_weight = 1', 'float inputs:fuzz_weight = 1', 'float inputs:thin_film_weight = 1' ]],
	'Standard Surface transmission': [ 'ND_standard_surface_surfaceshader', [ 'float inputs:transmission = 1' ]],
	'Standard Surface transmission, deep': [ 'ND_standard_surface_surfaceshader', [ 'float inputs:transmission = 1', 'float inputs:transmission_depth = 0.5' ]],
	'Standard Surface subsurface': [ 'ND_standard_surface_surfaceshader', [ 'float inputs:subsurface = 1' ]],
	'Standard Surface coat, sheen, thin film': [ 'ND_standard_surface_surfaceshader', [ 'float inputs:coat = 1', 'float inputs:sheen = 1', 'float inputs:thin_film_thickness = 500' ]],
	'glTF PBR transmission, clearcoat, iridescence': [ 'ND_gltf_pbr_surfaceshader', [ 'float inputs:transmission = 1', 'float inputs:clearcoat = 1', 'float inputs:iridescence = 1' ]],
	'UsdPreviewSurface specular workflow, clearcoat': [ 'UsdPreviewSurface', [ 'int inputs:useSpecularWorkflow = 1', 'float inputs:clearcoat = 1' ]],
};

const usda = body => `#usda 1.0\n${body}\n`;

const mtlxSurface = ( id, inputs ) => usda( `
def Mesh "M" ( prepend apiSchemas = ["MaterialBindingAPI"] )
{
	int[] faceVertexCounts = [3]
	int[] faceVertexIndices = [0, 1, 2]
	point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
	rel material:binding = </Mat>
}
def Material "Mat"
{
	token outputs:mtlx:surface.connect = </Mat/S.outputs:out>
	def Shader "S"
	{
		uniform token info:id = "${id}"
		${inputs.join( '\n\t\t' )}
		token outputs:out
	}
}` );

const surface = ( shaderInputs, textureInputs = null ) => usda( `
def Mesh "M" ( prepend apiSchemas = ["MaterialBindingAPI"] )
{
	int[] faceVertexCounts = [3]
	int[] faceVertexIndices = [0, 1, 2]
	point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
	texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] ( interpolation = "vertex" )
	rel material:binding = </Mat>
}
def Material "Mat"
{
	token outputs:surface.connect = </Mat/S.outputs:surface>
	def Shader "S"
	{
		uniform token info:id = "UsdPreviewSurface"
		${shaderInputs.join( '\n\t\t' )}
		${textureInputs ? 'color3f inputs:diffuseColor.connect = </Mat/T.outputs:rgb>' : ''}
		token outputs:surface
	}
	${textureInputs ? `def Shader "T"
	{
		uniform token info:id = "UsdUVTexture"
		asset inputs:file = @tex.png@
		${textureInputs.join( '\n\t\t' )}
		float3 outputs:rgb
	}` : ''}
}` );

async function load( text ) {

	const bytes = new TextEncoder().encode( text );
	const files = new USDFiles( [ 'root.usda', 'tex.png', 'sky.hdr' ], async path => ( path === 'root.usda' ? bytes : [ 'tex.png', 'sky.hdr' ].includes( path ) ? new Uint8Array( 8 ) : null ) );
	return loadUSDScene( {
		files, entryPath: 'root.usda',
		resolveImage: async path => Object.assign( new Texture(), { name: path } ),
		resolveEnvironment: async path => Object.assign( new Texture(), { name: path } ),
	} );

}

// What a scene renders from: every object's kind, placement and the properties the engine reads, rounded.
function describe_( built ) {

	const round = v => ( typeof v === 'number' ? + v.toPrecision( 6 ) : v );
	const plain = ( value, depth = 0 ) => {

		if ( value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string' ) return value;
		if ( typeof value === 'number' ) return round( value );
		if ( ArrayBuffer.isView( value ) ) return Array.from( value, round );
		if ( Array.isArray( value ) ) return value.map( v => plain( v, depth + 1 ) );
		if ( value.isColor ) return [ value.r, value.g, value.b ].map( round );
		if ( value.isVector2 || value.isVector3 || value.isEuler || value.isQuaternion ) return value.toArray().filter( v => typeof v === 'number' ).map( round );
		if ( value.isTexture ) return { name: value.name, wrapS: value.wrapS, wrapT: value.wrapT, colorSpace: value.colorSpace, offset: plain( value.offset ), repeat: plain( value.repeat ), rotation: round( value.rotation ), channel: value.channel };
		if ( depth > 2 || typeof value !== 'object' ) return undefined;
		return Object.fromEntries( Object.entries( value )// three keeps some material weights behind getters (_clearcoat, _sheen, _transmission, …): read them by name.
			.filter( ( [ k ] ) => k !== '_listeners' && k !== 'uuid' && k !== 'version' ).map( ( [ k, v ] ) => [ k.replace( /^_/, '' ), plain( v, depth + 1 ) ] ).filter( ( [ , v ] ) => v !== undefined ) );

	};

	const out = [];
	built.group.updateMatrixWorld( true );
	built.group.traverse( o => {

		const entry = { type: o.type, matrix: plain( o.matrixWorld.elements ), userData: plain( o.userData ) };
		if ( o.isLight ) Object.assign( entry, { intensity: round( o.intensity ), color: plain( o.color ), width: round( o.width ), height: round( o.height ), angle: round( o.angle ), penumbra: round( o.penumbra ), distance: round( o.distance ), decay: round( o.decay ) } );
		if ( o.isCamera ) Object.assign( entry, { fov: round( o.fov ), aspect: round( o.aspect ), near: round( o.near ), far: round( o.far ), zoom: round( o.zoom ), filmGauge: round( o.filmGauge ) } );
		if ( o.isMesh ) {

			const p = o.geometry.getAttribute( 'position' );
			entry.vertices = p.count;
			entry.bounds = plain( ( o.geometry.computeBoundingBox(), [ ...o.geometry.boundingBox.min.toArray(), ...o.geometry.boundingBox.max.toArray() ] ) );
			entry.material = plain( o.material );

		}

		out.push( entry );

	} );
	const environment = built.environment && { texture: built.environment.texture?.name, rotation: plain( built.environment.rotation ), intensity: round( built.environment.intensity ) };
	return { objects: out, environment, cameras: ( built.cameras ?? [] ).map( c => ( { fov: round( c.fov ), aspect: round( c.aspect ), userData: plain( c.userData ) } ) ), render: plain( built.render ) };

}

describe( 'USD fallbacks are OpenUSD\'s', () => {

	it.each( Object.keys( PRIMS ) )( '%s', async ( name ) => {

		const [ head, attributes, both = '' ] = PRIMS[ name ];
		const bare = await load( usda( `${head}\n{\n\t\t${both}\n}` ) );
		const explicit = await load( usda( `${head}\n{\n\t\t${both}\n\t\t${attributes}\n}` ) );
		expect( describe_( bare ) ).toEqual( describe_( explicit ) );

	} );

	it( 'UsdPreviewSurface', async () => {

		expect( describe_( await load( surface( [] ) ) ) ).toEqual( describe_( await load( surface( PREVIEW ) ) ) );

	} );

	it.each( Object.keys( MTLX ) )( '%s', async ( id ) => {

		expect( describe_( await load( mtlxSurface( id, [] ) ) ) ).toEqual( describe_( await load( mtlxSurface( id, MTLX[ id ] ) ) ) );

	} );

	// The inputs behind a weight whose fallback is 0, reached with the weight on in both.
	it.each( Object.entries( WEIGHTED ) )( '%s', async ( name, [ id, on ] ) => {

		const set = new Set( on.map( line => line.split( ' = ' )[ 0 ].split( ' ' ).pop() ) );
		const explicit = [ ...on, ...( MTLX[ id ] ?? PREVIEW ).filter( line => ! set.has( line.split( ' = ' )[ 0 ].split( ' ' ).pop() ) ) ];
		const build = inputs => ( id === 'UsdPreviewSurface' ? surface( inputs ) : mtlxSurface( id, inputs ) );
		expect( describe_( await load( build( on ) ) ) ).toEqual( describe_( await load( build( explicit ) ) ) );

	} );

	it( 'UsdUVTexture', async () => {

		expect( describe_( await load( surface( [], [] ) ) ) ).toEqual( describe_( await load( surface( [], TEXTURE ) ) ) );

	} );

} );
