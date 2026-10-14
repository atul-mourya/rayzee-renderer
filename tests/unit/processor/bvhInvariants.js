import {
	BVH_LEAF_MARKERS, BVH_MAX_INDEX, BVH_EMPTY_BOX, BVH_FOLDED_LEAF_MAX, BVH_FOLDED_FIRST_LIMIT, TRIANGLE_DATA_LAYOUT,
	TLAS_LEAF_IDENTITY, TLAS_PLACEMENT_MASK, CLUSTER_FIRST_MASK, CLUSTER_COUNT_SHIFT, CLUSTER_SIZE, CLUSTER_ROOT_MASK,
	CLUSTER_COPY_HIDDEN, RECORD_VEC4,
} from '@/core/Processor/BufferLayout.js';

const FPN = 16;
const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const { TRIANGLE_LEAF, BLAS_POINTER_LEAF, CLUSTER_LEAF } = BVH_LEAF_MARKERS;
const EMPTY = Math.fround( BVH_EMPTY_BOX );
const FOLDED = 0x80000000;
const MAX_PROBLEMS = 40;

const flat = store => ( store.chunks ? store.single ?? store.copyOf( 0, store.recordCount ) : store );
const f32 = a => ( a instanceof Float32Array ? a : new Float32Array( a.buffer, a.byteOffset, a.length ) );
const u32 = a => ( a instanceof Uint32Array ? a : new Uint32Array( a.buffer, a.byteOffset, a.length ) );

const emptyBox = () => [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];
const isEmpty = b => ! ( b[ 0 ] <= b[ 3 ] && b[ 1 ] <= b[ 4 ] && b[ 2 ] <= b[ 5 ] );
const isEmptySlot = b => b.every( v => v === EMPTY );
const tol = v => 1e-5 * Math.max( 1, Math.abs( v ) );
const fmt = b => `[${b.map( v => + v.toPrecision( 6 ) ).join( ', ' )}]`;

function unionInto( out, b ) {

	for ( let a = 0; a < 3; a ++ ) {

		out[ a ] = Math.min( out[ a ], b[ a ] );
		out[ 3 + a ] = Math.max( out[ 3 + a ], b[ 3 + a ] );

	}

	return out;

}

function contains( outer, inner ) {

	for ( let a = 0; a < 3; a ++ ) {

		if ( ! ( outer[ a ] <= inner[ a ] + tol( inner[ a ] ) ) ) return false;
		if ( ! ( outer[ 3 + a ] >= inner[ 3 + a ] - tol( inner[ 3 + a ] ) ) ) return false;

	}

	return true;

}

const slotBox = ( f, o, side ) => {

	const s = o + side * 8;
	return [ f[ s ], f[ s + 1 ], f[ s + 2 ], f[ s + 4 ], f[ s + 5 ], f[ s + 6 ] ];

};

function transformBox( box, m ) {

	const out = emptyBox();
	if ( isEmpty( box ) ) return out;
	for ( let c = 0; c < 8; c ++ ) {

		const x = box[ c & 1 ? 3 : 0 ], y = box[ c & 2 ? 4 : 1 ], z = box[ c & 4 ? 5 : 2 ];
		for ( let r = 0; r < 3; r ++ ) {

			const v = m[ r ] * x + m[ 4 + r ] * y + m[ 8 + r ] * z + m[ 12 + r ];
			out[ r ] = Math.min( out[ r ], v );
			out[ 3 + r ] = Math.max( out[ 3 + r ], v );

		}

	}

	return out;

}

const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

/**
 * Walks a BVH buffer as BVHTraversal reads it and lists every rule a traversal or refit relies on that it breaks: the
 * combined buffer with an InstanceTable, else one BLAS at node 0.
 * @returns {{problems: string[], stats: Object}}
 */
export function inspectBVH( nodes, triangles, { table = null, folded = nodes.foldedLeaves === true, triangleRange = null } = {} ) {

	const walker = new Walker( nodes, triangles, folded );
	if ( table ) walker.scene( table );
	else walker.single( triangleRange );
	return { problems: walker.problems, stats: walker.stats };

}

