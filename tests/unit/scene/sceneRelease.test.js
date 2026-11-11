/**
 * A replace load lets go of the scene's CPU data before it parses the new file: kept, a 40M-triangle scene and its
 * reload's geometry ran the tab out of memory. What the old scene drew stays on the GPU, so its textures stay.
 */
import { describe, it, expect, vi } from 'vitest';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';

function heldScene() {

	const sp = new SceneProcessor();
	sp.triangles = { records: 'triangle store' };
	sp.bvh = { records: 'tree' };
	sp.instanceTable = { blasBase: 1 };
	sp.meshes = [ 'mesh' ];
	sp.geometryExtractor.meshes = [ 'mesh' ];
	sp.geometryExtractor.materials = [ 'material' ];
	sp.srgbBucketTextures = [ { dispose: vi.fn() } ];
	return sp;

}

describe( 'SceneProcessor.releaseSceneData', () => {

	it( "drops the scene's CPU data and keeps the textures the stage binds", () => {

		const sp = heldScene();
		const [ texture ] = sp.srgbBucketTextures;
		const version = sp._geometryVersion ?? 0;

		sp.releaseSceneData();

		expect( sp.triangles ).toBeNull();
		expect( sp.bvh ).toBeNull();
		expect( sp.instanceTable ).toBeNull();
		expect( sp.meshes ).toEqual( [] );
		expect( sp.geometryExtractor.meshes ).toEqual( [] );
		expect( sp.geometryExtractor.materials ).toEqual( [] );
		expect( sp._geometryVersion ).toBe( version + 1 );
		expect( texture.dispose ).not.toHaveBeenCalled();

	} );

	it( 'leaves a build in progress alone', () => {

		const sp = heldScene();
		sp.isProcessing = true;
		sp.releaseSceneData();
		expect( sp.instanceTable ).toEqual( { blasBase: 1 } );
		expect( sp.meshes ).toEqual( [ 'mesh' ] );

	} );

} );
