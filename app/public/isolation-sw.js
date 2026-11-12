// Makes the app cross-origin isolated where the host cannot send the headers (GitHub Pages): it adds COOP and COEP
// to the page and to any same-origin worker script, so SharedArrayBuffer exists and the engine's workers share memory.
// Registered by src/lib/crossOriginIsolation.js. Every other request is left to the browser.

self.addEventListener( 'install', () => self.skipWaiting() );
self.addEventListener( 'activate', ( event ) => event.waitUntil( self.clients.claim() ) );

self.addEventListener( 'fetch', ( event ) => {

	const request = event.request;
	const page = request.mode === 'navigate';
	const worker = request.destination === 'worker' || request.destination === 'sharedworker';
	if ( ! page && ! worker ) return;
	if ( new URL( request.url ).origin !== self.location.origin ) return;
	// DevTools' own requests (chromium 823392) fail when fetched again.
	if ( request.cache === 'only-if-cached' && request.mode !== 'same-origin' ) return;

	event.respondWith( fetch( request ).then( isolated ) );

} );

function isolated( response ) {

	if ( response.status === 0 || response.type === 'opaqueredirect' ) return response;

	const headers = new Headers( response.headers );
	headers.set( 'Cross-Origin-Opener-Policy', 'same-origin' );
	headers.set( 'Cross-Origin-Embedder-Policy', 'credentialless' );
	return new Response( response.body, { status: response.status, statusText: response.statusText, headers } );

}
