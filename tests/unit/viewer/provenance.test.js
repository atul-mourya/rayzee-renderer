import { describe, it, expect } from 'vitest';
import { REVISION } from 'three';
import { PathTracerApp } from '@/core/viewer/PathTracerApp.js';
import { VERSION } from '@/core/Version.js';

describe( 'getProvenance', () => {

	it( 'names what produced an image, as plain JSON', () => {

		const app = new PathTracerApp( null, { strict: true } );
		app.adapterInfo = { vendor: 'apple', architecture: 'metal-3', isSoftware: false };

		const provenance = app.getProvenance();

		expect( JSON.parse( JSON.stringify( provenance ) ) ).toEqual( provenance );
		expect( provenance ).toMatchObject( {
			engine: VERSION,
			three: REVISION,
			adapter: { vendor: 'apple' },
			mode: { headless: true, strict: true, deterministic: false, lockstep: false },
			render: null,
		} );

	} );

	it( 'carries each setting with where it came from', () => {

		const app = new PathTracerApp( null );
		app.settings.set( 'maxBounces', 7, { silent: true, reset: false } );

		const { settings } = app.getProvenance();
		expect( settings.maxBounces ).toMatchObject( { value: 7, source: 'host' } );
		expect( settings.maxSamples.source ).toBe( 'default' );

	} );

	it( 'says which display-only exposure shaped an sRGB readback, since no setting records it', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().exposure ).toEqual( { auto: null, local: null } );

		app.stages.autoExposure = { enabled: true, getExposure: () => 2, strength: 0.3, metering: 'center', keyValue: 0.18 };
		app.stages.localExposure = { enabled: true, highlightContrast: 0.6, shadowContrast: 1, detailStrength: 1 };
		expect( app.getProvenance().exposure ).toEqual( {
			auto: { exposure: 2, strength: 0.3, metering: 'center', keyValue: 0.18 },
			local: { highlightContrast: 0.6, shadowContrast: 1, detailStrength: 1 },
		} );

	} );

	it( 'says which denoiser made the picture, since a denoised readback depends on its model', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().denoise ).toEqual( { live: 'none', final: null } );

		app.denoisingManager = {
			denoiserStrategy: 'oidn', finalDenoise: true, oidnQuality: 'high',
			denoiser: { currentTZAUrl: 'https://cdn/oidn/rt_hdr_calb_cnrm_large.tza', getRuntimeInfo: () => ( { precision: 'fp16' } ), _activeTileSize: 1056 },
		};
		expect( app.getProvenance().denoise ).toEqual( {
			live: 'oidn',
			final: { quality: 'high', weights: 'rt_hdr_calb_cnrm_large.tza', precision: 'fp16', tileSize: 1056 },
		} );

	} );

	it( 'says what the picture was shown at, so a saved copy of its light can be shown again', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().display ).toEqual( { exposure: null, backdrop: null, backdropExposure: null } );

		app.renderer = { toneMappingExposure: 2.5 };
		app.stages.compositor = { backdropExposure: 1 };
		expect( app.getProvenance().display ).toMatchObject( { exposure: 2.5, backdropExposure: 1 } );

	} );

	it( 'carries the area-light scale with the other settings', () => {

		expect( new PathTracerApp( null ).getProvenance().settings.areaLightIntensityScale )
			.toMatchObject( { value: 0.1, source: 'default', routed: true } );

	} );

	it( 'refuses the removed profile option rather than ignoring it', () => {

		expect( () => new PathTracerApp( null, { profile: 'physical' } ) ).toThrow( /`profile` option was removed/ );

	} );

} );
