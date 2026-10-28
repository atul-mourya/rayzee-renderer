import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataTexture, FloatType, Group, InstancedBufferAttribute, Mesh, RGBAFormat, SphereGeometry } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { SpillStore } from '@/core/storage/SpillStore.js';
import { GeometrySpill } from '@/core/storage/GeometrySpill.js';
import { ChunkedRecords } from '@/core/memory/ChunkedRecords.js';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';
import { SPILL_ENVIRONMENT_WIDTH, SPILL_PLACEMENT_BUDGET, SPILL_TRIANGLE_BUDGET } from '@/core/memory/HostMemory.js';
import { EngineEvents } from '@/core/EngineEvents.js';
import { ISSUE_CODES } from '@/core/EngineIssues.js';
import {
	needsSpill, spillToDisk, ensureResident, ensureGeometryResident, ensureMovable, spillTLAS, spillOrderMaps, spillAfterLoad, respill, whenTLASEditable,
	needsPageInForMove, restoreGeometry, disposeSpill, disposeMatrixSpill, disposeGeometrySpill, setMemorySpill, sceneBudgets,
	planSpill, progressiveSpill, chunkUploader, maybeSpill, scheduleRespill, ensureSceneResident,
} from '@/core/memory/SceneSpill.js';

const records = ( count, lanes, Type, perChunk, value ) => {

	const r = new ChunkedRecords( count, lanes, Type, perChunk * lanes * Type.BYTES_PER_ELEMENT );
	for ( let i = 0; i < count; i ++ ) r.setRecords( i, Type.from( { length: lanes }, ( _, l ) => value( i, l ) ) );
	return r;

};

const scene = () => {

	const sp = new SceneProcessor();
	sp.triangles = records( 10, 4, Uint32Array, 3, ( i, l ) => i * 10 + l );
	sp.bvh = records( 8, 16, Float32Array, 2, ( i, l ) => i + l / 100 );
	sp.instanceTable = { blasBase: 3 };
	return sp;

};

const flush = () => new Promise( r => setTimeout( r, 0 ) );

