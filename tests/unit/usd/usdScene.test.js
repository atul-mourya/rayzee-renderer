import { describe, it, expect } from 'vitest';
import { Vector3, Matrix4, Texture, SRGBColorSpace, MirroredRepeatWrapping, ClampToEdgeWrapping } from 'three';
import { USDFiles, loadUSDScene } from '@/core/Processor/USD/index.js';

const usda = body => `#usda 1.0\n${body}\n`;

async function load( layers, entryPath = 'root.usda', options = {} ) {

	const encoder = new TextEncoder();
	const files = new USDFiles( Object.keys( layers ), async path => ( layers[ path ] === undefined ? null : encoder.encode( layers[ path ] ) ) );
	return loadUSDScene( {
		files, entryPath,
		resolveImage: async () => null,
		resolveEnvironment: async path => Object.assign( new Texture(), { name: path } ),
		...options,
	} );

}

const meshes = group => {

	const out = [];
	group.traverse( o => o.isMesh && out.push( o ) );
	return out;

};

/** Every triangle corner in world space, for an instanced mesh once per instance. */
function worldCorners( mesh ) {

	mesh.updateMatrixWorld( true );
	const position = mesh.geometry.getAttribute( 'position' );
	const index = mesh.geometry.index;
	const placements = mesh.isInstancedMesh ? Array.from( { length: mesh.count }, ( _, i ) => {

		const m = new Matrix4();
		mesh.getMatrixAt( i, m );
		return m.premultiply( mesh.matrixWorld );

	} ) : [ mesh.matrixWorld ];
	return placements.map( m => Array.from( { length: index.count }, ( _, k ) => new Vector3().fromBufferAttribute( position, index.getX( k ) ).applyMatrix4( m ) ) );

}

describe( 'USD geometry', () => {

	it( 'triangulates polygons, reversing a left-handed winding, and places them by their xformOps', async () => {

		const { group } = await load( { 'root.usda': usda( `def Xform "a"
{
    double3 xformOp:translate = (10, 0, 0)
    float3 xformOp:rotateXYZ = (0, 90, 0)
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]
    def Mesh "quad"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        uniform token orientation = "leftHanded"
    }
}` ) } );

		const [ mesh ] = meshes( group );
		expect( mesh.geometry.index.count ).toBe( 6 );
		const [ corners ] = worldCorners( mesh );
		// rotateY 90° then translate: (1, 0, 0) lands at (10, 0, -1).
		expect( corners.some( p => p.distanceTo( new Vector3( 10, 0, - 1 ) ) < 1e-5 ) ).toBe( true );
		const [ a, b, c ] = corners;
		const facing = new Vector3().subVectors( b, a ).cross( new Vector3().subVectors( c, a ) );
		// Left-handed: the winding is reversed, so the quad faces local -Z, which the turn sends to -X.
		expect( facing.x ).toBeLessThan( 0 );

	} );

	it( 'turns a Z-up stage Y-up', async () => {

		const { group } = await load( { 'root.usda': usda( `(
    upAxis = "Z"
)
def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 5), (1, 0, 5), (0, 1, 5)]
}` ) } );

		const [ corners ] = worldCorners( meshes( group )[ 0 ] );
		expect( corners[ 0 ].y ).toBeCloseTo( 5, 5 );

	} );

	it( 'skips invisible, inactive and guide prims', async () => {

		const tri = name => `def Mesh "${name}"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}`;
		const { group } = await load( { 'root.usda': usda( `def Xform "hidden"
{
    token visibility = "invisible"
    ${tri( 'a' )}
}
def Xform "off" ( active = false )
{
    ${tri( 'b' )}
}
def Xform "guide"
{
    uniform token purpose = "guide"
    ${tri( 'c' )}
}
${tri( 'd' )}` ) } );

		expect( meshes( group ) ).toHaveLength( 1 );

	} );

	it( 'shares one template between instanceable prims of the same arcs', async () => {

		const { group } = await load( {
			'root.usda': usda( `def Xform "copies"
{
    def Xform "one" ( instanceable = true
        prepend references = @./thing.usda@ )
    {
        double3 xformOp:translate = (0, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def Xform "two" ( instanceable = true
        prepend references = @./thing.usda@ )
    {
        double3 xformOp:translate = (5, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
}` ),
			'thing.usda': usda( `(
    defaultPrim = "thing"
)
def Xform "thing"
{
    def Mesh "tri"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}` ),
		} );

		const [ mesh ] = meshes( group );
		expect( mesh.isInstancedMesh ).toBe( true );
		expect( mesh.count ).toBe( 2 );
		const xs = worldCorners( mesh ).map( corners => Math.round( corners[ 0 ].x ) ).sort( ( a, b ) => a - b );
		expect( xs ).toEqual( [ 0, 5 ] );

	} );

	it( 'places a point instancer\'s prototypes: translate, orient, scale, then the prototype\'s own transform', async () => {

		const { group } = await load( { 'root.usda': usda( `def PointInstancer "scatter"
{
    point3f[] positions = [(10, 0, 0), (0, 0, 10)]
    quath[] orientations = [(1, 0, 0, 0), (0.70710677, 0, 0.70710677, 0)]
    float3[] scales = [(1, 1, 1), (2, 2, 2)]
    int[] protoIndices = [0, 0]
    int64[] invisibleIds = []
    prepend rel prototypes = </scatter/proto>
    def Xform "proto"
    {
        double3 xformOp:translate = (1, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
        def Mesh "tri"
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (0, 1, 0), (0, 0, 1)]
        }
    }
}` ) } );

		const [ mesh ] = meshes( group );
		expect( mesh.count ).toBe( 2 );
		const sorted = worldCorners( mesh ).map( corners => corners[ 0 ].toArray().map( v => Math.round( v * 1000 ) / 1000 + 0 ) ).sort();
		// The second: scaled 2, turned 90° about Y (+X → -Z), then moved to (0, 0, 10): the prototype's (1, 0, 0) → (0, 0, 8).
		expect( sorted ).toContainEqual( [ 11, 0, 0 ] );
		expect( sorted ).toContainEqual( [ 0, 0, 8 ] );

	} );

	it( 'tessellates basis curves into strips', async () => {

		const { group } = await load( { 'root.usda': usda( `def BasisCurves "leaves"
{
    uniform token type = "cubic"
    uniform token basis = "bspline"
    int[] curveVertexCounts = [6, 6]
    point3f[] points = [(0,0,0),(0,0,0),(0,1,0),(0,2,0),(0,3,0),(0,3,0), (1,0,0),(1,0,0),(1,1,0),(1,2,0),(1,3,0),(1,3,0)]
    float[] widths = [0.1, 0.1, 0.4, 0.4, 0.1, 0.1, 0.1, 0.1, 0.4, 0.4, 0.1, 0.1] ( interpolation = "vertex" )
    normal3f[] normals = [(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1),(0,0,1)] ( interpolation = "vertex" )
}` ) } );

		const [ mesh ] = meshes( group );
		expect( mesh.geometry.index.count ).toBeGreaterThan( 0 );
		mesh.geometry.computeBoundingBox();
		const { min, max } = mesh.geometry.boundingBox;
		// Two strips side by side, a ribbon facing +Z: flat in Z, about as wide as the widest point.
		expect( max.z - min.z ).toBeLessThan( 1e-6 );
		expect( max.x - min.x ).toBeGreaterThan( 1 );
		expect( max.x - min.x ).toBeLessThan( 1.5 );

	} );

} );

