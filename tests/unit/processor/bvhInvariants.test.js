import { describe, it, expect, vi } from 'vitest';
import {
	BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry,
	Quaternion, SphereGeometry, TorusKnotGeometry, Vector3,
} from 'three';

vi.mock( '@/core/Processor/Workers/BVHWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( './bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/Processor/Workers/BVHWorker.js' ) ) };

} );

vi.mock( '@/core/Processor/Workers/BVHSubtreeWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( './bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/Processor/Workers/BVHSubtreeWorker.js' ) ) };

} );

vi.mock( '@/core/Processor/Workers/BVHRefitWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( './bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/Processor/Workers/BVHRefitWorker.js' ) ) };

} );

// Pieces of 160 triangles where the engine cuts 512k, so a test mesh splits as a 2M-triangle one does.
const SPLIT_PIECE = 160;
vi.mock( '@/core/Processor/SplitBLAS.js', async importOriginal => {

	const actual = await importOriginal();
	return { ...actual, partitionRange: ( records, start, count, piece, options ) => actual.partitionRange( records, start, count, Math.min( piece, SPLIT_PIECE ), options ) };

} );

import { inspectBVH } from './bvhInvariants.js';
import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';
import { foldLeaves } from '@/core/Processor/BVHLeafFold.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { PathTracerStage } from '@/core/Stages/PathTracerStage.js';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { StorageParts } from '@/core/TSL/patches.js';
import { TRIANGLE_DATA_LAYOUT } from '@/core/Processor/BufferLayout.js';

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
// Meshes past these build as the engine builds one past 200k (across workers) or 2M (in pieces) triangles.
const PARALLEL_FROM = 300;
const SPLIT_FROM = 600;

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function triangles( count, { spread = 30, size = 1 } = {} ) {

	const data = new Uint32Array( count * FPT );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < count; i ++ ) {

		const x = rand() * spread, y = rand() * spread, z = rand() * spread;
		f.set( [ x, y, z ], i * FPT );
		f.set( [ x + rand() * size, y, z ], i * FPT + 4 );
		f.set( [ x, y + rand() * size, z + rand() * size ], i * FPT + 8 );

	}

	return data;

}

function blas( data, { leaf = 4, depth = 30 } = {} ) {

	const builder = new BVHBuilder();
	builder.maxLeafSize = leaf;
	const nodes = builder.flattenBVH( builder.buildSync( data, depth ) );
	return { nodes, tris: builder.reorderedTriangleData };

}

function placed( object, position, rotation = null, scale = null ) {

	object.position.set( ...position );
	if ( rotation ) object.rotation.set( ...rotation );
	if ( scale ) object.scale.set( ...scale );
	return object;

}

function instanced( geometry, material, count, spread ) {

	const mesh = new InstancedMesh( geometry, material, count );
	const q = new Quaternion(), axis = new Vector3();
	for ( let i = 0; i < count; i ++ ) {

		q.setFromAxisAngle( axis.set( rand() - 0.5, rand() - 0.5, rand() - 0.5 ).normalize(), rand() * Math.PI * 2 );
		const s = 0.5 + rand();
		const at = new Vector3( rand() - 0.5, rand() - 0.5, rand() - 0.5 ).multiplyScalar( spread );
		mesh.setMatrixAt( i, new Matrix4().compose( at, q, new Vector3( s, s, s * ( 0.5 + rand() ) ) ) );

	}

	return mesh;

}

