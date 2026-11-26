/**
 * MaterialX documents (`.mtlx`) read as USD layers, laid out as OpenUSD's usdMtlx translates them: each material at
 * /MaterialX/Materials/<name>, its surface shader and the node graphs it reads beneath it, every node a Shader of
 * `ND_*` id — what USDScene's MaterialX reader takes. 1.37 (shaderref, bindinput, parameter) and 1.38 (`channels`,
 * swizzle) are read as MaterialX's own upgrade rewrites them.
 *
 *   const layer = parseUSDA( materialXToUSDA( text, { warn } ), path );
 */

// ── XML ──────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const decode = s => ( s.includes( '&' ) ? s.replace( /&(#x[0-9a-f]+|#\d+|\w+);/gi, ( m, e ) => {

	if ( e[ 0 ] !== '#' ) return ENTITIES[ e ] ?? m;
	return String.fromCodePoint( e[ 1 ] === 'x' || e[ 1 ] === 'X' ? parseInt( e.slice( 2 ), 16 ) : parseInt( e.slice( 1 ), 10 ) );

} ) : s );

const TAG = /<([^\s/>]+)/y;
const ATTR = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const END = /\s*(\/?)>/y;

/** Elements as `{ tag, attrs, children }`; text, comments and declarations dropped. */
export function parseXML( text ) {

	const root = { tag: '', attrs: {}, children: [] };
	const stack = [ root ];
	let i = 0;
	const skipTo = ( close, from ) => {

		const at = text.indexOf( close, from );
		if ( at < 0 ) throw new Error( `unterminated ${close === '-->' ? 'comment' : 'markup'}` );
		return at + close.length;

	};

	while ( ( i = text.indexOf( '<', i ) ) >= 0 ) {

		if ( text.startsWith( '<!--', i ) ) i = skipTo( '-->', i + 4 );
		else if ( text.startsWith( '<![CDATA[', i ) ) i = skipTo( ']]>', i );
		else if ( text[ i + 1 ] === '?' || text[ i + 1 ] === '!' ) i = skipTo( '>', i );
		else if ( text[ i + 1 ] === '/' ) {

			const end = skipTo( '>', i );
			const tag = text.slice( i + 2, end - 1 ).trim();
			const open = stack.pop();
			if ( stack.length === 0 || open.tag !== tag ) throw new Error( `</${tag}> does not close <${open.tag}>` );
			i = end;

		} else {

			TAG.lastIndex = i;
			const tag = TAG.exec( text );
			if ( ! tag ) throw new Error( `malformed tag at ${i}` );
			const element = { tag: tag[ 1 ], attrs: {}, children: [] };
			let at = TAG.lastIndex;
			for ( ; ; ) {

				ATTR.lastIndex = at;
				const attr = ATTR.exec( text );
				if ( ! attr ) break;
				element.attrs[ attr[ 1 ] ] = decode( attr[ 2 ] ?? attr[ 3 ] );
				at = ATTR.lastIndex;

			}

			END.lastIndex = at;
			const end = END.exec( text );
			if ( ! end ) throw new Error( `malformed <${element.tag}>` );
			stack[ stack.length - 1 ].children.push( element );
			if ( ! end[ 1 ] ) stack.push( element );
			i = END.lastIndex;

		}

	}

	if ( stack.length > 1 ) throw new Error( `<${stack[ stack.length - 1 ].tag}> is not closed` );
	return root;

}

// ── USDA writing ─────────────────────────────────────────────────

