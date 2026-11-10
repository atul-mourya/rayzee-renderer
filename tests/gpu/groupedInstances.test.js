/**
 * Instanced meshes placed by one matrix list trace as one object a copy: a TLAS entry whose subtree is a small tree
 * over the members' BLASes. Grouped or not, every ray must hit the same triangle at the same distance, and a hidden
 * member must vanish from every copy.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Fn, instanceIndex, instancedArray, storage, vec4, float } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describeGPU, createRenderer } from './gpu.js';

vi.mock( '@/core/bvh/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { InstanceTable } from '@/core/scene/InstanceTable.js';
import { TLASBuilder } from '@/core/bvh/TLASBuilder.js';
import { rebaseNodes } from '@/core/bvh/BVHLeafFold.js';
import { BVHRefitter } from '@/core/bvh/BVHRefitter.js';
import { PathTracerStage } from '@/core/pathtracer/PathTracerStage.js';
import { traverseBVH, traverseBVHShadow, traverseBVHShadowCameraCulled } from '@/core/shaders/BVHTraversal.js';
import { StorageParts } from '@/core/shaders/ThreePatches.js';
import { splitStorage } from '@/core/shaders/Common.js';
import { Ray } from '@/core/shaders/Struct.js';
import { withSceneResources } from '@/core/shaders/SceneResources.js';
import { TRI_SIDE_SHIFT } from '@/core/scene/BufferLayout.js';

const LANES = 20;
const PER_MESH = 300;
const COPIES = 60;
const RAYS = 8192;

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function mesh( cx ) {

	const data = new Uint32Array( PER_MESH * LANES );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < PER_MESH; i ++ ) {

		const x = cx + rand() * 2, y = rand() * 2, z = rand() * 2;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + rand() * 0.4, y + rand() * 0.1, z ], i * LANES + 4 );
		f.set( [ x, y + rand() * 0.4, z + rand() * 0.4 ], i * LANES + 8 );
		data[ i * LANES + 18 ] = 2 << TRI_SIDE_SHIFT;

	}

	const builder = new BVHBuilder();
	return { nodes: builder.flattenBVH( builder.buildSync( data ) ), triangles: builder.reorderedTriangleData };

}

function copies() {

	const out = new Float32Array( COPIES * 16 );
	const m = new Matrix4(), q = new Quaternion(), axis = new Vector3();
	for ( let i = 0; i < COPIES; i ++ ) {

		axis.set( rand() - 0.5, rand() - 0.5, rand() - 0.5 ).normalize();
		q.setFromAxisAngle( axis, rand() * Math.PI * 2 );
		const s = 0.5 + rand();
		m.compose( new Vector3( rand() * 40 - 20, rand() * 40 - 20, rand() * 40 - 20 ), q, new Vector3( s, s * ( 0.8 + rand() * 0.4 ), s ) );
		out.set( m.elements, i * 16 );

	}

	return out;

}

/** The copies with every third one sheared, as a placement under a non-uniformly scaled, turned parent is. */
function shearSome( matrices ) {

	const out = matrices.slice();
	const m = new Matrix4(), shear = new Matrix4().makeShear( 0.4, 0, 0.3, 0, 0, 0.2 );
	for ( let i = 0; i < COPIES; i += 3 ) out.set( m.fromArray( matrices, i * 16 ).multiply( shear ).elements, i * 16 );
	return out;

}

