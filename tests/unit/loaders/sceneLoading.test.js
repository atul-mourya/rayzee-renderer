import { describe, it, expect, vi, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene, Texture } from 'three';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { EngineEvents, setStatusCallback } from '@/core/EngineEvents.js';
import { IssueLog, EngineIssueError, ISSUE_CODES } from '@/core/EngineIssues.js';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { SPILL_ENVIRONMENT_WIDTH } from '@/core/memory/HostMemory.js';

const FORMATS = { glb: 'model', gltf: 'model', hdr: 'environment', png: 'image' };

function assetLoader( extra = {} ) {

	return {
		getFileFormat: ( name ) => {

			const type = FORMATS[ String( name ).split( '.' ).pop().toLowerCase() ];
			return type ? { type } : null;

		},
		formatError: ( name ) => new Error( `unsupported: ${name}` ),
		loadModel: vi.fn( async () => {} ),
		loadObject3D: vi.fn( async () => {} ),
		loadAssetFromUrl: vi.fn( async () => {} ),
		loadAssetFromFile: vi.fn( async () => {} ),
		loadExampleModels: vi.fn( async () => {} ),
		loadEnvironment: vi.fn( async () => {} ),
		loadFolder: vi.fn( async () => {} ),
		releaseTargetModel: vi.fn(),
		removeModelRoot: vi.fn(),
		commitPendingGraph: vi.fn(),
		cancelActiveLoad: vi.fn(),
		...extra,
	};

}

function makeApp( extra = {} ) {

	const events = [];
	const app = Object.assign( Object.create( RayzeeRenderer.prototype ), {
		events,
		_loadingInProgress: false,
		_memorySpill: 'auto',
		_spillPlan: null,
		_issues: new IssueLog(),
		_applySceneMetadataEnabled: true,
		_unlitRestore: null,
		_applyingSceneMetadata: false,
		settings: new RenderSettings(),
		assetLoader: assetLoader(),
		meshScene: new Scene(),
		stages: { pathTracer: { environment: { setEnvironmentMap: vi.fn( async () => {} ), applyHDRI: vi.fn( async () => {} ), beginHDRI: vi.fn() } } },
		pipeline: { eventBus: { emit: vi.fn() } },
		reset: vi.fn(),
		dispatchEvent: ( event ) => void events.push( event ),
		loadSceneData: vi.fn( async () => true ),
		_sceneBudgets: ( options ) => options,
		_planSpill: vi.fn(),
		_maybeSpill: vi.fn(),
		...extra,
	} );
	return app;

}

const types = ( app ) => app.events.map( e => e.type );

afterEach( () => {

	setStatusCallback( null );
	vi.restoreAllMocks();

} );