const USD_TYPES = {
	float: 'float', integer: 'int', boolean: 'bool', color3: 'color3f', color4: 'color4f', vector2: 'float2',
	vector3: 'float3', vector4: 'float4', matrix33: 'matrix3d', matrix44: 'matrix4d', string: 'string',
	filename: 'asset', geomname: 'string', floatarray: 'float[]', integerarray: 'int[]',
};
const SIZES = { color3: 3, color4: 4, vector2: 2, vector3: 3, vector4: 4, matrix33: 9, matrix44: 16 };
const VECTORS = new Set( [ 'color3', 'color4', 'vector2', 'vector3', 'vector4' ] );
const CHANNEL = { r: 0, g: 1, b: 2, a: 3, x: 0, y: 1, z: 2, w: 3 };
// Arithmetic whose float second operand names its own nodedef (ND_multiply_color3FA).
const FA_INPUTS = { multiply: 'in2', divide: 'in2', add: 'in2', subtract: 'in2', modulo: 'in2', power: 'in2', min: 'in2', max: 'in2', clamp: 'low', smoothstep: 'low', mix: 'mix' };
// Elements of a document or graph that are not nodes.
const NOT_NODES = new Set( [
	'nodedef', 'nodegraph', 'implementation', 'typedef', 'look', 'lookgroup', 'collection', 'geominfo', 'propertyset',
	'variantset', 'backdrop', 'token', 'input', 'output', 'parameter', 'comment', 'unitdef', 'unittypedef', 'targetdef',
	'attributedef', 'material', 'xi:include', 'materialassign', 'member',
] );

const identifier = name => {

	const clean = String( name ).replace( /[^A-Za-z0-9_]/g, '_' );
	return /^[0-9]/.test( clean ) ? `_${clean}` : clean || '_';

};

const quote = s => `"${String( s ).replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\n/g, '\\n' )}"`;
const asset = s => ( s.includes( '@' ) ? `@@@${s}@@@` : `@${s}@` );
const numbers = raw => String( raw ).split( /[\s,]+/ ).filter( Boolean ).map( Number ).map( n => ( Number.isFinite( n ) ? n : 0 ) );

function literal( type, raw ) {

	switch ( type ) {

		case 'float': return String( numbers( raw )[ 0 ] ?? 0 );
		case 'integer': return String( Math.trunc( numbers( raw )[ 0 ] ?? 0 ) );
		case 'boolean': return String( raw ).trim() === 'true' ? '1' : '0';
		case 'string':
		case 'geomname': return quote( raw );
		case 'floatarray': return `[${numbers( raw ).join( ', ' )}]`;
		case 'integerarray': return `[${numbers( raw ).map( Math.trunc ).join( ', ' )}]`;

	}

	const size = SIZES[ type ];
	if ( ! size ) return null;
	const v = numbers( raw );
	const all = Array.from( { length: size }, ( _, i ) => v[ i ] ?? v[ v.length - 1 ] ?? 0 );
	if ( type === 'matrix33' || type === 'matrix44' ) {

		const n = type === 'matrix33' ? 3 : 4;
		return `( ${Array.from( { length: n }, ( _, r ) => `(${all.slice( r * n, r * n + n ).join( ', ' )})` ).join( ', ' )} )`;

	}

	return `(${all.join( ', ' )})`;

}

const usdType = type => USD_TYPES[ type ] ?? 'token';

// ── Documents ────────────────────────────────────────────────────

const children = ( element, ...tags ) => element.children.filter( c => tags.includes( c.tag ) );
const inputsOf = element => children( element, 'input', 'parameter' );

/** What an element passes to the elements inside it: the nearest file prefix, colour space and tokens. */
function scoped( context, element ) {

	const tokens = children( element, 'token' );
	return {
		fileprefix: element.attrs.fileprefix ?? context.fileprefix,
		colorspace: element.attrs.colorspace ?? context.colorspace,
		tokens: tokens.length ? { ...context.tokens, ...Object.fromEntries( tokens.map( t => [ t.attrs.name, t.attrs.value ?? '' ] ) ) } : context.tokens,
	};

}

