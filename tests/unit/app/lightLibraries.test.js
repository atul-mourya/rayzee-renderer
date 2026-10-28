import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D, SpotLight, Mesh } from 'three';

vi.mock( '@/services/GoboLibrary', () => ( { GOBO_LIBRARY: [ 'gobo' ] } ) );
vi.mock( '@/services/IESLibrary', () => ( { IES_LIBRARY: [ 'ies' ] } ) );

import { setApp } from '@/lib/appProxy';
import { loadLightLibraries, lightLibrariesReady } from '@/lib/lightLibraries';

function makeApp( { lightData } = {} ) {

	const scene = new Object3D();
	const mesh = new Mesh();
	mesh.userData.gobo = 'not a light';
	scene.add( mesh );
	const light = new SpotLight();
	if ( lightData ) light.userData = lightData;
	scene.add( light );
	return {
		isInitialized: true,
		scene,
		reset: vi.fn(),
		goboManager: { loadLibrary: vi.fn( async () => {} ) },
		iesManager: { loadLibrary: vi.fn( async () => {} ) },
	};

}

describe( 'loadLightLibraries', () => {

	beforeEach( () => setApp( null ) );
	afterEach( () => vi.restoreAllMocks() );

	it( 'hands each manager its library, once per app', async () => {

		const app = makeApp();

		const first = loadLightLibraries( app );
		expect( loadLightLibraries( app ) ).toBe( first );
		await first;

		expect( app.goboManager.loadLibrary ).toHaveBeenCalledTimes( 1 );
		expect( app.goboManager.loadLibrary ).toHaveBeenCalledWith( [ 'gobo' ] );
		expect( app.iesManager.loadLibrary ).toHaveBeenCalledWith( [ 'ies' ] );

		const other = makeApp();
		await loadLightLibraries( other );
		expect( other.goboManager.loadLibrary ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'restarts the render only when a light already uses a mask or a profile', async () => {

		const plain = makeApp();
		await loadLightLibraries( plain );
		expect( plain.reset ).not.toHaveBeenCalled();

		const masked = makeApp( { lightData: { gobo: 'circle' } } );
		await loadLightLibraries( masked );
		expect( masked.reset ).toHaveBeenCalledTimes( 1 );

		const profiled = makeApp( { lightData: { ies: 'spot-narrow' } } );
		await loadLightLibraries( profiled );
		expect( profiled.reset ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'loads into an app without the managers or a scene', async () => {

		await expect( loadLightLibraries( { reset: vi.fn() } ) ).resolves.toBeUndefined();

	} );

	it( 'warns rather than rejects when a library fails to load', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const app = makeApp( { lightData: { gobo: 'circle' } } );
		const error = new Error( 'offline' );
		app.iesManager.loadLibrary.mockRejectedValue( error );

		await expect( loadLightLibraries( app ) ).resolves.toBeUndefined();
		expect( warn ).toHaveBeenCalledWith( expect.stringContaining( 'library load failed' ), error );
		expect( app.reset ).not.toHaveBeenCalled();

	} );

} );

describe( 'lightLibrariesReady', () => {

	it( 'resolves at once with no app running, or one whose libraries never started', async () => {

		setApp( null );
		await expect( lightLibrariesReady() ).resolves.toBeUndefined();

		setApp( makeApp() );
		await expect( lightLibrariesReady() ).resolves.toBeUndefined();

	} );

	it( 'is the running app\'s own load', async () => {

		const app = makeApp();
		let finish;
		app.goboManager.loadLibrary.mockReturnValue( new Promise( resolve => {

			finish = resolve;

		} ) );
		setApp( app );

		const load = loadLightLibraries( app );
		expect( lightLibrariesReady() ).toBe( load );

		let settled = false;
		lightLibrariesReady().then( () => {

			settled = true;

		} );
		await new Promise( resolve => setTimeout( resolve, 0 ) );
		expect( settled ).toBe( false );

		finish();
		await load;
		expect( settled ).toBe( true );

	} );

} );
