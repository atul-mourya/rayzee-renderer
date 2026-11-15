import { describe, it, expect } from 'vitest';
import { XMLDOMParser } from '@/core/node/XMLDOMParser.js';

// What Chrome's DOMParser made of each snippet ('ERROR': a parsererror), recorded 2026-11-15 through the serialiser below.
const CHROME = [
	[ "<a/>",
		"E a {} a  " ],
	[ "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<a>t</a>\n",
		"E a {} a  \n T \"t\"" ],
	[ "<a b=\"1\" c='2'>x</a>",
		"E a {} a  b[]=\"1\" c[]=\"2\"\n T \"x\"" ],
	[ "<a b=\"1 &amp; 2 &lt; &gt; &quot; &apos;\">&#65;&#x42;&#x1F600;</a>",
		"E a {} a  b[]=\"1 & 2 < > \\\" '\"\n T \"AB\ud83d\ude00\"" ],
	[ "<a b=\"x\ty\nz\">\r\nline\rtwo</a>",
		"E a {} a  b[]=\"x y z\"\n T \"\\nline\\ntwo\"" ],
	[ "<a><![CDATA[<b>&amp;</b>]]></a>",
		"E a {} a  \n C \"<b>&amp;</b>\"" ],
	[ "<a><!-- c --><?pi  some data ?></a>",
		"E a {} a  \n # \" c \"\n P pi \"some data \"" ],
	[ "<!DOCTYPE a [ <!ELEMENT a ANY> ]><a/>",
		"D\nE a {} a  " ],
	[ "<!-- before --><a/><!-- after -->",
		"# \" before \"\nE a {} a  \n# \" after \"" ],
	[ "<a xmlns=\"urn:d\" xmlns:p=\"urn:p\"><p:b p:c=\"1\" d=\"2\"/><c xmlns=\"\"/></a>",
		"E a {urn:d} a  xmlns[http://www.w3.org/2000/xmlns/]=\"urn:d\" xmlns:p[http://www.w3.org/2000/xmlns/]=\"urn:p\"\n E p:b {urn:p} b p p:c[urn:p]=\"1\" d[]=\"2\"\n E c {} c  xmlns[http://www.w3.org/2000/xmlns/]=\"\"" ],
	[ "<a>  <b> x </b>  </a>",
		"E a {} a  \n T \"  \"\n E b {} b  \n  T \" x \"\n T \"  \"" ],
	[ "\ufeff<a/>",
		"E a {} a  " ],
	[ "<a>&nbsp;</a>",
		"ERROR" ],
	[ "<a>&</a>",
		"ERROR" ],
	[ "<a><b></a>",
		"ERROR" ],
	[ "<a></a><b/>",
		"ERROR" ],
	[ "text<a/>",
		"ERROR" ],
	[ "<a b=\"1\" b=\"2\"/>",
		"ERROR" ],
	[ "<a b=1/>",
		"ERROR" ],
	[ "<p:a/>",
		"ERROR" ],
	[ "<a><!-- x -- y --></a>",
		"ERROR" ],
	[ "<a>]]></a>",
		"ERROR" ],
	[ " <?xml version=\"1.0\"?><a/>",
		"ERROR" ],
	[ "<a b=\"<\"/>",
		"ERROR" ],
	[ "",
		"ERROR" ],
	[ "<a>&#0;</a>",
		"ERROR" ],
	[ "<a><b/><b><b/></b></a>",
		"E a {} a  \n E b {} b  \n E b {} b  \n  E b {} b  " ],
	[ "<a xml:lang=\"en\"/>",
		"E a {} a  xml:lang[http://www.w3.org/XML/1998/namespace]=\"en\"" ],
];