class Walker {

	constructor( nodes, triangles, folded ) {

		const data = flat( nodes );
		this.f = f32( data );
		this.u = u32( data );
		this.nodeCount = this.f.length / FPN;
		this.t = f32( flat( triangles ) );
		this.triCount = this.t.length / FPT;
		this.folded = folded;
		this.visited = new Uint8Array( this.nodeCount );
		this.blasExtent = new Map();
		this.problems = [];
		this.stats = {
			leafNodes: 0, foldedLeaves: 0, emptySlots: 0, blases: 0, pointerLeaves: 0, clusterLeaves: 0,
			identityCopies: 0, hiddenCopies: 0, groupCopies: 0, unreached: 0,
		};

	}

	fail( message ) {

		if ( this.problems.length < MAX_PROBLEMS ) this.problems.push( message );

	}

	isLeafTag( tag ) {

		return this.folded ? tag >>> 30 === 1 : tag >= BVH_MAX_INDEX;

	}

	triangleBox( first, count ) {

		const box = emptyBox();
		for ( let i = first; i < first + count; i ++ ) {

			for ( let v = 0; v < 12; v += 4 ) for ( let a = 0; a < 3; a ++ ) {

				const x = this.t[ i * FPT + v + a ];
				box[ a ] = Math.min( box[ a ], x );
				box[ 3 + a ] = Math.max( box[ 3 + a ], x );

			}

		}

		return box;

	}

	checkSlot( slot, content, where, { tight = true, upper = null } = {} ) {

		if ( isEmptySlot( slot ) ) {

			this.stats.emptySlots ++;
			if ( ! isEmpty( content ) ) this.fail( `${where}: BVH_EMPTY_BOX over ${fmt( content )}` );
			return;

		}

		if ( isEmpty( content ) ) {

			if ( ! upper ) this.fail( `${where}: nothing under it, yet its box ${fmt( slot )} is not BVH_EMPTY_BOX` );

		} else {

			if ( ! contains( slot, content ) ) this.fail( `${where}: box ${fmt( slot )} does not hold ${fmt( content )}` );
			if ( tight && ! contains( content, slot ) ) this.fail( `${where}: box ${fmt( slot )} is looser than ${fmt( content )}` );

		}

		if ( upper && ! contains( upper, slot ) ) this.fail( `${where}: box ${fmt( slot )} reaches past ${fmt( upper )}` );

	}

	// Children follow their parent: a refit sweeps the nodes in reverse, and it keeps every walk finite.
	enter( n, parent, lo, hi, where ) {

		if ( ! ( n >= lo && n < hi ) ) return void this.fail( `${where}: node ${n} outside [${lo}, ${hi})` );
		if ( n <= parent ) return void this.fail( `${where}: node ${n} does not follow its parent ${parent}` );
		if ( this.visited[ n ] ++ ) return void this.fail( `${where}: node ${n} reached twice` );
		return true;

	}

	single( range ) {

		const [ first, count ] = range ?? [ 0, this.triCount ];
		this.blas( 0, 0, this.nodeCount, first, count, 'BLAS' );
		this.countUnreached( 0, this.nodeCount );

	}

