import { describe, it, expect } from 'vitest';
import { extractSceneMetadata, parseSceneMetadata } from '../../../rayzee/src/Processor/SceneMetadata.js';

const PAYLOAD = {
	environment: {
		sourceFile: 'https://assets.rayzee.atulmourya.com/hdri/Polyhaven/raw/brown_photostudio_02_1k.hdr',
		rotation: 0,
		intensity: 1,
	},
};

describe( 'parseSceneMetadata', () => {

	it( 'reads the documented payload', () => {

		expect( parseSceneMetadata( PAYLOAD ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a JSON string container', () => {

		expect( parseSceneMetadata( JSON.stringify( PAYLOAD ) ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a stringified environment sub-object', () => {

		const stringified = { environment: JSON.stringify( PAYLOAD.environment ) };
		expect( parseSceneMetadata( stringified ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a rayzee-namespaced payload', () => {

		expect( parseSceneMetadata( { rayzee: PAYLOAD } ) ).toEqual( PAYLOAD );

	} );

	it( 'omits rotation and intensity when absent or non-numeric', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: 'nope' } } );
		expect( metadata ).toEqual( { environment: { sourceFile: 'a.hdr' } } );

	} );

	it( 'parses numeric strings and clamps negative intensity to zero', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: '90', intensity: '-2' } } );
		expect( metadata.environment ).toEqual( { sourceFile: 'a.hdr', rotation: 90, intensity: 0 } );

	} );

	it( 'keeps rotation 0 and intensity 0 rather than treating them as missing', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: 0, intensity: 0 } } );
		expect( metadata.environment ).toEqual( { sourceFile: 'a.hdr', rotation: 0, intensity: 0 } );

	} );

	it( 'rejects containers with no usable environment url', () => {

		expect( parseSceneMetadata( { environment: {} } ) ).toBeNull();
		expect( parseSceneMetadata( { environment: { sourceFile: '   ' } } ) ).toBeNull();
		expect( parseSceneMetadata( { title: 'unrelated extras' } ) ).toBeNull();
		expect( parseSceneMetadata( 'not json' ) ).toBeNull();
		expect( parseSceneMetadata( null ) ).toBeNull();

	} );

} );

describe( 'extractSceneMetadata', () => {

	it( 'reads top-level glTF extras (gltf.userData)', () => {

		expect( extractSceneMetadata( { userData: PAYLOAD } ) ).toEqual( PAYLOAD );

	} );

	it( 'reads asset.extras', () => {

		expect( extractSceneMetadata( { userData: {}, asset: { extras: PAYLOAD } } ) ).toEqual( PAYLOAD );

	} );

	it( 'reads the active scene extras (scene.userData)', () => {

		expect( extractSceneMetadata( { userData: {}, scene: { userData: PAYLOAD } } ) ).toEqual( PAYLOAD );

	} );

	it( 'falls back to a non-active scene', () => {

		const gltf = { userData: {}, scene: { userData: {} }, scenes: [ { userData: {} }, { userData: PAYLOAD } ] };
		expect( extractSceneMetadata( gltf ) ).toEqual( PAYLOAD );

	} );

	it( 'returns null for a model with no metadata', () => {

		expect( extractSceneMetadata( { userData: {}, asset: { version: '2.0' }, scene: { userData: {} } } ) ).toBeNull();
		expect( extractSceneMetadata( null ) ).toBeNull();

	} );

} );
