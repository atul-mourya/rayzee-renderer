import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three';

export const DIFFUSE_TRANSMISSION_EXTENSION = 'KHR_materials_diffuse_transmission';

/**
 * A GLTFLoader plugin for KHR_materials_diffuse_transmission, which three.js does not read: each material's factors
 * and textures become the engine's `diffuseTransmission`, `diffuseTransmissionColor`, `diffuseTransmissionMap` (its
 * alpha is the factor) and `diffuseTransmissionColorMap`. The engine folds the maps in like the other extension maps,
 * through the albedo map's uv transform.
 */
export function diffuseTransmissionPlugin( parser ) {

	// The factor texture is read for its alpha alone and may be another slot's colour texture, so its colour space is
	// left as it is.
	const assign = ( material, key, info, colorSpace ) => {

		const params = {};
		return parser.assignTexture( params, key, info, colorSpace ).then( () => {

			if ( params[ key ] ) material[ key ] = params[ key ];

		} );

	};

	return {

		name: DIFFUSE_TRANSMISSION_EXTENSION,

		afterRoot( result ) {

			const definitions = parser.json.materials ?? [];
			const done = new Set();
			const pending = [];

			for ( const scene of result.scenes ?? [] ) scene.traverse( ( object ) => {

				const materials = Array.isArray( object.material ) ? object.material : object.material ? [ object.material ] : [];
				for ( const material of materials ) {

					if ( done.has( material ) ) continue;
					done.add( material );
					const index = parser.associations.get( material )?.materials;
					const extension = index === undefined ? null : definitions[ index ]?.extensions?.[ DIFFUSE_TRANSMISSION_EXTENSION ];
					if ( ! extension ) continue;

					material.diffuseTransmission = extension.diffuseTransmissionFactor ?? 0;
					const [ r, g, b ] = extension.diffuseTransmissionColorFactor ?? [ 1, 1, 1 ];
					material.diffuseTransmissionColor = new Color().setRGB( r, g, b, LinearSRGBColorSpace );
					if ( extension.diffuseTransmissionTexture ) pending.push( assign( material, 'diffuseTransmissionMap', extension.diffuseTransmissionTexture ) );
					if ( extension.diffuseTransmissionColorTexture ) pending.push( assign( material, 'diffuseTransmissionColorMap', extension.diffuseTransmissionColorTexture, SRGBColorSpace ) );

				}

			} );

			return Promise.all( pending );

		},

	};

}
