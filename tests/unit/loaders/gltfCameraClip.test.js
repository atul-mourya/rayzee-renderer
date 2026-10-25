import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { cameraClipPlugin } from '@/core/loaders/AssetLoader.js';

// glTF's znear is the near clipping plane, and Blender writes a camera's clip start there.
const gltf = JSON.stringify( {
	asset: { version: '2.0' },
	cameras: [
		{ type: 'perspective', perspective: { yfov: 0.8, znear: 1.1, zfar: 100 } },
		{ type: 'orthographic', orthographic: { xmag: 2, ymag: 1, znear: 0, zfar: 50 } },
	],
	nodes: [ { camera: 0, translation: [ 0, 1, 5 ] }, { camera: 1 } ],
	scenes: [ { nodes: [ 0, 1 ] } ],
	scene: 0,
} );

describe( 'glTF camera clip start', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	it( 'takes a camera\'s znear as its clip start, and gives none for a znear of 0', async () => {

		const result = await new GLTFLoader().register( () => cameraClipPlugin ).parseAsync( gltf, '' );
		const cameras = [];
		result.scene.traverse( object => object.isCamera && cameras.push( object ) );
		expect( cameras.map( camera => camera.userData.clipStart ) ).toEqual( [ 1.1, undefined ] );

	} );

} );
