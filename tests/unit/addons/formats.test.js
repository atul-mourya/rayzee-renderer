/**
 * The core reads glTF and .hdr; every other format is registered on the asset loader (rayzee/addons/formats, or a host's
 * own), and glTF's compression decoders are imported only for a file that uses them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataTextureLoader, Group, Mesh, PerspectiveCamera, Points, Scene, TextureLoader, Vector3 } from 'three';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { allFormats, objFormat, stlFormat, plyFormat, exrFormat, fbxFormat, usdFormat, colladaFormat, threeMFFormat, vdbFormat } from '@/core/addons/formats.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { decodersOnDemand } from '@/core/loaders/GLTFDecoders.js';
import { configurePlatform } from '@/core/Platform.js';
import { XMLDOMParser } from '@/core/node/XMLDOMParser.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

const stubControls = () => ( { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
const newLoader = () => new AssetLoader( new Scene(), new PerspectiveCamera(), stubControls() );

const OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const STL = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
const PLY_POINTS = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n';
const PLY_FACE = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
const FBX = '; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\nObjects:  {\n}\nConnections:  {\n\tC: "OO",1,0\n}\n';
const USDA = '#usda 1.0\ndef Xform "root"\n{\n\tdef Mesh "tri"\n\t{\n\t\tint[] faceVertexCounts = [3]\n\t\tint[] faceVertexIndices = [0, 1, 2]\n\t\tpoint3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]\n\t}\n}\n';

// One triangle with an embedded texture.
const PNG_URI = `data:image/png;base64,${Buffer.from( Uint8Array.of( 0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10 ) ).toString( 'base64' )}`;
const COLLADA = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
	<asset><up_axis>Y_UP</up_axis></asset>
	<library_images><image id="img"><init_from>${PNG_URI}</init_from></image></library_images>
	<library_effects><effect id="fx"><profile_COMMON>
		<newparam sid="surf"><surface type="2D"><init_from>img</init_from></surface></newparam>
		<newparam sid="samp"><sampler2D><source>surf</source></sampler2D></newparam>
		<technique sid="common"><lambert><diffuse><texture texture="samp" texcoord="UV"/></diffuse></lambert></technique>
	</profile_COMMON></effect></library_effects>
	<library_materials><material id="mat" name="mat"><instance_effect url="#fx"/></material></library_materials>
	<library_geometries><geometry id="g"><mesh>
		<source id="pos"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
		<source id="uv"><float_array id="ua" count="6">0 0 1 0 0 1</float_array><technique_common><accessor source="#ua" count="3" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>
		<vertices id="v"><input semantic="POSITION" source="#pos"/></vertices>
		<triangles material="m" count="1"><input semantic="VERTEX" source="#v" offset="0"/><input semantic="TEXCOORD" source="#uv" offset="1" set="0"/><p>0 0 1 1 2 2</p></triangles>
	</mesh></geometry></library_geometries>
	<library_visual_scenes><visual_scene id="s"><node id="n" name="tri"><instance_geometry url="#g"><bind_material><technique_common><instance_material symbol="m" target="#mat"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>
	<scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;

const THREE_MF = zipSync( {
	'[Content_Types].xml': strToU8( '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' ),
	'_rels/.rels': strToU8( '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' ),
	'3D/3dmodel.model': strToU8( '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>' ),
} );

describe( 'file formats', () => {

	// Node has no DOMParser: Collada and 3MF read their XML through the host's, as nodePlatform() gives it.
	beforeAll( () => configurePlatform( { DOMParser: XMLDOMParser } ) );
	afterAll( () => configurePlatform( { DOMParser: null } ) );

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
			[ '3mf', 'dae', 'fbx', 'glb', 'gltf', 'nvdb', 'obj', 'ply', 'stl', 'usd', 'usda', 'usdc', 'usdz', 'vdb' ]
		);

	} );

	it( 'loads an OpenVDB file as a volume, its temperature glowing as a black body', async () => {

		const loader = newLoader().registerFormat( vdbFormat );
		vi.spyOn( loader, 'onModelLoad' ).mockResolvedValue();
		const bytes = readFileSync( new URL( '../loaders/fixtures/vdb/mantaflow.vdb', import.meta.url ) );
		await loader._loadModelFileByExtension( new File( [ bytes ], 'fire.vdb' ), 'fire.vdb' );
		const [ volume ] = loader.targetModel.children;
		expect( loader.targetModel.name ).toBe( 'fire.vdb' );
		expect( volume.isVolume ).toBe( true );
		expect( [ volume.grid.name, volume.emissionGrid.name, volume.blackbody, volume.emits ] ).toEqual( [ 'density', 'temperature', true, true ] );
		expect( volume.grid.max ).toBeCloseTo( 0.987, 3 );

	} );

	it( 'loads a NanoVDB file through the same format, raw or zipped, as OpenVDB 12 and pbrt-v4 write them', async () => {

		const loader = newLoader().registerFormat( vdbFormat );
		vi.spyOn( loader, 'onModelLoad' ).mockResolvedValue();
		for ( const name of [ 'density-raw.nvdb', 'fog-zip.nvdb' ] ) {

			const bytes = readFileSync( new URL( `../loaders/fixtures/nanovdb/${name}`, import.meta.url ) );
			await loader._loadModelFileByExtension( new File( [ bytes ], name ), name );
			const [ volume ] = loader.targetModel.children;
			expect( [ loader.targetModel.name, volume.isVolume, volume.grid.name, volume.grid.max ] ).toEqual( [ name, true, 'density', 1 ] );

		}

		expect( loader.targetModel.children[ 0 ].emissionGrid.name ).toBe( 'temperature' );

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

	it( 'reads a PLY with faces as a mesh', async () => {

		const { model } = await plyFormat.parse( new File( [ PLY_FACE ], 'face.ply' ), { filename: 'face.ply', cache: {} } );
		expect( model ).toBeInstanceOf( Mesh );
		expect( model.name ).toBe( 'face.ply' );
		expect( model.geometry.index.count ).toBe( 3 );

	} );

	it( 'reads a binary PLY without three\'s loader, and an ASCII one with it', async () => {

		const header = new TextEncoder().encode( PLY_FACE.replace( 'ascii', 'binary_little_endian' ).split( 'end_header\n' )[ 0 ] + 'end_header\n' );
		const body = new DataView( new ArrayBuffer( 9 * 4 + 1 + 3 * 4 ) );
		[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ].forEach( ( v, i ) => body.setFloat32( i * 4, v, true ) );
		body.setUint8( 36, 3 );
		[ 0, 1, 2 ].forEach( ( v, i ) => body.setInt32( 37 + i * 4, v, true ) );
		const cache = {};
		const binary = await plyFormat.parse( new File( [ header, body ], 'b.ply' ), { filename: 'b.ply', cache } );
		expect( binary.model.geometry.index.count ).toBe( 3 );
		expect( cache.ply ).toBeUndefined();
		await plyFormat.parse( new File( [ PLY_FACE ], 'a.ply' ), { filename: 'a.ply', cache } );
		expect( cache.ply ).toBeDefined();

	} );

	it( 'reads FBX and USD with three\'s loaders, made once a cache', async () => {

		const cache = {};
		const fbx = await fbxFormat.parse( new File( [ FBX ], 'a.fbx' ), { filename: 'a.fbx', cache } );
		expect( fbx.model ).toBeInstanceOf( Group );
		const loader = cache.fbx;
		await fbxFormat.parse( new File( [ FBX ], 'b.fbx' ), { filename: 'b.fbx', cache } );
		expect( cache.fbx ).toBe( loader );
		expect( loader.constructor.name ).toBe( 'FBXLoader' );
		expect( fbx.model.scale.x ).toBe( 1 );

		// Centimetres (Maya, Max, Megascans) come out in metres; a file in metres (Blender's 100) as it is.
		const inUnit = async ( cm ) => ( await fbxFormat.parse( new File( [ FBX.replace( 'Objects:', `GlobalSettings:  {\n\tProperties70:  {\n\t\tP: "UnitScaleFactor", "double", "Number", "",${cm}\n\t}\n}\nObjects:` ) ], 'u.fbx' ), { filename: 'u.fbx', cache } ) ).model.scale.x;
		expect( await inUnit( 1 ) ).toBe( 0.01 );
		expect( await inUnit( 100 ) ).toBe( 1 );

		const { model } = await usdFormat.parse( new File( [ USDA ], 'tri.usda' ), { filename: 'tri.usda', cache } );
		expect( model.name ).toBe( 'tri.usda' );
		const meshes = [];
		model.traverse( o => o.isMesh && meshes.push( o ) );
		expect( meshes ).toHaveLength( 1 );
		expect( meshes[ 0 ].geometry.attributes.position.count ).toBe( 3 );
		expect( cache.usd.constructor.name ).toBe( 'USDLoader' );
		const usd = cache.usd;
		await usdFormat.parse( new File( [ USDA ], 'again.usda' ), { filename: 'again.usda', cache } );
		expect( cache.usd ).toBe( usd );

	} );

	it( 'keeps the shape an FBX camera names, and gives one naming none FBX\'s default, whatever the window', async () => {

		const camera = ( id, props ) => `\tNodeAttribute: ${id}, "NodeAttribute::", "Camera" {\n\t\tProperties70:  {\n${props}\t\t}\n\t\tTypeFlags: "Camera"\n\t}\n\tModel: ${id + 1}, "Model::cam${id}", "Camera" {\n\t}\n`;
		const prop = ( name, value ) => `\t\t\tP: "${name}", "double", "Number", "",${value}\n`;
		const fbx = FBX.replace( 'Objects:  {\n', `Objects:  {\n${
			camera( 10, prop( 'AspectWidth', 1920 ) + prop( 'AspectHeight', 1080 ) ) + camera( 20, prop( 'FocalLength', 50 ) )
		}` ).replace( '\tC: "OO",1,0\n', '\tC: "OO",11,0\n\tC: "OO",10,11\n\tC: "OO",21,0\n\tC: "OO",20,21\n' );

		const cameras = async () => {

			const { model } = await fbxFormat.parse( new File( [ fbx ], 'c.fbx' ), { filename: 'c.fbx', cache: {} } );
			return [ 'cam10', 'cam20' ].map( name => model.getObjectByName( name ) );

		};

		const [ named, unnamed ] = await cameras();
		expect( named.userData.aspect ).toBe( 1920 / 1080 );
		expect( named.aspect ).toBe( 1920 / 1080 );
		expect( unnamed.userData.aspect ).toBeUndefined();
		expect( unnamed.aspect ).toBe( 1.6 );
		expect( unnamed.getFocalLength() ).toBeCloseTo( 50, 6 );
		expect( globalThis.window ).toBeUndefined();

		// A browser's window is lent the same size for the parse, and left as it was.
		const innerWidth = { get: () => 3000, configurable: true, enumerable: true };
		globalThis.window = Object.defineProperties( {}, { innerWidth, innerHeight: { get: () => 1000, configurable: true } } );
		try {

			const [ , inBrowser ] = await cameras();
			expect( inBrowser.fov ).toBe( unnamed.fov );
			expect( Object.getOwnPropertyDescriptor( globalThis.window, 'innerWidth' ) ).toEqual( innerWidth );
			expect( globalThis.window.innerHeight ).toBe( 1000 );

		} finally {

			delete globalThis.window;

		}

	} );

	it( 'keeps a Collada camera\'s shape, and the view xfov gives it', async () => {

		const { ColladaComposer } = await import( 'three/addons/loaders/collada/ColladaComposer.js' );
		const buildCamera = ColladaComposer.prototype.buildCamera;
		const optics = [
			{ technique: 'perspective', parameters: { xfov: 60, aspect_ratio: 2, znear: 0.1, zfar: 100 } },
			{ technique: 'perspective', parameters: { xfov: 90, yfov: 60, znear: 0.1, zfar: 100 } },
			{ technique: 'perspective', parameters: { yfov: 40, znear: 0.1, zfar: 100 } },
			{ technique: 'orthographic', parameters: { xmag: 4, ymag: 2, znear: 0.1, zfar: 100 } },
		];
		// Three builds each camera once and puts clones of it in the scene.
		const scene = new Group();
		const cache = { collada: { parse: () => {

			const composer = new ColladaComposer( {}, null, null, null );
			for ( const data of optics ) scene.add( composer.buildCamera( { name: '', optics: data } ).clone() );
			return { scene };

		} } };

		await colladaFormat.parse( new File( [ '<COLLADA/>' ], 'c.dae' ), { filename: 'c.dae', cache } );
		const [ xfovOnly, both, yfovOnly, ortho ] = scene.children;
		const halfTan = degrees => Math.tan( degrees * Math.PI / 360 );

		expect( xfovOnly.userData.aspect ).toBe( 2 );
		expect( halfTan( xfovOnly.fov ) * 2 ).toBeCloseTo( halfTan( 60 ), 12 );
		expect( both.userData.aspect ).toBeCloseTo( halfTan( 90 ) / halfTan( 60 ), 12 );
		expect( [ both.fov, both.aspect ] ).toEqual( [ 60, both.userData.aspect ] );
		expect( yfovOnly.userData.aspect ).toBeUndefined();
		expect( [ yfovOnly.fov, yfovOnly.aspect ] ).toEqual( [ 40, 1 ] );
		expect( ortho.userData.aspect ).toBe( 2 );
		expect( ColladaComposer.prototype.buildCamera ).toBe( buildCamera );

	} );

	// Three things real files carry make ColladaLoader throw, one paints magenta: read as the nearest valid file.
	it( 'reads a Collada image without a file, an empty effect, a float transparent and an odd material symbol', async () => {

		const { ColladaParser } = await import( 'three/addons/loaders/collada/ColladaParser.js' );
		const { ColladaComposer } = await import( 'three/addons/loaders/collada/ColladaComposer.js' );
		const originals = [ 'parseImage', 'parseEffect', 'parseEffectParameters' ].map( k => ColladaParser.prototype[ k ] );
		const resolve = ColladaComposer.prototype.resolveMaterialBinding;

		// Just enough of a DOM element for the parser's own walks.
		const el = ( nodeName, attrs = {}, childNodes = [], text = '' ) => ( {
			nodeType: 1, nodeName, childNodes, textContent: text,
			getAttribute: k => attrs[ k ] ?? null,
			hasAttribute: k => k in attrs,
			getElementsByTagName( tag ) {

				return childNodes.flatMap( c => [ ...( c.nodeName === tag ? [ c ] : [] ), ...c.getElementsByTagName( tag ) ] );

			},
		} );

		let library, parameters, half, blank, materials;
		const cache = { collada: { parse: () => {

			const parser = new ColladaParser();
			parser.library = library = { images: {}, effects: {} };
			// SketchUp: an image with no file, an empty effect.
			parser.parseImage( el( 'image', { id: 'none' } ) );
			parser.parseImage( el( 'image', { id: 'wood' }, [ el( 'init_from', {}, [], 'wood.png' ) ] ) );
			parser.parseImage( el( 'image', { id: 'made' }, [ el( 'create_2d', {}, [ el( 'init_from', {}, [], 'x.png' ) ] ) ] ) );
			parser.parseEffect( el( 'effect', { id: 'empty' } ) );
			// three's old exporter: <transparent><float>1</float></transparent> beside <transparency> 0.15.
			parameters = parser.parseEffectParameters( el( 'phong', {}, [
				el( 'transparent', {}, [ el( 'float', {}, [], '1' ) ] ),
				el( 'transparency', {}, [ el( 'float', {}, [], '0.15' ) ] ),
			] ) );
			half = parser.parseEffectParameters( el( 'phong', {}, [ el( 'transparent', { opaque: 'RGB_ZERO' }, [ el( 'float', {}, [], '0.5' ) ] ) ] ) );
			blank = parser.parseEffectParameters( el( 'phong', {}, [ el( 'transparent', {}, [ el( 'float', {}, [], '' ) ] ) ] ) );

			const composer = new ColladaComposer( { materials: { walnut: {}, one: {}, two: {} } }, null, null, null );
			composer.getMaterial = id => `material ${id}`;
			materials = [
				composer.resolveMaterialBinding( [ 'default' ], { mat0: 'walnut' } ),
				composer.resolveMaterialBinding( [ 'a', 'b' ], { a: 'one', b: 'two' } ),
				composer.resolveMaterialBinding( [ 'c' ], { a: 'one', b: 'two' } ),
				composer.resolveMaterialBinding( [ 'd' ], { a: 'one', b: 'one' } ),
				// Bound to a material the file lacks: three's fallback, not a throw.
				composer.resolveMaterialBinding( [ 'e' ], { a: 'missing' } ),
			];
			return { scene: new Group() };

		} } };

		await colladaFormat.parse( new File( [ '<COLLADA/>' ], 'r.dae' ), { filename: 'r.dae', cache } );

		expect( library.images ).toEqual( { wood: { init_from: 'wood.png' } } );
		expect( library.effects.empty.profile ).toEqual( { surfaces: {}, samplers: {}, technique: { type: 'lambert', parameters: {} } } );
		expect( parameters.transparent ).toEqual( { opaque: 'A_ONE', data: { float: 1, color: [ 1, 1, 1, 1 ] } } );
		expect( parameters.transparency ).toEqual( { float: 0.15 } );
		expect( half.transparent.data.color ).toEqual( [ 0.5, 0.5, 0.5, 0.5 ] );
		// One material bound takes a symbol it does not name; with more, a stray symbol keeps three's fallback.
		expect( materials[ 0 ] ).toEqual( [ 'material walnut' ] );
		expect( materials[ 1 ] ).toEqual( [ 'material one', 'material two' ] );
		expect( materials[ 2 ][ 0 ].name ).toBe( '__DEFAULT' );
		expect( materials[ 3 ] ).toEqual( [ 'material one' ] );
		expect( materials[ 4 ][ 0 ].name ).toBe( '__DEFAULT' );
		expect( blank.transparent.data.color ).toEqual( [ 1, 1, 1, 1 ] );

		expect( [ 'parseImage', 'parseEffect', 'parseEffectParameters' ].map( k => ColladaParser.prototype[ k ] ) ).toEqual( originals );
		expect( ColladaComposer.prototype.resolveMaterialBinding ).toBe( resolve );

	} );

	it( 'hands Collada its text and 3MF its bytes, keeping Collada\'s whole result', async () => {

		const scene = new Group();
		const collada = { scene, animations: [] };
		const cache = { collada: { parse: vi.fn( () => collada ) }, threemf: { parse: vi.fn( () => scene ) } };

		const dae = await colladaFormat.parse( new File( [ '<COLLADA/>' ], 'a.dae' ), { filename: 'a.dae', cache } );
		expect( cache.collada.parse ).toHaveBeenCalledWith( '<COLLADA/>' );
		expect( dae ).toEqual( { model: scene, result: collada } );
		expect( scene.name ).toBe( 'a.dae' );

		const mf = await threeMFFormat.parse( new File( [ Uint8Array.of( 1, 2 ) ], 'a.3mf' ), { filename: 'a.3mf', cache } );
		expect( [ ...new Uint8Array( cache.threemf.parse.mock.calls[ 0 ][ 0 ] ) ] ).toEqual( [ 1, 2 ] );
		expect( mf ).toEqual( { model: scene } );

	} );

	it( 'makes the Collada and 3MF loaders from three\'s', async () => {

		const cache = {};
		await expect( threeMFFormat.parse( new File( [ '' ], 'a.3mf' ), { filename: 'a.3mf', cache } ) ).rejects.toThrow();
		await colladaFormat.parse( new File( [ COLLADA ], 'a.dae' ), { filename: 'a.dae', cache } );
		expect( cache.collada.constructor.name ).toBe( 'ColladaLoader' );
		expect( cache.threemf.constructor.name ).toBe( 'ThreeMFLoader' );

	} );

	it( 'reads Collada in Node, its texture decoded by the platform, and lends no global past the parse', async () => {

		const decodeImage = vi.fn( async () => ( { data: Uint8Array.of( 9, 8, 7, 255 ), width: 1, height: 1 } ) );
		configurePlatform( { decodeImage } );
		try {

			const { model } = await colladaFormat.parse( new File( [ COLLADA ], 't.dae' ), { filename: 't.dae', cache: {} } );
			const mesh = model.getObjectByName( 'tri' );
			expect( [ ...mesh.geometry.attributes.position.array ] ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
			expect( mesh.material.map.image ).toMatchObject( { width: 1, height: 1, data: Uint8Array.of( 9, 8, 7, 255 ) } );
			expect( decodeImage ).toHaveBeenCalledWith( expect.any( Uint8Array ), 'image/png' );
			expect( [ typeof DOMParser, typeof Node ] ).toEqual( [ 'undefined', 'undefined' ] );

		} finally {

			configurePlatform( { decodeImage: null } );

		}

	} );

	it( 'leaves a Collada texture it cannot read without an image, as a browser does', async () => {

		const { model } = await colladaFormat.parse( new File( [ COLLADA.replace( PNG_URI, 'missing.png' ) ], 't.dae' ), { filename: 't.dae', cache: {} } );
		const { map } = model.getObjectByName( 'tri' ).material;
		expect( map.isTexture ).toBe( true );
		expect( map.image ).toBeNull();

	} );

	// TGALoader fetches through a Request, which a relative URL throws in Node: the platform reads it instead.
	it( 'reads a Collada TGA texture through the platform, and leaves one it cannot read without pixels', async () => {

		const dir = mkdtempSync( join( tmpdir(), 'rayzee-tga-' ) );
		const tga = join( dir, 'wood.tga' );
		// 1 × 1, uncompressed true colour, 32 bits, top-left origin: B G R A.
		writeFileSync( tga, Uint8Array.of( 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 32, 0x28, 30, 20, 10, 255 ) );
		configurePlatform( { readFile: async ( url ) => new Uint8Array( await readFile( url ) ) } );
		const loads = [ TextureLoader.prototype.load, DataTextureLoader.prototype.load ];
		try {

			const read = await colladaFormat.parse( new File( [ COLLADA.replace( PNG_URI, pathToFileURL( tga ).href ) ], 't.dae' ), { filename: 't.dae', cache: {} } );
			expect( read.model.getObjectByName( 'tri' ).material.map.image ).toMatchObject( { width: 1, height: 1 } );
			expect( [ ...read.model.getObjectByName( 'tri' ).material.map.image.data ] ).toEqual( [ 10, 20, 30, 255 ] );

			const missing = await colladaFormat.parse( new File( [ COLLADA.replace( PNG_URI, 'textures/missing.tga' ) ], 'm.dae' ), { filename: 'm.dae', cache: {} } );
			expect( missing.model.getObjectByName( 'tri' ).material.map.image.data ).toBeNull();
			expect( [ TextureLoader.prototype.load, DataTextureLoader.prototype.load ] ).toEqual( loads );

		} finally {

			configurePlatform( { readFile: null } );
			rmSync( dir, { recursive: true } );

		}

	} );

	it( 'reads 3MF in Node', async () => {

		const { model } = await threeMFFormat.parse( new File( [ THREE_MF ], 't.3mf' ), { filename: 't.3mf', cache: {} } );
		const meshes = [];
		model.traverse( ( o ) => o.isMesh && meshes.push( o ) );
		expect( meshes.length ).toBe( 1 );
		expect( meshes[ 0 ].geometry.attributes.position.count ).toBe( 3 );

	} );

	it( 'says what to configure where there is no DOMParser', async () => {

		configurePlatform( { DOMParser: null } );
		try {

			await expect( colladaFormat.parse( new File( [ COLLADA ], 'a.dae' ), { filename: 'a.dae', cache: {} } ) ).rejects.toThrow( /no DOMParser.*configurePlatform/ );
			await expect( threeMFFormat.parse( new File( [ THREE_MF ], 'a.3mf' ), { filename: 'a.3mf', cache: {} } ) ).rejects.toThrow( /no DOMParser/ );

		} finally {

			configurePlatform( { DOMParser: XMLDOMParser } );

		}

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

	it( 'gives Draco and KTX2 at most four workers, fewer where the host sets fewer threads', async () => {

		const limits = async () => {

			const { loader, parse } = fakeLoader();
			parse.mockImplementation( ( data, path, onLoad ) => onLoad( [ loader.dracoLoader, loader.ktx2Loader ] ) );
			const [ draco, ktx2 ] = await parsed( loader, glb( { asset: { version: '2.0' }, extensionsUsed: [ 'KHR_draco_mesh_compression', 'KHR_texture_basisu' ] } ) );
			draco.dispose();
			ktx2.dispose();
			return [ draco.workerLimit, ktx2.workerPool.pool ];

		};

		vi.stubGlobal( 'navigator', { hardwareConcurrency: 12 } );
		try {

			expect( await limits() ).toEqual( [ 4, 4 ] );
			configurePlatform( { threads: 2 } );
			expect( await limits() ).toEqual( [ 2, 2 ] );

		} finally {

			configurePlatform( { threads: null } );
			vi.unstubAllGlobals();

		}

	} );

	it( 'fails what is not glTF, saying so plainly, rather than leaving the load running', async () => {

		const outcome = ( text ) => Promise.race( [
			decodersOnDemand( new GLTFLoader(), null ).parseAsync( new TextEncoder().encode( text ).buffer, '' ).then( () => 'loaded', ( error ) => error ),
			new Promise( ( resolve ) => setTimeout( () => resolve( 'still running' ), 1000 ) ),
		] );
		// A missing file a web server answers with its page.
		const page = await outcome( '\n  <!doctype html><html></html>' );
		expect( page.message ).toBe( 'The address gave a web page, not a 3D model. The link may be wrong, or the file missing.' );
		expect( page.cause ).toBeInstanceOf( SyntaxError );
		expect( ( await outcome( 'solid t\nendsolid t\n' ) ).message ).toBe( 'This is not a glTF model: the file could not be read as one.' );

	} );

} );
