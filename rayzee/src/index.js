/**
 * Rayzee Rendering Engine — Public API
 *
 * Framework-agnostic WebGPU path tracing engine.
 * Subscribe to EngineEvents via addEventListener() to integrate with any UI framework.
 */

// Patches (side-effect imports — must run before any StorageTexture usage)
import './shaders/ThreePatches.js';

// Main application: the viewer, built on the renderer core (also `rayzee/core`)
export { PathTracerApp, describeAdapter } from './viewer/PathTracerApp.js';
export { RayzeeRenderer } from './RayzeeRenderer.js';

// Event types
export { EngineEvents, LEGACY_EVENT_NAMES } from './EngineEvents.js';

// Headless rendering — the supported entry point for a caller with no screen
export { renderHeadless, openHeadless, captureHeadless } from './viewer/Headless.js';

// Degradation contract — what the engine survived instead of failing on
export { ISSUE_CODES, ISSUE_SEVERITY, IssueLog, EngineIssueError } from './EngineIssues.js';

// Settings provenance + viewer-vs-physical tuning
export { SETTING_SOURCE } from './RenderSettings.js';

// Asset URL / cache namespace overrides (call before constructing PathTracerApp)
export { configureAssets, getAssetConfig } from './AssetConfig.js';
export { configurePlatform, getPlatform } from './Platform.js';

// On-disk storage (origin private file system): caches, and areas a host defines for its own data
export { openStorage } from './addons/storage/OpenStorage.js';
export { StorageManager } from './addons/storage/StorageManager.js';
export { acquireLock, heldLockNames } from './addons/storage/Locks.js';
export { STORAGE_KIND, ENGINE_AREAS } from './storage/StorageAreas.js';
export { fileIdentity, folderIdentity, identityKey, sameIdentity } from './storage/FileIdentity.js';
export { DownloadCache, DOWNLOAD_POLICY, fetchFile, nameFromUrl, cachedObjectURL } from './storage/DownloadCache.js';

// Archives read in place: one entry at a time, never the whole file in memory
export { openZip, readZipDirectory } from './addons/archives/ZipReader.js';
export { ARCHIVE_FORMATS, localFolder } from './loaders/ArchiveFormats.js';

// Engine package version, as built
export { VERSION } from './Version.js';

// A loaded scene's edits as plain data (app.exportSceneState / importSceneState)
export { SCENE_STATE_VERSION } from './viewer/SceneState.js';
export { toPortable, fromPortable } from './Portable.js';

// glTF alphaMode derivation — the one definition, shared with hosts that edit materials
export { deriveAlphaMode, MATERIAL_VALUE_SOURCE } from './scene/GeometryExtractor.js';

// Scene-level authoring metadata embedded in model files (glTF `extras`)
export { extractSceneMetadata, parseSceneMetadata } from './loaders/SceneMetadata.js';

// Logging — leveled/namespaced console output shared with the workers
export { Logger, createLogger, fmt, LOG_LEVELS } from './Logger.js';

// Configuration defaults and presets
export {
	ENGINE_DEFAULTS,
	MATERIAL_DEFAULTS,
	PRODUCTION_RENDER_CONFIG,
	INTERACTIVE_RENDER_CONFIG,
} from './EngineDefaults.js';
export { MAX_RESERVABLE_RENDER_SIZE } from './pathtracer/StorageTexturePool.js';
export {
	DENOISER_DEFAULTS, DENOISER_STRATEGIES, NRD_DEFAULTS, NRD_QUALITY_PRESETS, NRD_PRESET_KEYS, NRD_HIT_DIST_A,
	NRD_HIT_DIST_B,
} from './viewer/denoise/DenoiserSettings.js';
export { SKY_DEFAULTS, DEFAULT_SUN_PATH } from './environment/EnvironmentManager.js';
export { AUTO_EXPOSURE_DEFAULTS } from './viewer/picture/AutoExposure.js';
export { LOCAL_EXPOSURE_DEFAULTS } from './viewer/picture/LocalExposure.js';
export { AUTO_FOCUS_DEFAULTS } from './viewer/camera/CameraManager.js';
export { TRIANGLE_DATA_LAYOUT, BVH_LEAF_MARKERS } from './scene/BufferLayout.js';
export { sunPosition, timeForSunElevation, dayOfYearForMonth } from './environment/SunPosition.js';

