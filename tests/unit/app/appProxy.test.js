import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to re-import fresh module for each test to reset internal state
let getApp, setApp, subscribeApp;

beforeEach( async () => {

	// Reset module to clear internal _app and _listeners
	vi.resetModules();
	const mod = await import( '@/lib/appProxy.js' );
	getApp = mod.getApp;
	setApp = mod.setApp;
	subscribeApp = mod.subscribeApp;

} );

describe( 'appProxy', () => {

	it( 'getApp returns null initially', () => {

		expect( getApp() ).toBeNull();

	} );

	it( 'getApp returns null when app is not initialized', () => {

		setApp( { someMethod: () => {} } ); // no isInitialized flag
		expect( getApp() ).toBeNull();

	} );

	it( 'getApp returns app when isInitialized is true', () => {

		const app = { isInitialized: true };
		setApp( app );
		expect( getApp() ).toBe( app );

	} );

	it( 'subscribeApp is called on setApp', () => {

		const listener = vi.fn();
		subscribeApp( listener );
		const app = { isInitialized: true };
		setApp( app );
		expect( listener ).toHaveBeenCalledWith( app );

	} );

	it( 'subscribeApp returns unsubscribe function', () => {

		const listener = vi.fn();
		const unsub = subscribeApp( listener );
		unsub();
		setApp( { isInitialized: true } );
		expect( listener ).not.toHaveBeenCalled();

	} );

	it( 'multiple subscribers all notified', () => {

		const a = vi.fn();
		const b = vi.fn();
		subscribeApp( a );
		subscribeApp( b );
		setApp( { isInitialized: true } );
		expect( a ).toHaveBeenCalledTimes( 1 );
		expect( b ).toHaveBeenCalledTimes( 1 );

	} );

} );
