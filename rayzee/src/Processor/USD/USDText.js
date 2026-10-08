/**
 * USD's text format (.usda) read into a Layer (USDLayer.js): prims with their specifier, metadata, composition arcs,
 * variant sets and properties. Values stay as authored; numeric arrays become typed arrays.
 */

import { Layer, Ref } from './USDLayer.js';

const LIST_OPS = new Set( [ 'prepend', 'append', 'add', 'delete', 'reorder' ] );
const SPECIFIERS = new Set( [ 'def', 'over', 'class' ] );
const QUALIFIERS = new Set( [ 'custom', 'uniform', 'varying', 'config' ] );

const INT_TYPES = new Set( [ 'int', 'int2', 'int3', 'int4', 'uint', 'int64', 'uint64', 'uchar' ] );
const DOUBLE_TYPES = new Set( [ 'double', 'double2', 'double3', 'double4', 'matrix2d', 'matrix3d', 'matrix4d', 'quatd', 'timecode',
	'point3d', 'vector3d', 'normal3d', 'color3d', 'color4d', 'texCoord2d', 'texCoord3d', 'frame4d' ] );
const NON_NUMERIC = new Set( [ 'token', 'string', 'asset', 'bool', 'dictionary', 'opaque', 'pathExpression' ] );

class Asset {

	constructor( path ) {

		this.asset = path;

	}

}

class Path {

	constructor( path ) {

		this.path = path;

	}

}

const isIdentStart = c => ( c >= 65 && c <= 90 ) || ( c >= 97 && c <= 122 ) || c === 95;
const isIdentChar = c => isIdentStart( c ) || ( c >= 48 && c <= 57 ) || c === 58 || c === 46;

class Reader {

	constructor( text ) {

		this.s = text;
		this.i = 0;

	}

	fail( message ) {

		let line = 1;
		for ( let k = 0; k < this.i && k < this.s.length; k ++ ) if ( this.s.charCodeAt( k ) === 10 ) line ++;
		throw new Error( `usda line ${line}: ${message}` );

	}

	skip() {

		const s = this.s;
		for ( ;; ) {

			const c = s.charCodeAt( this.i );
			if ( c === 32 || c === 9 || c === 10 || c === 13 || c === 59 ) this.i ++;
			else if ( c === 35 ) {

				while ( this.i < s.length && s.charCodeAt( this.i ) !== 10 ) this.i ++;

			} else return c;

		}

	}

	peek() {

		return this.skip();

	}

	startsNumber( c ) {

		if ( ( c >= 48 && c <= 57 ) || c === 46 ) return true;
		if ( c !== 45 && c !== 43 ) return false;
		const n = this.s.charCodeAt( this.i + 1 );
		return ( n >= 48 && n <= 57 ) || n === 46 || n === 105;

	}

	/** A layer offset after a reference or sublayer, `( offset = 10; scale = 2 )`, which nothing here applies. */
	skipLayerOffset() {

		const save = this.i;
		if ( this.peek() !== 40 ) return;
		this.i ++;
		const word = this.peekIdent();
		this.i = save;
		if ( word !== 'offset' && word !== 'scale' ) return;
		this.skip();
		const end = this.s.indexOf( ')', this.i );
		if ( end < 0 ) this.fail( 'unterminated layer offset' );
		this.i = end + 1;

	}

	eat( ch ) {

		if ( this.skip() !== ch.charCodeAt( 0 ) ) this.fail( `expected "${ch}", found "${this.s[ this.i ] ?? 'end of file'}"` );
		this.i ++;

	}

	maybe( ch ) {

		if ( this.skip() !== ch.charCodeAt( 0 ) ) return false;
		this.i ++;
		return true;

	}

	ident() {

		const c = this.skip();
		if ( ! isIdentStart( c ) ) this.fail( `expected a name, found "${this.s[ this.i ] ?? 'end of file'}"` );
		const start = this.i ++;
		while ( isIdentChar( this.s.charCodeAt( this.i ) ) ) this.i ++;
		return this.s.slice( start, this.i );

	}

	peekIdent() {

		const save = this.i;
		const c = this.skip();
		if ( ! isIdentStart( c ) ) {

			this.i = save;
			return null;

		}

		const word = this.ident();
		this.i = save;
		return word;

	}

