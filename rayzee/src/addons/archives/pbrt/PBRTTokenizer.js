/**
 * Tokenizer for the pbrt-v4 scene description grammar.
 *
 * pbrt files are a flat stream of directives. Lexically there are only four
 * things to recognize:
 *   - quoted strings:  "perspective", "float fov"
 *   - numbers:         1, -2.5, 1e-3, .5
 *   - brackets:        [ ]   (array delimiters)
 *   - bare words:      WorldBegin, Shape, true, false  (directives / bools)
 * Comments run from '#' to end of line.
 *
 * Scans BYTES, not a string, and hands the parser one token at a time. Scene files
 * reach 2.4 GB — far past both the 512 MB a JavaScript string can hold and what an
 * array of a hundred million token objects would cost — so neither the source text
 * nor the token stream is ever materialised whole.
 *
 * Pure JS, no Three.js — keeps it unit-testable in node.
 */

export const TokenType = {
	STRING: 'string', // quoted string, quotes stripped
	NUMBER: 'number', // numeric literal, already parsed to Number
	WORD: 'word', // bare identifier (directive name, true/false)
	LBRACKET: '[',
	RBRACKET: ']'
};

const TAB = 9, LF = 10, FF = 12, CR = 13, SPACE = 32;
const QUOTE = 34, HASH = 35, PLUS = 43, MINUS = 45, DOT = 46;
const ZERO = 48, NINE = 57, LBRACKET = 91, RBRACKET = 93;
const UPPER_E = 69, LOWER_E = 101;

const isSpace = b => b === SPACE || b === TAB || b === LF || b === CR || b === FF;
const isDigit = b => b >= ZERO && b <= NINE;

// Beyond 15 significant digits the scaled-integer shortcut loses the last bits, so
// those rare tokens go through Number() instead. 10^0..10^22 are the powers of ten a
// double holds exactly.
const MAX_EXACT_DIGITS = 15;
const MAX_EXACT_POW10 = 22;
const POW10 = ( () => {

	const t = new Float64Array( MAX_EXACT_POW10 + 1 );
	for ( let i = 0; i < t.length; i ++ ) t[ i ] = Math.pow( 10, i );
	return t;

} )();

const utf8 = new TextDecoder();

function decodeRange( bytes, start, end ) {

	const len = end - start;
	if ( len === 0 ) return '';

	let ascii = true;
	for ( let i = start; i < end; i ++ ) if ( bytes[ i ] > 127 ) {

		ascii = false; break;

	}

	if ( ! ascii ) return utf8.decode( bytes.subarray( start, end ) );

	let out = '';
	for ( let i = start; i < end; i ++ ) out += String.fromCharCode( bytes[ i ] );
	return out;

}

/**
 * Pull-based lexer over a byte buffer.
 *
 * `peek()` returns the next token without consuming it, `next()` consumes it, and both
 * return null at end of input.
 */
export class TokenStream {

	/** @param {Uint8Array|string} source */
	constructor( source ) {

		this.bytes = typeof source === 'string' ? new TextEncoder().encode( source ) : source;
		this.i = 0;
		this.n = this.bytes.length;
		this._ahead = null;

	}

	peek() {

		if ( this._ahead === null ) this._ahead = this._scan();
		return this._ahead;

	}

	next() {

		const t = this.peek();
		this._ahead = null;
		return t;

	}