/** Baked meshes, one geometry placed three ways (one mirrored), a one-leaf BLAS, and instanced, emissive and grouped copies. */
function scene() {

	const mat = new MeshStandardMaterial();
	const sphere = new SphereGeometry( 1, 16, 12 );
	const parts = {
		knot: placed( new Mesh( new TorusKnotGeometry( 1, 0.3, 64, 8 ), mat ), [ 6, 0, 0 ] ),
		sphereA: placed( new Mesh( sphere, mat ), [ - 6, 0, 0 ] ),
		sphereB: placed( new Mesh( sphere, mat ), [ 0, 5, 0 ], [ 0.3, 0.2, 0.1 ], [ 1, 2, 0.5 ] ),
		mirrored: placed( new Mesh( sphere, mat ), [ 0, - 5, 2 ], null, [ - 1, 1, 1 ] ),
		plane: placed( new Mesh( new PlaneGeometry(), mat ), [ 0, 0, 7 ] ),
		glow: instanced( new BoxGeometry(), new MeshStandardMaterial( { emissive: 0xffffff, emissiveIntensity: 2 } ), 3, 8 ),
		crowd: instanced( new IcosahedronGeometry( 0.5, 1 ), mat, 6, 20 ),
		trunk: instanced( new BoxGeometry( 0.4, 2, 0.4 ), mat, 6, 24 ),
		leaves: new InstancedMesh( new SphereGeometry( 1, 8, 6 ), new MeshStandardMaterial(), 6 ),
		fruit: new InstancedMesh( new IcosahedronGeometry( 0.3, 0 ), new MeshStandardMaterial(), 6 ),
	};

	parts.leaves.instanceMatrix = parts.fruit.instanceMatrix = parts.trunk.instanceMatrix;
	const parent = placed( new Group(), [ 1, 2, 3 ], [ 0.4, - 0.3, 0.2 ] );
	parent.add( parts.sphereB );
	const root = new Group();
	root.add( parent, ...Object.values( parts ).filter( p => p !== parts.sphereB ) );
	root.updateMatrixWorld( true );
	return { root, parts };

}

async function build( root, { fold = false, split = false, parallel = false, ...options } = {} ) {

	const sp = new SceneProcessor( options );
	sp._foldLeaves = fold;
	if ( split || parallel ) sp._isLargeMesh = range => range.count > ( parallel ? PARALLEL_FROM : SPLIT_FROM );
	if ( split ) {

		const large = sp._buildLargeBLAS.bind( sp );
		sp._buildLargeBLAS = ( range, opts ) => ( range.count > SPLIT_FROM ? sp._buildSplitBLAS( range, opts ) : large( range, opts ) );

	}

	await sp._extractGeometry( root );
	await sp._buildBVH();
	return sp;

}

const inspect = sp => inspectBVH( sp.bvh, sp.triangles, { table: sp.instanceTable } );
const meshIndex = ( sp, object ) => sp.meshes.indexOf( object );

const stageOver = sp => Object.assign( Object.create( PathTracerStage.prototype ), {
	_instanceTable: sp.instanceTable, bvhStorageAttr: { array: sp.bvhData, version: 0, addUpdateRange() {} },
} );

const patchVisibility = sp => stageOver( sp )._patchVisibilityFromMeshes( sp.meshes );

/** What a caller hands a refit for template `t`: its triangles in their original order, in world space, moved. */
function movedPositions( sp, t, move ) {

	const table = sp.instanceTable;
	const p = table.tplOwner[ t ];
	const order = table.bvhToOriginalOf( p );
	const first = table.tplTriOffset[ t ], count = table.tplTriCount[ t ];
	const m = new Matrix4().fromArray( table.matrixWorldOf( p ) );
	const f = sp.triangleFloats;
	const out = new Float32Array( count * 9 );
	const v = new Vector3();
	for ( let s = 0; s < count; s ++ ) for ( let k = 0; k < 3; k ++ ) {

		const at = ( first + s ) * FPT + k * 4;
		move( v.set( f[ at ], f[ at + 1 ], f[ at + 2 ] ).applyMatrix4( m ) );
		out.set( [ v.x, v.y, v.z ], ( order ? order[ s ] : s ) * 9 + k * 3 );

	}

	return out;

}

const twist = v => v.set( v.x + 0.6 * Math.sin( v.y * 1.7 ), v.y * 1.4 + 0.3, v.z - 0.4 * Math.cos( v.x ) );

