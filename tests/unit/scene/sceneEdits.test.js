import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mesh, MeshStandardMaterial, Object3D, Scene, Texture, BufferGeometry, SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace } from 'three';
import * as SceneEdits from '@/core/scene/SceneEdits.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

const flush = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

function makeApp( { sdf = {}, pathTracer = {} } = {} ) {

	const calls = [];
	const log = ( name ) => vi.fn( ( ...args ) => void calls.push( [ name, ...args ] ) );
	const app = {
		calls,
		_issues: new IssueLog(),
		settings: { set: vi.fn() },
		reset: log( 'reset' ),
		ensureSceneResident: vi.fn( async () => void calls.push( [ 'resident' ] ) ),
		_notePlacementsMoving: log( 'noteMoving' ),
		stages: {
			pathTracer: {
				updateTriangleData: log( 'triangles' ),
				updateBVHData: log( 'bvh' ),
				updateBufferRanges: log( 'ranges' ),
				setEmissiveTriangleData: log( 'emissive' ),
				setLightBVHData: log( 'lightBVH' ),
				updateMeshVisibility: log( 'meshVisibility' ),
				updateAllMeshVisibility: log( 'allVisibility' ),
				materialData: {
					getMaterialProperty: vi.fn( () => 0.5 ),
					getMaterialPropertySource: vi.fn( () => 'host' ),
					updateMaterialProperty: log( 'material' ),
					updateTextureTransform: log( 'textureTransform' ),
				},
				...pathTracer,
			},
		},
		_sdf: {
			triangles: 'triangle store',
			bvh: 'bvh store',
			...sdf,
		},
	};

	for ( const name of [ 'updateMeshTransforms', 'setMaterialProperty', 'updateAllMeshVisibility', 'rebuildMaterials' ] ) {

		app[ name ] = vi.fn( ( ...args ) => SceneEdits[ name ]( app, ...args ) );

	}

	app._uploadEmissivePayload = ( payload ) => SceneEdits.uploadEmissivePayload( app, payload );
	app._refreshEmissiveForVisibility = vi.fn( () => void calls.push( [ 'refreshEmissive' ] ) );
	return app;

}

afterEach( () => vi.useRealTimers() );

describe( 'refitting geometry', () => {

	it( 'brings a spilled scene back first, then uploads the refit ranges and keeps motion history', async () => {

		const app = makeApp( { sdf: { refitBVH: vi.fn( async () => {

			app.calls.push( [ 'refit' ] );
			return { triRanges: [[ 0, 9 ]], bvhRanges: [[ 0, 16 ]], refitTimeMs: 3 };

		} ) } } );

		await expect( SceneEdits.refitBVH( app, 'positions', 'normals' ) ).resolves.toEqual( { refitTimeMs: 3 } );
		expect( app._sdf.refitBVH ).toHaveBeenCalledWith( 'positions', 'normals' );
		expect( app.calls ).toEqual( [
			[ 'resident' ], [ 'refit' ],
			[ 'triangles', 'triangle store', [[ 0, 9 ]]],
			[ 'bvh', 'bvh store', [[ 0, 16 ]]],
			[ 'reset', false, { motion: true } ],
		] );

	} );

	it( 'refuses a per-mesh refit on a spilled scene before touching anything', () => {

		const app = makeApp( { sdf: { spilled: true, refitBLASes: vi.fn() } } );

		expect( () => SceneEdits.refitBLASes( app, [ 0 ], 'positions' ) ).toThrow( /ensureSceneResident/ );
		expect( app._sdf.refitBLASes ).not.toHaveBeenCalled();
		expect( app.reset ).not.toHaveBeenCalled();

	} );

	it( 'uploads only the refit meshes, then each rebuilt mesh again once its background build lands', () => {

		let onSwap;
		const app = makeApp( { sdf: {
			refitBLASes: vi.fn( () => ( { refitTimeMs: 1 } ) ),
			computeBLASDirtyRanges: vi.fn( ( meshes ) => ( { triRanges: meshes.map( m => [ 'tri', m ] ), bvhRanges: meshes.map( m => [ 'node', m ] ) } ) ),
			scheduleBackgroundRebuild: vi.fn( ( meshes, done ) => void ( onSwap = done ) ),
		} } );

		expect( SceneEdits.refitBLASes( app, [ 2, 5 ], 'positions', 'normals' ) ).toEqual( { refitTimeMs: 1 } );
		expect( app._sdf.refitBLASes ).toHaveBeenCalledWith( [ 2, 5 ], 'positions', 'normals' );
		expect( app.calls ).toEqual( [
			[ 'ranges', [[ 'tri', 2 ], [ 'tri', 5 ]], [[ 'node', 2 ], [ 'node', 5 ]]],
			[ 'reset', false, { motion: true } ],
		] );
		expect( app._sdf.scheduleBackgroundRebuild.mock.calls[ 0 ][ 0 ] ).toEqual( [ 2, 5 ] );

		app.calls.length = 0;
		onSwap( 5 );
		expect( app.calls ).toEqual( [
			[ 'ranges', [[ 'tri', 5 ]], [[ 'node', 5 ]]],
			[ 'reset', false, { motion: true } ],
		] );

	} );

} );

