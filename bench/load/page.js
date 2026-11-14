/**
 * One side of `bench:load` in a browser: a headless engine with on-disk storage, driven by the runner through
 * `globalThis.__load`. Files arrive through the page's file input, disk-backed, as the browser's driver sets them.
 */

import { configureAssets, openHeadless } from 'rayzee';
import { measureLoad } from './measure.js';

let app = null;

// For a driver that sees neither the page's console nor its requests (safaridriver).
const tail = [];
let last = null;
let repeats = 0;
const keep = ( line ) => {

	if ( line === last ) return ( tail[ tail.length - 1 ] = `${line} (×${++ repeats + 1})` );
	last = line;
	repeats = 0;
	if ( tail.push( line ) > 200 ) tail.shift();

};

for ( const level of [ 'log', 'info', 'warn', 'error', 'debug' ] ) {

	const own = console[ level ];
	console[ level ] = ( ...args ) => {

		// Drops `%c` and the styles it takes.
		const styles = typeof args[ 0 ] === 'string' ? args[ 0 ].split( '%c' ).length - 1 : 0;
		const text = styles ? [ args[ 0 ].replaceAll( '%c', '' ), ...args.slice( 1 + styles ) ] : args;
		keep( `${level}: ${text.map( String ).join( ' ' )}` );
		own.apply( console, args );

	};

}

addEventListener( 'error', ( event ) => keep( `pageerror: ${event.message}` ) );
addEventListener( 'unhandledrejection', ( event ) => keep( `pageerror: ${event.reason?.stack ?? event.reason}` ) );

const foreign = [];
new PerformanceObserver( ( list ) => {

	for ( const { name } of list.getEntries() ) if ( ! name.startsWith( `${location.origin}/` ) && ! /^(data|blob):/.test( name ) ) foreign.push( name );

} ).observe( { type: 'resource', buffered: true } );

// A window the browser counts as hidden has its timers throttled, and with them every load step.
const hidden = { ms: 0, since: null };
document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) hidden.since ??= performance.now();
	else if ( hidden.since !== null ) {

		hidden.ms += performance.now() - hidden.since;
		hidden.since = null;

	}

} );

// Writes to the cache areas since the load began: started, and still open.
const writes = { started: 0, open: new Set() };

function trackWrites( storage ) {

	for ( const name of storage.areaNames ) {

		const area = storage.area( name );
		if ( area.kind !== 'cache' ) continue;
		const create = area.create;
		area.create = function ( ...args ) {

			writes.started ++;
			let done;
			const open = new Promise( ( resolve ) => ( done = resolve ) );
			writes.open.add( open );
			open.then( () => writes.open.delete( open ) );
			return create.apply( this, args ).then( ( writer ) => {

				if ( ! writer ) return done();
				for ( const method of [ 'commit', 'abort' ] ) {

					const own = writer[ method ];
					writer[ method ] = ( ...a ) => own.apply( writer, a ).finally( done );

				}

				return writer;

			}, ( error ) => {

				done();
				throw error;

			} );

		};

	}

}

async function clearCaches() {

	for ( const name of app.storage?.areaNames ?? [] ) {

		const area = app.storage.area( name );
		if ( area.kind === 'cache' ) await area.clear();

	}

}

function openInput( model ) {

	const files = [ ...document.getElementById( 'files' ).files ];
	if ( ! model.folder ) return files[ 0 ];
	const { name, paths } = model.folder;
	paths.forEach( ( p, i ) => {

		if ( files[ i ]?.name !== p.slice( p.lastIndexOf( '/' ) + 1 ) ) throw new Error( `file input out of order at ${p}` );

	} );
	return { name, files: paths.map( ( p, i ) => ( { path: p, file: files[ i ] } ) ) };

}

const runtime = {
	openInput,
	// A browser decodes images as the textures pack (inside `textures`) and in the pbrt build, with no one call to time.
	decodeBusy: () => ( { ms: undefined, calls: null } ),
	resetDecode: () => {},
	// The runner samples the browser's processes from outside.
	startSampling: () => {},
	stopSampling: () => ( {} ),
	collect: () => globalThis.gc?.(),
	async settle( timeoutMs = 120_000 ) {

		await app._sdf?._blasStoring;
		const deadline = performance.now() + timeoutMs;
		while ( writes.open.size ) {

			if ( performance.now() > deadline ) throw new Error( `${writes.open.size} storage write(s) still open after ${timeoutMs / 1000} s` );
			await Promise.race( [ Promise.all( writes.open ), new Promise( ( resolve ) => setTimeout( resolve, 1000 ) ) ] );

		}

		return writes.started > 0;

	},
};

globalThis.__load = {

	async start( { width, height, hostMemoryGB } ) {

		configureAssets( { dracoDecoderPath: '/three/examples/jsm/libs/draco/', ktx2TranscoderPath: '/three/examples/jsm/libs/basis/', oidnWeightsBaseUrl: '/oidn/' } );
		app = await openHeadless( { width, height, strict: false, deterministic: true, hostMemoryGB, storage: 'auto' } );
		if ( app.storage ) trackWrites( app.storage );
		await app.denoisingManager?.denoiser?.whenLoaded?.();
		return {
			startupIssues: app.issues.map( ( { code, severity } ) => ( { code, severity } ) ),
			adapter: app.adapterInfo?.description || app.adapterInfo?.vendor || 'unknown',
			storage: !! app.storage,
			crossOriginIsolated: globalThis.crossOriginIsolated,
		};

	},

	/** `model.reopen` keeps what earlier loads stored; otherwise the caches are emptied first, as for a first open. */
	async load( model ) {

		if ( ! model.reopen ) await clearCaches();
		writes.started = 0;
		hidden.ms = 0;
		hidden.since = document.hidden ? performance.now() : null;
		const result = await measureLoad( app, model, runtime );
		result.hiddenMs = hidden.ms + ( hidden.since === null ? 0 : performance.now() - hidden.since );
		return result;

	},

	log: () => tail.splice( 0 ),
	network: () => foreign.splice( 0 ),

};
