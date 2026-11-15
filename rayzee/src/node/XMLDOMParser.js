/**
 * A DOMParser for XML, for runtimes without one (Node): what three.js's Collada and 3MF loaders read — elements and
 * their attributes with namespaces, text, CDATA, comments and processing instructions, the five named entities and
 * character references, `getElementsByTagName` and `querySelector( All )` over type and attribute selectors. A DOCTYPE's
 * internal subset is skipped.
 * Malformed XML gives a document whose root is a `parsererror` element, as Firefox's does (Chrome keeps what it read and
 * puts the `parsererror` inside it).
 */

const ELEMENT_NODE = 1, ATTRIBUTE_NODE = 2, TEXT_NODE = 3, CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7, COMMENT_NODE = 8, DOCUMENT_NODE = 9, DOCUMENT_TYPE_NODE = 10;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const PARSER_ERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

const XML_TYPES = new Set( [ 'application/xml', 'text/xml', 'image/svg+xml', 'application/xhtml+xml' ] );
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };
// Looser than XML's Name production (any character but markup and white space): a name only has to be found here.
const NAME = /[^\s\d.\-/>=<"'!?&;][^\s/>=<"'&;]*/y;
const SPACE = /[ \t\n]*/y;

class XMLParseError extends Error {}

class Node {

	constructor( nodeType, nodeName, ownerDocument ) {

		this.nodeType = nodeType;
		this.nodeName = nodeName;
		this.ownerDocument = ownerDocument;
		this.parentNode = null;
		this.childNodes = [];

	}

	get firstChild() {

		return this.childNodes[ 0 ] ?? null;

	}

	get lastChild() {

		return this.childNodes[ this.childNodes.length - 1 ] ?? null;

	}

	get nextSibling() {

		const siblings = this.parentNode?.childNodes;
		return siblings?.[ siblings.indexOf( this ) + 1 ] ?? null;

	}

	get previousSibling() {

		const siblings = this.parentNode?.childNodes;
		return siblings?.[ siblings.indexOf( this ) - 1 ] ?? null;

	}

	get parentElement() {

		return this.parentNode?.nodeType === ELEMENT_NODE ? this.parentNode : null;

	}

	hasChildNodes() {

		return this.childNodes.length > 0;

	}

}

class CharacterData extends Node {

	constructor( nodeType, nodeName, ownerDocument, data ) {

		super( nodeType, nodeName, ownerDocument );
		this.data = data;

	}

	get nodeValue() {

		return this.data;

	}

	get textContent() {

		return this.data;

	}

	get length() {

		return this.data.length;

	}

}

class ProcessingInstruction extends CharacterData {

	get target() {

		return this.nodeName;

	}

}

class Attr {

	constructor( name, value, namespaceURI ) {

		this.name = name;
		this.value = value;
		this.namespaceURI = namespaceURI;

	}

	get nodeType() {

		return ATTRIBUTE_NODE;

	}

	get nodeName() {

		return this.name;

	}

	get prefix() {

		const colon = this.name.indexOf( ':' );
		return colon > 0 ? this.name.slice( 0, colon ) : null;

	}

	get localName() {

		return this.name.slice( this.name.indexOf( ':' ) + 1 );

	}

	get nodeValue() {

		return this.value;

	}

	get textContent() {

		return this.value;

	}

}

// Elements and the document find their descendants alike.
class ParentNode extends Node {

	get children() {

		return this.childNodes.filter( ( n ) => n.nodeType === ELEMENT_NODE );

	}

	get childElementCount() {

		return this.children.length;

	}

	get firstElementChild() {

		return this.childNodes.find( ( n ) => n.nodeType === ELEMENT_NODE ) ?? null;

	}

	get lastElementChild() {

		return this.childNodes.findLast( ( n ) => n.nodeType === ELEMENT_NODE ) ?? null;

	}

	/** @returns {Element[]} descendants named `name` (qualified, `'*'` for all), in document order */
	getElementsByTagName( name ) {

		const out = [];
		walk( this, ( e ) => ( name === '*' || e.nodeName === name ) && out.push( e ) );
		return out;

	}

	getElementsByTagNameNS( namespaceURI, localName ) {

		const out = [];
		walk( this, ( e ) => ( namespaceURI === '*' || e.namespaceURI === ( namespaceURI || null ) )
			&& ( localName === '*' || e.localName === localName ) && out.push( e ) );
		return out;

	}

	querySelectorAll( selectors ) {

		const groups = parseSelectors( selectors );
		const out = [];
		walk( this, ( e ) => groups.some( ( g ) => matches( e, g ) ) && out.push( e ) );
		return out;

	}

	querySelector( selectors ) {

		const groups = parseSelectors( selectors );
		let found = null;
		walk( this, ( e ) => {

			if ( groups.some( ( g ) => matches( e, g ) ) ) found = e;
			return found !== null;

		} );
		return found;

	}

}

class Element extends ParentNode {

	constructor( name, namespaceURI, ownerDocument ) {

		super( ELEMENT_NODE, name, ownerDocument );
		const colon = name.indexOf( ':' );
		this.prefix = colon > 0 ? name.slice( 0, colon ) : null;
		this.localName = colon > 0 ? name.slice( colon + 1 ) : name;
		this.namespaceURI = namespaceURI;
		this.attributes = new NamedNodeMap();

	}

	get tagName() {

		return this.nodeName;

	}

	get nodeValue() {

		return null;

	}

	get textContent() {

		let text = '';
		const gather = ( node ) => {

			for ( const child of node.childNodes ) {

				if ( child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE ) text += child.data;
				else if ( child.nodeType === ELEMENT_NODE ) gather( child );

			}

		};

		gather( this );
		return text;

	}

	get id() {

		return this.getAttribute( 'id' ) ?? '';

	}

	getAttribute( name ) {

		return this.attributes.getNamedItem( name )?.value ?? null;

	}

	getAttributeNS( namespaceURI, localName ) {

		return this.attributes.getNamedItemNS( namespaceURI, localName )?.value ?? null;

	}

	hasAttribute( name ) {

		return this.attributes.getNamedItem( name ) !== null;

	}

	hasAttributeNS( namespaceURI, localName ) {

		return this.attributes.getNamedItemNS( namespaceURI, localName ) !== null;

	}

	getAttributeNames() {

		return Array.from( this.attributes, ( a ) => a.name );

	}

	setAttribute( name, value ) {

		const attr = this.attributes.getNamedItem( name );
		if ( attr ) attr.value = String( value );
		else this.attributes.push( new Attr( name, String( value ), name === 'xmlns' || name.startsWith( 'xmlns:' ) ? XMLNS_NS : null ) );

	}

	removeAttribute( name ) {

		const at = this.attributes.findIndex( ( a ) => a.name === name );
		if ( at >= 0 ) this.attributes.splice( at, 1 );

	}

	matches( selectors ) {

		return parseSelectors( selectors ).some( ( g ) => matches( this, g ) );

	}

	closest( selectors ) {

		const groups = parseSelectors( selectors );
		for ( let e = this; e; e = e.parentElement ) if ( groups.some( ( g ) => matches( e, g ) ) ) return e;
		return null;

	}

}

class NamedNodeMap extends Array {

	item( index ) {

		return this[ index ] ?? null;

	}

	getNamedItem( name ) {

		for ( let i = 0; i < this.length; i ++ ) if ( this[ i ].name === name ) return this[ i ];
		return null;

	}

	getNamedItemNS( namespaceURI, localName ) {

		for ( let i = 0; i < this.length; i ++ ) if ( this[ i ].namespaceURI === ( namespaceURI || null ) && this[ i ].localName === localName ) return this[ i ];
		return null;

	}

}

class Document extends ParentNode {

	constructor( contentType ) {

		super( DOCUMENT_NODE, '#document', null );
		this.contentType = contentType;

	}

	get documentElement() {

		return this.firstElementChild;

	}

	get textContent() {

		return null;

	}

}

/** Visits the element descendants of `root` in document order until `visit` returns true. */
function walk( root, visit ) {

	const stack = [ ...root.childNodes ].reverse();
	while ( stack.length ) {

		const node = stack.pop();
		if ( node.nodeType !== ELEMENT_NODE ) continue;
		if ( visit( node ) === true ) return;
		for ( let i = node.childNodes.length - 1; i >= 0; i -- ) stack.push( node.childNodes[ i ] );

	}

}

// ── Selectors: type selectors (or *) with [attr] / [attr="value"], joined by descendant or child combinators ──

const selectorCache = new Map();

function parseSelectors( selectors ) {

	const text = String( selectors );
	let groups = selectorCache.get( text );
	if ( groups ) return groups;

	const fail = () => {

		throw new SyntaxError( `'${text}' is not a selector this DOMParser takes (type and attribute selectors only)` );

	};

	const IDENT = /[A-Za-z_][\w.-]*/y;
	const ident = ( at ) => {

		IDENT.lastIndex = at;
		const match = IDENT.exec( text );
		return match ? match[ 0 ] : null;

	};

	groups = [];
	let steps = [];
	let combinator = ' ';
	let i = 0;
	const space = () => {

		const from = i;
		while ( /\s/.test( text[ i ] ?? '' ) ) i ++;
		return i > from;

	};

	space();
	while ( i <= text.length ) {

		if ( i === text.length || text[ i ] === ',' ) {

			if ( ! steps.length || combinator === '>' ) fail();
			groups.push( steps );
			steps = [];
			combinator = ' ';
			if ( i === text.length ) break;
			i ++;
			space();
			continue;

		}

		if ( text[ i ] === '>' ) {

			if ( ! steps.length || combinator === '>' ) fail();
			combinator = '>';
			i ++;
			space();
			continue;

		}

		const step = { name: '*', attrs: [], combinator };
		if ( text[ i ] === '*' ) i ++;
		else if ( text[ i ] !== '[' ) {

			step.name = ident( i ) ?? fail();
			i += step.name.length;

		}

		while ( text[ i ] === '[' ) {

			i ++;
			space();
			const name = ident( i ) ?? fail();
			i += name.length;
			space();
			let value;
			if ( text[ i ] === '=' ) {

				i ++;
				space();
				const quote = text[ i ];
				if ( quote === '"' || quote === '\'' ) {

					value = '';
					for ( i ++; i < text.length && text[ i ] !== quote; i ++ ) value += text[ i ] === '\\' ? text[ ++ i ] : text[ i ];
					if ( text[ i ++ ] !== quote ) fail();

				} else {

					value = ident( i ) ?? fail();
					i += value.length;

				}

				space();

			}

			if ( text[ i ++ ] !== ']' ) fail();
			step.attrs.push( { name, value } );

		}

		steps.push( step );
		combinator = ' ';
		if ( ! space() && i < text.length && ! ',>'.includes( text[ i ] ) ) fail();

	}

	if ( selectorCache.size >= 1024 ) selectorCache.clear(); // one entry a [id="…"] queried
	selectorCache.set( text, groups );
	return groups;

}

function matchesStep( element, { name, attrs } ) {

	if ( name !== '*' && element.localName !== name ) return false;
	for ( const { name: attr, value } of attrs ) {

		const actual = element.getAttribute( attr );
		if ( actual === null || ( value !== undefined && actual !== value ) ) return false;

	}

	return true;

}

// The last step names the element itself, each earlier one an ancestor (any for ' ', the parent for '>').
function matches( element, steps, last = steps.length - 1 ) {

	const step = steps[ last ];
	if ( ! matchesStep( element, step ) ) return false;
	if ( last === 0 ) return true;

	if ( step.combinator === '>' ) return element.parentElement !== null && matches( element.parentElement, steps, last - 1 );
	for ( let a = element.parentElement; a; a = a.parentElement ) if ( matches( a, steps, last - 1 ) ) return true;
	return false;

}

// ── Parsing ──

// A slice of the document is, in V8, a view that keeps the whole text alive; three keeps attribute values as names.
const own = ( text ) => ( text.length > 12 ? ( ' ' + text ).slice( 1 ) : text );

function decode( text, at ) {

	if ( text.indexOf( '&' ) < 0 ) return text;

	return text.replace( /&([^;&\s]*);?/g, ( whole, name ) => {

		if ( ! whole.endsWith( ';' ) ) throw new XMLParseError( `'&' not followed by an entity reference near offset ${at}` );
		if ( name[ 0 ] === '#' ) {

			const code = name[ 1 ] === 'x' ? parseInt( name.slice( 2 ), 16 ) : parseInt( name.slice( 1 ), 10 );
			const valid = /^#(x[0-9A-Fa-f]+|[0-9]+)$/.test( name ) && code > 0 && code <= 0x10FFFF && ! ( code >= 0xD800 && code <= 0xDFFF );
			if ( ! valid ) throw new XMLParseError( `invalid character reference &${name}; near offset ${at}` );
			return String.fromCodePoint( code );

		}

		if ( ! Object.hasOwn( ENTITIES, name ) ) throw new XMLParseError( `undefined entity &${name}; near offset ${at}` );
		return ENTITIES[ name ];

	} );

}

function parse( source, contentType ) {

	const text = source.replace( /^\uFEFF/, '' ).replace( /\r\n?/g, '\n' );
	const doc = new Document( contentType );
	const open = []; // elements not yet closed
	const scopes = [ { xml: XML_NS, xmlns: XMLNS_NS } ];
	let parent = doc;
	let i = 0;

	const fail = ( message ) => {

		throw new XMLParseError( `${message} (line ${text.slice( 0, i ).split( '\n' ).length})` );

	};

	const append = ( node ) => {

		node.parentNode = parent;
		parent.childNodes.push( node );

	};

	const readName = () => {

		NAME.lastIndex = i;
		const match = NAME.exec( text );
		if ( ! match ) fail( 'a name was expected' );
		i = NAME.lastIndex;
		return match[ 0 ];

	};

	const skipSpace = () => {

		SPACE.lastIndex = i;
		SPACE.exec( text );
		const moved = SPACE.lastIndex > i;
		i = SPACE.lastIndex;
		return moved;

	};

	const until = ( end, what ) => {

		const at = text.indexOf( end, i );
		if ( at < 0 ) fail( `unterminated ${what}` );
		const body = text.slice( i, at );
		i = at + end.length;
		return body;

	};

	const lookup = ( prefix ) => {

		for ( let s = scopes.length - 1; s >= 0; s -- ) if ( Object.hasOwn( scopes[ s ], prefix ) ) return scopes[ s ][ prefix ];
		return undefined;

	};

	const doctype = () => {

		skipSpace();
		const type = new Node( DOCUMENT_TYPE_NODE, readName(), doc );
		type.name = type.nodeName;
		append( type );
		let depth = 0;
		for ( ; i < text.length; i ++ ) {

			const c = text[ i ];
			if ( c === '"' || c === '\'' ) {

				const end = text.indexOf( c, i + 1 );
				if ( end < 0 ) break;
				i = end;

			} else if ( c === '[' ) depth ++;
			else if ( c === ']' ) depth --;
			else if ( c === '>' && depth === 0 ) {

				i ++;
				return;

			}

		}

		fail( 'unterminated DOCTYPE' );

	};

	const startTag = () => {

		const name = readName();
		const raw = [];
		while ( true ) {

			const spaced = skipSpace();
			const c = text[ i ];
			if ( c === '>' || c === '/' ) break;
			if ( c === undefined ) fail( `unterminated start tag <${name}>` );
			if ( ! spaced ) fail( `attributes of <${name}> must be separated by white space` );

			const attrName = readName();
			skipSpace();
			if ( text[ i ] !== '=' ) fail( `attribute ${attrName} of <${name}> has no value` );
			i ++;
			skipSpace();
			const quote = text[ i ];
			if ( quote !== '"' && quote !== '\'' ) fail( `attribute ${attrName} of <${name}> is not quoted` );
			i ++;
			const value = until( quote, `attribute ${attrName}` );
			if ( value.includes( '<' ) ) fail( `'<' in the value of attribute ${attrName}` );
			if ( raw.some( ( a ) => a.name === attrName ) ) fail( `attribute ${attrName} is repeated on <${name}>` );
			raw.push( { name: own( attrName ), value: own( decode( value.replace( /[\t\n]/g, ' ' ), i ) ) } );

		}

		const empty = text[ i ] === '/';
		if ( empty && text[ ++ i ] !== '>' ) fail( `'/' must close <${name}>` );
		i ++;

		const scope = {};
		for ( const { name: attrName, value } of raw ) {

			if ( attrName === 'xmlns' ) scope[ '' ] = value;
			else if ( attrName.startsWith( 'xmlns:' ) ) scope[ attrName.slice( 6 ) ] = value;

		}

		scopes.push( scope );
		const colon = name.indexOf( ':' );
		const prefix = colon > 0 ? name.slice( 0, colon ) : '';
		const namespaceURI = lookup( prefix );
		if ( prefix && ! namespaceURI ) fail( `namespace prefix ${prefix} of <${name}> is not declared` );

		const element = new Element( own( name ), namespaceURI || null, doc );
		for ( const { name: attrName, value } of raw ) {

			const attrColon = attrName.indexOf( ':' );
			const attrPrefix = attrColon > 0 ? attrName.slice( 0, attrColon ) : '';
			let ns = null;
			if ( attrName === 'xmlns' || attrPrefix === 'xmlns' ) ns = XMLNS_NS;
			else if ( attrPrefix ) {

				ns = lookup( attrPrefix );
				if ( ! ns ) fail( `namespace prefix ${attrPrefix} of attribute ${attrName} is not declared` );

			}

			element.attributes.push( new Attr( attrName, value, ns ) );

		}

		if ( parent === doc && doc.documentElement ) fail( 'a document has one root element' );
		append( element );

		if ( empty ) scopes.pop();
		else {

			open.push( element );
			parent = element;

		}

	};

	const endTag = () => {

		const name = readName();
		skipSpace();
		if ( text[ i ] !== '>' ) fail( `unterminated end tag </${name}>` );
		i ++;
		const element = open.pop();
		if ( ! element || element.nodeName !== name ) fail( `</${name}> does not close ${element ? `<${element.nodeName}>` : 'any element'}` );
		scopes.pop();
		parent = open[ open.length - 1 ] ?? doc;

	};

	while ( i < text.length ) {

		const lt = text.indexOf( '<', i );
		const end = lt < 0 ? text.length : lt;
		if ( end > i ) {

			const raw = text.slice( i, end );
			if ( parent === doc ) {

				if ( /[^ \t\n]/.test( raw ) ) fail( 'text outside the root element' );

			} else {

				if ( raw.includes( ']]>' ) ) fail( '\']]>\' in text' );
				const data = raw.length <= 256 ? own( decode( raw, i ) ) : decode( raw, i );
				const last = parent.childNodes[ parent.childNodes.length - 1 ];
				if ( last?.nodeType === TEXT_NODE ) last.data += data;
				else append( new CharacterData( TEXT_NODE, '#text', doc, data ) );

			}

			i = end;

		}

		if ( lt < 0 ) break;

		if ( text.startsWith( '<!--', i ) ) {

			i += 4;
			const body = until( '-->', 'comment' );
			if ( body.includes( '--' ) || body.endsWith( '-' ) ) fail( '\'--\' inside a comment' );
			append( new CharacterData( COMMENT_NODE, '#comment', doc, body ) );

		} else if ( text.startsWith( '<![CDATA[', i ) ) {

			if ( parent === doc ) fail( 'CDATA outside the root element' );
			i += 9;
			append( new CharacterData( CDATA_SECTION_NODE, '#cdata-section', doc, until( ']]>', 'CDATA section' ) ) );

		} else if ( text.startsWith( '<?', i ) ) {

			const at = i;
			i += 2;
			const target = readName();
			const body = until( '?>', `processing instruction ${target}` );
			if ( target.toLowerCase() === 'xml' ) {

				if ( target !== 'xml' || at !== 0 ) fail( 'an XML declaration is allowed only at the start' );

			} else append( new ProcessingInstruction( PROCESSING_INSTRUCTION_NODE, target, doc, body.replace( /^[ \t\n]+/, '' ) ) );

		} else if ( text.startsWith( '<!DOCTYPE', i ) ) {

			if ( parent !== doc || doc.documentElement ) fail( 'a DOCTYPE must come before the root element' );
			i += 9;
			doctype();

		} else if ( text[ i + 1 ] === '/' ) {

			i += 2;
			endTag();

		} else {

			i ++;
			startTag();

		}

	}

	if ( open.length ) fail( `<${open[ open.length - 1 ].nodeName}> is not closed` );
	if ( ! doc.documentElement ) fail( 'no root element' );
	return doc;

}

function errorDocument( message, contentType ) {

	const doc = new Document( contentType );
	const root = new Element( 'parsererror', PARSER_ERROR_NS, doc );
	root.parentNode = doc;
	doc.childNodes.push( root );
	const text = new CharacterData( TEXT_NODE, '#text', doc, `XML Parsing Error: ${message}` );
	text.parentNode = root;
	root.childNodes.push( text );
	return doc;

}

export class XMLDOMParser {

	/**
	 * @param {string} string
	 * @param {string} type - an XML type: 'application/xml', 'text/xml', 'image/svg+xml' or 'application/xhtml+xml'
	 * @returns {Document}
	 */
	parseFromString( string, type ) {

		if ( ! XML_TYPES.has( type ) ) throw new TypeError( `XMLDOMParser reads XML only, not '${type}'` );

		try {

			return parse( String( string ), type );

		} catch ( error ) {

			if ( error instanceof XMLParseError ) return errorDocument( error.message, type );
			throw error;

		}

	}

}