// The first lane whose bits differ, or -1: vitest takes minutes to diff two whole buffers.
function firstDifference( a, b ) {

	const x = new Uint32Array( a.buffer, a.byteOffset, a.length ), y = new Uint32Array( b.buffer, b.byteOffset, b.length );
	return x.length === y.length ? x.findIndex( ( v, i ) => v !== y[ i ] ) : Math.min( x.length, y.length );

}

const VARIANTS = {
	'plain': {},
	'folded': { fold: true },
	'split': { split: true },
	'parallel': { parallel: true },
	'clustered': { clusterCopies: true },
	'folded, split, parallel and clustered': { fold: true, split: true, parallel: true, clusterCopies: true },
};

describe( 'a BLAS from BVHBuilder', () => {

	it( 'reaches every triangle once through boxes that hold exactly what is under them, at any leaf size, folded or not', () => {

		for ( const options of [ { leaf: 1 }, { leaf: 4 }, { leaf: 8 }, { leaf: 20 }, { leaf: 4, depth: 8 } ] ) {

			const { nodes, tris } = blas( triangles( 2500 ), options );
			const plain = inspectBVH( nodes, tris );
			expect( plain.problems ).toEqual( [] );
			expect( plain.stats.unreached ).toBe( 0 );

			const folded = inspectBVH( foldLeaves( nodes ), tris, { folded: true } );
			expect( folded.problems ).toEqual( [] );
			expect( folded.stats.foldedLeaves ).toBeGreaterThan( 0 );
			if ( options.leaf > 15 || options.depth ) expect( folded.stats.leafNodes ).toBeGreaterThan( 0 );

		}

	} );

	it( 'stays sound on input no split can divide: one point, one plane, one triangle', () => {

		const flat = triangles( 300 );
		const f = new Float32Array( flat.buffer );
		for ( let i = 0; i < 300; i ++ ) for ( const v of [ 0, 4, 8 ] ) f[ i * FPT + v + 1 ] = 2;

		for ( const data of [ triangles( 300, { spread: 0, size: 0 } ), flat, triangles( 1 ) ] ) {

			const { nodes, tris } = blas( data );
			expect( inspectBVH( nodes, tris ).problems ).toEqual( [] );
			expect( inspectBVH( foldLeaves( nodes ), tris, { folded: true } ).problems ).toEqual( [] );

		}

	} );

	it( 'refits to boxes that hold the moved triangles, folded or not', () => {

		const { nodes, tris } = blas( triangles( 2000 ) );
		const f = new Float32Array( tris.buffer );
		for ( let i = 0; i < f.length; i += FPT ) for ( const v of [ 0, 4, 8 ] ) {

			f[ i + v ] = f[ i + v ] * 1.3 + Math.sin( f[ i + v + 1 ] );
			f[ i + v + 2 ] -= 5;

		}

		for ( const [ tree, folded ] of [[ nodes.slice(), false ], [ foldLeaves( nodes ), true ]] ) {

			expect( inspectBVH( tree, tris, { folded } ).problems ).not.toEqual( [] );
			new BVHRefitter().refit( tree, tris, tree.length / 16 );
			expect( inspectBVH( tree, tris, { folded } ).problems ).toEqual( [] );

		}

	} );

} );

describe( 'an empty scene', () => {

	it( 'is one empty triangle leaf, not a node that is its own child', () => {

		let nodes = null, tris = null;
		const app = {
			isInitialized: true, _releaseSceneState() {}, _dropDisplay() {}, reset() {}, dispatchEvent() {},
			stages: { pathTracer: {
				setTriangleData: t => tris = t, setBVHData: n => nodes = n, materialData: { setMaterialData() {} }, setupMaterial() {},
			} },
		};
		RayzeeRenderer.prototype.unloadScene.call( app );

		for ( const folded of [ false, true ] ) {

			const { problems, stats } = inspectBVH( nodes, tris, { folded, triangleRange: [ 0, 0 ] } );
			expect( problems ).toEqual( [] );
			expect( stats.leafNodes ).toBe( 1 );

		}

	} );

} );

