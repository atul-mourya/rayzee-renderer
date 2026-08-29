/**
 * Rayzee Rendering Engine — Public API
 *
 * Framework-agnostic WebGPU path tracing engine.
 * Subscribe to EngineEvents via addEventListener() to integrate with any UI framework.
 */

// Patches (side-effect imports — must run before any StorageTexture usage)
import './TSL/patches.js';

// Main application
export { PathTracerApp } from './PathTracerApp.js';

// Event types
export { EngineEvents } from './EngineEvents.js';

// Asset URL / cache namespace overrides (call before constructing PathTracerApp)
export { configureAssets, getAssetConfig } from './AssetConfig.js';

// glTF alphaMode derivation — the one definition, shared with hosts that edit materials
export { deriveAlphaMode } from './Processor/GeometryExtractor.js';

// Scene-level authoring metadata embedded in model files (glTF `extras`)
export { extractSceneMetadata, parseSceneMetadata } from './Processor/SceneMetadata.js';

// Logging — leveled/namespaced console output shared with the workers
export { Logger, createLogger, fmt, LOG_LEVELS } from './utils/Logger.js';

// Configuration defaults and presets
export {
	ENGINE_DEFAULTS,
	ASVGF_QUALITY_PRESETS,
	CAMERA_PRESETS,
	CAMERA_RANGES,
	SKY_PRESETS,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TRIANGLE_DATA_LAYOUT,
	BVH_LEAF_MARKERS,
	TEXTURE_CONSTANTS,
	DEFAULT_TEXTURE_MATRIX,
	MEMORY_CONSTANTS,
	PRODUCTION_RENDER_CONFIG,
	INTERACTIVE_RENDER_CONFIG,
	MAX_RESERVABLE_RENDER_SIZE,
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
