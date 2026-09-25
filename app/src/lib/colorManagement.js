/**
 * The app's side of colour management.
 *
 * The engine deliberately never names the OpenColorIO package — it is ~6 MB of WebAssembly and no
 * host should pay for it unless it loads a config. Naming it is therefore this file's job, and it
 * is imported lazily, so the cost lands the first time someone actually opens a config and never
 * before.
 */

import { configureAssets, getActiveColorManagement, onRegistryChange, listViewTransforms } from 'rayzee';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getApp } from '@/lib/appProxy';
import { useActiveApp } from '@/hooks/useActiveApp';
import { ASSETS_BASE_URL } from '@/Constants';

let configured = false;

function ensureConfigured() {

	if ( configured ) return;
	configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );
	configured = true;

}

/** The engine's colour management, or null before the app has started. */
export function colorManagement() {

	return getActiveColorManagement();

}

/** The OCIO module's own configs — ACES, and nothing to download. */
export async function builtinConfigs() {

	ensureConfigured();
	const { ColorManagement } = await import( 'rayzee' );
	return await ColorManagement.listBuiltinConfigs();

}

/**
 * Load a config by name from the ones built into the runtime.
 * @param {string} name - e.g. `ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5`
 */
export async function loadBuiltinConfig( name, options = {} ) {

	ensureConfigured();
	return await currentApp().loadColorConfig( { builtin: name, ...options } );

}

/**
 * The config the app starts in: Blender's own, so the menus read the way artists know them (AgX,
 * Filmic, Standard; Punchy, High Contrast). Its files are GPL-3.0, so they live on the
 * asset CDN beside a `manifest.json`, never inside the MIT app or engine. `VITE_COLOR_CONFIG_URL`
 * points a dev build at another copy.
 */
export const DEFAULT_COLOR_CONFIG = Object.freeze( {
	id: 'blender-5.1',
	label: 'Blender',
	description: 'Blender 5.1 — AgX, Filmic and their looks',
	baseUrl: import.meta.env?.VITE_COLOR_CONFIG_URL ?? `${ASSETS_BASE_URL}/ocio/blender-5.1/`,
	view: Object.freeze( { display: 'sRGB', view: 'AgX', look: 'AgX - Medium High Contrast' } ),
} );

async function fetchOk( url ) {

	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `${url}: HTTP ${response.status}` );
	return response;

}

/**
 * Fetch and load the default config, then select its default view.
 * @returns {Promise<{ config: Object, view: Object }>} the described config and the active view entry
 */
export async function loadDefaultConfig() {

	ensureConfigured();
	const { baseUrl, id, view } = DEFAULT_COLOR_CONFIG;
	const manifest = await ( await fetchOk( `${baseUrl}manifest.json` ) ).json();
	const files = await Promise.all( manifest.files.map( async relativePath => ( {
		relativePath,
		data: new Uint8Array( await ( await fetchOk( baseUrl + relativePath ) ).arrayBuffer() ),
	} ) ) );

	const config = await currentApp().loadColorConfig( { files, configPath: manifest.config, id, registerViews: false } );
	return { config, view: colorManagement().setView( view ) };

}

/** Unload the config, reverting a working space first so the environment is not left converted. */
export async function unloadConfig() {

	await currentApp().unloadColorConfig();

}

function currentApp() {

	const app = getApp();
	if ( ! app ) throw new Error( 'no app running' );
	return app;

}

/**
 * Load a config the user dropped in.
 *
 * A `.ocio` file on its own is rarely enough — almost every real config references LUTs beside it,
 * and mounting the `.ocio` without them fails at the first one. So this takes the whole selection
 * and keeps each file's path relative to the config's own directory.
 *
 * @param {FileList|File[]} files - a directory selection, or a single self-contained .ocio
 */
export async function loadConfigFromFiles( files, options = {} ) {

	ensureConfigured();

	const list = [ ...files ];
	const configFile = list.find( f => f.name.endsWith( '.ocio' ) );
	if ( ! configFile ) throw new Error( 'no .ocio file in the selection' );

	const relative = f => ( f.webkitRelativePath || f.name );
	const configPath = relative( configFile );
	const root = configPath.includes( '/' ) ? configPath.slice( 0, configPath.lastIndexOf( '/' ) + 1 ) : '';

	const packaged = await Promise.all( list.map( async f => ( {
		relativePath: relative( f ).startsWith( root ) ? relative( f ).slice( root.length ) : relative( f ),
		data: new Uint8Array( await f.arrayBuffer() ),
	} ) ) );

	return await currentApp().loadColorConfig( {
		files: packaged,
		configPath: configPath.slice( root.length ),
		// Named after its folder: nearly every config file is called config.ocio.
		id: root.replace( /\/$/, '' ).split( '/' ).pop() || configFile.name.replace( /\.ocio$/i, '' ),
		...options,
	} );

}

