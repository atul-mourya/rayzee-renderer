/**
 * One side of `bench:load` in Chrome: a headless engine with on-disk storage, driven by the runner through
 * `globalThis.__load`. Files arrive through the page's file input, disk-backed (DOM.setFileInputFiles).
 */

import { configureAssets, openHeadless } from 'rayzee';
import { measureLoad } from './measure.js';

let app = null;

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
	// Chrome decodes images as the textures pack (inside `textures`) and in the pbrt build, with no one call to time.
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
		return measureLoad( app, model, runtime );

	},

};
