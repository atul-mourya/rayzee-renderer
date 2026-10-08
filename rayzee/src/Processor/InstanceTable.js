/**
 * InstanceTable — per-placement transforms plus per-template BLAS metadata for the two-level BVH.
 *
 * Columns, not objects, and the per-template half is stored once rather than once per placement:
 * millions of placements still share a few thousand geometries, so triangle ranges, node counts
 * and object-space bounds live on the template. `sourceMesh` doubles as the template id.
 *
 * 75 bytes a placement, against 418 for the array-of-objects version and 211 for the flat but
 * denormalised one. World bounds and the inverse transform are derived on demand.
 */

import {
	TRIANGLE_DATA_LAYOUT, BVH_LEAF_MARKERS, BVH_EMPTY_BOX, assertBVHIndexFits, bvhIndexView,
	CLUSTER_SIZE, CLUSTER_FIRST_MASK, CLUSTER_COUNT_SHIFT, CLUSTER_COPY_HIDDEN, RECORD_VEC4, TLAS_LEAF_IDENTITY,
	encodeClusterBoxes as encodeClusterBoxBytes,
} from './BufferLayout.js';

const IDENTITY = Float64Array.from( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

/** Passed as a placement's matrix when its row already holds it (a pooled build). */
export const IN_PLACE = Object.freeze( [] );

/** Determinant of the upper-left 3x3 at `off`. Negative means the transform mirrors. */
export function determinant3At( m, off ) {

	return m[ off ] * ( m[ off + 5 ] * m[ off + 10 ] - m[ off + 6 ] * m[ off + 9 ] )
		- m[ off + 4 ] * ( m[ off + 1 ] * m[ off + 10 ] - m[ off + 2 ] * m[ off + 9 ] )
		+ m[ off + 8 ] * ( m[ off + 1 ] * m[ off + 6 ] - m[ off + 2 ] * m[ off + 5 ] );

}

/** Writes the inverse of the affine column-major 4x4 at `off` into `out`. */
export function invertAffineInto( m, off, out ) {

	const det = determinant3At( m, off );
	if ( ! Number.isFinite( det ) || Math.abs( det ) < 1e-20 ) {

		out.set( IDENTITY );
		return out;

	}

	const s = 1 / det;

	out[ 0 ] = ( m[ off + 5 ] * m[ off + 10 ] - m[ off + 6 ] * m[ off + 9 ] ) * s;
	out[ 1 ] = ( m[ off + 2 ] * m[ off + 9 ] - m[ off + 1 ] * m[ off + 10 ] ) * s;
	out[ 2 ] = ( m[ off + 1 ] * m[ off + 6 ] - m[ off + 2 ] * m[ off + 5 ] ) * s;
	out[ 3 ] = 0;
	out[ 4 ] = ( m[ off + 6 ] * m[ off + 8 ] - m[ off + 4 ] * m[ off + 10 ] ) * s;
	out[ 5 ] = ( m[ off ] * m[ off + 10 ] - m[ off + 2 ] * m[ off + 8 ] ) * s;
	out[ 6 ] = ( m[ off + 2 ] * m[ off + 4 ] - m[ off ] * m[ off + 6 ] ) * s;
	out[ 7 ] = 0;
	out[ 8 ] = ( m[ off + 4 ] * m[ off + 9 ] - m[ off + 5 ] * m[ off + 8 ] ) * s;
	out[ 9 ] = ( m[ off + 1 ] * m[ off + 8 ] - m[ off ] * m[ off + 9 ] ) * s;
	out[ 10 ] = ( m[ off ] * m[ off + 5 ] - m[ off + 1 ] * m[ off + 4 ] ) * s;
	out[ 11 ] = 0;

	out[ 12 ] = - ( out[ 0 ] * m[ off + 12 ] + out[ 4 ] * m[ off + 13 ] + out[ 8 ] * m[ off + 14 ] );
	out[ 13 ] = - ( out[ 1 ] * m[ off + 12 ] + out[ 5 ] * m[ off + 13 ] + out[ 9 ] * m[ off + 14 ] );
	out[ 14 ] = - ( out[ 2 ] * m[ off + 12 ] + out[ 6 ] * m[ off + 13 ] + out[ 10 ] * m[ off + 14 ] );
	out[ 15 ] = 1;
	return out;

}

/** `out = a * b`, column-major affine 4x4s; `b` is read at `bOff`. Matches how the extractor
 *  composes an InstancedMesh's host matrix with each instance matrix. */
export function multiplyAffine( a, b, bOff, out ) {

	for ( let c = 0; c < 4; c ++ ) {

		const o = bOff + c * 4;
		const b0 = b[ o ], b1 = b[ o + 1 ], b2 = b[ o + 2 ], b3 = b[ o + 3 ];

		for ( let r = 0; r < 4; r ++ ) {

			out[ c * 4 + r ] = a[ r ] * b0 + a[ 4 + r ] * b1 + a[ 8 + r ] * b2 + a[ 12 + r ] * b3;

		}

	}

	return out;

}

/** True when the matrix leaves points untouched — lets refit skip the transform entirely. */
export function isIdentity( m ) {

	for ( let i = 0; i < 16; i ++ ) if ( m[ i ] !== IDENTITY[ i ] ) return false;
	return true;

}

/** Axis-aligned bounds of an AABB carried through an affine transform (all 8 corners). */
export function transformAABB( aabb, m ) {

	if ( ! aabb ) return aabb;

	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let c = 0; c < 8; c ++ ) {

		const x = c & 1 ? aabb.maxX : aabb.minX;
		const y = c & 2 ? aabb.maxY : aabb.minY;
		const z = c & 4 ? aabb.maxZ : aabb.minZ;

		const wx = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
		const wy = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
		const wz = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];

		if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
		if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
		if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

	}

	return { minX, minY, minZ, maxX, maxY, maxZ };

}

