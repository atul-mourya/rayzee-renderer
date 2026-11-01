/**
 * A tripwire, not a spec. Everything here decides what a render looks like when a host sets
 * nothing. When one of these fails on purpose: update the snapshot (`npx vitest run -u`) and say
 * in the commit body how default renders change, so a host calibrated against the old defaults
 * finds out from the release notes, not by rendering. A look change is not breaking (CLAUDE.md).
 */
import { describe, it, expect } from 'vitest';
import {
	ENGINE_DEFAULTS, MATERIAL_DEFAULTS, PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG, modePresetSettings,
} from '@/core/EngineDefaults.js';
import { DENOISER_DEFAULTS } from '@/core/viewer/denoise/DenoiserSettings.js';
import { AUTO_EXPOSURE_DEFAULTS } from '@/core/viewer/picture/AutoExposure.js';
import { LOCAL_EXPOSURE_DEFAULTS } from '@/core/viewer/picture/LocalExposure.js';
import { AUTO_FOCUS_DEFAULTS } from '@/core/viewer/camera/CameraManager.js';
import { SKY_DEFAULTS } from '@/core/environment/EnvironmentManager.js';
import { DEFAULT_VIEW } from '@/core/color/ViewTransforms.js';

describe( 'defaults that shape pixels — a change here says how renders change in its commit', () => {

	it( 'viewer piece defaults', () => {

		expect( {
			denoisers: DENOISER_DEFAULTS,
			autoExposure: AUTO_EXPOSURE_DEFAULTS,
			localExposure: LOCAL_EXPOSURE_DEFAULTS,
			autoFocus: AUTO_FOCUS_DEFAULTS,
		} ).toMatchSnapshot();

	} );

	it( 'mode presets', () => {

		expect( {
			production: modePresetSettings( PRODUCTION_RENDER_CONFIG ),
			interactive: modePresetSettings( INTERACTIVE_RENDER_CONFIG ),
		} ).toMatchSnapshot();

	} );

	it( 'engine defaults', () => {

		expect( ENGINE_DEFAULTS ).toMatchSnapshot();

	} );

	it( 'starting sky and view', () => {

		expect( { sky: SKY_DEFAULTS, view: DEFAULT_VIEW } ).toMatchSnapshot();

	} );

	it( 'material defaults', () => {

		expect( MATERIAL_DEFAULTS ).toMatchSnapshot();

	} );

} );