/** 1.37's `<material>`s as 1.38's surface nodes and surfacematerials, a shaderref renamed where another element holds its name. */
function upgradeMaterials( elements, warn ) {

	const taken = new Set( elements.map( e => e.attrs.name ).filter( Boolean ) );
	// As MaterialX's createValidChildName: the name, else it with 2, 3… appended.
	const unique = name => {

		let candidate = name;
		for ( let n = 2; taken.has( candidate ); n ++ ) candidate = `${name}${n}`;
		taken.add( candidate );
		return candidate;

	};

	return elements.flatMap( element => {

		if ( element.tag !== 'material' ) return [ element ];
		const refs = children( element, 'shaderref' ).filter( ref => ! /displacement/.test( ref.attrs.node ?? '' ) );
		if ( refs.length === 0 ) {

			warn( 'mtlx:noshaderref', `MaterialX material "${element.attrs.name}" has no surface shaderref — skipped` );
			return [];

		}

		const ref = refs[ 0 ];
		const shader = {
			tag: ref.attrs.node, attrs: { name: unique( ref.attrs.name ?? `SR_${element.attrs.name}` ), type: 'surfaceshader', ...( ref.attrs.nodedef && { nodedef: ref.attrs.nodedef } ) },
			children: children( ref, 'bindinput', 'bindparam' ).map( b => ( { tag: 'input', attrs: b.attrs, children: [] } ) ),
		};
		const surface = {
			tag: 'surfacematerial', attrs: { name: element.attrs.name, type: 'material' },
			children: [ { tag: 'input', attrs: { name: 'surfaceshader', type: 'surfaceshader', nodename: shader.attrs.name }, children: [] } ],
		};
		return [ shader, surface ];

	} );

}

class Graph {

	/** `element`: the document or a nodegraph; `context`: what it passes to its nodes (scoped()). */
	constructor( element, context ) {

		this.element = element;
		this.context = context;
		this.nodes = new Map();
		for ( const child of element.children ) if ( ! NOT_NODES.has( child.tag ) && child.attrs.name ) this.nodes.set( child.attrs.name, child );

	}

	output( name ) {

		return children( this.element, 'output' ).find( o => o.attrs.name === name ) ?? null;

	}

}

// Whether an input takes its value from elsewhere.
const connects = input => [ 'nodename', 'nodegraph', 'output', 'interfacename' ].some( a => input.attrs[ a ] !== undefined );
const indent = ( lines, depth ) => lines.flatMap( line => line.split( '\n' ) ).map( line => '    '.repeat( depth ) + line );
// Nodes whose inputs USDScene reads as values: an interface input's value is written in place of the connection.
const READ_AS_VALUES = /^(tiled)?image$/;

const dirOf = path => ( path.includes( '/' ) ? path.slice( 0, path.lastIndexOf( '/' ) + 1 ) : '' );

/**
 * The elements a document's includes bring, after its own (an element of the same name it already has is kept): each
 * `{ href, text }`, `href` relative to this document. Their files are found from where each include sits: its folder
 * goes before the file prefix and the colour space of its own document is carried onto its elements.
 */
function included( elements, includes, warn ) {

	const names = new Set( elements.map( e => e.attrs.name ).filter( Boolean ) );
	const out = [ ...elements ];
	for ( const { href, text } of includes ) {

		let doc;
		try {

			doc = parseXML( text ).children.find( c => c.tag === 'materialx' );

		} catch ( error ) {

			warn( `mtlx:include:${href}`, `MaterialX include "${href}" could not be read: ${error.message}` );
			continue;

		}

		for ( const element of doc?.children ?? [] ) {

			if ( element.tag === 'xi:include' || ! element.attrs.name || names.has( element.attrs.name ) ) continue;
			names.add( element.attrs.name );
			const colorspace = element.attrs.colorspace ?? doc.attrs.colorspace;
			out.push( { ...element, attrs: {
				...element.attrs,
				fileprefix: dirOf( href ) + ( element.attrs.fileprefix ?? doc.attrs.fileprefix ?? '' ),
				...( colorspace && { colorspace } ),
			} } );

		}

	}

	return out;

}

