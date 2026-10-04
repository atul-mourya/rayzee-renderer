/**
 * The core reads glTF and .hdr; every other format is registered on the asset loader (rayzee/addons/formats, or a host's
 * own), and glTF's compression decoders are imported only for a file that uses them.
 */
import { describe, expect, it, vi } from 'vitest';
import { Mesh, PerspectiveCamera, Points, Scene, Vector3 } from 'three';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';
import { allFormats, objFormat, stlFormat, plyFormat, exrFormat } from '@/core/Processor/FileFormats.js';
import { decodersOnDemand } from '@/core/Processor/GLTFDecoders.js';

const stubControls = () => ( { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
const newLoader = () => new AssetLoader( new Scene(), new PerspectiveCamera(), stubControls() );

const OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const STL = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
const PLY_POINTS = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n';

describe( 'file formats', () => {

	it( 'reads only glTF, .hdr and images until a format is registered', () => {

		const loader = newLoader();
		expect( loader.getFileFormat( 'scene.glb' ) ).toMatchObject( { type: 'model' } );
		expect( loader.getFileFormat( 'sky.hdr' ) ).toMatchObject( { type: 'environment' } );
		for ( const name of [ 'a.fbx', 'a.obj', 'a.stl', 'a.ply', 'a.dae', 'a.3mf', 'a.usdz', 'sky.exr' ] ) expect( loader.getFileFormat( name ) ).toBeNull();
		expect( loader.formatError( 'a.obj' ).message ).toMatch( /rayzee\/addons\/formats.*registerFormat/ );
		expect( loader.formatError( 'a.xyz' ).message ).toBe( 'Unsupported file format: a.xyz' );

	} );

	it( 'reads what is registered, under every extension it names', () => {

		const loader = newLoader().registerFormat( ...allFormats );
		expect( loader.getFileFormat( 'a.USDA' ) ).toMatchObject( { type: 'model', label: 'USD' } );
		expect( loader.getFileFormat( 'sky.exr' ) ).toMatchObject( { type: 'environment' } );
		expect( Object.keys( loader.getSupportedFormats( 'model' ) ).sort() ).toEqual(
			[ '3mf', 'dae', 'fbx', 'glb', 'gltf', 'obj', 'ply', 'stl', 'usd', 'usda', 'usdc', 'usdz' ]
		);

	} );

	it( 'loads a registered model through the shared steps, and refuses an unregistered one', async () => {

		const loader = newLoader().registerFormat( objFormat, stlFormat, plyFormat );
		const onModelLoad = vi.spyOn( loader, 'onModelLoad' ).mockResolvedValue();
		const loaded = vi.fn();
		loader.addEventListener( 'load', loaded );

		await loader._loadModelFileByExtension( new File( [ OBJ ], 'tri.obj' ), 'tri.obj' );
		expect( loader.targetModel.name ).toBe( 'tri.obj' );
		expect( loader.targetModel.children[ 0 ] ).toBeInstanceOf( Mesh );

		await loader._loadModelFileByExtension( new File( [ STL ], 'tri.stl' ), 'tri.stl' );
		expect( loader.targetModel ).toBeInstanceOf( Mesh );
		expect( loader.targetModel.geometry.attributes.position.count ).toBe( 3 );

		await loader._loadModelFileByExtension( new File( [ PLY_POINTS ], 'cloud.ply' ), 'cloud.ply' );
		expect( loader.targetModel ).toBeInstanceOf( Points );

		expect( onModelLoad ).toHaveBeenCalledTimes( 3 );
		expect( loaded ).toHaveBeenCalledTimes( 3 );
		await expect( loader._loadModelFileByExtension( new File( [ '' ], 'a.fbx' ), 'a.fbx' ) ).rejects.toThrow( /rayzee\/addons\/formats/ );

	} );

	it( 'refuses an unregistered EXR before downloading it, and reads it once registered', async () => {

		const loader = newLoader();
		const download = vi.spyOn( loader, '_viaCache' );
		await expect( loader.loadEnvironmentByExtension( 'https://example.com/sky.exr', 'exr' ) ).rejects.toThrow( /rayzee\/addons\/formats/ );
		expect( download ).not.toHaveBeenCalled();

		loader.registerFormat( exrFormat );
		download.mockResolvedValue( { url: 'blob:sky', cached: true, release() {} } );
		const exr = await exrFormat.createLoader();
		const loadAsync = vi.spyOn( Object.getPrototypeOf( exr ), 'loadAsync' ).mockResolvedValue( { isTexture: true } );
		await loader.loadEnvironmentByExtension( 'https://example.com/sky.exr', 'exr' );
		expect( loadAsync ).toHaveBeenCalledWith( 'blob:sky', undefined );
		loadAsync.mockRestore();

	} );

} );

describe( 'glTF decoders on demand', () => {

	const glb = ( json ) => {

		const text = new TextEncoder().encode( JSON.stringify( json ) );
		const padded = new Uint8Array( Math.ceil( text.length / 4 ) * 4 ).fill( 0x20 );
		padded.set( text );
		const buffer = new ArrayBuffer( 20 + padded.length );
		const view = new DataView( buffer );
		view.setUint32( 0, 0x46546C67, true );
		view.setUint32( 4, 2, true );
		view.setUint32( 8, buffer.byteLength, true );
		view.setUint32( 12, padded.length, true );
		view.setUint32( 16, 0x4E4F534A, true );
		new Uint8Array( buffer, 20 ).set( padded );
		return buffer;

	};

	const fakeLoader = () => {

		const loader = {
			dracoLoader: null, ktx2Loader: null, meshoptDecoder: null,
			setDRACOLoader: vi.fn( function ( d ) {

				this.dracoLoader = d;

			} ),
			setKTX2Loader: vi.fn( function ( k ) {

				this.ktx2Loader = k;

			} ),
			setMeshoptDecoder: vi.fn( function ( m ) {

				this.meshoptDecoder = m;

			} ),
		};
		loader.parse = vi.fn();
		const parse = loader.parse;
		return { loader: decodersOnDemand( loader, null ), parse };

	};

	const parsed = ( loader, data ) => new Promise( ( resolve, reject ) => loader.parse( data, '', resolve, reject ) );

	it( 'imports nothing for a glTF that uses no compression', async () => {

		const { loader, parse } = fakeLoader();
		parse.mockImplementation( ( data, path, onLoad ) => onLoad( 'parsed' ) );
		expect( await parsed( loader, glb( { asset: { version: '2.0' } } ) ) ).toBe( 'parsed' );
		expect( loader.setDRACOLoader ).not.toHaveBeenCalled();
		expect( loader.setKTX2Loader ).not.toHaveBeenCalled();
		expect( loader.setMeshoptDecoder ).not.toHaveBeenCalled();

	} );

	it( 'attaches each decoder the file names, before the parse, binary or text alike', async () => {

		const { loader, parse } = fakeLoader();
		parse.mockImplementation( ( data, path, onLoad ) => onLoad( [ loader.dracoLoader, loader.ktx2Loader, loader.meshoptDecoder ] ) );

		const [ draco, ktx2, meshopt ] = await parsed( loader, glb( {
			asset: { version: '2.0' }, extensionsUsed: [ 'KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression' ],
		} ) );
		expect( draco?.constructor.name ).toBe( 'DRACOLoader' );
		expect( ktx2?.constructor.name ).toBe( 'KTX2Loader' );
		expect( meshopt?.supported ).toBeDefined();
		draco.dispose();
		ktx2.dispose();

		const text = fakeLoader();
		text.parse.mockImplementation( ( data, path, onLoad ) => onLoad( text.loader.dracoLoader ) );
		const json = new TextEncoder().encode( JSON.stringify( { asset: { version: '2.0' }, extensionsUsed: [ 'KHR_draco_mesh_compression' ] } ) ).buffer;
		const textDraco = await parsed( text.loader, json );
		expect( textDraco?.constructor.name ).toBe( 'DRACOLoader' );
		textDraco.dispose();

	} );

} );
