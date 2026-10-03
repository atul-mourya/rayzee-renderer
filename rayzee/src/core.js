/**
 * Rayzee renderer core — `rayzee/core`.
 *
 * A scene and camera in, path-traced samples accumulated, the image out. No denoisers, camera controls,
 * gizmo, overlays or timeline: `rayzee` adds those (PathTracerApp). See docs/CORE_AND_ADDONS.md.
 *
 * @example
 * const renderer = await new RayzeeRenderer( canvas ).init();
 * await renderer.loadObject3D( gltf.scene );
 * await renderer.renderFrames( 256 );
 * const image = await renderer.renderToBuffer( { colorSpace: 'srgb' } );
 * renderer.dispose();
 */

import './TSL/patches.js';

export { RayzeeRenderer, describeAdapter } from './RayzeeRenderer.js';
export { EngineEvents, LEGACY_EVENT_NAMES } from './EngineEvents.js';
export { ISSUE_CODES, ISSUE_SEVERITY, IssueLog, EngineIssueError } from './EngineIssues.js';
export { RenderSettings, SETTING_SOURCE } from './RenderSettings.js';
export { configureAssets, getAssetConfig } from './AssetConfig.js';
export { configurePlatform, getPlatform } from './Platform.js';
export { LightManager } from './managers/LightManager.js';
export { listViewTransforms, getViewTransform, onRegistryChange } from './Color/ViewTransforms.js';
export {
	ENGINE_DEFAULTS,
	MATERIAL_DEFAULTS,
	RENDER_PROFILES,
	getRenderProfile,
	MAX_RESERVABLE_RENDER_SIZE,
	TRIANGLE_DATA_LAYOUT,
} from './EngineDefaults.js';
export { Logger, createLogger, fmt, LOG_LEVELS } from './utils/Logger.js';
export { VERSION } from './version.js';