/** The files a document includes (`<xi:include href>`), as written. */
export function materialXIncludes( text ) {

	const doc = parseXML( text ).children.find( c => c.tag === 'materialx' );
	return children( doc ?? { children: [] }, 'xi:include' ).map( e => e.attrs.href ).filter( Boolean );

}

class Translator {

	constructor( root, warn, includes = [] ) {

		this.warn = warn;
		const doc = root.children.find( c => c.tag === 'materialx' );
		if ( ! doc ) throw new Error( 'not a MaterialX document (no <materialx> element)' );
		const upgraded = { ...doc, children: upgradeMaterials( included( doc.children, includes, warn ), warn ) };
		const context = scoped( { fileprefix: '', colorspace: null, tokens: {} }, upgraded );
		this.doc = new Graph( upgraded, context );
		this.graphs = new Map( children( upgraded, 'nodegraph' ).filter( g => ! g.attrs.nodedef ).map( g => [ g.attrs.name, new Graph( g, scoped( context, g ) ) ] ) );
		// Nodes the document defines itself: a nodedef implemented by a node graph (its `nodedef`, or an <implementation>).
		const defs = new Map( children( upgraded, 'nodedef' ).map( d => [ d.attrs.name, d ] ) );
		const graphsByName = new Map( children( upgraded, 'nodegraph' ).map( g => [ g.attrs.name, g ] ) );
		const links = [
			...children( upgraded, 'nodegraph' ).filter( g => g.attrs.nodedef ).map( g => [ g.attrs.nodedef, g ] ),
			...children( upgraded, 'implementation' ).filter( i => i.attrs.nodegraph ).map( i => [ i.attrs.nodedef, graphsByName.get( i.attrs.nodegraph ) ] ),
		];
		this.customs = links.flatMap( ( [ name, impl ] ) => ( defs.get( name )?.attrs.node && impl ? [ { def: defs.get( name ), impl } ] : [] ) );
		this.expanding = new Set();
		if ( children( upgraded, 'look', 'lookgroup' ).length ) warn( 'mtlx:look', 'MaterialX looks (material assignments to geometry) are not read' );
		this.materials = [ ...this.doc.nodes.values() ].filter( n => n.tag === 'surfacematerial' );

	}

	translate() {

		const lines = [ '#usda 1.0', 'def "MaterialX"', '{', '    def "Materials"', '    {' ];
		const seen = new Set();
		for ( const material of this.materials ) {

			const name = identifier( material.attrs.name );
			if ( seen.has( name ) ) continue;
			seen.add( name );
			lines.push( ...indent( this.material( material, `/MaterialX/Materials/${name}` ), 2 ) );

		}

		lines.push( '    }', '}' );
		return lines.join( '\n' ) + '\n';

	}

	// A material's prims are gathered by scope — the material (its surface shaders), the NodeGraphs graph of
	// document-level nodes, each node graph — and written out after, so whatever a node reads lands in its own block.
	// usdMtlx lifts the values of the material's shader onto the material's own inputs, connected back.
	material( material, path ) {

		this.base = path;
		this.top = `${path}/NodeGraphs`;
		this.written = new Set();
		this.blocks = new Map( [[ path, []]] );
		this.heads = new Map();
		this.interface = [];
		const input = inputsOf( material ).find( i => i.attrs.name === 'surfaceshader' );
		this.lifted = input?.attrs.nodename !== undefined ? this.doc.nodes.get( input.attrs.nodename ) : null;
		const source = input && this.source( input, this.doc, path, material.attrs.name );
		if ( ! source ) this.warn( `mtlx:nosurface:${material.attrs.name}`, `MaterialX material "${material.attrs.name}" has no surface shader — shaded grey` );
		const out = [ `def Material "${path.slice( path.lastIndexOf( '/' ) + 1 )}"`, '{', ...indent( this.interface, 1 ) ];
		if ( source ) out.push( `    token outputs:mtlx:surface.connect = <${source}>` );
		out.push( ...indent( this.blocks.get( path ), 1 ) );
		for ( const [ scope, lines ] of this.blocks ) {

			if ( scope === path ) continue;
			out.push( `    def NodeGraph "${scope.slice( scope.lastIndexOf( '/' ) + 1 )}"`, '    {', ...indent( this.heads.get( scope ) ?? [], 2 ), ...indent( lines, 2 ), '    }' );

		}

		out.push( '}' );
		return out;

	}