	string() {

		const c = this.skip();
		if ( c !== 34 && c !== 39 ) this.fail( `expected a string, found "${this.s[ this.i ] ?? 'end of file'}"` );
		const s = this.s;
		const q = s[ this.i ];
		if ( s.startsWith( q + q + q, this.i ) ) {

			const end = s.indexOf( q + q + q, this.i + 3 );
			if ( end < 0 ) this.fail( 'unterminated string' );
			const value = s.slice( this.i + 3, end );
			this.i = end + 3;
			return value;

		}

		let out = '';
		let start = ++ this.i;
		for ( ;; ) {

			const c = s.charCodeAt( this.i );
			if ( Number.isNaN( c ) ) this.fail( 'unterminated string' );
			if ( c === 92 ) {

				out += s.slice( start, this.i );
				const e = s[ this.i + 1 ];
				out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
				this.i += 2;
				start = this.i;
				continue;

			}

			if ( s[ this.i ] === q ) break;
			this.i ++;

		}

		out += s.slice( start, this.i );
		this.i ++;
		return out;

	}

	asset() {

		const s = this.s;
		if ( s.startsWith( '@@@', this.i ) ) {

			const end = s.indexOf( '@@@', this.i + 3 );
			if ( end < 0 ) this.fail( 'unterminated asset path' );
			const value = s.slice( this.i + 3, end );
			this.i = end + 3;
			return value;

		}

		const end = s.indexOf( '@', this.i + 1 );
		if ( end < 0 ) this.fail( 'unterminated asset path' );
		const value = s.slice( this.i + 1, end );
		this.i = end + 1;
		return value;

	}

	path() {

		const end = this.s.indexOf( '>', this.i + 1 );
		if ( end < 0 ) this.fail( 'unterminated path' );
		const value = this.s.slice( this.i + 1, end );
		this.i = end + 1;
		return value;

	}

	number() {

		const s = this.s;
		const start = this.i;
		if ( s[ this.i ] === '-' || s[ this.i ] === '+' ) this.i ++;
		if ( s.startsWith( 'inf', this.i ) ) {

			this.i += 3;
			return s[ start ] === '-' ? - Infinity : Infinity;

		}

		while ( this.i < s.length ) {

			const c = s.charCodeAt( this.i );
			if ( ( c >= 48 && c <= 57 ) || c === 46 ) this.i ++;
			else if ( c === 101 || c === 69 ) {

				this.i ++;
				if ( s[ this.i ] === '-' || s[ this.i ] === '+' ) this.i ++;

			} else break;

		}

		const value = Number( s.slice( start, this.i ) );
		if ( Number.isNaN( value ) ) this.fail( `bad number "${s.slice( start, this.i )}"` );
		return value;

	}

	value() {

		const c = this.skip();
		if ( c === 40 ) return this.sequence( ')' );
		if ( c === 91 ) return this.sequence( ']' );
		if ( c === 123 ) return this.dictionary();
		if ( c === 34 || c === 39 ) return this.string();
		if ( c === 64 ) {

			const asset = this.asset();
			const value = this.peek() === 60 ? new Ref( asset, this.path() ) : new Asset( asset );
			this.skipLayerOffset();
			return value;

		}

		if ( c === 60 ) {

			const value = new Path( this.path() );
			this.skipLayerOffset();
			return value;

		}

		if ( this.startsNumber( c ) ) return this.number();
		const word = this.ident();
		if ( word === 'true' ) return true;
		if ( word === 'false' ) return false;
		if ( word === 'None' ) return null;
		if ( word === 'inf' ) return Infinity;
		if ( word === 'nan' ) return NaN;
		return word;

	}

	sequence( close ) {

		this.i ++;
		const out = [];
		while ( this.peek() !== close.charCodeAt( 0 ) ) {

			out.push( this.value() );
			if ( ! this.maybe( ',' ) ) break;

		}

		this.eat( close );
		return out;

	}

	/** `{ type key = value ... }`, as metadata dictionaries and `variants` are written. */
	dictionary() {

		this.i ++;
		const out = {};
		while ( this.peek() !== 125 ) {

			if ( this.startsNumber( this.peek() ) ) {

				// timeSamples: { 1: value, 2: value }
				const time = this.number();
				this.eat( ':' );
				out[ time ] = this.value();
				this.maybe( ',' );
				continue;

			}

			let type = this.ident();
			if ( this.peek() === 91 && this.s[ this.i + 1 ] === ']' ) {

				this.i += 2;
				type += '[]';

			}

			const key = this.peek() === 34 || this.peek() === 39 ? this.string() : this.ident();
			this.eat( '=' );
			out[ key ] = type === 'dictionary' ? this.dictionary() : this.value();
			this.maybe( ',' );

		}

		this.eat( '}' );
		return out;

	}

}