describe( 'USD materials', () => {

	const scene = ( material, meshExtra = '' ) => ( { 'root.usda': usda( `def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </mat>
    ${meshExtra}
}
def Material "mat"
{
${material}
}` ) } );

	it( 'reads PxrDisneyBsdf through its colour correction, as Moana\'s BaseMaterial wires it', async () => {

		const { group } = await load( scene( `    color3f inputs:baseColor = (0.5, 0.25, 1)
    float inputs:metallic = 0.25
    float inputs:roughness = 0.6
    float inputs:clearcoat = 1
    float inputs:clearcoatGloss = 1
    token outputs:ri:surface.connect = </mat/bsdf.outputs:bxdf_out>
    def Shader "bsdf"
    {
        uniform token info:id = "PxrDisneyBsdf"
        color3f inputs:baseColor.connect = </mat/cc.outputs:resultRGB>
        float inputs:metallic.connect = </mat.inputs:metallic>
        float inputs:roughness.connect = </mat.inputs:roughness>
        float inputs:clearcoat.connect = </mat.inputs:clearcoat>
        float inputs:clearcoatGloss.connect = </mat.inputs:clearcoatGloss>
    }
    def Shader "cc"
    {
        uniform token info:id = "PxrColorCorrect"
        color3f inputs:gamma = (0.5, 0.5, 0.5)
        color3f inputs:inputRGB.connect = </mat.inputs:baseColor>
    }` ) );

		const { material } = meshes( group )[ 0 ];
		// gamma 0.5 raises to the power 2; then the colour sits on an 8-bit grid.
		expect( material.color.r ).toBeCloseTo( 0.25, 2 );
		expect( material.color.g ).toBeCloseTo( 0.0625, 2 );
		expect( material.color.b ).toBeCloseTo( 1, 2 );
		expect( material.metalness ).toBeCloseTo( 0.25 );
		expect( material.roughness ).toBeCloseTo( 0.6 );
		expect( material.clearcoat ).toBeCloseTo( 0.25 );
		expect( material.clearcoatRoughness ).toBeCloseTo( Math.sqrt( 0.001 ), 5 );

	} );

	it( 'takes a Ptex colour from the mesh\'s baked displayColor, corrected the same way', async () => {

		const { group } = await load( scene( `    token outputs:ri:surface.connect = </mat/bsdf.outputs:bxdf_out>
    def Shader "bsdf"
    {
        uniform token info:id = "PxrDisneyBsdf"
        color3f inputs:baseColor.connect = </mat/cc.outputs:resultRGB>
    }
    def Shader "cc"
    {
        uniform token info:id = "PxrColorCorrect"
        color3f inputs:gamma = (0.5, 0.5, 0.5)
        color3f inputs:inputRGB.connect = </mat/ptex.outputs:resultRGB>
    }
    def Shader "ptex"
    {
        uniform token info:id = "PxrPtexture"
        asset inputs:filename = @./tex/rock.ptx@
    }`, 'color3f[] primvars:displayColor = [(0.2, 0.4, 0.6), (0.4, 0.6, 0.8), (0.6, 0.8, 1)] ( interpolation = "vertex" )' ) );

		const { material } = meshes( group )[ 0 ];
		expect( material.color.r ).toBeCloseTo( 0.16, 2 );
		expect( material.color.g ).toBeCloseTo( 0.36, 2 );
		expect( material.color.b ).toBeCloseTo( 0.64, 2 );

	} );

	it( 'reads UsdPreviewSurface, and colours an unbound mesh by its displayColor', async () => {

		const preview = await load( scene( `    token outputs:surface.connect = </mat/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (0.1, 0.2, 0.3)
        float inputs:roughness = 0.3
        float inputs:metallic = 1
    }` ) );
		const { material } = meshes( preview.group )[ 0 ];
		expect( material.color.toArray().map( v => Math.round( v * 100 ) / 100 ) ).toEqual( [ 0.1, 0.2, 0.3 ] );
		expect( material.roughness ).toBeCloseTo( 0.3 );
		expect( material.metalness ).toBe( 1 );

		const plain = await load( { 'root.usda': usda( `def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    color3f[] primvars:displayColor = [(0.5, 0.5, 0.25)]
}` ) } );
		expect( meshes( plain.group )[ 0 ].material.color.b ).toBeCloseTo( 0.25, 2 );

	} );

	it( 'splits a mesh by its material subsets', async () => {

		const { group } = await load( { 'root.usda': usda( `def Mesh "two"
{
    int[] faceVertexCounts = [3, 3]
    int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    def GeomSubset "red"
    {
        uniform token elementType = "face"
        uniform token familyName = "materialBind"
        int[] indices = [1]
        rel material:binding = </red>
    }
}
def Material "red"
{
    token outputs:surface.connect = </red/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (1, 0, 0)
    }
}` ) } );

		const parts = meshes( group );
		expect( parts ).toHaveLength( 2 );
		expect( parts.map( m => m.geometry.index.count ).sort() ).toEqual( [ 3, 3 ] );
		expect( parts.some( m => m.material.color.r === 1 && m.material.color.g === 0 ) ).toBe( true );

	} );

} );

