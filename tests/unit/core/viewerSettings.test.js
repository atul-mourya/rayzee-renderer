import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { RenderSettings } from '@/core/RenderSettings.js';
import { AutoExposure } from '@/core/Stages/AutoExposure.js';

function viewer( { autoExposure = false, requiresMotionVectors = false } = {} ) {

	const renderer = { toneMappingExposure: 1 };
	const ae = new AutoExposure( renderer, { enabled: false, strength: 1 } );
	ae.setEnabled( autoExposure );
	const app = {
		stages: { pathTracer: { setUniform: vi.fn() }, autoExposure: ae },
		renderer,
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

	it( 'shows a new exposure, on top of auto exposure while that is on', () => {

		const manual = viewer();
		manual.settings.set( 'exposure', 2 );
		expect( manual.app.renderer.toneMappingExposure ).toBe( 2 );

		const auto = viewer( { autoExposure: true } );
		auto.app.stages.autoExposure._applyMetering( [ Math.log2( 0.18 / 4 ), 1, 1 ] );
		auto.app.stages.autoExposure.advance( 0 );
		auto.settings.set( 'exposure', 2 );
		expect( auto.app.renderer.toneMappingExposure ).toBeCloseTo( 8, 6 );

		auto.app.stages.autoExposure.setEnabled( false );
		expect( auto.app.renderer.toneMappingExposure ).toBe( 2 );

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
