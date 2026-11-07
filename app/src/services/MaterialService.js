import { Color } from 'three';
import { MATERIAL_DEFAULTS, subsurfaceFromDiffuse } from 'rayzee';
import { getApp } from '@/lib/appProxy';

/**
 * Service class for handling material operations
 */
export class MaterialService {

	/**
	 * A complete material from a Physically Based database entry (https://physicallybased.info: colours linear Rec.709,
	 * lengths in centimetres, `density` the mass density, which nothing optical reads).
	 * @param {Object} apiMaterialInfo - one entry of the catalogue
	 * @param {number} [unitsPerMetre=1] - the scene's scale, for the entry's lengths
	 * @returns {Object} Complete material object with all PBR properties
	 */
	static createCompleteMaterialFromAPI( apiMaterialInfo, unitsPerMetre = 1 ) {

		const completeMaterial = structuredClone( MATERIAL_DEFAULTS );
		const centimetre = unitsPerMetre / 100;
		const positive = ( v ) => typeof v === 'number' && v > 0;

		if ( apiMaterialInfo.color ) completeMaterial.color = apiMaterialInfo.color;
		if ( typeof apiMaterialInfo.metalness === 'number' ) completeMaterial.metalness = apiMaterialInfo.metalness;
		// 0 is a mirror: the engine takes it as an exact reflection.
		if ( typeof apiMaterialInfo.roughness === 'number' ) completeMaterial.roughness = apiMaterialInfo.roughness;
		if ( typeof apiMaterialInfo.ior === 'number' ) completeMaterial.ior = apiMaterialInfo.ior;
		if ( typeof apiMaterialInfo.transmission === 'number' ) completeMaterial.transmission = apiMaterialInfo.transmission;

		if ( completeMaterial.transmission > 0 ) {

			completeMaterial.side = 2;
			// The colour is reached at `transmissionDepth` inside (centimetres, as the radii are), glTF's attenuation;
			// without a depth it tints the surface. One or the other: both would tint it twice.
			if ( positive( apiMaterialInfo.transmissionDepth ) ) {

				completeMaterial.attenuationColor = [ ...completeMaterial.color ];
				completeMaterial.attenuationDistance = apiMaterialInfo.transmissionDepth * centimetre;
				completeMaterial.color = [ 1, 1, 1 ];

			}

			// An Abbe number; glTF's dispersion is 20 / it.
			if ( positive( apiMaterialInfo.transmissionDispersion ) ) completeMaterial.dispersion = 20 / apiMaterialInfo.transmissionDispersion;

		}

		// The diffuse mean free path, per channel: the colour shown and how far light spreads under the surface.
		if ( Array.isArray( apiMaterialInfo.subsurfaceRadius ) ) {

			const { subsurfaceColor, subsurfaceRadius } = subsurfaceFromDiffuse( completeMaterial.color, apiMaterialInfo.subsurfaceRadius, completeMaterial.ior );
			completeMaterial.subsurface = 1;
			completeMaterial.subsurfaceColor = subsurfaceColor;
			completeMaterial.subsurfaceRadius = subsurfaceRadius.map( ( r ) => r * centimetre );

		}

		// Handle thin film properties
		if ( typeof apiMaterialInfo.thinFilmThickness === 'number' ) {

			completeMaterial.iridescence = 1.0;
			completeMaterial.iridescenceThicknessRange = [ apiMaterialInfo.thinFilmThickness, apiMaterialInfo.thinFilmThickness ];

			if ( typeof apiMaterialInfo.thinFilmIor === 'number' ) {

				completeMaterial.iridescenceIOR = apiMaterialInfo.thinFilmIor;

			}

		}

		return completeMaterial;

	}

