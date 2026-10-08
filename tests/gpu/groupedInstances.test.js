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

vi.mock( '@/core/Processor/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';
import { rebaseNodes } from '@/core/Processor/BVHLeafFold.js';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';
import { PathTracerStage } from '@/core/Stages/PathTracerStage.js';
import { traverseBVH, traverseBVHShadow } from '@/core/TSL/BVHTraversal.js';
import { Ray } from '@/core/TSL/Struct.js';
import { withSceneResources } from '@/core/TSL/SceneResources.js';
import { TRI_SIDE_SHIFT } from '@/core/Processor/BufferLayout.js';

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

async function trace( renderer, nodes, triangles, { origins, dirs } ) {

	const attr = new StorageInstancedBufferAttribute( nodes, 4 );
	attr.copyRecordBase = nodes.copyRecordBase;
	const bvh = storage( attr, 'vec4', nodes.length / 4 ).toReadOnly();
	const count = triangles.length / LANES;
	const geo = new Uint32Array( count * 12 ), shade = new Uint32Array( count * 8 );
	for ( let i = 0; i < count; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	const tris = {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', count * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', count * 2 ).toReadOnly(),
	};

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

				const stage = { _instanceTable: built.table, bvhStorageAttr: { array: built.nodes } };
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