describe( 'spilling a scene to disk', () => {

	let uninstall, storage;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );

	} );

	afterEach( () => {

		vi.restoreAllMocks();
		storage.dispose();
		uninstall();

	} );

	it( 'moves triangles and BLAS nodes to disk, keeping the TLAS, and pages them back once', async () => {

		const sp = scene();
		const before = [ sp.triangles.copyOf( 0, 10 ), sp.bvh.copyOf( 0, 8 ) ];

		const result = await spillToDisk( sp, storage );
		expect( result.bytes ).toBe( 10 * 16 + 4 * 64 );
		expect( sp.triangles.spilledChunks ).toBe( 4 );
		expect( sp.bvh.isResident( 0, 4 ) ).toBe( true );
		expect( sp.bvh.isResident( 4, 1 ) ).toBe( false );
		expect( sp.spilled ).toBe( true );
		expect( await spillToDisk( sp, storage ) ).toBeNull();

		const paging = ensureResident( sp );
		expect( ensureResident( sp ) ).toBe( paging );
		await paging;
		expect( sp._paging ).toBeNull();
		expect( sp.spilled ).toBe( false );
		expect( sp._spillStores ).toBeNull();
		expect( sp.triangles.copyOf( 0, 10 ) ).toEqual( before[ 0 ] );
		expect( sp.bvh.copyOf( 0, 8 ) ).toEqual( before[ 1 ] );
		await vi.waitFor( async () => expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 ) );

	} );

	it( 'spills only a chunked, unspilled scene, and only with storage', async () => {

		expect( await spillToDisk( scene(), null ) ).toBeNull();

		const single = scene();
		single.triangles = records( 2, 4, Uint32Array, 3, () => 1 );
		expect( await spillToDisk( single, storage ) ).toBeNull();

		const flat = scene();
		flat.bvh = new Float32Array( 16 );
		expect( await spillToDisk( flat, storage ) ).toBeNull();

		expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 );

	} );

	it( 'gives up on a scene that changed while it was written', async () => {

		const sp = scene();
		sp._geometryVersion = 1;
		const spill = sp.triangles.spill.bind( sp.triangles );
		sp.triangles.spill = async ( ...args ) => {

			sp._geometryVersion ++;
			return spill( ...args );

		};

		expect( await spillToDisk( sp, storage ) ).toBeNull();

	} );

	it( 'leaves nothing behind when the second store finds no room', async () => {

		const create = SpillStore.create.bind( SpillStore );
		vi.spyOn( SpillStore, 'create' ).mockImplementationOnce( create ).mockResolvedValueOnce( null );
		const sp = scene();

		expect( await spillToDisk( sp, storage ) ).toBeNull();
		expect( sp._spillStores ).toBeFalsy();
		expect( sp.triangles.spilledChunks ).toBe( 0 );
		await vi.waitFor( async () => expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 ) );

	} );

	it( 'sends the TLAS to disk but the group trees, and reads it back once for an edit', async () => {

		const sp = scene();
		sp._bvhSpillStore = await SpillStore.create( storage, 'spill:tlas', 2 * 16 * 4 );
		sp.instanceTable = { blasBase: 4, clusterCount: 1, groupNodeStart: 2, groupNodeCount: 2 };
		sp.sceneBounds = () => 'root bounds';
		const before = sp.bvh.copyOf( 0, 8 );

		await spillTLAS( sp );
		expect( [ 0, 2, 4, 6 ].map( n => sp.bvh.isResident( n, 2 ) ) ).toEqual( [ false, true, false, false ] );
		expect( sp._spilledRootBounds ).toBe( 'root bounds' );

		const reading = whenTLASEditable( sp );
		expect( whenTLASEditable( sp ) ).toBe( reading );
		await reading;
		expect( sp.bvh.isResident( 0, 4 ) ).toBe( true );
		expect( sp._tlasReading ).toBeNull();
		expect( whenTLASEditable( sp ) ).toBeNull();
		expect( sp.bvh.copyOf( 0, 4 ) ).toEqual( before.subarray( 0, 64 ) );

		sp.instanceTable.groupNodeCount = 0;
		await spillTLAS( sp );
		expect( sp.bvh.isResident( 2, 2 ) ).toBe( false );
		await sp._bvhSpillStore.dispose();

	} );

	it( 'spills no TLAS without copy clusters or a store, and waits for a spill in flight before an edit', async () => {

		const sp = scene();
		sp.instanceTable = { blasBase: 4, clusterCount: 0 };
		sp._bvhSpillStore = {};
		await spillTLAS( sp );
		sp.instanceTable.clusterCount = 1;
		sp._bvhSpillStore = null;
		await spillTLAS( sp );
		expect( sp.bvh.spilledChunks ).toBe( 0 );

		let finish;
		sp._afterLoadSpill = new Promise( r => ( finish = r ) );
		const edit = vi.spyOn( sp, 'whenTLASEditable' ).mockReturnValue( 'edited' );
		const waiting = whenTLASEditable( sp );
		expect( edit ).not.toHaveBeenCalled();
		finish();
		expect( await waiting ).toBe( 'edited' );
		expect( whenTLASEditable( { bvh: null } ) ).toBeNull();

	} );

	it( 'reads back for a move the TLAS and the record chunks of the moved copies and their group', async () => {

		const sp = scene();
		const runs = [ { start: 0, count: 1 }, { start: 1, count: 1 }, { start: 2, count: 1 }, null ];
		sp.instanceTable = {
			blasBase: 2, clusterCount: 1, recordNodeStart: 4,
			groupOfTemplate: [ - 1, 0, 0 ], groups: [ { members: [ 1, 2 ] } ],
			placementRunOf: m => runs[ m ], tlasLeafIndex: Int32Array.of( 0, - 1, 2 ),
		};
		const store = await SpillStore.create( storage, 'spill:move', 2 * 16 * 4 );
		await sp.bvh.spill( store );

		expect( needsPageInForMove( sp, [ 3 ] ) ).toBe( true );
		await sp.bvh.ensureResident( 0, 2 );
		expect( needsPageInForMove( sp, [ 3 ] ) ).toBe( false );
		expect( needsPageInForMove( sp, [ 1 ] ) ).toBe( true );

		await ensureMovable( sp, [ 1 ] );
		expect( [ 0, 2, 4, 6 ].map( n => sp.bvh.isResident( n, 2 ) ) ).toEqual( [ true, false, true, true ] );
		expect( needsPageInForMove( sp, [ 1 ] ) ).toBe( false );
		expect( needsPageInForMove( sp, [ 0 ] ) ).toBe( false );
		expect( sp._movePageIns ).toBe( 0 );

		await sp.bvh.spill( store );
		sp.instanceTable.clusterCount = 0;
		await ensureMovable( sp, [ 1 ] );
		expect( [ 0, 2, 4, 6 ].map( n => sp.bvh.isResident( n, 2 ) ) ).toEqual( [ true, false, false, false ] );
		await store.dispose();

	} );

	it( 'knows when a move has nothing to read back', () => {

		expect( needsPageInForMove( { _matrixSpill: {} }, [ 0 ] ) ).toBe( true );
		expect( needsPageInForMove( { _afterLoadSpill: Promise.resolve() }, [ 0 ] ) ).toBe( true );
		expect( needsPageInForMove( { instanceTable: null, bvh: { spilledChunks: 1 } }, [ 0 ] ) ).toBe( false );
		expect( needsPageInForMove( scene(), [ 0 ] ) ).toBe( false );

	} );

	it( 'packs the order maps into large writes, one map past a write on its own, and reads them all back', async () => {

		const big = Uint32Array.from( { length: 8_500_000 }, ( _, i ) => ( i * 2654435761 ) >>> 0 );
		const maps = [[ 1, Uint32Array.of( 3, 1, 2 ) ], [ 2, big ], [ 3, Uint32Array.of( 7, 8 ) ]];
		const sp = new SceneProcessor();
		sp.instanceTable = { bvhToOriginal: new Map( maps.map( ( [ t, m ] ) => [ t, m.slice() ] ) ) };
		sp._progressive = { storage };

		await spillOrderMaps( sp );
		expect( sp.instanceTable.bvhToOriginal.size ).toBe( 0 );
		expect( sp._orderSpill.bytes ).toBe( ( 3 + 8_500_000 + 2 ) * 4 );

		await ensureResident( sp );
		const back = sp.instanceTable.bvhToOriginal;
		expect( [ ...back.get( 1 ) ] ).toEqual( [ 3, 1, 2 ] );
		expect( [ ...back.get( 3 ) ] ).toEqual( [ 7, 8 ] );
		expect( back.get( 2 ).length ).toBe( big.length );
		expect( back.get( 2 ).every( ( v, i ) => v === big[ i ] ) ).toBe( true );

		const empty = new SceneProcessor();
		empty.instanceTable = { bvhToOriginal: new Map() };
		empty._progressive = { storage };
		await spillOrderMaps( empty );
		expect( empty._orderSpill ).toBeFalsy();

	} );

	it( 'puts the instance matrices on disk after a load, giving their meshes bounds first', async () => {

		const values = Array.from( { length: 32 }, ( _, i ) => i );
		const list = new InstancedBufferAttribute( Float32Array.from( values ), 16 );
		const mesh = new Mesh();
		const sp = new SceneProcessor();
		sp.instanceTable = { adoptedMatrices: () => [ list ], clusterCount: 0, bvhToOriginal: new Map() };
		sp._progressive = { storage };
		sp._geometryOwner = {};
		sp._spillMeshBounds = [[ mesh, [ 0, 1, 2, 3, 4, 5 ]]];

		const spilling = spillAfterLoad( sp );
		expect( spillAfterLoad( sp ) ).toBe( spilling );
		await spilling;
		expect( sp._spillMeshBounds ).toBeNull();
		expect( mesh.boundingBox.min.toArray() ).toEqual( [ 0, 1, 2 ] );
		expect( mesh.boundingBox.max.toArray() ).toEqual( [ 3, 4, 5 ] );
		expect( mesh.boundingSphere.center.toArray() ).toEqual( [ 1.5, 2.5, 3.5 ] );
		expect( list.array.length ).toBe( 0 );
		expect( await spillAfterLoad( sp ) ).toBeUndefined();

		await ensureMovable( sp );
		expect( Array.from( list.array ) ).toEqual( values );

		const boxes = vi.spyOn( sp, '_instancedMeshBounds' ).mockReturnValue( [] );
		sp.instanceTable.writeEntryWorldAABB = vi.fn();
		await respill( sp );
		expect( boxes ).toHaveBeenCalledWith( expect.any( Function ), true );
		boxes.mock.calls[ 0 ][ 0 ]( 7, 'out' );
		expect( sp.instanceTable.writeEntryWorldAABB ).toHaveBeenCalledWith( 7, 'out', 0 );
		sp._disposeMatrixSpill();

	} );

	it( 'spills no matrices without lists, storage or room, and nothing again before a load spilled', async () => {

		const list = new InstancedBufferAttribute( new Float32Array( 16 ), 16 );
		const sp = new SceneProcessor();
		sp.instanceTable = { adoptedMatrices: () => [], clusterCount: 0, bvhToOriginal: new Map() };
		sp._geometryOwner = {};
		sp._spilledAfterLoad = true;

		await respill( sp );
		sp.instanceTable.adoptedMatrices = () => [ list ];
		await respill( sp );
		sp._progressive = { storage };
		vi.spyOn( GeometrySpill, 'create' ).mockResolvedValueOnce( null );
		await respill( sp );
		expect( sp._matrixSpill ).toBeFalsy();
		expect( list.array.length ).toBe( 16 );

		sp._matrixReading = Promise.resolve();
		await respill( sp );
		sp._matrixReading = null;
		sp._spilledAfterLoad = false;
		await respill( sp );
		expect( sp._matrixSpill ).toBeFalsy();

	} );

	it( 'reads the scene\'s geometry back and recounts it, warning about any that never left', async () => {

		const sp = new SceneProcessor();
		sp._geometryOwner = {};
		await restoreGeometry( sp, new Group() );
		expect( sp._geometryOwner ).toBeNull();

		const geometry = new SphereGeometry( 1, 8, 4 );
		const positions = geometry.attributes.position.array.slice();
		const object = new Group().add( new Mesh( geometry ) );
		sp._geometrySpill = await GeometrySpill.create( storage, 'spill:geo' );
		sp._geometrySpill.add( geometry );
		await sp._geometrySpill.written();
		expect( geometry.attributes.position.array.length ).toBe( 0 );

		await restoreGeometry( sp, object );
		expect( geometry.attributes.position.array ).toEqual( positions );
		expect( sp._geometrySpill ).toBeNull();
		expect( sp._geometryBytes ).toBe( positions.byteLength + geometry.attributes.normal.array.byteLength + geometry.attributes.uv.array.byteLength + geometry.index.array.byteLength );

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		sp._geometrySpill = await GeometrySpill.create( storage, 'spill:geo-failed' );
		sp._geometrySpill._store.writeAt = async () => {

			throw new Error( 'quota' );

		};

		sp._geometrySpill.add( new SphereGeometry( 1, 8, 4 ) );
		await sp._geometrySpill.written();
		await restoreGeometry( sp, object );
		expect( warn.mock.calls.flat().join( ' ' ) ).toContain( 'stayed in memory' );

	} );

	it( 'reads the geometry back once however many ask, the matrices with it', async () => {

		const sp = new SceneProcessor();
		sp._geometryOwner = 'model';
		let finish;
		const restore = vi.spyOn( sp, '_restoreGeometry' ).mockImplementation( () => new Promise( r => ( finish = r ) ) );
		const movable = vi.spyOn( sp, 'ensureMovable' ).mockResolvedValue();

		const first = ensureGeometryResident( sp ), second = ensureGeometryResident( sp );
		finish();
		await Promise.all( [ first, second ] );
		expect( restore.mock.calls ).toEqual( [[ 'model' ]] );
		expect( movable ).toHaveBeenCalledTimes( 2 );
		expect( sp._geometryReading ).toBeNull();

		sp._geometryOwner = null;
		await ensureGeometryResident( sp );
		expect( restore ).toHaveBeenCalledOnce();

	} );

	it( 'lets go of every spill, whatever its dispose does', async () => {

		const failing = () => ( { dispose: vi.fn().mockRejectedValue( new Error( 'busy' ) ) } );
		const stores = [ failing(), failing() ];
		const sp = { _spillStores: stores, _matrixSpill: failing(), _geometrySpill: failing(), _geometryOwner: {} };
		const [ matrices, geometry ] = [ sp._matrixSpill, sp._geometrySpill ];

		disposeSpill( sp );
		disposeMatrixSpill( sp );
		disposeGeometrySpill( sp );
		await flush();
		expect( stores.map( s => s.dispose.mock.calls.length ) ).toEqual( [ 1, 1 ] );
		expect( matrices.dispose ).toHaveBeenCalledOnce();
		expect( geometry.dispose ).toHaveBeenCalledOnce();
		expect( sp ).toEqual( { _spillStores: null, _matrixSpill: null, _geometrySpill: null, _geometryOwner: null } );
		disposeSpill( sp );

	} );

} );

