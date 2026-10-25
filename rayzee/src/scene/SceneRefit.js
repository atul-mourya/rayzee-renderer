import { Matrix4 } from 'three';
import { ChunkedRecords } from '../memory/ChunkedRecords.js';
import { createWorker } from '../Platform.js';
import BVHRefitWorker from '../bvh/BVHRefitWorker.js?worker&inline';
import { TRIANGLE_DATA_LAYOUT, RECORD_VEC4, TLAS_LEAF_IDENTITY, packNormalOct, BVH_LEAF_MARKERS, TLAS_PLACEMENT_MASK, CLUSTER_FIRST_MASK } from './BufferLayout.js';
import { BVHRefitter } from '../bvh/BVHRefitter.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { multiplyAffine, isIdentity } from './InstanceTable.js';
import { TLASBuilder } from '../bvh/TLASBuilder.js';

// A move's TLAS upload: touched nodes this close share a range, and past MAX_TLAS_RANGES ranges one spans them all.
const TLAS_RANGE_GAP = 1024;
const MAX_TLAS_RANGES = 64;

/** Float ranges of the BVH covering `nodes`, for an upload. */
function nodeRanges( nodes ) {

	const sorted = Int32Array.from( nodes ).sort();
	const out = [];
	let lo = sorted[ 0 ], hi = lo;
	for ( let k = 1; k <= sorted.length; k ++ ) {

		if ( k < sorted.length && sorted[ k ] - hi <= TLAS_RANGE_GAP ) {

			hi = sorted[ k ];
			continue;

		}

		out.push( { offset: lo * 16, count: ( hi - lo + 1 ) * 16 } );
		lo = hi = sorted[ k ];

	}

	return out.length > MAX_TLAS_RANGES ? [ { offset: sorted[ 0 ] * 16, count: ( sorted.at( - 1 ) - sorted[ 0 ] + 1 ) * 16 } ] : out;

}

// ===== BVH REFIT (Animation Support) =====

/**
 * Make sure a store's chunks live in shared memory. Already-shared chunks are left alone; a
 * page without cross-origin isolation falls back to copying, which is the old cost.
 * @private
 */
function adoptSharedChunks( processor, field, LaneType ) {

	const records = processor[ field ];
	if ( records.shared ) return;

	const chunks = records.chunks.map( c => {

		const view = new LaneType( new SharedArrayBuffer( c.byteLength ) );
		view.set( c );
		return view;

	} );

	const adopted = ChunkedRecords.adopt(
		chunks, records.recordCount, records.lanesPerRecord, records.recordsPerChunk
	);

	if ( field === 'bvh' ) processor._setBVHData( adopted );
	else processor._setTriangleData( adopted );

}

/**
 * Normalize a caller's positions or normals into a per-mesh reader. A full-scene array is
 * handed back as views into itself, so the old contract costs nothing extra; a callback lets a
 * caller build one mesh at a time and never hold 9 floats × every triangle at once — 1,030 MB
 * at 30M triangles, which is past what a renderer can allocate.
 */
export function meshSource( processor, source, what ) {

	if ( source == null ) return null;

	const table = processor.instanceTable;

	if ( typeof source === 'function' ) {

		// The table is keyed by placement and one instanced mesh holds several, so a raw
		// placement index is not something the caller can look up. Hand back the mesh.
		return i => {

			const mesh = table.sourceMesh[ i ];
			const got = source( mesh, table.triCountOf( i ) );
			const want = table.triCountOf( i ) * 9;
			if ( got && got.length !== want ) {

				throw new Error(
					`SceneProcessor: ${what}s for mesh ${mesh} must be ${want} floats ` +
					`(${table.triCountOf( i )} triangles × 9), got ${got.length}.`
				);

			}

			return got ?? null;

		};

	}

	// A short array reads past its end and writes NaN through every AABB above it with no
	// error anywhere, so the scene just vanishes. Check once here instead.
	const expected = ( processor.expandedTriangleCount ?? processor.triangleCount ) * 9;
	if ( source.length !== expected ) {

		throw new Error(
			`SceneProcessor: expected ${expected} ${what} floats (${expected / 9} triangles × 9, ` +
			`full scene), got ${source.length}. Pass a per-mesh callback instead to avoid ` +
			'building one array for the whole scene.'
		);

	}

	return i => {

		const from = table.expandedStartOf( i ) * 9;
		return source.subarray( from, from + table.triCountOf( i ) * 9 );

	};

}

