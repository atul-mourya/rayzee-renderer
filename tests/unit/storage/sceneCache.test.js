import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	AnimationClip, BufferAttribute, BufferGeometry, DataTexture, FloatType, Group, InstancedMesh, Matrix4, Mesh,
	MeshPhysicalMaterial, PerspectiveCamera, RGBAFormat, RepeatWrapping, SRGBColorSpace, Texture, VectorKeyframeTrack, PointLight,
	SpotLight, DirectionalLight, HemisphereLight, Vector3,
} from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { encodeSceneGraph, writeSceneGraph, decodeSceneGraph, SceneGraphUnsupported, ARCHIVE_PATH } from '@/core/Storage/SceneGraphCodec.js';
import { rangeChecksum } from '@/core/Storage/BLASCache.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { worthStoring } from '@/core/Storage/sceneCachePolicy.js';

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
		expect( out.children.map( ( c ) => c.name ) ).toEqual( [ 'shape_0', 'instance_0', 'placement_0', 'camera' ] );

		const [ mesh, instanced, placement, camera ] = out.children;
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
