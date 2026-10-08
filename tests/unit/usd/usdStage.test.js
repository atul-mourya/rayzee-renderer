import { describe, it, expect } from 'vitest';
import { USDFiles, USDStage } from '@/core/Processor/USD/USDStage.js';

/** A stage over in-memory text layers. */
async function stageOf( layers, root = 'scene/root.usda', { omitted = [] } = {} ) {

	const encoder = new TextEncoder();
	const files = new USDFiles( Object.keys( layers ), async path => encoder.encode( layers[ path ] ), { omitted } );
	const warnings = [];
	const stage = new USDStage( files, { warn: m => warnings.push( m ) } );
	await stage.open( root );
	return { stage, warnings };

}

const usda = body => `#usda 1.0\n${body}\n`;

// Moana's layout: an element places copies of an instance, which references its materials and geometry; the geometry
// pays a variant-holding model in; the element picks the variant for one copy with an `over`.
const ELEMENT = {
	'scene/root.usda': usda( `(
    defaultPrim = "island"
)
def Xform "island"
{
    def Xform "rocks" ( prepend references = @./elements/rocks/element.usda@</rocks> )
    {
    }
}` ),
	'scene/elements/rocks/element.usda': usda( `(
    defaultPrim = "rocks"
)
def Xform "rocks"
{
    def Xform "rocks1" ( payload = @./instance.usda@</rocks> )
    {
        over "geometry" ( variants = { string model = "big" } )
        {
        }
    }
    def Xform "rocks2" ( instanceable = true
        payload = @./instance.usda@</rocks> )
    {
    }
    def Xform "rocks3" ( instanceable = true
        payload = @./instance.usda@</rocks> )
    {
        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (5, 0, 0, 1) )
    }
}` ),
	'scene/elements/rocks/instance.usda': usda( `(
    defaultPrim = "rocks"
)
def Xform "rocks" ( prepend references = [ @./materials.usda@, @./geometry.usda@ ] )
{
}` ),
	'scene/elements/rocks/materials.usda': usda( `(
    defaultPrim = "rocks"
)
def Scope "rocks"
{
    def Scope "materials"
    {
        def Material "stone" ( prepend references = @../../materials/base.usda@</Base> )
        {
            color3f inputs:baseColor = (0.5, 0.4, 0.3)
        }
    }
    over "geometry"
    {
        over "rock"
        {
            rel material:binding = </rocks/materials/stone>
        }
    }
}` ),
	'scene/elements/rocks/geometry.usda': usda( `(
    defaultPrim = "rocks"
)
def Xform "rocks"
{
    def Xform "geometry" ( prepend payload = @./model.usda@</rocks/geometry> )
    {
    }
}` ),
	'scene/elements/rocks/model.usda': usda( `def Xform "rocks"
{
    def Xform "geometry" (
        variants = { string model = "small" }
        prepend variantSets = "model"
    )
    {
        variantSet "model" = {
            "small" {
                def Mesh "rock"
                {
                    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
                }
            }
            "big" {
                def Mesh "rock"
                {
                    point3f[] points = [(0, 0, 0), (9, 0, 0), (0, 9, 0)]
                }
            }
        }
    }
}` ),
	'scene/materials/base.usda': usda( `class "_class_Base"
{
    float inputs:roughness = 0.75
}
def Material "Base" ( prepend inherits = </_class_Base> )
{
    color3f inputs:baseColor = (1, 0, 0)
    float inputs:metallic = 0
    token outputs:surface.connect = </Base/shader.outputs:surface>
    def Shader "shader"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Base.inputs:baseColor>
    }
}` ),
};