describe( 'a replace-load', () => {

	it( 'records where the model came from, builds it, announces it, then stores its graph', async () => {

		const app = makeApp();
		const model = new Group();
		app.assetLoader.targetModel = model;
		app._emissiveSamplingUserSet = true;
		app._sceneSourceInput = 'a stale file';

		await app.loadModel( 'https://x.test/chair.glb', { cacheKey: 'chair-v2' } );

		expect( app.assetLoader.loadModel ).toHaveBeenCalledWith( 'https://x.test/chair.glb', { cacheKey: 'chair-v2' } );
		expect( app.sceneSource ).toEqual( { kind: 'url', url: 'https://x.test/chair.glb', cacheKey: 'chair-v2' } );
		expect( app._sceneSourceInput ).toBeNull();
		expect( app._emissiveSamplingUserSet ).toBe( false );
		expect( app.pipeline.eventBus.emit ).toHaveBeenCalledWith( 'pipeline:lightingChanged' );
		expect( app.events ).toEqual( [ { type: EngineEvents.MODEL_LOADED, url: 'https://x.test/chair.glb' } ] );
		expect( app.assetLoader.commitPendingGraph ).toHaveBeenCalledWith( model );
		expect( app._loadingInProgress ).toBe( false );
		expect( app._spillPlan ).toBeNull();

	} );

	it( 'stores no graph for a build that declined', async () => {

		const app = makeApp( { loadSceneData: vi.fn( async () => false ) } );
		await app.loadObject3D( new Object3D() );

		expect( app.sceneSource ).toEqual( { kind: 'object3d', name: 'object3d' } );
		expect( app.assetLoader.commitPendingGraph ).not.toHaveBeenCalled();

	} );

	it( 'drops the models appended to the previous scene', async () => {

		const app = makeApp();
		const floor = new Mesh();
		const primary = new Group();
		const appended = Object.assign( new Group(), { userData: { __rayzeeSceneObject: true } } );
		const helper = new Group();
		app.meshScene.add( floor, primary, appended, helper );
		app.assetLoader.floorPlane = floor;
		primary.userData.__rayzeeSceneObject = true;
		app.assetLoader.targetModel = primary;

		await app.loadExampleModels( 1, [ { url: 'a.glb' }, { url: 'b.glb' } ] );

		expect( app.assetLoader.removeModelRoot.mock.calls ).toEqual( [[ appended ]] );
		expect( app.sceneSource ).toEqual( { kind: 'url', url: 'b.glb', cacheKey: null } );

		await app.loadExampleModels( 5, [] );
		expect( app.sceneSource.url ).toBeNull();

	} );

	it( 'narrows the sky only when every scene spills', async () => {

		const app = makeApp( { _memorySpill: true } );
		app.loadSceneData = vi.fn( async () => {

			expect( app.assetLoader.maxEnvironmentWidth ).toBe( SPILL_ENVIRONMENT_WIDTH );
			return true;

		} );
		await app.loadModel( 'a.glb' );

		app._memorySpill = 'auto';
		app.loadSceneData = vi.fn( async () => {

			expect( app.assetLoader.maxEnvironmentWidth ).toBe( 0 );
			return true;

		} );
		await app.loadModel( 'a.glb' );
		expect( app.loadSceneData ).toHaveBeenCalledOnce();

	} );

	it( 'refuses a second load while one runs, and leaves the running one\'s flag alone', async () => {

		const app = makeApp( { _loadingInProgress: true } );

		await expect( app.loadModel( 'a.glb' ) ).rejects.toMatchObject( { code: 'LOAD_IN_PROGRESS' } );
		await expect( app.loadEnvironment( 'sky.hdr' ) ).rejects.toMatchObject( { code: 'LOAD_IN_PROGRESS' } );
		expect( app.assetLoader.loadModel ).not.toHaveBeenCalled();
		expect( app.assetLoader.loadEnvironment ).not.toHaveBeenCalled();
		expect( app._loadingInProgress ).toBe( true );

	} );

	it( 'holds the flag from the first await, so a load started meanwhile is refused', async () => {

		let finish;
		const parsed = new Promise( ( resolve ) => void ( finish = resolve ) );
		const app = makeApp();
		app.assetLoader.loadModel = vi.fn( () => parsed );

		const first = app.loadModel( 'a.glb' );
		const second = app.loadModel( 'b.glb' );
		finish();
		await expect( second ).rejects.toMatchObject( { code: 'LOAD_IN_PROGRESS' } );
		await first;
		expect( app.assetLoader.loadModel ).toHaveBeenCalledOnce();
		expect( app.sceneSource.url ).toBe( 'a.glb' );

	} );

	it( 'leaves the scene alone when the loader itself says another load is running', async () => {

		const app = makeApp();
		app._sceneSource = { kind: 'url', url: 'kept.glb' };
		app.assetLoader.loadModel = async () => {

			throw Object.assign( new Error( 'busy' ), { code: 'LOAD_IN_PROGRESS' } );

		};

		await expect( app.loadModel( 'b.glb' ) ).rejects.toThrow( 'busy' );
		expect( app.assetLoader.releaseTargetModel ).not.toHaveBeenCalled();
		expect( app.sceneSource ).toEqual( { kind: 'url', url: 'kept.glb' } );

	} );

	it( 'empties the scene when the build fails after the old model was released', async () => {

		const failure = new Error( 'scene over the memory budget' );
		const app = makeApp( { loadSceneData: vi.fn( async () => {

			throw failure;

		} ) } );
		app._spillPlan = { spill: true };

		await expect( app.loadModel( 'big.glb' ) ).rejects.toBe( failure );
		expect( app.sceneSource ).toBeNull();
		expect( app.assetLoader.releaseTargetModel ).toHaveBeenCalledOnce();
		expect( app.reset ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [] );
		expect( app._loadingInProgress ).toBe( false );
		expect( app._spillPlan ).toBeNull();

	} );

	it( 'still rethrows the failure when clearing the scene fails too', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const failure = new Error( 'parse failed' );
		const app = makeApp();
		app.assetLoader.loadModel = async () => {

			throw failure;

		};

		app.assetLoader.releaseTargetModel = () => {

			throw new Error( 'already gone' );

		};

		await expect( app.loadModel( 'a.glb' ) ).rejects.toBe( failure );
		expect( warn ).toHaveBeenCalledWith( expect.stringContaining( 'could not clear the scene' ), expect.any( Error ) );

	} );

} );

