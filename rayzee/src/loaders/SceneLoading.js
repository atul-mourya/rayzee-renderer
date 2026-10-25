import { EngineEvents } from '../EngineEvents.js';
import { nameFromUrl } from '../storage/DownloadCache.js';
import { isFolderInput, localFolder } from './archives/archiveFormats.js';
import { folderIdentity, identityKey, fileIdentity } from '../storage/identity.js';
import { SPILL_ENVIRONMENT_WIDTH, SPILL_TRIANGLE_BUDGET, SPILL_PLACEMENT_BUDGET } from '../memory/HostMemory.js';
import { resetLoading, updateLoading } from '../utils.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { SETTING_SOURCE } from '../RenderSettings.js';
import { BuildTimer } from '../scene/BuildTimer.js';
import { createLogger, fmt } from '../Logger.js';
import { limitEnvironmentWidth } from './AssetLoader.js';

const log = createLogger( 'engine' );

// The part of an archive a load chose, for sceneSource.
const partOf = ( { element, pbrtEntry } = {} ) => ( {
	...( element !== undefined ? { element } : {} ),
	...( pbrtEntry !== undefined ? { pbrtEntry } : {} ),
} );

// Quiet time after an edit before memory spill puts back on disk what the edit read back.
const RESPILL_AFTER_MS = 30_000;

export async function loadModel( app, url, options = {} ) {

	await app._loadWithSceneRebuild(
		() => app.assetLoader.loadModel( url, options ),
		{ type: EngineEvents.MODEL_LOADED, url },
		{ kind: 'url', url, cacheKey: options.cacheKey ?? null }
	);

}

export async function loadObject3D( app, object3d, name = 'object3d' ) {

	await app._loadWithSceneRebuild(
		() => app.assetLoader.loadObject3D( object3d, name ),
		{ type: EngineEvents.OBJECT3D_LOADED, name },
		{ kind: 'object3d', name }
	);

}

/**
 * A load is already running. Typed so hosts can tell "you clicked too fast" apart from
 * a genuine load failure and say so, instead of dropping the request on the floor.
 * @private
 */
function busyError( app, where ) {

	const error = new Error( `${where}: another load is already in progress` );
	error.code = 'LOAD_IN_PROGRESS';
	return error;

}

export async function loadEnvironment( app, url ) {

	if ( app._loadingInProgress ) throw busyError( app, 'PathTracerApp.loadEnvironment' );

	app._loadingInProgress = true;

	try {

		await app.assetLoader.loadEnvironment( url );

		const environmentTexture = app.meshScene.environment;
		if ( environmentTexture && app.stages.pathTracer ) {

			await app.stages.pathTracer.environment.setEnvironmentMap( environmentTexture );

		}

		app.pipeline?.eventBus.emit( 'pipeline:lightingChanged' );
		app.reset();
		app.dispatchEvent( { type: EngineEvents.ENVIRONMENT_LOADED, url } );

	} finally {

		app._loadingInProgress = false;

	}

}

export async function inspectArchive( app, file ) {

	return await app.assetLoader.inspectArchive( file );

}