	add( scope, lines ) {

		if ( ! this.blocks.has( scope ) ) this.blocks.set( scope, [] );
		this.blocks.get( scope ).push( ...lines );

	}

	unique( scope, name ) {

		let candidate = name;
		for ( let n = 1; this.written.has( `${scope}/${candidate}` ); n ++ ) candidate = `${name}_${n}`;
		this.written.add( `${scope}/${candidate}` );
		return candidate;

	}

	/** The connection an input makes (`<path>.outputs:x`), writing what it reads; null for a value. */
	source( input, graph, scope, owner ) {

		const { nodename, nodegraph, output, interfacename, channels } = input.attrs;
		let target = null, type = null;
		const bound = interfacename !== undefined ? graph.bindings?.get( interfacename ) : null;
		if ( bound ) {

			// Inside a custom node's graph: what the node's own input (or its definition's default) connects to.
			target = connects( bound.input ) ? this.source( bound.input, bound.graph, bound.scope, owner ) : null;
			type = bound.input.attrs.type ?? input.attrs.type;

		} else if ( interfacename !== undefined && graph.bindings ) {

			// An input the definition does not declare: unconnected.
			return null;

		} else if ( interfacename !== undefined && graph !== this.doc ) {

			target = `${scope}.inputs:${identifier( interfacename )}`;
			type = inputsOf( graph.element ).find( i => i.attrs.name === interfacename )?.attrs.type ?? input.attrs.type;

		} else if ( nodename !== undefined ) {

			const node = graph.nodes.get( nodename );
			if ( ! node ) {

				this.warn( `mtlx:missing:${nodename}`, `MaterialX node "${nodename}" not found` );
				return null;

			}

			const custom = this.customFor( node );
			if ( custom ) {

				target = this.expand( node, custom, graph, graph === this.doc ? this.top : scope, output );
				type = node.attrs.type;
				if ( ! target ) return null;
				if ( channels ) target = this.channels( target, type, channels, input.attrs.type, graph === this.doc ? this.top : scope, `${owner ?? 'in'}_${input.attrs.name}` );
				return target;

			}

			const at = this.node( node, graph, graph === this.doc ? this.top : scope );
			const out = output && children( node, 'output' ).find( o => o.attrs.name === output );
			// usdMtlx names a surface shader's output `surface`.
			target = `${at}.outputs:${identifier( output ?? ( node.attrs.type === 'surfaceshader' ? 'surface' : 'out' ) )}`;
			type = out?.attrs.type ?? node.attrs.type;

		} else if ( nodegraph !== undefined ) {

			const g = this.graphs.get( nodegraph );
			if ( ! g ) {

				this.warn( `mtlx:missing:${nodegraph}`, `MaterialX node graph "${nodegraph}" not found` );
				return null;

			}

			const at = this.graph( g );
			const out = output ? g.output( output ) : children( g.element, 'output' )[ 0 ];
			target = `${at}.outputs:${identifier( out?.attrs.name ?? output ?? 'out' )}`;
			type = out?.attrs.type ?? input.attrs.type;

		} else if ( output !== undefined && graph === this.doc && input.tag !== 'output' ) {

			// A document-level <output>, which names the node it passes on.
			const out = this.doc.output( output );
			target = out && this.source( out, graph, scope, owner );
			type = out?.attrs.type ?? input.attrs.type;

		}

		if ( ! target ) return null;
		if ( channels ) target = this.channels( target, type, channels, input.attrs.type, graph === this.doc ? this.top : scope, `${owner ?? 'in'}_${input.attrs.name}` );
		return target;

	}