describe( 'loading an environment', () => {

	it( 'installs it, restarts and announces it', async () => {

		const app = makeApp();
		const sky = new Texture();
		app.assetLoader.loadEnvironment = vi.fn( async () => void ( app.meshScene.environment = sky ) );

		await app.loadEnvironment( 'sky.hdr' );

		expect( app.stages.pathTracer.environment.setEnvironmentMap ).toHaveBeenCalledWith( sky );
		expect( app.pipeline.eventBus.emit ).toHaveBeenCalledWith( 'pipeline:lightingChanged' );
		expect( app.reset ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [ { type: EngineEvents.ENVIRONMENT_LOADED, url: 'sky.hdr' } ] );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'frees the load flag when the download fails', async () => {

		const app = makeApp();
		app.assetLoader.loadEnvironment = async () => {

			throw new Error( '404' );

		};

		await expect( app.loadEnvironment( 'sky.hdr' ) ).rejects.toThrow( '404' );
		expect( app.isLoading ).toBe( false );
		expect( app.events ).toEqual( [] );

	} );

} );

describe( 'loadFile', () => {

	it( 'names a URL\'s format by its path, or by the filename given', async () => {

		const app = makeApp();
		app._sceneBudgets = ( options ) => ( { ...options, maxTriangles: 7 } );

		await app.loadFile( 'https://x.test/models/chair.glb?sig=1', { element: 'room' } );
		expect( app.assetLoader.loadAssetFromUrl ).toHaveBeenCalledWith( 'https://x.test/models/chair.glb?sig=1', { element: 'room', maxTriangles: 7, filename: 'chair.glb' } );
		expect( app.sceneSource ).toEqual( { kind: 'url', url: 'https://x.test/models/chair.glb?sig=1', filename: 'chair.glb', cacheKey: null, element: 'room' } );
		expect( app.events ).toEqual( [ { type: EngineEvents.MODEL_LOADED, filename: 'chair.glb' } ] );

		await app.loadFile( 'https://x.test/download/123', { filename: 'scene.gltf', cacheKey: 'k', pbrtEntry: 'main.pbrt' } );
		expect( app.sceneSource ).toEqual( { kind: 'url', url: 'https://x.test/download/123', filename: 'scene.gltf', cacheKey: 'k', pbrtEntry: 'main.pbrt' } );

	} );

	it( 'sends an environment URL to loadEnvironment, with no scene rebuild', async () => {

		const app = makeApp();
		await app.loadFile( 'https://x.test/studio.hdr' );
		expect( app.assetLoader.loadEnvironment ).toHaveBeenCalledWith( 'https://x.test/studio.hdr' );
		expect( app.loadSceneData ).not.toHaveBeenCalled();

	} );

	it( 'rejects a format nothing reads, before loading anything', async () => {

		const app = makeApp();
		await expect( app.loadFile( 'https://x.test/a.obj' ) ).rejects.toThrow( 'unsupported: a.obj' );
		await expect( app.loadFile( new File( [ 'x' ], 'a.fbx' ) ) ).rejects.toThrow( 'unsupported: a.fbx' );
		expect( app._loadingInProgress ).toBe( false );

	} );

	it( 'keeps a local model and its identity for a saved session', async () => {

		const app = makeApp();
		const file = new File( [ 'glTF' ], 'chair.glb', { lastModified: 9 } );

		await app.loadFile( file, { element: 'seat' } );

		expect( app.assetLoader.loadAssetFromFile ).toHaveBeenCalledWith( file, { element: 'seat' } );
		expect( app.sceneSource ).toMatchObject( { kind: 'local-file', file: { name: 'chair.glb', size: 4, lastModified: 9 }, element: 'seat' } );
		expect( app.sceneSource.key ).toEqual( expect.any( String ) );
		expect( app.sceneSourceFile ).toBe( file );
		expect( app.sceneSourceFolder ).toBeNull();

	} );

	it( 'still loads a file it cannot read a sample of, without a key', async () => {

		const app = makeApp();
		const file = { name: 'chair.glb', size: 10, arrayBuffer: async () => {

			throw new Error( 'NotReadableError' );

		} };

		await app.loadFile( file );
		expect( app.sceneSource ).toEqual( { kind: 'local-file', file: { name: 'chair.glb', size: 10, lastModified: 0, sample: null }, key: null } );

	} );

	it( 'installs a dropped environment without rebuilding the scene', async () => {

		const app = makeApp();
		const sky = new Texture();
		app.assetLoader.loadAssetFromFile = vi.fn( async () => void ( app.meshScene.environment = sky ) );
		const file = new File( [ 'x' ], 'studio.hdr' );

		await app.loadFile( file, { element: 'ignored' } );

		expect( app.assetLoader.loadAssetFromFile ).toHaveBeenCalledWith( file );
		expect( app.stages.pathTracer.environment.applyHDRI ).toHaveBeenCalledWith( sky );
		expect( app.loadSceneData ).not.toHaveBeenCalled();
		expect( app.events ).toEqual( [ { type: EngineEvents.ENVIRONMENT_LOADED, filename: 'studio.hdr' } ] );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'refuses a dropped environment mid-load, and frees the flag after a failed one', async () => {

		const app = makeApp( { _loadingInProgress: true } );
		await expect( app.loadFile( new File( [ 'x' ], 'a.png' ) ) ).rejects.toMatchObject( { code: 'LOAD_IN_PROGRESS' } );

		app._loadingInProgress = false;
		app.assetLoader.loadAssetFromFile = async () => {

			throw new Error( 'bad header' );

		};

		await expect( app.loadFile( new File( [ 'x' ], 'a.hdr' ) ) ).rejects.toThrow( 'bad header' );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'cancels only a load in flight', () => {

		const app = makeApp();
		app.cancelLoad();
		expect( app.assetLoader.cancelActiveLoad ).not.toHaveBeenCalled();
		app._loadingInProgress = true;
		app.cancelLoad();
		expect( app.assetLoader.cancelActiveLoad ).toHaveBeenCalledOnce();

	} );

	it( 'lists an archive\'s parts without loading it', async () => {

		const parts = { kind: 'tar', elements: [ 'a', 'b' ] };
		const app = makeApp();
		app.assetLoader.inspectArchive = vi.fn( async () => parts );
		await expect( app.inspectArchive( 'scene.tar' ) ).resolves.toBe( parts );
		expect( app.assetLoader.inspectArchive ).toHaveBeenCalledWith( 'scene.tar' );
		expect( app.isLoading ).toBe( false );

	} );

} );

describe( 'the texture size cap', () => {

	function capped( { applied = ( size ) => Math.min( size, 4096 ), loaded = true } = {} ) {

		const app = makeApp( {
			_sdf: { setMaxTextureSize: vi.fn( applied ), triangles: loaded ? {} : null },
			settings: { values: { maxTextureSize: 2048 }, get( key ) {

				return this.values[ key ];

			}, set: vi.fn( function ( key, value ) {

				this.values[ key ] = value;

			} ) },
		} );
		app.stages.pathTracer.sdfs = { setMaxTextureSize: vi.fn() };
		app.loadSceneData = vi.fn( async () => {

			expect( app.isLoading ).toBe( true );
			return true;

		} );
		return app;

	}

	it( 'stores the clamped size and reprocesses the scene now', async () => {

		const app = capped();
		await app.setMaxTextureSize( 16384 );

		expect( app.settings.set ).toHaveBeenCalledWith( 'maxTextureSize', 4096, { reset: false } );
		expect( app.stages.pathTracer.sdfs.setMaxTextureSize ).toHaveBeenCalledWith( 4096 );
		expect( app.loadSceneData ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [ { type: EngineEvents.TEXTURES_REPROCESSED, maxTextureSize: 4096 } ] );
		expect( app.isLoading ).toBe( false );

	} );

	it.each( [
		[ 'the size did not change', { size: 2048 } ],
		[ 'asked not to', { size: 1024, options: { reprocess: false } } ],
		[ 'nothing is loaded', { size: 1024, loaded: false } ],
		[ 'a load is running', { size: 1024, loading: true } ],
	] )( 'does not reprocess when %s', async ( _, { size, options, loaded = true, loading = false } ) => {

		const app = capped( { loaded } );
		app._loadingInProgress = loading;
		await app.setMaxTextureSize( size, options );
		expect( app.loadSceneData ).not.toHaveBeenCalled();
		expect( app.settings.get( 'maxTextureSize' ) ).toBe( size );

	} );

	it( 'frees the load flag when reprocessing fails', async () => {

		const app = capped();
		app.loadSceneData = async () => {

			throw new Error( 'out of memory' );

		};

		await expect( app.setMaxTextureSize( 1024 ) ).rejects.toThrow( 'out of memory' );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'takes the size as given before a scene processor exists', async () => {

		const app = capped();
		app._sdf = null;
		await app.setMaxTextureSize( 9000 );
		expect( app.settings.get( 'maxTextureSize' ) ).toBe( 9000 );
		expect( app.loadSceneData ).not.toHaveBeenCalled();

	} );

} );

describe( 'the environment a model file authors', () => {

	function authored( environment, extra = {} ) {

		const app = makeApp( extra );
		app.assetLoader.sceneMetadata = { environment };
		return app;

	}

	it.each( [
		[ 'turned off by the host', { sourceFile: 'a.hdr' }, { _applySceneMetadataEnabled: false } ],
		[ 'naming no file', { intensity: 2 }, {} ],
		[ 'without a path tracer', { sourceFile: 'a.hdr' }, { stages: {} } ],
	] )( 'fetches nothing when %s', ( _, environment, extra ) => {

		const app = authored( environment, extra );
		expect( app._beginSceneMetadataEnvironment() ).toBeNull();
		expect( app.assetLoader.loadEnvironment ).not.toHaveBeenCalled();

	} );

	it( 'claims HDRI mode before the fetch, and marks the fetch while it runs', async () => {

		const sky = new Texture();
		const app = authored( { sourceFile: 'studio.hdr' } );
		app.assetLoader.loadEnvironment = vi.fn( async () => {

			expect( app.stages.pathTracer.environment.beginHDRI ).toHaveBeenCalledOnce();
			expect( app._applyingSceneMetadata ).toBe( true );
			return sky;

		} );

		await expect( app._beginSceneMetadataEnvironment() ).resolves.toBe( sky );
		expect( app.assetLoader.loadEnvironment ).toHaveBeenCalledWith( 'studio.hdr' );
		expect( app._applyingSceneMetadata ).toBe( false );

	} );

	it( 'falls back to the current environment when the fetch fails, and says which file', async () => {

		const app = authored( { sourceFile: 'gone.hdr' } );
		app.assetLoader.loadEnvironment = async () => {

			throw new Error( '404' );

		};

		await expect( app._beginSceneMetadataEnvironment() ).resolves.toBeNull();
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.ENVIRONMENT_LOAD_FAILED, detail: { sourceFile: 'gone.hdr', cause: '404' } } ] );
		expect( app._applyingSceneMetadata ).toBe( false );

	} );

	it( 'fails a strict host where the load awaits it', async () => {

		const app = authored( { sourceFile: 'gone.hdr' }, { _issues: new IssueLog( { strict: true } ) } );
		app.assetLoader.loadEnvironment = async () => {

			throw new Error( '404' );

		};

		await expect( app._beginSceneMetadataEnvironment() ).rejects.toBeInstanceOf( EngineIssueError );

	} );

	it( 'shows the image as both light and backdrop, at the authored intensity and rotation', () => {

		const app = authored( { sourceFile: 'a.hdr', intensity: 2.5, rotation: 90 }, { scene: new Scene() } );
		const sky = new Texture();
		app.settings.setMany( { enableEnvironment: false, showBackground: false, transparentBackground: true } );

		app._applySceneMetadataSettings( sky );

		const effective = app.settings.getEffective();
		for ( const [ key, value ] of Object.entries( { enableEnvironment: true, showBackground: true, transparentBackground: false, environmentIntensity: 2.5, backgroundIntensity: 2.5, environmentRotation: 90 } ) ) {

			expect( effective[ key ] ).toMatchObject( { value, source: SETTING_SOURCE.SCENE_METADATA } );

		}

		expect( app.scene.background ).toBe( sky );
		const [ event ] = app.events;
		expect( event ).toMatchObject( { type: EngineEvents.SCENE_METADATA_APPLIED, environment: { sourceFile: 'a.hdr', intensity: 2.5, rotation: 90 } } );
		expect( event.environment ).not.toBe( app.sceneMetadata.environment );

	} );

	it( 'leaves intensity and rotation alone when the file does not author them', () => {

		const app = authored( { sourceFile: 'a.hdr' } );
		app._applySceneMetadataSettings( new Texture() );
		expect( app.settings.getEffective().environmentIntensity.source ).toBe( SETTING_SOURCE.DEFAULT );
		expect( app.settings.getEffective().environmentRotation.source ).toBe( SETTING_SOURCE.DEFAULT );

	} );

	it( 'applies nothing for a file with no environment or one turned off', () => {

		for ( const metadata of [ null, { environment: { enabled: false } } ] ) {

			const app = makeApp();
			app.assetLoader.sceneMetadata = metadata;
			app._applySceneMetadataSettings( new Texture() );
			expect( app.events ).toEqual( [] );
			expect( app.settings.getEffective().enableEnvironment.source ).toBe( SETTING_SOURCE.DEFAULT );

		}

	} );

} );

describe( 'building the scene', () => {

	function building( { mode = 'hdri', upload = true, emitters = 0, sdf = {}, extra = {} } = {} ) {

		const status = [];
		setStatusCallback( ( event ) => status.push( event ) );
		const order = [];
		const step = ( name, result ) => vi.fn( async () => {

			order.push( name );
			return result;

		} );
		const pathTracer = {
			environment: {
				envParams: { mode },
				applyHDRI: step( 'applyHDRI' ),
				buildEnvironmentCDF: step( 'cdf' ),
				applyCDFResults: vi.fn( () => void order.push( 'applyCDF' ) ),
			},
			scene: {},
			uploadTextureArrays: step( 'textures' ),
			_collectMeshRefs: vi.fn( () => [ 'refs' ] ),
			setMeshVisibilityData: vi.fn(),
			setupMaterial: vi.fn( () => void order.push( 'compile' ) ),
			triangleCount: 12,
			bvhNodeCount: 5,
			materialData: { materialCount: 2 },
		};
		const settings = {
			values: { maxTextureSize: 2048, transparentBackground: true },
			get( key ) {

				return this.values[ key ];

			},
			set: vi.fn( function ( key, value ) {

				this.values[ key ] = value;

			} ),
			applyAll: vi.fn(),
		};
		const app = makeApp( {
			settings,
			stages: { pathTracer, compositor: { setTransparentBackground: vi.fn() } },
			_pathTracerEnabled: true,
			_releaseSceneState: vi.fn(),
			_refreshEmissiveForVisibility: vi.fn(),
			_chunkUploader: () => 'uploader',
			_progressiveSpill: () => false,
			_sceneRebuilt: vi.fn( () => void order.push( 'rebuilt' ) ),
			precompileRaster: step( 'raster' ),
			lightManager: 'lights',
			_sdf: {
				setMaxTextureSize: vi.fn(),
				buildBVH: step( 'bvh' ),
				uploadChunks: step( 'chunks' ),
				uploadToPathTracer: vi.fn( () => upload ),
				performanceMetrics: { totalProcessingTime: 40 },
				emissiveTriangleBuilder: { emissiveTriangles: new Array( emitters ) },
				srgbBucketTextures: [ 'srgb' ],
				linearBucketTextures: [ 'linear' ],
				instanceTable: { setCount: 3 },
				...sdf,
			},
			...extra,
		} );
		delete app.loadSceneData;
		app.assetLoader.flushPendingGraph = vi.fn();
		app.meshScene.add( new Mesh( new BoxGeometry( 2, 2, 2 ), new MeshBasicMaterial() ) );
		app.meshScene.children[ 0 ].position.y = 4;
		return { app, order, status, pathTracer, settings };

	}

	it( 'uploads, compiles, sets the ground to the model\'s floor and announces the rebuild', async () => {

		const { app, order, status, pathTracer, settings } = building();
		const model = new Group();
		app.assetLoader.targetModel = model;

		await expect( app.loadSceneData() ).resolves.toBe( true );

		expect( app._sdf.buildBVH ).toHaveBeenCalledWith( app.meshScene, { sceneKey: null, progressive: false } );
		expect( app.assetLoader.flushPendingGraph ).toHaveBeenCalledWith( 40 );
		expect( app._sdf.uploadChunks ).toHaveBeenCalledWith( 'uploader' );
		expect( pathTracer.uploadTextureArrays ).toHaveBeenCalledWith( [ 'srgb', 'linear' ] );
		expect( pathTracer.setMeshVisibilityData ).toHaveBeenCalledWith( [ 'refs' ] );
		expect( order ).toEqual( [ 'bvh', 'chunks', 'textures', 'compile', 'rebuilt' ] );
		expect( model.userData.__rayzeeSceneObject ).toBe( true );
		expect( settings.values.groundProjectionLevel ).toBe( 3 );
		expect( settings.values.groundCatcherHeight ).toBe( 3 );
		expect( settings.applyAll ).toHaveBeenCalledOnce();
		expect( app.stages.compositor.setTransparentBackground ).toHaveBeenCalledWith( true );
		expect( types( app ) ).toEqual( [ EngineEvents.SCENE_REBUILD ] );
		expect( status.at( - 1 ) ).toEqual( { type: EngineEvents.LOADING_RESET } );

	} );

	it( 'stops before compiling when the upload declines', async () => {

		const { app, pathTracer } = building( { upload: false } );
		await expect( app.loadSceneData() ).resolves.toBe( false );
		expect( pathTracer.setupMaterial ).not.toHaveBeenCalled();
		expect( app.events ).toEqual( [] );

	} );

	it( 'installs an authored environment beside the BVH build and waits for its table', async () => {

		const sky = new Texture();
		const { app, order, pathTracer } = building();
		app._applySceneMetadataSettings = vi.fn();

		await app.loadSceneData( { pendingEnvironment: Promise.resolve( sky ) } );

		expect( pathTracer.environment.applyHDRI ).toHaveBeenCalledWith( sky );
		expect( app._applySceneMetadataSettings ).toHaveBeenCalledWith( sky );
		expect( order.indexOf( 'applyCDF' ) ).toBeGreaterThan( order.indexOf( 'applyHDRI' ) );
		expect( order.indexOf( 'applyCDF' ) ).toBeGreaterThan( order.indexOf( 'compile' ) );

	} );

	it( 'still builds when the authored environment fails to install', async () => {

		const { app, pathTracer } = building();
		pathTracer.environment.applyHDRI = async () => {

			throw new Error( 'corrupt HDR' );

		};

		await expect( app.loadSceneData( { pendingEnvironment: Promise.resolve( new Texture() ) } ) ).resolves.toBe( true );
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.ENVIRONMENT_LOAD_FAILED, detail: { cause: 'corrupt HDR' } } ] );

	} );

	it( 'skips an authored environment that resolved to nothing', async () => {

		const { app, pathTracer } = building();
		await app.loadSceneData( { pendingEnvironment: Promise.resolve( null ) } );
		expect( pathTracer.environment.applyHDRI ).not.toHaveBeenCalled();
		expect( pathTracer.environment.applyCDFResults ).toHaveBeenCalledOnce();

	} );

	it( 'builds the table of an HDRI the loader installed, then applies how the file reads it', async () => {

		const { app, pathTracer } = building();
		const sky = Object.assign( new Texture(), { image: { data: new Float32Array( 4 ), width: 1, height: 1 } } );
		app.meshScene.environment = sky;
		app._applySceneMetadataSettings = vi.fn();

		await app.loadSceneData();

		expect( pathTracer.scene.environment ).toBe( sky );
		expect( pathTracer.environment.buildEnvironmentCDF ).toHaveBeenCalledOnce();
		expect( app._applySceneMetadataSettings ).toHaveBeenCalledWith( sky );
		expect( app._sdf.uploadToPathTracer.mock.calls[ 0 ][ 3 ] ).toBe( sky );

		app._applySceneMetadataEnabled = false;
		await app.loadSceneData();
		expect( app._applySceneMetadataSettings ).toHaveBeenCalledOnce();

	} );

	it( 'keeps a sky or colour in use: the model\'s HDRI slot is not uploaded', async () => {

		const { app, pathTracer } = building( { mode: 'procedural' } );
		app.meshScene.environment = Object.assign( new Texture(), { image: { data: new Float32Array( 4 ) } } );

		await app.loadSceneData( { keepUserLights: true } );

		expect( pathTracer.environment.buildEnvironmentCDF ).not.toHaveBeenCalled();
		expect( app._sdf.uploadToPathTracer ).toHaveBeenCalledWith( pathTracer, 'lights', app.meshScene, null, { keepUserLights: true } );

	} );

	it( 'uploads the environment that landed during the BVH build, not the one it replaced', async () => {

		const { app } = building();
		const fresh = new Texture();
		app.meshScene.environment = new Texture();
		app._sdf.buildBVH = vi.fn( async () => void ( app.meshScene.environment = fresh ) );

		await app.loadSceneData( { pendingEnvironment: Promise.resolve( fresh ) } );
		expect( app._sdf.uploadToPathTracer.mock.calls[ 0 ][ 3 ] ).toBe( fresh );

	} );

	it( 'follows the scene\'s emitters unless the user chose, counting hidden ones', async () => {

		const lit = building( { emitters: 2 } );
		await lit.app.loadSceneData();
		expect( lit.settings.values.enableEmissiveTriangleSampling ).toBe( true );

		const dark = building( { emitters: 0, sdf: { emissiveTriangleCount: 9 } } );
		await dark.app.loadSceneData();
		expect( dark.settings.values.enableEmissiveTriangleSampling ).toBe( false );

		const chosen = building( { emitters: 2 } );
		chosen.app._emissiveSamplingUserSet = true;
		await chosen.app.loadSceneData();
		expect( chosen.settings.values.enableEmissiveTriangleSampling ).toBeUndefined();

	} );

	it( 'compiles the raster fallback when path tracing is off, and keeps an appended model\'s selection', async () => {

		const { app, order } = building( { extra: { _pathTracerEnabled: false, _preserveSelectionOnRebuild: true } } );
		await app.loadSceneData();
		expect( order ).toContain( 'raster' );
		expect( app._releaseSceneState ).toHaveBeenCalledWith( { keepSelection: true } );

	} );

} );

