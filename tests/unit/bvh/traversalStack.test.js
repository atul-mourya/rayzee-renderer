import { describe, it, expect } from 'vitest';
import { traversalStackNeed, traversalStackSize, MIN_TRAVERSAL_STACK, MAX_TRAVERSAL_STACK } from '@/core/bvh/TraversalStack.js';
import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { foldLeaves } from '@/core/bvh/BVHLeafFold.js';
import { ChunkedRecords } from '@/core/memory/ChunkedRecords.js';
import { BVH_LEAF_MARKERS, CLUSTER_COUNT_SHIFT, TRI_SIDE_SHIFT } from '@/core/scene/BufferLayout.js';

const { TRIANGLE_LEAF, BLAS_POINTER_LEAF, CLUSTER_LEAF } = BVH_LEAF_MARKERS;

// Hand-built trees: `inner( l, r )`, `leaf()`, `pointer( root )`, `cluster( roots )`, laid out in the order given.
function tree( nodes ) {

	const u = new Uint32Array( nodes.length * 16 );
	nodes.forEach( ( n, i ) => {

		const o = i * 16;
		if ( n.inner ) [ u[ o + 3 ], u[ o + 7 ] ] = n.inner;
		else if ( n.pointer !== undefined ) [ u[ o ], u[ o + 3 ] ] = [ n.pointer, BLAS_POINTER_LEAF ];
		else if ( n.cluster ) {

			u[ o ] = ( n.cluster.length - 1 ) << CLUSTER_COUNT_SHIFT;
			u[ o + 3 ] = CLUSTER_LEAF;
			n.cluster.forEach( ( root, k ) => ( u[ o + 12 + k ] = root ) );

		} else [ u[ o + 1 ], u[ o + 3 ] ] = [ 1, TRIANGLE_LEAF ];

	} );
	return new Float32Array( u.buffer );

}

const inner = ( l, r ) => ( { inner: [ l, r ] } );
const leaf = () => ( {} );

// Inner nodes at..at+depth−1, each with a leaf on one side and the next inner node on the other.
function chain( depth, at = 0 ) {

	const nodes = [];
	for ( let i = 0; i < depth; i ++ ) nodes.push( inner( at + depth + 1 + i, at + ( i + 1 < depth ? i + 1 : depth ) ) );
	nodes.push( leaf() );
	for ( let i = 0; i < depth; i ++ ) nodes.push( leaf() );
	return nodes;

}

// The chain's boxes for a ray up +z through the origin: every side leaf further along it than the rest of the chain.
function boxedChain( depth ) {

	const f = tree( chain( depth ) );
	for ( let i = 0; i < depth; i ++ ) {

		f.set( [ - 1, - 1, 5 ], i * 16 ); f.set( [ 1, 1, 6 ], i * 16 + 4 );
		f.set( [ - 1, - 1, 0 ], i * 16 + 8 ); f.set( [ 1, 1, 1 ], i * 16 + 12 );

	}

	return f;

}

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function builtTree( count = 3000 ) {

	const data = new Uint32Array( count * 20 );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < count; i ++ ) {

		// Clumps at three scales, so the tree is lopsided.
		const s = [ 1, 0.05, 0.002 ][ i % 3 ];
		const x = rand() * 20 * s, y = rand() * 20 * s, z = rand() * 20 * s;
		f.set( [ x, y, z ], i * 20 );
		f.set( [ x + rand() * s, y, z ], i * 20 + 4 );
		f.set( [ x, y + rand() * s, z + rand() * s ], i * 20 + 8 );
		data[ i * 20 + 18 ] = 2 << TRI_SIDE_SHIFT;

	}

	const builder = new BVHBuilder();
	return builder.flattenBVH( builder.buildSync( data ) );

}

// Inner levels on the deepest path, read independently: a folded child is a leaf.
function innerDepth( f, folded ) {

	const u = new Uint32Array( f.buffer, f.byteOffset, f.length );
	const isLeaf = n => ( folded && n >= 0x80000000 ) || ( folded ? u[ n * 16 + 3 ] >>> 30 === 1 : u[ n * 16 + 3 ] >= 0x40000000 );
	const depth = n => ( isLeaf( n ) ? 0 : 1 + Math.max( depth( u[ n * 16 + 3 ] ), depth( u[ n * 16 + 7 ] ) ) );
	return depth( 0 );

}

// BVHTraversal's pushes over one tree with nothing ever hit, so every box a ray enters is pushed: the deepest stack.
function deepestWalk( f, origin, dir ) {

	const u = new Uint32Array( f.buffer, f.byteOffset, f.length );
	const inv = dir.map( d => 1 / d );
	const enter = ( o ) => {

		let lo = 0, hi = Infinity;
		for ( let a = 0; a < 3; a ++ ) {

			const t0 = ( f[ o + a ] - origin[ a ] ) * inv[ a ], t1 = ( f[ o + 4 + a ] - origin[ a ] ) * inv[ a ];
			lo = Math.max( lo, Math.min( t0, t1 ) );
			hi = Math.min( hi, Math.max( t0, t1 ) );

		}

		return lo <= hi ? lo : Infinity;

	};

	const stack = [ 0 ];
	let deepest = 1;
	while ( stack.length ) {

		const n = stack.pop();
		const o = n * 16;
		if ( u[ o + 3 ] >= 0x40000000 ) continue;
		const a = enter( o ), b = enter( o + 8 );
		const [ near, far, dn, df ] = a <= b ? [ u[ o + 3 ], u[ o + 7 ], a, b ] : [ u[ o + 7 ], u[ o + 3 ], b, a ];
		if ( df < Infinity ) stack.push( far );
		if ( dn < Infinity ) stack.push( near );
		deepest = Math.max( deepest, stack.length );

	}

	return deepest;

}