export async function loadFile( app, file, options = {} ) {

	options = app._sceneBudgets( options );

	if ( typeof file === 'string' ) {

		const filename = options.filename ?? nameFromUrl( file );
		const format = app.assetLoader?.getFileFormat( filename );
		if ( ! format ) throw app.assetLoader.formatError( filename );
		if ( format.type === 'environment' || format.type === 'image' ) return app.loadEnvironment( file );

		await app._loadWithSceneRebuild(
			() => app.assetLoader.loadAssetFromUrl( file, { ...options, filename } ),
			{ type: EngineEvents.MODEL_LOADED, filename },
			{ kind: 'url', url: file, filename, cacheKey: options.cacheKey ?? null, ...partOf( options ) }
		);
		return;

	}

	if ( isFolderInput( file ) ) {

		const folder = localFolder( file, { isModel: path => app.assetLoader?.getFileFormat( path )?.type === 'model' } );
		if ( folder.files.length === 0 ) throw new Error( `${folder.name} holds no files to load` );
		await app._loadWithSceneRebuild(
			() => app.assetLoader.loadFolder( folder, options ),
			{ type: EngineEvents.MODEL_LOADED, filename: folder.name },
			async () => {

				const id = await folderIdentity( folder );
				return { kind: 'local-folder', folder: id, key: identityKey( id ), ...( folder.flat ? { flat: true } : {} ), ...partOf( options ) };

			}
		);
		app._sceneSourceInput = folder;
		return;

	}

	const format = app.assetLoader?.getFileFormat( file?.name || '' );
	if ( ! format ) throw app.assetLoader.formatError( file?.name || '' );

	if ( format.type !== 'environment' && format.type !== 'image' ) {

		const identity = fileIdentity( file ).catch( () => ( { name: file.name, size: file.size, lastModified: file.lastModified ?? 0, sample: null } ) );
		await app._loadWithSceneRebuild(
			() => app.assetLoader.loadAssetFromFile( file, options ),
			{ type: EngineEvents.MODEL_LOADED, filename: file.name },
			async () => {

				const id = await identity;
				return { kind: 'local-file', file: id, key: id.sample ? identityKey( id ) : null, ...partOf( options ) };

			}
		);
		app._sceneSourceInput = file;
		return;

	}

	// Environment drop: install it, no scene rebuild.
	if ( app._loadingInProgress ) throw busyError( app, 'PathTracerApp.loadFile' );

	app._loadingInProgress = true;

	try {

		await app.assetLoader.loadAssetFromFile( file );

		const texture = app.meshScene.environment;
		if ( texture && app.stages.pathTracer ) {

			await app.stages.pathTracer.environment.applyHDRI( texture );

		}

		app.pipeline?.eventBus.emit( 'pipeline:lightingChanged' );
		app.reset();
		app.dispatchEvent( { type: EngineEvents.ENVIRONMENT_LOADED, filename: file.name } );

	} finally {

		app._loadingInProgress = false;

	}

}

export async function loadExampleModels( app, index, modelFiles ) {

	await app._loadWithSceneRebuild(
		() => app.assetLoader.loadExampleModels( index, modelFiles ),
		{ type: EngineEvents.MODEL_LOADED, index },
		{ kind: 'url', url: modelFiles[ index ]?.url ?? null, cacheKey: null }
	);

}

export function cancelLoad( app ) {

	if ( ! app._loadingInProgress ) return;
	app.assetLoader?.cancelActiveLoad();

}

export async function setMaxTextureSize( app, size, { reprocess = true } = {} ) {

	const prev = app.settings.get( 'maxTextureSize' );
	const applied = app._sdf?.setMaxTextureSize( size ) ?? size;
	app.settings.set( 'maxTextureSize', applied, { reset: false } );
	if ( typeof app.stages?.pathTracer?.sdfs?.setMaxTextureSize === 'function' ) {

		app.stages.pathTracer.sdfs.setMaxTextureSize( applied );

	}

	// Reprocess the loaded scene so the new cap takes effect immediately.
	if ( reprocess && applied !== prev && app._sdf?.triangles && ! app._loadingInProgress ) {

		app._loadingInProgress = true;
		try {

			await app.loadSceneData();
			app.reset();
			app.dispatchEvent( { type: EngineEvents.TEXTURES_REPROCESSED, maxTextureSize: applied } );

		} finally {

			app._loadingInProgress = false;

		}

	}

}

