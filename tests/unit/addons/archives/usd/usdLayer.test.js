import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseUSDA } from '@/core/addons/archives/usd/USDText.js';
import { parseUSDC, Crate, composeListOps, Ref } from '@/core/addons/archives/usd/USDLayer.js';

const fixture = name => readFileSync( new URL( `./fixtures/${name}`, import.meta.url ) );
const text = () => parseUSDA( fixture( 'crate.usda' ).toString( 'utf8' ), 'fx/crate.usda' );
const crate = () => {

	const bytes = fixture( 'crate.usdc' );
	return parseUSDC( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), 'fx/crate.usdc' );

};

// The same scene written by OpenUSD as text and as crate (`usdcat crate.usda -o crate.usdc`) reads the same both ways.
describe.each( [[ 'text', text ], [ 'crate', crate ]] )( 'a %s layer', ( _, read ) => {

	const layer = read();
	const root = layer.root.child( 'root' );

	it( 'keeps the layer metadata', () => {

		expect( layer.meta ).toMatchObject( { defaultPrim: 'root', upAxis: 'Z', metersPerUnit: 0.01 } );

	} );

	it( 'keeps every reference and payload, with their list op', () => {

		expect( root.specifier ).toBe( 'def' );
		expect( root.typeName ).toBe( 'Xform' );
		expect( root.arcs.references.prepend ).toEqual( [ new Ref( './a.usda', '' ), new Ref( './b.usda', '/b' ) ] );
		expect( root.arcs.payload.prepend ).toEqual( [ new Ref( './other.usd', '/x' ) ] );
		const proto = root.child( 'inst' ).child( 'proto' );
		expect( [ ...proto.arcs.payload.prepend, ...( proto.arcs.payload.explicit ?? [] ) ] ).toEqual( [ new Ref( './p.usd', '/p' ) ] );

	} );

	it( 'reads values in the type they were written with', () => {

		const value = name => root.property( name ).value;
		expect( Array.from( value( 'primvars:pref' ) ) ).toEqual( [ 1, 2, 3 ] );
		expect( Array.from( value( 'xformOp:transform' ) ) ).toEqual( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1 ] );
		expect( Array.from( value( 'xformOpOrder' ) ) ).toEqual( [ 'xformOp:transform' ] );
		expect( Array.from( value( 'ramp' ) ) ).toEqual( Array.from( { length: 20 }, ( _, i ) => i ) );
		expect( Array.from( value( 'whole' ) ) ).toEqual( Array.from( { length: 20 }, ( _, i ) => i * 2 ) );
		expect( Array.from( value( 'few' ) ) ).toEqual( Array.from( { length: 20 }, ( _, i ) => ( i % 2 ? 0.25 : 0.5 ) ) );
		expect( value( 'label' ) ).toBe( 'a label' );
		expect( value( 'texture' ) ).toBe( './tex/wood.png' );
		expect( root.property( 'uniform' ) ).toBeNull();
		expect( root.property( 'xformOpOrder' ).uniform ).toBe( true );

	} );

	it( 'keeps time samples in time order', () => {

		expect( [ ...root.property( 'animated' ).timeSamples ] ).toEqual( [[ 1, 10 ], [ 2, 20 ]] );

	} );

	it( 'holds quaternions real part last, as three.js does', () => {

		const q = Array.from( root.child( 'inst' ).property( 'orientations' ).value );
		expect( q.slice( 0, 4 ) ).toEqual( [ 0, 0, 0, 1 ] );
		expect( q[ 4 ] ).toBe( 0 );
		expect( q[ 5 ] ).toBeCloseTo( 0.7071, 3 );
		expect( q[ 7 ] ).toBeCloseTo( 0.7071, 3 );

	} );

	it( 'keeps relationship targets and connections', () => {

		expect( root.child( 'inst' ).property( 'prototypes' ).targets.prepend ).toEqual( [ '/root/inst/proto' ] );
		const connections = root.child( 'mat' ).property( 'outputs:surface' ).connections;
		expect( [ ...( connections.explicit ?? [] ), ...connections.prepend ] ).toEqual( [ '/root/mat/shader.outputs:surface' ] );

	} );

	it( 'keeps variant sets and the selection', () => {

		const geo = root.child( 'geo' );
		expect( geo.variantSelection ).toEqual( { shape: 'tall' } );
		expect( geo.arcs.variantSetNames.prepend ).toEqual( [ 'shape' ] );
		expect( geo.variant( 'shape', 'tall' ).child( 'body' ).property( 'points' ).value.length ).toBe( 6 );
		expect( geo.variant( 'shape', 'short' ).child( 'body' ).property( 'points' ).value.length ).toBe( 3 );

	} );

	it( 'keeps dictionary metadata', () => {

		expect( root.meta.customData ).toEqual( { note: 'hello', count: 3 } );

	} );

} );