function refsOf( value ) {

	if ( value === null ) return [];
	const items = Array.isArray( value ) ? value : [ value ];
	const out = [];
	for ( const item of items ) {

		if ( item instanceof Ref ) out.push( item );
		else if ( item instanceof Asset ) out.push( new Ref( item.asset, '' ) );
		else if ( item instanceof Path ) out.push( new Ref( '', item.path ) );

	}

	return out;

}

function pathsOf( value ) {

	if ( value === null ) return [];
	return ( Array.isArray( value ) ? value : [ value ] ).filter( v => v instanceof Path ).map( v => v.path );

}

function stringsOf( value ) {

	if ( value === null ) return [];
	return ( Array.isArray( value ) ? value : [ value ] ).map( String );

}

function plain( value ) {

	if ( value instanceof Asset ) return value.asset;
	if ( value instanceof Path ) return value.path;
	if ( Array.isArray( value ) ) return value.map( plain );
	return value;

}

function flatten( value, out ) {

	for ( const v of value ) {

		if ( Array.isArray( v ) ) flatten( v, out );
		else out.push( v );

	}

	return out;

}

function typed( type, value ) {

	if ( value === null || value === undefined ) return value;
	const array = type.endsWith( '[]' );
	const base = array ? type.slice( 0, - 2 ) : type;
	if ( NON_NUMERIC.has( base ) || ! Array.isArray( value ) ) return plain( value );
	const numbers = flatten( value, [] );
	// Text writes a quaternion real part first; crate files and three.js keep it last.
	if ( base.startsWith( 'quat' ) ) {

		for ( let i = 0; i + 3 < numbers.length; i += 4 ) numbers.splice( i, 4, numbers[ i + 1 ], numbers[ i + 2 ], numbers[ i + 3 ], numbers[ i ] );

	}

	if ( ! array ) return numbers;
	if ( INT_TYPES.has( base ) ) return Int32Array.from( numbers );
	if ( DOUBLE_TYPES.has( base ) ) return Float64Array.from( numbers );
	return Float32Array.from( numbers );

}

function setPrimMeta( spec, key, op, value ) {

	switch ( key ) {

		case 'references':
		case 'payload':
			spec.setArc( key, op, refsOf( value ) );
			return;
		case 'inherits':
		case 'specializes':
			spec.setArc( key, op, pathsOf( value ) );
			return;
		case 'variantSets':
			spec.setArc( 'variantSetNames', op, stringsOf( value ) );
			return;
		case 'apiSchemas':
			spec.setArc( 'apiSchemas', op, stringsOf( value ) );
			return;
		case 'variants':
			spec.variantSelection = { ...( spec.variantSelection ?? {} ), ...value };
			return;
		default:
			spec.meta[ key ] = plain( value );

	}

}

class TextParser extends Reader {

	parse( path ) {

		const layer = new Layer( path );
		if ( this.s.charCodeAt( 0 ) === 0xFEFF ) this.i = 1;
		if ( ! this.s.startsWith( '#usda', this.i ) ) throw new Error( 'not a usda layer' );
		while ( this.i < this.s.length && this.s.charCodeAt( this.i ) !== 10 ) this.i ++;

		if ( this.peek() === 40 ) this.metadata( ( key, op, value ) => {

			if ( key === 'subLayers' ) layer.meta.subLayers = refsOf( value ).map( r => r.asset );
			else layer.meta[ key ] = plain( value );

		}, doc => {

			layer.meta.doc = doc;

		} );

		while ( ! Number.isNaN( this.peek() ) ) this.prim( layer.root );

		return layer;

	}

	metadata( onEntry, onDoc = null ) {

		this.eat( '(' );
		while ( this.peek() !== 41 ) {

			const c = this.peek();
			if ( c === 34 || c === 39 ) {

				const doc = this.string();
				if ( onDoc ) onDoc( doc );
				continue;

			}

			let key = this.ident();
			let op = 'explicit';
			if ( LIST_OPS.has( key ) ) {

				op = key;
				key = this.ident();

			}

			this.eat( '=' );
			onEntry( key, op, this.value() );

		}

		this.eat( ')' );

	}