/** Shared pipeline: load asset → sync controls → build BVH → reset → dispatch events */
export async function loadWithSceneRebuild( app, loadFn, eventPayload, source = null ) {

	if ( app._loadingInProgress ) throw busyError( app, 'PathTracerApp' );

	app._loadingInProgress = true;
	// The previous scene's sky width must not narrow this one's while it loads.
	if ( app.assetLoader ) app.assetLoader.maxEnvironmentWidth = app._memorySpill === true ? SPILL_ENVIRONMENT_WIDTH : 0;

	try {

		await loadFn();
		app._sceneSource = typeof source === 'function' ? await source() : source;
		app._sceneSourceInput = null;
		// A fresh model re-establishes the emissive-sampling auto-default (incremental
		// rebuilds — add/remove object, texture reprocess — preserve the user's choice).
		app._emissiveSamplingUserSet = false;
		// Replace-load clears any dynamically-appended models — but only AFTER
		// loadFn() succeeds, so a failed load leaves the current scene intact.
		// (The old primary was already released by releaseTargetModel() in loadFn.)
		app._clearAppendedModels();
		app._modelReplaced();
		// Before the scene's own environment starts loading: a spilling scene's is narrowed as it decodes.
		app._planSpill();
		const built = await app.loadSceneData( { pendingEnvironment: app._beginSceneMetadataEnvironment() } );
		app._maybeSpill();
		app.pipeline?.eventBus.emit( 'pipeline:lightingChanged' );
		// Not held: the first denoise of a new scene lands ~1.1 s after the load (upload and
		// shader compilation come first), and a second of the previous model reads as a bug.
		app._dropDisplay();
		app.reset();
		app.dispatchEvent( eventPayload );
		app._modelAnnounced();
		if ( built ) app.assetLoader?.commitPendingGraph( app.sceneModel );

	} catch ( error ) {

		// loadFn released the previous model before this one was known to be loadable, so
		// there is nothing to fall back to. Leaving it half-built would keep the last
		// frame's buffers on screen under a scene that no longer exists.
		if ( ! error || error.code !== 'LOAD_IN_PROGRESS' ) app._discardFailedLoad();

		// Only the scene build reported its own failure; one in the parse left a host's loading
		// status spinning on its last step. A part prompt is not a failure, so it just ends it.
		if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' ) resetLoading();
		else if ( error?.code !== 'LOAD_IN_PROGRESS' ) updateLoading( { status: `Error: ${error?.message ?? error}`, failed: true, progress: 100 } );
		throw error;

	} finally {

		app._loadingInProgress = false;
		app._spillPlan = null;

	}

}

/**
 * Put the engine back to an empty scene after a load failed part-way. The failure itself is
 * rethrown for the host to report; this only makes sure what is on screen matches it.
 * @private
 */
export function discardFailedLoad( app ) {

	app._sceneSource = app._sceneSourceInput = null;

	try {

		app._clearAppendedModels();
		app.assetLoader?.releaseTargetModel();
		app._dropDisplay();
		app.reset();

	} catch ( cleanupError ) {

		console.warn( 'PathTracerApp: could not clear the scene after a failed load', cleanupError );

	}

}

/**
 * Starts fetching the environment authored into the just-loaded model's metadata and
 * returns a promise for the texture — deliberately NOT awaited here. The fetch is the
 * longest single step of such a load (measured 1448 ms for a 1k HDRI against 325 ms to
 * build and upload a 112k-triangle scene), so the promise is handed to loadSceneData(),
 * which installs it and builds its CDF while the BVH builds.
 *
 * Called from both replace-load seams: the URL/catalog path (_loadWithSceneRebuild) and
 * the drag-drop / File-open path, which drives the AssetLoader directly and rebuilds via
 * the 'load' event (_onAssetLoaded). Appending a model never applies it — an appended
 * model must not hijack the scene's environment.
 *
 * Resolves to null rather than rejecting: a failed fetch leaves the model on the current
 * environment. Returns null outright when there is nothing to apply. Under `strict` the
 * recorded issue throws instead, and the rejection surfaces where loadSceneData awaits it.
 * Opt out per app with `new PathTracerApp( canvas, { applySceneMetadata: false } )`.
 *
 * @returns {Promise<import('three').Texture|null>|null}
 */
export function beginSceneMetadataEnvironment( app ) {

	restoreUnlitSettings( app );
	const env = app.sceneMetadata?.environment;
	if ( app._applySceneMetadataEnabled && env?.enabled === false ) {

		applyUnlitSettings( app );
		return null;

	}

	if ( ! app._applySceneMetadataEnabled || ! env?.sourceFile || ! app.stages.pathTracer ) return null;

	// Claim 'hdri' mode up front: loadEnvironment() fires beforeEnvironmentLoad, and a
	// host that answers it with setMode( 'hdri' ) would otherwise restore the HDRI
	// stashed by the current sky mode on top of the download now in flight.
	app.stages.pathTracer.environment.beginHDRI();
	app._applyingSceneMetadata = true;

	return app.assetLoader.loadEnvironment( env.sourceFile )
		.catch( error => {

			app._issues.record(
				ISSUE_CODES.ENVIRONMENT_LOAD_FAILED,
				`authored environment "${env.sourceFile}" failed to load — lighting falls back to the previous environment`,
				{ sourceFile: env.sourceFile, cause: String( error?.message ?? error ) }
			);
			return null;

		} )
		.finally( () => {

			app._applyingSceneMetadata = false;

		} );

}

