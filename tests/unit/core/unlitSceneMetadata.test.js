import { describe, it, expect } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';

// A pbrt scene without an infinite light has no environment; the next model gets back what it replaced.
describe( 'PathTracerApp — a scene with no environment', () => {

	function app( settings = new RenderSettings() ) {

		const events = [];
		const receiver = Object.assign( Object.create( PathTracerApp.prototype ), {
			settings, _applySceneMetadataEnabled: true, _unlitRestore: null, stages: {},
			assetLoader: { sceneMetadata: null }, dispatchEvent: ( e ) => events.push( e ),
		} );
		const load = ( metadata ) => {

			receiver.assetLoader.sceneMetadata = metadata;
			return receiver._beginSceneMetadataEnvironment();

		};

		return { receiver, events, load, settings };

	}

	it( 'turns the environment off and restores it on the next load', () => {

		const { settings, events, load } = app();
		expect( load( { environment: { enabled: false } } ) ).toBeNull();
		expect( settings.get( 'enableEnvironment' ) ).toBe( false );
		expect( settings.get( 'showBackground' ) ).toBe( false );
		expect( settings.getEffective().enableEnvironment.source ).toBe( SETTING_SOURCE.SCENE_METADATA );
		expect( events.at( - 1 ).environment ).toEqual( { enabled: false } );

		load( null );
		expect( settings.get( 'enableEnvironment' ) ).toBe( true );
		expect( settings.get( 'showBackground' ) ).toBe( true );
		expect( settings.getEffective().enableEnvironment.source ).toBe( SETTING_SOURCE.DEFAULT );
		expect( events.at( - 1 ).environment ).toEqual( { enabled: true } );

	} );

	it( 'is not turned back on by the HDRI already installed', () => {

		const { receiver, settings, load } = app();
		load( { environment: { enabled: false } } );
		receiver._applySceneMetadataSettings( {} );
		expect( settings.get( 'enableEnvironment' ) ).toBe( false );

	} );

	it( 'keeps what the user changed meanwhile, and a host value it replaced', () => {

		const { settings, load } = app();
		settings.set( 'showBackground', false );
		load( { environment: { enabled: false } } );
		settings.set( 'enableEnvironment', true );
		load( null );
		expect( settings.get( 'enableEnvironment' ) ).toBe( true );
		expect( settings.getEffective().enableEnvironment.source ).toBe( SETTING_SOURCE.HOST );
		expect( settings.get( 'showBackground' ) ).toBe( false );
		expect( settings.getEffective().showBackground.source ).toBe( SETTING_SOURCE.HOST );

	} );

	it( 'restores what came before a run of scenes without one', () => {

		const { settings, load } = app();
		load( { environment: { enabled: false } } );
		load( { environment: { enabled: false } } );
		expect( settings.get( 'enableEnvironment' ) ).toBe( false );
		load( null );
		expect( settings.get( 'enableEnvironment' ) ).toBe( true );

	} );

} );