	blas( root, lo, hi, first, count, label ) {

		this.stats.blases ++;
		const seen = new Uint8Array( count );
		const leaf = ( a, n, where ) => {

			if ( a < first || a + n > first + count ) {

				this.fail( `${where}: triangles [${a}, ${a + n}) outside [${first}, ${first + count})` );
				return emptyBox();

			}

			for ( let i = a; i < a + n; i ++ ) seen[ i - first ] ++;
			return this.triangleBox( a, n );

		};

		const visit = ( n, parent ) => {

			const where = `${label} node ${n}`;
			if ( ! this.enter( n, parent, lo, hi, where ) ) return emptyBox();
			const o = n * FPN, tag = this.u[ o + 3 ];

			if ( this.isLeafTag( tag ) ) {

				if ( tag !== TRIANGLE_LEAF ) this.fail( `${where}: leaf tag ${tag.toString( 16 )} in a BLAS` );
				this.stats.leafNodes ++;
				return leaf( this.u[ o ], this.u[ o + 1 ], where );

			}

			const box = emptyBox();
			for ( let side = 0; side < 2; side ++ ) {

				const ref = this.u[ o + 3 + side * 4 ];
				let content;
				if ( ref >= FOLDED && this.folded ) {

					const v = ( ~ ref ) >>> 0, a = v >>> 4, c = v & 15;
					if ( c === 0 || c > BVH_FOLDED_LEAF_MAX || a >= BVH_FOLDED_FIRST_LIMIT ) this.fail( `${where}: folded child ${a}+${c} is no leaf` );
					this.stats.foldedLeaves ++;
					content = leaf( a, c, `${where} folded child` );

				} else if ( ref >= BVH_MAX_INDEX ) {

					this.fail( `${where}: child ${ref.toString( 16 )} is neither a node nor, here, a folded leaf` );
					continue;

				} else content = visit( ref, n );

				this.checkSlot( slotBox( this.f, o, side ), content, `${where} side ${side}` );
				unionInto( box, content );

			}

			return box;

		};

		const extent = visit( root, - 1 );
		let missing = 0, twice = 0;
		for ( let i = 0; i < count; i ++ ) {

			if ( seen[ i ] === 0 ) missing ++;
			else if ( seen[ i ] > 1 ) twice ++;

		}

		if ( missing || twice ) this.fail( `${label}: ${missing} triangles never reached, ${twice} reached more than once` );
		this.blasExtent.set( root, extent );
		return extent;

	}

	countUnreached( lo, hi ) {

		for ( let n = lo; n < hi; n ++ ) if ( ! this.visited[ n ] ) this.stats.unreached ++;

	}

	scene( table ) {

		const { tlasNodeCount, groupNodeStart, groupNodeCount, blasBase } = table;
		const treeEnd = table.treeNodeCount;
		if ( blasBase !== tlasNodeCount + groupNodeCount || groupNodeStart !== tlasNodeCount ) this.fail( `layout: blasBase ${blasBase} is not TLAS ${tlasNodeCount} + groups ${groupNodeCount}` );
		if ( this.nodeCount < table.totalNodeCount ) this.fail( `layout: ${this.nodeCount} nodes, the table needs ${table.totalNodeCount}` );
		if ( this.nodeCount >= BVH_MAX_INDEX ) this.fail( 'layout: node count reaches BVH_MAX_INDEX' );

		const owners = [];
		for ( let t = 0; t < table.templateCount; t ++ ) {

			const owner = table.tplOwner[ t ];
			if ( owner < 0 ) continue;
			if ( table.sourceMesh[ owner ] === t ) owners.push( t );
			else if ( table.tplBlasOffset[ t ] !== table.tplBlasOffset[ table.sourceMesh[ owner ] ] ) this.fail( `template ${t}: aliases a BLAS it does not point at` );

		}

		let at = blasBase;
		const covered = new Uint8Array( this.triCount );
		this.rootTemplate = new Map();
		for ( const t of [ ...owners ].sort( ( a, b ) => table.tplBlasOffset[ a ] - table.tplBlasOffset[ b ] ) ) {

			const off = table.tplBlasOffset[ t ];
			if ( off < at ) this.fail( `template ${t}: BLAS at ${off} overlaps what ends at ${at}` );
			at = off + table.tplNodeCount[ t ];
			const first = table.tplTriOffset[ t ], count = table.tplTriCount[ t ];
			for ( let i = first; i < first + count; i ++ ) if ( i < this.triCount ) covered[ i ] ++;
			this.rootTemplate.set( off, t );
			this.blas( off, off, off + table.tplNodeCount[ t ], first, count, `BLAS ${t}` );

		}

		if ( at > treeEnd ) this.fail( `layout: BLASes end at ${at}, past the tree's ${treeEnd}` );
		if ( covered.some( c => c !== 1 ) ) this.fail( 'triangles: owner BLAS ranges do not partition the store' );

		this.groupExtent = table.groups.map( ( g, i ) => this.groupTree( table, g, i ) );
		if ( groupNodeCount ) {

			const e = table.emptyGroupLeaf, o = e * FPN;
			this.visited[ e ] = 1;
			if ( this.u[ o + 3 ] !== TRIANGLE_LEAF || this.u[ o + 1 ] !== 0 ) this.fail( `empty leaf ${e} is not an empty triangle leaf` );

		}

		const clustered = table.clusterCount > 0;
		this.entryReach = new Uint32Array( table.entryCount );
		this.placementReach = new Uint32Array( table.count );
		if ( clustered ) {

			this.recordReach = new Uint32Array( table.entryCount );
			if ( table.recordNodeStart !== treeEnd ) this.fail( `records start at ${table.recordNodeStart}, the tree ends at ${treeEnd}` );

		}

		if ( tlasNodeCount ) this.tlasNode( table, 0, - 1, clustered );

		const once = ( counts, what, wanted = () => true ) => {

			const off = [];
			counts.forEach( ( c, i ) => wanted( i ) && c !== 1 && off.length < 5 && off.push( `${i}×${c}` ) );
			if ( off.length ) this.fail( `${what} not reached exactly once: ${off.join( ' ' )}` );

		};

		once( this.entryReach, 'TLAS entries' );
		once( this.placementReach, 'placements', p => table.isSet[ p ] );
		if ( clustered ) once( this.recordReach, 'copy records' );
		this.countUnreached( 0, treeEnd );

	}