/**
 * Mirrors the authored environment onto the settings once its texture is installed.
 * The authored env is both the light and the backdrop, so the backdrop axis
 * (showBackground / transparentBackground) is forced to the image.
 * @private
 */
export function applySceneMetadataSettings( app, texture ) {

	const metadata = app.sceneMetadata;
	const env = metadata?.environment;
	if ( ! env || env.enabled === false ) return;

	const updates = { enableEnvironment: true, showBackground: true, transparentBackground: false };
	if ( env.intensity !== undefined ) {

		updates.environmentIntensity = env.intensity;
		updates.backgroundIntensity = env.intensity;

	}

	if ( env.rotation !== undefined ) updates.environmentRotation = env.rotation;

	app.settings.setMany( updates, { reset: false, source: SETTING_SOURCE.SCENE_METADATA } );
	if ( app.scene ) app.scene.background = texture;

	app.dispatchEvent( { type: EngineEvents.SCENE_METADATA_APPLIED, metadata, environment: { ...env } } );

}

/**
 * A scene that has no environment (a pbrt scene without an infinite light) renders with none: no light
 * from it and a plain backdrop. The next model gets back what it replaced, unless someone changed it since.
 * @private
 */
function applyUnlitSettings( app ) {

	const effective = app.settings.getEffective();
	const updates = { enableEnvironment: false, showBackground: false };
	app._unlitRestore = Object.fromEntries( Object.keys( updates ).map( key => [ key, { value: effective[ key ].value, source: effective[ key ].source } ] ) );
	app.settings.setMany( updates, { reset: false, source: SETTING_SOURCE.SCENE_METADATA } );
	app.dispatchEvent( { type: EngineEvents.SCENE_METADATA_APPLIED, metadata: app.sceneMetadata, environment: { enabled: false } } );

}

/** @private */
function restoreUnlitSettings( app ) {

	const saved = app._unlitRestore;
	if ( ! saved ) return;
	app._unlitRestore = null;
	const effective = app.settings.getEffective();
	for ( const [ key, { value, source } ] of Object.entries( saved ) ) {

		if ( effective[ key ]?.source === SETTING_SOURCE.SCENE_METADATA ) app.settings.set( key, value, { reset: false, source } );

	}

	app.dispatchEvent( { type: EngineEvents.SCENE_METADATA_APPLIED, metadata: app.sceneMetadata, environment: { enabled: app.settings.get( 'enableEnvironment' ) } } );

}