	_scan() {

		const b = this.bytes;
		let i = this.i;
		const n = this.n;

		for ( ;; ) {

			while ( i < n && isSpace( b[ i ] ) ) i ++;
			if ( i < n && b[ i ] === HASH ) {

				while ( i < n && b[ i ] !== LF ) i ++;
				continue;

			}

			break;

		}

		if ( i >= n ) {

			this.i = i;
			return null;

		}

		const c = b[ i ];

		if ( c === LBRACKET ) {

			this.i = i + 1;
			return { type: TokenType.LBRACKET };

		}

		if ( c === RBRACKET ) {

			this.i = i + 1;
			return { type: TokenType.RBRACKET };

		}

		if ( c === QUOTE ) {

			const start = ++ i;
			while ( i < n && b[ i ] !== QUOTE ) i ++;
			if ( i >= n ) throw new Error( 'PBRT tokenizer: unterminated string literal' );
			this.i = i + 1;
			return { type: TokenType.STRING, value: decodeRange( b, start, i ) };

		}

		if ( isDigit( c ) || ( c === DOT && isDigit( b[ i + 1 ] ) )
			|| ( ( c === MINUS || c === PLUS ) && ( isDigit( b[ i + 1 ] ) || ( b[ i + 1 ] === DOT && isDigit( b[ i + 2 ] ) ) ) ) ) {

			return this._scanNumber( i );

		}

		const start = i;
		while ( i < n ) {

			const ch = b[ i ];
			if ( isSpace( ch ) || ch === QUOTE || ch === LBRACKET || ch === RBRACKET || ch === HASH ) break;
			i ++;

		}

		this.i = i;
		return { type: TokenType.WORD, value: decodeRange( b, start, i ) };

	}

	_scanNumber( start ) {

		const b = this.bytes;
		const n = this.n;
		let i = start;

		let negative = false;
		if ( b[ i ] === MINUS ) {

			negative = true; i ++;

		} else if ( b[ i ] === PLUS ) i ++;

		let mantissa = 0;
		let digits = 0;
		let fracDigits = 0;

		while ( i < n && isDigit( b[ i ] ) ) {

			mantissa = mantissa * 10 + ( b[ i ] - ZERO );
			digits ++; i ++;

		}

		if ( i < n && b[ i ] === DOT ) {

			i ++;
			while ( i < n && isDigit( b[ i ] ) ) {

				mantissa = mantissa * 10 + ( b[ i ] - ZERO );
				digits ++; fracDigits ++; i ++;

			}

		}

		let exponent = 0;
		if ( i < n && ( b[ i ] === LOWER_E || b[ i ] === UPPER_E ) ) {

			let j = i + 1;
			let expNeg = false;
			if ( j < n && ( b[ j ] === MINUS || b[ j ] === PLUS ) ) {

				expNeg = b[ j ] === MINUS; j ++;

			}

			if ( j < n && isDigit( b[ j ] ) ) {

				let e = 0;
				while ( j < n && isDigit( b[ j ] ) ) {

					e = e * 10 + ( b[ j ] - ZERO ); j ++;

				}

				exponent = expNeg ? - e : e;
				i = j;

			}

		}

		this.i = i;

		if ( digits === 0 ) throw new Error( `PBRT tokenizer: invalid number "${decodeRange( b, start, i )}"` );

		const scale = exponent - fracDigits;
		const exact = digits <= MAX_EXACT_DIGITS && scale >= - MAX_EXACT_POW10 && scale <= MAX_EXACT_POW10;

		if ( ! exact ) {

			const value = Number( decodeRange( b, start, i ) );
			if ( Number.isNaN( value ) ) throw new Error( `PBRT tokenizer: invalid number "${decodeRange( b, start, i )}"` );
			return { type: TokenType.NUMBER, value };

		}

		// Scale by dividing rather than multiplying by a negative power: 10^-4 is not exact,
		// and 654435761 * 1e-4 lands a bit below -65443.5761.
		let value = scale === 0 ? mantissa
			: scale > 0 ? mantissa * POW10[ scale ]
				: mantissa / POW10[ - scale ];
		if ( negative ) value = - value;
		return { type: TokenType.NUMBER, value };

	}

}

/**
 * Tokenize a whole pbrt source into an array.
 * Convenience for tests and small files; the loader streams instead.
 * @param {string|Uint8Array} src
 * @returns {Array<{type: string, value?: string|number}>}
 */
export function tokenize( src ) {

	const stream = new TokenStream( src );
	const tokens = [];
	for ( let t = stream.next(); t !== null; t = stream.next() ) tokens.push( t );
	return tokens;

}
