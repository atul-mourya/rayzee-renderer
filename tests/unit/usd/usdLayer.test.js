import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseUSDA } from '@/core/Processor/USD/USDText.js';
import { parseUSDC, Crate, composeListOps, Ref } from '@/core/Processor/USD/USDLayer.js';

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

	it( 'says where it stopped on a malformed layer', () => {

		expect( () => parseUSDA( '#usda 1.0\ndef Xform "a"\n{\n  def\n}\n' ) ).toThrow( /line 5/ );

	} );

} );