describe( 'deciding to spill', () => {

	const survey = counts => ( { geometryExtractor: { surveyScene: vi.fn( () => counts ) } } );

	it( 'spills a scene past the safe line only', () => {

		expect( needsSpill( survey( { triangles: 1e6, placements: 10, geometryBytes: 1e8 } ), {} ) ).toBe( false );
		expect( needsSpill( survey( { triangles: 2e8, placements: 10, geometryBytes: 1e8 } ), {} ) ).toBe( true );

	} );

	it( 'keeps a mode of true, false or auto', () => {

		const app = {};
		for ( const [ mode, kept ] of [[ true, true ], [ false, false ], [ 'auto', 'auto' ], [ 'yes', 'auto' ], [ undefined, 'auto' ]] ) {

			setMemorySpill( app, mode );
			expect( app._memorySpill ).toBe( kept );

		}

	} );

	it( 'raises an archive\'s budgets only where a build could spill, the host\'s own winning', () => {

		const options = { maxTriangles: 5 };
		expect( sceneBudgets( { _memorySpill: false, storage: {} }, options ) ).toBe( options );
		expect( sceneBudgets( { _memorySpill: 'auto', storage: null }, options ) ).toBe( options );
		expect( sceneBudgets( { _memorySpill: 'auto', storage: {} }, options ) ).toEqual( { maxTriangles: 5, maxPlacements: SPILL_PLACEMENT_BUDGET } );
		expect( sceneBudgets( { _memorySpill: true, storage: {} }, {} ) ).toEqual( { maxTriangles: SPILL_TRIANGLE_BUDGET, maxPlacements: SPILL_PLACEMENT_BUDGET } );

	} );

	const sky = width => {

		const texture = new DataTexture( new Float32Array( width * 4 ), width, 1, RGBAFormat, FloatType );
		texture.dispose = vi.fn();
		return texture;

	};

	const app = ( overrides = {} ) => ( {
		_memorySpill: 'auto',
		storage: {},
		assetLoader: { animations: [], maxEnvironmentWidth: 0 },
		_sdf: { needsSpill: vi.fn( () => true ) },
		meshScene: { environment: sky( 16 ) },
		...overrides,
	} );

	it( 'spills a static scene past the line, shrinking a wide sky for it', () => {

		const wide = sky( SPILL_ENVIRONMENT_WIDTH + 8 );
		const host = app( { meshScene: { environment: wide } } );
		expect( planSpill( host ) ).toBe( true );
		expect( host._spillPlan ).toBe( true );
		expect( host.assetLoader.maxEnvironmentWidth ).toBe( SPILL_ENVIRONMENT_WIDTH );
		expect( wide.image.width ).toBe( ( SPILL_ENVIRONMENT_WIDTH + 8 ) / 2 );
		expect( wide.dispose ).toHaveBeenCalledOnce();

		const narrow = app();
		expect( planSpill( narrow ) ).toBe( true );
		expect( narrow.meshScene.environment.dispose ).not.toHaveBeenCalled();

	} );

	it( 'never spills an animated scene or one without storage, and asks no survey when told to spill', () => {

		const animated = app( { assetLoader: { animations: [ {} ], maxEnvironmentWidth: 99 } } );
		expect( planSpill( animated ) ).toBe( false );
		expect( animated._sdf.needsSpill ).not.toHaveBeenCalled();
		expect( animated.assetLoader.maxEnvironmentWidth ).toBe( 0 );

		expect( planSpill( app( { storage: null } ) ) ).toBe( false );
		expect( planSpill( app( { _memorySpill: false } ) ) ).toBe( false );
		expect( planSpill( app( { _sdf: { needsSpill: () => false } } ) ) ).toBe( false );

		const forced = app( { assetLoader: undefined, meshScene: null } );
		expect( planSpill( forced ) ).toBe( true );
		forced._memorySpill = true;
		expect( planSpill( forced ) ).toBe( true );
		expect( forced._sdf.needsSpill ).toHaveBeenCalledOnce();

	} );

	it( 'hands the build the plan once, or plans then', () => {

		const host = { storage: 'disk', _spillPlan: true, _planSpill: vi.fn( () => false ), _chunkUploader: () => 'uploader' };
		expect( progressiveSpill( host ) ).toEqual( { storage: 'disk', uploader: 'uploader' } );
		expect( host._spillPlan ).toBeNull();
		expect( progressiveSpill( host ) ).toBeNull();
		expect( host._planSpill ).toHaveBeenCalledOnce();

	} );

	it( 'uploads triangle chunks and node chunks each their own way', () => {

		const stage = { createTriangleChunkUploader: vi.fn( () => 'triangles' ), createChunkUploader: vi.fn( () => 'nodes' ) };
		const upload = chunkUploader( { stages: { pathTracer: stage } } );
		expect( upload( 'tris', 'triangles', { textureCoordinates: true } ) ).toBe( 'triangles' );
		expect( stage.createTriangleChunkUploader ).toHaveBeenCalledWith( 'tris', { textureCoordinates: true } );
		expect( upload( 'nodes', 'bvh', {} ) ).toBe( 'nodes' );
		expect( stage.createChunkUploader ).toHaveBeenCalledWith( 'nodes' );

	} );

} );