/** Writes an AABB carried through an affine transform into `dst` at `dstOff`. */
export function transformAABBInto( src, srcOff, m, mOff, dst, dstOff ) {

	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let c = 0; c < 8; c ++ ) {

		const x = src[ srcOff + ( c & 1 ? 3 : 0 ) ];
		const y = src[ srcOff + ( c & 2 ? 4 : 1 ) ];
		const z = src[ srcOff + ( c & 4 ? 5 : 2 ) ];

		const wx = m[ mOff ] * x + m[ mOff + 4 ] * y + m[ mOff + 8 ] * z + m[ mOff + 12 ];
		const wy = m[ mOff + 1 ] * x + m[ mOff + 5 ] * y + m[ mOff + 9 ] * z + m[ mOff + 13 ];
		const wz = m[ mOff + 2 ] * x + m[ mOff + 6 ] * y + m[ mOff + 10 ] * z + m[ mOff + 14 ];

		if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
		if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
		if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

	}

	dst[ dstOff ] = minX; dst[ dstOff + 1 ] = minY; dst[ dstOff + 2 ] = minZ;
	dst[ dstOff + 3 ] = maxX; dst[ dstOff + 4 ] = maxY; dst[ dstOff + 5 ] = maxZ;

}

/** True when the 16 floats at `off` leave points untouched — lets refit skip the transform. */
export function isIdentityAt( m, off ) {

	for ( let i = 0; i < 16; i ++ ) if ( m[ off + i ] !== IDENTITY[ i ] ) return false;
	return true;

}

export class InstanceTable {

	constructor() {

		this.count = 0;
		this.templateCount = 0;
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;
		this.allocate( 0 );

	}

	/**
	 * Pre-allocate the columns. Must be called before setEntry().
	 *
	 * @param {number} count - placements
	 * @param {number} [templateCount] - distinct source meshes; defaults to one per placement
	 * @param {Float32Array|MatrixRuns} [worldPool] - the transforms, adopted rather than copied: one array of a row a
	 *   placement, or runs of rows (GeometryExtractor) reading an InstancedMesh's own matrix list where it already is
	 * @param {Int32Array} [sourcePool] - likewise for the source-mesh column
	 */
	allocate( count, templateCount = count, worldPool = null, sourcePool = null ) {

		this.count = count;
		this.templateCount = templateCount;

		this.isSet = new Uint8Array( count );
		// Object3D this placement came from, and the template index for everything below.
		this.sourceMesh = sourcePool && sourcePool.length >= count ? sourcePool : new Int32Array( count );
		this.tlasLeafIndex = new Int32Array( count ).fill( - 1 ); // set by TLASBuilder
		this.visible = new Uint8Array( count ).fill( 1 ); // baked into TLAS leaf slot [2]
		// A mirroring transform reverses triangle winding, so front and back swap in object
		// space. Traversal needs telling, or single-sided faces cull inside out.
		this.flipWinding = new Uint8Array( count );
		// template -> inverse of the pose baked into its triangles, for templates stored in
		// world space. A move composes the new world matrix against this.
		this.tplBakeInverse = null;

		if ( worldPool?.first ) this._adoptRuns( worldPool );
		else this._adoptRuns( { first: [ 0, count ], arrays: [ worldPool && worldPool.length >= count * 16 ? worldPool : new Float32Array( count * 16 ) ], arrayOf: [ 0 ], base: [ 0 ], owned: [ worldPool ? 0 : 1 ] } );

		this.tplTriOffset = new Int32Array( templateCount );
		this.tplTriCount = new Int32Array( templateCount );
		this.tplExpandedStart = new Int32Array( templateCount );
		this.tplNodeCount = new Int32Array( templateCount );
		this.tplBlasOffset = new Int32Array( templateCount );
		this.tplOwner = new Int32Array( templateCount ).fill( - 1 ); // placement that built the BLAS
		this.tplObjectAABB = new Float32Array( templateCount * 6 );

		this._placementRuns = null;

		// TLAS entries: one a placement, or one a copy of a group — instanced meshes placed by one shared matrix list,
		// traced as one object through a small tree over their BLASes. Null maps are the identity.
		this.groups = [];
		this.groupOfTemplate = null;
		this.memberSlot = null;
		this.entryCount = count;
		this.entryRep = null;
		this.entryGroup = null;
		this.placementEntry = null;
		this.groupNodeStart = 0;
		this.groupNodeCount = 0;

		// Copy clusters (planClusters / formClusters): the TLAS is built over clusters of entries, and each entry's
		// transform is a record behind the BLASes. Cluster c owns records clusterStart[c] .. clusterStart[c + 1] − 1.
		this.clusterCount = 0;
		this.clusterStart = null;
		this.recordEntry = null;
		this.recordCluster = null;
		this.clusterLeaf = null;
		this.recordNodeStart = 0;
		this.recordNodeCount = 0;

		// Keyed by template, and only templates that own a BLAS carry them.
		this.originalToBvhMap = new Map();
		this.bvhToOriginal = new Map();
		this.blasData = new Map();

	}

	/** Writes the placement half of an entry. @private */
	_place( index, template, matrixWorld, matrixOffset ) {

		this.isSet[ index ] = 1;
		this.sourceMesh[ index ] = template;

		if ( matrixWorld !== IN_PLACE ) this._writeRow( index, matrixWorld ?? IDENTITY, matrixWorld ? matrixOffset : 0 );
		const o = this.matrixRow( index );
		this.flipWinding[ index ] = determinant3At( this.rowArray, o ) < 0 ? 1 : 0;

	}

	/**
	 * Set a placement whose BLAS has just been built. Template metadata (triangle range, node
	 * count, reorder map) is recorded once against `sourceMesh`, not once per placement.
	 *
	 * @param {Object} params
	 * @param {number} params.meshIndex - Placement slot
	 * @param {number} params.blasNodeCount - Number of BVH nodes in this BLAS
	 * @param {number} params.triOffset - Triangle index offset in global triangleData
	 * @param {number} params.triCount - Number of triangles for this mesh
	 * @param {Uint32Array} params.originalToBvhMap - Per-BLAS triangle reorder map
	 * @param {Float32Array} params.bvhData - Raw BLAS BVH data (local indices, before assembly)
	 * @param {ArrayLike<number>} [params.matrixWorld] - object-to-world, column-major 16
	 * @param {number} [params.matrixOffset] - element offset into `matrixWorld`
	 */
	setEntry( { meshIndex, blasNodeCount, triOffset, triCount, originalToBvhMap, bvhData, matrixWorld = null, matrixOffset = 0, expandedStart = null, sourceMesh = null } ) {

		const t = sourceMesh ?? meshIndex;

		this._place( meshIndex, t, matrixWorld, matrixOffset );

		this.tplTriOffset[ t ] = triOffset;
		this.tplTriCount[ t ] = triCount;
		this.tplExpandedStart[ t ] = expandedStart ?? triOffset;
		this.tplNodeCount[ t ] = blasNodeCount;
		this.tplOwner[ t ] = meshIndex;

		if ( originalToBvhMap ) this.originalToBvhMap.set( t, originalToBvhMap );
		if ( bvhData ) this.blasData.set( t, bvhData );

	}

