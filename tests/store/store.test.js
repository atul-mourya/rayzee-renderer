import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub browser APIs that Zustand/store.js may reference. localStorage is required: without
// it the store import throws and the `catch { store = null }` below silently skips every test.
globalThis.window = globalThis.window || {};
const _ls = new Map();
globalThis.localStorage = globalThis.localStorage || {
	getItem: k => _ls.get( k ) ?? null,
	setItem: ( k, v ) => _ls.set( k, String( v ) ),
	removeItem: k => _ls.delete( k ),
	clear: () => _ls.clear(),
};
globalThis.window.localStorage = globalThis.localStorage;
globalThis.matchMedia = globalThis.matchMedia
	|| ( () => ( { matches: false, addEventListener() {}, removeEventListener() {} } ) );

// Mock appProxy before store imports it (top-level only)
vi.mock( '@/lib/appProxy.js', () => {

	let _app = null;
	return {
		getApp: () => _app,
		setApp: ( app ) => {

			_app = app;

		},
		subscribeApp: vi.fn( () => () => {} ),
		__setMockApp: ( app ) => {

			_app = app;

		},
	};

} );

// We'll dynamically import the store to avoid static import issues
let store;

beforeEach( async () => {

	try {

		store = await import( '@/store.js' );

	} catch ( error ) {

		// Loud on purpose: a silent null here turns every test in this file into a no-op.
		throw new Error( `store.js failed to import — tests would silently pass: ${error.message}` );

	}

} );

describe( 'Store', () => {

	it( 'module loads without error', () => {

		// If store imported, it should be an object with exports
		// If it failed, we skip
		if ( ! store ) {

			expect( true ).toBe( true ); // skip
			return;

		}

		expect( store ).toBeDefined();

	} );

} );

describe( 'bounce-loop settings unwrap the Slider array', () => {

	// PathTracer sums these three into loopBound. A raw [n] from Slider.onValueChange makes
	// that sum string-concatenate ( [20] + 5 + 8 === '2058' ), and the bounce loop then runs
	// to 2058 on any frame the survivor curve can't early-exit — which hangs the tab.
	const CASES = [
		[ 'handleBouncesChange', 'maxBounces', 20 ],
		[ 'handleTransmissiveBouncesChange', 'transmissiveBounces', 7 ],
		[ 'handleMaxSubsurfaceStepsChange', 'maxSubsurfaceSteps', 32 ],
	];

	for ( const [ handler, key, value ] of CASES ) {

		it( `${handler} forwards a number, not an array`, async () => {

			if ( ! store ) return;

			const set = vi.fn();
			const proxy = await import( '@/lib/appProxy.js' );
			proxy.__setMockApp( { settings: { set }, reset: vi.fn() } );

			store.usePathTracerStore.getState()[ handler ]( [ value ] );

			expect( set ).toHaveBeenCalledWith( key, value );
			const forwarded = set.mock.calls.at( - 1 )[ 1 ];
			expect( typeof forwarded ).toBe( 'number' );
			// The actual failure mode: a non-number turns the loopBound sum into a string.
			expect( typeof ( forwarded + 5 + 8 ) ).toBe( 'number' );

		} );

	}

} );
