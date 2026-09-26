import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cm = { setView: vi.fn( view => ( { id: 209, ocio: view } ) ) };
const app = { loadColorConfig: vi.fn( async () => ( { id: 'blender-5.1' } ) ) };

vi.mock( 'rayzee', () => ( {
	configureAssets: vi.fn(),
	getActiveColorManagement: () => cm,
	onRegistryChange: vi.fn(),
	listViewTransforms: () => [],
} ) );
vi.mock( '@/lib/appProxy', () => ( { getApp: () => app } ) );
vi.mock( '@/hooks/useActiveApp', () => ( { useActiveApp: () => app } ) );
vi.mock( '@/Constants', () => ( { ASSETS_BASE_URL: 'https://cdn.test' } ) );

import { loadDefaultConfig, DEFAULT_COLOR_CONFIG } from '@/lib/colorManagement';

const BASE = 'https://cdn.test/ocio/blender-5.1/';

function serve( routes ) {

	vi.stubGlobal( 'fetch', vi.fn( async url => {

		if ( ! ( url in routes ) ) return { ok: false, status: 404 };
		const body = routes[ url ];
		return {
			ok: true,
			status: 200,
			json: async () => body,
			arrayBuffer: async () => new TextEncoder().encode( body ).buffer,
		};

	} ) );

}

describe( 'default colour config', () => {

	beforeEach( () => {

		cm.setView.mockClear();
		app.loadColorConfig.mockClear();

	} );

	afterEach( () => vi.unstubAllGlobals() );

	it( 'loads every file the CDN manifest lists and selects AgX with its contrast look', async () => {

		serve( {
			[ `${BASE}manifest.json` ]: { config: 'config.ocio', files: [ 'config.ocio', 'luts/AgX_Base_sRGB.cube' ] },
			[ `${BASE}config.ocio` ]: 'ocio_profile_version: 2.5',
			[ `${BASE}luts/AgX_Base_sRGB.cube` ]: 'LUT_3D_SIZE 2',
		} );

		const { view } = await loadDefaultConfig();

		const options = app.loadColorConfig.mock.calls[ 0 ][ 0 ];
		expect( options.configPath ).toBe( 'config.ocio' );
		expect( options.id ).toBe( DEFAULT_COLOR_CONFIG.id );
		expect( options.registerViews ).toBe( false );
		expect( options.files.map( f => f.relativePath ) ).toEqual( [ 'config.ocio', 'luts/AgX_Base_sRGB.cube' ] );
		expect( new TextDecoder().decode( options.files[ 1 ].data ) ).toBe( 'LUT_3D_SIZE 2' );

		expect( cm.setView ).toHaveBeenCalledWith( { display: 'sRGB', view: 'AgX', look: 'AgX - Medium High Contrast' } );
		expect( view.id ).toBe( 209 );

	} );

	it( 'rejects without touching the app when a file is missing', async () => {

		serve( { [ `${BASE}manifest.json` ]: { config: 'config.ocio', files: [ 'config.ocio', 'luts/missing.cube' ] }, [ `${BASE}config.ocio` ]: '' } );

		await expect( loadDefaultConfig() ).rejects.toThrow( /missing\.cube: HTTP 404/ );
		expect( app.loadColorConfig ).not.toHaveBeenCalled();
		expect( cm.setView ).not.toHaveBeenCalled();

	} );

} );
