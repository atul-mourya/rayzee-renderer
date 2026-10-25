/**
 * USD composition over files read on demand: layer stacks (sublayers), references, payloads, inherits, specializes
 * and variant sets, composed one prim at a time. A composed prim keeps the tree of sites its opinions come from —
 * one node per layer stack and arc, strongest first, as OpenUSD's prim index does — and reads values, children and
 * relationship targets through it, each node mapping the paths it authors into the stage's namespace.
 */

import { composeListOps, parseUSDC } from './USDLayer.js';
import { parseUSDA } from './USDText.js';

const RANK = { local: 0, inherit: 1, variant: 2, reference: 3, payload: 4, specialize: 5 };
const MAX_CONNECTION_HOPS = 32;

export function parseLayer( bytes, path ) {

	const crate = bytes.length >= 8 && bytes[ 0 ] === 0x50 && bytes[ 1 ] === 0x58 && bytes[ 2 ] === 0x52 && bytes[ 3 ] === 0x2D
		&& bytes[ 4 ] === 0x55 && bytes[ 5 ] === 0x53 && bytes[ 6 ] === 0x44 && bytes[ 7 ] === 0x43;
	if ( ! crate ) return parseUSDA( new TextDecoder().decode( bytes ), path );
	const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
	return parseUSDC( whole ? bytes.buffer : bytes.slice().buffer, path );

}

function normalize( path ) {

	const out = [];
	for ( const part of path.replace( /\\/g, '/' ).split( '/' ) ) {

		if ( part === '' || part === '.' ) continue;
		if ( part === '..' ) out.pop();
		else out.push( part );

	}

	return out.join( '/' );

}

const dirOf = path => ( path.includes( '/' ) ? path.slice( 0, path.lastIndexOf( '/' ) ) : '' );

export class USDFiles {

	/** `omitted`: files there but not read, those of the parts left out of a partial load. */
	constructor( paths, read, { omitted = [] } = {} ) {

		this.read = read;
		this.exact = new Map();
		this.lower = new Map();
		this.byName = new Map();
		this.omitted = new Set( omitted.map( path => normalize( path ).toLowerCase() ) );
		for ( const path of paths ) {

			const key = normalize( path );
			this.exact.set( key, path );
			this.lower.set( key.toLowerCase(), path );
			const name = key.split( '/' ).pop().toLowerCase();
			const bucket = this.byName.get( name );
			if ( bucket ) bucket.push( path );
			else this.byName.set( name, [ path ] );

		}

	}

	isOmitted( asset, from = '' ) {

		return this.omitted.has( this.key( asset, from ).toLowerCase() );

	}

	key( asset, from ) {

		const clean = asset.replace( /\\/g, '/' );
		return normalize( clean.startsWith( '/' ) ? clean : `${dirOf( from )}/${clean}` );

	}

	resolve( asset, from = '' ) {

		if ( ! asset ) return null;
		const clean = asset.replace( /\\/g, '/' );
		const key = this.key( asset, from );
		const hit = this.exact.get( key ) ?? this.lower.get( key.toLowerCase() );
		if ( hit ) return hit;
		const tail = normalize( clean ).toLowerCase();
		const bucket = this.byName.get( tail.split( '/' ).pop() ) ?? [];
		const suffix = bucket.filter( p => normalize( p ).toLowerCase().endsWith( `/${tail}` ) );
		return suffix.length === 1 ? suffix[ 0 ] : null;

	}

}

const identity = path => path;

/** Paths under `src` moved under `dst`, then through `next`; other paths only through `next`. */
function prefixMap( src, dst, next ) {

	if ( src === dst ) return next;
	return path => {

		if ( path === src ) return next( dst );
		const c = path.charCodeAt( src.length );
		if ( path.startsWith( src ) && ( c === 47 || c === 46 || c === 123 ) ) return next( dst + path.slice( src.length ) );
		return next( path );

	};

}

const childPath = ( parent, name ) => ( parent === '/' ? `/${name}` : `${parent}/${name}` );

class Node {

	constructor( stack, path, map, arc, depth ) {

		this.stack = stack;
		this.path = path;
		this.map = map;
		this.arc = arc;
		this.depth = depth;
		this.specs = [];
		this.layers = [];
		this.children = [];
		this.choice = null;
		this.doneSets = null;

	}

	/** Children stay in strength order: by arc, then the arc authored deeper in namespace first. */
	add( child ) {

		const rank = RANK[ child.arc ];
		let i = this.children.length;
		while ( i > 0 ) {

			const c = this.children[ i - 1 ];
			const r = RANK[ c.arc ];
			if ( r < rank || ( r === rank && c.depth >= child.depth ) ) break;
			i --;

		}

		this.children.splice( i, 0, child );

	}

}