describe( 'USD MaterialX', () => {

	const scene = ( material, extra = '' ) => ( { 'root.usda': usda( `def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
        interpolation = "vertex"
    )
    rel material:binding = </mat>
}
def Material "mat"
{
${material}
}
${extra}` ), 'wood.png': '', 'rough.png': '', 'normal.png': '', 'leather.png': '' } );
	const images = { resolveImage: async path => Object.assign( new Texture(), { name: path } ) };
	const materialOf = async ( layers, options ) => {

		const result = await load( layers, 'root.usda', options );
		return { material: meshes( result.group )[ 0 ].material, result };

	};

	it( 'reads OpenPBR, which Blender writes for its Principled BSDF, ahead of the preview surface beside it', async () => {

		const { material } = await materialOf( scene( `    token outputs:mtlx:surface.connect = </mat/pbr.outputs:surface>
    token outputs:surface.connect = </mat/preview.outputs:surface>
    def Shader "preview"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (0, 1, 0)
    }
    def Shader "pbr"
    {
        uniform token info:id = "ND_open_pbr_surface_surfaceshader"
        color3f inputs:base_color = (0.8, 0.4, 0.2)
        float inputs:base_weight = 0.5
        float inputs:base_metalness = 0.25
        float inputs:specular_roughness = 0.35
        float inputs:specular_ior = 1.45
        float inputs:base_diffuse_roughness = 0.6
        float inputs:coat_weight = 0.5
        float inputs:coat_roughness = 0.1
        float inputs:fuzz_weight = 1
        color3f inputs:fuzz_color = (1, 0, 0)
        float inputs:thin_film_weight = 1
        float inputs:thin_film_thickness = 0.3
        float inputs:emission_luminance = 2
        color3f inputs:emission_color = (1, 0.5, 0.25)
        float inputs:transmission_weight = 1
        color3f inputs:transmission_color = (0.5, 1, 1)
        float inputs:transmission_depth = 2
        float inputs:subsurface_weight = 0.5
        color3f inputs:subsurface_color = (1, 0.5, 0.5)
        float inputs:subsurface_radius = 0.1
        color3f inputs:subsurface_radius_scale = (1, 0.2, 0.1)
    }` ) );

		expect( material.color.toArray() ).toEqual( [ 0.4, 0.2, 0.1 ] );
		expect( [ material.metalness, material.roughness, material.ior, material.diffuseRoughness ] ).toEqual( [ 0.25, 0.35, 1.45, 0.6 ] );
		expect( [ material.clearcoat, material.clearcoatRoughness ] ).toEqual( [ 0.5, 0.1 ] );
		expect( [ material.sheen, ...material.sheenColor.toArray() ] ).toEqual( [ 1, 1, 0, 0 ] );
		expect( [ material.iridescence, ...material.iridescenceThicknessRange ] ).toEqual( [ 1, 300, 300 ] );
		expect( [ ...material.emissive.toArray(), material.emissiveIntensity ] ).toEqual( [ 1, 0.5, 0.25, 2 ] );
		expect( [ material.transmission, ...material.attenuationColor.toArray(), material.attenuationDistance ] ).toEqual( [ 1, 0.5, 1, 1, 2 ] );
		expect( [ material.subsurface, material.subsurfaceRadiusScale, ...material.subsurfaceRadius ] ).toEqual( [ 0.5, 0.1, 1, 0.2, 0.1 ] );

	} );

	it( 'places a texture by Blender\'s Mapping chain, with its gain, wrap, colour space, a grey roughness map and a normal map', async () => {

		const { material } = await materialOf( scene( `    token outputs:mtlx:surface.connect = </mat/pbr.outputs:surface>
    def Shader "pbr"
    {
        uniform token info:id = "ND_open_pbr_surface_surfaceshader"
        color3f inputs:base_color.connect = </mat/graph.outputs:color>
        float inputs:specular_roughness.connect = </mat/graph.outputs:rough>
        float3 inputs:geometry_normal.connect = </mat/graph.outputs:normal>
    }
    def NodeGraph "graph"
    {
        color3f outputs:color.connect = </mat/graph/tint.outputs:out>
        float outputs:rough.connect = </mat/graph/rough.outputs:out>
        float3 outputs:normal.connect = </mat/graph/nmap.outputs:out>
        def Shader "uv"
        {
            uniform token info:id = "ND_texcoord_vector2"
        }
        def Shader "to3"
        {
            uniform token info:id = "ND_convert_vector2_vector3"
            float2 inputs:in.connect = </mat/graph/uv.outputs:out>
        }
        def Shader "scale"
        {
            uniform token info:id = "ND_multiply_vector3"
            float3 inputs:in1.connect = </mat/graph/to3.outputs:out>
            float3 inputs:in2 = (2, 4, 1)
        }
        def Shader "turn"
        {
            uniform token info:id = "ND_rotate3d_vector3"
            float3 inputs:in.connect = </mat/graph/scale.outputs:out>
            float inputs:amount = 90
            float3 inputs:axis = (0, 0, 1)
        }
        def Shader "move"
        {
            uniform token info:id = "ND_add_vector3"
            float3 inputs:in1.connect = </mat/graph/turn.outputs:out>
            float3 inputs:in2 = (0.5, 0.25, 0)
        }
        def Shader "to2"
        {
            uniform token info:id = "ND_convert_vector3_vector2"
            float3 inputs:in.connect = </mat/graph/move.outputs:out>
        }
        def Shader "img"
        {
            uniform token info:id = "ND_image_color4"
            asset inputs:file = @./wood.png@ (
                colorSpace = "srgb_texture"
            )
            float2 inputs:texcoord.connect = </mat/graph/to2.outputs:out>
            string inputs:uaddressmode = "mirror"
            string inputs:vaddressmode = "clamp"
        }
        def Shader "rgb"
        {
            uniform token info:id = "ND_convert_color4_color3"
            color4f inputs:in.connect = </mat/graph/img.outputs:out>
        }
        def Shader "tint"
        {
            uniform token info:id = "ND_multiply_color3"
            color3f inputs:in1.connect = </mat/graph/rgb.outputs:out>
            color3f inputs:in2 = (0.5, 0.25, 1)
        }
        def Shader "rough"
        {
            uniform token info:id = "ND_image_float"
            asset inputs:file = @./rough.png@
        }
        def Shader "nimg"
        {
            uniform token info:id = "ND_image_vector3"
            asset inputs:file = @./normal.png@
        }
        def Shader "nmap"
        {
            uniform token info:id = "ND_normalmap_float"
            float3 inputs:in.connect = </mat/graph/nimg.outputs:out>
            float inputs:scale = 0.5
        }
    }` ), images );

		// Scaled (2, 4), turned 90° as MaterialX's rotate3d turns, moved (0.5, 0.25): u' = 4v + 0.5, v' = −2u + 0.25.
		expect( material.map.matrixAutoUpdate ).toBe( false );
		expect( Array.from( material.map.matrix.elements ).map( v => Math.round( v * 1e6 ) / 1e6 + 0 ) ).toEqual( [ 0, - 2, 0, 4, 0, 0, 0.5, 0.25, 1 ] );
		expect( [ material.map.colorSpace, material.map.wrapS, material.map.wrapT ] ).toEqual( [ SRGBColorSpace, MirroredRepeatWrapping, ClampToEdgeWrapping ] );
		expect( material.color.toArray() ).toEqual( [ 0.5, 0.25, 1 ] );
		expect( material.roughnessMap.userData.usdPath ).toMatch( /rough\.png$/ );
		expect( material.roughness ).toBe( 1 );
		expect( material.normalMap.userData.usdPath ).toMatch( /normal\.png$/ );
		expect( material.normalScale.toArray() ).toEqual( [ 0.5, 0.5 ] );

	} );

	it( 'keeps a texture blended with a colour, falls back past a node it cannot read, and says so', async () => {

		const { material, result } = await materialOf( scene( `    token outputs:mtlx:surface.connect = </mat/pbr.outputs:surface>
    def Shader "pbr"
    {
        uniform token info:id = "ND_open_pbr_surface_surfaceshader"
        color3f inputs:base_color.connect = </mat/blend.outputs:out>
        color3f inputs:specular_color.connect = </mat/noise.outputs:out>
    }
    def Shader "img"
    {
        uniform token info:id = "ND_image_color3"
        asset inputs:file = @./leather.png@
    }
    def Shader "blend"
    {
        uniform token info:id = "ND_mix_color3"
        color3f inputs:fg.connect = </mat/img.outputs:out>
        color3f inputs:bg = (0.5, 0.5, 0.5)
        float inputs:mix = 0.7
    }
    def Shader "noise"
    {
        uniform token info:id = "ND_noise3d_color3"
    }` ), images );

		expect( material.map.userData.usdPath ).toMatch( /leather\.png$/ );
		expect( material.specularColor.toArray() ).toEqual( [ 1, 1, 1 ] );
		expect( result.warnings.some( w => /mixes of a texture/.test( w ) ) ).toBe( true );
		expect( result.warnings.some( w => /MaterialX node "noise3d"/.test( w ) ) ).toBe( true );

	} );

	it( 'reads Standard Surface and glTF PBR', async () => {

		const standard = await materialOf( scene( `    token outputs:mtlx:surface.connect = </mat/ss.outputs:out>
    def Shader "ss"
    {
        uniform token info:id = "ND_standard_surface_surfaceshader"
        float inputs:base = 0.5
        color3f inputs:base_color = (1, 0.5, 0)
        float inputs:metalness = 1
        float inputs:specular_roughness = 0.4
        float inputs:diffuse_roughness = 0.3
        float inputs:coat = 1
        float inputs:emission = 3
        color3f inputs:emission_color = (0, 1, 0)
    }` ) );
		expect( standard.material.color.toArray() ).toEqual( [ 0.5, 0.25, 0 ] );
		expect( [ standard.material.metalness, standard.material.roughness, standard.material.clearcoat, standard.material.diffuseRoughness ] ).toEqual( [ 1, 0.4, 1, 0.3 ] );
		expect( [ ...standard.material.emissive.toArray(), standard.material.emissiveIntensity ] ).toEqual( [ 0, 1, 0, 3 ] );

		const gltf = await materialOf( scene( `    token outputs:mtlx:surface.connect = </mat/g.outputs:out>
    def Shader "g"
    {
        uniform token info:id = "ND_gltf_pbr_surfaceshader"
        color3f inputs:base_color = (0.2, 0.4, 0.6)
        float inputs:metallic = 0
        float inputs:roughness = 0.7
        float inputs:transmission = 1
        float inputs:ior = 1.33
    }` ) );
		expect( gltf.material.color.toArray() ).toEqual( [ 0.2, 0.4, 0.6 ] );
		expect( [ gltf.material.metalness, gltf.material.roughness, gltf.material.transmission, gltf.material.ior ] ).toEqual( [ 0, 0.7, 1, 1.33 ] );

	} );

	const graph = body => scene( `    token outputs:mtlx:surface.connect = </mat/surface.outputs:out>
    def Shader "surface"
    {
        uniform token info:id = "ND_surface"
        token inputs:bsdf.connect = </mat/bsdf.outputs:out>
        token inputs:edf.connect = </mat/edf.outputs:out>
    }
${body}` );

	it( 'reads a BSDF graph as its lobes say: a plain diffuse reflects nothing specular', async () => {

		const { material } = await materialOf( graph( `    def Shader "bsdf"
    {
        uniform token info:id = "ND_oren_nayar_diffuse_bsdf"
        color3f inputs:color = (0.2, 0.4, 0.6)
        float inputs:roughness = 0.8
    }` ) );
		expect( material.color.toArray() ).toEqual( [ 0.2, 0.4, 0.6 ] );
		expect( [ material.metalness, material.specularIntensity, material.transmission ] ).toEqual( [ 0, 0, 0 ] );
		expect( material.diffuseRoughness ).toBe( 0.8 );

	} );

	it( 'mixes a diffuse and a conductor by the mix\'s weights, its colour from the artistic IOR\'s reflectivity', async () => {

		const { material } = await materialOf( graph( `    def Shader "diffuse"
    {
        uniform token info:id = "ND_oren_nayar_diffuse_bsdf"
        color3f inputs:color = (0.4, 0.4, 0.4)
    }
    def Shader "artistic"
    {
        uniform token info:id = "ND_artistic_ior"
        color3f inputs:reflectivity = (1, 0.8, 0.4)
        color3f inputs:edge_color = (1, 1, 1)
    }
    def Shader "metal"
    {
        uniform token info:id = "ND_conductor_bsdf"
        color3f inputs:ior.connect = </mat/artistic.outputs:ior>
        color3f inputs:extinction.connect = </mat/artistic.outputs:extinction>
        float2 inputs:roughness = (0.3, 0.3)
    }
    def Shader "bsdf"
    {
        uniform token info:id = "ND_mix_bsdf"
        token inputs:fg.connect = </mat/metal.outputs:out>
        token inputs:bg.connect = </mat/diffuse.outputs:out>
        float inputs:mix = 0.25
    }` ) );
		expect( material.metalness ).toBeCloseTo( 0.25 );
		expect( material.color.toArray().map( v => Math.round( v * 1000 ) / 1000 ) ).toEqual( [ 0.55, 0.5, 0.4 ] );
		expect( material.roughness ).toBeCloseTo( 0.3 );

	} );

	it( 'reads a transmitting dielectric as glass, and a uniform EDF as emission', async () => {

		const { material } = await materialOf( graph( `    def Shader "bsdf"
    {
        uniform token info:id = "ND_dielectric_bsdf"
        color3f inputs:tint = (0.9, 1, 0.7)
        float inputs:ior = 1.33
        float2 inputs:roughness = (0.1, 0.1)
        string inputs:scatter_mode = "RT"
    }
    def Shader "edf"
    {
        uniform token info:id = "ND_uniform_edf"
        color3f inputs:color = (8, 4, 1)
    }` ) );
		expect( [ material.transmission, material.ior, material.roughness ] ).toEqual( [ 1, 1.33, 0.1 ] );
		expect( material.color.toArray() ).toEqual( [ 0.9, 1, 0.7 ] );
		expect( [ ...material.emissive.toArray(), material.emissiveIntensity ] ).toEqual( [ 1, 0.5, 0.125, 8 ] );

	} );

	it( 'splits a BSDF mix a texture drives evenly, and says so', async () => {

		const { material, result } = await materialOf( graph( `    def Shader "diffuse"
    {
        uniform token info:id = "ND_oren_nayar_diffuse_bsdf"
        color3f inputs:color = (1, 1, 1)
    }
    def Shader "glass"
    {
        uniform token info:id = "ND_dielectric_bsdf"
        string inputs:scatter_mode = "RT"
    }
    def Shader "mask"
    {
        uniform token info:id = "ND_image_float"
        asset inputs:file = @./rough.png@
    }
    def Shader "bsdf"
    {
        uniform token info:id = "ND_mix_bsdf"
        token inputs:fg.connect = </mat/glass.outputs:out>
        token inputs:bg.connect = </mat/diffuse.outputs:out>
        float inputs:mix.connect = </mat/mask.outputs:out>
    }` ), images );
		expect( material.transmission ).toBeCloseTo( 0.5 );
		expect( result.warnings.some( w => /driven by a texture/.test( w ) ) ).toBe( true );

	} );

	it( 'places a copy of a texture, leaving the image other materials share as it was', async () => {

		const shared = `def Material "other"
{
    token outputs:surface.connect = </other/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </other/t.outputs:rgb>
    }
    def Shader "t"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @./wood.png@
    }
}
def Mesh "plain"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
        interpolation = "vertex"
    )
    rel material:binding = </other>
}`;
		const { result } = await materialOf( scene( `    token outputs:surface.connect = </mat/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </mat/place.outputs:result>
    }
    def Shader "t"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @./wood.png@
    }
    def Shader "place"
    {
        uniform token info:id = "UsdTransform2d"
        float2 inputs:in.connect = </mat/t.outputs:rgb>
        float2 inputs:scale = (4, 4)
    }`, shared ), images );

		const [ placed, plain ] = meshes( result.group ).map( m => m.material.map );
		expect( placed.repeat.toArray() ).toEqual( [ 4, 4 ] );
		expect( plain.repeat.toArray() ).toEqual( [ 1, 1 ] );

	} );

} );