// Each query on XML_DOC as Chrome answered it: every match's path, the first, and the matches inside the second <b>.
const XML_DOC = '<a xmlns:p="urn:p"><b sid="j-1"><c/></b><b><c id="x"/><d><c/><p:c/></d></b></a>';
const QUERIES = [
	[ "b", "a/b0 a/b1 | first a/b0 | in b1 " ],
	[ "b c", "a/b0/c0 a/b1/c0 a/b1/d1/c0 a/b1/d1/p:c1 | first a/b0/c0 | in b1 a/b1/c0 a/b1/d1/c0 a/b1/d1/p:c1" ],
	[ "b > c", "a/b0/c0 a/b1/c0 | first a/b0/c0 | in b1 a/b1/c0" ],
	[ "[sid=\"j-1\"]", "a/b0 | first a/b0 | in b1 " ],
	[ "c[id=\"x\"]", "a/b1/c0 | first a/b1/c0 | in b1 a/b1/c0" ],
	[ "*", "a a/b0 a/b0/c0 a/b1 a/b1/c0 a/b1/d1 a/b1/d1/c0 a/b1/d1/p:c1 | first a | in b1 a/b1/c0 a/b1/d1 a/b1/d1/c0 a/b1/d1/p:c1" ],
	[ "a > b > c", "a/b0/c0 a/b1/c0 | first a/b0/c0 | in b1 a/b1/c0" ],
	[ "b, d", "a/b0 a/b1 a/b1/d1 | first a/b0 | in b1 a/b1/d1" ],
	[ "[id]", "a/b1/c0 | first a/b1/c0 | in b1 a/b1/c0" ],
	[ "[sid='j-1'] c", "a/b0/c0 | first a/b0/c0 | in b1 " ],
	[ "d c", "a/b1/d1/c0 a/b1/d1/p:c1 | first a/b1/d1/c0 | in b1 a/b1/d1/c0 a/b1/d1/p:c1" ],
	[ "c", "a/b0/c0 a/b1/c0 a/b1/d1/c0 a/b1/d1/p:c1 | first a/b0/c0 | in b1 a/b1/c0 a/b1/d1/c0 a/b1/d1/p:c1" ],
];

const parse = ( text ) => new XMLDOMParser().parseFromString( text, 'application/xml' );

// A document as one string: comparable across DOMParser implementations.
function canon( doc ) {

	const err = doc.getElementsByTagName( 'parsererror' ).length > 0;
	if ( err ) return 'ERROR';
	const out = [];
	const walk = ( n, d ) => {

		const pad = ' '.repeat( d );
		if ( n.nodeType === 1 ) {

			const attrs = Array.from( n.attributes, ( a ) => `${a.name}[${a.namespaceURI ?? ''}]=${JSON.stringify( a.value )}` ).join( ' ' );
			out.push( `${pad}E ${n.nodeName} {${n.namespaceURI ?? ''}} ${n.localName} ${n.prefix ?? ''} ${attrs}` );
			for ( const c of n.childNodes ) walk( c, d + 1 );

		} else if ( n.nodeType === 3 ) out.push( `${pad}T ${JSON.stringify( n.data )}` );
		else if ( n.nodeType === 4 ) out.push( `${pad}C ${JSON.stringify( n.data )}` );
		else if ( n.nodeType === 8 ) out.push( `${pad}# ${JSON.stringify( n.data )}` );
		else if ( n.nodeType === 7 ) out.push( `${pad}P ${n.target} ${JSON.stringify( n.data )}` );
		else if ( n.nodeType === 10 ) out.push( `${pad}D` );

	};

	for ( const c of doc.childNodes ) walk( c, 0 );
	return out.join( '\n' );

}

const path = ( e ) => {

	const parts = [];
	for ( ; e && e.nodeType === 1; e = e.parentNode ) parts.unshift( e.nodeName + ( e.parentNode?.nodeType === 1 ? e.parentNode.children.indexOf( e ) : '' ) );
	return parts.join( '/' );

};