describe( 'spilling around a loaded scene', () => {

	const host = ( sdf ) => ( { storage: {}, _sdf: sdf, dispatchEvent: vi.fn(), _issues: { warn: vi.fn() } } );

	afterEach( () => {

		vi.useRealTimers();

	} );

	it( 'spills the rest in the background once loaded, and announces it', async () => {

		const app = host( { spilling: true, spillAfterLoad: vi.fn( async () => {} ), spillToDisk: vi.fn( async () => ( { bytes: 10, ms: 2 } ) ) } );
		maybeSpill( app );
		await flush();
		expect( app._sdf.spillToDisk ).toHaveBeenCalledWith( app.storage );
		expect( app.dispatchEvent ).toHaveBeenCalledWith( { type: EngineEvents.SCENE_SPILLED, bytes: 10, ms: 2 } );

		app._sdf.spillToDisk.mockResolvedValueOnce( null );
		app.dispatchEvent.mockClear();
		maybeSpill( app );
		await flush();
		expect( app.dispatchEvent ).not.toHaveBeenCalled();

	} );

	it( 'warns rather than fails when a spill does', async () => {

		const app = host( { spilling: true, spillAfterLoad: async () => {

			throw new Error( 'disk full' );

		}, spillToDisk: async () => {

			throw new Error( 'disk gone' );

		} } );
		maybeSpill( app );
		await flush();
		expect( app._issues.warn.mock.calls ).toEqual( [
			[ ISSUE_CODES.STORAGE_WRITE_FAILED, 'memory spill failed: disk full' ],
			[ ISSUE_CODES.STORAGE_WRITE_FAILED, 'memory spill failed: disk gone' ],
		] );

	} );

	it( 'leaves a scene that is not spilling alone', () => {

		const sdf = { spilling: false, spillAfterLoad: vi.fn(), spillToDisk: vi.fn(), respill: vi.fn() };
		maybeSpill( host( sdf ) );
		maybeSpill( { storage: null, _sdf: { ...sdf, spilling: true } } );
		vi.useFakeTimers();
		const app = host( sdf );
		scheduleRespill( app );
		vi.runAllTimers();
		expect( [ sdf.spillAfterLoad, sdf.spillToDisk, sdf.respill ].map( f => f.mock.calls.length ) ).toEqual( [ 0, 0, 0 ] );
		expect( app._respillTimer ).toBeUndefined();

	} );

	it( 'spills again only once edits have been quiet for 30 s', async () => {

		vi.useFakeTimers();
		const app = host( { spilling: true, respill: vi.fn( async () => {} ) } );
		scheduleRespill( app );
		vi.advanceTimersByTime( 20_000 );
		scheduleRespill( app );
		vi.advanceTimersByTime( 29_999 );
		expect( app._sdf.respill ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 1 );
		expect( app._sdf.respill ).toHaveBeenCalledOnce();
		expect( app._respillTimer ).toBeNull();

		app._sdf.respill.mockRejectedValueOnce( new Error( 'locked' ) );
		scheduleRespill( app );
		await vi.runAllTimersAsync();
		expect( app._issues.warn ).toHaveBeenCalledWith( ISSUE_CODES.STORAGE_WRITE_FAILED, 'memory spill failed: locked' );

	} );

	it( 'brings a spilled scene and its geometry back on request', async () => {

		const order = [];
		const sdf = { spilled: true, ensureResident: vi.fn( async () => order.push( 'records' ) ), ensureGeometryResident: vi.fn( async () => order.push( 'geometry' ) ) };
		await ensureSceneResident( { _sdf: sdf } );
		expect( order ).toEqual( [ 'records', 'geometry' ] );

		sdf.spilled = false;
		await ensureSceneResident( { _sdf: sdf } );
		expect( sdf.ensureResident ).toHaveBeenCalledOnce();
		expect( sdf.ensureGeometryResident ).toHaveBeenCalledTimes( 2 );
		await ensureSceneResident( {} );

	} );

} );