// types.usda writes every value type, its arrays long enough for the crate's compressed codings; types.usdc is OpenUSD's
// crate of it (`usdcat types.usda -o types.usdc`). Both readers give the same values in the same kind of array.
describe( 'every value type, from text and from crate', () => {

	const kind = v => ( v instanceof Map ? 'Map' : ArrayBuffer.isView( v ) ? v.constructor.name : Array.isArray( v ) ? 'Array' : typeof v );
	const flat = v => ( v instanceof Map ? [ ...v ].map( ( [ k, x ] ) => [ k, kind( x ), flat( x ) ] )
		: ArrayBuffer.isView( v ) || Array.isArray( v ) ? Array.from( v, flat ) : typeof v === 'number' ? + v.toPrecision( 6 ) : v );
	const bytes = fixture( 'types.usdc' );
	const fromText = parseUSDA( fixture( 'types.usda' ).toString( 'utf8' ), 'fx/types.usda' ).root.child( 't' );
	const fromCrate = parseUSDC( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), 'fx/types.usdc' ).root.child( 't' );

	it( 'agree on all of them', () => {

		const read = spec => [ ...spec.props ].sort( ( a, b ) => ( a[ 0 ] < b[ 0 ] ? - 1 : 1 ) ).map( ( [ name, p ] ) => {

			const v = p.timeSamples ?? p.value;
			return [ name, p.type, kind( v ), flat( v ) ];

		} );
		expect( read( fromText ) ).toEqual( read( fromCrate ) );

	} );

	// dicts.usda puts the same kinds of value inside metadata dictionaries (dicts.usdc: `usdcat dicts.usda -o dicts.usdc`).
	it( 'agree inside dictionaries too', () => {

		const read = file => {

			const bytes = fixture( file );
			const layer = file.endsWith( '.usdc' )
				? parseUSDC( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), file )
				: parseUSDA( bytes.toString( 'utf8' ), file );
			const deep = v => ( v && typeof v === 'object' && ! ArrayBuffer.isView( v ) && ! Array.isArray( v )
				? Object.fromEntries( Object.keys( v ).sort().map( k => [ k, deep( v[ k ] ) ] ) ) : [ kind( v ), flat( v ) ] );
			const a = layer.root.child( 'a' ).meta;
			return deep( { layer: layer.meta.customLayerData, assetInfo: a.assetInfo, customData: a.customData } );

		};

		expect( read( 'dicts.usda' ) ).toEqual( read( 'dicts.usdc' ) );
		expect( read( 'dicts.usda' ).layer.logos ).toEqual( [ 'Array', [ './a.png', './b.png' ]] );

	} );

	it( 'read asset arrays, 64-bit and unsigned integers and bools as written', () => {

		for ( const t of [ fromText, fromCrate ] ) {

			expect( t.property( 'assets' ).value ).toEqual( [ './a0.png', './a1.png', './a2.png', './a3.png' ] );
			expect( Array.from( t.property( 'big64' ).value.subarray( 0, 5 ) ) ).toEqual( [ 5000000000, - 5000000000, 2 ** 53 - 1, 0, 7 ] );
			expect( Array.from( t.property( 'bigu' ).value.subarray( 0, 2 ) ) ).toEqual( [ 4294967295, 3000000000 ] );
			expect( [ t.property( 'one64' ).value, t.property( 'oneu' ).value ] ).toEqual( [ 5000000000, 4294967295 ] );
			expect( Array.from( t.property( 'wrap64' ).value.subarray( 0, 2 ) ) ).toEqual( [ 2 ** 63, - ( 2 ** 63 ) ] );
			expect( Array.from( t.property( 'topu64' ).value.subarray( 0, 2 ) ) ).toEqual( [ 2 ** 63, 2 ** 64 ] );
			expect( Array.from( t.property( 'short64' ).value ) ).toEqual( [ 1, - 2, 5000000000 ] );
			expect( t.property( 'bools' ).value.every( b => typeof b === 'boolean' ) ).toBe( true );

		}

	} );

} );

