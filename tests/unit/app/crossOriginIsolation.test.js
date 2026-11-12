import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const FIREFOX = ( v, android = false ) => `Mozilla/5.0 (${android ? 'Android 15; Mobile' : 'Macintosh; Intel Mac OS X 10.15'}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;

function worker( state ) {

	const listeners = [];
	return {
		state,
		addEventListener: ( _, listener ) => listeners.push( listener ),
		become( next ) {

			this.state = next;
			listeners.forEach( ( listener ) => listener() );

		},
	};

}

describe( 'crossOriginIsolate', () => {

	let page, store, registration;

	function stubPage( { isolated = false, secure = true, userAgent = CHROME, chromium = true, controller = null } = {} ) {

		store = new Map();
		registration = { installing: worker( 'installing' ), waiting: null, active: null };
		page = {
			window: { crossOriginIsolated: isolated, isSecureContext: secure },
			navigator: {
				userAgent,
				userAgentData: chromium ? { brands: [] } : undefined,
				serviceWorker: { controller, register: vi.fn( async () => registration ) },
			},
			location: { reload: vi.fn() },
		};
		vi.stubGlobal( 'window', page.window );
		vi.stubGlobal( 'navigator', page.navigator );
		vi.stubGlobal( 'location', page.location );
		vi.stubGlobal( 'sessionStorage', {
			getItem: ( k ) => store.get( k ) ?? null,
			setItem: ( k, v ) => store.set( k, v ),
			removeItem: ( k ) => store.delete( k ),
		} );

	}

	async function start() {

		const { crossOriginIsolate } = await import( '@/lib/crossOriginIsolation.js' );
		let resolved = false;
		crossOriginIsolate().then( () => ( resolved = true ) );
		for ( let i = 0; i < 5; i ++ ) await Promise.resolve();
		return () => resolved;

	}

	beforeEach( () => vi.resetModules() );
	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'reloads once the first time, after the worker is active, and holds the app back meanwhile', async () => {

		stubPage();
		const resolved = await start();
		expect( page.navigator.serviceWorker.register ).toHaveBeenCalledWith( 'isolation-sw.js' );
		expect( page.location.reload ).not.toHaveBeenCalled();

		registration.installing.become( 'activated' );
		await new Promise( ( r ) => setTimeout( r, 0 ) );
		expect( page.location.reload ).toHaveBeenCalledTimes( 1 );
		expect( resolved() ).toBe( false );

	} );

	it( 'starts at once when the page is already isolated, and clears the reload mark', async () => {

		stubPage( { isolated: true } );
		store.set( 'rayzee:isolation-reload', '1' );
		const resolved = await start();
		expect( resolved() ).toBe( true );
		expect( page.navigator.serviceWorker.register ).not.toHaveBeenCalled();
		expect( store.has( 'rayzee:isolation-reload' ) ).toBe( false );

	} );

	it( 'never reloads twice in a session, nor when the worker serves the page without isolating it', async () => {

		stubPage();
		store.set( 'rayzee:isolation-reload', '1' );
		expect( ( await start() )() ).toBe( true );

		vi.resetModules();
		stubPage( { controller: {} } );
		expect( ( await start() )() ).toBe( true );
		expect( page.location.reload ).not.toHaveBeenCalled();

	} );

	it( 'starts unisolated when the worker fails to install or register', async () => {

		stubPage();
		const resolved = await start();
		registration.installing.become( 'redundant' );
		await new Promise( ( r ) => setTimeout( r, 0 ) );
		expect( resolved() ).toBe( true );
		expect( page.location.reload ).not.toHaveBeenCalled();

		vi.resetModules();
		stubPage();
		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		page.navigator.serviceWorker.register.mockRejectedValue( new Error( '404' ) );
		const after = await start();
		await new Promise( ( r ) => setTimeout( r, 0 ) );
		expect( after() ).toBe( true );

	} );

	it( 'registers only where COEP credentialless works: Chromium and desktop Firefox 119+, on a secure page', async () => {

		const cases = [
			[ { userAgent: CHROME }, true ],
			[ { userAgent: FIREFOX( 119 ), chromium: false }, true ],
			[ { userAgent: FIREFOX( 118 ), chromium: false }, false ],
			[ { userAgent: FIREFOX( 140, true ), chromium: false }, false ],
			[ { userAgent: SAFARI, chromium: false }, false ],
			[ { userAgent: CHROME, secure: false }, false ],
		];
		for ( const [ options, registers ] of cases ) {

			vi.resetModules();
			stubPage( options );
			await start();
			expect( page.navigator.serviceWorker.register.mock.calls.length > 0, options.userAgent ).toBe( registers );

		}

	} );

} );

describe( 'isolation-sw.js', () => {

	let listeners;

	beforeEach( async () => {

		vi.resetModules();
		listeners = {};
		vi.stubGlobal( 'self', {
			location: { origin: 'https://example.github.io' },
			clients: { claim: vi.fn() },
			skipWaiting: vi.fn(),
			addEventListener: ( type, listener ) => ( listeners[ type ] = listener ),
		} );
		await import( '../../../app/public/isolation-sw.js' );

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	function dispatch( request ) {

		let responded = null;
		listeners.fetch( { request, respondWith: ( promise ) => ( responded = promise ) } );
		return responded;

	}

	const request = ( url, mode, destination = '' ) => ( { url, mode, destination, cache: 'default' } );

	it( 'adds COOP and COEP to the page and to same-origin worker scripts, keeping the rest of the response', async () => {

		vi.stubGlobal( 'fetch', vi.fn( async () => new Response( 'body', { status: 200, headers: { 'Content-Type': 'text/html' } } ) ) );
		for ( const r of [ request( 'https://example.github.io/RayTracing/', 'navigate', 'document' ),
			request( 'https://example.github.io/RayTracing/w.js', 'same-origin', 'worker' ) ] ) {

			const response = await dispatch( r );
			expect( response.headers.get( 'Cross-Origin-Opener-Policy' ) ).toBe( 'same-origin' );
			expect( response.headers.get( 'Cross-Origin-Embedder-Policy' ) ).toBe( 'credentialless' );
			expect( response.headers.get( 'Content-Type' ) ).toBe( 'text/html' );
			expect( await response.text() ).toBe( 'body' );

		}

	} );

	it( 'leaves every other request to the browser', () => {

		vi.stubGlobal( 'fetch', vi.fn() );
		expect( dispatch( request( 'https://example.github.io/RayTracing/assets/a.js', 'cors', 'script' ) ) ).toBe( null );
		expect( dispatch( request( 'https://cdn.example.com/model.glb', 'cors', '' ) ) ).toBe( null );
		expect( dispatch( request( 'https://other.example/w.js', 'cors', 'worker' ) ) ).toBe( null );
		expect( dispatch( { ...request( 'https://example.github.io/RayTracing/', 'no-cors', 'document' ), cache: 'only-if-cached' } ) ).toBe( null );
		expect( fetch ).not.toHaveBeenCalled();

	} );

	it( 'passes redirects and opaque responses through untouched', async () => {

		const redirect = { status: 0, type: 'opaqueredirect' };
		vi.stubGlobal( 'fetch', vi.fn( async () => redirect ) );
		expect( await dispatch( request( 'https://example.github.io/RayTracing', 'navigate', 'document' ) ) ).toBe( redirect );

	} );

} );
