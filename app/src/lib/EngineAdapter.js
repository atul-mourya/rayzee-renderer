/**
 * EngineAdapter — bridges engine events to Zustand stores.
 *
 * This is the ONLY file that wires the framework-agnostic engine events
 * to the React/Zustand UI layer. If you're using a different UI framework,
 * replace this adapter with your own.
 */
import { EngineEvents } from 'rayzee';

/**
 * Subscribe to engine events and dispatch corresponding Zustand store updates.
 * @param {PathTracerApp} engine - The engine instance (extends EventDispatcher)
 * @param {Object} stores - Zustand stores { useStore, useCameraStore, usePathTracerStore }
 * @returns {Function} cleanup - Call to unsubscribe all listeners
 */
export function connectEngineToStore( engine, { useStore, useCameraStore, usePathTracerStore, useAnimationStore, useLightStore } ) {

	const handlers = [];

	function on( type, fn ) {

		engine.addEventListener( type, fn );
		handlers.push( [ type, fn ] );

	}

	// ── Render lifecycle ─────────────────────────────────────
	on( EngineEvents.RENDER_COMPLETE, ( e ) => {

		useStore.getState().setIsRenderComplete( true );
		useStore.getState().setIsRendering( false );
		useStore.getState().setCompletionReason( e?.reason ?? null );

	} );

	on( EngineEvents.RENDER_RESET, () => {

		useStore.getState().setIsRenderComplete( false );
		useStore.getState().setIsRendering( true );
		useStore.getState().setCompletionReason( null );

	} );

	// ── Denoiser ─────────────────────────────────────────────
	on( EngineEvents.DENOISING_START, () => useStore.getState().setIsDenoising( true ) );
	on( EngineEvents.DENOISING_END, () => useStore.getState().setIsDenoising( false ) );

	// ── Upscaler ─────────────────────────────────────────────
	on( EngineEvents.UPSCALING_START, () => {

		useStore.getState().setIsUpscaling( true );
		useStore.getState().setUpscalingProgress( 0 );

	} );

	on( EngineEvents.UPSCALING_PROGRESS, ( e ) => {

		useStore.getState().setUpscalingProgress( e.progress );

	} );

	on( EngineEvents.UPSCALING_END, () => {

		useStore.getState().setIsUpscaling( false );
		useStore.getState().setUpscalingProgress( 0 );

	} );

	// ── Loading & stats ──────────────────────────────────────
	on( EngineEvents.LOADING_RESET, () => useStore.getState().resetLoading() );

	on( EngineEvents.LOADING_UPDATE, ( e ) => {

		const { type: _type, target: _target, ...loadingState } = e;
		const state = useStore.getState();
		state.setLoading( { ...state.loading, ...loadingState } );

	} );

	on( EngineEvents.STATS_UPDATE, ( e ) => {

		const { type: _type, target: _target, ...statsUpdate } = e;
		const state = useStore.getState();
		state.setStats( { ...( state.stats || {} ), ...statsUpdate } );

	} );

	// ── Selection & interaction ──────────────────────────────
	on( EngineEvents.OBJECT_SELECTED, ( e ) => {

		useStore.getState().setSelectedObject( e.object );

	} );

	on( EngineEvents.OBJECT_DOUBLE_CLICKED, () => {

		useStore.getState().setActiveTab( 'material' );

	} );

	on( EngineEvents.SELECT_MODE_CHANGED, ( e ) => {

		useCameraStore.getState().setSelectMode( e.enabled );

	} );

	// ── Object transform ────────────────────────────────────
	on( EngineEvents.OBJECT_TRANSFORM_START, () => {

		useStore.getState().setIsTransforming( true );

	} );

	on( EngineEvents.OBJECT_TRANSFORM_END, () => {

		useStore.getState().setIsTransforming( false );

		// A light's Position/Target fields in the Lights panel are edited via
		// numeric inputs that don't reflect gizmo drags live — refresh them
		// once the drag ends (mirrors LightsTab's own SceneRebuild refresh).
		if ( engine.transformManager?.attachedObject?.isLight && useLightStore ) {

			useLightStore.getState().setLights( engine.lightManager.getAll() );

		}

	} );

	on( EngineEvents.TRANSFORM_MODE_CHANGED, ( e ) => {

		useStore.setState( { transformMode: e.mode } );

	} );

	// ── Camera ───────────────────────────────────────────────
	on( EngineEvents.AF_POINT_PLACED, ( e ) => {

		useCameraStore.getState().handleAFScreenPointChange( e.point );

	} );

	on( EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => {

		useCameraStore.getState().setAutoFocusDistance( e.distance );

	} );

	// Camera list changed (add / remove / model load) → sync names + selection.
	on( 'CamerasUpdated', ( e ) => {

		const cam = useCameraStore.getState();
		cam.setCameraNames( e.cameraNames || engine.cameraManager.getCameraNames() );
		cam.setSelectedCameraIndex( engine.currentCameraIndex ?? 0 );

	} );

	// Camera switch → sync selection + the camera's own per-camera DOF/focus effects.
	// The engine emits UI-facing (unscaled) values, so this is a plain passthrough.
	on( 'CameraSwitched', ( e ) => {

		const cam = useCameraStore.getState();
		cam.setSelectedCameraIndex( e.cameraIndex );

		if ( e.effects ) {

			cam.applyCameraEffects( {
				fov: e.fov,
				enableDOF: e.effects.enableDOF,
				focusDistance: e.effects.focusDistance,
				aperture: e.effects.aperture,
				focalLength: e.effects.focalLength,
				apertureScale: e.effects.apertureScale,
				anamorphicRatio: e.effects.anamorphicRatio,
				autoFocusMode: e.effects.autoFocusMode,
				afScreenPoint: e.effects.afScreenPoint,
			} );

		}

	} );

	on( EngineEvents.AUTO_EXPOSURE_UPDATED, ( e ) => {

		usePathTracerStore.getState().setCurrentAutoExposure( e.exposure );
		usePathTracerStore.getState().setCurrentAvgLuminance( e.luminance );

	} );

	// ── Animation ───────────────────────────────────────────
	on( EngineEvents.ANIMATION_STARTED, () => {

		if ( useAnimationStore ) useAnimationStore.getState().setIsPlaying?.( true );

	} );

	on( EngineEvents.ANIMATION_PAUSED, () => {

		if ( useAnimationStore ) {

			const state = useAnimationStore.getState();
			state.setIsPlaying?.( false );
			state.setIsPaused?.( true );

		}

	} );

	on( EngineEvents.ANIMATION_STOPPED, () => {

		if ( useAnimationStore ) {

			const state = useAnimationStore.getState();
			state.setIsPlaying?.( false );
			state.setIsPaused?.( false );

		}

	} );

	on( EngineEvents.ANIMATION_FINISHED, () => {

		if ( useAnimationStore ) {

			const state = useAnimationStore.getState();
			state.setIsPlaying?.( false );
			state.setIsPaused?.( false );

		}

	} );

	// The loaded model file carried an authored environment and the engine installed it.
	on( 'SceneMetadataApplied', ( e ) => {

		usePathTracerStore?.getState().syncSceneEnvironment?.( e.environment );

	} );

	on( 'SceneRebuild', () => {

		// Update animation clips list when a new scene is loaded
		if ( useAnimationStore ) {

			const clips = engine.animationManager?.clips || [];
			useAnimationStore.getState().setClips( clips );

		}

		// Mirror the new scene floor into the shadow-catcher height control. The engine already
		// re-seeded the uniform in loadSceneData; this keeps the UI value in sync on model change.
		if ( usePathTracerStore && typeof engine.getSceneMinY === 'function' ) {

			usePathTracerStore.setState( { groundCatcherHeight: engine.getSceneMinY() } );

		}

		// Mirror the emissive-sampling toggle: the engine auto-enables it when the loaded
		// scene has emissive geometry, so the "Emissive Geometry" switch tracks the scene.
		if ( usePathTracerStore && engine.settings ) {

			usePathTracerStore.setState( {
				enableEmissiveTriangleSampling: !! engine.settings.get( 'enableEmissiveTriangleSampling' ),
			} );

		}

		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

	} );

	on( 'resolution_changed', ( e ) => {

		window.dispatchEvent( new CustomEvent( 'resolution_changed', {
			detail: { width: e.width, height: e.height }
		} ) );

	} );

	// ── Cleanup ──────────────────────────────────────────────
	return () => {

		handlers.forEach( ( [ type, fn ] ) => engine.removeEventListener( type, fn ) );
		handlers.length = 0;

	};

}
