// The engine's workers share memory (parallel BVH builds, texture packing, pbrt bakes) only in a cross-origin isolated
// page. Where the host does not send COOP/COEP (GitHub Pages), public/isolation-sw.js adds them: the first visit
// installs it and reloads once, later visits are isolated from the start. Off where COEP `credentialless` is not
// supported (Safari, Firefox for Android): `require-corp` would block the catalogues' cross-origin images.

const RELOADED = 'rayzee:isolation-reload';

// Chromium (every version with WebGPU has it) and desktop Firefox 119+. No feature test exists for a COEP value.
function supportsCredentiallessCOEP() {

	if ( navigator.userAgentData ) return true;
	const firefox = /Firefox\/(\d+)/.exec( navigator.userAgent );
	return firefox !== null && Number( firefox[ 1 ] ) >= 119 && ! /Android/.test( navigator.userAgent );

}

function activated( registration ) {

	return new Promise( ( resolve ) => {

		const worker = registration.installing || registration.waiting || registration.active;
		if ( ! worker ) return resolve( false );
		const check = () => {

			if ( worker.state === 'activated' ) resolve( true );
			else if ( worker.state === 'redundant' ) resolve( false );

		};

		worker.addEventListener( 'statechange', check );
		check();

	} );

}

/**
 * Resolves once the app may start: at once when the page is isolated or cannot be, never when it reloads to be.
 * @returns {Promise<void>}
 */
export async function crossOriginIsolate() {

	try {

		if ( window.crossOriginIsolated ) {

			sessionStorage.removeItem( RELOADED );
			return;

		}

		if ( ! window.isSecureContext || ! ( 'serviceWorker' in navigator ) || ! supportsCredentiallessCOEP() ) return;

		const registration = await navigator.serviceWorker.register( 'isolation-sw.js' );
		// Served by the worker and still not isolated: the headers did not take, so reloading would not help.
		if ( navigator.serviceWorker.controller || sessionStorage.getItem( RELOADED ) ) return;
		if ( ! await activated( registration ) ) return;

		sessionStorage.setItem( RELOADED, '1' );
		location.reload();
		return new Promise( () => {} );

	} catch ( error ) {

		console.warn( 'Cross-origin isolation unavailable:', error );

	}

}