function* strength( node ) {

	yield node;
	for ( const child of node.children ) yield* strength( child );

}

function mapOp( op, map ) {

	const each = list => list.map( map );
	return { explicit: op.explicit ? each( op.explicit ) : null, prepend: each( op.prepend ), append: each( op.append ), add: each( op.add ), delete: each( op.delete ) };

}

export class Prim {

	constructor( stage, path, root ) {

		this.stage = stage;
		this.path = path;
		this.root = root;
		this._sites = null;

	}

	get name() {

		return this.path === '/' ? '' : this.path.slice( this.path.lastIndexOf( '/' ) + 1 );

	}

	/** `[ node, spec, layer ]`, strongest first. */
	get sites() {

		if ( this._sites ) return this._sites;
		this._sites = [];
		for ( const node of strength( this.root ) ) for ( let k = 0; k < node.specs.length; k ++ ) this._sites.push( [ node, node.specs[ k ], node.layers[ k ] ] );
		return this._sites;

	}

	get typeName() {

		for ( const [ , spec ] of this.sites ) if ( spec.typeName ) return spec.typeName;
		return '';

	}

	/** Defined by some `def` or `class`, and not abstract (its strongest one a `class`). */
	get isDefined() {

		for ( const [ , spec ] of this.sites ) {

			if ( spec.specifier === 'def' ) return true;
			if ( spec.specifier === 'class' ) return false;

		}

		return false;

	}

	meta( key ) {

		for ( const [ , spec ] of this.sites ) if ( spec.meta[ key ] !== undefined ) return spec.meta[ key ];
		return undefined;

	}

	property( name ) {

		for ( const [ , spec ] of this.sites ) {

			const prop = spec.props?.get( name );
			if ( prop && ( prop.hasValue || prop.timeSamples ) ) return prop;

		}

		return null;

	}

	/** The strongest value, or the earliest time sample where there is none; undefined when unauthored or blocked. */
	value( name ) {

		const prop = this.property( name );
		if ( ! prop ) return undefined;
		if ( prop.hasValue ) return prop.value ?? undefined;
		const first = prop.timeSamples?.values().next();
		return first && ! first.done ? first.value ?? undefined : undefined;

	}

	propertyMeta( name, key ) {

		for ( const [ , spec ] of this.sites ) {

			const value = spec.props?.get( name )?.meta[ key ];
			if ( value !== undefined ) return value;

		}

		return undefined;

	}

	/** An asset-valued attribute as the file it names, resolved against the layer that authored the value. */
	assetPath( name ) {

		for ( const [ , spec, layer ] of this.sites ) {

			const prop = spec.props?.get( name );
			if ( ! prop?.hasValue ) continue;
			const value = prop.value;
			return typeof value === 'string' && value ? { asset: value, path: this.stage.files.resolve( value, layer.path ) } : null;

		}

		return null;

	}

	propertyNames() {

		const names = new Set();
		for ( const [ , spec ] of this.sites ) for ( const name of spec.props?.keys() ?? [] ) names.add( name );
		return [ ...names ];

	}

	_paths( name, field ) {

		const ops = [];
		for ( const [ node, spec ] of this.sites ) {

			const op = spec.props?.get( name )?.[ field ];
			if ( op ) ops.push( mapOp( op, node.map ) );

		}

		return composeListOps( ops ).map( item => item.value );

	}

	targets( name ) {

		return this._paths( name, 'targets' );

	}

	connections( name ) {

		return this._paths( name, 'connections' );

	}

	childNames() {

		const names = new Set();
		for ( const [ , spec ] of this.sites ) for ( const name of spec.children?.keys() ?? [] ) names.add( name );
		return [ ...names ];

	}

	/**
	 * What two instanceable prims must share to share a prototype: the arcs on the prim itself and all they bring in.
	 * The sites that only hold the prim's own opinions — where an ancestor's arc brought it in — differ per copy and are
	 * left out, as OpenUSD leaves out an instance's local opinions.
	 */
	instanceKey() {

		const depth = this.path.split( '/' ).length - 1;
		const parts = [];
		const visit = node => {

			if ( node.arc !== 'local' && node.depth >= depth ) parts.push( `${node.arc}|${node.stack.id}|${node.path}|${node.choice ?? ''}` );
			for ( const child of node.children ) visit( child );

		};

		visit( this.root );
		return parts.join( ';' );

	}

}

export class USDStage {

	constructor( files, { warn = () => {} } = {} ) {

		this.files = files;
		this.warn = warn;
		this._layers = new Map();
		this._stacks = new Map();
		this._prims = new Map();
		this._warned = new Set();
		this.omittedArcs = 0;
		this.root = null;
		this.pseudoRoot = null;

	}

