import { describe, it, expect, vi } from 'vitest';

// three's FileLoader makes one per streamed chunk; Node has none (nodePlatform() defines one for hosts).
vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { localFolder, isFolderInput } from '@/core/loaders/ArchiveFormats.js';
import { openFolder } from '@/core/addons/archives/ArchiveReader.js';
import { folderIdentity, identityKey } from '@/core/storage/FileIdentity.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { configurePlatform } from '@/core/Platform.js';
import { holdImages, releaseImages } from '@/core/materials/TextureCreator.js';

// What a folder picker hands over: Files carrying their path inside the picked folder.
const picked = ( path, body, options ) => Object.defineProperty(
	new File( [ body ], path.split( '/' ).pop(), options ), 'webkitRelativePath', { value: path }
);

// A File that records every read of its bytes.
function tracked( reads ) {

	return class extends File {

		arrayBuffer() {

			reads.push( this.name );
			return super.arrayBuffer();

		}

		text() {

			reads.push( this.name );
			return super.text();

		}

	};

}

const MODEL = /\.(gltf|glb|fbx|obj)$/i;

function importerWith( overrides = {} ) {

	const loaded = [];
	const loader = {
		storage: null,
		_issues: new IssueLog(),
		getFileFormat: path => ( MODEL.test( path ) ? { type: 'model' } : null ),
		createGLTFLoader: async () => new GLTFLoader(),
		_disposeGLTFLoader() {},
		_throwDeferred() {},
		releaseTargetModel() {},
		onModelLoad: async model => loaded.push( model ),
		dispatchEvent() {},
		_keyed: ( kind, id ) => ( id ? `${kind}::${id}` : null ),
		...overrides,
	};
	return { importer: new ArchiveImporter( loader ), loader, loaded };

}

describe( 'a folder as loadFile takes it', () => {

	it( 'takes a folder picker\'s files, sorted, with hidden files and folders left out', () => {

		const folder = localFolder( { files: [
			picked( 'Room/scene.gltf', '{}' ),
			picked( 'Room/.DS_Store', 'x' ),
			picked( 'Room/.git/HEAD', 'x' ),
			picked( 'Room/__MACOSX/scene.gltf', 'x' ),
			picked( 'Room/textures/wood.png', 'x' ),
			picked( 'Room/scene.bin', 'x' ),
		] } );

		expect( folder.name ).toBe( 'Room' );
		expect( folder.flat ).toBe( false );
		expect( folder.files.map( e => e.path ) ).toEqual( [ 'Room/scene.bin', 'Room/scene.gltf', 'Room/textures/wood.png' ] );

	} );

	it( 'takes path and file pairs, and names loose files after their model', () => {

		const folder = localFolder(
			{ files: [ { path: 'scene.bin', file: new File( [ 'x' ], 'scene.bin' ) }, { path: '.\\scene.gltf', file: new File( [ '{}' ], 'scene.gltf' ) } ] },
			{ isModel: path => MODEL.test( path ) }
		);

		expect( folder.files.map( e => e.path ) ).toEqual( [ 'scene.bin', 'scene.gltf' ] );
		expect( folder.name ).toBe( 'scene.gltf' );
		expect( folder.flat ).toBe( true );
		expect( localFolder( folder ) ).toEqual( folder );
		expect( localFolder( { name: 'Mine', files: folder.files } ).name ).toBe( 'Mine' );

	} );

	it( 'is told apart from a File and a URL', () => {

		expect( isFolderInput( { files: [] } ) ).toBe( true );
		expect( isFolderInput( new File( [ 'x' ], 'a.glb' ) ) ).toBe( false );
		expect( isFolderInput( 'https://x.test/a.glb' ) ).toBe( false );
		expect( isFolderInput( null ) ).toBe( false );

	} );

	it( 'has an identity any change inside it changes, without reading a file', async () => {

		const reads = [];
		const Tracked = tracked( reads );
		const make = ( size, lastModified = 1 ) => localFolder( { name: 'Room', files: [
			{ path: 'Room/a.gltf', file: new Tracked( [ 'x'.repeat( size ) ], 'a.gltf', { lastModified } ) },
			{ path: 'Room/b.bin', file: new Tracked( [ 'yy' ], 'b.bin', { lastModified: 2 } ) },
		] } );

		const id = await folderIdentity( make( 3 ) );
		expect( id ).toMatchObject( { name: 'Room', size: 5, lastModified: 2, files: 2 } );
		expect( await folderIdentity( make( 3 ) ) ).toEqual( id );
		expect( ( await folderIdentity( make( 4 ) ) ).sample ).not.toBe( id.sample );
		expect( ( await folderIdentity( make( 3, 9 ) ) ).sample ).not.toBe( id.sample );
		expect( identityKey( id ) ).toMatch( /^folder:Room\|5\|2\|[0-9a-f]{64}$/ );
		expect( reads ).toEqual( [] );

	} );

	it( 'opens with the shape of the archive readers, reading only what is asked for', async () => {

		const folder = localFolder( { name: 'Island', files: [
			{ path: 'Island/island.pbrt', file: new File( [ 'WorldBegin\n' ], 'island.pbrt' ) },
			{ path: 'Island/isA/isA.pbrt', file: new File( [ 'A' ], 'isA.pbrt' ) },
			{ path: 'Island/isB/isB.pbrt', file: new File( [ 'BBBB' ], 'isB.pbrt' ) },
		] } );

		const source = openFolder( folder, { filter: path => ! path.includes( 'isB' ) } );
		expect( source.listing ).toEqual( [
			{ path: 'Island/isA/isA.pbrt', size: 1, offset: 0 },
			{ path: 'Island/isB/isB.pbrt', size: 4 },
			{ path: 'Island/island.pbrt', size: 11, offset: 0 },
		] );
		expect( source.indexed ).toBe( 2 );
		expect( new TextDecoder().decode( await source.read( 'Island/island.pbrt' ) ) ).toBe( 'WorldBegin\n' );
		expect( new TextDecoder().decode( await source.readHead( 'Island/island.pbrt', 5 ) ) ).toBe( 'World' );
		expect( await source.slice( 'Island/isA/isA.pbrt' ) ).toBe( folder.files[ 0 ].file );
		expect( await source.read( 'Island/isB/isB.pbrt' ) ).toBeNull();

	} );

} );