export async function refitBVH( processor, newPositions, newNormals ) {

	processor._geometryVersion = ( processor._geometryVersion ?? 0 ) + 1;

	if ( ! processor.bvh || ! processor.triangles || ! processor.instanceTable ) {

		throw new Error( 'No BVH data available for refit. Run buildBVH() first.' );

	}

	const positionsFor = processor._meshSource( newPositions, 'position' );
	const normalsFor = processor._meshSource( newNormals, 'normal' );

	if ( ! positionsFor ) throw new Error( 'SceneProcessor.refitBVH: positions are required.' );

	// Lazy-create worker
	if ( ! processor._refitWorker ) {

		processor._refitWorker = createWorker( BVHRefitWorker );

	}

	// First call: move triangles and nodes into shared memory so the worker refits them in
	// place. Positions never cross the boundary — they are scattered into the triangle records
	// below, one mesh at a time, so nothing scene-sized is allocated on either side.
	if ( ! processor._refitSharedBuffers ) {

		// Both stores are built on SharedArrayBuffer when the page allows it, so the worker
		// takes them as they are. Copying instead would duplicate the two largest structures
		// in the scene — 3,968 MB at 30M triangles, which is where this used to fail.
		adoptSharedChunks( processor, 'bvh', Float32Array );
		adoptSharedChunks( processor, 'triangles', Uint32Array );

		const sharedBvhBufs = processor.bvh.chunks.map( c => c.buffer );
		const sharedTriBufs = processor.triangles.chunks.map( c => c.buffer );
		processor._refitSharedBuffers = { bvhBufs: sharedBvhBufs, triBufs: sharedTriBufs };

		processor._refitWorker.postMessage( {
			type: 'init',
			sharedBvhBufs,
			bvhRecordCount: processor.bvh.recordCount,
			bvhRecordsPerChunk: processor.bvh.recordsPerChunk,
			sharedTriBufs,
			triRecordCount: processor.triangles.recordCount,
			triLanesPerRecord: processor.triangles.lanesPerRecord,
			triRecordsPerChunk: processor.triangles.recordsPerChunk,
		} );

	}

	// Scatter straight into the shared triangle records, mesh by mesh, so the caller's slice
	// can be released as soon as it is read. Callers hand over world space; triangles are
	// stored per instance, so each mesh comes back through its own inverse.
	const table = processor.instanceTable;
	const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
	const triRanges = [];
	const blasRanges = [];
	const refit = [];
	let owners = 0;
	for ( let i = 0; i < table.count; i ++ ) {

		if ( ! table.isSet[ i ] || ! table.isOwner( i ) ) continue;
		owners ++;

		const p = positionsFor( i );
		if ( ! p ) continue;
		processor._updateMeshTrianglePositions( i, p );
		blasRanges.push( table.blasOffsetOf( i ), table.blasNodeCountOf( i ) );
		refit.push( i );

		// Smooth normals overwrite the face normals just computed, so they follow per mesh.
		if ( normalsFor ) {

			const n = normalsFor( i );
			if ( n ) processor._patchMeshSmoothNormals( i, n );

		}

		const offset = table.triOffsetOf( i ) * FPT, count = table.triCountOf( i ) * FPT;
		const last = triRanges.at( - 1 );
		if ( last && last.offset + last.count === offset ) last.count += count;
		else triRanges.push( { offset, count } );

	}

	const tlasNodeCount = table.tlasNodeCount;
	const partial = tlasNodeCount > 0 && blasRanges.length / 2 < owners;
	const bvhRanges = partial ? [ processor.computeTLASDirtyRange() ] : null;
	for ( let r = 0; partial && r < blasRanges.length; r += 2 ) bvhRanges.push( { offset: blasRanges[ r ] * 16, count: blasRanges[ r + 1 ] * 16 } );

	return new Promise( ( resolve, reject ) => {

		processor._refitWorker.onmessage = ( e ) => {

			const msg = e.data;
			if ( msg.type === 'refitComplete' ) {

				// Later moves and main-thread refits box placements by these.
				for ( const i of refit ) table.recomputeAABB( i, processor.bvh, processor.triangles );
				table.computeGroupAABBs();
				// The worker boxes a group copy by its shown members only.
				const leaves = hiddenGroupLeaves( processor );
				if ( leaves.length ) processor._refitTLAS( leaves );
				resolve( { refitTimeMs: msg.refitTimeMs, triRanges, bvhRanges } );

			} else if ( msg.type === 'error' ) {

				reject( new Error( msg.error ) );

			}

		};

		// Signal worker — no data transfer needed, everything is in shared memory
		processor._refitWorker.postMessage( {
			type: 'refit', blasRanges: partial ? blasRanges : null, tlasNodeCount,
			groupRange: table.groupNodeCount ? [ table.groupNodeStart, table.groupNodeCount ] : null,
			treeNodeCount: table.treeNodeCount, recordNodeStart: table.clusterCount ? table.recordNodeStart : - 1,
		} );

	} );

}