	warnOnce( key, message ) {

		if ( this._warned.has( key ) ) return;
		this._warned.add( key );
		this.warn( message );

	}

	async open( path ) {

		this.root = await this.stack( path );
		if ( ! this.root ) throw new Error( `USD layer "${path}" could not be read` );
		const meta = this.root.layers[ 0 ].meta;
		this.upAxis = meta.upAxis ?? 'Y';
		this.metersPerUnit = meta.metersPerUnit ?? 0.01;
		this.defaultPrim = meta.defaultPrim ?? '';
		this.pseudoRoot = new Prim( this, '/', this.rootNode( this.root, identity, 'local', 0 ) );
		this._prims.set( '/', this.pseudoRoot );
		return this.pseudoRoot;

	}

	layer( path ) {

		let pending = this._layers.get( path );
		if ( ! pending ) {

			pending = ( async () => {

				const bytes = await this.files.read( path );
				if ( ! bytes ) return null;
				try {

					return parseLayer( bytes, path );

				} catch ( error ) {

					this.warnOnce( `parse:${path}`, `USD layer "${path}" could not be parsed: ${error.message}` );
					return null;

				}

			} )();
			this._layers.set( path, pending );

		}

		return pending;

	}

	stack( path, seen = new Set() ) {

		let pending = this._stacks.get( path );
		if ( ! pending ) {

			pending = ( async () => {

				const layers = [];
				const add = async ( p ) => {

					if ( seen.has( p ) ) return;
					seen.add( p );
					const layer = await this.layer( p );
					if ( ! layer ) return;
					layers.push( layer );
					for ( const sub of layer.meta.subLayers ?? [] ) {

						const resolved = this.files.resolve( sub, p );
						if ( resolved ) await add( resolved );
						else this.warnOnce( `missing:${sub}`, `USD sublayer "${sub}" of "${p}" not found` );

					}

				};

				await add( path );
				if ( layers.length === 0 ) return null;
				return { id: path, layers, defaultPrim: layers[ 0 ].meta.defaultPrim ?? '' };

			} )();
			this._stacks.set( path, pending );

		}

		return pending;

	}

	rootNode( stack, map, arc, depth ) {

		const node = new Node( stack, '/', map, arc, depth );
		node.layers = stack.layers.slice();
		node.specs = stack.layers.map( layer => layer.root );
		return node;

	}

	async child( prim, name ) {

		const path = childPath( prim.path, name );
		const cached = this._prims.get( path );
		if ( cached ) return cached;
		const depth = path.split( '/' ).length - 1;
		const root = await this.childNode( prim.root, name, depth, new Set() );
		if ( ! root ) return null;
		await this.addVariants( root, depth, new Set() );
		const child = new Prim( this, path, root );
		this._prims.set( path, child );
		return child;

	}

	async primAt( path ) {

		if ( ! this.pseudoRoot ) return null;
		const cached = this._prims.get( path );
		if ( cached ) return cached;
		let prim = this.pseudoRoot;
		for ( const name of path.split( '/' ).filter( Boolean ) ) {

			prim = await this.child( prim, name );
			if ( ! prim ) return null;

		}

		return prim;

	}

	/** Forgets composed prims and every layer outside the root layer stack, once a part of the stage is done with. */
	release() {

		this._prims.clear();
		this._prims.set( '/', this.pseudoRoot );
		const keep = new Set( this.root.layers.map( layer => layer.path ) );
		for ( const path of this._layers.keys() ) if ( ! keep.has( path ) ) this._layers.delete( path );
		for ( const path of this._stacks.keys() ) if ( path !== this.root.id ) this._stacks.delete( path );

	}

	async childNode( parent, name, depth, chain ) {

		const node = new Node( parent.stack, childPath( parent.path, name ), parent.map, parent.arc, parent.depth );
		node.choice = parent.choice;
		for ( let k = 0; k < parent.specs.length; k ++ ) {

			const spec = parent.specs[ k ].child( name );
			if ( spec ) {

				node.specs.push( spec );
				node.layers.push( parent.layers[ k ] );

			}

		}

		for ( const sub of parent.children ) {

			const child = await this.childNode( sub, name, depth, chain );
			if ( child ) node.children.push( child );

		}

		if ( node.specs.length ) await this.addArcs( node, depth, chain );
		return node.specs.length || node.children.length ? node : null;

	}

	async addArcs( node, depth, chain ) {

		const arcs = key => composeListOps( node.specs.map( spec => spec.arcs?.[ key ] ?? null ), node.layers );
		for ( const { value } of arcs( 'inherits' ) ) await this.addClass( node, value, 'inherit', depth, chain );
		for ( const { value, source } of arcs( 'references' ) ) await this.addReference( node, value, source, 'reference', depth, chain );
		for ( const { value, source } of arcs( 'payload' ) ) await this.addReference( node, value, source, 'payload', depth, chain );
		for ( const { value } of arcs( 'specializes' ) ) await this.addClass( node, value, 'specialize', depth, chain );

	}