describe( 'XMLDOMParser', () => {

	it.each( CHROME )( 'reads %j as Chrome does', ( text, expected ) => {

		expect( canon( parse( text ) ) ).toBe( expected );

	} );

	it.each( QUERIES )( 'finds %s as Chrome does', ( selector, expected ) => {

		const doc = parse( XML_DOC );
		const first = doc.querySelector( selector );
		const inB = doc.getElementsByTagName( 'b' )[ 1 ].querySelectorAll( selector );
		expect( `${doc.querySelectorAll( selector ).map( path ).join( ' ' )} | first ${first ? path( first ) : 'none'} | in b1 ${inB.map( path ).join( ' ' )}` ).toBe( expected );

	} );

	it( 'lists elements by qualified name', () => {

		const doc = parse( XML_DOC );
		expect( doc.getElementsByTagName( '*' ).map( path ).join( ' ' ) ).toBe( 'a a/b0 a/b0/c0 a/b1 a/b1/c0 a/b1/d1 a/b1/d1/c0 a/b1/d1/p:c1' );
		expect( [ doc.getElementsByTagName( 'p:c' ).length, doc.getElementsByTagName( 'c' ).length ] ).toEqual( [ 1, 3 ] );
		expect( doc.getElementsByTagNameNS( 'urn:p', 'c' ).map( path ) ).toEqual( [ 'a/b1/d1/p:c1' ] );

	} );

	it( 'reads attributes by name and namespace, and sets them', () => {

		const b = parse( '<a xmlns:p="urn:p"><b p:x="1" y="2"/></a>' ).querySelector( 'b' );
		expect( [ b.getAttribute( 'p:x' ), b.getAttributeNS( 'urn:p', 'x' ), b.getAttribute( 'x' ), b.getAttribute( 'z' ) ] ).toEqual( [ '1', '1', null, null ] );
		expect( [ b.hasAttribute( 'y' ), b.hasAttribute( 'z' ) ] ).toEqual( [ true, false ] );
		b.setAttribute( 'id', 'n1' );
		b.setAttribute( 'y', 3 );
		b.removeAttribute( 'p:x' );
		expect( b.getAttributeNames() ).toEqual( [ 'y', 'id' ] );
		expect( b.matches( '[id="n1"][y="3"]' ) ).toBe( true );
		expect( b.closest( 'a' ).nodeName ).toBe( 'a' );

	} );

	it( 'gives text, siblings and the document element', () => {

		const doc = parse( '<a>x<b>y<![CDATA[z]]></b><!--c-->w</a>' );
		const b = doc.querySelector( 'b' );
		expect( [ doc.documentElement.textContent, b.textContent, doc.textContent ] ).toEqual( [ 'xyzw', 'yz', null ] );
		expect( [ b.previousSibling.data, b.nextSibling.data, b.parentElement.nodeName, doc.documentElement.parentElement ] ).toEqual( [ 'x', 'c', 'a', null ] );

	} );

	// Not recorded from Chrome: XML 1.0 makes these errors (an '&' starts a reference ended by ';'; a surrogate is no
	// character).
	it( 'refuses a bare ampersand and a surrogate reference, and matches an attribute by its value', () => {

		const failed = ( xml ) => parse( xml ).getElementsByTagName( 'parsererror' ).length > 0;
		expect( [ failed( '<a>x & y</a>' ), failed( '<a>&amp x</a>' ), failed( '<a b="x & y"/>' ), failed( '<a>&#xD800;</a>' ), failed( '<a>&#55296;</a>' ) ] )
			.toEqual( [ true, true, true, true, true ] );
		expect( failed( '<a>x &amp; y &#x1F600;</a>' ) ).toBe( false );

		const doc = parse( XML_DOC );
		expect( doc.querySelectorAll( '[sid="j-2"]' ) ).toHaveLength( 0 );
		expect( doc.querySelector( 'c[id="y"]' ) ).toBeNull();

	} );

	it( 'refuses selectors and types it does not read', () => {

		const doc = parse( XML_DOC );
		for ( const selector of [ 'b:first-child', '.x', '#x', 'b + c', 'b ~ c', '[id^="x"]', '', 'b >', '> b' ] ) {

			expect( () => doc.querySelectorAll( selector ), selector ).toThrow( SyntaxError );

		}

		expect( () => new XMLDOMParser().parseFromString( '<a/>', 'text/html' ) ).toThrow( TypeError );

	} );

} );