/**
 * Refit specific BLASes and rebuild TLAS after object transform or per-mesh animation.
 * Runs on the main thread (fast for per-mesh updates).
 *
 * @param {number[]} affectedMeshIndices - Indices into `this.meshes`, the same space
 *   {@link updateMeshTransforms} takes
 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order (full scene)
 * @param {Float32Array} [newNormals] - Optional smooth normals (9 floats per tri)
 * @returns {{ refitTimeMs: number }}
 */
/**
 * The placement holding a mesh's triangles. The instance table is keyed by placement and one
 * instanced mesh contributes several, so every entry point taking mesh indices converts here.
 *
 * @param {number} meshIndex
 * @returns {number} placement index, or -1 when the mesh placed nothing
 */
export function placementOf( processor, meshIndex ) {

	return processor.instanceTable?.placementRunOf( meshIndex )?.start ?? - 1;

}

export function refitBLASes( processor, affectedMeshIndices, newPositions, newNormals ) {

	processor._geometryVersion = ( processor._geometryVersion ?? 0 ) + 1;

	if ( ! processor.instanceTable || ! processor.bvh || ! processor.triangles ) {

		throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

	}

	const positionsFor = processor._meshSource( newPositions, 'position' );
	const normalsFor = processor._meshSource( newNormals, 'normal' );

	if ( ! positionsFor ) throw new Error( 'SceneProcessor.refitBLASes: positions are required.' );

	const start = performance.now();

	// Lazy-create refitter instance
	if ( ! processor._blasRefitter ) {

		processor._blasRefitter = new BVHRefitter();

	}

	// Step 1: Update triangle positions and refit each affected BLAS
	const table = processor.instanceTable;

	for ( const meshIndex of affectedMeshIndices ) {

		const placement = processor._placementOf( meshIndex );
		if ( placement < 0 || ! table.isSet[ placement ] ) continue;

		// Triangles are shared between placements of one geometry, so writing this mesh's
		// vertices would move every other copy with them. Anything that deforms is extracted
		// with triangles of its own, so reaching here means the wrong mesh was handed over.
		if ( ! table.isOwner( placement ) ) {

			const owner = table.tplOwner[ table.sourceMesh[ placement ] ];
			processor.config.issues?.record(
				ISSUE_CODES.REFIT_SHARED_GEOMETRY,
				`mesh ${meshIndex} shares its triangles with another placement; deforming it would move every copy, so it was skipped`,
				{ meshIndex, owner: table.sourceMesh[ owner ] ?? owner }
			);
			continue;

		}

		const p = positionsFor( placement );
		if ( ! p ) continue;
		processor._updateMeshTrianglePositions( placement, p );

		if ( normalsFor ) {

			const n = normalsFor( placement );
			if ( n ) processor._patchMeshSmoothNormals( placement, n );

		}

		// Refit this BLAS's nodes
		processor._blasRefitter.refitRange(
			processor.bvh,
			processor.triangles,
			table.blasOffsetOf( placement ),
			table.blasNodeCountOf( placement )
		);

		// Recompute this mesh's AABB for TLAS rebuild
		processor.instanceTable.recomputeAABB( placement, processor.bvh, processor.triangles );

	}

	// Step 2: group trees over the refit BLASes, then the TLAS AABBs in place (no SAH rebuild)
	writeGroupNodes( processor );
	processor._refitTLAS();

	return { refitTimeMs: performance.now() - start };

}