/** Every registered view transform, re-read whenever one is added or removed. */
export function useViewTransforms() {

	return useSyncExternalStore(
		onRegistryChange,
		// A new array each time would loop; the registry's version is the stable identity.
		() => cachedTransforms(),
		() => cachedTransforms()
	);

}

let cache = null;
let cacheKey = '';
function cachedTransforms() {

	const list = listViewTransforms();
	const key = list.map( t => `${t.id}:${t.name}` ).join( '|' );
	if ( key !== cacheKey ) {

		cacheKey = key;
		cache = list;

	}

	return cache;

}

/**
 * The colour-management snapshot a panel renders from, kept in step with the engine.
 *
 * Reads through the engine's own `change` event rather than mirroring state into the store: the
 * config, the working space and the active view are engine state, and a second copy of them is a
 * second thing to get out of date.
 */
export function useColorStatus() {

	// Keyed on the app, not run once: the panel can mount before the engine exists, and the app is
	// recreated for a new canvas. Subscribing once left the panel frozen on a disposed instance.
	const app = useActiveApp();
	const cm = app?.color ?? null;
	const [ status, setStatus ] = useState( () => cm?.status() ?? null );

	useEffect( () => {

		if ( ! cm ) {

			setStatus( null );
			return;

		}

		setStatus( cm.status() );
		return cm.on( 'change', () => setStatus( cm.status() ) );

	}, [ cm ] );

	return status;

}

/**
 * Save the finished render as an OpenEXR file, in the chosen delivery space.
 *
 * This is what "Export As" means. A PNG is a picture — display-referred bytes through the view
 * transform — and a delivery space cannot change it. An EXR is scene-referred float, which is the
 * one place a colour space like ACES2065-1 is the answer rather than a category error.
 *
 * Taken from what the viewport shows — denoised when a denoiser has run — but without bloom, which a
 * compositor adds back itself. Exposure is not applied: it is part of how the image is viewed, not of
 * the light in it.
 *
 * @param {?string} space - a config colour space, or null for the working space as-is
 * @returns {Promise<{ colorSpace: string, width: number, height: number, bytes: number }>}
 */
export async function saveEXR( space = null ) {

	const { bytes, colorSpace, width, height } = await encodeEXR( space );

	const safe = String( colorSpace ).replace( /[^a-z0-9.+-]+/gi, '_' );
	const url = URL.createObjectURL( new Blob( [ bytes ], { type: 'image/x-exr' } ) );
	const link = document.createElement( 'a' );
	link.href = url;
	link.download = `render-${safe}-${Date.now()}.exr`;
	link.click();
	setTimeout( () => URL.revokeObjectURL( url ), 1000 );

	return { colorSpace, width, height, bytes: bytes.byteLength };

}

/** The EXR `saveEXR` writes, without downloading it. */
export async function encodeEXR( space = null ) {

	const app = currentApp();

	const [ { DataTexture, RGBAFormat, FloatType, HalfFloatType }, { EXRExporter } ] = await Promise.all( [
		import( 'three' ),
		import( 'three/examples/jsm/exporters/EXRExporter.js' ),
	] );

	const { data, width, height, colorSpace, workingSpace } = await app.renderToBuffer( { colorSpace: space ?? 'linear', source: 'display' } );

	// The readback is top row first; the exporter writes row y to scanline height-1-y, which is right
	// for a GL-style bottom-up buffer and upside down for this one.
	const flipped = new Float32Array( data.length );
	const row = width * 4;
	for ( let y = 0; y < height; y ++ ) flipped.set( data.subarray( y * row, ( y + 1 ) * row ), ( height - 1 - y ) * row );

	const texture = new DataTexture( flipped, width, height, RGBAFormat, FloatType );
	const bytes = await new EXRExporter().parse( texture, { type: HalfFloatType } );
	texture.dispose();

	return { bytes, colorSpace: space ?? workingSpace ?? colorSpace, width, height, source: data };

}
