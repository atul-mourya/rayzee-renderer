import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock( '@/lib/appProxy.js', () => {

	let _app = null;
	return {
		getApp: () => _app,
		setApp: a => {

			_app = a;

		},
		subscribeApp: vi.fn( () => () => {} ),
		__setMockApp: a => {

			_app = a;

		},
	};

} );

let store, setMaterialProperty, material;

beforeEach( async () => {

	store = await import( '@/store.js' );
	setMaterialProperty = vi.fn();
	const proxy = await import( '@/lib/appProxy.js' );
	proxy.__setMockApp( { setMaterialProperty, reset: vi.fn() } );

	material = { transparent: false, opacity: 1, alphaTest: 0, alphaMode: 0, map: null };
	store.useStore.setState( {
		selectedObject: { isMesh: true, material, userData: { materialIndex: 0 } },
	} );

} );

/** Last value written for a given material property, or undefined. */
const written = prop => setMaterialProperty.mock.calls.filter( c => c[ 1 ] === prop ).at( - 1 )?.[ 2 ];

describe( 'alphaMode stays consistent with the alpha controls', () => {

	// alphaMode is the ONLY field the camera path reads (MaterialTransmission.js:451 takes the
	// opaque fast path on alphaMode 0, and the MASK branch is gated on alphaMode 1). A control
	// that changes alpha behaviour without moving alphaMode is therefore inert.

	it( 'Alpha Test drives alphaMode to MASK', () => {

		store.useMaterialStore.getState().handleAlphaTestChange( [ 0.5 ] );

		expect( written( 'alphaTest' ) ).toBe( 0.5 );
		expect( written( 'alphaMode' ) ).toBe( 1 );

	} );

	it( 'clearing Alpha Test returns alphaMode to OPAQUE', () => {

		store.useMaterialStore.getState().handleAlphaTestChange( [ 0.5 ] );
		store.useMaterialStore.getState().handleAlphaTestChange( [ 0 ] );

		expect( written( 'alphaMode' ) ).toBe( 0 );

	} );

	it( 'Alpha Test takes priority over Transparent (glTF: MASK and BLEND are exclusive)', () => {

		material.transparent = true;
		material.opacity = 0.5;
		store.useMaterialStore.getState().handleAlphaTestChange( [ 0.5 ] );

		expect( written( 'alphaMode' ) ).toBe( 1 );

	} );

	it( 'Transparent still drives alphaMode to BLEND', () => {

		material.opacity = 0.5;
		store.useMaterialStore.getState().handleTransparentChange( true );

		expect( written( 'alphaMode' ) ).toBe( 2 );

	} );

} );