	/**
	 * Apply material information to a Three.js material object
	 * @param {Object} materialInfo - Material information from API
	 * @param {Object} threeMaterial - Three.js material object to modify
	 */
	static applyMaterialToObject( materialInfo, threeMaterial ) {

		if ( ! threeMaterial ) {

			console.error( "Invalid material object provided" );
			return;

		}

		// Clear all texture maps to prevent old textures from being used
		// This is critical when applying a non-textured material to an object that previously had textures
		const textureMapProperties = [
			'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
			'emissiveMap', 'displacementMap', 'clearcoatMap', 'clearcoatRoughnessMap',
			'transmissionMap', 'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
			'specularIntensityMap', 'specularColorMap', 'iridescenceMap', 'iridescenceThicknessMap', 'diffuseRoughnessMap'
		];

		textureMapProperties.forEach( prop => {

			if ( prop in threeMaterial ) {

				threeMaterial[ prop ] = null;

			}

		} );

		// Helper function to ensure property exists and set it
		const ensureAndSet = ( obj, prop, value ) => {

			if ( ! ( prop in obj ) ) {

				// Create the property if it doesn't exist
				obj[ prop ] = value;

			} else {

				obj[ prop ] = value;

			}

		};

		// Helper function for color properties
		const ensureAndSetColor = ( obj, prop, colorArray ) => {

			if ( Array.isArray( colorArray ) && colorArray.length >= 3 ) {

				if ( ! ( prop in obj ) ) {

					// Create Color object if property doesn't exist
					obj[ prop ] = new Color();

				}

				if ( obj[ prop ] && obj[ prop ].setRGB ) {

					obj[ prop ].setRGB( colorArray[ 0 ], colorArray[ 1 ], colorArray[ 2 ] );

				}

			}

		};

		// Create complete material with defaults first
		const completeMaterial = this.createCompleteMaterialFromAPI( materialInfo, getApp()?.settings?.get( 'unitsPerMetre' ) ?? 1 );

		// Ensure and set all material properties to create a complete PBR material
		// Base colors
		ensureAndSetColor( threeMaterial, 'color', completeMaterial.color );
		ensureAndSetColor( threeMaterial, 'emissive', completeMaterial.emissive );
		ensureAndSetColor( threeMaterial, 'attenuationColor', completeMaterial.attenuationColor );
		ensureAndSetColor( threeMaterial, 'specularColor', completeMaterial.specularColor );
		ensureAndSetColor( threeMaterial, 'sheenColor', completeMaterial.sheenColor );

		// Basic material properties
		ensureAndSet( threeMaterial, 'emissiveIntensity', completeMaterial.emissiveIntensity );
		ensureAndSet( threeMaterial, 'roughness', completeMaterial.roughness );
		ensureAndSet( threeMaterial, 'metalness', completeMaterial.metalness );
		ensureAndSet( threeMaterial, 'ior', completeMaterial.ior );
		ensureAndSet( threeMaterial, 'opacity', completeMaterial.opacity );

		// Transmission properties
		ensureAndSet( threeMaterial, 'transmission', completeMaterial.transmission );
		ensureAndSet( threeMaterial, 'thickness', completeMaterial.thickness );
		ensureAndSet( threeMaterial, 'attenuationDistance', completeMaterial.attenuationDistance );

		// Advanced properties
		ensureAndSet( threeMaterial, 'dispersion', completeMaterial.dispersion );
		ensureAndSet( threeMaterial, 'sheen', completeMaterial.sheen );
		ensureAndSet( threeMaterial, 'sheenRoughness', completeMaterial.sheenRoughness );
		ensureAndSet( threeMaterial, 'specularIntensity', completeMaterial.specularIntensity );
		ensureAndSet( threeMaterial, 'clearcoat', completeMaterial.clearcoat );
		ensureAndSet( threeMaterial, 'clearcoatRoughness', completeMaterial.clearcoatRoughness );

		// Iridescence properties
		ensureAndSet( threeMaterial, 'iridescence', completeMaterial.iridescence );
		ensureAndSet( threeMaterial, 'iridescenceIOR', completeMaterial.iridescenceIOR );
		ensureAndSet( threeMaterial, 'iridescenceThicknessMinimum', completeMaterial.iridescenceThicknessRange[ 0 ] );
		ensureAndSet( threeMaterial, 'iridescenceThicknessMaximum', completeMaterial.iridescenceThicknessRange[ 1 ] );

		// Subsurface scattering (custom props; MeshPhysicalMaterial has none)
		ensureAndSet( threeMaterial, 'subsurface', completeMaterial.subsurface );
		ensureAndSetColor( threeMaterial, 'subsurfaceColor', completeMaterial.subsurfaceColor );
		ensureAndSet( threeMaterial, 'subsurfaceRadius', completeMaterial.subsurfaceRadius );
		ensureAndSet( threeMaterial, 'subsurfaceRadiusScale', completeMaterial.subsurfaceRadiusScale );
		ensureAndSet( threeMaterial, 'subsurfaceAnisotropy', completeMaterial.subsurfaceAnisotropy );

		// Surface anisotropy (native MeshPhysicalMaterial props)
		ensureAndSet( threeMaterial, 'anisotropy', completeMaterial.anisotropy );
		ensureAndSet( threeMaterial, 'anisotropyRotation', completeMaterial.anisotropyRotation );

		// Diffuse roughness (custom prop until three.js r187), or a library material keeps the last one's.
		ensureAndSet( threeMaterial, 'diffuseRoughness', completeMaterial.diffuseRoughness );

		// Rendering properties
		ensureAndSet( threeMaterial, 'transparent', completeMaterial.transparent > 0 );
		ensureAndSet( threeMaterial, 'alphaTest', completeMaterial.alphaTest );
		// Handle side property (convert number to Three.js constants)
		const sideMap = { 0: 0, 1: 1, 2: 2 }; // FrontSide, BackSide, DoubleSide
		ensureAndSet( threeMaterial, 'side', sideMap[ completeMaterial.side ] !== undefined ? sideMap[ completeMaterial.side ] : 0 );

		// Ensure needsUpdate exists and set it
		ensureAndSet( threeMaterial, 'needsUpdate', true );

	}

	/**
	 * Update path tracer with new material properties
	 * @param {Object} selectedObject - The selected object to update
	 */
	static updatePathTracerMaterial( selectedObject ) {

		const app = getApp();
		if ( ! app || ! ( selectedObject && selectedObject.material ) ) {

			console.warn( 'PathTracer app or selected object material not available' );
			return;

		}

		// Check if the material index exists
		if ( selectedObject.userData && selectedObject.userData.materialIndex === undefined ) {

			console.warn( 'Material index not found on selected object, using default index 0' );

		}

		const objMaterialIndex = selectedObject.userData && selectedObject.userData.materialIndex !== undefined
			? selectedObject.userData.materialIndex
			: 0;

		// Use app-level proxy method for material update
		app.stages.pathTracer?.materialData.updateMaterial( objMaterialIndex, selectedObject.material );

		// Reset renderer to apply changes
		if ( app.reset ) {

			app.reset();

		}

	}

}