	async addClass( node, path, arc, depth, chain ) {

		const sub = await this.subtree( node.stack, path, prefixMap( path, node.path, node.map ), arc, depth, chain );
		if ( sub ) node.add( sub );

	}

	async addReference( node, ref, layer, arc, depth, chain ) {

		let stack = node.stack;
		if ( ref.asset ) {

			const path = this.files.resolve( ref.asset, layer?.path ?? '' );
			if ( ! path ) {

				if ( this.files.isOmitted( ref.asset, layer?.path ?? '' ) ) this.omittedArcs ++;
				else this.warnOnce( `missing:${ref.asset}`, `USD ${arc} "${ref.asset}" (from "${layer?.path}") not found — skipped` );
				return;

			}

			stack = await this.stack( path );
			if ( ! stack ) return;

		}

		const target = ref.path || ( stack.defaultPrim ? `/${stack.defaultPrim}` : '' );
		if ( ! target ) {

			this.warnOnce( `nodefault:${stack.id}`, `USD ${arc} to "${stack.id}" names no prim and the layer has no defaultPrim — skipped` );
			return;

		}

		const sub = await this.subtree( stack, target, prefixMap( target, node.path, node.map ), arc, depth, chain );
		if ( sub ) node.add( sub );

	}

	/**
	 * The sites of `path` in a layer stack, composed from its root down with the arcs and variants of its ancestors,
	 * as the target of an arc. Its own variant sets are left for the prim it is composed into, where a stronger site
	 * may select them.
	 */
	async subtree( stack, path, map, arc, depth, chain ) {

		const key = `${stack.id}\u0000${path}`;
		if ( chain.has( key ) ) {

			this.warnOnce( `cycle:${key}`, `USD composition cycle through "${path}" in "${stack.id}" — skipped` );
			return null;

		}

		const inner = new Set( chain ).add( key );
		let node = this.rootNode( stack, map, arc, depth );
		const names = path.split( '/' ).filter( Boolean );
		for ( let i = 0; i < names.length; i ++ ) {

			if ( i > 0 ) await this.addVariants( node, depth, inner );
			node = await this.childNode( node, names[ i ], depth, inner );
			if ( ! node ) return null;

		}

		return node;

	}

	/**
	 * Variant sets, evaluated once the other arcs are in: a selection may be authored by any site, the strongest wins,
	 * and a selected variant can bring arcs and variant sets of its own.
	 */
	async addVariants( root, depth, chain ) {

		for ( let changed = true; changed; ) {

			changed = false;
			for ( const node of [ ...strength( root ) ] ) {

				const sets = new Set( composeListOps( node.specs.map( spec => spec.arcs?.variantSetNames ?? null ) ).map( item => item.value ) );
				for ( const spec of node.specs ) for ( const set of spec.variantSets?.keys() ?? [] ) sets.add( set );
				for ( const set of sets ) {

					node.doneSets ??= new Set();
					if ( node.doneSets.has( set ) ) continue;
					node.doneSets.add( set );
					const choice = this.selection( root, set );
					if ( ! choice ) continue;

					const variant = new Node( node.stack, node.path, node.map, 'variant', depth );
					variant.choice = `${set}=${choice}`;
					for ( let k = 0; k < node.specs.length; k ++ ) {

						const spec = node.specs[ k ].variant( set, choice );
						if ( spec ) {

							variant.specs.push( spec );
							variant.layers.push( node.layers[ k ] );

						}

					}

					if ( variant.specs.length === 0 ) continue;
					node.add( variant );
					await this.addArcs( variant, depth, chain );
					changed = true;

				}

			}

		}

	}

	selection( root, set ) {

		for ( const node of strength( root ) ) for ( const spec of node.specs ) {

			const choice = spec.variantSelection?.[ set ];
			if ( choice ) return choice;

		}

		return null;

	}

	async connectionSource( prim, attribute ) {

		let [ target ] = prim.connections( attribute );
		for ( let hop = 0; target && hop < MAX_CONNECTION_HOPS; hop ++ ) {

			const dot = target.lastIndexOf( '.' );
			const source = await this.primAt( target.slice( 0, dot ) );
			if ( ! source ) return null;
			const name = target.slice( dot + 1 );
			const next = source.connections( name )[ 0 ];
			if ( ! next || source.value( 'info:id' ) ) return { prim: source, name };
			target = next;

		}

		return null;

	}

}