	/**
	 * Register a placement that reuses `ownerIndex`'s triangles and BLAS. Only the transform
	 * differs, so its template borrows the owner's node range and object-space bounds.
	 *
	 * @param {number} meshIndex
	 * @param {number} ownerIndex
	 * @param {ArrayLike<number>} [matrixWorld]
	 */
	setAlias( meshIndex, ownerIndex, matrixWorld = null, expandedStart = null, sourceMesh = null, matrixOffset = 0 ) {

		if ( ! this.isSet[ ownerIndex ] ) throw new Error( `InstanceTable.setAlias: owner ${ownerIndex} not built` );

		const t = sourceMesh ?? meshIndex;
		const ot = this.sourceMesh[ ownerIndex ];

		this._place( meshIndex, t, matrixWorld, matrixOffset );

		if ( t === ot ) return; // same template as the owner: nothing to mirror

		this.tplTriOffset[ t ] = this.tplTriOffset[ ot ];
		this.tplTriCount[ t ] = this.tplTriCount[ ot ];
		this.tplNodeCount[ t ] = this.tplNodeCount[ ot ];
		this.tplExpandedStart[ t ] = expandedStart ?? this.tplExpandedStart[ ot ];
		this.tplOwner[ t ] = this.tplOwner[ ot ];

	}

	/**
	 * Groups instanced meshes placed by one shared matrix list: each copy becomes one TLAS entry, whose subtree is a
	 * small tree over the members' BLAS roots in the copies' shared object space. Every member keeps its placements
	 * (transforms, visibility, refit stay per mesh); only the TLAS sees one entry where it saw one per member.
	 *
	 * @param {Array<{members: ArrayLike<number>, starts: ArrayLike<number>, count: number}>} groups - members are
	 *   templates, `starts` the first placement of each, all `count` long
	 */
	setGroups( groups ) {

		this.groups = [];
		this.groupOfTemplate = null;
		this.memberSlot = null;
		this.entryCount = this.count;
		this.entryRep = null;
		this.entryGroup = null;
		this.placementEntry = null;
		this.groupNodeCount = 0;

		const valid = ( groups ?? [] ).filter( g => g.members.length >= 2 && Array.from( g.starts ).every( s => s >= 0 && s + g.count <= this.count ) );
		if ( valid.length === 0 ) return;

		const ofTemplate = new Int32Array( this.templateCount ).fill( - 1 );
		const slot = new Int32Array( this.templateCount );
		let nodes = 1; // the empty leaf a hidden member points at

		for ( const g of valid ) {

			const id = this.groups.length;
			const members = Int32Array.from( g.members );
			this.groups.push( { members, starts: Int32Array.from( g.starts ), count: g.count, offset: - 1, nodes: members.length - 1, aabb: new Float32Array( 6 ) } );
			for ( let j = 0; j < members.length; j ++ ) {

				ofTemplate[ members[ j ] ] = id;
				slot[ members[ j ] ] = j;

			}

			nodes += members.length - 1;

		}

		const n = this.count, src = this.sourceMesh;
		const entryOf = new Int32Array( n );
		let entries = 0;
		for ( let p = 0; p < n; p ++ ) {

			const t = src[ p ];
			if ( ofTemplate[ t ] < 0 || slot[ t ] === 0 ) entryOf[ p ] = entries ++;

		}

		const rep = new Int32Array( entries );
		const group = new Int32Array( entries ).fill( - 1 );
		for ( let p = 0; p < n; p ++ ) {

			const t = src[ p ];
			const g = ofTemplate[ t ];
			if ( g >= 0 && slot[ t ] !== 0 ) continue;
			rep[ entryOf[ p ] ] = p;
			if ( g >= 0 ) group[ entryOf[ p ] ] = g;

		}

		for ( const g of this.groups ) {

			const first = g.starts[ 0 ];
			for ( let j = 1; j < g.members.length; j ++ ) entryOf.set( entryOf.subarray( first, first + g.count ), g.starts[ j ] );

		}

		this.groupOfTemplate = ofTemplate;
		this.memberSlot = slot;
		this.entryCount = entries;
		this.entryRep = rep;
		this.entryGroup = group;
		this.placementEntry = entryOf;
		this.groupNodeCount = nodes;

	}

	/** The placement whose transform an entry's TLAS leaf carries. */
	repOf( entry ) {

		return this.entryRep ? this.entryRep[ entry ] : entry;

	}

	/** The TLAS entry a placement is traced through. */
	entryOf( placement ) {

		return this.placementEntry ? this.placementEntry[ placement ] : placement;

	}

	/** Group of an entry, or -1. */
	groupOfEntry( entry ) {

		return this.entryGroup ? this.entryGroup[ entry ] : - 1;

	}

	/** The node an entry's leaf points at: its template's BLAS root, or its group's tree. */
	entryRoot( entry ) {

		const g = this.groupOfEntry( entry );
		return g >= 0 ? this.groups[ g ].offset : this.tplBlasOffset[ this.sourceMesh[ this.repOf( entry ) ] ];

	}

	/** An entry is visible while any member placement of it is. */
	entryVisible( entry ) {

		const g = this.groupOfEntry( entry );
		if ( g < 0 ) return this.visible[ this.repOf( entry ) ] === 1;
		const { starts } = this.groups[ g ];
		const copy = this.repOf( entry ) - starts[ 0 ];
		for ( let j = 0; j < starts.length; j ++ ) if ( this.visible[ starts[ j ] + copy ] ) return true;
		return false;

	}

	/** Records `node` as the TLAS leaf of every placement traced through `entry`. */
	setLeafOf( entry, node ) {

		const g = this.groupOfEntry( entry );
		const p = this.repOf( entry );
		if ( g < 0 ) {

			this.tlasLeafIndex[ p ] = node;
			return;

		}

		const { starts } = this.groups[ g ];
		const copy = p - starts[ 0 ];
		for ( let j = 0; j < starts.length; j ++ ) this.tlasLeafIndex[ starts[ j ] + copy ] = node;

	}