export async function loadSceneData( app, { pendingEnvironment = null, keepUserLights = false } = {} ) {

	// The append path (addModel) keeps its selection: the selected object persists.
	app._releaseSceneState( { keepSelection: !! app._preserveSelectionOnRebuild } );

	// Tag the primary (replace-loaded) model so it appears in the scene-object list.
	tagPrimarySceneObject( app );

	const timer = new BuildTimer( '', { namespace: 'scene', level: 'info' } );
	// meshScene.environment is the HDRI slot: a sky or colour in use outlives the model.
	const hdri = () => app.stages.pathTracer.environment.envParams.mode === 'hdri' ? app.meshScene.environment : null;
	const environmentTexture = hdri();

	// Environment CDF build in parallel with BVH
	let cdfPromise = null;
	if ( pendingEnvironment ) {

		// The authored environment is still downloading. Install + CDF it off to the side so
		// the fetch overlaps the BVH build below instead of gating it.
		timer.start( 'Environment fetch + CDF (concurrent)' );
		cdfPromise = pendingEnvironment
			.then( async texture => {

				if ( ! texture ) return;
				await app.stages.pathTracer.environment.applyHDRI( texture );
				app._applySceneMetadataSettings( texture );

			} )
			.catch( error => app._issues.record(
				ISSUE_CODES.ENVIRONMENT_LOAD_FAILED,
				'authored environment failed to install — the scene is lit by whatever was already loaded',
				{ cause: String( error?.message ?? error ) }
			) )
			.finally( () => timer.end( 'Environment fetch + CDF (concurrent)' ) );

	} else if ( environmentTexture?.image?.data ) {

		timer.start( 'Environment CDF build (worker)' );
		app.stages.pathTracer.scene.environment = environmentTexture;
		cdfPromise = app.stages.pathTracer.environment.buildEnvironmentCDF()
			.then( () => {

				timer.end( 'Environment CDF build (worker)' );
				// A loader can install the environment itself and still author how it should
				// be read — a pbrt scene bakes the light's transform in and needs rotation 0.
				if ( app._applySceneMetadataEnabled ) app._applySceneMetadataSettings( environmentTexture );

			} );

	}

	// Build BVH
	timer.start( 'BVH build (SceneProcessor)' );
	app._sdf.setMaxTextureSize( app.settings.get( 'maxTextureSize' ) );
	await app._sdf.buildBVH( app.meshScene, { sceneKey: app.assetLoader?.sceneSourceKey ?? null, progressive: app._progressiveSpill() } );
	app.assetLoader?.flushPendingGraph( app._sdf.performanceMetrics.totalProcessingTime );
	timer.end( 'BVH build (SceneProcessor)' );

	// Transfer geometry, materials, and textures to GPU
	updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
	await new Promise( r => setTimeout( r, 0 ) );
	timer.start( 'GPU data transfer' );
	await app._sdf.uploadChunks( app._chunkUploader() );

	// Re-read rather than reusing the snapshot above: a pendingEnvironment may have landed
	// during the BVH build, and the snapshot is then a disposed texture.
	if ( ! app._sdf.uploadToPathTracer( app.stages.pathTracer, app.lightManager, app.meshScene, hdri(), { keepUserLights } ) ) return false;

	// Not left to the first frame, where three.js sends every layer at once.
	await app.stages.pathTracer.uploadTextureArrays( [ ...( app._sdf.srgbBucketTextures ?? [] ), ...( app._sdf.linearBucketTextures ?? [] ) ] );

	// Patch per-mesh visibility into the TLAS leaves we just uploaded
	app.stages.pathTracer._meshRefs = app.stages.pathTracer._collectMeshRefs( app.meshScene );
	app.stages.pathTracer.setMeshVisibilityData( app.stages.pathTracer._meshRefs );

	// Drop authored-hidden meshes' triangles from the emissive-NEE structure
	// (runs before setupMaterial so the kernels compile against the final buffer)
	app._refreshEmissiveForVisibility();

	timer.end( 'GPU data transfer' );

	// Compile shaders
	updateLoading( { status: "Compiling shaders...", progress: 90 } );
	await new Promise( r => setTimeout( r, 0 ) );
	timer.start( 'Material setup (TSL compile)' );
	app.stages.pathTracer.setupMaterial();
	timer.end( 'Material setup (TSL compile)' );

	app._rasterPrecompile = null;

	if ( ! app._pathTracerEnabled ) {

		timer.start( 'Pipeline precompile' );
		await app.precompileRaster();
		timer.end( 'Pipeline precompile' );

	}

	// Wait for CDF
	if ( cdfPromise ) {

		updateLoading( { status: "Finalizing environment map...", progress: 95 } );
		await cdfPromise;
		app.stages.pathTracer.environment.applyCDFResults();

	}

	// Seed the ground-projection plane AND the shadow-catcher plane to the scene floor so models
	// that aren't authored at y=0 sit on the ground (not sunk) — auto-updates on every model change.
	const sceneMinY = app.getSceneMinY();
	app.settings.set( 'groundProjectionLevel', sceneMinY, { reset: false } );
	app.settings.set( 'groundCatcherHeight', sceneMinY, { reset: false } );

	// Auto-follow the scene: enable emissive-triangle NEE when the scene has emissive
	// geometry, disable it when it doesn't — unless the user set the toggle explicitly.
	// Runs before applyAll()/SceneRebuild so the uniform and UI both pick up the new value.
	if ( ! app._emissiveSamplingUserSet ) {

		// Keyed on the canonical (unfiltered) emissive set — emissiveTriangleCount
		// reflects only the visible subset, and hidden emitters can be shown later.
		const hasEmissive = ( app._sdf?.emissiveTriangleBuilder?.emissiveTriangles?.length
			?? app._sdf?.emissiveTriangleCount ?? 0 ) > 0;
		app.settings.set( 'enableEmissiveTriangleSampling', hasEmissive, { reset: false } );

	}

	// Apply all settings to stages in one shot
	timer.start( 'Apply settings' );
	app.settings.applyAll();
	app.stages.compositor.setTransparentBackground( app.settings.get( 'transparentBackground' ) );
	timer.end( 'Apply settings' );

	timer.print( sceneSummaryParts( app ) );
	resetLoading();

	app._sceneRebuilt();

	app.dispatchEvent( { type: EngineEvents.SCENE_REBUILD } );
	return true;

}

