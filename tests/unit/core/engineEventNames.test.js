import { describe, it, expect, vi, afterEach } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { EngineEvents, LEGACY_EVENT_NAMES } from '@/core/EngineEvents.js';

// The dispatcher half of the app is all these need; the constructor needs a GPU.
const bareApp = () => Object.create( PathTracerApp.prototype );

describe( 'engine event names', () => {

	afterEach( () => vi.restoreAllMocks() );

	it( 'names every legacy alias after a distinct EngineEvents value', () => {

		const values = new Set( Object.values( EngineEvents ) );
		for ( const key of Object.keys( LEGACY_EVENT_NAMES ) ) expect( values.has( key ) ).toBe( true );
		expect( new Set( Object.values( LEGACY_EVENT_NAMES ) ).size ).toBe( Object.keys( LEGACY_EVENT_NAMES ).length );

	} );

	it( 'still reaches a listener on the old name, with the payload', () => {

		const app = bareApp();
		const modern = vi.fn(), legacy = vi.fn();
		app.addEventListener( EngineEvents.MODEL_LOADED, modern );
		app.addEventListener( 'ModelLoaded', legacy );

		app.dispatchEvent( { type: EngineEvents.MODEL_LOADED, url: 'a.glb' } );

		expect( modern ).toHaveBeenCalledOnce();
		expect( legacy ).toHaveBeenCalledOnce();
		expect( legacy.mock.calls[ 0 ][ 0 ] ).toMatchObject( { type: 'ModelLoaded', url: 'a.glb' } );

	} );

	it( 'dispatches an event with no legacy name once', () => {

		const app = bareApp();
		const listener = vi.fn();
		app.addEventListener( EngineEvents.FRAME, listener );
		app.dispatchEvent( { type: EngineEvents.FRAME } );

		expect( listener ).toHaveBeenCalledOnce();

	} );

	it( 'warns once for a name nothing dispatches', () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const app = bareApp();
		app.addEventListener( 'SceneMetadataAplied', () => {} );
		app.addEventListener( 'SceneMetadataAplied', () => {} );

		const hits = warn.mock.calls.filter( ( args ) => args.join( ' ' ).includes( 'SceneMetadataAplied' ) );
		expect( hits ).toHaveLength( 1 );

	} );

	it( 'is quiet for known names, old and new', () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const app = bareApp();
		app.addEventListener( EngineEvents.RENDER_COMPLETE, () => {} );
		app.addEventListener( 'RenderComplete', () => {} );
		app.addEventListener( 'SceneMetadataApplied', () => {} );

		expect( warn ).not.toHaveBeenCalled();

	} );

} );