export function updateMeshTransforms( processor, meshIndices ) {

	if ( ! processor.instanceTable || ! processor.bvh ) {

		throw new Error( 'No TLAS/BLAS data available. Run buildBVH() first.' );

	}

	const start = performance.now();
	const table = processor.instanceTable;
	const composed = processor._transformScratch ??= new Float32Array( 16 );
	const leaves = [];

	for ( const meshIndex of processor._withGroupSiblings( meshIndices ) ) {

		const mesh = processor.meshes?.[ meshIndex ];
		const run = table.placementRunOf( meshIndex );
		if ( ! mesh || ! run ) continue;

		mesh.updateMatrixWorld( true );
		const world = mesh.matrixWorld.elements;
		const instances = mesh.isInstancedMesh ? mesh.instanceMatrix?.array ?? null : null;
		// Baked triangles hold the pose they were extracted at; the leaf only carries the delta.
		const bakeInverse = table.tplBakeInverse?.get( table.sourceMesh[ run.start ] ) ?? null;

		for ( let k = 0; k < run.count; k ++ ) {

			const p = run.start + k;
			if ( ! table.isSet[ p ] ) continue;

			if ( instances ) {

				multiplyAffine( world, instances, k * 16, composed );
				table.setPlacementMatrix( p, composed );

			} else if ( bakeInverse ) {

				multiplyAffine( world, bakeInverse, 0, composed );
				table.setPlacementMatrix( p, composed );

			} else {

				table.setPlacementMatrix( p, world );

			}

			writeLeafMatrix( processor, p );
			const leaf = table.leafOfPlacement( p );
			if ( leaf >= 0 ) leaves.push( leaf );

		}

	}

	processor._refitTLAS( leaves );

	return { refitTimeMs: performance.now() - start, placements: leaves.length };

}

/** The TLAS leaves of every copy of a group with a hidden member. @private */
function hiddenGroupLeaves( processor ) {

	const table = processor.instanceTable;
	const leaves = [];
	for ( const g of table.groups ) {

		if ( g.members.every( ( _, j ) => table.visible[ g.starts[ j ] ] ) ) continue;
		for ( let c = 0; c < g.count; c ++ ) leaves.push( table.leafOfPlacement( g.starts[ 0 ] + c ) );

	}

	return leaves;

}

/**
 * A grouped mesh's parts are traced as one object, so a part moved alone takes its siblings with it: each sibling
 * is given the first moved member's world transform, and all of them are moved.
 */
export function withGroupSiblings( processor, meshIndices ) {

	const table = processor.instanceTable;
	if ( ! table.groups.length ) return meshIndices;

	const out = new Set( meshIndices );
	const synced = new Set();
	const parentInverse = processor._parentInverse ??= new Matrix4();

	for ( const meshIndex of meshIndices ) {

		const g = table.groupOfTemplate[ meshIndex ] ?? - 1;
		if ( g < 0 || synced.has( g ) ) continue;
		synced.add( g );

		const mover = processor.meshes?.[ meshIndex ];
		if ( ! mover ) continue;
		mover.updateMatrixWorld( true );

		for ( const sibling of table.groups[ g ].members ) {

			out.add( sibling );
			const mesh = processor.meshes[ sibling ];
			if ( ! mesh || mesh === mover ) continue;
			if ( mesh.parent ) mesh.parent.updateMatrixWorld( true );
			mesh.matrix.copy( mover.matrixWorld );
			if ( mesh.parent ) mesh.matrix.premultiply( parentInverse.copy( mesh.parent.matrixWorld ).invert() );
			mesh.matrix.decompose( mesh.position, mesh.quaternion, mesh.scale );
			mesh.updateMatrixWorld( true );

		}

	}

	return out;

}

/** Refresh one TLAS leaf's world-to-object matrix from the table — its copy record, when clustered. @private */
function writeLeafMatrix( processor, placement ) {

	const table = processor.instanceTable;
	const node = table.tlasLeafIndex[ placement ];
	if ( node < 0 ) return;

	if ( table.clusterCount ) {

		processor._writeCopyRecord( node, table.repOf( table.entryOf( placement ) ) );
		return;

	}

	TLASBuilder.writeLeafMatrix(
		processor.bvh.chunkFor( node ), processor.bvhIndexChunks.chunkFor( node ), processor.bvh.baseOf( node ),
		table, placement, table.entryOf( placement )
	);

}

/**
 * Rewrites copy record `r` from placement `p`'s transform, and its identity bit (a moved baked placement stops being
 * identity); records the range for the next upload. @private
 */
