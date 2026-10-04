/**
 * Engine event type constants.
 * The rendering engine dispatches these events via THREE.EventDispatcher.
 * UI adapters subscribe to these events to bridge engine state to their framework.
 */
export const EngineEvents = {
	// Render lifecycle
	RENDER_COMPLETE: 'engine:renderComplete',
	RENDER_RESET: 'engine:renderReset',
	FRAME: 'engine:frame',
	// The path tracer compiles its shaders in the background ({ compiling }); the canvas keeps its last frame meanwhile.
	SHADERS_COMPILING: 'engine:shadersCompiling',

	// Denoiser
	DENOISING_START: 'engine:denoisingStart',
	DENOISING_END: 'engine:denoisingEnd',

	// Upscaler
	UPSCALING_START: 'engine:upscalingStart',
	UPSCALING_PROGRESS: 'engine:upscalingProgress',
	UPSCALING_END: 'engine:upscalingEnd',

	// Loading & stats
	LOADING_UPDATE: 'engine:loadingUpdate',
	LOADING_RESET: 'engine:loadingReset',
	STATS_UPDATE: 'engine:statsUpdate',

	// Selection & interaction
	OBJECT_SELECTED: 'engine:objectSelected',
	OBJECT_DESELECTED: 'engine:objectDeselected',
	OBJECT_DOUBLE_CLICKED: 'engine:objectDoubleClicked',
	SELECT_MODE_CHANGED: 'engine:selectModeChanged',

	// Object transform
	OBJECT_TRANSFORM_START: 'engine:objectTransformStart',
	OBJECT_TRANSFORM_END: 'engine:objectTransformEnd',
	TRANSFORM_MODE_CHANGED: 'engine:transformModeChanged',

	// Camera
	CAMERA_SWITCHED: 'engine:cameraSwitched',
	CAMERAS_UPDATED: 'engine:camerasUpdated',
	FOCUS_CHANGED: 'engine:focusChanged',
	AUTO_FOCUS_UPDATED: 'engine:autoFocusUpdated',
	ORTHO_HEIGHT_UPDATED: 'engine:orthoHeightUpdated',
	AUTO_EXPOSURE_UPDATED: 'engine:autoExposureUpdated',
	AF_POINT_PLACED: 'engine:afPointPlaced',

	// Settings
	SETTING_CHANGED: 'engine:settingChanged',

	// Animation
	ANIMATION_STARTED: 'engine:animationStarted',
	ANIMATION_PAUSED: 'engine:animationPaused',
	ANIMATION_STOPPED: 'engine:animationStopped',
	ANIMATION_FINISHED: 'engine:animationFinished',

	// Timeline (authored keyframes)
	TIMELINE_CHANGED: 'engine:timelineChanged',

	// Video rendering
	VIDEO_RENDER_PROGRESS: 'engine:videoRenderProgress',
	VIDEO_RENDER_COMPLETE: 'engine:videoRenderComplete',

	// Lifecycle
	DISPOSE: 'engine:dispose',
	DEVICE_LOST: 'engine:deviceLost',

	// Degradation
	ISSUE: 'engine:issue',

	// Scene and assets
	MODEL_LOADED: 'engine:modelLoaded',
	OBJECT3D_LOADED: 'engine:object3dLoaded',
	MODEL_ADDED: 'engine:modelAdded',
	SCENE_OBJECT_REMOVED: 'engine:sceneObjectRemoved',
	SCENE_UNLOADED: 'engine:sceneUnloaded',
	SCENE_REBUILD: 'engine:sceneRebuild',
	SCENE_SPILLED: 'engine:sceneSpilled',
	SCENE_METADATA_APPLIED: 'engine:sceneMetadataApplied',
	ENVIRONMENT_LOADED: 'engine:environmentLoaded',
	TEXTURES_REPROCESSED: 'engine:texturesReprocessed',

	// Render size
	RESOLUTION_CHANGED: 'engine:resolutionChanged',
	RESERVED_RENDER_SIZE_CHANGED: 'engine:reservedRenderSizeChanged',

	// Storage (OPFS): usage or entries changed
	STORAGE_CHANGED: 'engine:storageChanged',
};

/**
 * The names these events had before they moved under `engine:`. The app dispatches each under both
 * until the next major.
 */
export const LEGACY_EVENT_NAMES = Object.freeze( {
	[ EngineEvents.RENDER_COMPLETE ]: 'RenderComplete',
	[ EngineEvents.RENDER_RESET ]: 'RenderReset',
	[ EngineEvents.CAMERA_SWITCHED ]: 'CameraSwitched',
	[ EngineEvents.CAMERAS_UPDATED ]: 'CamerasUpdated',
	[ EngineEvents.FOCUS_CHANGED ]: 'focusChanged',
	[ EngineEvents.MODEL_LOADED ]: 'ModelLoaded',
	[ EngineEvents.OBJECT3D_LOADED ]: 'Object3DLoaded',
	[ EngineEvents.MODEL_ADDED ]: 'ModelAdded',
	[ EngineEvents.SCENE_OBJECT_REMOVED ]: 'SceneObjectRemoved',
	[ EngineEvents.SCENE_UNLOADED ]: 'SceneUnloaded',
	[ EngineEvents.SCENE_REBUILD ]: 'SceneRebuild',
	[ EngineEvents.SCENE_SPILLED ]: 'SceneSpilled',
	[ EngineEvents.SCENE_METADATA_APPLIED ]: 'SceneMetadataApplied',
	[ EngineEvents.ENVIRONMENT_LOADED ]: 'EnvironmentLoaded',
	[ EngineEvents.TEXTURES_REPROCESSED ]: 'TexturesReprocessed',
	[ EngineEvents.RESOLUTION_CHANGED ]: 'resolution_changed',
	[ EngineEvents.RESERVED_RENDER_SIZE_CHANGED ]: 'reserved_render_size_changed',
} );
