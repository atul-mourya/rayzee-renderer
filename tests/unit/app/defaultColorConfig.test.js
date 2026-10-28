import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted( () => ( { cm: null, app: null, transforms: [], setState: null, effect: null } ) );

vi.mock( 'rayzee', async () => ( {
	configureAssets: vi.fn(),
	getActiveColorManagement: () => h.cm,
	onRegistryChange: vi.fn(),
	listViewTransforms: () => h.transforms,
	fetchFile: ( await import( '@/core/storage/DownloadCache.js' ) ).fetchFile,
	ColorManagement: { listBuiltinConfigs: vi.fn( async () => [ 'ocio://studio-config' ] ) },
} ) );
vi.mock( '@/lib/appProxy', () => ( { getApp: () => h.app } ) );
vi.mock( '@/hooks/useActiveApp', () => ( { useActiveApp: () => h.app } ) );
vi.mock( '@/Constants', () => ( { ASSETS_BASE_URL: 'https://cdn.test' } ) );
vi.mock( '@bb-studio/ocio', () => ( { runtime: 'ocio' } ) );
vi.mock( 'react', () => ( {
	useSyncExternalStore: ( subscribe, getSnapshot, getServerSnapshot ) => ( { subscribe, getSnapshot, getServerSnapshot } ),
	useState: init => [ typeof init === 'function' ? init() : init, h.setState ],
	useEffect: effect => {

		h.effect = effect;

	},
} ) );

import { onRegistryChange } from 'rayzee';
import {
	loadDefaultConfig, DEFAULT_COLOR_CONFIG, fetchStartupColor, showStartupColor, applyHdrScreen, useHdrScreen,
	isDefaultConfigPending, ensureDefaultConfig, loadConfigFromFiles, loadBuiltinConfig, unloadConfig, colorManagement,
	useViewTransforms, useColorStatus, HDR_SCREEN_KEY,
} from '@/lib/colorManagement';

const BASE = 'https://cdn.test/ocio/blender-5.1/';
const MANIFEST = { [ `${BASE}manifest.json` ]: { config: 'config.ocio', files: [ 'config.ocio' ] }, [ `${BASE}config.ocio` ]: 'ocio_profile_version: 2.5' };
const PENDING = { config: null, activeView: { configId: 'blender-5.1' } };

let cm, app;

function serve( routes ) {

	vi.stubGlobal( 'fetch', vi.fn( async url => {

		if ( ! ( url in routes ) ) return { ok: false, status: 404 };
		const body = routes[ url ];
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => new TextEncoder().encode( typeof body === 'string' ? body : JSON.stringify( body ) ).buffer,
		};

	} ) );

}

const text = bytes => new TextDecoder().decode( bytes );
const fetched = () => fetch.mock.calls.map( ( [ url ] ) => url.replace( BASE, '' ) );

function screen( matches ) {

	const query = { matches, addEventListener: vi.fn(), removeEventListener: vi.fn() };
	vi.stubGlobal( 'matchMedia', vi.fn( () => query ) );
	return query;

}

const preference = value => vi.stubGlobal( 'localStorage', { getItem: key => ( key === HDR_SCREEN_KEY ? value : null ) } );

async function fresh() {

	vi.resetModules();
	const rayzee = await import( 'rayzee' );
	rayzee.configureAssets.mockClear();
	return { mod: await import( '@/lib/colorManagement' ), rayzee };

}

beforeEach( () => {

	cm = h.cm = {
		setView: vi.fn( view => ( { id: 209, ocio: view } ) ),
		loadBakedView: vi.fn( async () => ( { id: 'baked' } ) ),
		setActiveView: vi.fn( id => ( { id } ) ),
		setHdrOutput: vi.fn(),
		status: vi.fn( () => ( {} ) ),
		on: vi.fn(),
	};
	app = h.app = {
		color: cm,
		loadColorConfig: vi.fn( async () => ( { id: 'blender-5.1' } ) ),
		unloadColorConfig: vi.fn( async () => {} ),
	};

} );

