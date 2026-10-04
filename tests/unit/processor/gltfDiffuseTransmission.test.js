import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { diffuseTransmissionPlugin, DIFFUSE_TRANSMISSION_EXTENSION } from '@/core/Processor/GLTFDiffuseTransmission.js';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';

// One triangle per material, the extension on the first, required by the file.
function gltf( extension ) {

	const positions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
	const uri = `data:application/octet-stream;base64,${Buffer.from( positions.buffer ).toString( 'base64' )}`;
	const primitive = ( material ) => ( { attributes: { POSITION: 0 }, material } );
	return JSON.stringify( {
		asset: { version: '2.0' },
		extensionsUsed: [ DIFFUSE_TRANSMISSION_EXTENSION ], extensionsRequired: [ DIFFUSE_TRANSMISSION_EXTENSION ],
		buffers: [ { byteLength: 36, uri } ],
		bufferViews: [ { buffer: 0, byteLength: 36 } ],
		accessors: [ { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] } ],
		materials: [ { name: 'leaf', extensions: { [ DIFFUSE_TRANSMISSION_EXTENSION ]: extension } }, { name: 'stone' } ],
		meshes: [ { primitives: [ primitive( 0 ) ] }, { primitives: [ primitive( 1 ) ] } ],
		nodes: [ { mesh: 0 }, { mesh: 1 } ],
		scenes: [ { nodes: [ 0, 1 ] } ],
		scene: 0,
	} );

}

async function load( extension ) {

	const loader = new GLTFLoader().register( ( parser ) => diffuseTransmissionPlugin( parser ) );
	const result = await loader.parseAsync( gltf( extension ), '' );
	const [ leaf, stone ] = result.scene.children.map( ( mesh ) => mesh.material );
	return { leaf, stone };

}

describe( 'KHR_materials_diffuse_transmission', () => {

	// three's FileLoader makes one per streamed chunk; Node has none (nodePlatform() defines it for hosts).
	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {

			constructor( type, init = {} ) {

				super( type );
				Object.assign( this, init );

			}

		} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	it( 'gives a material its factors and leaves the others alone', async () => {

		const { leaf, stone } = await load( { diffuseTransmissionFactor: 0.25, diffuseTransmissionColorFactor: [ 1, 0.9, 0.85 ] } );
		expect( leaf.diffuseTransmission ).toBe( 0.25 );
		expect( leaf.diffuseTransmissionColor.toArray() ).toEqual( [ 1, 0.9, 0.85 ] );
		expect( stone.diffuseTransmission ).toBeUndefined();

		// …and the engine reads them as material values, not defaults.
		const extracted = new GeometryExtractor().createMaterialObject( leaf );
		expect( extracted.diffuseTransmission ).toBe( 0.25 );
		expect( extracted.diffuseTransmissionColor.toArray() ).toEqual( [ 1, 0.9, 0.85 ] );

	} );

	it( 'defaults the colour to white', async () => {

		const { leaf } = await load( { diffuseTransmissionFactor: 1 } );
		expect( leaf.diffuseTransmissionColor.toArray() ).toEqual( [ 1, 1, 1 ] );

	} );

	it( 'loads both textures through the parser, the colour one as sRGB', async () => {

		// GLTFLoader decodes images with the DOM, so the parser is a stand-in here: assignTexture is its own API.
		const material = { name: 'leaf' };
		const assigned = [];
		const parser = {
			json: { materials: [ { extensions: { [ DIFFUSE_TRANSMISSION_EXTENSION ]: {
				diffuseTransmissionFactor: 1, diffuseTransmissionTexture: { index: 0 }, diffuseTransmissionColorTexture: { index: 1 },
			} } } ] },
			associations: new Map( [[ material, { materials: 0 } ]] ),
			assignTexture: async ( params, key, info, colorSpace ) => {

				assigned.push( [ key, info.index, colorSpace ] );
				params[ key ] = { isTexture: true, index: info.index };

			},
		};
		const scene = { traverse: ( visit ) => visit( { material } ) };
		await diffuseTransmissionPlugin( parser ).afterRoot( { scenes: [ scene ] } );

		expect( assigned ).toEqual( [[ 'diffuseTransmissionMap', 0, undefined ], [ 'diffuseTransmissionColorMap', 1, 'srgb' ]] );
		expect( material.diffuseTransmissionMap.index ).toBe( 0 );
		expect( material.diffuseTransmissionColorMap.index ).toBe( 1 );

	} );

} );
