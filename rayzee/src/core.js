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

import './shaders/patches.js';

export { RayzeeRenderer, describeAdapter } from './RayzeeRenderer.js';
export { EngineEvents, LEGACY_EVENT_NAMES } from './EngineEvents.js';
export { ISSUE_CODES, ISSUE_SEVERITY, IssueLog, EngineIssueError } from './EngineIssues.js';
export { RenderSettings, SETTING_SOURCE } from './RenderSettings.js';
export { configureAssets, getAssetConfig } from './AssetConfig.js';
export { configurePlatform, getPlatform } from './Platform.js';
export { LightManager } from './lights/LightManager.js';
export { listViewTransforms, getViewTransform, onRegistryChange, DEFAULT_VIEW } from './color/ViewTransforms.js';
export { ARCHIVE_FORMATS, localFolder } from './loaders/archiveFormats.js';
export { ENGINE_DEFAULTS, MATERIAL_DEFAULTS } from './EngineDefaults.js';
export { SKY_DEFAULTS } from './environment/EnvironmentManager.js';
export { MAX_RESERVABLE_RENDER_SIZE } from './pathtracer/StorageTexturePool.js';
export { TRIANGLE_DATA_LAYOUT } from './scene/BufferLayout.js';
export { Logger, createLogger, fmt, LOG_LEVELS } from './Logger.js';
export { VERSION } from './version.js';
