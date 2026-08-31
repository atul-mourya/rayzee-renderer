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
	AUTO_FOCUS_UPDATED: 'engine:autoFocusUpdated',
	AUTO_EXPOSURE_UPDATED: 'engine:autoExposureUpdated',
	AF_POINT_PLACED: 'engine:afPointPlaced',

	// Settings
	SETTING_CHANGED: 'engine:settingChanged',

	// Animation
	ANIMATION_STARTED: 'engine:animationStarted',
	ANIMATION_PAUSED: 'engine:animationPaused',
	ANIMATION_STOPPED: 'engine:animationStopped',
	ANIMATION_FINISHED: 'engine:animationFinished',

	// Video rendering
	VIDEO_RENDER_PROGRESS: 'engine:videoRenderProgress',
	VIDEO_RENDER_COMPLETE: 'engine:videoRenderComplete',

	// Lifecycle
	DISPOSE: 'engine:dispose',
	DEVICE_LOST: 'engine:deviceLost',

	// Degradation — something rendered anyway that a batch host may not want to ship
	ISSUE: 'engine:issue',

	// Authored scene metadata (glTF `extras`) was applied to the settings
	SCENE_METADATA_APPLIED: 'engine:sceneMetadataApplied',
};