	/** The definition and graph a custom node is made of: by its `nodedef`, else by its category and type. */
	customFor( node ) {

		if ( node.attrs.nodedef ) return this.customs.find( c => c.def.attrs.name === node.attrs.nodedef ) ?? null;
		const typeOf = def => def.attrs.type ?? children( def, 'output' )[ 0 ]?.attrs.type;
		return this.customs.find( c => c.def.attrs.node === node.tag && ( ! node.attrs.type || typeOf( c.def ) === node.attrs.type ) )
			?? this.customs.find( c => c.def.attrs.node === node.tag ) ?? null;

	}

	/**
	 * A custom node written as its graph's nodes, in its own scope, each named after it (`<node>_<inner>`); the graph's
	 * inputs bound to the node's own, else its definition's defaults. The connection its output makes.
	 */
	expand( node, { def, impl }, graph, scope, output ) {

		// A definition whose graph reaches it again, however deep, never ends.
		const key = def.attrs.name;
		if ( this.expanding.has( key ) ) {

			this.warn( `mtlx:recursive:${node.tag}`, `MaterialX node "${node.tag}" is defined through itself — left out` );
			return null;

		}

		this.expanding.add( key );
		const prefix = `${node.attrs.name}_`;
		const context = scoped( graph.context, node );
		const bindings = new Map();
		for ( const declared of inputsOf( def ) ) {

			const own = inputsOf( node ).find( i => i.attrs.name === declared.attrs.name );
			bindings.set( declared.attrs.name, own ? { input: own, graph, scope, context } : { input: declared, graph: this.doc, scope, context: scoped( context, def ) } );

		}

		const inner = {
			element: impl, context: scoped( context, impl ), bindings,
			nodes: new Map( impl.children.filter( c => ! NOT_NODES.has( c.tag ) && c.attrs.name ).map( c => [ c.attrs.name, { ...c, attrs: { ...c.attrs, name: prefix + c.attrs.name } } ] ) ),
			output: name => children( impl, 'output' ).find( o => o.attrs.name === name ) ?? null,
		};
		const out = ( output && inner.output( output ) ) ?? children( impl, 'output' )[ 0 ];
		const target = out ? this.source( out, inner, scope, prefix + out.attrs.name ) : null;
		this.expanding.delete( key );
		return target;

	}

	/** A 1.38 channel pick as MaterialX's upgrade writes it: an extract, a convert or a combine of extracts. */
	channels( target, from, channels, to, scope, stem ) {

		const helper = ( suffix, id, lines ) => {

			const name = this.unique( scope, identifier( `${stem}_${suffix}` ) );
			this.add( scope, this.shader( name, id, lines ) );
			return `${scope}/${name}.outputs:out`;

		};

		const pick = c => {

			if ( c === '0' || c === '1' ) return { value: c };
			if ( from === 'float' ) return { target };
			return { target: helper( c, `ND_extract_${from}`, [ `${usdType( from )} inputs:in.connect = <${target}>`, `int inputs:index = ${CHANNEL[ c ] ?? 0}` ] ) };

		};

		if ( channels.length === 1 ) return pick( channels ).target ?? null;
		if ( from === 'float' && [ ...channels ].every( c => c === channels[ 0 ] ) ) return helper( 'convert', `ND_convert_float_${to}`, [ `float inputs:in.connect = <${target}>` ] );
		const parts = [ ...channels ].map( pick );
		return helper( 'combine', `ND_combine${channels.length}_${to}`, parts.map( ( p, i ) => (
			p.target ? `float inputs:in${i + 1}.connect = <${p.target}>` : `float inputs:in${i + 1} = ${p.value}`
		) ) );

	}

	/** A document-level node goes into the NodeGraphs graph, a surface shader onto the material; a graph's node into it. */
	node( node, graph, scope ) {

		const where = graph === this.doc && node.attrs.type === 'surfaceshader' ? this.base : scope;
		const at = `${where}/${identifier( node.attrs.name )}`;
		if ( this.written.has( at ) ) return at;
		this.written.add( at );
		this.add( where, this.writeNode( node, graph, where ) );
		return at;

	}