export function writeCopyRecord( processor, r, p ) {

	const table = processor.instanceTable;
	const rows = processor._recordScratch ??= new Float32Array( 12 );
	table.writeRecord( rows, 0, p );
	const lane = table.recordNodeStart * 16 + r * RECORD_VEC4 * 4;
	for ( let i = 0; i < 12; i ++ ) {

		const node = ( lane + i ) >> 4;
		processor.bvh.chunkFor( node )[ processor.bvh.baseOf( node ) + ( ( lane + i ) & 15 ) ] = rows[ i ];

	}

	const leaf = table.clusterLeaf[ table.clusterOf( r ) ];
	const idx = processor.bvhIndexChunks.chunkFor( leaf ), o = processor.bvh.baseOf( leaf ) + table.copyWordSlot( r );
	const identity = isIdentity( table.matrixWorldOf( p ) );
	idx[ o ] = ( ( idx[ o ] & ~ TLAS_LEAF_IDENTITY ) | ( identity ? TLAS_LEAF_IDENTITY : 0 ) ) >>> 0;

	// One range a chunk: a mesh's copies sit all over the records, and a spilled scene has only their chunks back.
	const moved = processor._movedRecords ??= new Map();
	const lanesPerChunk = processor.bvh.recordsPerChunk * 16;
	for ( let at = lane, end = lane + 12; at < end; ) {

		const k = Math.floor( at / lanesPerChunk ), stop = Math.min( end, ( k + 1 ) * lanesPerChunk );
		const range = moved.get( k );
		if ( range ) {

			range.lo = Math.min( range.lo, at );
			range.hi = Math.max( range.hi, stop );

		} else moved.set( k, { lo: at, hi: stop } );
		at = stop;

	}

}

export function takeMoveRanges( processor ) {

	const tlas = processor._tlasRanges ?? [ processor.computeTLASDirtyRange() ];
	processor._tlasRanges = null;
	return [ ...tlas, ...processor.takeMovedRecordRanges() ];

}

export function takeMovedRecordRanges( processor ) {

	const moved = processor._movedRecords;
	processor._movedRecords = null;
	return moved ? [ ...moved.values() ].map( r => ( { offset: r.lo, count: r.hi - r.lo } ) ) : [];

}

/** Rewrites the group trees from the members' current bounds and visibility. @private */
function writeGroupNodes( processor ) {

	const table = processor.instanceTable;
	if ( ! table?.groupNodeCount || ! processor.bvh ) return;
	table.computeGroupAABBs();
	processor.bvh.setRecords( table.groupNodeStart, table.groupNodeBlock() );

}

export function computeTLASDirtyRange( processor ) {

	return { offset: 0, count: processor.instanceTable.blasBase * 16 };

}

export function computeBLASDirtyRanges( processor, affectedMeshIndices ) {

	const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
	const FPN = 16; // FLOATS_PER_NODE — 4 × vec4 per BVH node
	const triRanges = [];
	const bvhRanges = [];

	for ( const meshIndex of affectedMeshIndices ) {

		const table = processor.instanceTable;
		const placement = processor._placementOf( meshIndex );
		if ( placement < 0 || ! table.isSet[ placement ] ) continue;

		triRanges.push( { offset: table.triOffsetOf( placement ) * FPT, count: table.triCountOf( placement ) * FPT } );
		bvhRanges.push( { offset: table.blasOffsetOf( placement ) * FPN, count: table.blasNodeCountOf( placement ) * FPN } );

	}

	// Always include the TLAS and group trees (rebuilt on every refit)
	bvhRanges.push( { offset: 0, count: processor.instanceTable.blasBase * FPN } );

	return { triRanges, bvhRanges };

}

/**
 * Update triangle positions for a single mesh entry.
 * Iterates in BVH order for sequential writes (cache-friendly), random reads from newPositions.
 */