describe( 'moving placements', () => {

	function movable( sdf = {} ) {

		return makeApp( { sdf: {
			needsPageInForMove: () => false,
			updateMeshTransforms: vi.fn( () => {

				app.calls.push( [ 'move' ] );
				return { refitTimeMs: 0.2, placements: 3 };

			} ),
			takeMoveRanges: () => [[ 'tlas', 0 ]],
			...sdf,
		} } );

	}

	let app;

	it( 'tells the denoiser before the move, uploads only the TLAS ranges, and keeps motion history', () => {

		app = movable();
		expect( SceneEdits.updateMeshTransforms( app, [ 4 ] ) ).toEqual( { refitTimeMs: 0.2, placements: 3 } );
		expect( app.calls ).toEqual( [
			[ 'noteMoving', [ 4 ]], [ 'move' ],
			[ 'ranges', [], [[ 'tlas', 0 ]]],
			[ 'reset', false, { motion: true } ],
		] );

	} );

	it( 'waits for a spilled scene\'s matrices, then moves', async () => {

		let pagedIn = false;
		app = movable( {
			needsPageInForMove: () => ! pagedIn,
			ensureMovable: vi.fn( async () => void ( pagedIn = true ) ),
		} );

		expect( SceneEdits.updateMeshTransforms( app, [ 1 ] ) ).toBeNull();
		expect( app._sdf.updateMeshTransforms ).not.toHaveBeenCalled();
		await flush();
		expect( app._sdf.ensureMovable ).toHaveBeenCalledWith( [ 1 ] );
		expect( app._sdf.updateMeshTransforms ).toHaveBeenCalledWith( [ 1 ] );

	} );

	it( 'records a failed read-back instead of moving', async () => {

		app = movable( {
			needsPageInForMove: () => true,
			ensureMovable: async () => {

				throw new Error( 'disk gone' );

			},
		} );

		SceneEdits.updateMeshTransforms( app, [ 1 ] );
		await flush();
		expect( app._sdf.updateMeshTransforms ).not.toHaveBeenCalled();
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.STORAGE_READ_FAILED, message: expect.stringContaining( 'disk gone' ) } ] );

	} );

	it( 'puts a spilling scene back on disk once moves go quiet', () => {

		vi.useFakeTimers();
		app = movable( { spilling: true, respill: vi.fn( async () => {} ) } );

		SceneEdits.updateMeshTransforms( app, [ 0 ] );
		vi.advanceTimersByTime( 20_000 );
		SceneEdits.updateMeshTransforms( app, [ 0 ] );
		vi.advanceTimersByTime( 20_000 );
		expect( app._sdf.respill ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 10_000 );
		expect( app._sdf.respill ).toHaveBeenCalledOnce();

	} );

} );

