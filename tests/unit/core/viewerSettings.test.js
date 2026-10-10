import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { RenderSettings } from '@/core/RenderSettings.js';
import { EngineEvents } from '@/core/EngineEvents.js';
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

describe( 'a finished render\'s exposure', () => {

	function complete( { enabled = true, resetWhileLanding = false } = {} ) {

		const calls = [];
		const app = {
			stages: {
				pathTracer: { resetCount: 3 },
				autoExposure: {
					enabled,
					meter: async () => {

						calls.push( 'meter' );
						if ( resetWhileLanding ) app.stages.pathTracer.resetCount ++;

					},
					advance: ( s ) => calls.push( `land ${s}` ),
				},
			},
			pipeline: { context: {} },
			completion: { renderCompleteDispatched: true },
			denoisingManager: { onRenderComplete: () => calls.push( 'closing passes' ) },
			_completionInfo: () => ( { reason: 'samples' } ),
			_finishImage: PathTracerApp.prototype._finishImage,
			_renderCompleted: PathTracerApp.prototype._renderCompleted,
			_refreshFinished: () => calls.push( 'redraw' ),
			dispatchEvent: ( e ) => calls.push( e.type ),
		};
		PathTracerApp.prototype._announceComplete.call( app );
		return calls;

	}

	const settle = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

	// Headless, nothing runs the loop that builds it from each finished image.
	it( 'builds local exposure for a readback the loop has not built it for', () => {

		const built = [];
		const le = {
			wantsBuild: true,
			build( context ) {

				built.push( context );
				this.wantsBuild = false;

			},
			toneGain: () => 'gain',
		};
		const app = { stages: { localExposure: le }, pipeline: { context: 'image' } };

		expect( PathTracerApp.prototype._displayGain.call( app ) ).toBe( 'gain' );
		expect( PathTracerApp.prototype._displayGain.call( app ) ).toBe( 'gain' );
		expect( built ).toEqual( [ 'image' ] );

	} );

	it( 'reads the finished image and lands on it before the closing passes and the event', async () => {

		const calls = complete();
		await settle();
		expect( calls ).toEqual( [ 'meter', 'land Infinity', 'redraw', 'closing passes', EngineEvents.RENDER_COMPLETE ] );

	} );

	it( 'announces nothing for a render reset while it landed, and at once with auto exposure off', async () => {

		const reset = complete( { resetWhileLanding: true } );
		await settle();
		expect( reset ).toEqual( [ 'meter', 'land Infinity' ] );

		expect( complete( { enabled: false } ) ).toEqual( [ 'closing passes', EngineEvents.RENDER_COMPLETE ] );

	} );

} );
