import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	AnimationClip, BufferAttribute, BufferGeometry, DataTexture, FloatType, Group, InstancedMesh, Matrix4, Mesh,
	MeshPhysicalMaterial, PerspectiveCamera, RGBAFormat, RepeatWrapping, SRGBColorSpace, Texture, VectorKeyframeTrack, PointLight,
	SpotLight, DirectionalLight, HemisphereLight, Vector3, BoxGeometry, SphereGeometry, Color, DoubleSide, BackSide, FrontSide,
} from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage, acquireSharedStorage } from '@/core/addons/storage/OpenStorage.js';
import { encodeSceneGraph, writeSceneGraph, decodeSceneGraph, SceneGraphUnsupported, ARCHIVE_PATH } from '@/core/addons/archives/SceneGraphCodec.js';
import { rangeChecksum } from '@/core/storage/BLASCache.js';
import { ChunkedRecords } from '@/core/memory/ChunkedRecords.js';
import { worthStoring } from '@/core/storage/StorageAreas.js';
import { getAssetConfig } from '@/core/AssetConfig.js';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';
import { SpillStore } from '@/core/storage/SpillStore.js';
import { inspectBVH } from '../bvh/bvhInvariants.js';
import { GeometryExtractor, resolveMaterialTextures } from '@/core/scene/GeometryExtractor.js';
import { TextureCreator } from '@/core/materials/TextureCreator.js';
import { MATERIAL_DEFAULTS } from '@/core/EngineDefaults.js';

vi.mock( '@/core/bvh/BVHWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( '../bvh/bvhInvariants.js' );
	return { default: inProcessWorker( () => import( '@/core/bvh/BVHWorker.js' ) ) };

} );

function buildScene() {

	const root = new Group();
	root.name = 'PBRTScene';
	root.userData.source = 'test';

	const albedo = new Texture();
	albedo.userData[ ARCHIVE_PATH ] = 'textures/wood.png';
	albedo.colorSpace = SRGBColorSpace;
	albedo.wrapS = RepeatWrapping;
	albedo.repeat.set( 4, 2 );

	const material = new MeshPhysicalMaterial( { roughness: 0.4, map: albedo, name: 'wood' } );
	material.color.setRGB( 0.123456, 0.654321, 0.00123 );
	material.sheenColor.setRGB( 0.3141, 0.2718, 0.1618 );
	material.userData.pbrt = { type: 'coateddiffuse' };
	material.diffuseTransmission = 0.15;
	material.diffuseRoughness = 0.7;
	material.bumpDistance = - 0.0125;
	material.relativeIOR = true;
	material.emissiveSide = FrontSide;
	material.diffuseTransmissionColor = material.color.clone().setRGB( 0.9, 0.5, 0.25 );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] ), 3 ) );
	geometry.setAttribute( 'normal', new BufferAttribute( new Float32Array( [ 0, 0, 1, 0, 0, 1, 0, 0, 1 ] ), 3 ) );
	geometry.setIndex( new BufferAttribute( new Uint16Array( [ 0, 1, 2 ] ), 1 ) );
	geometry.name = 'tri';

	const mesh = new Mesh( geometry, material );
	mesh.name = 'shape_0';
	mesh.position.set( 1, 2, 3 );
	mesh.rotation.set( 0.1, 0.2, 0.3 );
	root.add( mesh );

	const instanced = new InstancedMesh( geometry, material, 3 );
	instanced.name = 'instance_0';
	instanced.frustumCulled = false;
	for ( let i = 0; i < 3; i ++ ) instanced.setMatrixAt( i, new Matrix4().makeTranslation( i, 0, 0 ) );
	root.add( instanced );

	const sibling = new InstancedMesh( geometry, material, 3 );
	sibling.name = 'instance_1';
	sibling.instanceMatrix = instanced.instanceMatrix;
	root.add( sibling );

	const placement = new Group();
	placement.name = 'placement_0';
	placement.add( new Mesh( geometry, material ) );
	root.add( placement );

	const camera = new PerspectiveCamera( 35, 1.5, 0.1, 500 );
	camera.name = 'camera';
	camera.position.set( 0, 1, 10 );
	root.add( camera );

	const env = new DataTexture( new Float32Array( [ 1, 2, 3, 1, 4, 5, 6, 1 ] ), 2, 1, RGBAFormat, FloatType );
	env.userData.__rayzeeSource = 'bytes:abc';

	const clip = new AnimationClip( 'move', 1, [ new VectorKeyframeTrack( 'shape_0.position', [ 0, 1 ], [ 0, 0, 0, 1, 1, 1 ] ) ] );

	return { root, env, clip };

}