	groupTree( table, g, gi ) {

		const lo = g.offset, hi = g.offset + g.nodes, empty = table.emptyGroupLeaf;
		const members = new Map( Array.from( g.members, t => [ table.tplBlasOffset[ t ], 0 ] ) );
		const label = `group ${gi}`;

		const visit = ( n, parent ) => {

			if ( n === empty ) return emptyBox();
			if ( members.has( n ) ) {

				members.set( n, members.get( n ) + 1 );
				return this.blasExtent.get( n ) ?? emptyBox();

			}

			const where = `${label} node ${n}`;
			if ( ! this.enter( n, parent, lo, hi, where ) ) return emptyBox();
			const o = n * FPN;
			if ( this.isLeafTag( this.u[ o + 3 ] ) ) return this.fail( `${where}: a leaf inside a group tree` ), emptyBox();

			const box = emptyBox();
			for ( let side = 0; side < 2; side ++ ) {

				const content = visit( this.u[ o + 3 + side * 4 ], n );
				this.checkSlot( slotBox( this.f, o, side ), content, `${where} side ${side}` );
				unionInto( box, content );

			}

			return box;

		};

		const shown = visit( lo, - 1 );
		const all = emptyBox();
		g.members.forEach( ( t, j ) => {

			const root = table.tplBlasOffset[ t ];
			const visible = table.tplOwner[ t ] >= 0 && table.visible[ g.starts[ j ] ] === 1;
			if ( members.get( root ) !== ( visible ? 1 : 0 ) ) this.fail( `${label}: member ${j} reached ${members.get( root )} times while ${visible ? 'shown' : 'hidden'}` );
			unionInto( all, this.blasExtent.get( root ) ?? emptyBox() );

		} );

		for ( let n = lo; n < hi; n ++ ) if ( ! this.visited[ n ] ) this.fail( `${label}: node ${n} unreached` );
		return { shown, all };

	}