describe( 'a scene from SceneProcessor', () => {

	for ( const [ name, options ] of Object.entries( VARIANTS ) ) {

		it( `${name}: one TLAS entry a placement or group copy, each over a sound BLAS or group tree`, async () => {

			const { root } = scene();
			const { problems, stats } = inspect( await build( root, options ) );
			expect( problems ).toEqual( [] );
			expect( stats.groupCopies ).toBe( 6 );
			expect( stats.identityCopies ).toBeGreaterThan( 0 );
			expect( options.clusterCopies ? stats.clusterLeaves : stats.pointerLeaves ).toBeGreaterThan( 0 );
			if ( options.fold ) expect( stats.foldedLeaves ).toBeGreaterThan( 0 );
			// A parallel build leaves each subtree's root behind once it is copied over its frontier leaf; folding drops it.
			if ( ! options.parallel || options.fold ) expect( stats.unreached ).toBe( 0 );

		} );

	}

	it( 'keeps meshes without triangles out of the TLAS, and a stray vertex out of every box, through a refit', async () => {

		for ( const options of [ {}, { clusterCopies: true } ] ) {

			const { root, parts } = scene();
			const stray = new BufferGeometry();
			stray.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5 ], 3 ) );
			const noIndices = new BoxGeometry();
			noIndices.setIndex( [] );
			root.add( new Mesh(), new Mesh( noIndices, new MeshStandardMaterial() ), placed( new Mesh( stray, new MeshStandardMaterial() ), [ 2, 2, 2 ] ) );
			root.updateMatrixWorld( true );

			const sp = await build( root, options );
			expect( inspect( sp ).problems ).toEqual( [] );
			await sp.refitBVH( mesh => ( mesh === meshIndex( sp, parts.knot ) ? movedPositions( sp, mesh, twist ) : null ) );
			expect( inspect( sp ).problems ).toEqual( [] );

		}

	} );

	it( 'builds a large mesh in pieces, and a mid-sized one across workers', async () => {

		const { root, parts } = scene();
		const plain = await build( root );
		const large = await build( root, { split: true, parallel: true } );
		const nodes = ( sp, part ) => sp.instanceTable.tplNodeCount[ meshIndex( sp, part ) ];
		expect( nodes( large, parts.knot ) ).not.toBe( nodes( plain, parts.knot ) );
		expect( nodes( large, parts.sphereA ) ).not.toBe( nodes( plain, parts.sphereA ) );
		expect( inspect( large ).problems ).toEqual( [] );

	} );

	it( 'hides a grouped member behind BVH_EMPTY_BOX and a whole copy by its leaf, through toggles and a refit', async () => {

		for ( const options of [ {}, { clusterCopies: true }, { fold: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			parts.leaves.visible = parts.crowd.visible = false;
			patchVisibility( sp );
			const hidden = inspect( sp );
			expect( hidden.problems ).toEqual( [] );
			expect( hidden.stats.emptySlots ).toBeGreaterThan( 0 );
			expect( hidden.stats.hiddenCopies ).toBe( 6 );

			parts.leaves.visible = true;
			patchVisibility( sp );
			expect( inspect( sp ).problems ).toEqual( [] );

			parts.trunk.visible = parts.leaves.visible = parts.fruit.visible = false;
			patchVisibility( sp );
			expect( inspect( sp ).stats.hiddenCopies ).toBe( 12 );

			await sp.refitBVH( mesh => ( mesh === meshIndex( sp, parts.trunk ) ? movedPositions( sp, mesh, twist ) : null ) );
			expect( inspect( sp ).problems ).toEqual( [] );

			const table = sp.instanceTable;
			const refitOnly = sp.bvhData.slice();
			new BVHRefitter().refit( refitOnly, sp.triangles, table.treeNodeCount, table.clusterCount ? table.recordNodeStart : - 1 );
			expect( inspectBVH( refitOnly, sp.triangles, { table, folded: sp.bvh.foldedLeaves === true } ).problems ).toEqual( [] );

		}

	} );

	it( 'patches no leaf whose flag already stands, and only those that change', async () => {

		for ( const options of [ {}, { clusterCopies: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const table = sp.instanceTable;
			const stage = stageOver( sp );
			const leaves = () => [ ...( stage._dirtyBVHLeaves ?? [] ) ].filter( n => n < table.groupNodeStart || n >= table.groupNodeStart + table.groupNodeCount );
			const before = sp.bvhData.slice();

			stage._patchVisibilityFromMeshes( sp.meshes );
			expect( leaves() ).toEqual( [] );
			expect( firstDifference( sp.bvhData, before ) ).toBe( - 1 );

			parts.knot.visible = false;
			stage._patchVisibilityFromMeshes( sp.meshes );
			const knot = meshIndex( sp, parts.knot );
			const run = table.placementRunOf( knot );
			expect( leaves().length ).toBe( run.count );
			expect( inspect( sp ).problems ).toEqual( [] );
			for ( let p = run.start; p < run.start + run.count; p ++ ) expect( table.visible[ p ] ).toBe( 0 );

		}

	} );

	it( 'hides every placement of the mesh it is asked to, one mesh at a time', async () => {

		for ( const options of [ {}, { clusterCopies: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const table = sp.instanceTable;
			const stage = stageOver( sp );
			for ( const part of [ parts.crowd, parts.leaves, parts.knot ] ) stage.updateMeshVisibility( meshIndex( sp, part ), false );

			const { problems, stats } = inspect( sp );
			expect( problems ).toEqual( [] );
			expect( stats.hiddenCopies ).toBe( 7 );
			for ( let p = 0; p < table.count; p ++ ) {

				const hidden = [ parts.crowd, parts.leaves, parts.knot ].includes( sp.meshes[ table.sourceMesh[ p ] ] );
				expect( table.visible[ p ] ).toBe( hidden ? 0 : 1 );

			}

		}

	} );

	it( 'finds a grouped member hidden through a worker refit inside every copy\'s box once it is shown again', async () => {

		for ( const options of [ {}, { clusterCopies: true }, { fold: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			parts.leaves.visible = false;
			patchVisibility( sp );
			await sp.refitBVH( mesh => ( mesh === meshIndex( sp, parts.knot ) ? movedPositions( sp, mesh, twist ) : null ) );
			parts.leaves.visible = true;
			patchVisibility( sp );
			expect( inspect( sp ).problems ).toEqual( [] );

		}

	} );

} );

describe( 'a refit', () => {

	for ( const [ name, options ] of Object.entries( VARIANTS ) ) {

		it( `${name}: through the worker in part is bit-identical to a full refit, and in full keeps every invariant`, async () => {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const table = sp.instanceTable;
			const deformed = [ parts.knot, parts.trunk, parts.sphereA ].map( p => meshIndex( sp, p ) );

			await sp.refitBVH( mesh => ( deformed.includes( mesh ) ? movedPositions( sp, mesh, twist ) : null ) );
			expect( inspect( sp ).problems ).toEqual( [] );

			const full = sp.bvhData.slice();
			new BVHRefitter().refit( full, sp.triangles, table.treeNodeCount, table.clusterCount ? table.recordNodeStart : - 1 );
			expect( firstDifference( full, sp.bvhData ) ).toBe( - 1 );

			await sp.refitBVH( mesh => movedPositions( sp, mesh, v => v.multiplyScalar( 0.7 ) ) );
			expect( inspect( sp ).problems ).toEqual( [] );

		} );

	}

	it( 'of chosen meshes on the main thread (refitBLASes) keeps every invariant', async () => {

		for ( const options of [ {}, VARIANTS[ 'folded, split, parallel and clustered' ] ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const meshes = [ parts.knot, parts.crowd, parts.leaves ].map( p => meshIndex( sp, p ) );
			sp.refitBLASes( meshes, mesh => movedPositions( sp, mesh, twist ) );
			expect( inspect( sp ).problems ).toEqual( [] );

		}

	} );

	it( 'on the main thread is followed by a background rebuild that swaps in, folded or not', async () => {

		for ( const options of [ {}, { fold: true }, { clusterCopies: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const knot = meshIndex( sp, parts.knot );
			sp.refitBLASes( [ knot ], mesh => movedPositions( sp, mesh, twist ) );
			let swapped = false;
			sp.scheduleBackgroundRebuild( [ knot ], () => swapped = true );
			await vi.waitFor( () => expect( sp._pendingRebuilds.size ).toBe( 0 ), { timeout: 4000, interval: 5 } );
			expect( swapped ).toBe( true );
			expect( inspect( sp ).problems ).toEqual( [] );

		}

	} );

	it( 'through the worker leaves what a later move or main-thread refit boxes the mesh by', async () => {

		for ( const options of [ {}, { clusterCopies: true } ] ) {

			const { root, parts } = scene();
			const sp = await build( root, options );
			const grown = [ parts.knot, parts.trunk ].map( p => meshIndex( sp, p ) );
			await sp.refitBVH( mesh => ( grown.includes( mesh ) ? movedPositions( sp, mesh, v => v.multiplyScalar( 1.8 ) ) : null ) );

			for ( const part of [ parts.knot, parts.leaves ] ) {

				part.position.x += 1;
				part.updateMatrixWorld( true );

			}

			sp.updateMeshTransforms( [ parts.knot, parts.leaves ].map( p => meshIndex( sp, p ) ) );
			expect( inspect( sp ).problems ).toEqual( [] );

			sp.refitBLASes( [ meshIndex( sp, parts.plane ) ], mesh => movedPositions( sp, mesh, twist ) );
			expect( inspect( sp ).problems ).toEqual( [] );

		}

	} );

} );

describe( 'moving objects (updateMeshTransforms)', () => {

	for ( const [ name, options ] of Object.entries( VARIANTS ) ) {

		it( `${name}: rewrites leaves and boxes as a full TLAS refit would`, async () => {

			const { root, parts } = scene();
			const sp = await build( root, options );

			parts.knot.position.set( - 30, 4, 2 );
			parts.knot.rotation.set( 1, 2, 3 );
			parts.sphereB.parent.rotation.y += 1.2;
			parts.crowd.position.set( 0, 12, - 9 );
			parts.leaves.position.set( 3, 0, 40 );
			const moved = [ parts.knot, parts.sphereB, parts.crowd, parts.leaves ];
			for ( const p of moved ) p.updateMatrixWorld( true );

			sp.updateMeshTransforms( moved.map( p => meshIndex( sp, p ) ) );
			expect( inspect( sp ).problems ).toEqual( [] );

			const partial = sp.bvhData.slice();
			sp._refitTLAS();
			expect( firstDifference( partial, sp.bvhData ) ).toBe( - 1 );

		} );

	}

} );

describe( 'buffer parts', () => {

	it( 'hold whole nodes and carry the BVH across them unchanged', async () => {

		const { root } = scene();
		const sp = await build( root, { clusterCopies: true } );
		const lanes = sp.bvh.recordCount * 16;
		const parts = new StorageParts( lanes, 16, 64 * 37 + 20, Float32Array );
		const gpu = new Map( parts.attrs.map( attr => [ attr, new Float32Array( attr.gpuByteLength / 4 ) ] ) );
		const backend = {
			createStorageAttribute() {},
			get: attr => ( { buffer: gpu.get( attr ) } ),
			device: { queue: { writeBuffer: ( buffer, byteOffset, src, srcOffset, n ) => buffer.set( src.subarray( srcOffset, srcOffset + n ), byteOffset / 4 ) } },
		};
		parts.writeRecords( backend, sp.bvh, 0, lanes );

		expect( parts.attrs.length ).toBeGreaterThan( 2 );
		for ( const part of gpu.values() ) expect( part.length % 16 ).toBe( 0 );
		const joined = new Float32Array( lanes );
		let at = 0;
		for ( const part of gpu.values() ) {

			joined.set( part, at );
			at += part.length;

		}

		expect( firstDifference( joined, sp.bvhData ) ).toBe( - 1 );

	} );

} );
