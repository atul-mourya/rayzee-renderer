import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, SphereGeometry } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { GeometrySpill } from '@/core/Storage/GeometrySpill.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { SpillStore } from '@/core/Storage/SpillStore.js';
import { PathTracerStage } from '@/core/Stages/PathTracerStage.js';
import { InstancedBufferAttribute } from 'three';

function snapshot( geometry ) {

	const out = {};
	for ( const [ name, attribute ] of Object.entries( geometry.attributes ) ) out[ name ] = attribute.array.slice();
	if ( geometry.index ) out.index = geometry.index.array.slice();
	return out;

}

function big() {

	// Past the size that gets a write of its own.
	const g = new BufferGeometry();
	const positions = new Float32Array( 3 * 800_000 );
	for ( let i = 0; i < positions.length; i ++ ) positions[ i ] = Math.sin( i );
	g.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	return g;

}

describe( 'GeometrySpill', () => {

	let storage, uninstall;

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

	it( 'empties the arrays while they are on disk and puts back exactly what was there', async () => {

		const box = new BoxGeometry( 1, 2, 3 );
		const sphere = new SphereGeometry( 1, 12, 6 );
		const large = big();
		const before = [ box, sphere, large ].map( snapshot );
		const counts = box.attributes.position.count;

		const spill = await GeometrySpill.create( storage, 'spill:geo' );
		for ( const g of [ box, sphere, large ] ) spill.add( g );

		expect( box.attributes.position.array.length ).toBe( 0 );
		expect( box.index.array.length ).toBe( 0 );
		expect( large.attributes.position.array.length ).toBe( 0 );
		expect( box.attributes.position.count ).toBe( counts );

		await spill.written();
		expect( spill.queuedBytes ).toBe( 0 );
		await spill.restore();

		expect( [ box, sphere, large ].map( snapshot ) ).toEqual( before );
		expect( box.attributes.position.array ).toBeInstanceOf( Float32Array );
		expect( box.index.array.constructor ).toBe( before[ 0 ].index.constructor );

		await spill.dispose();
		expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 );

	}, 60000 );

	it( 'restores two attributes sharing one array as one array', async () => {

		const g = new BufferGeometry();
		const shared = Float32Array.from( { length: 30 }, ( _, i ) => i );
		g.setAttribute( 'position', new BufferAttribute( shared, 3 ) );
		g.setAttribute( 'normal', new BufferAttribute( shared, 3 ) );

		const spill = await GeometrySpill.create( storage, 'spill:shared' );
		spill.add( g );
		await spill.restore();

		expect( g.attributes.position.array ).toBe( g.attributes.normal.array );
		expect( Array.from( g.attributes.position.array ) ).toEqual( Array.from( shared ) );
		await spill.dispose();

	} );

	it( 'keeps bounds while the arrays are away, and restores those over any computed from the empty ones', async () => {

		const fresh = new BoxGeometry();
		const bounded = new BoxGeometry( 2, 2, 2 );
		bounded.computeBoundingBox();

		const spill = await GeometrySpill.create( storage, 'spill:bounds' );
		spill.add( fresh );
		spill.add( bounded );
		expect( fresh.boundingBox.max.x ).toBe( 0.5 );
		expect( fresh.boundingSphere.radius ).toBeGreaterThan( 0.8 );
		fresh.computeBoundingBox();
		await spill.restore();

		expect( fresh.boundingBox.max.x ).toBe( 0.5 );
		expect( bounded.boundingBox.max.x ).toBe( 1 );
		await spill.dispose();

	} );

	it( 'stays on disk after a spilling build until the scene asks for it, then comes back once', async () => {

		const g = new SphereGeometry( 1, 16, 8 );
		const before = snapshot( g );
		const sp = new SceneProcessor();
		sp._geometrySpill = await GeometrySpill.create( storage, 'spill:kept' );
		sp._geometrySpill.add( g );
		await sp._geometrySpill.written();
		sp._geometryOwner = {};

		expect( sp.geometryOnDisk ).toBe( true );
		expect( g.attributes.position.array.length ).toBe( 0 );
		await Promise.all( [ sp.ensureGeometryResident(), sp.ensureGeometryResident() ] );

		expect( sp.geometryOnDisk ).toBe( false );
		expect( snapshot( g ) ).toEqual( before );
		await sp.ensureGeometryResident();
		sp.dispose();

	} );

	it( 'sends a spilled scene\'s order maps to disk and reads them back with the rest', async () => {

		const sp = new SceneProcessor();
		const maps = new Map( [[ 0, Uint32Array.of( 2, 0, 1 ) ], [ 5, Uint32Array.from( { length: 3000000 }, ( _, i ) => i ^ 7 ) ], [ 9, Uint32Array.of( 4 ) ]] );
		sp.instanceTable = { bvhToOriginal: new Map( [ ...maps ].map( ( [ t, m ] ) => [ t, m.slice() ] ) ) };
		sp._progressive = { storage };
		await sp._spillOrderMaps();

		expect( sp.instanceTable.bvhToOriginal.size ).toBe( 0 );
		expect( sp.spilled ).toBe( true );
		await sp.ensureResident();
		expect( sp.spilled ).toBe( false );
		for ( const [ t, m ] of maps ) expect( Array.from( sp.instanceTable.bvhToOriginal.get( t ) ) ).toEqual( Array.from( m ) );
		sp.dispose();

	} );

	it( 'brings a spilled scene\'s instance matrices back for a move', async () => {

		const list = new InstancedBufferAttribute( Float32Array.from( { length: 32 }, ( _, i ) => i ), 16 );
		const sp = new SceneProcessor();
		sp._matrixSpill = await GeometrySpill.create( storage, 'spill:matrices' );
		sp._matrixSpill.addAttributes( [ list ] );
		await sp._matrixSpill.written();

		expect( sp.matricesOnDisk ).toBe( true );
		expect( sp.needsPageInForMove( [ 0 ] ) ).toBe( true );
		expect( list.array.length ).toBe( 0 );
		await sp.ensureMovable();
		expect( sp.matricesOnDisk ).toBe( false );
		expect( Array.from( list.array ) ).toEqual( Array.from( { length: 32 }, ( _, i ) => i ) );
		sp.dispose();

	} );

	it( 'puts what an edit read back on disk again, but not while one is reading', async () => {

		const values = Array.from( { length: 32 }, ( _, i ) => i );
		const list = new InstancedBufferAttribute( Float32Array.from( values ), 16 );
		const sp = new SceneProcessor();
		sp.instanceTable = { adoptedMatrices: () => [ list ], clusterCount: 0, bvhToOriginal: new Map() };
		sp._progressive = { storage };
		sp._geometryOwner = {};
		sp._spilledAfterLoad = true;

		await sp.respill();
		expect( sp.matricesOnDisk ).toBe( true );
		expect( list.array.length ).toBe( 0 );

		const reading = sp.ensureMovable();
		await sp.respill();
		await reading;
		expect( sp.matricesOnDisk ).toBe( false );
		expect( Array.from( list.array ) ).toEqual( values );

		await sp.respill();
		expect( sp.matricesOnDisk ).toBe( true );
		await sp.ensureMovable();
		expect( Array.from( list.array ) ).toEqual( values );
		sp.dispose();

	} );

	it( 'uploads a store of several chunks one chunk at a time, awaiting each, and leaves the rest to the upload', async () => {

		const store = chunks => ( { chunks, _gpuUpload: null } );
		const sp = new SceneProcessor();
		sp.triangles = store( [ 1, 2, null, 4 ] );
		sp.bvh = store( [ 5 ] );
		sp.textureCoordinates = false;
		const calls = [];
		let pending = 0;
		await sp.uploadChunks( ( records, kind, options ) => async k => {

			expect( pending ).toBe( 0 );
			pending ++;
			calls.push( [ kind, records.chunks[ k ], options.textureCoordinates ] );
			await new Promise( r => setTimeout( r, 1 ) );
			pending --;

		} );
		expect( calls ).toEqual( [[ 'triangles', 1, false ], [ 'triangles', 2, false ], [ 'triangles', 4, false ]] );

		sp.triangles._gpuUpload = {};
		calls.length = 0;
		await sp.uploadChunks( () => async () => calls.push( 'upload' ) );
		expect( calls ).toEqual( [] );

	} );

	it( 'reads a spilled TLAS back before a visibility edit, and edits once', async () => {

		const records = new ChunkedRecords( 8, 16, Float32Array, 4 * 16 * 4 );
		for ( let i = 0; i < 8; i ++ ) records.setRecords( i, Float32Array.from( { length: 16 }, () => i ) );
		const store = await SpillStore.create( storage, 'spill:tlas', 4 * 16 * 4 );
		await records.spill( store );
		const stage = { _bvhRecords: records, _instanceTable: { blasBase: 6 } };

		let edits = 0;
		PathTracerStage.prototype._whenTLASResident.call( stage, () => edits ++ );
		PathTracerStage.prototype._whenTLASResident.call( stage, () => edits ++ );
		expect( edits ).toBe( 0 );
		await stage._tlasReading;
		await Promise.resolve();
		expect( edits ).toBe( 2 );
		expect( records.isResident( 0, 6 ) ).toBe( true );
		expect( records.chunkFor( 5 )[ records.baseOf( 5 ) ] ).toBe( 5 );

		PathTracerStage.prototype._whenTLASResident.call( stage, () => edits ++ );
		expect( edits ).toBe( 3 );
		await store.dispose();

	} );

	it( 'keeps an array in memory when its write fails', async () => {

		const g = new SphereGeometry( 1, 8, 4 );
		const before = snapshot( g );
		const spill = await GeometrySpill.create( storage, 'spill:fail' );
		spill._store.writeAt = async () => {

			throw new Error( 'quota' );

		};

		spill.add( g );
		await spill.written();
		expect( spill.error?.message ).toBe( 'quota' );
		await spill.restore();

		expect( snapshot( g ) ).toEqual( before );
		await spill.dispose();

	} );

	it( 'lets go of an array it restored once that array is on disk again, never of one it was handed', async () => {

		const values = Float32Array.from( { length: 3 * 1024 * 1024 }, ( _, i ) => i % 977 );
		const big = new InstancedBufferAttribute( values.slice(), 16 );
		const small = new InstancedBufferAttribute( Float32Array.from( { length: 32 }, ( _, i ) => i ), 16 );
		const handed = big.array;
		const first = await GeometrySpill.create( storage, 'spill:release-1' );
		first.addAttributes( [ big, small ] );
		await first.written();
		expect( handed.buffer.byteLength ).toBe( values.byteLength );

		await first.restore();
		const restored = [ big.array, small.array ];
		const second = await GeometrySpill.create( storage, 'spill:release-2' );
		second.addAttributes( [ big, small ] );
		await second.written();
		expect( restored.map( a => a.buffer.byteLength ) ).toEqual( [ 0, 0 ] );
		expect( second.queuedBytes ).toBe( 0 );

		await second.restore();
		expect( big.array.every( ( v, i ) => v === values[ i ] ) ).toBe( true );
		expect( Array.from( small.array ) ).toEqual( Array.from( { length: 32 }, ( _, i ) => i ) );
		await first.dispose();
		await second.dispose();

	} );

	it( 'takes only geometry made of plain attributes', () => {

		const morphed = new BoxGeometry();
		morphed.morphAttributes.position = [ morphed.attributes.position.clone() ];

		expect( GeometrySpill.canTake( new BoxGeometry() ) ).toBe( true );
		expect( GeometrySpill.canTake( morphed ) ).toBe( false );

	} );

} );