describe( 'loading a folder', () => {

	it( 'loads a glTF whose buffer sits elsewhere in the folder, reading nothing else', async () => {

		const positions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		const gltf = {
			asset: { version: '2.0' }, scene: 0, scenes: [ { nodes: [ 0 ] } ], nodes: [ { mesh: 0, name: 'tri' } ],
			meshes: [ { primitives: [ { attributes: { POSITION: 0 } } ] } ],
			accessors: [ { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] } ],
			bufferViews: [ { buffer: 0, byteLength: 36 } ],
			buffers: [ { uri: '../data/mesh%20data.bin', byteLength: 36 } ],
		};

		const reads = [];
		const Tracked = tracked( reads );
		const folder = localFolder( { name: 'Room', files: [
			{ path: 'Room/models/scene.gltf', file: new Tracked( [ JSON.stringify( gltf ) ], 'scene.gltf' ) },
			{ path: 'Room/data/mesh data.bin', file: new Tracked( [ positions ], 'mesh data.bin' ) },
			{ path: 'Room/unused.raw', file: new Tracked( [ new Uint8Array( 1 << 16 ) ], 'unused.raw' ) },
		] } );

		const { importer, loaded } = importerWith();
		await importer.loadFolder( folder );

		const mesh = loaded[ 0 ].getObjectByName( 'tri' );
		expect( Array.from( mesh.geometry.getAttribute( 'position' ).array ) ).toEqual( Array.from( positions ) );
		expect( reads ).toEqual( [ 'scene.gltf' ] );

	} );

	it( 'loads an OBJ with the materials its .mtl names', async () => {

		const folder = localFolder( { name: 'Chair', files: [
			{ path: 'Chair/chair.obj', file: new File( [ 'mtllib chair.mtl\nusemtl red\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' ], 'chair.obj' ) },
			{ path: 'Chair/chair.mtl', file: new File( [ 'newmtl red\nKd 1 0 0\n' ], 'chair.mtl' ) },
		] } );

		const { importer, loaded } = importerWith();
		await importer.loadFolder( folder );

		const mesh = loaded[ 0 ].children[ 0 ];
		expect( mesh.material.name ).toBe( 'red' );
		expect( mesh.material.color.getHex() ).toBe( 0xff0000 );

	} );

	it( 'picks a main glTF, else the shallowest model with glTF first, and names the rest', async () => {

		const { importer, loader } = importerWith();
		const choose = async paths => {

			importer.loadModelFromZipEntry = vi.fn( async () => {} );
			await importer.findAndLoadModelFromZip( Object.fromEntries( paths.map( p => [ p, new Blob( [ 'x' ] ) ] ) ), 'Car' );
			return importer.loadModelFromZipEntry.mock.calls[ 0 ][ 1 ];

		};

		expect( await choose( [ 'Car/car.fbx', 'Car/scene.gltf', 'Car/variants/scene.glb' ] ) ).toBe( 'Car/scene.gltf' );
		expect( await choose( [ 'Car/a/x.gltf', 'Car/b.fbx', 'Car/c.gltf' ] ) ).toBe( 'Car/c.gltf' );
		expect( await choose( [ 'Car/deep/one.glb', 'Car/top.fbx' ] ) ).toBe( 'Car/top.fbx' );

		const ambiguous = loader._issues.list.filter( i => i.code === ISSUE_CODES.ASSET_AMBIGUOUS_ENTRY );
		expect( ambiguous[ 0 ].detail ).toEqual( { loaded: 'Car/scene.gltf', alternatives: [ 'Car/car.fbx', 'Car/variants/scene.glb' ] } );

		await expect( importer.findAndLoadModelFromZip( { 'Car/readme.txt': new Blob( [ 'x' ] ) }, 'Car' ) ).rejects.toThrow( /No supported model files found in Car/ );

	} );

	it( 'asks which parts of a large pbrt folder to load, and loads only those', async () => {

		const file = ( body, name ) => new File( [ body ], name );
		const folder = localFolder( { name: 'Island', files: [
			{ path: 'Island/island.pbrt', file: file( 'WorldBegin\n', 'island.pbrt' ) },
			{ path: 'Island/isA/isA.pbrt', file: file( 'A'.repeat( 10 ), 'isA.pbrt' ) },
			{ path: 'Island/isB/isB.pbrt', file: file( 'B'.repeat( 10 ), 'isB.pbrt' ) },
		] } );

		const { importer } = importerWith();
		importer.loadPBRTFromZip = vi.fn( async () => 'scene' );

		await expect( importer.loadFolder( folder, { promptBytes: 1 } ) ).rejects.toMatchObject( {
			code: 'ARCHIVE_NEEDS_ELEMENT',
			elements: [ expect.objectContaining( { prefix: 'Island/isA' } ), expect.objectContaining( { prefix: 'Island/isB' } ) ],
		} );

		expect( await importer.loadFolder( folder, { promptBytes: 1, element: [ 'Island/isA' ] } ) ).toBe( 'scene' );
		const source = importer.loadPBRTFromZip.mock.calls[ 0 ][ 4 ];
		expect( source.listing.filter( e => e.offset !== undefined ).map( e => e.path ) ).toEqual( [ 'Island/isA/isA.pbrt', 'Island/island.pbrt' ] );
		expect( source.elements ).toEqual( [ 'Island/isA' ] );

	} );

	// Bistro: three camera files beside one geometry/ folder they all include.
	it( 'loads the scene a part names by its .pbrt file, with the folders the scenes share', async () => {

		const file = ( body, name ) => new File( [ body ], name );
		const folder = localFolder( { name: 'bistro', files: [
			{ path: 'bistro/bistro_cafe.pbrt', file: file( 'WorldBegin\nInclude "geometry.pbrt"\n', 'bistro_cafe.pbrt' ) },
			{ path: 'bistro/bistro_vespa.pbrt', file: file( 'WorldBegin\nInclude "geometry.pbrt"\n', 'bistro_vespa.pbrt' ) },
			{ path: 'bistro/geometry.pbrt', file: file( 'Shape "plymesh" "string filename" "geometry/mesh_00001.ply"\n', 'geometry.pbrt' ) },
			{ path: 'bistro/geometry/mesh_00001.ply', file: file( 'ply', 'mesh_00001.ply' ) },
			{ path: 'bistro/textures/wall.png', file: file( 'png', 'wall.png' ) },
		] } );

		const { importer } = importerWith();
		importer.loadPBRTFromZip = vi.fn( async () => 'scene' );

		expect( await importer.loadFolder( folder, { element: 'bistro/bistro_vespa.pbrt' } ) ).toBe( 'scene' );
		const [ , , entry, , source ] = importer.loadPBRTFromZip.mock.calls[ 0 ];
		expect( entry ).toBe( 'bistro/bistro_vespa.pbrt' );
		expect( source.listing.filter( e => e.offset !== undefined ).map( e => e.path ) ).toContain( 'bistro/geometry/mesh_00001.ply' );

	} );

} );

