/**
 * A glTF material property left out has the spec's default. Each material here is loaded twice — bare, and with every
 * property written at the default the glTF 2.0 spec or its extension gives — through three's GLTFLoader with the engine's
 * own plugins, and the material block the engine packs must be the same.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { diffuseTransmissionPlugin } from '@/core/loaders/GLTFDiffuseTransmission.js';
import { GeometryExtractor } from '@/core/scene/GeometryExtractor.js';
import { packMaterial } from '@/core/materials/MaterialPacking.js';
import { MATERIAL_DATA_LAYOUT } from '@/core/scene/BufferLayout.js';

// [ bare material, the same with the spec's defaults written out ]. A weight whose default is 0 is set on both, so what
// it gates is reached.
const CASES = {
	core: [ {}, { pbrMetallicRoughness: { baseColorFactor: [ 1, 1, 1, 1 ], metallicFactor: 1, roughnessFactor: 1 }, emissiveFactor: [ 0, 0, 0 ], alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false } ],
	'core, masked': [ { alphaMode: 'MASK' }, { alphaMode: 'MASK', alphaCutoff: 0.5 } ],
	KHR_materials_ior: [ { ior: {} }, { ior: { ior: 1.5 } } ],
	KHR_materials_specular: [ { specular: {} }, { specular: { specularFactor: 1, specularColorFactor: [ 1, 1, 1 ] } } ],
	KHR_materials_clearcoat: [ { clearcoat: { clearcoatFactor: 1 } }, { clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0 } } ],
	KHR_materials_sheen: [ { sheen: { sheenRoughnessFactor: 0.5 } }, { sheen: { sheenColorFactor: [ 0, 0, 0 ], sheenRoughnessFactor: 0.5 } } ],
	'KHR_materials_sheen, coloured': [ { sheen: { sheenColorFactor: [ 1, 1, 1 ] } }, { sheen: { sheenColorFactor: [ 1, 1, 1 ], sheenRoughnessFactor: 0 } } ],
	KHR_materials_transmission: [ { transmission: { transmissionFactor: 1 } }, { transmission: { transmissionFactor: 1 } } ],
	KHR_materials_volume: [ { transmission: { transmissionFactor: 1 }, volume: {} }, { transmission: { transmissionFactor: 1 }, volume: { thicknessFactor: 0, attenuationColor: [ 1, 1, 1 ] } } ],
	KHR_materials_iridescence: [ { iridescence: { iridescenceFactor: 1 } }, { iridescence: { iridescenceFactor: 1, iridescenceIor: 1.3, iridescenceThicknessMinimum: 100, iridescenceThicknessMaximum: 400 } } ],
	KHR_materials_anisotropy: [ { anisotropy: { anisotropyStrength: 0.5 } }, { anisotropy: { anisotropyStrength: 0.5, anisotropyRotation: 0 } } ],
	KHR_materials_emissive_strength: [ { emissiveFactor: [ 1, 1, 1 ], emissive_strength: {} }, { emissiveFactor: [ 1, 1, 1 ], emissive_strength: { emissiveStrength: 1 } } ],
	KHR_materials_dispersion: [ { transmission: { transmissionFactor: 1 }, dispersion: {} }, { transmission: { transmissionFactor: 1 }, dispersion: { dispersion: 0 } } ],
	KHR_materials_diffuse_transmission: [ { diffuse_transmission: { diffuseTransmissionFactor: 1 } }, { diffuse_transmission: { diffuseTransmissionFactor: 1, diffuseTransmissionColorFactor: [ 1, 1, 1 ] } } ],
};

// The material JSON: core properties as they are, `name: {…}` entries as KHR_materials_<name>.
function material( spec ) {

	const out = { extensions: {} };
	for ( const [ key, value ] of Object.entries( spec ) ) {

		if ( [ 'pbrMetallicRoughness', 'emissiveFactor', 'alphaMode', 'alphaCutoff', 'doubleSided' ].includes( key ) ) out[ key ] = value;
		else out.extensions[ `KHR_materials_${key}` ] = value;

	}

	return out;

}

function gltf( spec ) {

	const positions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
	const uri = `data:application/octet-stream;base64,${Buffer.from( positions.buffer ).toString( 'base64' )}`;
	const mat = material( spec );
	return JSON.stringify( {
		asset: { version: '2.0' },
		extensionsUsed: Object.keys( mat.extensions ),
		buffers: [ { byteLength: 36, uri } ],
		bufferViews: [ { buffer: 0, byteLength: 36 } ],
		accessors: [ { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] } ],
		materials: [ mat ],
		meshes: [ { primitives: [ { attributes: { POSITION: 0 }, material: 0 } ] } ],
		nodes: [ { mesh: 0 } ],
		scenes: [ { nodes: [ 0 ] } ],
		scene: 0,
	} );

}

// The block the engine packs for the file's one material, as plain numbers.
async function packed( spec ) {

	const loader = new GLTFLoader().register( ( parser ) => diffuseTransmissionPlugin( parser ) );
	const result = await loader.parseAsync( gltf( spec ), '' );
	const mesh = result.scene.children[ 0 ];
	const mat = new GeometryExtractor().createMaterialObject( mesh.material, mesh );
	const data = new Float32Array( MATERIAL_DATA_LAYOUT.FLOATS_PER_MATERIAL );
	packMaterial( data, 0, mat );
	return Array.from( data, ( v ) => + v.toPrecision( 6 ) );

}

describe( 'glTF defaults are the spec\'s', () => {

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

	it.each( Object.keys( CASES ) )( '%s', async ( name ) => {

		const [ bare, explicit ] = CASES[ name ];
		expect( await packed( bare ) ).toEqual( await packed( explicit ) );

	} );

} );
