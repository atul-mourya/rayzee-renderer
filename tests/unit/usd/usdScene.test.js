import { describe, it, expect } from 'vitest';
import { Vector3, Matrix4, Texture } from 'three';
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