describe( 'crate arrays across file versions', () => {

	const reader = ( minor, words ) => {

		const buffer = new ArrayBuffer( words.length * 4 );
		const view = new DataView( buffer );
		words.forEach( ( [ kind, v ], i ) => ( kind === 'f' ? view.setFloat32( i * 4, v, true ) : view.setUint32( i * 4, v, true ) ) );
		return Object.assign( Object.create( Crate.prototype ), { buffer, bytes: new Uint8Array( buffer ), view, pos: 0, major: 0, minor } );

	};

	const VEC3F = 24;

	it( 'skips the rank written before the size before 0.5.0', () => {

		const r = reader( 4, [[ 'u', 1 ], [ 'u', 2 ], [ 'f', 1 ], [ 'f', 2 ], [ 'f', 3 ], [ 'f', 4 ], [ 'f', 5 ], [ 'f', 6 ]] );
		expect( Array.from( r.array( VEC3F, false ) ) ).toEqual( [ 1, 2, 3, 4, 5, 6 ] );

	} );

	it( 'reads a 32-bit size before 0.7.0 and a 64-bit one after', () => {

		const short = reader( 6, [[ 'u', 1 ], [ 'f', 7 ], [ 'f', 8 ], [ 'f', 9 ]] );
		expect( Array.from( short.array( VEC3F, false ) ) ).toEqual( [ 7, 8, 9 ] );
		const long = reader( 8, [[ 'u', 1 ], [ 'u', 0 ], [ 'f', 7 ], [ 'f', 8 ], [ 'f', 9 ]] );
		expect( Array.from( long.array( VEC3F, false ) ) ).toEqual( [ 7, 8, 9 ] );

	} );

} );

describe( 'list ops', () => {

	it( 'apply weakest first: an explicit list resets, prepends and appends move items, deletes remove them', () => {

		const weak = { explicit: [ 'a', 'b' ], prepend: [], append: [], add: [], delete: [] };
		const strong = { explicit: null, prepend: [ 'c', 'b' ], append: [ 'a' ], add: [ 'd' ], delete: [] };
		expect( composeListOps( [ strong, weak ] ).map( i => i.value ) ).toEqual( [ 'c', 'b', 'd', 'a' ] );
		const remove = { explicit: null, prepend: [], append: [], add: [], delete: [ 'b' ] };
		expect( composeListOps( [ remove, strong, weak ] ).map( i => i.value ) ).toEqual( [ 'c', 'd', 'a' ] );

	} );

	it( 'say which layer authored each item', () => {

		const items = composeListOps( [ { explicit: null, prepend: [ 'x' ], append: [], add: [], delete: [] }, { explicit: [ 'y' ], prepend: [], append: [], add: [], delete: [] } ], [ 'strong', 'weak' ] );
		expect( items ).toEqual( [ { value: 'x', source: 'strong' }, { value: 'y', source: 'weak' } ] );

	} );

} );

