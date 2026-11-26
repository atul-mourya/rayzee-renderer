import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Texture, Color, Vector2 } from 'three';

vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { USDFiles, USDStage, loadUSDScene, materialXPreview } from '@/core/addons/archives/usd/index.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { localFolder } from '@/core/loaders/ArchiveFormats.js';
import { IssueLog } from '@/core/EngineIssues.js';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';
import { materialXToUSDA, materialXNames, parseXML } from '@/core/addons/archives/usd/MaterialX.js';

// fixtures/materialx: each .mtlx is valid against MaterialX 1.39.4's libraries; its .pixar.usda is OpenUSD 25.08's usdMtlx
// translation of it (Blender 5.1's pxr, `Usd.Stage.Open( mtlx ).GetRootLayer().ExportToString()`).
const fixture = name => readFileSync( new URL( `./fixtures/materialx/${name}`, import.meta.url ), 'utf8' );
const encoder = new TextEncoder();

/** Each material of `lib` on a triangle of its own, read through the USD reader; the materials by name. */
async function materials( lib, libText, names, extra = {} ) {

	// Every file the library names exists, so its textures resolve.
	const textures = [ ...( lib.endsWith( '.mtlx' ) ? materialXToUSDA( libText ) : libText ).matchAll( /@([^@]+)@/g ) ].map( m => m[ 1 ].replace( /^\.\//, '' ) );
	const out = {};
	for ( const name of names ) {

		const root = `#usda 1.0
def "Looks" (
    prepend references = @${lib}@</MaterialX/Materials>
)
{
}
def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
        interpolation = "vertex"
    )
    rel material:binding = </Looks/${name}>
}
`;
		const layers = { 'root.usda': root, [ lib ]: libText, ...Object.fromEntries( textures.map( t => [ t, '' ] ) ), ...extra };
		const files = new USDFiles( Object.keys( layers ), async path => ( layers[ path ] === undefined ? null : encoder.encode( layers[ path ] ) ) );
		const { group } = await loadUSDScene( {
			files, entryPath: 'root.usda',
			resolveImage: async path => Object.assign( new Texture(), { name: path } ),
			resolveEnvironment: async () => null,
		} );
		group.traverse( o => {

			if ( o.isMesh ) out[ name ] = o.material;

		} );

	}

	return { materials: out };

}

/** Every property a material carries, textures by what they read and how. */
function describeMaterial( material ) {

	const plain = v => {

		if ( v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ) return typeof v === 'number' ? Math.round( v * 1e6 ) / 1e6 : v;
		if ( v instanceof Color ) return v.toArray().map( plain );
		if ( v instanceof Vector2 ) return v.toArray().map( plain );
		if ( v.isTexture ) return {
			name: v.name, colorSpace: v.colorSpace, wrapS: v.wrapS, wrapT: v.wrapT, channel: v.channel,
			repeat: plain( v.repeat ), offset: plain( v.offset ), rotation: plain( v.rotation ), center: plain( v.center ),
			matrix: v.matrixAutoUpdate ? null : v.matrix.elements.map( plain ), userData: JSON.parse( JSON.stringify( v.userData ) ),
		};
		if ( Array.isArray( v ) || ArrayBuffer.isView( v ) ) return Array.from( v, plain );
		if ( typeof v === 'object' ) return Object.fromEntries( Object.entries( v ).map( ( [ k, x ] ) => [ k, plain( x ) ] ) );
		return String( v );

	};

	const skip = new Set( [ 'uuid', 'id', 'version', '_listeners', 'name' ] );
	return Object.fromEntries( Object.keys( material ).filter( k => ! skip.has( k ) && typeof material[ k ] !== 'function' ).map( k => [ k, plain( material[ k ] ) ] ) );

}

describe( 'MaterialX documents read as USD layers', () => {

	// old137.mtlx names a document colour space, which usdMtlx keeps only as layer data: it is compared on its own below.
	const PARITY = [ 'tiled_wood', 'mixed', 'graph_channels', 'openpbr_full', 'bsdf_graph', 'old137_nocs' ];

	it.each( PARITY )( '%s.mtlx gives the materials OpenUSD\'s usdMtlx translation gives', async name => {

		const text = fixture( `${name}.mtlx` );
		const names = materialXNames( text );
		expect( names.length ).toBeGreaterThan( 0 );
		const ours = await materials( 'lib.mtlx', text, names );
		const pixar = await materials( 'lib.usda', fixture( `${name}.pixar.usda` ), names );
		for ( const material of names ) {

			expect( ours.materials[ material ], material ).toBeDefined();
			expect( describeMaterial( ours.materials[ material ] ), material ).toEqual( describeMaterial( pixar.materials[ material ] ) );

		}

	} );

	it.each( PARITY )( '%s.mtlx puts what each material reads where usdMtlx puts it', async name => {

		// Every prim a material's surface reaches through its connections, by path: paths a USD scene could reference.
		// MaterialX's upgrade names the nodes it adds swizzle, swizzle2…: those may differ.
		const reached = async ( lib, text ) => {

			const files = new USDFiles( [ lib ], async () => encoder.encode( text ) );
			const stage = new USDStage( files );
			await stage.open( lib );
			const out = new Set();
			const missing = [];
			const follow = async target => {

				const path = target.slice( 0, target.lastIndexOf( '.' ) );
				if ( out.has( path ) ) return;
				out.add( path );
				const prim = await stage.primAt( path );
				if ( ! prim ) missing.push( path );
				for ( const property of prim?.propertyNames() ?? [] ) for ( const next of prim.connections( property ) ) await follow( next );

			};

			const materials = await stage.primAt( '/MaterialX/Materials' );
			for ( const material of materials.childNames() ) {

				const prim = await stage.child( materials, material );
				out.add( prim.path );
				for ( const next of prim.connections( 'outputs:mtlx:surface' ) ) await follow( next );

			}

			expect( missing, `${lib}: connections to no prim` ).toEqual( [] );
			return [ ...out ].filter( path => ! /\/swizzle\d*$/.test( path ) );

		};

		const ours = new Set( await reached( 'lib.mtlx', fixture( `${name}.mtlx` ) ) );
		const pixar = await reached( 'lib.usda', fixture( `${name}.pixar.usda` ) );
		expect( pixar.length ).toBeGreaterThan( 1 );
		for ( const path of pixar ) {

			// Pixar's material interface inputs are the material itself.
			if ( path.split( '/' ).length > 4 ) expect( ours.has( path ), path ).toBe( true );

		}

	} );

	it( 'reads every material the samples hold, textured and not', async () => {

		const wood = ( await materials( 'lib.mtlx', fixture( 'tiled_wood.mtlx' ), [ 'Wood' ] ) ).materials.Wood;
		expect( wood.name ).toBe( 'Wood' );
		expect( wood.map?.name ).toBe( 'textures/wood_color.png' );
		expect( wood.roughnessMap?.name ).toBe( 'textures/wood_roughness.png' );
		expect( wood.normalMap?.name ).toBe( 'textures/wood_normal.png' );
		expect( wood.normalScale.x ).toBeCloseTo( 0.8 );
		expect( wood.clearcoat ).toBeCloseTo( 0.25 );

		const { materials: mixed } = await materials( 'lib.mtlx', fixture( 'mixed.mtlx' ), [ 'Brick', 'Tinted', 'Gold' ] );
		expect( mixed.Gold.metalness ).toBe( 1 );
		expect( mixed.Gold.color.toArray().map( v => Math.round( v * 1000 ) / 1000 ) ).toEqual( [ 1, 0.766, 0.336 ] );
		expect( mixed.Brick.map?.name ).toBe( 'maps/brick.jpg' );
		expect( mixed.Tinted.transmission ).toBeCloseTo( 0.9 );

	} );

	it( 'reads a 1.37 document\'s colour space as the files\' own, where usdMtlx keeps it only as layer data', async () => {

		const text = fixture( 'old137.mtlx' );
		expect( materialXToUSDA( text ) ).toMatch( /asset inputs:file = @tex\/old\.png@ \(\s+colorSpace = "lin_rec709"/ );
		const linear = ( await materials( 'lib.mtlx', text, [ 'OldMat' ] ) ).materials.OldMat;
		const auto = ( await materials( 'lib.mtlx', fixture( 'old137_nocs.mtlx' ), [ 'OldMat' ] ) ).materials.OldMat;
		expect( linear.map.colorSpace ).not.toBe( auto.map.colorSpace );
		expect( linear.metalness ).toBeCloseTo( 0.5 );
		expect( linear.roughness ).toBeCloseTo( 0.35 );

	} );

} );

describe( 'MaterialX translation', () => {

	const doc = body => `<?xml version="1.0"?>\n<!-- a comment -->\n<materialx version="1.38">\n${body}\n</materialx>`;
	const surface = ( inputs, extra = '' ) => doc( `<standard_surface name="S" type="surfaceshader">${inputs}</standard_surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>${extra}` );

	it( 'parses attributes in either quote, entities and self-closed or empty elements', () => {

		const root = parseXML( `<?xml version="1.0"?><a x='1' y="&lt;&amp;&#65;&#x42;"><b/><c></c><!-- <d/> --></a>` );
		const a = root.children[ 0 ];
		expect( a.attrs ).toEqual( { x: '1', y: '<&AB' } );
		expect( a.children.map( c => c.tag ) ).toEqual( [ 'b', 'c' ] );
		expect( () => parseXML( '<a><b></a>' ) ).toThrow( /does not close/ );
		expect( () => parseXML( '<a>' ) ).toThrow( /not closed/ );
		expect( () => materialXToUSDA( '<nope/>' ) ).toThrow( /not a MaterialX document/ );

	} );

	it( 'writes values of every type USD reads', () => {

		const usda = materialXToUSDA( surface( `
<input name="base" type="float" value="0.5" />
<input name="thin_walled" type="boolean" value="true" />
<input name="base_color" type="color3" value="0.1,0.2, 0.3" />
<input name="normal" type="vector3" value="0, 0, 1" />
<input name="mode" type="integer" value="2" />
<input name="label" type="string" value='say "hi"' />
<input name="m" type="matrix33" value="1,0,0, 0,1,0, 0,0,1" />` ) );
		expect( usda ).toContain( 'float inputs:base = 0.5' );
		expect( usda ).toContain( 'bool inputs:thin_walled = 1' );
		expect( usda ).toContain( 'color3f inputs:base_color = (0.1, 0.2, 0.3)' );
		expect( usda ).toContain( 'float3 inputs:normal = (0, 0, 1)' );
		expect( usda ).toContain( 'int inputs:mode = 2' );
		expect( usda ).toContain( 'string inputs:label = "say \\"hi\\""' );
		expect( usda ).toContain( 'matrix3d inputs:m = ( (1, 0, 0), (0, 1, 0), (0, 0, 1) )' );

	} );

	it( 'resolves file prefixes and tokens from the nearest element, and names each node\'s nodedef', () => {

		const usda = materialXToUSDA( doc( `<nodegraph name="G" fileprefix="g/">
  <token name="R" type="string" value="4k" />
  <image name="i" type="color3" fileprefix="own/"><input name="file" type="filename" value="a_[R].png" /></image>
  <image name="j" type="float"><input name="file" type="filename" value="b.png" fileprefix="in/" /></image>
  <image name="k" type="vector3"><input name="file" type="filename" value="c.png" /></image>
  <multiply name="mul" type="color3"><input name="in1" type="color3" nodename="i" /><input name="in2" type="float" nodename="j" /></multiply>
  <convert name="cv" type="color3"><input name="in" type="vector3" nodename="k" /></convert>
  <add name="sum" type="color3"><input name="in1" type="color3" nodename="mul" /><input name="in2" type="color3" nodename="cv" /></add>
  <output name="o" type="color3" nodename="sum" />
</nodegraph>
<standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" nodegraph="G" output="o" /></standard_surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>` ) );
		expect( usda ).toContain( 'asset inputs:file = @own/a_4k.png@' );
		expect( usda ).toContain( 'asset inputs:file = @in/b.png@' );
		expect( usda ).toContain( 'asset inputs:file = @g/c.png@' );
		expect( usda ).toContain( '"ND_multiply_color3FA"' );
		expect( usda ).toContain( '"ND_convert_vector3_color3"' );
		expect( usda ).toContain( '"ND_add_color3"' );
		expect( usda ).toContain( '"ND_image_float"' );

	} );

	it( 'picks channels as the 1.39 upgrade does: an extract, a convert, or a combine with constants', () => {

		const usda = materialXToUSDA( surface( `
<input name="base" type="float" nodename="img" channels="g" />
<input name="base_color" type="color3" nodename="gray" channels="rrr" />
<input name="specular_color" type="color3" nodename="img" channels="bg1" />`, `
<image name="img" type="color3"><input name="file" type="filename" value="x.png" /></image>
<image name="gray" type="float"><input name="file" type="filename" value="y.png" /></image>` ) );
		expect( usda ).toMatch( /def Shader "S_base_g"\s*\{\s*uniform token info:id = "ND_extract_color3"\s*color3f inputs:in\.connect = <\/MaterialX\/Materials\/M\/NodeGraphs\/img\.outputs:out>\s*int inputs:index = 1/ );
		expect( usda ).toMatch( /"ND_convert_float_color3"\s*float inputs:in\.connect = <\/MaterialX\/Materials\/M\/NodeGraphs\/gray\.outputs:out>/ );
		expect( usda ).toMatch( /"ND_combine3_color3"\s*float inputs:in1\.connect = <[^>]+S_specular_color_b\.outputs:out>\s*float inputs:in2\.connect = <[^>]+S_specular_color_g\.outputs:out>\s*float inputs:in3 = 1/ );
		expect( usda ).toContain( 'color3f inputs:base_color.connect = </MaterialX/Materials/M/NodeGraphs/S_base_color_convert.outputs:out>' );

	} );

	it( 'reads a swizzle of a value, and of a whole vector, as its node', () => {

		const usda = materialXToUSDA( surface( `
<input name="base_color" type="color3" nodename="sw" />
<input name="base" type="float" nodename="all" />`, `
<swizzle name="sw" type="color3"><input name="in" type="color3" value="0.1, 0.2, 0.3" /><input name="channels" type="string" value="bgr" /></swizzle>
<swizzle name="all" type="float"><input name="in" type="float" nodename="c" /><input name="channels" type="string" value="r" /></swizzle>
<constant name="c" type="float"><input name="value" type="float" value="0.7" /></constant>` ) );
		expect( usda ).toMatch( /def Shader "sw"\s*\{\s*uniform token info:id = "ND_constant_color3"\s*color3f inputs:value = \(0\.3, 0\.2, 0\.1\)/ );
		expect( usda ).toMatch( /def Shader "all"\s*\{\s*uniform token info:id = "ND_dot_float"\s*float inputs:in\.connect = <\/MaterialX\/Materials\/M\/NodeGraphs\/c\.outputs:out>/ );

	} );

	it( 'reads a surface built inside a node graph, which usdMtlx cannot', async () => {

		const text = readFileSync( new URL( './fixtures/materialx/bsdf_graph.mtlx', import.meta.url ), 'utf8' )
			.replace( '<surfacematerial name="Lacquer" type="material">\n    <input name="surfaceshader" type="surfaceshader" nodename="Lacquer_S" />',
				'<surfacematerial name="Lacquer" type="material">\n    <input name="surfaceshader" type="surfaceshader" nodegraph="NG" output="out" />' )
			.replace( '<surfacematerial name="Copper"', `<nodegraph name="NG">
    <dielectric_bsdf name="coat" type="BSDF"><input name="ior" type="float" value="1.5" /><input name="roughness" type="vector2" value="0.04, 0.04" /></dielectric_bsdf>
    <oren_nayar_diffuse_bsdf name="diffuse" type="BSDF"><input name="color" type="color3" value="0.6, 0.1, 0.1" /><input name="roughness" type="float" value="0.5" /></oren_nayar_diffuse_bsdf>
    <layer name="stack" type="BSDF"><input name="top" type="BSDF" nodename="coat" /><input name="base" type="BSDF" nodename="diffuse" /></layer>
    <uniform_edf name="glow" type="EDF"><input name="color" type="color3" value="0.2, 0.3, 0.1" /></uniform_edf>
    <surface name="surf" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="stack" /><input name="edf" type="EDF" nodename="glow" /><input name="opacity" type="float" value="1" /></surface>
    <output name="out" type="surfaceshader" nodename="surf" />
  </nodegraph>
  <surfacematerial name="Copper"` );
		const inGraph = ( await materials( 'lib.mtlx', text, [ 'Lacquer' ] ) ).materials.Lacquer;
		const atTop = ( await materials( 'lib.mtlx', fixture( 'bsdf_graph.mtlx' ), [ 'Lacquer' ] ) ).materials.Lacquer;
		expect( describeMaterial( inGraph ) ).toEqual( describeMaterial( atTop ) );

	} );

	it( 'says what it leaves out', () => {

		const warnings = [];
		materialXToUSDA( doc( `<look name="L"><materialassign name="a" material="M" geom="/x" /></look>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="missing" /></surfacematerial>
<surfacematerial name="N" type="material" />` ), { warn: ( _, message ) => warnings.push( message ) } );
		expect( warnings.some( w => /looks/.test( w ) ) ).toBe( true );
		expect( warnings.some( w => /"missing" not found/.test( w ) ) ).toBe( true );
		expect( warnings.some( w => /"N" has no surface shader/.test( w ) ) ).toBe( true );

	} );

	it( 'names prims as USD identifiers and writes each material once', () => {

		const text = doc( `<standard_surface name="1 shader" type="surfaceshader" />
<surfacematerial name="my-mat" type="material"><input name="surfaceshader" type="surfaceshader" nodename="1 shader" /></surfacematerial>` );
		expect( materialXNames( text ) ).toEqual( [ 'my_mat' ] );
		expect( materialXToUSDA( text ) ).toContain( 'def Shader "_1_shader"' );

	} );

} );

describe( 'MaterialX documents: what a review found', () => {

	const doc = body => `<?xml version="1.0"?>\n<materialx version="1.38">\n${body}\n</materialx>`;
	const files = { 'a.png': '', 'b.png': '', 'tex/a.png': '' };
	const one = async ( text, name = 'M' ) => ( await materials( 'lib.mtlx', text, [ name ], files ) ).materials[ name ];

	/** Every connection in the translated layer reaches a prim. */
	async function dangling( text ) {

		const stage = new USDStage( new USDFiles( [ 'lib.mtlx' ], async () => encoder.encode( text ) ) );
		await stage.open( 'lib.mtlx' );
		const out = [];
		const walk = async prim => {

			for ( const property of prim.propertyNames() ) for ( const target of prim.connections( property ) ) {

				if ( ! await stage.primAt( target.slice( 0, target.lastIndexOf( '.' ) ) ) ) out.push( `${prim.path}.${property} → ${target}` );

			}

			for ( const child of prim.childNames() ) await walk( await stage.child( prim, child ) );

		};

		await walk( stage.pseudoRoot );
		return out;

	}

	it( 'writes what a surface mixed inside a mix reads, in the graph it belongs to', async () => {

		const text = doc( `<image name="img" type="color3"><input name="file" type="filename" value="a.png" /></image>
<image name="img2" type="color3"><input name="file" type="filename" value="b.png" /></image>
<standard_surface name="A" type="surfaceshader"><input name="base_color" type="color3" nodename="img" /></standard_surface>
<standard_surface name="B" type="surfaceshader"><input name="base_color" type="color3" nodename="img2" /></standard_surface>
<standard_surface name="C" type="surfaceshader" />
<mix name="inner" type="surfaceshader"><input name="fg" type="surfaceshader" nodename="B" /><input name="bg" type="surfaceshader" nodename="C" /><input name="mix" type="float" value="0.5" /></mix>
<mix name="outer" type="surfaceshader"><input name="fg" type="surfaceshader" nodename="A" /><input name="bg" type="surfaceshader" nodename="inner" /><input name="mix" type="float" value="0.5" /></mix>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="outer" /></surfacematerial>` );
		expect( await dangling( text ) ).toEqual( [] );
		expect( materialXToUSDA( text ) ).toContain( 'def Shader "img2"' );

	} );

	it( 'follows includes: their graphs, files from where they sit, nested, once each, and says which are missing', async () => {

		const main = `<?xml version="1.0"?><materialx version="1.38">
  <xi:include href="lib/graphs.mtlx" />
  <xi:include href="nowhere.mtlx" />
  <standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" nodegraph="NG" output="out" />
    <input name="specular_roughness" type="float" nodegraph="NG_rough" output="out" /></standard_surface>
  <surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>
</materialx>`;
		const graphs = `<?xml version="1.0"?><materialx version="1.38" fileprefix="maps/" colorspace="srgb_texture">
  <xi:include href="../main.mtlx" />
  <xi:include href="more/rough.mtlx" />
  <nodegraph name="NG"><image name="i" type="color3"><input name="file" type="filename" value="wood.png" /></image>
    <output name="out" type="color3" nodename="i" /></nodegraph>
</materialx>`;
		const rough = `<?xml version="1.0"?><materialx version="1.38">
  <nodegraph name="NG_rough"><image name="r" type="float"><input name="file" type="filename" value="rough.png" /></image>
    <output name="out" type="float" nodename="r" /></nodegraph>
</materialx>`;
		const layers = { 'root.usda': `#usda 1.0
def "Looks" (
    prepend references = @main.mtlx@</MaterialX/Materials>
)
{
}
def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
        interpolation = "vertex"
    )
    rel material:binding = </Looks/M>
}
`, 'main.mtlx': main, 'lib/graphs.mtlx': graphs, 'lib/more/rough.mtlx': rough, 'lib/maps/wood.png': '', 'lib/more/rough.png': '' };
		const { group, warnings } = await loadUSDScene( {
			files: new USDFiles( Object.keys( layers ), async path => ( layers[ path ] === undefined ? null : encoder.encode( layers[ path ] ) ) ),
			entryPath: 'root.usda', resolveImage: async path => Object.assign( new Texture(), { name: path } ), resolveEnvironment: async () => null,
		} );
		let material = null;
		group.traverse( o => {

			if ( o.isMesh ) material = o.material;

		} );
		expect( material.map?.name ).toBe( 'lib/maps/wood.png' );
		// The included document's colour space came with its graph.
		expect( material.map.colorSpace ).toBe( 'srgb' );
		expect( material.roughnessMap?.name ).toBe( 'lib/more/rough.png' );
		expect( warnings.some( w => /MaterialX include "nowhere\.mtlx" \(from "main\.mtlx"\) not found/.test( w ) ) ).toBe( true );

	} );

	it( 'writes a node the document defines itself as its graph\'s nodes, its inputs or its definition\'s defaults bound', async () => {

		const defs = `<nodedef name="ND_tint_color3" node="tint" type="color3">
  <input name="base" type="color3" value="1, 1, 1" /><input name="amount" type="float" value="0.5" /><output name="out" type="color3" />
</nodedef>
<nodegraph name="NG_tint" nodedef="ND_tint_color3">
  <multiply name="m" type="color3"><input name="in1" type="color3" interfacename="base" /><input name="in2" type="float" interfacename="amount" /></multiply>
  <output name="out" type="color3" nodename="m" />
</nodegraph>`;
		const text = doc( `${defs}
<image name="img" type="color3"><input name="file" type="filename" value="a.png" /></image>
<tint name="t1" type="color3"><input name="base" type="color3" nodename="img" /></tint>
<tint name="t2" type="color3"><input name="base" type="color3" value="0.2, 0.4, 0.6" /></tint>
<tint name="t3" type="color3"><input name="base" type="color3" value="0.2, 0.4, 0.6" /><input name="amount" type="float" value="2" /></tint>
<standard_surface name="S1" type="surfaceshader"><input name="base_color" type="color3" nodename="t1" /></standard_surface>
<standard_surface name="S2" type="surfaceshader"><input name="base_color" type="color3" nodename="t2" /></standard_surface>
<standard_surface name="S3" type="surfaceshader"><input name="base_color" type="color3" nodename="t3" /></standard_surface>
<surfacematerial name="M1" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S1" /></surfacematerial>
<surfacematerial name="M2" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S2" /></surfacematerial>
<surfacematerial name="M3" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S3" /></surfacematerial>` );
		expect( await dangling( text ) ).toEqual( [] );
		const usda = materialXToUSDA( text );
		expect( usda ).toContain( 'def Shader "t1_m"' );
		expect( usda ).not.toContain( 'ND_tint' );
		const { materials: m } = await materials( 'lib.mtlx', text, [ 'M1', 'M2', 'M3' ], files );
		expect( m.M1.map?.name ).toBe( 'a.png' );
		const rounded = c => c.toArray().map( v => Math.round( v * 1000 ) / 1000 );
		expect( rounded( m.M2.color ) ).toEqual( [ 0.1, 0.2, 0.3 ] );
		expect( rounded( m.M3.color ) ).toEqual( [ 0.4, 0.8, 1.2 ] );

	} );

	it( 'leaves out a node defined through itself, saying so', () => {

		const warnings = [];
		const text = doc( `<nodedef name="ND_loop_float" node="loop" type="float"><input name="x" type="float" value="1" /><output name="out" type="float" /></nodedef>
<nodegraph name="NG_loop" nodedef="ND_loop_float"><loop name="again" type="float" /><output name="out" type="float" nodename="again" /></nodegraph>
<loop name="l" type="float" />
<standard_surface name="S" type="surfaceshader"><input name="base" type="float" nodename="l" /></standard_surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>` );
		expect( () => materialXToUSDA( text, { warn: ( _, w ) => warnings.push( w ) } ) ).not.toThrow();
		expect( warnings.some( w => /"loop" is defined through itself/.test( w ) ) ).toBe( true );

	} );

	it( 'names a node of several outputs by its category, as artistic_ior\'s nodedef is named', async () => {

		const text = doc( `<artistic_ior name="air" type="multioutput">
  <input name="reflectivity" type="color3" value="0.9, 0.6, 0.3" /><input name="edge_color" type="color3" value="1, 0.9, 0.8" />
</artistic_ior>
<conductor_bsdf name="metal" type="BSDF">
  <input name="ior" type="color3" nodename="air" output="ior" /><input name="extinction" type="color3" nodename="air" output="extinction" />
</conductor_bsdf>
<surface name="S" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="metal" /></surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>` );
		expect( materialXToUSDA( text ) ).toContain( '"ND_artistic_ior"' );
		const metal = await one( text );
		expect( metal.metalness ).toBe( 1 );
		expect( metal.color.toArray().map( v => Math.round( v * 100 ) / 100 ) ).toEqual( [ 0.9, 0.6, 0.3 ] );

	} );

	it( 'puts the shader\'s values on the material, as usdMtlx does, so a USD scene can override them there', async () => {

		const usda = materialXToUSDA( fixture( 'tiled_wood.mtlx' ) );
		expect( usda ).toMatch( /def Material "Wood"\s*\{\s*float inputs:base = 1\s*float inputs:coat = 0\.25/ );
		expect( usda ).toContain( 'float inputs:coat.connect = </MaterialX/Materials/Wood.inputs:coat>' );
		const overridden = await materials( 'lib.mtlx', fixture( 'tiled_wood.mtlx' ), [ 'Wood' ], {} );
		expect( overridden.materials.Wood.clearcoat ).toBeCloseTo( 0.25 );
		const root = `#usda 1.0
def "Looks" (
    prepend references = @lib.mtlx@</MaterialX/Materials>
)
{
    over "Wood"
    {
        float inputs:coat = 0.75
    }
}
def Mesh "tri"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </Looks/Wood>
}
`;
		const layers = { 'root.usda': root, 'lib.mtlx': fixture( 'tiled_wood.mtlx' ) };
		const { group } = await loadUSDScene( {
			files: new USDFiles( Object.keys( layers ), async path => encoder.encode( layers[ path ] ) ), entryPath: 'root.usda',
			resolveImage: async () => null, resolveEnvironment: async () => null,
		} );
		let coat = null;
		group.traverse( o => {

			if ( o.isMesh ) coat = o.material.clearcoat;

		} );
		expect( coat ).toBeCloseTo( 0.75 );

	} );

	it( 'keeps two 1.37 materials\' same-named shaderrefs apart, and one named as its material', async () => {

		const text = `<?xml version="1.0"?><materialx version="1.37">
<material name="A"><shaderref name="SR" node="standard_surface"><bindinput name="metalness" type="float" value="0.2" /></shaderref></material>
<material name="B"><shaderref name="SR" node="standard_surface"><bindinput name="metalness" type="float" value="0.8" /></shaderref></material>
<material name="C"><shaderref name="C" node="standard_surface"><bindinput name="metalness" type="float" value="0.5" /></shaderref></material>
</materialx>`;
		const { materials: m } = await materials( 'lib.mtlx', text, [ 'A', 'B', 'C' ] );
		expect( [ m.A.metalness, m.B.metalness, m.C.metalness ] ).toEqual( [ 0.2, 0.8, 0.5 ] );

	} );

	it( 'reads an image\'s file and tiling given through its graph\'s inputs', async () => {

		const text = doc( `<nodegraph name="G">
  <input name="file" type="filename" value="tex/a.png" colorspace="srgb_texture" />
  <input name="tiling" type="vector2" value="3, 2" />
  <tiledimage name="img" type="color3"><input name="file" type="filename" interfacename="file" /><input name="uvtiling" type="vector2" interfacename="tiling" /></tiledimage>
  <output name="out" type="color3" nodename="img" />
</nodegraph>
<standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" nodegraph="G" output="out" /></standard_surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>` );
		const map = ( await one( text ) ).map;
		expect( map?.name ).toBe( 'tex/a.png' );
		expect( map.matrix.elements[ 0 ] ).toBeCloseTo( 3 );
		expect( map.matrix.elements[ 4 ] ).toBeCloseTo( 2 );

	} );

	it( 'follows an input to a document-level output', async () => {

		const text = doc( `<image name="img" type="color3"><input name="file" type="filename" value="a.png" /></image>
<output name="o" type="color3" nodename="img" />
<standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" output="o" /></standard_surface>
<surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S" /></surfacematerial>` );
		expect( ( await one( text ) ).map?.name ).toBe( 'a.png' );

	} );

	it( 'leaves a stray document out of a frame sequence', () => {

		const archives = new ArchiveImporter( { getFileFormat: path => ( /\.(vdb|mtlx)$/.test( path ) ? { type: 'model', parseSequence: /\.vdb$/.test( path ) ? () => {} : undefined } : null ) } );
		expect( archives._sequenceRun( [ 'f_0001.vdb', 'f_0002.vdb', 'f_0003.vdb', 'look.mtlx' ] )?.run.paths.length ).toBe( 3 );

	} );

} );

describe( 'MaterialX documents on their own', () => {

	const MODEL = /\.(gltf|glb|obj|usd|usda|usdc|mtlx)$/i;
	function importer() {

		const loaded = [];
		const loader = {
			storage: null,
			_issues: new IssueLog(),
			getFileFormat: path => ( MODEL.test( path ) ? { type: 'model' } : null ),
			releaseTargetModel() {},
			applyEnvironmentToScene() {},
			onModelLoad: async model => loaded.push( model ),
			dispatchEvent() {},
			_keyed: () => null,
			_reportImageFailure() {},
			_throwDeferred() {},
		};
		return { archives: new ArchiveImporter( loader ), loader, loaded };

	}

	const folderOf = files => localFolder( { files: Object.entries( files ).map( ( [ path, body ] ) => ( { path, file: new File( [ body ], path.split( '/' ).pop() ) } ) ) } );
	const spheres = model => {

		const out = [];
		model.traverse( o => o.isMesh && out.push( o ) );
		return out;

	};

	it( 'lays out every material of a folder\'s documents on a sphere of its own, in a grid', async () => {

		const preview = await materialXPreview( [ 'lib/a.mtlx', 'lib/b.mtlx', 'lib/tex.png' ], async path => encoder.encode( {
			'lib/a.mtlx': fixture( 'mixed.mtlx' ), 'lib/b.mtlx': fixture( 'tiled_wood.mtlx' ),
		}[ path ] ?? '' ) );
		expect( preview.documents ).toEqual( [ 'lib/a.mtlx', 'lib/b.mtlx' ] );
		expect( preview.materials ).toBe( 4 );
		// 4 materials: 2 × 2, centred.
		expect( [ ...preview.text.matchAll( /translate = \(([^)]+)\)/g ) ].map( m => m[ 1 ] ) ).toEqual( [ '-0.625, 0.5, -0.625', '0.625, 0.5, -0.625', '-0.625, 0.5, 0.625', '0.625, 0.5, 0.625' ] );
		expect( preview.text ).toContain( 'prepend references = @lib/b.mtlx@</MaterialX/Materials>' );
		expect( preview.text ).toContain( 'rel material:binding = </MaterialX/Documents/D1/Wood>' );
		const odd = await materialXPreview( [ 'a@b/D0.mtlx' ], async () => encoder.encode( fixture( 'tiled_wood.mtlx' ).replace( /"Wood"/, '"D0"' ) ) );
		expect( odd.text ).toContain( '@@@a@b/D0.mtlx@@@' );
		expect( odd.text ).toContain( 'def Sphere "D0"' );
		expect( await materialXPreview( [ 'a.usda', 'b.png' ], async () => null ) ).toBeNull();

	} );

	it( 'opens a folder of documents and textures, each material on a textured sphere', async () => {

		const { archives, loaded } = importer();
		const model = await archives.loadFolder( folderOf( {
			'kit/mixed.mtlx': fixture( 'mixed.mtlx' ), 'kit/wood/tiled_wood.mtlx': fixture( 'tiled_wood.mtlx' ),
			'kit/maps/brick.jpg': '', 'kit/wood/textures/wood_color.png': '',
		} ) );
		expect( loaded ).toEqual( [ model ] );
		expect( model.name ).toBe( 'mixed.mtlx' );
		const meshes = spheres( model );
		expect( meshes.length ).toBe( 4 );
		expect( meshes.map( m => m.name ).sort() ).toEqual( [ 'Brick', 'Gold', 'Tinted', 'Wood' ] );
		expect( meshes.every( m => m.geometry.getAttribute( 'uv' ) ) ).toBe( true );
		const gold = meshes.find( m => m.material.metalness === 1 );
		expect( gold.material.color.toArray().map( v => Math.round( v * 1000 ) / 1000 ) ).toEqual( [ 1, 0.766, 0.336 ] );

	} );

	it( 'opens one document', async () => {

		const { archives } = importer();
		const model = await archives.loadUSDScene( { 'gold.mtlx': new File( [ fixture( 'mixed.mtlx' ) ], 'gold.mtlx' ) }, 'gold.mtlx' );
		expect( spheres( model ).length ).toBe( 3 );
		expect( model.name ).toBe( 'gold.mtlx' );

	} );

	it( 'leaves a document beside a model or a USD scene to them', async () => {

		const { archives } = importer();
		expect( archives._mainModelPath( [ 'a/model.obj', 'a/look.mtlx' ] ) ).toMatchObject( { path: 'a/model.obj', models: [ 'a/model.obj' ], usd: false } );
		expect( archives._mainModelPath( [ 'look.mtlx', 'deep/scene.usda' ] ) ).toMatchObject( { path: 'deep/scene.usda', usd: true } );
		expect( archives._mainModelPath( [ 'x/look.mtlx', 'x/tex.png' ] ) ).toMatchObject( { path: 'x/look.mtlx', usd: true } );

	} );

	it( 'reads a document\'s materials without loading a scene: from a file, a zip or a folder; none beside a model', async () => {

		const { archives, loaded } = importer();
		const names = async input => ( await archives.readMaterials( input ) )?.map( m => [ m.name, m.material.isMeshPhysicalMaterial ] ) ?? null;
		expect( await names( new File( [ fixture( 'mixed.mtlx' ) ], 'mixed.mtlx' ) ) ).toEqual( [[ 'Brick', true ], [ 'Tinted', true ], [ 'Gold', true ]] );
		const zip = new File( [ zipSync( { 'kit/wood.mtlx': strToU8( fixture( 'tiled_wood.mtlx' ) ), 'kit/textures/wood_color.png': new Uint8Array( 0 ) } ) ], 'kit.zip' );
		expect( await names( zip ) ).toEqual( [[ 'Wood', true ]] );
		const folder = localFolder( { files: [ { path: 'f/gold.mtlx', file: new File( [ fixture( 'mixed.mtlx' ) ], 'gold.mtlx' ) } ] } );
		expect( ( await names( folder ) ).length ).toBe( 3 );
		const withModel = new File( [ zipSync( { 'a.mtlx': strToU8( fixture( 'mixed.mtlx' ) ), 'chair.obj': strToU8( 'v 0 0 0' ) } ) ], 'chair.zip' );
		expect( await names( withModel ) ).toBe( null );
		expect( await names( new File( [ 'not a zip' ], 'notes.txt' ) ) ).toBe( null );
		expect( loaded ).toEqual( [] );

	} );

	it( 'turns a model zip away by its listing, reading none of its files', async () => {

		const { archives } = importer();
		// Bytes no compressor shrinks, stored as they are: reading the model would read all 2 MB.
		const noise = new Uint8Array( 2 << 20 ).map( ( _, i ) => ( i * 2654435761 ) >>> 24 );
		class Counted extends File {

			read = 0;
			slice( ...args ) {

				const part = super.slice( ...args );
				this.read += part.size;
				return part;

			}

		}

		const zip = new Counted( [ zipSync( { 'a.mtlx': strToU8( fixture( 'mixed.mtlx' ) ), 'chair.obj': [ noise, { level: 0 } ] } ) ], 'chair.zip' );
		expect( await archives.readMaterials( zip ) ).toBe( null );
		expect( zip.read ).toBeLessThan( 256 << 10 );

		const plain = new Counted( [ zipSync( { 'notes.txt': [ noise, { level: 0 } ] } ) ], 'notes.zip' );
		expect( await archives.readMaterials( plain ) ).toBe( null );
		expect( plain.read ).toBeLessThan( 256 << 10 );

	} );

	it( 'fails plainly when nothing in it is a material', async () => {

		const { archives } = importer();
		const error = await archives.loadUSDScene( { 'empty.mtlx': new File( [ '<?xml version="1.0"?><materialx version="1.39"/>' ], 'empty.mtlx' ) }, 'empty.mtlx' ).catch( e => e );
		expect( error.message ).toMatch( /No USD layer or MaterialX material found in empty\.mtlx/ );

	} );

} );