	/** Each group's object-space bounds: every member's, hidden or not, so a toggle never moves the TLAS. */
	computeGroupAABBs() {

		for ( const g of this.groups ) {

			const box = g.aabb;
			box.fill( Infinity, 0, 3 );
			box.fill( - Infinity, 3, 6 );
			for ( const t of g.members ) {

				if ( this.tplOwner[ t ] < 0 ) continue;
				const o = t * 6;
				for ( let a = 0; a < 3; a ++ ) {

					box[ a ] = Math.min( box[ a ], this.tplObjectAABB[ o + a ] );
					box[ 3 + a ] = Math.max( box[ 3 + a ], this.tplObjectAABB[ o + 3 + a ] );

				}

			}

			if ( box[ 0 ] > box[ 3 ] ) box.fill( 0 );

		}

	}

	/** The empty leaf a hidden group member points at: the group region's last node. */
	get emptyGroupLeaf() {

		return this.groupNodeStart + this.groupNodeCount - 1;

	}

	/**
	 * The group region's nodes, from the members' bounds, BLAS offsets and visibility: each group's tree, then the
	 * empty leaf a hidden member points at. Pre-order, so a parent precedes its children, as refit expects.
	 * @returns {Float32Array} groupNodeCount nodes of 16 floats, for node groupNodeStart on
	 */
	groupNodeBlock() {

		const block = new Float32Array( this.groupNodeCount * 16 );
		if ( ! this.groups.length ) return block;

		const idx = new Uint32Array( block.buffer );
		idx[ ( this.groupNodeCount - 1 ) * 16 + 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
		for ( const g of this.groups ) this._writeGroupTree( g, block, idx );
		return block;

	}

	/** @private */
	_writeGroupTree( g, block, idx ) {

		const base = this.groupNodeStart;
		const empty = this.emptyGroupLeaf;
		const aabb = this.tplObjectAABB;
		let next = g.offset;

		const child = ( list ) => {

			if ( list.length === 1 ) {

				const j = list[ 0 ];
				const t = g.members[ j ];
				const shown = this.tplOwner[ t ] >= 0 && this.visible[ g.starts[ j ] ] === 1;
				return shown ? { ref: this.tplBlasOffset[ t ], box: aabb.subarray( t * 6, t * 6 + 6 ) } : { ref: empty, box: null };

			}

			const node = next ++;
			const [ left, right ] = splitMembers( list, g.members, aabb );
			const a = child( left );
			const b = child( right );
			const o = ( node - base ) * 16;
			writeChildBox( block, o, a.box );
			writeChildBox( block, o + 8, b.box );
			idx[ o + 3 ] = a.ref;
			idx[ o + 7 ] = b.ref;
			return { ref: node, box: unionBoxes( a.box, b.box ) };

		};

		child( Array.from( g.members, ( _, j ) => j ) );

	}

	/**
	 * Plans copy clusters: ⌈entries / CLUSTER_SIZE⌉ of them. Only how many, which is fixed before any bounds exist (the
	 * BVH layout and the BLAS cache need it then); formClusters picks the members.
	 */
	planClusters() {

		this.clusterCount = Math.ceil( this.entryCount / CLUSTER_SIZE );
		this.recordNodeCount = Math.ceil( this.entryCount * RECORD_VEC4 / 4 );
		if ( this.entryCount >= CLUSTER_FIRST_MASK ) throw new RangeError( `${this.entryCount.toLocaleString()} copies is past what a copy cluster can address` );

	}

	/**
	 * Picks each cluster's members: the entries halved at the centre median of their widest axis until runs of
	 * CLUSTER_SIZE remain, so a cluster holds near neighbours, whatever each draws. Records follow cluster order.
	 * @param {Float32Array} world - each entry's world bounds, entryCount × 6
	 * @returns {Float64Array} each cluster's world bounds, clusterCount × 6, what the TLAS sorts on
	 */
	formClusters( world ) {

		const n = this.entryCount;
		const sorted = new Int32Array( n );
		for ( let e = 0; e < n; e ++ ) sorted[ e ] = e;
		splitIntoRuns( sorted, 0, n, world );

		const clusterStart = new Int32Array( this.clusterCount + 1 );
		const recordCluster = new Int32Array( n );
		const bounds = new Float64Array( this.clusterCount * 6 );
		for ( let c = 0; c < this.clusterCount; c ++ ) {

			const r0 = c * CLUSTER_SIZE, end = Math.min( r0 + CLUSTER_SIZE, n );
			clusterStart[ c ] = r0;
			const b = c * 6;
			bounds[ b ] = bounds[ b + 1 ] = bounds[ b + 2 ] = Infinity;
			bounds[ b + 3 ] = bounds[ b + 4 ] = bounds[ b + 5 ] = - Infinity;
			for ( let r = r0; r < end; r ++ ) {

				recordCluster[ r ] = c;
				const o = sorted[ r ] * 6;
				for ( let a = 0; a < 3; a ++ ) {

					if ( world[ o + a ] < bounds[ b + a ] ) bounds[ b + a ] = world[ o + a ];
					if ( world[ o + 3 + a ] > bounds[ b + 3 + a ] ) bounds[ b + 3 + a ] = world[ o + 3 + a ];

				}

			}

		}

		clusterStart[ this.clusterCount ] = n;
		this.clusterStart = clusterStart;
		this.recordEntry = sorted;
		this.recordCluster = recordCluster;
		this.clusterLeaf = new Int32Array( this.clusterCount ).fill( - 1 );
		return bounds;

	}

	/**
	 * Writes cluster `c`'s TLAS leaf at float offset `o` of `data` (node `node`), its copies' boxes from `world`, and
	 * makes each copy's record its placements' instance id (`tlasLeafIndex`).
	 */
	writeClusterLeaf( data, idx, o, c, world, node ) {

		const first = this.clusterStart[ c ], count = this.clusterStart[ c + 1 ] - first;
		idx[ o ] = ( first | ( count - 1 ) << CLUSTER_COUNT_SHIFT ) >>> 0;
		idx[ o + 3 ] = BVH_LEAF_MARKERS.CLUSTER_LEAF;
		for ( let k = 0; k < CLUSTER_SIZE; k ++ ) idx[ o + 12 + k ] = k < count ? this.copyWord( this.recordEntry[ first + k ] ) : 0;
		this.encodeClusterBoxes( data, idx, o, c, world );
		this.clusterLeaf[ c ] = node;
		for ( let r = first; r < first + count; r ++ ) this.setLeafOf( this.recordEntry[ r ], r );

	}

	/** A cluster leaf's word for `entry` (BufferLayout): its root, whether its transform is identity, and hidden. */
	copyWord( entry ) {

		const o = this.matrixRow( this.repOf( entry ) );
		const identity = isIdentityAt( this.rowArray, o ) ? TLAS_LEAF_IDENTITY : 0;
		return ( this.entryRoot( entry ) | identity | ( this.entryVisible( entry ) ? 0 : CLUSTER_COPY_HIDDEN ) ) >>> 0;

	}

	/**
	 * Cluster `c`'s boxes into its leaf at `o` (BufferLayout `encodeClusterBoxes`): each copy's world box from `world`
	 * (entry-indexed, at build) or, without it, from its transform now. The union goes to `out` at `outOff`.
	 */
	encodeClusterBoxes( data, idx, o, c, world = null, out = null, outOff = 0 ) {

		const first = this.clusterStart[ c ], count = this.clusterStart[ c + 1 ] - first;
		const boxes = _copyBoxes;
		for ( let k = 0; k < count; k ++ ) {

			const e = this.recordEntry[ first + k ];
			if ( world ) for ( let i = 0; i < 6; i ++ ) boxes[ k * 6 + i ] = world[ e * 6 + i ];
			else this.writeEntryWorldAABB( e, boxes, k * 6 );

		}

		encodeClusterBoxBytes( data, idx, o, boxes, count, out, outOff );

	}

	/** A copy record: placement `p`'s world-to-object rows, laid out as a leaf's slots 4–15, at `off` of `out`. */
	writeRecord( out, off, p ) {

		const inv = _recordInverse;
		const o = this.matrixRow( p );
		invertAffineInto( this.rowArray, o, inv );
		out[ off ] = inv[ 0 ]; out[ off + 1 ] = inv[ 4 ]; out[ off + 2 ] = inv[ 8 ]; out[ off + 3 ] = inv[ 12 ];
		out[ off + 4 ] = inv[ 1 ]; out[ off + 5 ] = inv[ 5 ]; out[ off + 6 ] = inv[ 9 ]; out[ off + 7 ] = inv[ 13 ];
		out[ off + 8 ] = inv[ 2 ]; out[ off + 9 ] = inv[ 6 ]; out[ off + 10 ] = inv[ 10 ]; out[ off + 11 ] = inv[ 14 ];

	}

	/** The TLAS leaf holding placement `p`: its cluster's when clustered. */
	leafOfPlacement( p ) {

		const id = this.tlasLeafIndex[ p ];
		return id < 0 || ! this.clusterCount ? id : this.clusterLeaf[ this.recordCluster[ id ] ];

	}

	/** The slot of record `r`'s word in its cluster leaf (`copyWord`). */
	copyWordSlot( r ) {

		return 12 + r - this.clusterStart[ this.recordCluster[ r ] ];

	}

	/** Placements actually built. */
	get setCount() {

		let n = 0;
		for ( let i = 0; i < this.count; i ++ ) n += this.isSet[ i ];
		return n;

	}

	/**
	 * Placement transforms are runs of rows: run r covers placements first[ r ] … first[ r + 1 ] − 1, whose 16 floats
	 * each follow from base[ r ] in arrays[ arrayOf[ r ] ]. An adopted array (an InstancedMesh's matrix list) is never
	 * written: the first write to its run copies the run into an array of the table's own.
	 * @private
	 */
	_adoptRuns( { first, arrays, arrayOf, base, owned } ) {

		this._runFirst = Int32Array.from( first );
		this._runArrays = arrays.slice();
		this._runArray = Int32Array.from( arrayOf );
		this._runBase = Float64Array.from( base );
		this._runOwned = Uint8Array.from( owned );
		this._lastRun = 0;
		this.rowArray = this._runArrays[ 0 ] ?? null;

	}

	/** The run holding placement `p`. @private */
	_runOf( p ) {

		const first = this._runFirst;
		let r = this._lastRun;
		if ( p >= first[ r ] && p < first[ r + 1 ] ) return r;
		let lo = 0, hi = first.length - 2;
		while ( lo < hi ) {

			const mid = ( lo + hi + 1 ) >> 1;
			if ( first[ mid ] <= p ) lo = mid;
			else hi = mid - 1;

		}

		r = this._lastRun = lo;
		return r;

	}

	/** Where placement `p`'s 16 object-to-world floats start in `this.rowArray`, which this sets. */
	matrixRow( p ) {

		const r = this._runOf( p );
		this.rowArray = this._runArrays[ this._runArray[ r ] ];
		return this._runBase[ r ] + ( p - this._runFirst[ r ] ) * 16;

	}

	/** The transform array when a single run of the table's own holds every placement, else null. */
	get world() {

		return this._runFirst.length === 2 && this._runBase[ 0 ] === 0 ? this._runArrays[ this._runArray[ 0 ] ] : null;

	}

	/** Bytes of transforms the table holds itself, not counting the matrix lists it reads in place. */
	get matrixBytes() {

		const own = new Set();
		for ( let r = 0; r < this._runArray.length; r ++ ) if ( this._runOwned[ r ] ) own.add( this._runArrays[ this._runArray[ r ] ] );
		let bytes = 0;
		for ( const a of own ) bytes += a.byteLength;
		return bytes;

	}

	/** @private */
	_writeRow( p, m, mo ) {

		const r = this._runOf( p );
		if ( ! this._runOwned[ r ] ) {

			const start = this._runBase[ r ], end = start + ( this._runFirst[ r + 1 ] - this._runFirst[ r ] ) * 16;
			this._runArrays.push( this._runArrays[ this._runArray[ r ] ].slice( start, end ) );
			this._runArray[ r ] = this._runArrays.length - 1;
			this._runBase[ r ] = 0;
			this._runOwned[ r ] = 1;

		}

		const o = this.matrixRow( p ), w = this.rowArray;
		for ( let k = 0; k < 16; k ++ ) w[ o + k ] = m[ mo + k ];

	}

	/**
	 * Replace one placement's object-to-world transform. Its geometry is untouched, which is the
	 * whole point: a rigid move is a matrix change, and rewriting shared triangles instead would
	 * drag every other placement of the same geometry along with it.
	 */
	setPlacementMatrix( index, matrixWorld, matrixOffset = 0 ) {

		this._place( index, this.sourceMesh[ index ], matrixWorld, matrixOffset );

	}

	/**
	 * The contiguous run of placements recorded for `meshIndex`, or null. One object contributes
	 * one placement, or one per instance for an InstancedMesh, and the extractor emits them in
	 * mesh order — so the run is contiguous and worth indexing once rather than scanning per move.
	 *
	 * @returns {{start: number, count: number}|null}
	 */
	placementRunOf( meshIndex ) {

		if ( ! this._placementRuns ) {

			const runs = this._placementRuns = new Map();
			for ( let i = 0; i < this.count; i ++ ) {

				const m = this.sourceMesh[ i ];
				const run = runs.get( m );
				if ( run ) run.count ++;
				else runs.set( m, { start: i, count: 1 } );

			}

		}

		return this._placementRuns.get( meshIndex ) ?? null;

	}

	/** True when this placement is the one whose BLAS the others alias. */
	isOwner( index ) {

		return this.tplOwner[ this.sourceMesh[ index ] ] === index;

	}

	triOffsetOf( index ) {

		return this.tplTriOffset[ this.sourceMesh[ index ] ];

	}

	triCountOf( index ) {

		return this.tplTriCount[ this.sourceMesh[ index ] ];

	}

	expandedStartOf( index ) {

		return this.tplExpandedStart[ this.sourceMesh[ index ] ];

	}

	blasOffsetOf( index ) {

		return this.tplBlasOffset[ this.sourceMesh[ index ] ];

	}

	blasNodeCountOf( index ) {

		return this.tplNodeCount[ this.sourceMesh[ index ] ];

	}

	/** Record a rebuilt BLAS's node count. May shrink; never past what the build allocated. */
	setBlasNodeCount( index, nodeCount ) {

		this.tplNodeCount[ this.sourceMesh[ index ] ] = nodeCount;

	}

	/** Record the stored-order to caller-order map for a rebuilt BLAS. */
	setBvhToOriginal( index, map ) {

		this.bvhToOriginal.set( this.sourceMesh[ index ], map );

	}

	/**
	 * The per-BLAS triangle reorder map this placement traverses through. A placement that
	 * borrows another's BLAS borrows its map too — only the owner's template carries one.
	 */
	bvhToOriginalOf( index ) {

		const t = this.sourceMesh[ index ];
		const own = this.bvhToOriginal.get( t );
		if ( own ) return own;

		const owner = this.tplOwner[ t ];
		return ( owner >= 0 ? this.bvhToOriginal.get( this.sourceMesh[ owner ] ) : null ) || null;

	}

	/** A view of the 16 object-to-world floats for `index`. Cold paths only. */
	matrixWorldOf( index ) {

		const o = this.matrixRow( index );
		return this.rowArray.subarray( o, o + 16 );

	}

	/**
	 * The 16 world-to-object floats for `index`, inverted on demand. Allocates — per-mesh work
	 * only; the TLAS build inverts into its own scratch.
	 */
	matrixInverseOf( index ) {

		const o = this.matrixRow( index );
		return invertAffineInto( this.rowArray, o, new Float64Array( 16 ) );

	}

	/** Writes this placement's world-space bounds into `out` at `off`. */
	writeWorldAABB( index, out, off ) {

		if ( ! this.isSet[ index ] ) {

			for ( let k = 0; k < 6; k ++ ) out[ off + k ] = 0;
			return;

		}

		const o = this.matrixRow( index );
		transformAABBInto( this.tplObjectAABB, this.sourceMesh[ index ] * 6, this.rowArray, o, out, off );

	}

	/** Writes a TLAS entry's world-space bounds — its group's, for a group copy — into `out` at `off`. */
	writeEntryWorldAABB( entry, out, off ) {

		const g = this.groupOfEntry( entry );
		if ( g < 0 ) {

			this.writeWorldAABB( this.repOf( entry ), out, off );
			return;

		}

		const p = this.repOf( entry );
		if ( ! this.isSet[ p ] ) {

			for ( let k = 0; k < 6; k ++ ) out[ off + k ] = 0;
			return;

		}

		const o = this.matrixRow( p );
		transformAABBInto( this.groups[ g ].aabb, 0, this.rowArray, o, out, off );

	}

	/**
	 * Every TLAS entry's world-space bounds, 6 floats each — what the TLAS sorts on.
	 * @param {Float64Array|Float32Array} out
	 */
	writeEntryWorldAABBs( out ) {

		if ( ! this.entryRep ) {

			this.writeWorldAABBs( out );
			return;

		}

		for ( let e = 0; e < this.entryCount; e ++ ) this.writeEntryWorldAABB( e, out, e * 6 );

	}

	/**
	 * Every placement's world-space bounds, 6 floats each.
	 * @param {Float64Array|Float32Array} out
	 */
	writeWorldAABBs( out ) {

		const aabb = this.tplObjectAABB, src = this.sourceMesh, set = this.isSet;

		for ( let i = 0; i < this.count; i ++ ) {

			const o = i * 6;

			if ( ! set[ i ] ) {

				out[ o ] = 0; out[ o + 1 ] = 0; out[ o + 2 ] = 0;
				out[ o + 3 ] = 0; out[ o + 4 ] = 0; out[ o + 5 ] = 0;
				continue;

			}

			const m = this.matrixRow( i );
			transformAABBInto( aabb, src[ i ] * 6, this.rowArray, m, out, o );

		}

	}

	/**
	 * A plain snapshot of one placement, shaped like the old entry object.
	 *
	 * This allocates, so it is for per-mesh work (refit of a handful of meshes) only — never a
	 * loop over every placement, which is the cost this class exists to avoid.
	 *
	 * @param {number} i
	 * @returns {object|null}
	 */
	entryAt( i ) {

		if ( ! this.isSet[ i ] ) return null;

		const t = this.sourceMesh[ i ];
		const owner = this.tplOwner[ t ];

		return {
			meshIndex: i,
			blasOffset: this.tplBlasOffset[ t ],
			blasNodeCount: this.tplNodeCount[ t ],
			triOffset: this.tplTriOffset[ t ],
			triCount: this.tplTriCount[ t ],
			expandedStart: this.tplExpandedStart[ t ],
			sourceMesh: t,
			sharedFrom: owner === i ? null : owner,
			matrixWorld: this.matrixWorldOf( i ),
			matrixInverse: this.matrixInverseOf( i ),
			flipWinding: !! this.flipWinding[ i ],
			bvhToOriginal: this.bvhToOriginal.get( t ) || null,
			visible: !! this.visible[ i ],
			tlasLeafIndex: this.tlasLeafIndex[ i ],
		};

	}

	/**
	 * Set per-mesh visibility flag. Does NOT update the GPU buffer — caller must patch
	 * combinedBvhData[tlasLeafIndex*16 + 2] and mark the bvh attr dirty.
	 *
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setVisibility( meshIndex, visible ) {

		if ( this.isSet[ meshIndex ] ) this.visible[ meshIndex ] = visible ? 1 : 0;

	}

	/**
	 * Compute object-space AABBs for every template from its BLAS root node.
	 * O(1) per template for inner roots; falls back to a triangle scan for leaf roots (rare).
	 *
	 * @param {Float32Array} triangleData - Global triangle data (needed for leaf-root fallback)
	 */
	/**
	 * @param {Object} triangleData
	 * @param {{owners?: boolean}} [options] - `owners: false` when each owner's bounds were taken
	 *   as its BLAS landed (a build that spills its BLASes keeps none of them here)
	 */
	computeAABBs( triangleData, { owners = true } = {} ) {

		for ( let t = 0; owners && t < this.templateCount; t ++ ) {

			if ( this.tplOwner[ t ] < 0 ) continue;
			const blas = this.blasData.get( t );
			if ( blas ) this._readRootAABB( Array.isArray( blas ) ? blas[ 0 ] : blas, t, triangleData, this.tplObjectAABB, t * 6 );

		}

		// Templates aliasing another's BLAS share its object bounds; only the transform differs.
		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 || this.blasData.has( t ) ) continue;
			const ot = this.sourceMesh[ owner ];
			if ( ot !== t ) this.tplObjectAABB.copyWithin( t * 6, ot * 6, ot * 6 + 6 );

		}

	}

	/**
	 * Recompute a placement's template bounds after its BLAS was refit.
	 * Reads from the combined bvhData buffer at the BLAS root offset.
	 *
	 * @param {number} entryIndex
	 * @param {Float32Array} combinedBvhData - The assembled BVH buffer (TLAS + BLASes)
	 * @param {Float32Array} triangleData - Global triangle data (for leaf-root fallback)
	 */
	recomputeAABB( entryIndex, combinedBvhData, triangleData ) {

		const t = this.sourceMesh[ entryIndex ];
		const n = this.tplBlasOffset[ t ];
		// Flat buffer or ChunkedRecords: either way, take that one node's 16 floats.
		const node = combinedBvhData.chunks
			? combinedBvhData.chunkFor( n ).subarray( combinedBvhData.baseOf( n ), combinedBvhData.baseOf( n ) + 16 )
			: combinedBvhData.subarray( n * 16, n * 16 + 16 );
		this._readRootAABB( node, t, triangleData, this.tplObjectAABB, t * 6 );

	}

	/**
	 * Read the root node's AABB from a flat BVH data array into `out` at `off`.
	 * Inner root: union of left+right child AABBs (O(1)).
	 * Leaf root: scan triangles (rare — only meshes with <= maxLeafSize tris).
	 * @private
	 */
	_readRootAABB( bvhData, template, triangleData, out, off ) {

		InstanceTable.rootAABB( bvhData, triangleData, this.tplTriOffset[ template ], this.tplTriCount[ template ], out, off );

	}

	/** A BLAS's object-space bounds, from its root node or, for a leaf root, its triangles. */
	static rootAABB( bvhData, triangleData, triOffset, triCount, out, off ) {

		if ( ! bvhData || bvhIndexView( bvhData )[ 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

			// Root is a leaf — very small mesh. Scan its triangles.
			aabbOfTriangles( triangleData, triOffset, triCount, out, off );
			return;

		}

		// Inner node: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		out[ off ] = Math.min( bvhData[ 0 ], bvhData[ 8 ] );
		out[ off + 1 ] = Math.min( bvhData[ 1 ], bvhData[ 9 ] );
		out[ off + 2 ] = Math.min( bvhData[ 2 ], bvhData[ 10 ] );
		out[ off + 3 ] = Math.max( bvhData[ 4 ], bvhData[ 12 ] );
		out[ off + 4 ] = Math.max( bvhData[ 5 ], bvhData[ 13 ] );
		out[ off + 5 ] = Math.max( bvhData[ 6 ], bvhData[ 14 ] );

	}

	/**
	 * Compute AABB by scanning triangle positions (fallback for leaf-root BLASes).
	 * @private
	 */
	_computeAABBFromTriangles( template, triangleData, out, off ) {

		aabbOfTriangles( triangleData, this.tplTriOffset[ template ], this.tplTriCount[ template ], out, off );

	}

	/**
	 * Assign BLAS offsets in the combined BVH buffer. Called once the TLAS node count is known.
	 * @param {number} tlasNodeCount - Number of nodes in the TLAS
	 */
	assignOffsets( tlasNodeCount ) {

		this.tlasNodeCount = tlasNodeCount;
		this.groupNodeStart = tlasNodeCount;
		let offset = tlasNodeCount;
		for ( const g of this.groups ) {

			g.offset = offset;
			offset += g.nodes;

		}

		if ( this.groups.length ) offset ++; // the empty leaf, last: a full refit computes it before any group node reads it
		const blasBase = offset;
		this.recordNodeStart = 0;

		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 || this.sourceMesh[ owner ] !== t ) continue;
			this.tplBlasOffset[ t ] = offset;
			offset += this.tplNodeCount[ t ];

		}

		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 ) continue;
			const ot = this.sourceMesh[ owner ];
			if ( ot !== t ) this.tplBlasOffset[ t ] = this.tplBlasOffset[ ot ];

		}

		this.totalBLASNodes = offset - blasBase;
		if ( this.clusterCount ) this.recordNodeStart = offset;
		assertBVHIndexFits( offset + ( this.clusterCount ? this.recordNodeCount : 0 ), 'combined TLAS + BLAS node count' );

	}

	/** Where the BLASes start: after the TLAS and the group trees. */
	get blasBase() {

		return this.tlasNodeCount + this.groupNodeCount;

	}

	/** Tree nodes: TLAS, group trees, all BLASes. */
	get treeNodeCount() {

		return this.blasBase + this.totalBLASNodes;

	}

	/** The whole buffer in nodes: the tree, then the copy records when clustered. */
	get totalNodeCount() {

		return this.treeNodeCount + ( this.clusterCount ? this.recordNodeCount : 0 );

	}

	/** Reset all columns. */
	clear() {

		this.allocate( 0 );
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;

	}

}