describe( 'the asset loader\'s folder entry point', () => {

	function loaderWith( loadFolder ) {

		const loader = Object.create( AssetLoader.prototype );
		loader.archives = loadFolder ? { loadFolder } : null;
		loader._archiveLoader = null;
		const errors = [];
		loader.addEventListener( 'error', e => errors.push( e.message ) );
		return { loader, errors };

	}

	const folder = { name: 'Island', files: [] };

	it( 'hands a part question back with the folder to retry with, as no failure', async () => {

		const ask = Object.assign( new Error( 'choose' ), { code: 'ARCHIVE_NEEDS_ELEMENT' } );
		const { loader, errors } = loaderWith( async () => {

			throw ask;

		} );
		await expect( loader.loadFolder( folder ) ).rejects.toBe( ask );
		expect( ask.file ).toBe( folder );
		expect( errors ).toEqual( [] );

	} );

	it( 'reports a failure, and names the add-on when there is no importer', async () => {

		const { loader, errors } = loaderWith( async () => {

			throw new Error( 'broken' );

		} );
		await expect( loader.loadFolder( folder ) ).rejects.toThrow( 'broken' );
		expect( errors ).toEqual( [ 'broken' ] );

		await expect( loaderWith( null ).loader.loadFolder( folder ) ).rejects.toThrow( /rayzee\/addons\/archives/ );

	} );

} );