/** The combined [ TLAS | group trees | BLAS A | BLAS B ] buffer, as SceneProcessor assembles it. */
function assemble( parts, matrices, { grouped, hideB, hideSome = false, clustered = false } ) {

	const table = new InstanceTable();
	const world = new Float32Array( COPIES * 2 * 16 );
	world.set( matrices, 0 );
	world.set( matrices, COPIES * 16 );
	const source = new Int32Array( COPIES * 2 );
	source.fill( 1, COPIES );
	table.allocate( COPIES * 2, 2, world, source );

	let triOffset = 0;
	parts.forEach( ( part, t ) => {

		const first = t * COPIES;
		table.setEntry( {
			meshIndex: first, blasNodeCount: part.nodes.length / 16, triOffset, triCount: PER_MESH,
			originalToBvhMap: null, bvhData: part.nodes, matrixWorld: world, matrixOffset: first * 16, sourceMesh: t,
		} );
		for ( let i = 1; i < COPIES; i ++ ) table.setAlias( first + i, first, world, null, t, ( first + i ) * 16 );
		triOffset += PER_MESH;

	} );

	if ( hideB ) table.visible.fill( 0, COPIES );
	if ( hideSome ) for ( let p = 0; p < COPIES * 2; p += 3 ) table.visible[ p ] = 0;
	table.setGroups( grouped ? [ { members: [ 0, 1 ], starts: [ 0, COPIES ], count: COPIES } ] : null );
	if ( clustered ) table.planClusters();
	table.computeAABBs( null );
	table.computeGroupAABBs();
	if ( clustered ) {

		table.clusterWorld = new Float32Array( table.entryCount * 6 );
		table.writeEntryWorldAABBs( table.clusterWorld );
		table.clusterBounds = table.formClusters( table.clusterWorld );

	}

	table.assignOffsets( TLASBuilder.nodeCountFor( clustered ? table.clusterCount : table.entryCount ) );

	const nodes = new Float32Array( table.totalNodeCount * 16 );
	nodes.set( new TLASBuilder().build( table ).data, 0 );
	if ( clustered ) for ( let r = 0; r < table.entryCount; r ++ ) table.writeRecord( nodes, table.recordNodeStart * 16 + r * 12, table.repOf( table.recordEntry[ r ] ) );
	if ( table.groupNodeCount ) nodes.set( table.groupNodeBlock(), table.groupNodeStart * 16 );
	const idx = new Uint32Array( nodes.buffer );
	parts.forEach( ( part, t ) => {

		const at = table.tplBlasOffset[ t ];
		nodes.set( part.nodes, at * 16 );
		rebaseNodes( idx, at, t * PER_MESH, at * 16, ( at + part.nodes.length / 16 ) * 16 );

	} );

	if ( clustered ) nodes.copyRecordBase = table.recordNodeStart * 4;
	return { nodes, table };

}

function rays() {

	const origins = new Float32Array( RAYS * 4 ), dirs = new Float32Array( RAYS * 4 );
	for ( let i = 0; i < RAYS; i ++ ) {

		origins.set( [ rand() * 60 - 30, rand() * 60 - 30, - 40 ], i * 4 );
		const d = [ rand() - 0.5, rand() - 0.5, 1 ];
		const l = Math.hypot( ...d );
		dirs.set( d.map( v => v / l ), i * 4 );

	}

	return { origins, dirs };

}

/** The `{ geo, shade }` storage pair over 20-lane triangle records. */
function triangleStores( triangles ) {

	const count = triangles.length / LANES;
	const geo = new Uint32Array( count * 12 ), shade = new Uint32Array( count * 8 );
	for ( let i = 0; i < count; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	return {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', count * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', count * 2 ).toReadOnly(),
	};

}

async function trace( renderer, nodes, triangles, { origins, dirs } ) {

	const attr = new StorageInstancedBufferAttribute( nodes, 4 );
	attr.copyRecordBase = nodes.copyRecordBase;
	const bvh = storage( attr, 'vec4', nodes.length / 4 ).toReadOnly();
	const tris = triangleStores( triangles );

	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( RAYS, 'vec4' );
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = traverseBVH( ray, bvh, tris ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( 70 ) ).toVar();
		out.element( instanceIndex ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( shadow.get( 'didHit' ) ), float( hit.get( 'didHit' ) ) ) );

	} )(), { alphaShadows: null } ).compute( RAYS );

	await renderer.computeAsync( kernel );
	return new Float32Array( await renderer.getArrayBufferAsync( out.value ) );

}