/** Counts for the single `[scene]` summary line emitted after a scene build. */
function sceneSummaryParts( app ) {

	const pt = app.stages.pathTracer;
	const meshes = app._sdf?.instanceTable?.setCount ?? 0;
	const maps = app._sdf?.geometryExtractor?.maps?.length ?? 0;

	return [
		fmt.count( pt.triangleCount, 'tri' ),
		meshes ? fmt.count( meshes, 'mesh', 'meshes' ) : null,
		fmt.count( pt.materialData.materialCount, 'material' ),
		maps ? fmt.count( maps, 'map' ) : null,
		fmt.count( pt.bvhNodeCount, 'BVH node' ),
	];

}

// ═══════════════════════════════════════════════════════════════
// Dynamic scene objects (add / remove / list / visibility)
//
// Top-level objects are the auto-created "Ground" plane plus each loaded
// model root parented into meshScene. The scene graph + per-root userData
// tags are the single source of truth (no separate registry): ids are
// Object3D uuids (stable across rebuilds, since the same root persists).
// ═══════════════════════════════════════════════════════════════

/** Tag the primary (replace-loaded) model as a removable scene object (read by the Outliner + removeSceneObject). Idempotent. */
function tagPrimarySceneObject( app ) {

	const m = app.sceneModel;
	if ( ! m ) return;
	m.userData.__rayzeeSceneObject = true;

}

/** Remove + dispose all dynamically-appended models (keeps Ground and the primary). */
export function clearAppendedModels( app ) {

	const scene = app.meshScene;
	if ( ! scene ) return;
	const floor = app.assetLoader?.floorPlane;
	const primary = app.sceneModel;
	for ( const child of [ ...scene.children ] ) {

		if ( child === floor || child === primary ) continue;
		if ( ! child.userData?.__rayzeeSceneObject ) continue;
		app.assetLoader.removeModelRoot( child );

	}

}

/** Reframe-free rebuild sequence. Assumes the _loadingInProgress guard is already held. */
async function finishRebuildNoReframe( app, eventPayload ) {

	await app.loadSceneData( { keepUserLights: true } ); // emits 'SceneRebuild'
	app._maybeSpill();
	app._sceneBoundsChanged();
	app.pipeline?.eventBus.emit( 'pipeline:lightingChanged' );
	app.reset();
	if ( eventPayload ) app.dispatchEvent( eventPayload );

}

export async function addModel( app, url, { name, cacheKey } = {} ) {

	if ( app._loadingInProgress ) {

		throw new Error( 'PathTracerApp.addModel: another load is already in progress' );

	}

	app._loadingInProgress = true;
	app._preserveSelectionOnRebuild = true;
	try {

		const { root } = await app.assetLoader.appendModel( url, { cacheKey } );
		root.userData.__rayzeeSceneObject = true;
		root.userData.__rayzeeSourceUrl = url;
		if ( cacheKey ) root.userData.__rayzeeCacheKey = cacheKey;
		if ( name ) root.userData.__rayzeeName = name;
		await finishRebuildNoReframe( app, { type: EngineEvents.MODEL_ADDED, url, id: root.uuid } );
		return root.uuid;

	} finally {

		app._preserveSelectionOnRebuild = false;
		app._loadingInProgress = false;

	}

}

export async function addModelFromObject3D( app, object3d, { name } = {} ) {

	if ( app._loadingInProgress ) {

		throw new Error( 'PathTracerApp.addModelFromObject3D: another load is already in progress' );

	}

	app._loadingInProgress = true;
	app._preserveSelectionOnRebuild = true;
	try {

		const { root } = app.assetLoader.appendObject3D( object3d, name || 'object3d' );
		root.userData.__rayzeeSceneObject = true;
		if ( name ) root.userData.__rayzeeName = name;
		await finishRebuildNoReframe( app, { type: EngineEvents.MODEL_ADDED, id: root.uuid } );
		return root.uuid;

	} finally {

		app._preserveSelectionOnRebuild = false;
		app._loadingInProgress = false;

	}

}