describe( 'material edits', () => {

	it( 'reads back what the shader uses, and nothing before the path tracer exists', () => {

		const app = makeApp();
		expect( SceneEdits.getMaterialProperty( app, 2, 'roughness' ) ).toBe( 0.5 );
		expect( SceneEdits.getMaterialPropertySource( app, 2, 'roughness' ) ).toBe( 'host' );
		app.stages.pathTracer = null;
		expect( SceneEdits.getMaterialProperty( app, 2, 'roughness' ) ).toBeUndefined();
		expect( SceneEdits.getMaterialPropertySource( app, 2, 'roughness' ) ).toBeUndefined();

	} );

	it( 'rebuilds the emitter list for an emission edit and uploads its light tree', () => {

		const payload = { rawData: 'rows', emissiveCount: 4, totalPower: 9, bitTrailMap: 'trail', lightBVHNodeData: 'nodes', lightBVHNodeCount: 7 };
		const app = makeApp( { sdf: { updateMaterialEmissive: vi.fn( () => payload ) } } );

		SceneEdits.setMaterialProperty( app, 3, 'emissiveIntensity', 5 );
		expect( app._sdf.updateMaterialEmissive ).toHaveBeenCalledWith( 3, 'emissiveIntensity', 5 );
		expect( app.calls ).toEqual( [
			[ 'material', 3, 'emissiveIntensity', 5 ],
			[ 'emissive', 'rows', 4, 9, 'trail' ],
			[ 'lightBVH', 'nodes', 7 ],
			[ 'reset' ],
		] );

	} );

	it( 'leaves the emitters alone for any other property', () => {

		const app = makeApp( { sdf: { updateMaterialEmissive: vi.fn() } } );
		SceneEdits.setMaterialProperty( app, 3, 'roughness', 0.2 );
		expect( app._sdf.updateMaterialEmissive ).not.toHaveBeenCalled();
		expect( app.calls ).toEqual( [[ 'material', 3, 'roughness', 0.2 ], [ 'reset' ]] );

	} );

	it( 'reads a spilled scene back before an edit that rewrites triangle records', async () => {

		const app = makeApp( { sdf: { spilled: true, updateMaterialEmissive: () => null } } );
		app.ensureSceneResident = vi.fn( async () => {

			app._sdf.spilled = false;

		} );

		SceneEdits.setMaterialProperty( app, 1, 'side', 2 );
		expect( app.stages.pathTracer.materialData.updateMaterialProperty ).not.toHaveBeenCalled();
		await flush();
		expect( app.stages.pathTracer.materialData.updateMaterialProperty ).toHaveBeenCalledWith( 1, 'side', 2 );

		SceneEdits.setMaterialProperty( app, 1, 'roughness', 0.4 );
		expect( app.stages.pathTracer.materialData.updateMaterialProperty ).toHaveBeenLastCalledWith( 1, 'roughness', 0.4 );

	} );

	it( 'records a failed read-back instead of dropping a material edit silently', async () => {

		const app = makeApp( { sdf: { spilled: true } } );
		app.ensureSceneResident = vi.fn( async () => {

			throw new Error( 'spill file gone' );

		} );

		SceneEdits.setMaterialProperty( app, 1, 'side', 2 );
		await flush();
		expect( app.stages.pathTracer.materialData.updateMaterialProperty ).not.toHaveBeenCalled();
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.STORAGE_READ_FAILED, message: expect.stringContaining( 'spill file gone' ) } ] );

	} );

	it( 'edits a spilled scene\'s materials in place when no triangle record changes', () => {

		const app = makeApp( { sdf: { spilled: true } } );
		SceneEdits.setMaterialProperty( app, 1, 'metalness', 1 );
		expect( app.ensureSceneResident ).not.toHaveBeenCalled();
		expect( app.stages.pathTracer.materialData.updateMaterialProperty ).toHaveBeenCalledWith( 1, 'metalness', 1 );

	} );

	it( 'uploads nothing for an empty payload, and no light tree it does not carry', () => {

		const app = makeApp();
		SceneEdits.uploadEmissivePayload( app, null );
		SceneEdits.uploadEmissivePayload( app, { rawData: 'rows', emissiveCount: 0, totalPower: 0, bitTrailMap: null } );
		expect( app.calls ).toEqual( [[ 'emissive', 'rows', 0, 0, null ]] );

		app.stages.pathTracer = null;
		expect( () => SceneEdits.uploadEmissivePayload( app, { rawData: 'rows' } ) ).not.toThrow();

	} );

	it( 'applies a texture transform and restarts', () => {

		const app = makeApp();
		SceneEdits.setTextureTransform( app, 0, 'map', { repeat: [ 2, 2 ] } );
		expect( app.calls ).toEqual( [[ 'textureTransform', 0, 'map', { repeat: [ 2, 2 ] } ], [ 'reset' ]] );

	} );

} );

