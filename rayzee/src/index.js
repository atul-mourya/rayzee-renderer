/**
 * Rayzee Rendering Engine — Public API
 *
 * Framework-agnostic WebGPU path tracing engine.
 * Subscribe to EngineEvents via addEventListener() to integrate with any UI framework.
 */

// Patches (side-effect imports — must run before any StorageTexture usage)
import './TSL/patches.js';

// Main application
export { PathTracerApp, describeAdapter } from './PathTracerApp.js';

// Event types
export { EngineEvents } from './EngineEvents.js';

// Headless rendering — the supported entry point for a caller with no screen
export { renderHeadless, openHeadless, captureHeadless } from './Headless.js';

// Degradation contract — what the engine survived instead of failing on
export { ISSUE_CODES, ISSUE_SEVERITY, IssueLog, EngineIssueError } from './EngineIssues.js';

// Settings provenance + viewer-vs-physical tuning
export { SETTING_SOURCE } from './RenderSettings.js';

// Asset URL / cache namespace overrides (call before constructing PathTracerApp)
export { configureAssets, getAssetConfig } from './AssetConfig.js';

// glTF alphaMode derivation — the one definition, shared with hosts that edit materials
export { deriveAlphaMode, MATERIAL_VALUE_SOURCE } from './Processor/GeometryExtractor.js';

// Scene-level authoring metadata embedded in model files (glTF `extras`)
export { extractSceneMetadata, parseSceneMetadata } from './Processor/SceneMetadata.js';

// Logging — leveled/namespaced console output shared with the workers
export { Logger, createLogger, fmt, LOG_LEVELS } from './utils/Logger.js';

// Configuration defaults and presets
export {
	ENGINE_DEFAULTS,
	ASVGF_QUALITY_PRESETS,
	NRD_DEFAULTS,
	NRD_QUALITY_PRESETS,
	NRD_PRESET_KEYS,
	NRD_HIT_DIST_A,
	NRD_HIT_DIST_B,
	CAMERA_PRESETS,
	CAMERA_RANGES,
	SKY_PRESETS,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TRIANGLE_DATA_LAYOUT,
	BVH_LEAF_MARKERS,
	TEXTURE_CONSTANTS,
	DEFAULT_TEXTURE_MATRIX,
	MATERIAL_DEFAULTS,
	MEMORY_CONSTANTS,
	PRODUCTION_RENDER_CONFIG,
	INTERACTIVE_RENDER_CONFIG,
	MAX_RESERVABLE_RENDER_SIZE,
	RENDER_PROFILES,
	getRenderProfile,
} from './EngineDefaults.js';

// Settings & managers (for advanced consumers)
export { RenderSettings } from './RenderSettings.js';
export { CameraManager } from './managers/CameraManager.js';
export { LightManager } from './managers/LightManager.js';
export { GoboManager } from './managers/GoboManager.js';
export { IESManager } from './managers/IESManager.js';
export { DenoisingManager } from './managers/DenoisingManager.js';
export { OverlayManager } from './managers/OverlayManager.js';

// VRAM accounting
export { VRAMTracker, bufferBytes, textureBytes } from './Processor/VRAMTracker.js';
export {
	MemoryLedger, estimateSceneBytes, probeAddressSpace, SAFE_SCENE_BYTES, MAX_SCENE_BYTES,
} from './Processor/HostMemory.js';

// Pipeline infrastructure (for advanced consumers building custom stages)
export { RenderPipeline } from './Pipeline/RenderPipeline.js';
export { RenderStage, StageExecutionMode } from './Pipeline/RenderStage.js';
export { PipelineContext } from './Pipeline/PipelineContext.js';
export {
	setBindingAudit,
	getBindingAuditFindings,
	clearBindingAuditFindings,
} from './Pipeline/BindingAudit.js';

// Animation (for advanced consumers)
export { AnimationManager } from './managers/AnimationManager.js';

// Transform controls
export { TransformManager } from './managers/TransformManager.js';

// Video rendering
export { VideoRenderManager } from './managers/VideoRenderManager.js';

// Interaction
export { InteractionManager } from './managers/InteractionManager.js';

// DLSS neural passes. The app drives these through `denoisingManager` — what is exported here is
// the offline entry point (`renderUpscaled`, used by the regression bench) plus the two contracts a
// host needs to build UI against.
export { renderUpscaled, SR_SCALE, SR_MAX_INPUT } from './dlss/DLSSSuperRes.js';
export { DLSS_NR_DEFAULTS, DLSS_NR_RANGES, DLSS_NR_MAX_PIXELS } from './dlss/DLSSNeural.js';

// ── Colour management ───────────────────────────────────────────────────────────────────────────
// `app.color` is the instance a host normally uses; these are for building UI against it, and for
// code that needs the view-transform registry without an app.
export {
	ColorManagement, getActiveColorManagement, setActiveColorManagement,
	isColorManaged, DEFAULT_WORKING_SPACE, findNativeLinearSpace, canvasColorSpaceFor,
} from './Color/ColorManagement.js';
export { displayCanvasFit } from './Color/Displays.js';
export {
	VIEW_TRANSFORMS, listViewTransforms, getViewTransform, addViewTransform, removeViewTransform,
	onRegistryChange, getRegistryVersion, buildToneMapWGSL,
	OCIO_VIEW_BASE, MAX_TABLE_TRANSFORMS,
} from './Color/ViewTransforms.js';
export {
	buildOcioView, addOcioView, addAllOcioViews,
	DEFAULT_LUT_SIZE, DEFAULT_MIN_EV, DEFAULT_MAX_EV,
} from './Color/OcioViews.js';
export {
	resolveInputSpace, textureInputSpace, setInputOverride, clearInputOverrides,
	listInputOverrides, listFileRules, isDataTexture,
} from './Color/InputColorSpaces.js';
export {
	convertColor, convertPixelsF32, convertEncodedRGBA8, applyMatrixRGBA8, extractMatrix,
	hasColorSpace, isDataSpace, srgbToLinear, linearToSrgb,
} from './Color/ColorSpaces.js';
export { measureBakeError, bakeLut, makeCpuSampler } from './Color/LutBake.js';