describe( 'USD cameras, lights and dome', () => {

	const SCENE = { 'root.usda': usda( `def Camera "shot"
{
    float focalLength = 35
    float horizontalAperture = 36
    float verticalAperture = 20
    float2 clippingRange = (1, 1000)
    double3 xformOp:translate = (0, 1, 5)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
def RectLight "key"
{
    color3f inputs:color = (1, 0.5, 0.25)
    float inputs:exposure = 3
    float inputs:intensity = 2
    float inputs:width = 4
    float inputs:height = 2
    double3 xformOp:translate = (0, 10, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
def DomeLight "sky"
{
    float inputs:exposure = 1
    asset inputs:texture:file = @./sky.exr@
    float3 xformOp:rotateXYZ = (0, 25, 0)
    uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
}` ), 'sky.exr': '' };

	it( 'gives a camera an authored near clip as its clip start, and none from UsdGeom\'s fallback', async () => {

		const camera = clipping => usda( `def Camera "shot"
{
${clipping}    float focalLength = 35
}` );
		expect( ( await load( { 'root.usda': camera( '    float2 clippingRange = (1.1, 100)\n' ) } ) ).cameras[ 0 ].userData.clipStart ).toBeCloseTo( 1.1 );
		expect( ( await load( { 'root.usda': camera( '' ) } ) ).cameras[ 0 ].userData.clipStart ).toBeUndefined();

	} );

	it( 'makes a camera with the apertures\' field of view', async () => {

		const { cameras } = await load( SCENE );
		expect( cameras ).toHaveLength( 1 );
		expect( cameras[ 0 ].name ).toBe( 'shot' );
		expect( cameras[ 0 ].fov ).toBeCloseTo( 2 * Math.atan( 20 / 70 ) * 180 / Math.PI, 5 );
		expect( cameras[ 0 ].position.toArray() ).toEqual( [ 0, 1, 5 ] );

	} );

	it( 'makes a rect light of the radiance intensity × 2^exposure, its colour normalised', async () => {

		const { lights } = await load( SCENE );
		expect( lights ).toHaveLength( 1 );
		expect( lights[ 0 ].intensity ).toBeCloseTo( 16 );
		expect( lights[ 0 ].color.toArray() ).toEqual( [ 1, 0.5, 0.25 ] );
		expect( [ lights[ 0 ].width, lights[ 0 ].height ] ).toEqual( [ 4, 2 ] );
		expect( lights[ 0 ].userData.normalize ).toBe( false );

	} );

	const light = ( type, body, name = 'light' ) => usda( `def ${type} "${name}"
{
${body}
}` );

	it( 'reads a normalized rect or disk light as π × intensity of power, whatever its size', async () => {

		const { lights: [ rect ] } = await load( { 'root.usda': light( 'RectLight', `    float inputs:intensity = 10
    float inputs:width = 2
    float inputs:height = 1
    bool inputs:normalize = 1` ) } );
		expect( rect.intensity ).toBeCloseTo( 10 * Math.PI );
		expect( rect.userData.normalize ).toBe( true );
		expect( rect.userData.__radianceConverted ).toBe( true );

		const { lights: [ disk ] } = await load( { 'root.usda': light( 'DiskLight', `    float inputs:intensity = 10
    float inputs:radius = 0.5
    bool inputs:normalize = 1` ) } );
		expect( disk.intensity ).toBeCloseTo( 10 * Math.PI );
		expect( disk.userData.shape ).toBe( 'disk' );

	} );

	it( 'gives a sphere light π × radiance × its area of power, the area left out when normalized', async () => {

		const sphere = normalize => load( { 'root.usda': light( 'SphereLight', `    float inputs:intensity = 10
    float inputs:radius = 0.25
    bool inputs:normalize = ${normalize}` ) } );
		expect( ( await sphere( 0 ) ).lights[ 0 ].intensity ).toBeCloseTo( Math.PI * 10 * 4 * Math.PI * 0.25 ** 2 );
		expect( ( await sphere( 1 ) ).lights[ 0 ].intensity ).toBeCloseTo( Math.PI * 10 );

	} );

	it( 'reads a distant light as the irradiance it gives a surface facing it', async () => {

		const sun = body => load( { 'root.usda': light( 'DistantLight', body ) } ).then( r => r.lights[ 0 ] );
		const normalized = await sun( `    float inputs:intensity = 3
    float inputs:angle = 10
    bool inputs:normalize = 1` );
		expect( normalized.intensity ).toBeCloseTo( 3 );
		expect( normalized.userData.__luxConverted ).toBe( true );
		// USD's own fallbacks, intensity 50000 over a disc 0.53° wide.
		const fallback = await sun( '    float inputs:exposure = 0' );
		expect( fallback.intensity ).toBeCloseTo( 50000 * Math.PI * Math.sin( 0.265 * Math.PI / 180 ) ** 2 );

	} );

	it( 'aims spot and distant lights down their prim\'s −Z', async () => {

		const aim = async ( type, extra = '' ) => {

			const { lights: [ l ] } = await load( { 'root.usda': light( type, `${extra}    float3 xformOp:rotateXYZ = (-90, 0, 0)
    double3 xformOp:translate = (1, 2, 3)
    uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]` ) } );
			l.updateMatrixWorld( true );
			return l.target.getWorldPosition( new Vector3() ).sub( l.getWorldPosition( new Vector3() ) ).normalize().toArray();

		};

		for ( const direction of [ await aim( 'DistantLight' ), await aim( 'SphereLight', '    float inputs:shaping:cone:angle = 30\n' ) ] ) {

			[ 0, - 1, 0 ].forEach( ( expected, i ) => expect( direction[ i ] ).toBeCloseTo( expected ) );

		}

	} );

	it( 'makes the dome light the environment, turned from USD\'s lat-long convention to the engine\'s', async () => {

		const { environment } = await load( SCENE );
		expect( environment.texture.name ).toBe( 'sky.exr' );
		expect( environment.intensity ).toBeCloseTo( 2 );
		expect( environment.rotation ).toBeCloseTo( 65 );

	} );

} );

