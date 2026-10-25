import { create } from 'zustand';
import { DEFAULT_STATE, CAMERA_PRESETS } from '@/Constants';
import { getApp } from '@/lib/appProxy';

// Simple ('look') or Pro ('physical') depth of field — who is using the app, so it is kept across sessions.
const DOF_MODE_KEY = 'rayzee-dof-mode';

function readDofMode() {

	try {

		const mode = localStorage.getItem( DOF_MODE_KEY );
		return mode === 'look' || mode === 'physical' ? mode : DEFAULT_STATE.dofMode;

	} catch {

		return DEFAULT_STATE.dofMode;

	}

}

// Camera store
export const useCameraStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	activePreset: "custom",
	dofMode: readDofMode(),
	navigationMode: 'orbit',
	walkSpeed: 1,
	walkSpeedFitted: 1,
	orthoHeight: 1,
	modelDimensions: [ 1, 1, 1 ],
	cameraNames: [],
	selectedCameraIndex: 0,
	selectMode: false,

	// Auto-focus state
	autoFocusMode: DEFAULT_STATE.autoFocusMode,
	afScreenPoint: { ...DEFAULT_STATE.afScreenPoint },
	afSmoothingFactor: DEFAULT_STATE.afSmoothingFactor,
	afPlacingPoint: false,

	setCameraNames: names => set( { cameraNames: names } ),
	setSelectedCameraIndex: idx => set( { selectedCameraIndex: idx } ),

	// Sync the UI to a camera's own DOF/focus effects on switch (pure state, no engine calls —
	// the engine already applied them). Only defined fields are written.
	applyCameraEffects: e => set( () => {

		const next = { activePreset: 'custom' };
		if ( e.fov !== undefined ) next.fov = e.fov;
		if ( e.enableDOF !== undefined ) next.enableDOF = e.enableDOF;
		if ( e.focusDistance !== undefined ) next.focusDistance = e.focusDistance;
		if ( e.aperture !== undefined ) next.aperture = e.aperture;
		if ( e.focalLength !== undefined ) next.focalLength = e.focalLength;
		if ( e.apertureScale !== undefined ) next.apertureScale = e.apertureScale;
		if ( e.anamorphicRatio !== undefined ) next.anamorphicRatio = e.anamorphicRatio;
		if ( e.dofBlur !== undefined ) next.dofBlur = e.dofBlur;
		if ( e.autoFocusMode !== undefined ) next.autoFocusMode = e.autoFocusMode;
		if ( e.afScreenPoint !== undefined ) next.afScreenPoint = e.afScreenPoint;
		return next;

	} ),
	setSelectMode: mode => set( { selectMode: mode } ),
	// Auto-focus reports every frame the focus moves: store only a change the readout would show.
	setAutoFocusDistance: val => {

		const { focusDistance, unitsPerMetre } = get();
		const shown = d => ( d / unitsPerMetre ).toPrecision( 3 );
		if ( shown( val ) !== shown( focusDistance ) ) set( { focusDistance: val } );

	},
	setFov: val => set( { fov: val, activePreset: "custom" } ),
	setAperture: val => set( { aperture: val, activePreset: "custom" } ),
	setFocalLength: val => set( { focalLength: val, activePreset: "custom" } ),
	setEnableDOF: val => set( { enableDOF: val, activePreset: "custom" } ),
	setZoomToCursor: val => set( { zoomToCursor: val } ),
	handleToggleSelectMode: () => {

		const app = getApp();
		if ( ! app ) return;

		const isActive = app.interactionManager.toggleSelectMode();
		set( { selectMode: isActive } );

	},

	handleEnableDOFChange: val => {

		set( { enableDOF: val, activePreset: "custom" } );
		getApp()?.settings.set( 'enableDOF', val );

	},

	handleDofModeChange: mode => {

		set( { dofMode: mode } );
		getApp()?.settings.set( 'dofMode', mode );

		try {

			localStorage.setItem( DOF_MODE_KEY, mode );

		} catch {

			// Storage blocked: the choice lasts for this page only.

		}

	},

	handleDofBlurChange: percent => {

		const dofBlur = percent / 100;
		set( { dofBlur, activePreset: "custom" } );
		getApp()?.settings.set( 'dofBlur', dofBlur );

	},

	// The real length of the model's longest side, which sets how many scene units the lens takes as a metre.
	handleSubjectSizeChange: metres => {

		if ( ! ( metres > 0 ) ) return;
		const unitsPerMetre = Math.max( ...get().modelDimensions ) / metres;
		set( { unitsPerMetre } );
		getApp()?.settings.set( 'unitsPerMetre', unitsPerMetre );

	},

	// A new model starts in its own file's units, at the walk speed the engine fitted to it.
	syncModelSize: ( { resetUnits = false } = {} ) => {

		const app = getApp();
		if ( ! app ) return;

		const next = {};
		const modelDimensions = app.assetLoader.getSceneSize().toArray();
		if ( modelDimensions.some( ( d, i ) => d !== get().modelDimensions[ i ] ) ) next.modelDimensions = modelDimensions;

		// The load that fired this has already reset the render.
		if ( resetUnits ) {

			next.unitsPerMetre = 1;
			app.settings.set( 'unitsPerMetre', 1, { reset: false } );
			next.walkSpeed = next.walkSpeedFitted = app.cameraManager.walkControls.speed;

		}

		if ( Object.keys( next ).length ) set( next );

	},

	handleNavigationModeChange: mode => {

		set( { navigationMode: mode } );
		getApp()?.cameraManager.setNavigationMode( mode );

	},

	handleWalkSpeedChange: metresPerSecond => {

		const walkSpeed = metresPerSecond * get().unitsPerMetre;
		set( { walkSpeed } );
		const walk = getApp()?.cameraManager.walkControls;
		if ( walk ) walk.speed = walkSpeed;

	},

	setOrthoHeight: orthoHeight => set( { orthoHeight } ),

	handleOrthoHeightChange: metres => {

		const orthoHeight = metres * get().unitsPerMetre;
		set( { orthoHeight } );
		getApp()?.cameraManager.setOrthoHeight( orthoHeight );

	},

	handleZoomToCursorChange: val => {

		set( { zoomToCursor: val } );
		const app = getApp();
		if ( app?.cameraManager?.controls ) {

			app.cameraManager.controls.zoomToCursor = val;

		}

	},

	handleAFScreenPointChange: point => {

		set( { afScreenPoint: point, afPlacingPoint: false } );
		const app = getApp();
		if ( app ) {

			app.cameraManager.setAFScreenPoint( point.x, point.y );
			app.wake();

		}

	},

	handleAFResetToCenter: () => {

		const center = { x: 0.5, y: 0.5 };
		set( { afScreenPoint: center } );
		const app = getApp();
		if ( app ) {

			app.cameraManager.setAFScreenPoint( 0.5, 0.5 );
			app.wake();

		}

	},

	handleAFSmoothingChange: val => {

		set( { afSmoothingFactor: val } );
		const cm = getApp()?.cameraManager;
		if ( cm ) cm.afSmoothingFactor = val;

	},

	handleToggleAFPointPlacement: () => {

		const current = get().afPlacingPoint;
		set( { afPlacingPoint: ! current } );
		const cm = getApp()?.cameraManager;
		if ( cm ) {

			if ( ! current ) {

				cm.enterAFPointPlacementMode();

			} else {

				cm.exitAFPointPlacementMode();

			}

		}

	},

	handlePresetChange: key => {

		if ( key === "custom" ) {

			set( { activePreset: "custom" } );
			return;

		}

		// Sets both lens models, so switching between them keeps the look's intent.
		const { dofBlur, aperture, focalLength, apertureScale, anamorphicRatio = 1.0 } = CAMERA_PRESETS[ key ];
		const lens = { dofBlur, aperture, focalLength, apertureScale, anamorphicRatio };
		set( { ...lens, activePreset: key } );
		getApp()?.settings.setMany( lens );

	},

	handleFovChange: val => {

		const app = getApp();
		if ( app ) {

			const oldFov = app.cameraManager.active.fov;
			const target = app.cameraManager.controls.target.clone();
			const oldDistance = app.cameraManager.active.position.distanceTo( target );

			// Keep perceived size constant: distance * tan(fov/2) = constant
			const newDistance = oldDistance * Math.tan( oldFov * Math.PI / 360 ) / Math.tan( val * Math.PI / 360 );

			// Move camera along the orbit direction
			const direction = app.cameraManager.active.position.clone().sub( target ).normalize();
			app.cameraManager.active.position.copy( target ).addScaledVector( direction, newDistance );

			app.cameraManager.active.fov = val;
			app.cameraManager.active.updateProjectionMatrix();
			app.cameraManager.controls.update();
			app.reset();

		}

		set( { fov: val, activePreset: "custom" } );

	},

	handleApertureChange: val => {

		set( { aperture: val, activePreset: "custom" } );
		getApp()?.settings.set( 'aperture', val );

	},

	handleFocalLengthChange: val => {

		set( { focalLength: val, activePreset: "custom" } );
		const app = getApp();
		if ( app ) {

			app.settings.set( 'focalLength', val );
			if ( val <= 0 ) app.settings.set( 'aperture', 16.0 );

		}

	},

	handleCameraMove: point => {

		const app = getApp();
		if ( ! app?.cameraManager?.controls ) return;
		const controls = app.cameraManager.controls;
		const camera = app.cameraManager.camera;
		const target = controls.target.clone();
		const distance = camera.position.distanceTo( target );
		const remap = ( val, inMin, inMax, outMin, outMax ) => ( val - inMin ) * ( outMax - outMin ) / ( inMax - inMin ) + outMin;
		const phi = remap( point.y, 0, 100, 0, - Math.PI );
		const theta = remap( point.x, 0, 100, 0, - Math.PI );
		const newX = target.x + distance * Math.sin( phi ) * Math.cos( theta );
		const newY = target.y + distance * Math.cos( phi );
		const newZ = target.z + distance * Math.sin( phi ) * Math.sin( theta );
		camera.position.set( newX, newY, newZ );
		camera.lookAt( target );
		controls.update();

	},

	// Store camera state is written by the engine's CameraSwitched / CamerasUpdated
	// events (via EngineAdapter), so these handlers only drive the engine.
	handleCameraChange: idx => {

		getApp()?.cameraManager.switchCamera( Number( idx ) );

	},

	// Snapshot the current view as a new camera and switch to it.
	handleAddCamera: () => {

		getApp()?.addCamera();

	},

	// Remove a user-added camera; the engine falls back to the default if it was active.
	handleRemoveCamera: idx => {

		getApp()?.removeCamera( Number( idx ) );

	},

	// Back to the active camera's own view, whose field of view may differ from the slider's.
	handleResetCamera: () => {

		const cameraManager = getApp()?.cameraManager;
		if ( ! cameraManager ) return;
		cameraManager.resetView();
		const { fov } = cameraManager.camera;
		if ( fov !== get().fov ) set( { fov } );

	},

	handleApertureScaleChange: val => {

		set( { apertureScale: val, activePreset: "custom" } );
		getApp()?.settings.set( 'apertureScale', val );

	},

	handleAnamorphicRatioChange: val => {

		set( { anamorphicRatio: val, activePreset: "custom" } );
		getApp()?.settings.set( 'anamorphicRatio', val );

	},


} ) );