	prim( parent ) {

		const specifier = this.ident();
		if ( ! SPECIFIERS.has( specifier ) ) this.fail( `expected def, over or class, found "${specifier}"` );
		const typeName = this.peek() === 34 || this.peek() === 39 ? '' : this.ident();
		const name = this.string();
		const spec = parent.child( name, true );
		spec.specifier = specifier;
		spec.typeName = typeName;
		if ( this.peek() === 40 ) this.metadata( ( key, op, value ) => setPrimMeta( spec, key, op, value ), doc => {

			spec.meta.doc = doc;

		} );

		this.body( spec );

	}

	body( spec ) {

		this.eat( '{' );
		while ( this.peek() !== 125 ) {

			const word = this.peekIdent();
			if ( word === null ) this.fail( `unexpected "${this.s[ this.i ] ?? 'end of file'}" in a prim` );
			if ( SPECIFIERS.has( word ) ) this.prim( spec );
			else if ( word === 'variantSet' ) this.variantSet( spec );
			else if ( word === 'reorder' ) {

				this.ident();
				const what = this.ident();
				this.eat( '=' );
				const order = stringsOf( this.value() );
				if ( what === 'nameChildren' ) spec.reorder = order;

			} else this.property( spec );

		}

		this.eat( '}' );

	}

	variantSet( spec ) {

		this.ident();
		const setName = this.string();
		this.eat( '=' );
		this.eat( '{' );
		while ( this.peek() !== 125 ) {

			const variant = spec.variant( setName, this.string(), true );
			if ( this.peek() === 40 ) this.metadata( ( key, op, value ) => setPrimMeta( variant, key, op, value ) );
			this.body( variant );

		}

		this.eat( '}' );

	}

	property( spec ) {

		let word = this.ident();
		let op = 'explicit';
		let uniform = false;
		let custom = false;
		for ( ;; ) {

			if ( LIST_OPS.has( word ) ) op = word;
			else if ( QUALIFIERS.has( word ) ) {

				if ( word === 'uniform' ) uniform = true;
				if ( word === 'custom' ) custom = true;

			} else break;
			word = this.ident();

		}

		if ( word === 'rel' ) {

			const name = this.ident();
			const prop = spec.property( name, true );
			prop.rel = true;
			prop.custom = custom;
			if ( this.maybe( '=' ) ) {

				const targets = this.value();
				prop.setTargets( op, pathsOf( targets ) );

			}

			if ( this.peek() === 40 ) this.metadata( ( key, _, value ) => {

				prop.meta[ key ] = plain( value );

			}, () => {} );
			return;

		}

		let type = word;
		if ( this.peek() === 91 && this.s[ this.i + 1 ] === ']' ) {

			this.i += 2;
			type += '[]';

		}

		let name = this.ident();
		let mode = 'default';
		for ( const suffix of [ '.connect', '.timeSamples', '.spline' ] ) {

			if ( name.endsWith( suffix ) ) {

				mode = suffix.slice( 1 );
				name = name.slice( 0, - suffix.length );

			}

		}

		const prop = spec.property( name, true );
		prop.type = type;
		prop.uniform = uniform || prop.uniform;
		prop.custom = custom;

		if ( this.maybe( '=' ) ) {

			if ( mode === 'connect' ) prop.setConnections( op, pathsOf( this.value() ) );
			else if ( mode === 'timeSamples' ) {

				const samples = this.value();
				prop.timeSamples = new Map( Object.entries( samples ).map( ( [ t, v ] ) => [ Number( t ), typed( type, v ) ] ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] ) );

			} else if ( mode === 'spline' ) {

				this.value();

			} else {

				const value = this.value();
				prop.value = value === null ? null : typed( type, value );
				prop.hasValue = true;

			}

		}

		if ( this.peek() === 40 ) this.metadata( ( key, _, value ) => {

			prop.meta[ key ] = plain( value );

		}, doc => {

			prop.meta.doc = doc;

		} );

	}

}

export function parseUSDA( text, path = '' ) {

	return new TextParser( text ).parse( path );

}