afterEach( () => {

	vi.unstubAllGlobals();
	vi.restoreAllMocks();

} );

describe( 'default colour config', () => {

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

		await expect( loadDefaultConfig() ).rejects.toThrow( /HTTP 404 .*missing\.cube/ );
		expect( app.loadColorConfig ).not.toHaveBeenCalled();
		expect( cm.setView ).not.toHaveBeenCalled();

	} );

} );

describe( 'startup colour', () => {

	it( 'downloads only the baked view when it is there', async () => {

		serve( { [ `${BASE}default-view.bin` ]: 'table', ...MANIFEST } );

		const { baked, config, hdr } = fetchStartupColor();

		expect( text( await baked ) ).toBe( 'table' );
		expect( await config ).toBeNull();
		expect( await hdr ).toBeNull();
		expect( fetched() ).toEqual( [ 'default-view.bin' ] );

	} );

	it( 'downloads the whole config when the baked view is missing', async () => {

		serve( MANIFEST );

		const { baked, config } = fetchStartupColor();

		await expect( baked ).rejects.toThrow( /404/ );
		const download = await config;
		expect( download.configPath ).toBe( 'config.ocio' );
		expect( download.files.map( f => text( f.data ) ) ).toEqual( [ 'ocio_profile_version: 2.5' ] );

	} );

	it( 'downloads the HDR version only for an HDR screen the viewer has not turned off', async () => {

		serve( { [ `${BASE}default-view.bin` ]: 'table', [ `${BASE}default-view-hdr.bin` ]: 'hdr table' } );
		screen( true );

		expect( text( await fetchStartupColor().hdr ) ).toBe( 'hdr table' );

		preference( 'false' );
		fetch.mockClear();
		expect( await fetchStartupColor().hdr ).toBeNull();
		expect( fetched() ).toEqual( [ 'default-view.bin' ] );

		screen( false );
		preference( null );
		expect( await fetchStartupColor().hdr ).toBeNull();

	} );

	it( 'takes a missing HDR version as none', async () => {

		serve( { [ `${BASE}default-view.bin` ]: 'table' } );
		screen( true );

		expect( await fetchStartupColor().hdr ).toBeNull();

	} );

	it( 'shows the baked view, and its HDR version, without loading the config', async () => {

		const sdr = new Uint8Array( [ 1 ] ), hdrBytes = new Uint8Array( [ 2 ] );

		const shown = await showStartupColor( { baked: Promise.resolve( sdr ), config: Promise.resolve( null ), hdr: Promise.resolve( hdrBytes ) } );

		expect( cm.loadBakedView ).toHaveBeenNthCalledWith( 1, sdr, { expect: { configId: 'blender-5.1', display: 'sRGB', view: 'AgX', look: 'AgX - Medium High Contrast' } } );
		expect( cm.loadBakedView ).toHaveBeenNthCalledWith( 2, hdrBytes, { expect: { configId: 'blender-5.1', look: 'AgX - Medium High Contrast' } } );
		expect( cm.setActiveView ).toHaveBeenCalledWith( 'baked' );
		expect( shown ).toEqual( { view: { id: 'baked' } } );
		expect( app.loadColorConfig ).not.toHaveBeenCalled();
		expect( cm.setHdrOutput ).toHaveBeenCalledWith( false );

	} );

	it( 'shows the baked view alone when there is no HDR version', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		await showStartupColor( { baked: Promise.resolve( new Uint8Array( 1 ) ), config: Promise.resolve( null ), hdr: Promise.resolve( null ) } );

		expect( cm.loadBakedView ).toHaveBeenCalledTimes( 1 );
		expect( warn ).not.toHaveBeenCalled();

	} );

	it( 'still shows the baked view when its HDR version is refused', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		cm.loadBakedView.mockImplementation( async ( bytes, { expect: e } ) => {

			if ( ! e.view ) throw new Error( 'other config' );
			return { id: 'baked' };

		} );

		const shown = await showStartupColor( { baked: Promise.resolve( new Uint8Array( 1 ) ), config: Promise.resolve( null ), hdr: Promise.resolve( new Uint8Array( 1 ) ) } );

		expect( shown ).toEqual( { view: { id: 'baked' } } );
		expect( warn ).toHaveBeenCalledWith( 'No pre-baked HDR view: other config' );

	} );

	it( 'falls back to the config already downloaded when the baked view will not load', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const files = [ { relativePath: 'config.ocio', data: new Uint8Array( 1 ) } ];

		const shown = await showStartupColor( { baked: Promise.reject( new Error( 'gone' ) ), config: Promise.resolve( { files, configPath: 'config.ocio' } ), hdr: Promise.resolve( null ) } );

		expect( app.loadColorConfig ).toHaveBeenCalledWith( { files, configPath: 'config.ocio', id: 'blender-5.1', registerViews: false } );
		expect( shown.view.id ).toBe( 209 );
		expect( cm.setActiveView ).not.toHaveBeenCalled();

	} );

	it( 'downloads the config then, when startup did not', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		serve( MANIFEST );
		cm.loadBakedView.mockRejectedValue( new Error( 'stale table' ) );

		await showStartupColor( { baked: Promise.resolve( new Uint8Array( 1 ) ), config: Promise.resolve( null ), hdr: Promise.resolve( null ) } );

		expect( fetched() ).toEqual( [ 'manifest.json', 'config.ocio' ] );
		expect( app.loadColorConfig.mock.calls[ 0 ][ 0 ].configPath ).toBe( 'config.ocio' );

	} );

} );