describe( 'emissive sampling', () => {

	it( 'drops the emitters of hidden placements, by the mesh each one shows', () => {

		const rebuildEmissiveForVisibility = vi.fn( () => null );
		const app = makeApp( { sdf: {
			instanceTable: {
				count: 4,
				isSet: [ 1, 1, 0, 1 ],
				visible: [ 1, 0, 0, 0 ],
				sourceMesh: [ 7, 8, 9, 8 ],
			},
			rebuildEmissiveForVisibility,
		} } );

		SceneEdits.refreshEmissiveForVisibility( app );
		expect( [ ...rebuildEmissiveForVisibility.mock.calls[ 0 ][ 0 ] ] ).toEqual( [ 8 ] );

	} );

	it( 'does nothing before a scene is built', () => {

		const app = makeApp();
		app._sdf = null;
		expect( () => SceneEdits.refreshEmissiveForVisibility( app ) ).not.toThrow();

	} );

	it( 'marks the toggle as the user\'s, so a rebuild stops following the scene', () => {

		const app = makeApp();
		SceneEdits.setEmissiveTriangleSampling( app, false );
		expect( app._emissiveSamplingUserSet ).toBe( true );
		expect( app.settings.set ).toHaveBeenCalledWith( 'enableEmissiveTriangleSampling', false );

	} );

	it( 'counts hidden emitters as emissive geometry', () => {

		const app = makeApp( { sdf: { emissiveTriangleBuilder: { emissiveTriangles: [ 1, 2 ] }, emissiveTriangleCount: 0 } } );
		expect( SceneEdits.hasEmissiveGeometry( app ) ).toBe( true );

		app._sdf = { emissiveTriangleCount: 3 };
		expect( SceneEdits.hasEmissiveGeometry( app ) ).toBe( true );
		app._sdf = { emissiveTriangleBuilder: { emissiveTriangles: [] }, emissiveTriangleCount: 3 };
		expect( SceneEdits.hasEmissiveGeometry( app ) ).toBe( false );
		app._sdf = null;
		expect( SceneEdits.hasEmissiveGeometry( app ) ).toBe( false );

	} );

} );

describe( 'visibility', () => {

	it( 'patches the TLAS, refreshes the emitters and restarts, at once when the TLAS is in memory', () => {

		const app = makeApp( { sdf: { whenTLASEditable: () => null } } );

		SceneEdits.setMeshVisibility( app, 3, false );
		SceneEdits.updateAllMeshVisibility( app );
		expect( app.calls ).toEqual( [
			[ 'meshVisibility', 3, false ], [ 'refreshEmissive' ], [ 'reset' ],
			[ 'allVisibility' ], [ 'refreshEmissive' ], [ 'reset' ],
		] );

	} );

	it( 'waits for a spilled TLAS', async () => {

		let back;
		const app = makeApp( { sdf: { whenTLASEditable: () => new Promise( ( resolve ) => void ( back = resolve ) ) } } );

		SceneEdits.setMeshVisibility( app, 1, true );
		expect( app.calls ).toEqual( [] );
		back();
		await flush();
		expect( app.calls ).toEqual( [[ 'meshVisibility', 1, true ], [ 'refreshEmissive' ], [ 'reset' ]] );

	} );

	it( 'records a TLAS that could not be read back, and changes nothing', async () => {

		const app = makeApp( { sdf: { whenTLASEditable: async () => {

			throw new Error( 'file vanished' );

		} } } );

		SceneEdits.updateAllMeshVisibility( app );
		await flush();
		expect( app.calls ).toEqual( [] );
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.STORAGE_READ_FAILED, message: expect.stringContaining( 'file vanished' ) } ] );

	} );

	it( 'sets, toggles and coerces an object\'s visibility by uuid', () => {

		const scene = new Scene();
		const object = new Object3D();
		scene.add( object );
		const app = makeApp();
		app.getScene = () => scene;
		app.updateAllMeshVisibility = vi.fn();

		expect( SceneEdits.setMeshVisibilityByUuid( app, object.uuid, false ) ).toBe( false );
		expect( object.visible ).toBe( false );
		expect( SceneEdits.setMeshVisibilityByUuid( app, object.uuid, prev => ! prev ) ).toBe( true );
		expect( SceneEdits.setMeshVisibilityByUuid( app, object.uuid, 0 ) ).toBe( false );
		expect( app.updateAllMeshVisibility ).toHaveBeenCalledTimes( 3 );

		expect( SceneEdits.setMeshVisibilityByUuid( app, 'nope', true ) ).toBeNull();
		app.getScene = () => null;
		expect( SceneEdits.setMeshVisibilityByUuid( app, object.uuid, true ) ).toBeNull();
		expect( app.updateAllMeshVisibility ).toHaveBeenCalledTimes( 3 );

	} );

} );