	graph( g ) {

		const name = identifier( g.element.attrs.name );
		const at = `${this.base}/${name}`;
		if ( this.written.has( at ) ) return at;
		this.written.add( at );
		this.blocks.set( at, [] );
		const head = [];
		this.heads.set( at, head );
		for ( const input of inputsOf( g.element ) ) this.writeInput( input, g, at, line => head.push( line ), null, g.context );
		for ( const output of children( g.element, 'output' ) ) {

			const source = this.source( output, g, at, `${name}_${output.attrs.name}` );
			if ( source ) head.push( `${usdType( output.attrs.type )} outputs:${identifier( output.attrs.name )}.connect = <${source}>` );

		}

		return at;

	}

	/** A node's Shader prim, as lines. */
	writeNode( node, graph, scope ) {

		if ( node.tag === 'swizzle' ) return this.swizzle( node, graph, scope );
		const context = scoped( graph.context, node );
		const lines = [];
		const values = READ_AS_VALUES.test( node.tag );
		for ( const input of inputsOf( node ) ) this.writeInput( input, graph, scope, line => lines.push( line ), node.attrs.name, context, { values, lift: node === this.lifted } );
		return this.shader( identifier( node.attrs.name ), this.nodeId( node ), lines );

	}

	shader( name, id, lines ) {

		return [ `def Shader "${name}"`, '{', `    uniform token info:id = "${id}"`, ...indent( lines, 1 ), '}' ];

	}

	writeInput( input, graph, scope, out, owner, context, { values = false, lift = false } = {} ) {

		const { name, type, interfacename } = input.attrs;
		if ( ! name ) return;
		const usd = `${usdType( type )} inputs:${identifier( name )}`;
		// Read as a value (an image's file and placement, any string): the graph's own input's value comes in.
		const bound = interfacename !== undefined ? graph.bindings?.get( interfacename ) : null;
		if ( bound && ! connects( bound.input ) ) {

			// A custom node's graph has no prim of its own: its inputs' values are written where they are read.
			const line = bound.input.attrs.value === undefined ? null : this.valueLine( usd, type, bound.input.attrs.value, scoped( bound.context, bound.input ) );
			return line && out( line );

		}

		const inner = ! graph.bindings && interfacename !== undefined && graph !== this.doc && ( values || type === 'filename' || type === 'string' )
			? inputsOf( graph.element ).find( i => i.attrs.name === interfacename && i.attrs.value !== undefined ) : null;
		if ( inner ) return out( this.valueLine( usd, type, inner.attrs.value, scoped( graph.context, inner ) ) );
		const source = this.source( input, graph, scope, owner );
		if ( source ) return out( `${usd}.connect = <${source}>` );
		if ( input.attrs.value === undefined ) return;
		const line = this.valueLine( usd, type, input.attrs.value, scoped( context, input ) );
		if ( ! line ) return;
		if ( ! lift ) return out( line );
		this.interface.push( line );
		out( `${usd}.connect = <${this.base}.inputs:${identifier( name )}>` );

	}

	valueLine( usd, type, value, scope ) {

		if ( type === 'filename' ) {

			const file = ( scope.fileprefix ?? '' ) + value.replace( /\[(\w+)\]/g, ( m, t ) => scope.tokens[ t ] ?? m );
			return scope.colorspace ? `${usd} = ${asset( file )} (\n    colorSpace = ${quote( scope.colorspace )}\n)` : `${usd} = ${asset( file )}`;

		}

		const v = literal( type, value );
		return v === null ? null : `${usd} = ${v}`;

	}