const _copyBoxes = new Float64Array( CLUSTER_SIZE * 6 );
const _recordInverse = new Float64Array( 16 );

/**
 * Orders `sorted[ lo, hi )` so each run of CLUSTER_SIZE holds neighbours: halved at the centre median of the widest
 * axis, the lower part a whole number of runs, which keeps the run count ⌈n / CLUSTER_SIZE⌉.
 */
function splitIntoRuns( sorted, lo, hi, world ) {

	const stack = [ lo, hi ];
	while ( stack.length ) {

		const end = stack.pop(), start = stack.pop();
		if ( end - start <= CLUSTER_SIZE ) continue;

		let axis = 0, widest = - 1;
		for ( let a = 0; a < 3; a ++ ) {

			let min = Infinity, max = - Infinity;
			for ( let i = start; i < end; i ++ ) {

				const c = world[ sorted[ i ] * 6 + a ] + world[ sorted[ i ] * 6 + 3 + a ];
				if ( c < min ) min = c;
				if ( c > max ) max = c;

			}

			if ( max - min > widest ) {

				widest = max - min;
				axis = a;

			}

		}

		const mid = start + CLUSTER_SIZE * Math.ceil( ( end - start ) / ( 2 * CLUSTER_SIZE ) );
		selectNth( sorted, start, end, mid, world, axis );
		stack.push( start, mid, mid, end );

	}

}

