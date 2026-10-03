import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { RenderSettings } from '@/core/RenderSettings.js';

function viewer( { autoExposure = false, requiresMotionVectors = false } = {} ) {

	const app = {
		stages: { pathTracer: { setUniform: vi.fn() }, autoExposure: { enabled: autoExposure } },
		renderer: { toneMappingExposure: 1 },
		cameraManager: { applyProjection: vi.fn() },
		denoisingManager: { requiresMotionVectors, setDenoiserStrategy: vi.fn() },
		reset: vi.fn(),
		_reconcileCompletion: vi.fn(),
	};
	const settings = new RenderSettings();
	settings.bind( PathTracerApp.prototype._settingsBindings.call( app ) );
	return { app, settings };

}

describe( 'the viewer\'s side of the core settings', () => {

	it( 'shows a new exposure unless auto exposure drives it', () => {

		const manual = viewer();
		manual.settings.set( 'exposure', 2 );
		expect( manual.app.renderer.toneMappingExposure ).toBe( 2 );

		const auto = viewer( { autoExposure: true } );
		auto.settings.set( 'exposure', 2 );
		expect( auto.app.renderer.toneMappingExposure ).toBe( 1 );

	} );

	it( 'turns the camera, and keeps the motion-vector denoisers except for a panorama', () => {

		const { app, settings } = viewer( { requiresMotionVectors: true } );

		settings.set( 'cameraProjection', 'orthographic' );
		expect( app.cameraManager.applyProjection ).toHaveBeenLastCalledWith( 'orthographic' );
		expect( app.denoisingManager.setDenoiserStrategy ).not.toHaveBeenCalled();

		settings.set( 'cameraProjection', 'equirectangular' );
		expect( app.denoisingManager.setDenoiserStrategy ).toHaveBeenCalledWith( 'edgeaware' );

	} );

} );
