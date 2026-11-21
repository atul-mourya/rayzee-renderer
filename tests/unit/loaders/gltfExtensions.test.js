import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

const gltf = ( extensionsUsed ) => JSON.stringify( { asset: { version: '2.0' }, extensionsUsed, scenes: [ { nodes: [] } ], scene: 0 } );

async function report( extensionsUsed ) {

	const loader = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), saveState() {}, update() {} } );
	loader._issues = new IssueLog();
	const parser = await loader.createGLTFLoader();
	const data = await parser.parseAsync( gltf( extensionsUsed ), '' );
	loader._reportGLTFExtensions( data, 'scene.gltf' );
	loader._disposeGLTFLoader( parser );
	return loader._issues.list.filter( ( issue ) => issue.code === ISSUE_CODES.ASSET_PARAMETERS_IGNORED );

}

describe( 'glTF extensions nothing reads', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );
		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

	} );
	afterAll( () => vi.restoreAllMocks() );

	it( 'are reported once, as pbrt\'s and USD\'s ignored parameters are; read and metadata-only ones are not', async () => {

		const [ issue, ...more ] = await report( [ 'KHR_materials_variants', 'KHR_materials_emissive_strength', 'KHR_animation_pointer', 'KHR_materials_diffuse_transmission', 'KHR_xmp_json_ld', 'EXT_lights_image_based' ] );
		expect( more ).toHaveLength( 0 );
		expect( issue.detail ).toEqual( { entry: 'scene.gltf', unused: { KHR_materials_variants: 1, EXT_lights_image_based: 1 }, approximated: {} } );
		expect( issue.message ).toMatch( /2 glTF extension\(s\) not read in "scene\.gltf": KHR_materials_variants, EXT_lights_image_based/ );
		expect( await report( [ 'KHR_materials_emissive_strength' ] ) ).toHaveLength( 0 );
		expect( await report( undefined ) ).toHaveLength( 0 );

	} );

} );
