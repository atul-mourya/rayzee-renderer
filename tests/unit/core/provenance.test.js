import { describe, it, expect } from 'vitest';
import { REVISION } from 'three';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { VERSION } from '@/core/version.js';
import { getRenderProfile } from '@/core/EngineDefaults.js';

describe( 'getProvenance', () => {

	it( 'names what produced an image, as plain JSON', () => {

		const app = new PathTracerApp( null, { profile: 'physical', strict: true } );
		app.adapterInfo = { vendor: 'apple', architecture: 'metal-3', isSoftware: false };

		const provenance = app.getProvenance();

		expect( JSON.parse( JSON.stringify( provenance ) ) ).toEqual( provenance );
		expect( provenance ).toMatchObject( {
			engine: VERSION,
			three: REVISION,
			profile: { name: 'physical', values: { ...getRenderProfile( 'physical' ) } },
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

	it( 'reports the viewer profile by name when none is asked for', () => {

		expect( new PathTracerApp( null ).getProvenance().profile.name ).toBe( 'viewer' );

	} );

} );
