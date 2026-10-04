/**
 * A tripwire, not a spec. Everything here decides what a render looks like when a host sets
 * nothing, and hosts pin a major version to pin that look. When one of these fails on purpose:
 * update the snapshot (`npx vitest run -u`), and give the commit a `BREAKING CHANGE:` footer
 * saying how default renders change — the release is then a major. A host that re-blessed its
 * look against the old defaults found out by rendering; this is how it finds out from the notes.
 */
import { describe, it, expect } from 'vitest';
import {
	ENGINE_DEFAULTS, MATERIAL_DEFAULTS, PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG, modePresetSettings,
} from '@/core/EngineDefaults.js';
import { DENOISER_DEFAULTS } from '@/core/Stages/DenoiserSettings.js';
import { AUTO_EXPOSURE_DEFAULTS } from '@/core/Stages/AutoExposure.js';
import { AUTO_FOCUS_DEFAULTS } from '@/core/managers/CameraManager.js';

describe( 'defaults that shape pixels — a change here is a BREAKING CHANGE', () => {

	it( 'viewer piece defaults', () => {

		expect( {
			denoisers: DENOISER_DEFAULTS,
			autoExposure: AUTO_EXPOSURE_DEFAULTS,
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

	it( 'material defaults', () => {

		expect( MATERIAL_DEFAULTS ).toMatchSnapshot();

	} );

} );