	// `lo` is what a node's box must hold, `hi` what it may reach to: a group copy is boxed by its shown members or all.
	tlasNode( table, n, parent, clustered ) {

		const where = `TLAS node ${n}`;
		if ( ! this.enter( n, parent, 0, table.tlasNodeCount, where ) ) return { lo: emptyBox(), hi: emptyBox() };
		const o = n * FPN, tag = this.u[ o + 3 ];

		if ( this.isLeafTag( tag ) ) {

			const want = clustered ? CLUSTER_LEAF : BLAS_POINTER_LEAF;
			if ( tag !== want ) this.fail( `${where}: leaf tag ${tag.toString( 16 )}, expected ${want.toString( 16 )}` );
			return clustered ? this.clusterLeaf( table, n ) : this.pointerLeaf( table, n );

		}

		const lo = emptyBox(), hi = emptyBox();
		for ( let side = 0; side < 2; side ++ ) {

			const ref = this.u[ o + 3 + side * 4 ];
			if ( ref >= BVH_MAX_INDEX ) {

				this.fail( `${where}: child ${ref.toString( 16 )} is not a node` );
				continue;

			}

			const child = this.tlasNode( table, ref, n, clustered );
			this.checkSlot( slotBox( this.f, o, side ), child.lo, `${where} side ${side}`, { tight: false, upper: child.hi } );
			unionInto( lo, child.lo );
			unionInto( hi, child.hi );

		}

		return { lo, hi };

	}

	pointerLeaf( table, n ) {

		this.stats.pointerLeaves ++;
		const o = n * FPN, word = this.u[ o + 1 ], entry = word & TLAS_PLACEMENT_MASK;
		if ( entry >= table.entryCount ) return this.fail( `TLAS leaf ${n}: entry ${entry} of ${table.entryCount}` ), { lo: emptyBox(), hi: emptyBox() };

		const copy = this.copy( table, entry, this.u[ o ], this.f.subarray( o + 4, o + 16 ), ( word & TLAS_LEAF_IDENTITY ) !== 0, n, `TLAS leaf ${n}` );
		const flag = this.f[ o + 2 ];
		if ( flag !== ( copy.visible ? 1 : 0 ) ) this.fail( `TLAS leaf ${n}: visibility ${flag}, entry ${entry} is ${copy.visible ? 'shown' : 'hidden'}` );
		return copy;

	}

	clusterLeaf( table, n ) {

		this.stats.clusterLeaves ++;
		const o = n * FPN, head = this.u[ o ];
		const first = head & CLUSTER_FIRST_MASK, count = ( ( head >>> CLUSTER_COUNT_SHIFT ) & 3 ) + 1;
		const where = `cluster leaf ${n}`;
		const lo = emptyBox(), hi = emptyBox();
		if ( first % CLUSTER_SIZE || first + count > table.entryCount ) return this.fail( `${where}: records ${first}+${count} of ${table.entryCount}` ), { lo, hi };
		if ( table.clusterLeaf[ first / CLUSTER_SIZE ] !== n ) this.fail( `${where}: the table puts cluster ${first / CLUSTER_SIZE} at ${table.clusterLeaf[ first / CLUSTER_SIZE ]}` );
		if ( n >= 1 << 28 ) this.fail( `${where}: past what a copy stack entry can name` );

		const exps = this.u[ o + 1 ];
		const base = [ this.f[ o + 2 ], this.f[ o + 4 ], this.f[ o + 5 ] ];
		const step = [ 0, 1, 2 ].map( a => 2 ** ( ( ( exps >>> ( a * 8 ) ) & 255 ) - 127 ) );
		const byte = ( slot, k ) => ( this.u[ o + slot ] >>> ( k * 8 ) ) & 255;

		for ( let k = 0; k < CLUSTER_SIZE; k ++ ) {

			const word = this.u[ o + 12 + k ];
			if ( k >= count ) {

				if ( word !== 0 ) this.fail( `${where}: copy word ${k} past its count` );
				continue;

			}

			const r = first + k;
			this.recordReach[ r ] ++;
			const entry = table.recordEntry[ r ];
			const lane = table.recordNodeStart * FPN + r * RECORD_VEC4 * 4;
			const copy = this.copy( table, entry, word & CLUSTER_ROOT_MASK, this.f.subarray( lane, lane + 12 ), ( word & TLAS_LEAF_IDENTITY ) !== 0, r, `${where} copy ${k}` );
			if ( ( ( word & CLUSTER_COPY_HIDDEN ) === 0 ) !== copy.visible ) this.fail( `${where} copy ${k}: hidden bit disagrees with entry ${entry}` );

			const decoded = [ 0, 1, 2 ].map( a => Math.fround( base[ a ] + byte( 6 + a, k ) * step[ a ] ) )
				.concat( [ 0, 1, 2 ].map( a => Math.fround( base[ a ] + byte( 9 + a, k ) * step[ a ] ) ) );
			if ( ! isEmpty( copy.lo ) && ! contains( decoded, copy.lo ) ) this.fail( `${where} copy ${k}: byte box ${fmt( decoded )} does not hold ${fmt( copy.lo )}` );
			unionInto( lo, copy.lo );
			unionInto( hi, copy.hi );

		}

		return { lo, hi };

	}