describe( 'traversalStackNeed', () => {

	it( 'is a chain\'s depth plus one: the nearer child sits on its sibling at every level', () => {

		expect( traversalStackNeed( tree( chain( 1 ) ) ) ).toBe( 2 );
		expect( traversalStackNeed( tree( chain( 50 ) ) ) ).toBe( 51 );
		expect( traversalStackNeed( tree( [ leaf() ] ) ) ).toBe( 1 );

	} );

	it( 'is a built tree\'s deepest path plus one, folded or not', () => {

		const bvh = builtTree();
		const depth = innerDepth( bvh, false );
		expect( depth ).toBeGreaterThan( 12 );
		expect( traversalStackNeed( bvh ) ).toBe( depth + 1 );

		const folded = foldLeaves( bvh );
		folded.foldedLeaves = true;
		expect( traversalStackNeed( folded ) ).toBe( innerDepth( folded, true ) + 1 );
		// Read as unfolded, a folded child reference looks like a node and the need comes out wrong.
		expect( traversalStackNeed( folded, { folded: false } ) ).not.toBe( traversalStackNeed( folded ) );

	} );

	it( 'is what the shader\'s walk reaches on a ray that enters both children at every level', () => {

		expect( deepestWalk( boxedChain( 50 ), [ 0, 0, - 5 ], [ 0, 0, 1 ] ) ).toBe( traversalStackNeed( boxedChain( 50 ) ) );

	} );

	it( 'is never below what the shader\'s walk reaches', () => {

		const bvh = builtTree();
		const need = traversalStackNeed( bvh );
		let deepest = 0;
		for ( let r = 0; r < 4000; r ++ ) {

			const origin = [ rand() * 24 - 2, rand() * 24 - 2, - 5 ];
			const d = [ rand() - 0.5, rand() - 0.5, 1 ], l = Math.hypot( ...d );
			deepest = Math.max( deepest, deepestWalk( bvh, origin, d.map( v => v / l ) ) );

		}

		expect( deepest ).toBeGreaterThan( 2 );
		expect( deepest ).toBeLessThanOrEqual( need );

	} );

	it( 'adds an object\'s need below the leaf that enters it', () => {

		// TLAS: an inner node over two pointer leaves; one object a chain of 3, the other a single leaf.
		const nodes = [ inner( 1, 2 ), { pointer: 3 }, { pointer: 3 + 7 }, ...chain( 3, 3 ), leaf() ];
		expect( traversalStackNeed( tree( nodes ) ) ).toBe( 1 + 4 );

	} );

	it( 'counts a cluster\'s copies on the stack beneath the first one entered', () => {

		// Four copies, one of a chain of 3 (need 4): three pending copies under it.
		const four = [ { cluster: [ 2, 1, 1, 1 ] }, leaf(), ...chain( 3, 2 ) ];
		expect( traversalStackNeed( tree( four ) ) ).toBe( 3 + 4 );
		// Copies of a single leaf: the four entries themselves.
		expect( traversalStackNeed( tree( [ { cluster: [ 1, 1, 1, 1 ] }, leaf() ] ) ) ).toBe( 4 );
		expect( traversalStackNeed( tree( [ { cluster: [ 1, 1 ] }, leaf() ] ) ) ).toBe( 2 );

	} );

	it( 'reads chunked records as the flat array they hold', () => {

		const flat = tree( chain( 30 ) );
		const perChunk = 7;
		const chunks = [];
		for ( let s = 0; s < flat.length / 16; s += perChunk ) chunks.push( flat.slice( s * 16, Math.min( flat.length, ( s + perChunk ) * 16 ) ) );
		const records = ChunkedRecords.adopt( chunks, flat.length / 16, 16, perChunk );
		expect( records.chunks.length ).toBeGreaterThan( 5 );
		expect( traversalStackNeed( records ) ).toBe( traversalStackNeed( flat ) );

	} );

} );

describe( 'traversalStackSize', () => {

	it( 'keeps every tree within the old 40 at 40, and rounds a deeper one up to 8', () => {

		expect( traversalStackSize( null ) ).toBe( MIN_TRAVERSAL_STACK );
		expect( traversalStackSize( tree( chain( 20 ) ) ) ).toBe( 40 );
		expect( traversalStackSize( tree( chain( 39 ) ) ) ).toBe( 40 );
		expect( traversalStackSize( tree( chain( 40 ) ) ) ).toBe( 48 );
		expect( traversalStackSize( tree( chain( 50 ) ) ) ).toBe( 56 );
		expect( traversalStackSize( tree( chain( 200 ) ) ) ).toBe( MAX_TRAVERSAL_STACK );

	} );

	it( 'takes 64 for a tree with chunks on disk, which it cannot walk', () => {

		const records = ChunkedRecords.adopt( [ tree( chain( 50 ) ) ], 101, 16, 101 );
		records.isResident = () => false;
		expect( traversalStackSize( records ) ).toBe( 64 );

	} );

} );