describe( 'USD composition', () => {

	it( 'follows references, a list of them, payloads and variants to the geometry', async () => {

		const { stage, warnings } = await stageOf( ELEMENT );
		const rock = await stage.primAt( '/island/rocks/rocks2/geometry/rock' );
		expect( rock.typeName ).toBe( 'Mesh' );
		expect( rock.isDefined ).toBe( true );
		expect( Array.from( rock.value( 'points' ) ) ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		expect( warnings ).toEqual( [] );

	} );

	it( 'lets a stronger site select a variant set a referenced layer defines', async () => {

		const { stage } = await stageOf( ELEMENT );
		const rock = await stage.primAt( '/island/rocks/rocks1/geometry/rock' );
		expect( rock.value( 'points' )[ 3 ] ).toBe( 9 );

	} );

	it( 'maps a relationship a referenced layer authors into the stage\'s namespace', async () => {

		const { stage } = await stageOf( ELEMENT );
		const rock = await stage.primAt( '/island/rocks/rocks1/geometry/rock' );
		expect( rock.targets( 'material:binding' ) ).toEqual( [ '/island/rocks/rocks1/materials/stone' ] );

	} );

	it( 'reads values through references, local opinions first, and through inherits', async () => {

		const { stage } = await stageOf( ELEMENT );
		const stone = await stage.primAt( '/island/rocks/rocks1/materials/stone' );
		expect( stone.value( 'inputs:baseColor' ) ).toEqual( [ 0.5, 0.4, 0.3 ] );
		expect( stone.value( 'inputs:metallic' ) ).toBe( 0 );
		expect( stone.value( 'inputs:roughness' ) ).toBe( 0.75 );
		const shader = await stage.primAt( '/island/rocks/rocks1/materials/stone/shader' );
		expect( shader.connections( 'inputs:diffuseColor' ) ).toEqual( [ '/island/rocks/rocks1/materials/stone.inputs:baseColor' ] );

	} );

	it( 'gives prims composed from the same arcs one prototype key, whatever each copy overrides', async () => {

		const { stage } = await stageOf( ELEMENT );
		const [ a, b, c ] = await Promise.all( [ 'rocks1', 'rocks2', 'rocks3' ].map( n => stage.primAt( `/island/rocks/${n}` ) ) );
		expect( b.instanceKey() ).toBe( c.instanceKey() );
		// An instance's opinions below itself are not composed into its prototype, as in OpenUSD.
		expect( a.instanceKey() ).toBe( b.instanceKey() );
		expect( ( await stage.primAt( '/island/rocks' ) ).instanceKey() ).not.toBe( b.instanceKey() );

	} );

	it( 'composes sublayers, the stronger first', async () => {

		const { stage } = await stageOf( {
			'root.usda': usda( `(
    subLayers = [ @./base.usda@ ]
)
over "thing"
{
    float size = 2
}` ),
			'base.usda': usda( `def Sphere "thing"
{
    float size = 1
    float other = 3
}` ),
		}, 'root.usda' );
		const thing = await stage.primAt( '/thing' );
		expect( thing.typeName ).toBe( 'Sphere' );
		expect( thing.value( 'size' ) ).toBe( 2 );
		expect( thing.value( 'other' ) ).toBe( 3 );

	} );

	it( 'skips an arc to a missing file with a warning, and one to a part left out quietly, counted', async () => {

		const { stage, warnings } = await stageOf( {
			'root.usda': usda( `def Xform "a" ( prepend references = @./gone.usda@ )
{
}
def Xform "b" ( prepend references = @./left/out.usda@ )
{
}` ),
		}, 'root.usda', { omitted: [ 'left/out.usda' ] } );
		expect( await stage.primAt( '/a' ) ).not.toBeNull();
		expect( await stage.primAt( '/b' ) ).not.toBeNull();
		expect( warnings ).toEqual( [ 'USD reference "./gone.usda" (from "root.usda") not found — skipped' ] );
		expect( stage.omittedArcs ).toBe( 1 );

	} );

	it( 'stops a composition cycle instead of recursing', async () => {

		const { stage, warnings } = await stageOf( {
			'root.usda': usda( `def Xform "a" ( prepend references = @./b.usda@</b> )
{
}` ),
			'b.usda': usda( `def Xform "b" ( prepend references = @./root.usda@</a> )
{
}` ),
		}, 'root.usda' );
		expect( ( await stage.primAt( '/a' ) ).isDefined ).toBe( true );
		expect( warnings.some( w => w.includes( 'cycle' ) ) ).toBe( true );

	} );

} );