/** Every traversal over `bvh` (a node, or a split one): hit, shadow, camera-culled shadow, and the hit's world normal and instance. */
async function traceAll( renderer, bvh, triangles, { origins, dirs } ) {

	const tris = triangleStores( triangles );
	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( RAYS * 2, 'vec4' );
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = traverseBVH( ray, bvh, tris ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( 70 ) ).toVar();
		const culled = traverseBVHShadowCameraCulled( ray, bvh, tris, float( 70 ) ).toVar();
		out.element( instanceIndex.mul( 2 ) ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( shadow.get( 'didHit' ) ), float( culled.get( 'didHit' ) ) ) );
		out.element( instanceIndex.mul( 2 ).add( 1 ) ).assign( vec4( hit.get( 'normal' ), float( hit.get( 'instanceLeaf' ) ) ) );

	} )(), { alphaShadows: null } ).compute( RAYS );

	await renderer.computeAsync( kernel );
	return new Float32Array( await renderer.getArrayBufferAsync( out.value ) );

}

describeGPU( 'grouped instance traversal', () => {

	let renderer, parts, matrices, triangles, light;

	beforeAll( async () => {

		renderer = await createRenderer();
		parts = [ mesh( 0 ), mesh( 1.5 ) ];
		matrices = copies();
		triangles = new Uint32Array( PER_MESH * 2 * LANES );
		triangles.set( parts[ 0 ].triangles, 0 );
		triangles.set( parts[ 1 ].triangles, PER_MESH * LANES );
		light = rays();

	} );

	afterAll( () => renderer?.dispose() );

	it( 'puts one TLAS entry a copy, not one a member', () => {

		const plain = assemble( parts, matrices, { grouped: false } );
		const grouped = assemble( parts, matrices, { grouped: true } );
		expect( plain.table.entryCount ).toBe( COPIES * 2 );
		expect( grouped.table.entryCount ).toBe( COPIES );
		expect( grouped.table.tlasNodeCount ).toBe( COPIES * 2 - 1 );
		// One inner node joins the two members, then the empty leaf.
		expect( grouped.table.groupNodeCount ).toBe( 2 );
		expect( grouped.table.totalNodeCount ).toBeLessThan( plain.table.totalNodeCount );

	} );

	it( 'hits the same triangle at the same distance', async () => {

		const plain = await trace( renderer, assemble( parts, matrices, { grouped: false } ).nodes, triangles, light );
		const grouped = await trace( renderer, assemble( parts, matrices, { grouped: true } ).nodes, triangles, light );

		let hits = 0;
		for ( let i = 0; i < RAYS; i ++ ) {

			expect( grouped[ i * 4 + 3 ] ).toBe( plain[ i * 4 + 3 ] );
			if ( ! plain[ i * 4 + 3 ] ) continue;
			hits ++;
			expect( grouped[ i * 4 + 1 ] ).toBe( plain[ i * 4 + 1 ] );
			expect( grouped[ i * 4 ] ).toBe( plain[ i * 4 ] );
			expect( grouped[ i * 4 + 2 ] ).toBe( plain[ i * 4 + 2 ] );

		}

		expect( hits ).toBeGreaterThan( RAYS * 0.05 );

	} );

	it( 'drops a hidden member from every copy', async () => {

		const plain = await trace( renderer, assemble( parts, matrices, { grouped: false, hideB: true } ).nodes, triangles, light );
		const grouped = await trace( renderer, assemble( parts, matrices, { grouped: true, hideB: true } ).nodes, triangles, light );

		for ( let i = 0; i < RAYS; i ++ ) {

			expect( grouped[ i * 4 + 3 ] ).toBe( plain[ i * 4 + 3 ] );
			if ( ! grouped[ i * 4 + 3 ] ) continue;
			expect( grouped[ i * 4 + 1 ] ).toBeLessThan( PER_MESH );
			expect( grouped[ i * 4 + 1 ] ).toBe( plain[ i * 4 + 1 ] );
			expect( grouped[ i * 4 + 2 ] ).toBe( plain[ i * 4 + 2 ] );

		}

	} );

	it( 'keeps a hidden member out through a full and a partial refit', async () => {

		const plain = await trace( renderer, assemble( parts, matrices, { grouped: false, hideB: true } ).nodes, triangles, light );

		const full = assemble( parts, matrices, { grouped: true, hideB: true } );
		new BVHRefitter().refit( full.nodes, triangles, full.table.totalNodeCount );
		const partial = assemble( parts, matrices, { grouped: true, hideB: true } );
		const t = partial.table;
		new BVHRefitter().refitPartial( partial.nodes, triangles, [ t.tplBlasOffset[ 0 ], t.tplNodeCount[ 0 ] ], t.tlasNodeCount, [ t.groupNodeStart, t.groupNodeCount ] );

		for ( const { nodes } of [ full, partial ] ) {

			// The TLAS root's boxes stay within the scene: an empty child read back as a box would have grown them.
			for ( const v of nodes.subarray( 0, 15 ) ) expect( Math.abs( v ) ).toBeLessThan( 1e6 );
			const out = await trace( renderer, nodes, triangles, light );
			for ( let i = 0; i < RAYS; i ++ ) {

				expect( out[ i * 4 + 3 ] ).toBe( plain[ i * 4 + 3 ] );
				if ( out[ i * 4 + 3 ] ) expect( out[ i * 4 + 1 ] ).toBe( plain[ i * 4 + 1 ] );

			}

		}

	} );

	it( 'traces copy clusters as it traces one leaf a copy', async () => {

		const cases = [ {}, { hideB: true }, { grouped: true }, { grouped: true, hideB: true }, { hideSome: true }, { hideSome: true, later: true } ];
		for ( const { later, ...options } of cases ) {

			const plain = await trace( renderer, assemble( parts, matrices, options ).nodes, triangles, light );
			const built = assemble( parts, matrices, { ...options, hideSome: options.hideSome && ! later, clustered: true } );
			expect( built.table.clusterCount ).toBe( built.table.entryCount / 4 );
			// Hidden after the build, as the app hides a mesh: only that copy's flag in its leaf changes.
			if ( later ) {

				const stage = { _instanceTable: built.table, bvhStorageAttr: { array: built.nodes }, cpuTree: built.nodes };
				for ( let p = 0; p < COPIES * 2; p += 3 ) expect( PathTracerStage.prototype._patchTLASLeafVisibility.call( stage, p, false ) ).toBe( true );

			}

			const clustered = await trace( renderer, built.nodes, triangles, light );
			for ( let i = 0; i < RAYS; i ++ ) {

				expect( clustered[ i * 4 + 3 ] ).toBe( plain[ i * 4 + 3 ] );
				expect( clustered[ i * 4 + 2 ] ).toBe( plain[ i * 4 + 2 ] );
				if ( ! plain[ i * 4 + 3 ] ) continue;
				expect( clustered[ i * 4 + 1 ] ).toBe( plain[ i * 4 + 1 ] );
				expect( clustered[ i * 4 ] ).toBe( plain[ i * 4 ] );

			}

		}

	} );

	it( 'traces instances and copy clusters identically over BVH parts', async () => {

		for ( const options of [ {}, { grouped: true }, { clustered: true }, { hideSome: true, clustered: true } ] ) {

			const { nodes, table } = assemble( parts, matrices, options );
			const attr = new StorageInstancedBufferAttribute( nodes, 4 );
			attr.copyRecordBase = nodes.copyRecordBase;
			const single = await traceAll( renderer, storage( attr, 'vec4', nodes.length / 4 ).toReadOnly(), triangles, light );

			// Three parts: a boundary in the TLAS and one in a BLAS, or, over copy clusters, one in a BLAS and one through a
			// copy record (12 lanes, so records do straddle parts of whole nodes).
			const total = table.totalNodeCount, records = table.recordNodeStart;
			let partNodes = Math.ceil( total / 3 );
			if ( options.clustered ) {

				partNodes = Math.ceil( ( records + total ) / 4 );
				while ( ( partNodes * 2 - records ) % 3 === 0 ) partNodes ++;
				expect( partNodes * 2 ).toBeGreaterThan( records );

			} else expect( partNodes ).toBeLessThan( table.tlasNodeCount );

			const split = new StorageParts( nodes.length, 16, partNodes * 64, Float32Array );
			expect( split.attrs.length ).toBe( 3 );
			split.create( renderer.backend );
			split.write( renderer.backend, 0, nodes, 0, nodes.length );
			split.attrs[ 0 ].copyRecordBase = nodes.copyRecordBase;
			const parted = await traceAll( renderer, splitStorage( split.attrs.map( a => storage( a, 'vec4', a.count ).toReadOnly() ), split.elementsPerPart, 'vec4' ), triangles, light );

			let hits = 0;
			for ( let i = 0; i < RAYS * 8; i ++ ) expect( parted[ i ] ).toBe( single[ i ] );
			for ( let i = 0; i < RAYS; i ++ ) if ( single[ i * 8 + 7 ] >= 0 ) hits ++;
			expect( hits ).toBeGreaterThan( RAYS * 0.05 );

		}

	}, 30000 );

	it( 'traces the objects 4-wide under the binary top level as the binary tree, read from memory or disk, in one buffer or parts', async () => {

		// Every other chunk of 64 nodes on "disk".
		const onDisk = ( nodes ) => {

			const per = 64, count = nodes.length / 16, chunks = [];
			for ( let k = 0; k * per < count; k ++ ) chunks.push( k % 2 ? null : nodes.slice( k * per * 16, Math.min( count, ( k + 1 ) * per ) * 16 ) );
			return { recordsPerChunk: per, recordCount: count, lanesPerRecord: 16, chunks, _store: { _chunkBytes: per * 64, readAt: async ( at, bytes ) => nodes.buffer.slice( at, at + bytes ) } };

		};

		const compact = ( set, { disk = false, partBytes = Infinity } = {} ) => Object.assign( Object.create( PathTracerStage.prototype ), {
			renderer, bvhNodeCount: set.nodes.length / 16, _instanceTable: set.table, bufferPartBytes: partBytes, _bvhRecords: disk ? onDisk( set.nodes ) : null,
			// No triangle parts of its own, so three tree parts fit the default binding limit.
			_partCounts: { geo: 0, shade: 0 },
			bvhStorageAttr: { array: disk ? null : set.nodes, copyRecordBase: set.nodes.copyRecordBase, binaryOnly: true },
			_binaryFlat: disk ? null : set.nodes,
			// Small jobs: objects in several batches, copy records in several ranges.
			compactJobSize: 7,
		} );

		const binaryOf = ( set ) => traceAll( renderer, storage( Object.assign( new StorageInstancedBufferAttribute( set.nodes, 4 ), { copyRecordBase: set.nodes.copyRecordBase } ), 'vec4', set.nodes.length / 4 ).toReadOnly(), triangles, light );

		// Hits on the same triangle of the same instance, at distances and normals within `tolerance` (copy records are
		// packed to 32 B: a rotation kept to about a millionth); a ray grazing an edge may take its neighbour.
		const compare = ( reference, traced, tolerance ) => {

			let moved = 0, worst = 0, hits = 0;
			for ( let i = 0; i < RAYS; i ++ ) {

				const a = reference.subarray( i * 8, i * 8 + 8 ), b = traced.subarray( i * 8, i * 8 + 8 );
				if ( a[ 7 ] >= 0 ) hits ++;
				if ( a[ 1 ] !== b[ 1 ] || a[ 2 ] !== b[ 2 ] || a[ 3 ] !== b[ 3 ] || a[ 7 ] !== b[ 7 ] ) {

					if ( moved < 4 ) console.log( 'DIFF', i, Array.from( a ), Array.from( b ) );
					moved ++;
					continue;

				}

				if ( a[ 7 ] < 0 ) continue;
				worst = Math.max( worst, Math.abs( a[ 0 ] - b[ 0 ] ) / a[ 0 ], Math.abs( a[ 4 ] - b[ 4 ] ), Math.abs( a[ 5 ] - b[ 5 ] ), Math.abs( a[ 6 ] - b[ 6 ] ) );

			}

			expect( hits ).toBeGreaterThan( RAYS * 0.02 );
			if ( tolerance === 0 ) {

				expect( moved ).toBe( 0 );
				expect( worst ).toBe( 0 );

			} else {

				expect( moved ).toBeLessThan( RAYS * 0.002 );
				expect( worst ).toBeLessThan( tolerance );

			}

		};

		const cases = [ {}, { grouped: true }, { hideB: true }, { grouped: true, hideB: true }, { clustered: true }, { grouped: true, clustered: true }, { hideSome: true, clustered: true } ];
		for ( const options of cases ) {

			const set = assemble( parts, matrices, options );
			const binary = await binaryOf( set );

			let partBytes = Infinity;
			for ( const disk of [ false, true ] ) {

				const stage = compact( set, { disk, partBytes } );
				const stats = await stage.buildWideBVH();
				if ( ! disk && ! options.clustered && ! options.grouped && ! options.hideB ) {

					const back = new Uint32Array( await renderer.getArrayBufferAsync( stage.bvhStorageAttr ) );
					const bin = new Uint32Array( set.nodes.buffer );
					const leaves = [];
					for ( let n = 0; n < 239; n ++ ) if ( bin[ n * 16 + 3 ] === 0x40000001 ) leaves.push( [ n, bin[ n * 16 ], back[ n * 16 ], back[ n * 16 + 3 ].toString( 16 ) ] );
					let same = 0;
					for ( let n = 0; n < 239 * 16; n ++ ) if ( back[ n ] === bin[ n ] ) same ++;
					console.log( 'BACK', back.length / 16, same, 239 * 16, JSON.stringify( leaves.slice( 0, 4 ) ), Array.from( back.subarray( 239 * 16, 240 * 16 ) ).map( v => v.toString( 16 ) ).join( ' ' ) );

				}

				expect( stats.objectNodes ).toBeLessThan( ( stats.binaryNodes - stats.topNodes ) * 0.7 );
				expect( stats.parts ).toBe( disk ? 3 : 1 );
				expect( stats.copies ).toBe( options.clustered ? set.table.entryCount : 0 );
				compare( binary, await traceAll( renderer, stage.bvhStorageNode, triangles, light ), options.clustered ? 1e-4 : 0 );
				partBytes = Math.ceil( stats.bytes / 64 / 3 + 1 ) * 64;

			}

			if ( ! options.clustered ) continue;

			// A sheared copy keeps its whole record.
			const sheared = assemble( parts, shearSome( matrices ), options );
			const stage = compact( sheared );
			const stats = await stage.buildWideBVH();
			expect( stats.sheared ).toBeGreaterThan( sheared.table.entryCount / 4 );
			compare( await binaryOf( sheared ), await traceAll( renderer, stage.bvhStorageNode, triangles, light ), 1e-4 );

			// Edits after the build reach the GPU as the binary tree has them: copies hidden, and every copy record (packed
			// and sheared) written again.
			for ( let p = 0; p < COPIES * 2; p += 5 ) stage._patchTLASLeafVisibility( p, false );
			stage._flushBVHEdits();
			stage._writeTreeRecords( sheared.nodes.copyRecordBase * 4, sheared.table.entryCount * 12 );
			const edited = await binaryOf( sheared );
			expect( edited ).not.toEqual( await binaryOf( assemble( parts, shearSome( matrices ), options ) ) );
			compare( edited, await traceAll( renderer, stage.bvhStorageNode, triangles, light ), 1e-4 );

		}

	}, 60000 );

	it( 'refits copy clusters to where their copies are', async () => {

		const plain = await trace( renderer, assemble( parts, matrices, { grouped: true } ).nodes, triangles, light );
		const built = assemble( parts, matrices, { grouped: true, clustered: true } );
		// Scramble the leaf boxes, then let the refitter rebuild them from the records.
		const t = built.table;
		for ( let c = 0; c < t.clusterCount; c ++ ) for ( const slot of [ 1, 2, 4, 5, 6, 7, 8, 9, 10, 11 ] ) built.nodes[ t.clusterLeaf[ c ] * 16 + slot ] = 0;
		new BVHRefitter().refit( built.nodes, triangles, t.treeNodeCount, t.recordNodeStart );
		const out = await trace( renderer, built.nodes, triangles, light );
		for ( let i = 0; i < RAYS; i ++ ) {

			expect( out[ i * 4 + 3 ] ).toBe( plain[ i * 4 + 3 ] );
			if ( plain[ i * 4 + 3 ] ) expect( out[ i * 4 + 1 ] ).toBe( plain[ i * 4 + 1 ] );

		}

	} );

} );