describe( 'a texture\'s colour space', () => {

	function textured( { config = false, scene = true } = {} ) {

		const app = makeApp();
		app.color = { hasConfig: config };
		app.rebuildMaterials = vi.fn( async () => {} );
		if ( scene ) app.stages.pathTracer.sdfs = {};
		const texture = new Texture();
		texture.colorSpace = NoColorSpace;
		return { app, texture };

	}

	it( 'wants a three.js texture', async () => {

		const { app } = textured();
		await expect( SceneEdits.setTextureColorSpace( app, { colorSpace: 'srgb' }, 'srgb' ) ).rejects.toThrow( /three.js texture/ );

	} );

	it( 'overrides with three\'s own two, and puts the original back when cleared', async () => {

		const { app, texture } = textured();
		const version = texture.version;

		await SceneEdits.setTextureColorSpace( app, texture, 'srgb' );
		expect( texture.colorSpace ).toBe( SRGBColorSpace );
		expect( texture.userData.__rayzeeColorSpaceChoice ).toBe( 'srgb' );
		await SceneEdits.setTextureColorSpace( app, texture, 'linear' );
		expect( texture.colorSpace ).toBe( LinearSRGBColorSpace );

		await SceneEdits.setTextureColorSpace( app, texture, null );
		expect( texture.colorSpace ).toBe( NoColorSpace );
		expect( texture.userData ).toEqual( {} );
		expect( texture.version ).toBe( version + 3 );
		expect( app.rebuildMaterials ).toHaveBeenCalledTimes( 3 );

	} );

	it( 'takes a config space only with a config loaded, read raw', async () => {

		const { app, texture } = textured();
		await expect( SceneEdits.setTextureColorSpace( app, texture, 'ACEScg' ) ).rejects.toThrow( /needs a colour config/ );
		expect( app.rebuildMaterials ).not.toHaveBeenCalled();

		app.color.hasConfig = true;
		await SceneEdits.setTextureColorSpace( app, texture, 'ACEScg' );
		expect( texture.userData.ocioColorSpace ).toBe( 'ACEScg' );
		expect( texture.colorSpace ).toBe( SRGBColorSpace );

		await SceneEdits.setTextureColorSpace( app, texture, 'linear' );
		expect( texture.userData.ocioColorSpace ).toBeUndefined();
		expect( texture.userData.__rayzeeOriginalColorSpace ).toBe( NoColorSpace );

	} );

	it( 'rebuilds nothing before a scene exists', async () => {

		const { app, texture } = textured( { scene: false } );
		await SceneEdits.setTextureColorSpace( app, texture, 'srgb' );
		expect( app.rebuildMaterials ).not.toHaveBeenCalled();

	} );

} );

describe( 'rebuilding materials', () => {

	function withScene( { withoutUV, textured } ) {

		const material = new MeshStandardMaterial();
		if ( textured ) material.map = new Texture();
		const scene = new Scene().add( new Mesh( new BufferGeometry(), material ) );
		const app = makeApp( { sdf: { triangles: 'records', triangleCount: 12 }, pathTracer: {
			rebuildMaterials: vi.fn( async () => void app.calls.push( [ 'rebuild' ] ) ),
			triangleStorageNode: { withoutUV },
			setTriangleData: vi.fn(),
			setupMaterial: vi.fn(),
		} } );
		app.meshScene = scene;
		return { app, scene };

	}

	it( 'reads a spilled scene back, rebuilds from the scene, and restarts', async () => {

		const { app, scene } = withScene( { withoutUV: false, textured: true } );
		await SceneEdits.rebuildMaterials( app );
		expect( app.stages.pathTracer.rebuildMaterials ).toHaveBeenCalledWith( scene );
		expect( app.calls ).toEqual( [[ 'resident' ], [ 'rebuild' ], [ 'reset' ]] );
		expect( app.stages.pathTracer.setTriangleData ).not.toHaveBeenCalled();

	} );

	it( 'uploads texture coordinates again once a scene loaded without them gains a texture', async () => {

		const { app } = withScene( { withoutUV: true, textured: true } );
		await SceneEdits.rebuildMaterials( app );
		expect( app._sdf.textureCoordinates ).toBe( true );
		expect( app.stages.pathTracer.setTriangleData ).toHaveBeenCalledWith( 'records', 12, { textureCoordinates: true } );
		expect( app.stages.pathTracer.setupMaterial ).toHaveBeenCalledOnce();

	} );

	it( 'keeps the coordinates out while nothing is textured', async () => {

		const { app } = withScene( { withoutUV: true, textured: false } );
		const other = new Scene();
		await SceneEdits.rebuildMaterials( app, other );
		expect( app.stages.pathTracer.rebuildMaterials ).toHaveBeenCalledWith( other );
		expect( app.stages.pathTracer.setTriangleData ).not.toHaveBeenCalled();

	} );

} );
