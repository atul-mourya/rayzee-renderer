import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock( '@/core/bvh/BVHWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( './bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/bvh/BVHWorker.js' ) ) };

} );
vi.mock( '@/core/bvh/BVHSubtreeWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( './bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/bvh/BVHSubtreeWorker.js' ) ) };

} );
// Chunks of 16 KB where the engine cuts 64 MB: this scene's few thousand triangles span a dozen chunks, its meshes and
// BLASes crossing their edges as a 50M-triangle scene's do, and every store built here is chunked alike.
const CHUNK_BYTES = vi.hoisted( () => 16 * 1024 );
vi.mock( '@/core/memory/ChunkedRecords.js', async importOriginal => {

	const actual = await importOriginal();
	class ChunkedRecords extends actual.ChunkedRecords {

		constructor( count, lanes, Type, max = CHUNK_BYTES, shared = false ) {

			super( count, lanes, Type, max, shared );

		}

		// The module's own methods make stores of the class it holds.
		static [ Symbol.hasInstance ]( value ) {

			return value instanceof actual.ChunkedRecords;

		}

		static lazy( count, lanes, Type, max = CHUNK_BYTES, shared = false ) {

			return actual.ChunkedRecords.lazy( count, lanes, Type, max, shared );

		}

	}

	return { ...actual, ChunkedRecords, DEFAULT_CHUNK_BYTES: CHUNK_BYTES };

} );

// Pieces of 160 triangles where the engine cuts 512k, so a test mesh splits as a 2M-triangle one does.
vi.mock( '@/core/bvh/SplitBLAS.js', async importOriginal => {

	const actual = await importOriginal();
	return { ...actual, partitionRange: ( records, start, count, piece, options ) => actual.partitionRange( records, start, count, Math.min( piece, 160 ), options ) };

} );

import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage, acquireSharedStorage } from '@/core/addons/storage/OpenStorage.js';
import { getAssetConfig } from '@/core/AssetConfig.js';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';
import { inspectBVH, scene } from './bvhInvariants.js';

const inspect = sp => inspectBVH( sp.bvh, sp.triangles, { table: sp.instanceTable } );
const all = store => store.single ?? store.copyOf( 0, store.recordCount );
// The first lane whose bits differ, or -1: vitest takes minutes to diff two whole buffers.
function firstDifference( a, b ) {

	const x = new Uint32Array( a.buffer, a.byteOffset, a.length ), y = new Uint32Array( b.buffer, b.byteOffset, b.length );
	return x.length === y.length ? x.findIndex( ( v, i ) => v !== y[ i ] ) : Math.min( x.length, y.length );

}

const VARIANTS = {
	'plain': {},
	'folded': { fold: true },
	'clustered': { clusterCopies: true },
	'folded and clustered': { fold: true, clusterCopies: true },
	// Meshes past these build as the engine builds one past 200k (across workers) or 2M (in pieces) triangles.
	'split': { split: true },
	'parallel': { parallel: true },
	'folded, split, parallel and clustered': { fold: true, split: true, parallel: true, clusterCopies: true },
};
const PARALLEL_FROM = 300;
const SPLIT_FROM = 600;
const BASIC = Object.fromEntries( Object.entries( VARIANTS ).slice( 0, 4 ) );

