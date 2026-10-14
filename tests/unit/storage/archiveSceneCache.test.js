import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';
import { ArchiveImporter } from '@/core/Processor/ArchiveImporter.js';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { localFolder } from '@/core/Processor/archiveFormats.js';

// A parse (minMs 0) or a parse plus build (BUILD_MS) slow enough to store, whatever this machine's speed.
const policy = vi.hoisted( () => ( { minMs: 0 } ) );
vi.mock( '@/core/Storage/sceneCachePolicy.js', async importOriginal => ( {
	...await importOriginal(),
	worthStoring: ms => ms >= policy.minMs,
} ) );

const BUILD_MS = 60_000;

// A folder's identity is its files' paths, sizes and dates: `stamp` makes another archive.
const room = ( stamp = 1 ) => localFolder( { files: [ { path: 'Room/room.pbrt', file: new File( [ `
	LookAt 0 2 8  0 0 0  0 1 0
	Camera "perspective" "float fov" 40
	WorldBegin
	LightSource "point" "rgb I" [ 5 5 5 ] "point3 from" [ 0 4 0 ]
	Material "diffuse" "rgb reflectance" [ 0.8 0.2 0.1 ]
	Shape "trianglemesh" "point3 P" [ -2 0 -2  2 0 -2  2 0 2  -2 0 2 ] "integer indices" [ 0 1 2  0 2 3 ]
	ObjectBegin "tri"
	Shape "trianglemesh" "point3 P" [ -0.5 0 0  0.5 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
	ObjectEnd
	AttributeBegin Translate -1 0 0 ObjectInstance "tri" AttributeEnd
	AttributeBegin Translate 1 0 0 ObjectInstance "tri" AttributeEnd
` ], 'room.pbrt', { lastModified: stamp } ) } ] } );

const summary = model => {

	model.updateMatrixWorld( true );
	const out = [];
	model.traverse( o => o.isMesh && out.push( {
		name: o.name,
		positions: [ ...o.geometry.attributes.position.array ],
		world: o.matrixWorld.toArray(),
		instances: o.isInstancedMesh ? [ ...o.instanceMatrix.array ] : null,
		color: o.material.color.toArray(),
	} ) );
	return out;

};

// Each entry the importer opens: when its data is on disk, and whether it was committed or aborted.
function watchWrites( area ) {

	const writes = [];
	const create = area.create.bind( area );
	area.create = async ( ...args ) => {

		const writer = await create( ...args );
		if ( ! writer ) return writer;
		const write = { key: writer.key };
		write.written = new Promise( resolve => {

			const writeFile = writer.writeFile.bind( writer );
			writer.writeFile = async ( name, data ) => {

				const size = await writeFile( name, data );
				if ( name === 'graph.json' ) resolve();
				return size;

			};

		} );
		write.ended = new Promise( resolve => {

			for ( const end of [ 'commit', 'abort' ] ) {

				const run = writer[ end ].bind( writer );
				writer[ end ] = async ( ...a ) => {

					try {

						return await run( ...a );

					} finally {

						resolve( end );

					}

				};

			}

		} );
		writes.push( write );
		return writer;

	};

	return writes;

}

// The renderer's replace-load (`_loadWithSceneRebuild`) and failure handling, real; its scene build stubbed.
function engineFor( loader ) {

	return Object.assign( Object.create( RayzeeRenderer.prototype ), {
		assetLoader: loader, _loadingInProgress: false, pipeline: null,
		build: async () => true,
		async loadSceneData() {

			loader.flushPendingGraph( BUILD_MS );
			return this.build();

		},
		_beginSceneMetadataEnvironment: () => null,
		_clearAppendedModels() {}, _modelReplaced() {}, _planSpill() {}, _maybeSpill() {}, _dropDisplay() {}, reset() {},
		dispatchEvent() {}, _modelAnnounced() {},
	} );

}

const loadInto = ( app, folder ) => app._loadWithSceneRebuild( () => app.assetLoader.loadFolder( folder ), {} );

describe( 'the archive scene cache across a load', () => {

	let storage, root, uninstall, loader, scenes, writes;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		scenes = storage.area( 'scenes' );
		writes = watchWrites( scenes );
		loader = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), saveState() {}, update() {} } );
		loader.storage = storage;
		loader.setArchiveImporter( new ArchiveImporter( loader ) );
		policy.minMs = 0;

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	// Entry directories on disk, committed or not.
	const onDisk = async () => {

		const dir = await root.getDirectoryHandle( 'scenes' ).catch( () => null );
		const ids = [];
		if ( dir ) for await ( const id of dir.keys() ) ids.push( id );
		return ids;

	};

	// The i-th write, once the importer has opened it in the background.
	const nth = i => vi.waitFor( () => writes[ i ] ?? Promise.reject( new Error( `no write ${i} yet` ) ) );
	const ended = async i => ( await nth( i ) ).ended;

	it( 'stores a load the engine accepted, and the next open restores the same scene', async () => {

		const app = engineFor( loader );
		await loadInto( app, room() );
		const fresh = summary( app.sceneModel );
		expect( await ended( 0 ) ).toBe( 'commit' );

		await loadInto( app, room() );
		expect( writes ).toHaveLength( 1 );
		expect( summary( app.sceneModel ) ).toEqual( fresh );

	} );

	it.each( [
		[ 'written during the build', 0 ],
		[ 'written after it', BUILD_MS ],
	] )( 'leaves nothing restorable from a load whose build the engine rejected — %s', async ( _, minMs ) => {

		policy.minMs = minMs;
		const app = engineFor( loader );
		const rejected = new Error( 'scene over the memory budget' );
		app.build = async () => {

			if ( minMs === 0 ) await ( await nth( 0 ) ).written;
			throw rejected;

		};

		await expect( loadInto( app, room() ) ).rejects.toBe( rejected );
		expect( await ended( 0 ) ).toBe( 'abort' );
		expect( await scenes.open( writes[ 0 ].key ) ).toBeNull();
		expect( await onDisk() ).toEqual( [] );

		app.build = async () => true;
		await loadInto( app, room() );
		expect( await ended( 1 ) ).toBe( 'commit' );
		expect( writes[ 1 ].key ).toBe( writes[ 0 ].key );

	} );

	it( 'abandons a load superseded or disposed before the engine accepted it, and keeps one it accepted', async () => {

		await loader.loadFolder( room( 1 ) );
		const first = loader.targetModel;
		await loader.loadFolder( room( 2 ) );
		loader.commitPendingGraph( first );
		await loader.loadFolder( room( 3 ) );
		expect( await ended( 0 ) ).toBe( 'abort' );
		expect( await ended( 1 ) ).toBe( 'abort' );

		loader.commitPendingGraph( loader.targetModel );
		await loader.loadFolder( room( 4 ) );
		expect( await ended( 2 ) ).toBe( 'commit' );

		loader.dispose();
		expect( await ended( 3 ) ).toBe( 'abort' );
		expect( ( await scenes.list() ).map( e => e.key ) ).toEqual( [ writes[ 2 ].key ] );
		expect( await onDisk() ).toHaveLength( 1 );

	} );

	it( 'loads without storage, storing nothing', async () => {

		loader.storage = null;
		const app = engineFor( loader );
		await loadInto( app, room() );
		expect( summary( app.sceneModel ) ).toHaveLength( 2 );
		loader.releaseTargetModel();
		expect( writes ).toEqual( [] );
		expect( await onDisk() ).toEqual( [] );

	} );

} );