/** Partially sorts `sorted[ lo, hi )` by centre along `axis` so index `k` holds what a full sort would put there. */
function selectNth( sorted, lo, hi, k, world, axis ) {

	const key = ( i ) => world[ sorted[ i ] * 6 + axis ] + world[ sorted[ i ] * 6 + 3 + axis ];
	let l = lo, r = hi - 1;
	while ( r > l ) {

		const m = ( l + r ) >>> 1;
		const a = key( l ), b = key( m ), c = key( r );
		const pivot = a < b ? ( b < c ? b : a < c ? c : a ) : ( a < c ? a : b < c ? c : b );
		let i = l, j = r;
		while ( i <= j ) {

			while ( key( i ) < pivot ) i ++;
			while ( key( j ) > pivot ) j --;
			if ( i <= j ) {

				const t = sorted[ i ];
				sorted[ i ] = sorted[ j ];
				sorted[ j ] = t;
				i ++;
				j --;

			}

		}

		if ( k <= j ) r = j;
		else if ( k >= i ) l = i;
		else return;

	}

}

/** Splits group member slots in two at the centroid median of their widest axis. */
function splitMembers( list, members, aabb ) {

	const centre = ( j, a ) => aabb[ members[ j ] * 6 + a ] + aabb[ members[ j ] * 6 + 3 + a ];
	let axis = 0, widest = - 1;
	for ( let a = 0; a < 3; a ++ ) {

		let lo = Infinity, hi = - Infinity;
		for ( const j of list ) {

			const c = centre( j, a );
			if ( c < lo ) lo = c;
			if ( c > hi ) hi = c;

		}

		if ( hi - lo > widest ) {

			widest = hi - lo;
			axis = a;

		}

	}

	const sorted = list.slice().sort( ( x, y ) => centre( x, axis ) - centre( y, axis ) || x - y );
	const mid = sorted.length >> 1;
	return [ sorted.slice( 0, mid ), sorted.slice( mid ) ];

}