describe( 'scene objects', () => {

	function withObjects() {

		const app = makeApp();
		const floor = new Mesh();
		const primary = Object.assign( new Group(), { userData: { __rayzeeSceneObject: true } } );
		app.meshScene.add( floor, primary );
		app.assetLoader.floorPlane = floor;
		app.assetLoader.targetModel = primary;
		app._sceneBoundsChanged = vi.fn();
		app._releaseSceneState = vi.fn();
		return { app, floor, primary };

	}

	it( 'adds a model by URL, tagged for the outliner, without reframing', async () => {

		const { app } = withObjects();
		const root = new Group();
		app.assetLoader.appendModel = vi.fn( async () => ( { root } ) );
		app.loadSceneData = vi.fn( async () => {

			expect( app._preserveSelectionOnRebuild ).toBe( true );
			return true;

		} );

		await expect( app.addModel( 'lamp.glb', { name: 'Lamp', cacheKey: 'lamp-1' } ) ).resolves.toBe( root.uuid );

		expect( app.assetLoader.appendModel ).toHaveBeenCalledWith( 'lamp.glb', { cacheKey: 'lamp-1' } );
		expect( root.userData ).toEqual( { __rayzeeSceneObject: true, __rayzeeSourceUrl: 'lamp.glb', __rayzeeCacheKey: 'lamp-1', __rayzeeName: 'Lamp' } );
		expect( app.loadSceneData ).toHaveBeenCalledWith( { keepUserLights: true } );
		expect( app._sceneBoundsChanged ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [ { type: EngineEvents.MODEL_ADDED, url: 'lamp.glb', id: root.uuid } ] );
		expect( app._preserveSelectionOnRebuild ).toBe( false );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'adds a caller\'s object the same way', async () => {

		const { app } = withObjects();
		const root = new Group();
		app.assetLoader.appendObject3D = vi.fn( () => ( { root } ) );

		await app.addModelFromObject3D( new Object3D() );
		expect( app.assetLoader.appendObject3D.mock.calls[ 0 ][ 1 ] ).toBe( 'object3d' );
		expect( root.userData ).toEqual( { __rayzeeSceneObject: true } );
		expect( app.events ).toEqual( [ { type: EngineEvents.MODEL_ADDED, id: root.uuid } ] );

		await app.addModelFromObject3D( new Object3D(), { name: 'Vase' } );
		expect( root.userData.__rayzeeName ).toBe( 'Vase' );

	} );

	it( 'refuses an add mid-load, and frees the flags after a failed one', async () => {

		const { app } = withObjects();
		app._loadingInProgress = true;
		await expect( app.addModel( 'a.glb' ) ).rejects.toThrow( /already in progress/ );
		await expect( app.addModelFromObject3D( new Object3D() ) ).rejects.toThrow( /already in progress/ );
		expect( app.isLoading ).toBe( true );

		app._loadingInProgress = false;
		app.assetLoader.appendModel = async () => {

			throw new Error( '404' );

		};

		await expect( app.addModel( 'a.glb' ) ).rejects.toThrow( '404' );
		expect( app.isLoading ).toBe( false );
		expect( app._preserveSelectionOnRebuild ).toBe( false );

	} );

	it( 'removes an appended model, or releases the primary one, and rebuilds', async () => {

		const { app, primary } = withObjects();
		const added = Object.assign( new Group(), { userData: { __rayzeeSceneObject: true } } );
		app.meshScene.add( added );

		await expect( app.removeSceneObject( added.uuid ) ).resolves.toBe( true );
		expect( app.assetLoader.removeModelRoot ).toHaveBeenCalledWith( added );
		expect( app._releaseSceneState ).toHaveBeenCalled();

		await expect( app.removeSceneObject( primary.uuid ) ).resolves.toBe( true );
		expect( app.assetLoader.releaseTargetModel ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [
			{ type: EngineEvents.SCENE_OBJECT_REMOVED, id: added.uuid },
			{ type: EngineEvents.SCENE_OBJECT_REMOVED, id: primary.uuid },
		] );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'keeps the ground, ignores what it does not know, and refuses mid-load', async () => {

		const { app, floor, primary } = withObjects();
		await expect( app.removeSceneObject( floor.uuid ) ).resolves.toBe( false );
		await expect( app.removeSceneObject( 'nope' ) ).resolves.toBe( false );
		app._loadingInProgress = true;
		await expect( app.removeSceneObject( primary.uuid ) ).rejects.toThrow( /already in progress/ );
		app.meshScene = null;
		await expect( app.removeSceneObject( primary.uuid ) ).resolves.toBe( false );
		expect( app.loadSceneData ).not.toHaveBeenCalled();

	} );

	it( 'frees the flag when a removal\'s rebuild fails', async () => {

		const { app, primary } = withObjects();
		app.loadSceneData = async () => {

			throw new Error( 'device lost' );

		};

		await expect( app.removeSceneObject( primary.uuid ) ).rejects.toThrow( 'device lost' );
		expect( app.isLoading ).toBe( false );

	} );

	it( 'sets an object\'s visibility through the mesh visibility patch', () => {

		const app = makeApp( { setMeshVisibilityByUuid: vi.fn( () => false ) } );
		expect( app.setSceneObjectVisibility( 'id', false ) ).toBe( false );
		expect( app.setMeshVisibilityByUuid ).toHaveBeenCalledWith( 'id', false );

	} );

} );