describe( 'SceneGraphCodec', () => {

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

	it( 'stores a builder-shaped scene and decodes it back', async () => {

		const { root, env, clip } = buildScene();
		const encoded = encodeSceneGraph( root, { environment: env, animations: [ clip ], stats: { triangleCount: 7 } } );

		const area = storage.area( 'scenes' );
		const writer = await area.create( 'k' );
		await writeSceneGraph( writer, encoded );
		await writer.commit();

		const entry = await area.open( 'k' );
		const requested = [];
		const decoded = await decodeSceneGraph( await entry.json( 'graph.json' ), await entry.file( 'data.bin' ), {
			loadTexture: async ( path, loader ) => {

				requested.push( [ path, loader ] );
				return new Texture();

			},
		} );
		entry.release();

		expect( requested ).toEqual( [[ 'textures/wood.png', 'image' ]] );
		expect( decoded.stats.triangleCount ).toBe( 7 );

		const out = decoded.root;
		expect( out.name ).toBe( 'PBRTScene' );
		expect( out.uuid ).toBe( root.uuid );
		expect( out.children.map( ( c ) => c.name ) ).toEqual( [ 'shape_0', 'instance_0', 'instance_1', 'placement_0', 'camera' ] );

		const [ mesh, instanced, sibling, placement, camera ] = out.children;
		// One matrix list stored once and shared again: the engine places the two as one object.
		expect( sibling.instanceMatrix ).toBe( instanced.instanceMatrix );
		expect( mesh.position.toArray() ).toEqual( [ 1, 2, 3 ] );
		expect( mesh.quaternion.toArray() ).toEqual( root.children[ 0 ].quaternion.toArray() );
		expect( [ ...mesh.geometry.attributes.position.array ] ).toEqual( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
		expect( mesh.geometry.index.array ).toBeInstanceOf( Uint16Array );
		expect( mesh.geometry ).toBe( instanced.geometry );
		expect( mesh.geometry.uuid ).toBe( root.children[ 0 ].geometry.uuid );

		expect( instanced.isInstancedMesh ).toBe( true );
		expect( instanced.count ).toBe( 3 );
		expect( instanced.frustumCulled ).toBe( false );
		const m = new Matrix4();
		instanced.getMatrixAt( 2, m );
		expect( m.elements[ 12 ] ).toBe( 2 );
		expect( instanced.instanceMatrix.isInstancedBufferAttribute ).toBe( true );

		expect( placement.children[ 0 ].material ).toBe( mesh.material );
		const material = mesh.material;
		expect( material.isMeshPhysicalMaterial ).toBe( true );
		expect( material.uuid ).toBe( root.children[ 0 ].material.uuid );
		expect( material.roughness ).toBeCloseTo( 0.4 );
		expect( material.color.toArray() ).toEqual( root.children[ 0 ].material.color.toArray() );
		expect( material.sheenColor.toArray() ).toEqual( root.children[ 0 ].material.sheenColor.toArray() );
		expect( material.userData.pbrt ).toEqual( { type: 'coateddiffuse' } );
		// Engine properties three.js does not serialise.
		expect( material.diffuseTransmission ).toBe( 0.15 );
		expect( material.diffuseRoughness ).toBe( 0.7 );
		expect( material.bumpDistance ).toBe( - 0.0125 );
		expect( material.relativeIOR ).toBe( true );
		expect( material.emissiveSide ).toBe( FrontSide );
		expect( material.diffuseTransmissionColor.toArray() ).toEqual( root.children[ 0 ].material.diffuseTransmissionColor.toArray() );
		expect( material.map.uuid ).toBe( root.children[ 0 ].material.map.uuid );
		expect( material.map.repeat.toArray() ).toEqual( [ 4, 2 ] );
		expect( material.map.colorSpace ).toBe( SRGBColorSpace );
		expect( material.map.userData[ ARCHIVE_PATH ] ).toBe( 'textures/wood.png' );

		expect( camera.isPerspectiveCamera ).toBe( true );
		expect( camera.fov ).toBe( 35 );
		expect( camera.far ).toBe( 500 );

		expect( [ ...decoded.environment.image.data ] ).toEqual( [ 1, 2, 3, 1, 4, 5, 6, 1 ] );
		expect( decoded.environment.userData.__rayzeeSource ).toBe( 'bytes:abc' );
		expect( decoded.animations[ 0 ].tracks[ 0 ].name ).toBe( 'shape_0.position' );

	} );

	it( 'stores lamps with their targets', async () => {

		const root = new Group();
		const spot = new SpotLight( 0xff8800, 12.5, 0, 0.4, 0.25, 2 );
		spot.position.set( 1, 2, 3 );
		spot.target.position.set( 0, - 2, 0 );
		spot.add( spot.target );
		const sun = new DirectionalLight( 0xffffff, 3 );
		sun.position.set( 0, 5, 0 );
		sun.target.position.set( 1, - 5, 0 );
		sun.add( sun.target );
		const point = new PointLight( 0x0000ff, 7 );
		point.userData.__candelaConverted = true;
		root.add( spot, sun, point );

		const encoded = encodeSceneGraph( root );
		const decoded = await decodeSceneGraph( JSON.parse( JSON.stringify( encoded.manifest ) ), new Blob( [] ), { loadTexture: async () => null } );
		const [ s, d, p ] = decoded.root.children;
		decoded.root.updateMatrixWorld( true );

		expect( s.isSpotLight && d.isDirectionalLight && p.isPointLight ).toBe( true );
		expect( [ s.intensity, s.angle, s.penumbra, s.decay ] ).toEqual( [ 12.5, 0.4, 0.25, 2 ] );
		expect( s.color.toArray() ).toEqual( spot.color.toArray() );
		expect( s.target.getWorldPosition( new Vector3() ).toArray() ).toEqual( [ 1, 0, 3 ] );
		expect( d.target.getWorldPosition( new Vector3() ).toArray() ).toEqual( [ 1, 0, 0 ] );
		expect( p.intensity ).toBe( 7 );
		expect( p.userData.__candelaConverted ).toBe( true );

	} );

	it( 'decodes a file once for every texture that reads it, as the build shared it', async () => {

		const root = new Group();
		const geometry = new BufferGeometry();
		const textureOf = ( repeat ) => {

			const texture = new Texture();
			texture.userData[ ARCHIVE_PATH ] = 'textures/normal.png';
			texture.repeat.set( repeat, repeat );
			return texture;

		};

		const a = new MeshPhysicalMaterial( { normalMap: textureOf( 1 ) } );
		const b = new MeshPhysicalMaterial( { normalMap: textureOf( 3 ) } );
		b.normalMap.userData.only = 'b';
		root.add( new Mesh( geometry, a ), new Mesh( geometry, b ) );

		const requested = [];
		const encoded = encodeSceneGraph( root );
		const decoded = await decodeSceneGraph( JSON.parse( JSON.stringify( encoded.manifest ) ), new Blob( [] ), {
			loadTexture: async ( path ) => {

				requested.push( path );
				const texture = new Texture();
				texture.userData.decoded = true;
				return texture;

			},
		} );

		const [ outA, outB ] = decoded.root.children.map( ( mesh ) => mesh.material.normalMap );
		expect( requested ).toEqual( [ 'textures/normal.png' ] );
		// One image, so one layer of a texture array; each texture keeps its own settings.
		expect( outB.source ).toBe( outA.source );
		expect( outA.uuid ).toBe( a.normalMap.uuid );
		expect( outB.uuid ).toBe( b.normalMap.uuid );
		expect( outA.repeat.x ).toBe( 1 );
		expect( outB.repeat.x ).toBe( 3 );
		expect( outB.userData ).toEqual( { [ ARCHIVE_PATH ]: 'textures/normal.png', __rayzeeArchiveLoader: 'image', only: 'b' } );

	} );

	it( 'keeps every property and map the engine reads off a material', async () => {

		// Every MATERIAL_DEFAULTS property away from its default; alphaMode is derived, not set.
		const maps = Object.keys( resolveMaterialTextures( {} ) );
		const make = ( extra ) => {

			const material = Object.assign( new MeshPhysicalMaterial(), {
				roughness: 0.3, metalness: 0.2, ior: 1.37, opacity: 0.8, transmission: 0.4, thickness: 0.6, attenuationDistance: 2.5,
				dispersion: 0.1, sheen: 0.5, sheenRoughness: 0.4, specularIntensity: 0.7, clearcoat: 0.3, clearcoatRoughness: 0.2,
				iridescence: 0.4, iridescenceIOR: 1.6, iridescenceThicknessRange: [ 120, 380 ], bumpScale: 0.5, bumpDistance: 0.02,
				relativeIOR: true, displacementScale: 0.3, displacementBias: 0.1, transparent: true, alphaTest: 0.25, side: DoubleSide,
				depthWrite: false, emissiveIntensity: 2.5, anisotropy: 0.5, anisotropyRotation: 0.7, diffuseTransmission: 0.3,
				diffuseRoughness: 0.4, subsurface: 0.6, subsurfaceRadius: [ 0.5, 0.25, 0.125 ], subsurfaceRadiusScale: 0.3,
				subsurfaceAnisotropy: 0.2,
				subsurfaceColor: new Color( 0.9, 0.4, 0.3 ), diffuseTransmissionColor: new Color( 0.2, 0.7, 0.4 ),
			}, extra );
			material.color.setRGB( 0.6, 0.5, 0.4 );
			material.emissive.setRGB( 0.1, 0.2, 0.3 );
			material.attenuationColor.setRGB( 0.8, 0.7, 0.6 );
			material.sheenColor.setRGB( 0.3, 0.2, 0.1 );
			material.specularColor.setRGB( 0.9, 0.8, 0.7 );
			material.normalScale.set( 0.5, - 0.5 );
			material.clearcoatNormalScale.set( 0.25, 0.75 );
			for ( const key of maps ) {

				material[ key ] = new Texture();
				material[ key ].userData[ ARCHIVE_PATH ] = `textures/${key}.png`;

			}

			return material;

		};

		const material = make();
		// Glass reads as double-sided whatever its side: a second, opaque material carries `side`.
		const opaque = make( { transmission: 0, side: BackSide } );

		const record = ( m ) => new GeometryExtractor().createMaterialObject( m );
		const plain = ( v ) => ( v?.isColor || v?.isVector2 ? v.toArray() : v );
		const before = [ record( material ), record( opaque ) ];
		const untouched = Object.keys( MATERIAL_DEFAULTS ).filter( ( key ) => key !== 'alphaMode'
			&& before.some( ( r ) => JSON.stringify( plain( r[ key ] ) ) === JSON.stringify( MATERIAL_DEFAULTS[ key ] ) ) );
		expect( untouched, 'properties this test leaves at their default' ).toEqual( [ 'transmission' ] );

		const root = new Group();
		root.add( new Mesh( new BoxGeometry(), material ), new Mesh( new BoxGeometry(), opaque ) );
		const area = storage.area( 'scenes' );
		const writer = await area.create( 'all' );
		await writeSceneGraph( writer, encodeSceneGraph( root ) );
		await writer.commit();
		const entry = await area.open( 'all' );
		const decoded = await decodeSceneGraph( await entry.json( 'graph.json' ), await entry.file( 'data.bin' ), {
			loadTexture: async () => new Texture(),
		} );
		entry.release();

		const out = decoded.root.children.map( ( mesh ) => mesh.material );
		for ( const key of maps ) expect( out[ 0 ][ key ]?.uuid, key ).toBe( material[ key ].uuid );
		const packed = ( m ) => [ ...new TextureCreator().createMaterialRawData( [ record( m ) ] ) ];
		expect( packed( out[ 0 ] ) ).toEqual( packed( material ) );
		expect( packed( out[ 1 ] ) ).toEqual( packed( opaque ) );

	} );

	it( 'refuses what it does not know rather than store it wrongly', () => {

		const { root } = buildScene();
		root.add( new HemisphereLight() );
		expect( () => encodeSceneGraph( root ) ).toThrow( SceneGraphUnsupported );

		const plain = new Group();
		plain.add( new Mesh( new BufferGeometry(), new MeshPhysicalMaterial( { map: new Texture() } ) ) );
		expect( () => encodeSceneGraph( plain ) ).toThrow( /no archive path/ );

	} );

} );

describe( 'BLAS cache helpers', () => {

	it( 'checksums positions the same in any order, ignoring lanes a BLAS never reads', () => {

		const records = new ChunkedRecords( 10, 20, Uint32Array, 20 * 4 * 3 );
		for ( let r = 0; r < 10; r ++ ) records.setRecords( r, Uint32Array.from( { length: 20 }, ( _, l ) => r * 100 + l ) );

		const before = rangeChecksum( records, 2, 6 );
		const a = records.copyOf( 3, 1 );
		const b = records.copyOf( 6, 1 );
		records.setRecords( 3, b );
		records.setRecords( 6, a );
		expect( rangeChecksum( records, 2, 6 ) ).toBe( before );

		const uvOnly = records.copyOf( 4, 1 );
		uvOnly[ 13 ] ^= 1;
		records.setRecords( 4, uvOnly );
		expect( rangeChecksum( records, 2, 6 ) ).toBe( before );

		const moved = records.copyOf( 4, 1 );
		moved[ 5 ] ^= 1;
		records.setRecords( 4, moved );
		expect( rangeChecksum( records, 2, 6 ) ).not.toBe( before );

	} );

	it( 'stores only slow builds that read back fast', () => {

		expect( worthStoring( 9_000, 1e6 ) ).toBe( false );
		expect( worthStoring( 20_000, 1e9 ) ).toBe( true );
		expect( worthStoring( 12_000, 9e9 ) ).toBe( false );

	} );

} );

describe( 'a failed BVH build', () => {

	let uninstall, shared;

	beforeEach( async () => {

		uninstall = createFakeOPFS().install();
		shared = await acquireSharedStorage( getAssetConfig().cacheNamespace );

	} );

	afterEach( () => {

		shared.release();
		uninstall();

	} );

	const scene = () => {

		const root = new Group();
		const box = new Mesh( new BoxGeometry( 1, 2, 3 ), new MeshPhysicalMaterial() );
		box.position.set( 3, 0, 0 );
		root.add( new Mesh( new SphereGeometry( 1, 16, 8 ), new MeshPhysicalMaterial() ), box );
		root.updateMatrixWorld( true );
		return root;

	};

	const processor = () => Object.assign( new SceneProcessor(), { _sceneKey: 'two shapes' } );
	// Replacing an entry waits for every reader's lock on it.
	const storeOrLocked = ( sp ) => Promise.race( [ sp._storeBLASes( 'test' ), new Promise( r => setTimeout( () => r( 'locked' ), 2000 ) ) ] );

	// The sphere and box, plus instanced copies sharing one list (a group), over a second template.
	const richScene = () => {

		const root = scene();
		const material = new MeshPhysicalMaterial();
		const trunk = new InstancedMesh( new BoxGeometry( 0.2, 1, 0.2 ), material, 3 );
		const crown = new InstancedMesh( new SphereGeometry( 0.5, 8, 6 ), material, 3 );
		for ( let i = 0; i < 3; i ++ ) trunk.setMatrixAt( i, new Matrix4().makeTranslation( i * 2, 4, 0 ) );
		crown.instanceMatrix = trunk.instanceMatrix;
		root.add( trunk, crown );
		root.updateMatrixWorld( true );
		return root;

	};

	// The first lane whose bits differ, or -1.
	const firstDifference = ( a, b ) => {

		const x = new Uint32Array( a.buffer, a.byteOffset, a.length ), y = new Uint32Array( b.buffer, b.byteOffset, b.length );
		return x.length === y.length ? x.findIndex( ( v, i ) => v !== y[ i ] ) : Math.min( x.length, y.length );

	};

	it( 'restores a stored BVH that keeps every invariant and is the fresh build bit for bit', async () => {

		const fresh = processor();
		await fresh._extractGeometry( richScene() );
		await fresh._buildBVH();
		expect( await fresh._storeBLASes( 'test' ) ).toBe( true );

		const again = processor();
		await again._extractGeometry( richScene() );
		await again._buildBVH();
		expect( again._blasRestored ).toBe( true );
		expect( again.instanceGroups.length ).toBe( 1 );

		const { problems, stats } = inspectBVH( again.bvh, again.triangles, { table: again.instanceTable } );
		expect( problems ).toEqual( [] );
		expect( stats.groupCopies ).toBe( 3 );
		const nodes = ( sp ) => sp.bvh.single ?? sp.bvh.copyOf( 0, sp.bvh.recordCount );
		const triangles = ( sp ) => sp.triangles.single ?? sp.triangles.copyOf( 0, sp.triangles.recordCount );
		expect( firstDifference( nodes( again ), nodes( fresh ) ) ).toBe( - 1 );
		expect( firstDifference( triangles( again ), triangles( fresh ) ) ).toBe( - 1 );
		fresh.dispose();
		again.dispose();

	} );

	it( 'lets go of a stored BVH when the build that restored it fails', async () => {

		const first = processor();
		await first._extractGeometry( scene() );
		await first._buildBVH();
		expect( await first._storeBLASes( 'test' ) ).toBe( true );

		const failing = processor();
		const overBudget = new Error( 'over the memory budget' );
		failing._checkAssemblyHeadroom = () => {

			throw overBudget;

		};

		await failing._extractGeometry( scene() );
		await expect( failing._buildBVH() ).rejects.toBe( overBudget );
		expect( failing._blasRestored ).toBe( true );

		expect( await storeOrLocked( first ) ).toBe( true );
		first.dispose();
		failing.dispose();

	} );

	it( 'drops the BLAS nodes it spilled', async () => {

		const spillArea = shared.storage.area( 'spill' );
		const blasStore = await SpillStore.create( shared.storage, 'spill:failed:blas', 0 );
		await blasStore.writeAt( 0, new Float32Array( 64 ) );
		await blasStore.flush();
		expect( await spillArea.list() ).toHaveLength( 1 );

		const sp = processor();
		await sp._extractGeometry( scene() );
		const writeFailed = new Error( 'disk full' );
		sp._buildBLASes = async ( ranges, startProgress, build ) => {

			build.spill = { chain: Promise.resolve(), blasStore };
			throw writeFailed;

		};

		await expect( sp._buildBVH() ).rejects.toBe( writeFailed );
		expect( await spillArea.list() ).toHaveLength( 0 );
		sp.dispose();

	} );


	describe( 'are used only for what they were built over', () => {

		const stored = async ( root ) => {

			const sp = processor();
			await sp._extractGeometry( root );
			await sp._buildBVH();
			expect( await sp._storeBLASes( 'test' ) ).toBe( true );
			return sp;

		};

		const rebuilt = async ( root, edit = () => {} ) => {

			const sp = processor();
			edit( sp );
			await sp._extractGeometry( root );
			await sp._buildBVH();
			const { problems } = inspectBVH( sp.bvh, sp.triangles, { table: sp.instanceTable } );
			expect( problems ).toEqual( [] );
			return sp;

		};

		it( 'rebuilds when the triangles changed under the same layout', async () => {

			const first = await stored( scene() );
			const moved = scene();
			moved.children[ 1 ].position.x = 4;
			moved.updateMatrixWorld( true );
			const again = await rebuilt( moved );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

		it( 'rebuilds when the layout changed', async () => {

			const first = await stored( scene() );
			const finer = scene();
			finer.children[ 0 ].geometry = new SphereGeometry( 1, 20, 10 );
			const again = await rebuilt( finer );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

		// Rewrites the stored entry with its index changed by `edit`.
		const tamper = async ( key, edit ) => {

			const area = shared.storage.area( 'scenes' );
			const entry = await area.open( key );
			const index = await entry.json( 'index.json' );
			const nodes = new Uint8Array( await ( await entry.file( 'nodes.f32' ) ).arrayBuffer() );
			const order = new Uint8Array( await ( await entry.file( 'order.u32' ) ).arrayBuffer() );
			entry.release();
			const writer = await area.create( key );
			await writer.write( 'nodes.f32', nodes );
			await writer.write( 'order.u32', order );
			await writer.writeJSON( 'index.json', edit( index ) );
			await writer.commit();

		};

		it( 'refuses an entry stored in another format', async () => {

			const first = await stored( scene() );
			await tamper( first._blasKey, ( index ) => ( { ...index, v: index.v + 1 } ) );
			const again = await rebuilt( scene() );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

		// The same triangles, so only the layout checks can tell.
		it.each( [
			[ 'the BLASes start elsewhere', ( index ) => ( { ...index, tlasNodeCount: index.tlasNodeCount + 1 } ) ],
			[ 'a template sits elsewhere', ( index ) => ( { ...index, templates: index.templates.map( ( t, i ) => i === 1 ? [ t[ 0 ], t[ 1 ], t[ 2 ], t[ 3 ], t[ 4 ] + 1, ...t.slice( 5 ) ] : t ) } ) ],
			[ 'the node count is off', ( index ) => ( { ...index, totalNodes: index.totalNodes + 1 } ) ],
		] )( 'refuses an entry whose layout does not match: %s', async ( _, edit ) => {

			const first = await stored( scene() );
			await tamper( first._blasKey, edit );
			const again = await rebuilt( scene() );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

		it( 'stores nothing for a scene that changed while it was being stored', async () => {

			const first = processor();
			await first._extractGeometry( scene() );
			await first._buildBVH();
			const area = shared.storage.area( 'scenes' );
			const create = area.create;
			area.create = async ( ...args ) => {

				const writer = await create.apply( area, args );
				const write = writer.write;
				writer.write = ( ...a ) => {

					first._geometryVersion ++;
					return write.apply( writer, a );

				};

				return writer;

			};

			try {

				expect( await first._storeBLASes( 'test' ) ).toBe( false );

			} finally {

				area.create = create;

			}

			const again = await rebuilt( scene() );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

		it( 'restores nothing with the scene cache off', async () => {

			const first = await stored( scene() );
			const again = await rebuilt( scene(), ( sp ) => void ( sp.config.sceneCache = false ) );
			expect( again._blasRestored ).toBeFalsy();
			first.dispose();
			again.dispose();

		} );

	} );

} );