export function updateMeshTrianglePositions( processor, i, meshPositions ) {

	const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
	const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
	const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;
	const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
	const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
	const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;
	const tri = processor.triangles, triF = processor.triangleFloatChunks;
	const table = processor.instanceTable;

	const bvhToOrig = table.bvhToOriginalOf( i );
	const triOffset = table.triOffsetOf( i ), triCount = table.triCountOf( i );

	// Callers hand over world-space positions, which is the only space they can build
	// one in; triangles are stored per instance, so they come back through the inverse.
	const m = table.matrixInverseOf( i );
	const identity = isIdentity( m );

	for ( let bvhLocal = 0; bvhLocal < triCount; bvhLocal ++ ) {

		const origLocal = bvhToOrig ? bvhToOrig[ bvhLocal ] : bvhLocal;
		const t = triOffset + bvhLocal;
		const f = triF.chunkFor( t ), u = tri.chunkFor( t );
		const dst = tri.baseOf( t );
		const src = origLocal * 9;

		let ax = meshPositions[ src ];
		let ay = meshPositions[ src + 1 ];
		let az = meshPositions[ src + 2 ];
		let bx = meshPositions[ src + 3 ];
		let by = meshPositions[ src + 4 ];
		let bz = meshPositions[ src + 5 ];
		let cx = meshPositions[ src + 6 ];
		let cy = meshPositions[ src + 7 ];
		let cz = meshPositions[ src + 8 ];

		if ( ! identity ) {

			const px = ( x, y, z ) => m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
			const py = ( x, y, z ) => m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
			const pz = ( x, y, z ) => m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];
			const a = [ px( ax, ay, az ), py( ax, ay, az ), pz( ax, ay, az ) ];
			const b = [ px( bx, by, bz ), py( bx, by, bz ), pz( bx, by, bz ) ];
			const c = [ px( cx, cy, cz ), py( cx, cy, cz ), pz( cx, cy, cz ) ];
			ax = a[ 0 ]; ay = a[ 1 ]; az = a[ 2 ];
			bx = b[ 0 ]; by = b[ 1 ]; bz = b[ 2 ];
			cx = c[ 0 ]; cy = c[ 1 ]; cz = c[ 2 ];

		}

		f[ dst + PA ] = ax;
		f[ dst + PA + 1 ] = ay;
		f[ dst + PA + 2 ] = az;
		f[ dst + PB ] = bx;
		f[ dst + PB + 1 ] = by;
		f[ dst + PB + 2 ] = bz;
		f[ dst + PC ] = cx;
		f[ dst + PC + 1 ] = cy;
		f[ dst + PC + 2 ] = cz;

		const abx = bx - ax, aby = by - ay, abz = bz - az;
		const acx = cx - ax, acy = cy - ay, acz = cz - az;
		const packed = packNormalOct(
			aby * acz - abz * acy,
			abz * acx - abx * acz,
			abx * acy - aby * acx
		);

		u[ dst + NA ] = packed;
		u[ dst + NB ] = packed;
		u[ dst + NC ] = packed;

	}

}

/**
 * Patch smooth normals for a single mesh's triangles.
 */
export function patchMeshSmoothNormals( processor, i, meshNormals ) {

	const table = processor.instanceTable;
	patchNormalsRange( processor,
		meshNormals, table.triOffsetOf( i ), table.triCountOf( i ),
		table.matrixWorldOf( i ), table.bvhToOriginalOf( i )
	);

}

/**
 * Shared normal-patching loop for a range of triangles.
 * @private
 */
function patchNormalsRange( processor, normals, triOffset, count, matrixWorld, bvhToOrig ) {

	const NA = TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET;
	const NB = TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET;
	const NC = TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET;

	// Callers supply world-space normals. Traversal takes object normals out through the
	// transpose of world-to-object, so coming the other way is the transpose of
	// object-to-world — not its inverse, which is what a position would use.
	const m = matrixWorld;
	const plain = ! m || isIdentity( m );
	const slots = [ NA, NB, NC ];

	// Walked in stored order so the writes stay sequential; the inverse map is the only
	// permutation kept, so the read is the scattered side.
	for ( let k = 0; k < count; k ++ ) {

		const bvhIdx = triOffset + k;
		const u = processor.triangles.chunkFor( bvhIdx );
		const dst = processor.triangles.baseOf( bvhIdx );
		const src = ( bvhToOrig ? bvhToOrig[ k ] : k ) * 9;

		for ( let v = 0; v < 3; v ++ ) {

			const s = src + v * 3;
			const nx = normals[ s ], ny = normals[ s + 1 ], nz = normals[ s + 2 ];
			let ox = nx, oy = ny, oz = nz;

			if ( ! plain ) {

				ox = m[ 0 ] * nx + m[ 1 ] * ny + m[ 2 ] * nz;
				oy = m[ 4 ] * nx + m[ 5 ] * ny + m[ 6 ] * nz;
				oz = m[ 8 ] * nx + m[ 9 ] * ny + m[ 10 ] * nz;
				const len = Math.hypot( ox, oy, oz ) || 1;
				ox /= len; oy /= len; oz /= len;

			}

			u[ dst + slots[ v ] ] = packNormalOct( ox, oy, oz );

		}

	}

}