describe( 'USD scenes past the budgets', () => {

	const tri = `int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]`;

	const scatter = ( name, count ) => `def PointInstancer "${name}"
{
    point3f[] positions = [${Array.from( { length: count }, ( _, i ) => `(${i}, 0, 0)` ).join( ', ' )}]
    int[] protoIndices = [${Array( count ).fill( 0 ).join( ', ' )}]
    prepend rel prototypes = </${name}/proto>
    def Mesh "proto"
    {
        ${tri}
    }
}`;

	const grass = ( name, count ) => `def BasisCurves "${name}"
{
    uniform token type = "linear"
    int[] curveVertexCounts = [${Array( count ).fill( 2 ).join( ', ' )}]
    point3f[] points = [${Array.from( { length: count }, ( _, i ) => `(${i}, 0, 0), (${i}, 1, 0)` ).join( ', ' )}]
    float[] widths = [0.1]
}`;

	it( 'stores a mesh read under several prims of one part once', async () => {

		const { group, triangleCount } = await load( {
			'root.usda': usda( `def Xform "island"
{
    def Xform "rocks"
    {
        def "a" ( prepend references = @./rock.usda@ )
        {
        }
        def "b" ( prepend references = @./rock.usda@ )
        {
            double3 xformOp:translate = (5, 0, 0)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }
    }
}` ),
			'rock.usda': usda( `(
    defaultPrim = "rock"
)
def Mesh "rock"
{
    ${tri}
}` ),
		} );

		const parts = meshes( group );
		expect( parts ).toHaveLength( 2 );
		expect( parts[ 0 ].geometry ).toBe( parts[ 1 ].geometry );
		expect( triangleCount ).toBe( 1 );

	} );

	it( 'thins copies to the placement budget, keeping a small instancer whole and thinning the large one', async () => {

		const scene = { 'root.usda': usda( `${scatter( 'flowers', 20 )}\n${scatter( 'groundcover', 2000 )}` ) };
		const once = await load( scene, 'root.usda', { maxPlacements: 220 } );
		expect( once.placementCount ).toBeLessThanOrEqual( 220 );
		expect( once.placementCount ).toBeGreaterThan( 150 );
		expect( once.skippedForBudget ).toBe( 0 );
		expect( once.fitNote ).toMatch( /scattered copies kept/ );
		const counts = meshes( once.group ).map( m => m.count ).sort( ( a, b ) => a - b );
		expect( counts[ 0 ] ).toBe( 20 );

		const again = await load( scene, 'root.usda', { maxPlacements: 220 } );
		expect( meshes( again.group ).map( m => m.count ).sort( ( a, b ) => a - b ) ).toEqual( counts );

	} );

	it( 'thins curves to the triangle budget instead of leaving out what is read last', async () => {

		const { triangleCount, fitNote, skippedForBudget, group } = await load(
			{ 'root.usda': usda( `${grass( 'grass', 2000 )}\n${grass( 'fronds', 20 )}` ) },
			'root.usda', { maxTriangles: 1000, curveSteps: 1 }
		);
		expect( fitNote ).toMatch( /of the curves/ );
		expect( skippedForBudget ).toBe( 0 );
		expect( triangleCount ).toBeLessThanOrEqual( 1000 );
		expect( meshes( group ) ).toHaveLength( 2 );

	} );

	it( 'counts a copy of a two-part prototype as one placement', async () => {

		const copies = 300;
		const { group, placementCount, fitNote } = await load( { 'root.usda': usda( `def PointInstancer "trees"
{
    point3f[] positions = [${Array.from( { length: copies }, ( _, i ) => `(${i}, 0, 0)` ).join( ', ' )}]
    int[] protoIndices = [${Array( copies ).fill( 0 ).join( ', ' )}]
    prepend rel prototypes = </trees/tree>
    def Xform "tree"
    {
        def Mesh "trunk"
        {
            ${tri}
        }
        def Mesh "crown"
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 2, 0), (1, 2, 0), (0, 3, 0)]
        }
    }
}` ) }, 'root.usda', { maxPlacements: 400 } );

		expect( fitNote ).toBeNull();
		expect( placementCount ).toBe( copies );
		// Small parts merge into one batch; whatever stays apart is placed by the same matrix list.
		const parts = meshes( group );
		expect( parts.every( m => m.isInstancedMesh && m.count === copies && m.instanceMatrix === parts[ 0 ].instanceMatrix ) ).toBe( true );

	} );

	it( 'leaves a scene within its budgets as it is', async () => {

		const { fitNote, placementCount } = await load( { 'root.usda': usda( scatter( 'few', 10 ) ) }, 'root.usda', { maxPlacements: 100 } );
		expect( fitNote ).toBeNull();
		expect( placementCount ).toBe( 10 );

	} );

} );