describe( 'a BVH built through disk', () => {

	let uninstall, storage;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	const processor = ( { fold = false, split = false, parallel = false, ...options } = {} ) => {

		const sp = new SceneProcessor( options );
		sp._foldLeaves = fold;
		sp.bvhBuilder.foldLeaves = fold;
		if ( split || parallel ) sp._isLargeMesh = range => range.count > ( parallel ? PARALLEL_FROM : SPLIT_FROM );
		if ( split ) {

			const large = sp._buildLargeBLAS.bind( sp );
			sp._buildLargeBLAS = ( range, opts ) => ( range.count > SPLIT_FROM ? sp._buildSplitBLAS( range, opts ) : large( range, opts ) );

		}

		return sp;

	};

	const progressive = ( uploaded ) => ( { storage, uploader: ( _records, kind ) => async k => void uploaded.push( `${kind ?? 'nodes'}:${k}` ) } );

	// As buildBVH runs a spilling scene past one chunk: extraction and the BLAS builds together, each chunk uploaded once
	// its BLASes are built and written to disk.
	// The extraction pauses every 150 triangles (the engine's 1M), so the BLAS builds and uploads run while it does.
	async function streamed( root, options ) {

		const sp = processor( options );
		const uploaded = [];
		let pauses = 0;
		const extract = sp.geometryExtractor.extractStreaming.bind( sp.geometryExtractor );
		sp.geometryExtractor.extractStreaming = ( object, opts ) => extract( object, { ...opts, yieldEvery: 150, pause: async ( ...a ) => {

			pauses ++;
			return opts.pause?.( ...a );

		} } );
		sp._progressive = progressive( uploaded );
		sp._streaming = true;
		await sp._extractStreaming( root );
		await sp._buildBVH();
		sp._buildEmissiveData();
		const spilled = sp.spilled;
		await sp._restoreGeometry( root );
		return { sp, uploaded, pauses, spilled };

	}

	async function inMemory( root, options ) {

		const sp = processor( options );
		await sp._extractGeometry( root );
		await sp._buildBVH();
		sp._buildEmissiveData();
		return sp;

	}

	const same = ( sp, plain ) => {

		expect( firstDifference( all( sp.bvh ), all( plain.bvh ) ) ).toBe( - 1 );
		expect( firstDifference( all( sp.triangles ), all( plain.triangles ) ) ).toBe( - 1 );
		expect( sp.emissiveTriangleCount ).toBeGreaterThan( 0 );
		expect( sp.emissiveTriangleCount ).toBe( plain.emissiveTriangleCount );
		expect( firstDifference( sp.emissiveTriangleData, plain.emissiveTriangleData ) ).toBe( - 1 );

	};

	for ( const [ name, options ] of Object.entries( VARIANTS ) ) {

		it( `${name}: keeps every invariant across chunk edges and is the in-memory build bit for bit`, async () => {

			const { root } = scene();
			const { sp, uploaded, pauses, spilled } = await streamed( root, options );
			expect( sp.triangles.chunks.length ).toBeGreaterThan( 4 );
			expect( pauses ).toBeGreaterThan( 2 );
			// Built through disk: every triangle chunk and node chunk sent up, most of them then written out.
			expect( spilled ).toBe( true );
			expect( uploaded.filter( u => u.startsWith( 'triangles' ) ).length ).toBe( sp.triangles.chunks.length );
			expect( uploaded.filter( u => u.startsWith( 'nodes' ) ).length ).toBeGreaterThan( 0 );
			await sp.ensureResident();

			const { problems, stats } = inspect( sp );
			expect( problems ).toEqual( [] );
			expect( stats.unreached ).toBe( 0 );
			if ( options.fold ) expect( stats.foldedLeaves ).toBeGreaterThan( 0 );
			if ( options.clusterCopies ) expect( stats.clusterLeaves ).toBeGreaterThan( 0 );

			const plain = await inMemory( scene().root, options );
			same( sp, plain );
			sp.dispose();
			plain.dispose();

		} );

	}

	// Storage refused the streaming build's own stores: extracted in memory, then spilled chunk by chunk as each one's
	// BLASes are built (`_beginProgressiveSpill`).
	for ( const [ name, options ] of Object.entries( BASIC ) ) {

		it( `${name}: spilled after an in-memory extraction, is the in-memory build bit for bit`, async () => {

			const sp = processor( options );
			const uploaded = [];
			sp._progressive = progressive( uploaded );
			await sp._extractGeometry( scene().root );
			await sp._buildBVH();
			sp._buildEmissiveData();
			expect( uploaded.filter( u => u.startsWith( 'triangles' ) ).length ).toBe( sp.triangles.chunks.length );
			if ( sp.spilled ) await sp.ensureResident();
			expect( inspect( sp ).problems ).toEqual( [] );
			const plain = await inMemory( scene().root, options );
			same( sp, plain );
			sp.dispose();
			plain.dispose();

		} );

	}

	it( 'comes back from a spill to disk bit for bit, every invariant kept', async () => {

		const { root } = scene();
		const sp = await inMemory( root );
		expect( sp.triangles.chunks.length ).toBeGreaterThan( 4 );
		const before = [ all( sp.bvh ), all( sp.triangles ) ];
		expect( await sp.spillToDisk( storage ) ).not.toBeNull();
		expect( sp.spilled ).toBe( true );
		await sp.ensureResident();
		expect( sp.spilled ).toBe( false );
		expect( firstDifference( all( sp.bvh ), before[ 0 ] ) ).toBe( - 1 );
		expect( firstDifference( all( sp.triangles ), before[ 1 ] ) ).toBe( - 1 );
		expect( inspect( sp ).problems ).toEqual( [] );
		sp.dispose();

	} );

} );

describe( 'a stored BVH restored', () => {

	let uninstall, shared;

	beforeEach( async () => {

		uninstall = createFakeOPFS().install();
		shared = await acquireSharedStorage( getAssetConfig().cacheNamespace );

	} );

	afterEach( () => {

		shared.release();
		uninstall();

	} );

	for ( const [ name, { fold = false, ...options } ] of Object.entries( BASIC ) ) {

		it( `${name}: keeps every invariant across chunk edges and is the fresh build bit for bit`, async () => {

			const build = async () => {

				const sp = Object.assign( new SceneProcessor( options ), { _sceneKey: `scene ${name}` } );
				sp._foldLeaves = fold;
				sp.bvhBuilder.foldLeaves = fold;
				await sp._extractGeometry( scene().root );
				await sp._buildBVH();
				return sp;

			};

			const fresh = await build();
			expect( fresh.triangles.chunks.length ).toBeGreaterThan( 4 );
			expect( await fresh._storeBLASes( 'test' ) ).toBe( true );
			const again = await build();
			expect( again._blasRestored ).toBe( true );

			const { problems, stats } = inspect( again );
			expect( problems ).toEqual( [] );
			if ( fold ) expect( stats.foldedLeaves ).toBeGreaterThan( 0 );
			expect( firstDifference( all( again.bvh ), all( fresh.bvh ) ) ).toBe( - 1 );
			expect( firstDifference( all( again.triangles ), all( fresh.triangles ) ) ).toBe( - 1 );
			fresh.dispose();
			again.dispose();

		} );

	}

} );