/**
 * Refit the TLAS boxes in place, top down. A node keeps each child's box in its own slots, so a subtree holding none
 * of `leaves` is skipped: a move costs its leaves' paths to the root, not the tree (moving 69,856 copies on the Moana
 * island, 20M nodes: 11.6 s → 93 ms). Every leaf when `leaves` is omitted.
 * @param {ArrayLike<number>} [leaves] - TLAS leaf nodes whose boxes changed, in any order
 */
export function refitTLAS( processor, leaves = null ) {

	const table = processor.instanceTable;
	const count = table.tlasNodeCount;
	const marks = leaves ? Int32Array.from( leaves ).sort() : null;
	processor._tlasRanges = marks ? [] : null;
	if ( ! count || marks?.length === 0 ) return;
	const touched = marks ? Array.from( marks ) : null;

	// Frames of node, end of its subtree (pre-order: [node, end)), parent slot (parent * 2 + side, -1 at the root),
	// and whether its children are done.
	let stack = processor._refitStack ??= new Int32Array( 256 );
	let top = 0, cursor = 0;
	const box = processor._refitBox ??= new Float32Array( 6 );
	const push = ( node, end, slot, done ) => {

		if ( top + 4 > stack.length ) {

			const grown = new Int32Array( stack.length * 2 );
			grown.set( stack );
			stack = processor._refitStack = grown;

		}

		stack[ top ++ ] = node; stack[ top ++ ] = end; stack[ top ++ ] = slot; stack[ top ++ ] = done;

	};

	push( 0, count, - 1, 0 );
	while ( top ) {

		const done = stack[ -- top ], slot = stack[ -- top ], end = stack[ -- top ], i = stack[ -- top ];
		const f = processor.bvh.chunkFor( i ), o = processor.bvh.baseOf( i );

		if ( done ) {

			box[ 0 ] = Math.min( f[ o ], f[ o + 8 ] ); box[ 1 ] = Math.min( f[ o + 1 ], f[ o + 9 ] ); box[ 2 ] = Math.min( f[ o + 2 ], f[ o + 10 ] );
			box[ 3 ] = Math.max( f[ o + 4 ], f[ o + 12 ] ); box[ 4 ] = Math.max( f[ o + 5 ], f[ o + 13 ] ); box[ 5 ] = Math.max( f[ o + 6 ], f[ o + 14 ] );

		} else {

			if ( marks ) {

				while ( cursor < marks.length && marks[ cursor ] < i ) cursor ++;
				if ( cursor === marks.length || marks[ cursor ] >= end ) continue;

			}

			const idx = processor.bvhIndexChunks.chunkFor( i );
			const marker = idx[ o + 3 ];
			if ( marker === BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ) {

				// Slot [1] is this leaf's own entry. Keying off slot [0] instead collapsed every placement of a shared
				// geometry onto one box, so all but one copy sat outside its own bounds and rays walked past it.
				const entry = idx[ o + 1 ] & TLAS_PLACEMENT_MASK;
				if ( entry >= table.entryCount ) continue;
				table.writeEntryWorldAABB( entry, box, 0 );

			} else if ( marker === BVH_LEAF_MARKERS.CLUSTER_LEAF ) {

				table.encodeClusterBoxes( f, idx, o, table.clusterOf( idx[ o ] & CLUSTER_FIRST_MASK ), null, box, 0 );

			} else if ( marker < BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

				const right = idx[ o + 7 ];
				push( i, end, slot, 1 );
				push( right, end, i * 2 + 1, 0 );
				push( marker, right, i * 2, 0 );
				continue;

			} else continue;

		}

		if ( slot < 0 ) continue;
		const p = slot >> 1, pf = processor.bvh.chunkFor( p ), po = processor.bvh.baseOf( p ) + ( slot & 1 ) * 8;
		pf[ po ] = box[ 0 ]; pf[ po + 1 ] = box[ 1 ]; pf[ po + 2 ] = box[ 2 ];
		pf[ po + 4 ] = box[ 3 ]; pf[ po + 5 ] = box[ 4 ]; pf[ po + 6 ] = box[ 5 ];
		touched?.push( p );

	}

	if ( touched ) processor._tlasRanges = nodeRanges( touched );

}