describe( 'the text format', () => {

	it( 'reads prepend payload, over prims with variant selections, and a doc string', () => {

		const layer = parseUSDA( `#usda 1.0
(
    "the layer's doc"
    subLayers = [ @./base.usda@, @./more.usda@ ( offset = 10; scale = 2 ) ]
)
def Xform "a" ( prepend payload = @./m.usd@</a/geo> )
{
    over "geometry" ( variants = { string model = "two" } )
    {
    }
    custom float inputs:x.connect = </mat.inputs:x>
    rel material:binding = [</m1>, </m2>]
    float3 xformOp:rotateXYZ = (-40, 25, 1e-3)
    float big = -inf
}
` );
		const a = layer.root.child( 'a' );
		expect( layer.meta.doc ).toBe( 'the layer\'s doc' );
		expect( layer.meta.subLayers ).toEqual( [ './base.usda', './more.usda' ] );
		expect( a.arcs.payload.prepend ).toEqual( [ new Ref( './m.usd', '/a/geo' ) ] );
		expect( a.child( 'geometry' ) ).toMatchObject( { specifier: 'over', variantSelection: { model: 'two' } } );
		expect( a.property( 'inputs:x' ).connections.explicit ).toEqual( [ '/mat.inputs:x' ] );
		expect( a.property( 'material:binding' ).targets.explicit ).toEqual( [ '/m1', '/m2' ] );
		expect( Array.from( a.property( 'xformOp:rotateXYZ' ).value ) ).toEqual( [ - 40, 25, 0.001 ] );
		expect( a.property( 'big' ).value ).toBe( - Infinity );

	} );

	it( 'reads dictionaries inside dictionaries, as OpenUSD and Omniverse write them', () => {

		const layer = parseUSDA( `#usda 1.0
(
    customLayerData = {
        dictionary cameraSettings = {
            dictionary Front = {
                double3 position = (5, 0, 0)
                double radius = 500
            }
            string boundCamera = "/OmniverseKit_Persp"
        }
    }
    defaultPrim = "World"
)
def Xform "World" ( customData = { dictionary a = { int b = 2 } } )
{
}
` );
		expect( layer.meta.customLayerData.cameraSettings ).toEqual( { Front: { position: [ 5, 0, 0 ], radius: 500 }, boundCamera: '/OmniverseKit_Persp' } );
		expect( layer.meta.defaultPrim ).toBe( 'World' );
		expect( layer.root.child( 'World' ).meta.customData ).toEqual( { a: { b: 2 } } );

	} );

	// syntax.usda is written to use the text format's corners; syntax.usdc is OpenUSD's crate of it
	// (`usdcat syntax.usda -o syntax.usdc`). Both readers must agree on everything the scene reads.
	it( 'reads every corner of the text format as OpenUSD does', () => {

		const number = v => ( Number.isFinite( v ) ? + v.toPrecision( 6 ) : String( v ) );
		const plainOf = v => ( v === null || v === undefined ? null : typeof v === 'number' ? number( v )
			: ArrayBuffer.isView( v ) || Array.isArray( v ) ? Array.from( v, plainOf )
				: v instanceof Map ? [ ...v ].map( ( [ k, x ] ) => [ number( k ), plainOf( x ) ] )
					: typeof v === 'object' ? Object.fromEntries( Object.keys( v ).filter( k => ! k.startsWith( '_' ) ).sort().map( k => [ k, plainOf( v[ k ] ) ] ) ) : v );
		// The two readers name doc strings differently, keep child order apart, and only the crate one keeps an unread
		// `spline` field; nothing composes any of them.
		const metaOf = meta => plainOf( Object.fromEntries( Object.entries( meta ).filter( ( [ k ] ) => ! [ 'doc', 'documentation', 'comment', 'primOrder', 'spline' ].includes( k ) ) ) );
		const prim = spec => ( {
			specifier: spec.specifier, typeName: spec.typeName, meta: metaOf( spec.meta ), arcs: plainOf( spec.arcs ), variants: plainOf( spec.variantSelection ),
			variantSets: spec.variantSets && [ ...spec.variantSets ].map( ( [ set, m ] ) => [ set, [ ...m ].map( ( [ name, v ] ) => [ name, prim( v ) ] ) ] ),
			children: spec.children && [ ...spec.children ].map( ( [ name, c ] ) => [ name, prim( c ) ] ),
			props: spec.props && [ ...spec.props ].sort( ( a, b ) => ( a[ 0 ] < b[ 0 ] ? - 1 : 1 ) ).map( ( [ name, p ] ) => [ name, {
				rel: p.rel, type: p.type, value: plainOf( p.value ), hasValue: p.hasValue, timeSamples: plainOf( p.timeSamples ),
				targets: plainOf( p.targets ), connections: plainOf( p.connections ), meta: metaOf( p.meta ), custom: p.custom, uniform: p.rel || p.uniform,
			} ] ),
		} );
		const read = layer => ( { meta: metaOf( layer.meta ), root: prim( layer.root ) } );

		const bytes = fixture( 'syntax.usdc' );
		const fromText = parseUSDA( fixture( 'syntax.usda' ).toString( 'utf8' ), 'fx/syntax.usda' );
		const fromCrate = parseUSDC( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), 'fx/syntax.usdc' );
		expect( read( fromText ) ).toEqual( read( fromCrate ) );

		const world = fromText.root.child( 'world' );
		expect( fromText.meta.doc ).toBe( 'A doc string\nover two lines' );
		expect( fromText.meta.customLayerData[ 'key with spaces' ] ).toBe( 'it\'s "quoted"\tand tabbed\non two lines' );
		expect( world.property( 'tex' ).value ).toBe( './has @ sign.png' );
		expect( [ ...world.property( 'opacity' ).timeSamples ] ).toEqual( [[ - 1, 0.25 ], [ 0.5, null ], [ 2, 1 ]] );
		expect( world.property( 'h' ).value ).toBe( - Infinity );
		expect( world.reorder ).toEqual( [ 'b', 'a' ] );

	} );

	it( 'steps over a spline, as authored and as OpenUSD writes it, and reads on', () => {

		for ( const spline of [
			'{\n        bezier,\n        pre: held,\n        post: linear,\n        1: 0; post held,\n        5: 10,\n    }',
			'{\n        post: linear,\n        1: 0; pre (0, 0); post held,\n        5: 10; post held,\n    }',
		] ) {

			const layer = parseUSDA( `#usda 1.0\ndef Xform "a"\n{\n    double x.spline = ${spline}\n    double y = 2\n}\ndef Xform "b"\n{\n}\n` );
			const a = layer.root.child( 'a' );
			expect( [ a.property( 'x' ).hasValue, a.property( 'y' ).value, !! layer.root.child( 'b' ) ] ).toEqual( [ false, 2, true ] );

		}

		// Not syntax OpenUSD 0.25 accepts, but a later knot carrying data would bring braces and strings of its own.
		const ahead = parseUSDA( '#usda 1.0\ndef Xform "a"\n{\n    double x.spline = { 1: 0 { string s = "}" }, 2: 1 }\n    double y = 3\n}\n' );
		expect( ahead.root.child( 'a' ).property( 'y' ).value ).toBe( 3 );
		expect( () => parseUSDA( '#usda 1.0\ndef Xform "a"\n{\n    double x.spline = {\n        1: 0,\n' ) ).toThrow( /unterminated block/ );

	} );

	it( 'says where it stopped on a malformed layer', () => {

		expect( () => parseUSDA( '#usda 1.0\ndef Xform "a"\n{\n  def\n}\n' ) ).toThrow( /line 5/ );

	} );

} );