export async function removeSceneObject( app, id ) {

	const scene = app.meshScene;
	if ( ! scene ) return false;

	const floor = app.assetLoader?.floorPlane;
	if ( floor && floor.uuid === id ) return false; // Ground is not deletable

	const root = app.getSceneObject( id );
	if ( ! root ) return false;

	if ( app._loadingInProgress ) {

		throw new Error( 'PathTracerApp.removeSceneObject: another load is already in progress' );

	}

	app._loadingInProgress = true;
	try {

		app._releaseSceneState();

		if ( root === app.sceneModel ) {

			app.assetLoader.releaseTargetModel();

		} else {

			app.assetLoader.removeModelRoot( root );

		}

		// Ground is permanent (removal refused above), so the scene always keeps
		// renderable geometry — a full rebuild is always valid here.
		await finishRebuildNoReframe( app, { type: EngineEvents.SCENE_OBJECT_REMOVED, id } );

		return true;

	} finally {

		app._loadingInProgress = false;

	}

}

export function setSceneObjectVisibility( app, id, visible ) {

	return app.setMeshVisibilityByUuid( id, visible );

}

export function setMemorySpill( app, mode ) {

	app._memorySpill = mode === true || mode === false ? mode : 'auto';

}

/**
 * Triangle and placement budgets for a scene archive: raised whenever a build could spill, since the preflight
 * refuses what cannot fit either way. @private
 */
export function sceneBudgets( app, options ) {

	if ( app._memorySpill === false || ! app.storage ) return options;
	return { maxTriangles: SPILL_TRIANGLE_BUDGET, maxPlacements: SPILL_PLACEMENT_BUDGET, ...options };

}

/**
 * Decides whether the scene about to be built spills: static scenes only, since a deforming clip refits every
 * frame. Held for the build that follows ({@link _progressiveSpill}). @private
 */
export function planSpill( app ) {

	const offered = app._memorySpill !== false && !! app.storage && ( app.assetLoader?.animations?.length ?? 0 ) === 0;
	const spill = offered && ( app._memorySpill === true || app._sdf.needsSpill( app.meshScene ) );
	if ( app.assetLoader ) app.assetLoader.maxEnvironmentWidth = spill ? SPILL_ENVIRONMENT_WIDTH : 0;
	// An importer installs its own sky at the end of its read, before this.
	const sky = spill ? app.meshScene?.environment : null;
	const image = sky?.image;
	if ( image ) limitEnvironmentWidth( sky, SPILL_ENVIRONMENT_WIDTH );
	if ( sky && sky.image !== image ) {

		// three.js keeps an uploaded texture's size, so the old one goes.
		sky.dispose();
		sky.needsUpdate = true;

	}

	if ( spill && app._memorySpill === 'auto' ) log.info( 'scene is past the in-memory line: building it through disk' );
	app._spillPlan = spill;
	return spill;

}

/** @private */
export function progressiveSpill( app ) {

	const spill = app._spillPlan ?? app._planSpill();
	app._spillPlan = null;
	return spill ? { storage: app.storage, uploader: app._chunkUploader() } : null;

}

/** @private */
export function chunkUploader( app ) {

	const stage = app.stages.pathTracer;
	return ( records, kind, options ) => kind === 'triangles' ? stage.createTriangleChunkUploader( records, options ) : stage.createChunkUploader( records );

}

/** The rest of a spilling scene's spill, once it is on the GPU, in the background. @private */
export function maybeSpill( app ) {

	if ( ! app._sdf?.spilling || ! app.storage ) return;
	app._sdf.spillAfterLoad().catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );
	app._sdf.spillToDisk( app.storage )
		.then( result => result && app.dispatchEvent( { type: EngineEvents.SCENE_SPILLED, ...result } ) )
		.catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );

}

/** Once edits have been quiet for {@link RESPILL_AFTER_MS}, puts back on disk what they read back. @private */
export function scheduleRespill( app ) {

	if ( ! app._sdf?.spilling ) return;
	clearTimeout( app._respillTimer );
	app._respillTimer = setTimeout( () => {

		app._respillTimer = null;
		app._sdf?.respill().catch( error => app._issues.warn( ISSUE_CODES.STORAGE_WRITE_FAILED, `memory spill failed: ${error.message}` ) );

	}, RESPILL_AFTER_MS );
	app._respillTimer.unref?.();

}

export async function ensureSceneResident( app ) {

	if ( app._sdf?.spilled ) await app._sdf.ensureResident();
	await app._sdf?.ensureGeometryResident();

}