describe( 'loadFile with a folder', () => {

	it( 'loads it through the folder path and records where it came from', async () => {

		const assetLoader = {
			getFileFormat: path => ( MODEL.test( path ) ? { type: 'model' } : null ),
			loadFolder: vi.fn( async () => {} ),
		};
		const receiver = {
			assetLoader,
			_sceneBudgets: options => options,
			async _loadWithSceneRebuild( load, event, source ) {

				await load();
				this.event = event;
				this._sceneSource = await source();

			},
		};

		await RayzeeRenderer.prototype.loadFile.call( receiver, { files: [
			picked( 'Sponza/sponza.gltf', '{}', { lastModified: 3 } ),
			picked( 'Sponza/sponza.bin', 'xx', { lastModified: 4 } ),
		] }, { element: 'Sponza/part' } );

		const [ folder, options ] = assetLoader.loadFolder.mock.calls[ 0 ];
		expect( folder.name ).toBe( 'Sponza' );
		expect( options ).toEqual( { element: 'Sponza/part' } );
		expect( receiver.event.filename ).toBe( 'Sponza' );
		expect( receiver._sceneSource ).toMatchObject( {
			kind: 'local-folder',
			folder: { name: 'Sponza', size: 4, lastModified: 4, files: 2 },
			element: 'Sponza/part',
		} );
		expect( receiver._sceneSource.key ).toBe( identityKey( receiver._sceneSource.folder ) );
		expect( receiver._sceneSource.flat ).toBeUndefined();
		expect( RayzeeRenderer.prototype.__lookupGetter__( 'sceneSourceFolder' ).call( receiver ) ).toBe( folder );
		expect( RayzeeRenderer.prototype.__lookupGetter__( 'sceneSourceFile' ).call( receiver ) ).toBeNull();

		await expect( RayzeeRenderer.prototype.loadFile.call( receiver, { files: [ picked( 'Empty/.DS_Store', 'x' ) ] } ) )
			.rejects.toThrow( /holds no files/ );

	} );

} );

describe( 'a pbrt texture map from a folder', () => {

	// A 4×2 PNG's header: what is read of it until the arrays are packed.
	const PNG = new Uint8Array( [ 137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 1, 73, 68, 65, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0 ] );
	const pixels = new Uint8Array( 4 * 2 * 4 ).map( ( _, i ) => 3 * i );

	it( 'reads only the file\'s header at load, and the texture is the one a decode at load made', async () => {

		const decodeImage = vi.fn( async () => ( { data: pixels.slice(), width: 4, height: 2 } ) );
		configurePlatform( { decodeImage } );
		try {

			const reads = [];
			const file = new ( tracked( reads ) )( [ PNG ], 'wood.png' );
			const { importer } = importerWith();

			const lazy = await importer._archiveImage( file, 'textures/wood.png' );
			const eager = await importer._pbrtTextureFromBytes( PNG, 'textures/wood.png' );
			expect( reads ).toEqual( [] );
			expect( decodeImage ).toHaveBeenCalledOnce();
			expect( lazy.image ).toMatchObject( { width: 4, height: 2, data: null } );
			expect( lazy.userData.__rayzeeArchivePath ).toBe( 'textures/wood.png' );
			const settings = ( t ) => [ t.constructor, t.flipY, t.colorSpace, t.wrapS, t.wrapT, t.format, t.type, t.magFilter, t.minFilter,
				t.generateMipmaps, t.unpackAlignment, t.premultiplyAlpha ];
			expect( settings( lazy ) ).toEqual( settings( eager ) );

			await holdImages( [ lazy ] );
			expect( reads ).toEqual( [ 'wood.png' ] );
			expect( Array.from( lazy.image.data ) ).toEqual( Array.from( eager.image.data ) );
			releaseImages( [ lazy ] );
			expect( lazy.image.data ).toBeNull();

		} finally {

			configurePlatform( { decodeImage: null } );

		}

	} );

} );