	/** 1.38's swizzle, as the upgrade replaces it: the same pick an input's `channels` makes, under the node's name. */
	swizzle( node, graph, scope ) {

		const input = inputsOf( node ).find( i => i.attrs.name === 'in' );
		const channels = inputsOf( node ).find( i => i.attrs.name === 'channels' )?.attrs.value ?? '';
		const from = input?.attrs.type ?? 'float', to = node.attrs.type ?? 'float';
		const name = identifier( node.attrs.name );
		const source = input && this.source( input, graph, scope, node.attrs.name );
		if ( ! source ) {

			const v = numbers( input?.attrs.value ?? '0' );
			const picked = [ ...channels ].map( c => ( c === '0' || c === '1' ? Number( c ) : v[ CHANNEL[ c ] ?? 0 ] ?? 0 ) );
			return this.shader( name, `ND_constant_${to}`, [ `${usdType( to )} inputs:value = ${literal( to, picked.join( ',' ) )}` ] );

		}

		const same = channels.length === ( SIZES[ from ] ?? 1 ) && [ ...channels ].every( ( c, i ) => CHANNEL[ c ] === i );
		const picked = channels && ! same ? this.channels( source, from, channels, to, scope, name ) : source;
		return this.shader( name, `ND_dot_${to}`, [ `${usdType( to )} inputs:in.connect = <${picked}>` ] );

	}

	nodeId( node ) {

		if ( node.attrs.nodedef ) return node.attrs.nodedef;
		const category = node.tag, type = node.attrs.type ?? 'float';
		const inputType = n => inputsOf( node ).find( i => i.attrs.name === n )?.attrs.type ?? null;
		if ( type === 'surfaceshader' ) return category === 'surface' ? 'ND_surface' : `ND_${category}_surfaceshader`;
		if ( type === 'BSDF' || type === 'EDF' || type === 'VDF' ) {

			const kind = type.toLowerCase();
			if ( category.endsWith( `_${kind}` ) ) return `ND_${category}`;
			if ( category === 'multiply' ) return `ND_multiply_${kind}${inputType( 'in2' ) === 'float' ? 'F' : 'C'}`;
			return `ND_${category}_${kind}`;

		}

		if ( type === 'material' ) return `ND_${category}`;
		if ( category === 'convert' ) return `ND_convert_${inputType( 'in' ) ?? 'float'}_${type}`;
		if ( /^(extract|separate[234])$/.test( category ) ) return `ND_${category}_${inputType( 'in' ) ?? 'color3'}`;
		if ( category === 'normalmap' ) return `ND_normalmap_${inputType( 'scale' ) === 'vector2' ? 'vector2' : 'float'}`;
		// artistic_ior and the like: their nodedef names no type.
		if ( type === 'multioutput' ) return `ND_${category}`;
		if ( category === 'mix' ) return VECTORS.has( type ) && inputType( 'mix' ) && inputType( 'mix' ) !== 'float' ? `ND_mix_${type}_${type}` : `ND_mix_${type}`;
		const second = FA_INPUTS[ category ];
		if ( second && VECTORS.has( type ) && inputType( second ) === 'float' ) return `ND_${category}_${type}FA`;
		return `ND_${category}_${type}`;

	}

}

/**
 * A MaterialX document's materials as USDA text, laid out as usdMtlx lays them out. Nodes the document wires to a
 * material are written beneath it; what nothing reaches is left out.
 * @param {string} text - the `.mtlx` document
 * @param {{warn?: function(string, string): void, includes?: Array<{href: string, text: string}>}} [options] -
 *   `warn( key, message )`, once per key is enough; `includes` the documents it includes, nested ones too, `href`
 *   relative to this document (USDStage reads them)
 * @returns {string}
 */
export function materialXToUSDA( text, { warn = () => {}, includes = [] } = {} ) {

	return new Translator( parseXML( text ), warn, includes ).translate();

}

/** The names of a document's materials, as the prims under /MaterialX/Materials are named. */
export function materialXNames( text ) {

	const t = new Translator( parseXML( text ), () => {} );
	return [ ...new Set( t.materials.map( m => identifier( m.attrs.name ) ) ) ];

}
