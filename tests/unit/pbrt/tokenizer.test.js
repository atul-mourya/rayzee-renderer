import { describe, it, expect } from 'vitest';
import { tokenize, TokenStream, TokenType } from '@/core/Processor/PBRT/PBRTTokenizer.js';

const enc = new TextEncoder();
const values = src => tokenize( src ).map( t => t.value );
const types = src => tokenize( src ).map( t => t.type );

describe( 'pbrt tokenizer', () => {

	it( 'reads the four lexical forms', () => {

		expect( types( 'Shape "trianglemesh" [ 1 2 ]' ) ).toEqual( [
			TokenType.WORD, TokenType.STRING, TokenType.LBRACKET,
			TokenType.NUMBER, TokenType.NUMBER, TokenType.RBRACKET
		] );

	} );

	it( 'drops comments to end of line', () => {

		expect( values( '# a comment\nWorldBegin # trailing\nAttributeEnd' ) )
			.toEqual( [ 'WorldBegin', 'AttributeEnd' ] );

	} );

	it( 'accepts bytes and a string identically', () => {

		const src = 'LookAt 1 -2.5 .5 "x"';
		expect( values( src ) ).toEqual( values( enc.encode( src ) ) );

	} );

	it( 'throws on an unterminated string', () => {

		expect( () => tokenize( 'Shape "oops' ) ).toThrow( /unterminated string/ );

	} );

	it( 'keeps a multi-byte string intact', () => {

		expect( values( '"café"' ) ).toEqual( [ 'café' ] );

	} );

} );

describe( 'number scanning', () => {

	it( 'handles every literal form pbrt writes', () => {

		expect( values( '1 -1 +1 .5 -.5 0.25 1e-3 1E3 -2.5e+2 1675.3383' ) )
			.toEqual( [ 1, - 1, 1, 0.5, - 0.5, 0.25, 1e-3, 1e3, - 250, 1675.3383 ] );

	} );

	it( 'matches Number() across a wide spread of values', () => {

		// The scanner rebuilds the value from digits rather than slicing a string, so it has
		// to agree with the reference parse on ordinary scene coordinates.
		const samples = [];
		for ( let i = 0; i < 4000; i ++ ) {

			const mantissa = ( ( i * 2654435761 ) % 1e9 ) / 1e4;
			const sign = i % 2 ? '-' : '';
			samples.push( `${sign}${mantissa}` );

		}

		samples.push( '9542.965', '-15104.931', '4800.5444', '0.000001', '1e-30', '1e30', '123456789.5' );

		const parsed = values( samples.join( ' ' ) );
		for ( let i = 0; i < samples.length; i ++ ) {

			expect( parsed[ i ] ).toBe( Number( samples[ i ] ) );

		}

	} );

	it( 'falls back to Number() past 15 significant digits', () => {

		const long = '1.234567890123456789';
		expect( values( long ) ).toEqual( [ Number( long ) ] );
		const huge = '123456789012345678901234';
		expect( values( huge ) ).toEqual( [ Number( huge ) ] );

	} );

	it( 'does not swallow a trailing e that is not an exponent', () => {

		// "1e" is a number followed by a word in pbrt's grammar, not a malformed float.
		const toks = tokenize( '1efoo' );
		expect( toks[ 0 ] ).toEqual( { type: TokenType.NUMBER, value: 1 } );
		expect( toks[ 1 ] ).toEqual( { type: TokenType.WORD, value: 'efoo' } );

	} );

	it( 'separates numbers from following brackets without whitespace', () => {

		expect( values( '[1 2]' ) ).toEqual( [ undefined, 1, 2, undefined ] );

	} );

} );

describe( 'TokenStream', () => {

	it( 'peeks without consuming and ends with null', () => {

		const s = new TokenStream( 'A 1' );
		expect( s.peek().value ).toBe( 'A' );
		expect( s.peek().value ).toBe( 'A' );
		expect( s.next().value ).toBe( 'A' );
		expect( s.next().value ).toBe( 1 );
		expect( s.next() ).toBe( null );
		expect( s.peek() ).toBe( null );

	} );

	it( 'never materialises the source as one string', () => {

		// The point of scanning bytes: files reach 2.4 GB, past what a string can hold.
		const bytes = enc.encode( 'Shape "sphere" "float radius" [ 2 ]' );
		const s = new TokenStream( bytes );
		expect( s.bytes ).toBe( bytes );

		const seen = [];
		for ( let t = s.next(); t !== null; t = s.next() ) seen.push( t.value );
		expect( seen ).toEqual( [ 'Shape', 'sphere', 'float radius', undefined, 2, undefined ] );

	} );

} );