// Settings & managers (for advanced consumers)
export { RenderSettings } from './RenderSettings.js';
export { CameraManager } from './viewer/camera/CameraManager.js';
export { LightManager } from './lights/LightManager.js';
export { GoboManager } from './viewer/lights/GoboManager.js';
export { IESManager } from './viewer/lights/IESManager.js';
export { DenoisingManager } from './viewer/denoise/DenoisingManager.js';
export { OverlayManager } from './viewer/overlays/OverlayManager.js';

// VRAM accounting
export { VRAMTracker, bufferBytes, textureBytes } from './memory/VRAMTracker.js';
export {
	MemoryLedger, estimateSceneBytes, probeAddressSpace, SAFE_SCENE_BYTES, MAX_SCENE_BYTES,
} from './memory/HostMemory.js';

// Pipeline infrastructure (for advanced consumers building custom stages)
export { RenderPipeline } from './pipeline/RenderPipeline.js';
export { RenderStage, StageExecutionMode } from './pipeline/RenderStage.js';
export { PipelineContext } from './pipeline/PipelineContext.js';
export {
	setBindingAudit,
	getBindingAuditFindings,
	clearBindingAuditFindings,
} from './pipeline/BindingAudit.js';

// Animation (for advanced consumers)
export { AnimationManager } from './viewer/animation/AnimationManager.js';

// Transform controls
export { TransformManager } from './viewer/overlays/TransformManager.js';

// Video rendering
export { VideoRenderManager } from './viewer/animation/VideoRenderManager.js';

// Authored animation: keyframed tracks on one timeline (engine.timeline)
export { TimelineManager } from './viewer/animation/TimelineManager.js';
export { CameraTrack } from './viewer/animation/CameraTrack.js';

// Interaction
export { InteractionManager } from './viewer/camera/InteractionManager.js';

// Neural post passes. The app drives these through `denoisingManager` — what is exported here is
// the offline entry point (`renderUpscaled`, used by the regression bench) plus the two contracts a
// host needs to build UI against.
export { renderUpscaled, SR_SCALE, SR_MAX_INPUT } from './viewer/picture/NeuralSuperRes.js';
export { RETOUCH_DEFAULTS, RETOUCH_RANGES, RETOUCH_MAX_PIXELS } from './viewer/picture/NeuralRetouch.js';

// ── Colour management ───────────────────────────────────────────────────────────────────────────
// `app.color` is the instance a host normally uses; these are for building UI against it, and for
// code that needs the view-transform registry without an app.
export {
	ColorManagement, getActiveColorManagement, setActiveColorManagement,
	isColorManaged, DEFAULT_WORKING_SPACE, findNativeLinearSpace, canvasColorSpaceFor,
} from './addons/color/ColorManagement.js';
export { displayCanvasFit, isHdrDisplay, hdrViewFor, matchingView, sameToneMapping } from './addons/color/Displays.js';
export {
	VIEW_TRANSFORMS, listViewTransforms, getViewTransform, addViewTransform, removeViewTransform,
	onRegistryChange, getRegistryVersion, buildToneMapWGSL,
	OCIO_VIEW_BASE, MAX_TABLE_TRANSFORMS, DEFAULT_VIEW,
} from './color/ViewTransforms.js';
export {
	buildOcioView, addOcioView, addAllOcioViews, buildCanvasView,
	DEFAULT_LUT_SIZE, DEFAULT_MIN_EV, DEFAULT_MAX_EV,
} from './addons/color/OcioViews.js';
export {
	resolveInputSpace, textureInputSpace, setInputOverride, clearInputOverrides,
	listInputOverrides, listFileRules, isDataTexture,
} from './addons/color/InputColorSpaces.js';
export {
	convertColor, convertPixelsF32, convertEncodedRGBA8, applyMatrixRGBA8, extractMatrix,
	hasColorSpace, isDataSpace, srgbToLinear, linearToSrgb,
} from './addons/color/ColorSpaces.js';
export { measureBakeError, bakeLut, makeCpuSampler } from './addons/color/LutBake.js';