describe( 'HDR on screen', () => {

	it( 'shows HDR only on an HDR screen the viewer wants it on', () => {

		screen( true );
		applyHdrScreen( true );
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( true );
		applyHdrScreen( false );
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( false );

		screen( false );
		applyHdrScreen( true );
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( false );

		vi.unstubAllGlobals();
		applyHdrScreen( true );
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( false );

	} );

	it( 'reads the viewer\'s choice from storage, on unless turned off', () => {

		screen( true );
		preference( 'false' );
		applyHdrScreen();
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( false );

		preference( 'true' );
		applyHdrScreen();
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( true );

		preference( '{broken' );
		applyHdrScreen();
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( true );

	} );

	it( 'does nothing without colour management that can show HDR', () => {

		h.cm = null;
		expect( () => applyHdrScreen( true ) ).not.toThrow();

		h.cm = { status: vi.fn() };
		applyHdrScreen( true );
		expect( h.cm.status ).not.toHaveBeenCalled();

	} );

	it( 'loads the default config when the HDR version needs it', async () => {

		serve( MANIFEST );
		cm.status.mockReturnValue( { ...PENDING, hdr: { reason: 'needs-config' } } );

		applyHdrScreen( true );
		expect( fetched() ).toEqual( [ 'manifest.json' ] );
		await ensureDefaultConfig();

		expect( app.loadColorConfig ).toHaveBeenCalledTimes( 1 );

		cm.status.mockReturnValue( PENDING );
		applyHdrScreen( true );
		expect( fetch ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'follows the window to another screen, listening once', async () => {

		const query = screen( true );
		const { mod } = await fresh();

		mod.watchHdrScreen();
		mod.watchHdrScreen();

		expect( cm.setHdrOutput ).toHaveBeenCalledTimes( 2 );
		expect( query.addEventListener ).toHaveBeenCalledTimes( 1 );

		query.matches = false;
		query.addEventListener.mock.calls[ 0 ][ 1 ]();
		expect( cm.setHdrOutput ).toHaveBeenLastCalledWith( false );

	} );

	it( 'reports the screen\'s range to React and follows its changes', () => {

		const query = screen( true );
		const store = useHdrScreen();
		const onChange = () => {};

		const unsubscribe = store.subscribe( onChange );
		expect( query.addEventListener ).toHaveBeenCalledWith( 'change', onChange );
		unsubscribe();
		expect( query.removeEventListener ).toHaveBeenCalledWith( 'change', onChange );
		expect( store.getSnapshot() ).toBe( true );
		expect( store.getServerSnapshot() ).toBe( false );

		vi.unstubAllGlobals();
		expect( () => store.subscribe( onChange )() ).not.toThrow();
		expect( store.getSnapshot() ).toBe( false );

	} );

} );

describe( 'default config on demand', () => {

	it( 'is pending only while the default view shows without its config', () => {

		expect( isDefaultConfigPending( null ) ).toBe( false );
		expect( isDefaultConfigPending( PENDING ) ).toBe( true );
		expect( isDefaultConfigPending( { ...PENDING, config: { id: 'blender-5.1' } } ) ).toBe( false );
		expect( isDefaultConfigPending( { config: null, activeView: { configId: 'aces' } } ) ).toBe( false );
		expect( isDefaultConfigPending( { config: null } ) ).toBe( false );

	} );

	it( 'resolves to null when there is nothing to load', async () => {

		serve( MANIFEST );
		expect( await ensureDefaultConfig() ).toBeNull();

		h.cm = null;
		expect( await ensureDefaultConfig() ).toBeNull();
		expect( fetch ).not.toHaveBeenCalled();

	} );

	it( 'loads once however many ask while it loads, and again once it has finished', async () => {

		serve( MANIFEST );
		cm.status.mockReturnValue( PENDING );

		const first = ensureDefaultConfig();
		expect( ensureDefaultConfig() ).toBe( first );
		expect( ( await first ).config ).toEqual( { id: 'blender-5.1' } );
		expect( app.loadColorConfig ).toHaveBeenCalledTimes( 1 );

		await ensureDefaultConfig();
		expect( app.loadColorConfig ).toHaveBeenCalledTimes( 2 );

	} );

} );

describe( 'loading configs', () => {

	const file = ( name, body, webkitRelativePath = '' ) => ( { name, webkitRelativePath, arrayBuffer: async () => new TextEncoder().encode( body ).buffer } );

	it( 'refuses a selection without a .ocio file', async () => {

		await expect( loadConfigFromFiles( [ file( 'a.cube', '' ) ] ) ).rejects.toThrow( 'no .ocio file in the selection' );
		expect( app.loadColorConfig ).not.toHaveBeenCalled();

	} );

	it( 'keeps each file\'s path relative to the config\'s folder and names the config after it', async () => {

		await loadConfigFromFiles( [
			file( 'config.ocio', 'profile', 'configs/studio/config.ocio' ),
			file( 'a.cube', 'lut', 'configs/studio/luts/a.cube' ),
			file( 'readme.txt', 'x', 'elsewhere/readme.txt' ),
		], { registerViews: true } );

		const options = app.loadColorConfig.mock.calls[ 0 ][ 0 ];
		expect( options.configPath ).toBe( 'config.ocio' );
		expect( options.id ).toBe( 'studio' );
		expect( options.registerViews ).toBe( true );
		expect( options.files.map( f => f.relativePath ) ).toEqual( [ 'config.ocio', 'luts/a.cube', 'elsewhere/readme.txt' ] );
		expect( text( options.files[ 1 ].data ) ).toBe( 'lut' );

	} );

	it( 'names a lone config file after itself, unless told otherwise', async () => {

		await loadConfigFromFiles( [ file( 'aces-studio.ocio', 'profile' ) ] );
		expect( app.loadColorConfig.mock.lastCall[ 0 ] ).toMatchObject( { configPath: 'aces-studio.ocio', id: 'aces-studio' } );

		await loadConfigFromFiles( [ file( 'aces-studio.ocio', 'profile' ) ], { id: 'mine' } );
		expect( app.loadColorConfig.mock.lastCall[ 0 ].id ).toBe( 'mine' );

		await loadConfigFromFiles( [ file( 'LUT.CUBE', 'lut' ), file( 'STUDIO.OCIO', 'profile' ) ] );
		expect( app.loadColorConfig.mock.lastCall[ 0 ] ).toMatchObject( { configPath: 'STUDIO.OCIO', id: 'STUDIO' } );

	} );

	it( 'loads a built-in config by name and unloads through the app', async () => {

		await loadBuiltinConfig( 'ocio://cg-config', { registerViews: false } );
		expect( app.loadColorConfig ).toHaveBeenCalledWith( { builtin: 'ocio://cg-config', registerViews: false } );

		await unloadConfig();
		expect( app.unloadColorConfig ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'needs a running app', async () => {

		h.app = null;
		await expect( loadBuiltinConfig( 'ocio://cg-config' ) ).rejects.toThrow( 'no app running' );
		await expect( unloadConfig() ).rejects.toThrow( 'no app running' );

	} );

	it( 'names the OCIO runtime to the engine once, on first use', async () => {

		const { mod, rayzee } = await fresh();
		expect( rayzee.configureAssets ).not.toHaveBeenCalled();

		expect( await mod.builtinConfigs() ).toEqual( [ 'ocio://studio-config' ] );
		await mod.loadBuiltinConfig( 'ocio://studio-config' );

		expect( rayzee.configureAssets ).toHaveBeenCalledTimes( 1 );
		const { ocioRuntimeFactory } = rayzee.configureAssets.mock.calls[ 0 ][ 0 ];
		expect( ( await ocioRuntimeFactory() ).runtime ).toBe( 'ocio' );

	} );

	it( 'reads the active colour management from the engine', () => {

		expect( colorManagement() ).toBe( cm );
		h.cm = null;
		expect( colorManagement() ).toBeNull();

	} );

} );

describe( 'colour hooks', () => {

	it( 'keeps one list of view transforms until one is added, removed or renamed', async () => {

		const { mod } = await fresh();
		h.transforms = [ { id: 1, name: 'AgX' }, { id: 2, name: 'Filmic' } ];
		const store = mod.useViewTransforms();

		const first = store.getSnapshot();
		expect( first ).toEqual( h.transforms );
		h.transforms = h.transforms.map( t => ( { ...t } ) );
		expect( store.getSnapshot() ).toBe( first );
		expect( store.getServerSnapshot() ).toBe( first );

		h.transforms = [ { id: 1, name: 'AgX' }, { id: 2, name: 'Filmic Log' } ];
		expect( store.getSnapshot() ).toEqual( h.transforms );
		expect( store.getSnapshot() ).not.toBe( first );

	} );

	it( 'subscribes to the registry', () => {

		expect( useViewTransforms().subscribe ).toBe( onRegistryChange );

	} );

	it( 'follows the engine\'s colour status through its change event', () => {

		const unsubscribe = () => {};

		h.setState = vi.fn();
		cm.on.mockReturnValue( unsubscribe );
		cm.status.mockReturnValue( { config: 'a' } );

		expect( useColorStatus() ).toEqual( { config: 'a' } );

		expect( h.effect() ).toBe( unsubscribe );
		expect( h.setState ).toHaveBeenLastCalledWith( { config: 'a' } );
		expect( cm.on ).toHaveBeenCalledWith( 'change', expect.any( Function ) );

		cm.status.mockReturnValue( { config: 'b' } );
		cm.on.mock.calls[ 0 ][ 1 ]();
		expect( h.setState ).toHaveBeenLastCalledWith( { config: 'b' } );

	} );

	it( 'has no status before the engine exists', () => {

		h.setState = vi.fn();
		h.app = null;

		expect( useColorStatus() ).toBeNull();
		expect( h.effect() ).toBeUndefined();
		expect( h.setState ).toHaveBeenCalledWith( null );

	} );

} );