	copy( table, entry, root, rows, identityBit, instance, where ) {

		this.entryReach[ entry ] ++;
		const rep = table.repOf( entry );
		const g = table.groupOfEntry( entry );
		const placements = g < 0 ? [ rep ] : Array.from( table.groups[ g ].starts, s => s + rep - table.groups[ g ].starts[ 0 ] );
		let visible = false;
		for ( const p of placements ) {

			this.placementReach[ p ] ++;
			visible ||= table.visible[ p ] === 1;
			if ( table.tlasLeafIndex[ p ] !== instance ) this.fail( `${where}: placement ${p} records leaf ${table.tlasLeafIndex[ p ]}` );

		}

		let object;
		if ( g >= 0 ) {

			this.stats.groupCopies ++;
			if ( root !== table.groups[ g ].offset ) this.fail( `${where}: root ${root}, group ${g} starts at ${table.groups[ g ].offset}` );
			object = { lo: this.groupExtent[ g ].shown, hi: this.groupExtent[ g ].all };

		} else {

			const want = table.tplBlasOffset[ table.sourceMesh[ rep ] ];
			if ( root !== want || ! this.rootTemplate.has( root ) ) this.fail( `${where}: root ${root}, placement ${rep}'s BLAS is at ${want}` );
			const extent = this.blasExtent.get( root ) ?? emptyBox();
			object = { lo: extent, hi: extent };

		}

		const m = table.matrixWorldOf( rep );
		for ( const p of placements ) if ( table.matrixWorldOf( p ).some( ( v, i ) => v !== m[ i ] ) ) this.fail( `${where}: placement ${p} is not where the rest of its copy is` );
		const identity = IDENTITY.every( ( v, i ) => m[ i ] === v );
		if ( identityBit !== identity ) this.fail( `${where}: identity bit ${identityBit}, matrix ${identity ? 'is' : 'is not'} identity` );
		if ( identity ) this.stats.identityCopies ++;
		if ( ! visible ) this.stats.hiddenCopies ++;

		for ( let i = 0; i < 3; i ++ ) for ( let j = 0; j < 4; j ++ ) {

			let sum = 0, size = 0;
			for ( let k = 0; k < 4; k ++ ) {

				const term = rows[ i * 4 + k ] * m[ j * 4 + k ];
				sum += term;
				size += Math.abs( term );

			}

			if ( Math.abs( sum - ( i === j ? 1 : 0 ) ) > 1e-5 * ( 1 + size ) ) return this.fail( `${where}: world-to-object rows do not invert placement ${rep}'s matrix` ), { lo: emptyBox(), hi: emptyBox(), visible };

		}

		return { lo: transformBox( object.lo, m ), hi: transformBox( object.hi, m ), visible };

	}

}

/** A bundled worker run on this thread: its module installs its handler on `self`, imported once by `load`. */
export function inProcessWorker( load ) {

	let loaded = null;
	const ready = () => loaded ??= ( async () => {

		const scope = globalThis.self = {};
		await load();
		return scope.onmessage;

	} )();

	return class {

		postMessage( data ) {

			ready().then( fn => {

				globalThis.self = { postMessage: reply => this.onmessage?.( { data: reply } ) };
				fn( { data } );

			} );

		}

		terminate() {}

	};

}
