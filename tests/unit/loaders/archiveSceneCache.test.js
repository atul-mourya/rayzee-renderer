import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { localFolder } from '@/core/loaders/ArchiveFormats.js';
import { usdFormat } from '@/core/addons/formats.js';

// A parse (minMs 0) or a parse plus build (BUILD_MS) slow enough to store, whatever this machine's speed.
const policy = vi.hoisted( () => ( { minMs: 0 } ) );
vi.mock( '@/core/storage/StorageAreas.js', async importOriginal => ( {
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

const usdRoom = ( stamp = 1 ) => localFolder( { files: [ { path: 'Shop/shop.usda', file: new File( [ `#usda 1.0
def Material "red"
{
    token outputs:surface.connect = </red/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (0.8, 0.1, 0.1)
        float inputs:roughness = 0.4
    }
}
def Xform "shelf"
{
    double3 xformOp:translate = (2, 0, -1)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Mesh "board"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-1, 0, -1), (1, 0, -1), (1, 0, 1), (-1, 0, 1)]
        rel material:binding = </red>
    }
}
def RectLight "panel"
{
    float inputs:intensity = 5
    float inputs:width = 2
    float inputs:height = 0.5
    double3 xformOp:translate = (0, 3, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
def Camera "cam"
{
    float focalLength = 35
    double3 xformOp:translate = (0, 1, 6)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
` ], 'shop.usda', { lastModified: stamp } ) } ] } );

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

const lightsAndCameras = model => {

	model.updateMatrixWorld( true );
	const out = [];
	model.traverse( o => ( o.isLight || o.isCamera ) && out.push( {
		type: o.type,
		world: o.matrixWorld.toArray(),
		values: [ o.intensity, o.width, o.height, o.fov, o.near, o.far ],
		userData: { ...o.userData },
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

	it( 'reports an image that failed at the build again when the scene is reopened from storage', async () => {

		const recorded = [];
		loader._issues = { record: ( code, message ) => recorded.push( { code, message } ), warn() {} };
		const app = engineFor( loader );
		const scene = () => localFolder( { files: [
			{ path: 'Room/room.pbrt', file: new File( [ `
				WorldBegin
				Texture "t" "spectrum" "imagemap" "string filename" "bad.png"
				Material "diffuse" "texture reflectance" "t"
				Shape "trianglemesh" "point3 P" [ -2 0 -2  2 0 -2  2 0 2 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 1 1 ]
			` ], 'room.pbrt', { lastModified: 1 } ) },
			{ path: 'Room/bad.png', file: new File( [ 'not an image' ], 'bad.png', { lastModified: 1 } ) },
		] } );

		await loadInto( app, scene() );
		expect( await ended( 0 ) ).toBe( 'commit' );
		const cold = recorded.filter( ( r ) => r.code === 'texture.build_failed' );
		expect( cold ).toHaveLength( 1 );

		recorded.length = 0;
		await loadInto( app, scene() );
		expect( writes ).toHaveLength( 1 );
		expect( recorded.filter( ( r ) => r.code === 'texture.build_failed' ) ).toEqual( cold );

	} );

	it( 'stores a USD scene too, and the next open restores the same scene without reading it', async () => {

		loader.registerFormat( usdFormat );
		const app = engineFor( loader );
		const usdLoads = vi.spyOn( ArchiveImporter.prototype, 'loadUSDScene' );
		try {

			await loadInto( app, usdRoom() );
			const fresh = summary( app.sceneModel );
			const freshLights = lightsAndCameras( app.sceneModel );
			expect( fresh.map( ( m ) => m.color ) ).toEqual( [[ 0.8, 0.1, 0.1 ]] );
			expect( freshLights.map( ( o ) => o.type ) ).toEqual( expect.arrayContaining( [ 'RectAreaLight', 'PerspectiveCamera' ] ) );
			expect( await ended( 0 ) ).toBe( 'commit' );
			const importer = usdLoads.mock.contexts[ 0 ];
			expect( importer.lastUSDStats.fromStorage ).toBe( false );

			await loadInto( app, usdRoom() );
			expect( writes ).toHaveLength( 1 );
			expect( importer.lastUSDStats.fromStorage ).toBe( true );
			expect( summary( app.sceneModel ) ).toEqual( fresh );
			expect( lightsAndCameras( app.sceneModel ) ).toEqual( freshLights );

			// Another file is another scene.
			await loadInto( app, usdRoom( 2 ) );
			expect( importer.lastUSDStats.fromStorage ).toBe( false );
			expect( await ended( 1 ) ).toBe( 'commit' );

		} finally {

			usdLoads.mockRestore();

		}

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