/** A child's box into an inner node's slot at `off`; none is the far point box no ray enters. */
function writeChildBox( block, off, box ) {

	for ( let a = 0; a < 3; a ++ ) {

		block[ off + a ] = box ? box[ a ] : BVH_EMPTY_BOX;
		block[ off + 4 + a ] = box ? box[ 3 + a ] : BVH_EMPTY_BOX;

	}

}

function unionBoxes( a, b ) {

	if ( ! a || ! b ) return a ?? b;
	const out = new Float32Array( 6 );
	for ( let k = 0; k < 3; k ++ ) {

		out[ k ] = Math.min( a[ k ], b[ k ] );
		out[ 3 + k ] = Math.max( a[ 3 + k ], b[ 3 + k ] );

	}

	return out;

}

/** Bounds of triangles [triOffset, triOffset + triCount) of a flat or chunked store, into out[off..off+5]. */
function aabbOfTriangles( triangleData, triOffset, triCount, out, off ) {

	const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
	// Flat array or ChunkedRecords: resolve the chunk once per triangle either way.
	const chunked = triangleData && triangleData.chunks ? triangleData.viewAs( Float32Array ) : null;
	const flat = chunked ? null : ( triangleData instanceof Float32Array
		? triangleData
		: new Float32Array( triangleData.buffer, triangleData.byteOffset, triangleData.length ) );
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let t = 0; t < triCount; t ++ ) {

		const gi = triOffset + t;
		const tri = chunked ? chunked.chunkFor( gi ) : flat;
		const base = chunked ? chunked.baseOf( gi ) : gi * FPT;

		// Positions A (offset 0), B (offset 4), C (offset 8)
		for ( let o = 0; o <= 8; o += 4 ) {

			const x = tri[ base + o ], y = tri[ base + o + 1 ], z = tri[ base + o + 2 ];
			if ( x < minX ) minX = x;
			if ( y < minY ) minY = y;
			if ( z < minZ ) minZ = z;
			if ( x > maxX ) maxX = x;
			if ( y > maxY ) maxY = y;
			if ( z > maxZ ) maxZ = z;

		}

	}

	out[ off ] = minX; out[ off + 1 ] = minY; out[ off + 2 ] = minZ;
	out[ off + 3 ] = maxX; out[ off + 4 ] = maxY; out[ off + 5 ] = maxZ;

}
