import { useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useStore, useAssetsStore } from '@/store';
import { PolyHavenService } from '@/services/PolyHavenService';
import { PolyHavenMaterialLoader } from '@/services/PolyHavenMaterialLoader';

/**
 * Custom hook for handling PolyHaven material application to objects
 */
export const usePolyHavenMaterialApplicator = () => {

	const { toast } = useToast();
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setLoading = useStore( ( state ) => state.setLoading );

	const applyPolyHavenMaterial = useCallback( async ( value ) => {

		if ( ! value || value === '' ) {

			console.warn( 'No material value provided' );
			return;

		}

		const { selectedObject } = useStore.getState();
		if ( ! selectedObject ) {

			console.warn( 'No object selected for material application' );
			return;

		}

		setLoading( {
			isLoading: true,
			title: "Loading PolyHaven Material",
			status: "Preparing to load material...",
			progress: 10
		} );

		try {

			const materialIndex = parseInt( value );

			// Get materials from the assets store instead of global cache
			const { polyHavenMaterials } = useAssetsStore.getState();
			if ( ! polyHavenMaterials || polyHavenMaterials.length === 0 ) {

				throw new Error( 'No PolyHaven materials loaded' );

			}

			if ( materialIndex < 0 || materialIndex >= polyHavenMaterials.length ) {

				throw new Error( `Invalid material index: ${materialIndex} (available: 0-${polyHavenMaterials.length - 1})` );

			}

			const materialData = polyHavenMaterials[ materialIndex ];
			setLoading( {
				isLoading: true,
				title: "Loading PolyHaven Material",
				status: `Loading textures for ${materialData.name}...`,
				progress: 25
			} );

			// Load complete material with textures
			const completeMaterialConfig = await PolyHavenService.loadCompleteMaterial( materialData );

			setLoading( {
				isLoading: true,
				title: "Loading PolyHaven Material",
				status: "Converting to Three.js material...",
				progress: 50
			} );

			// Convert to Three.js material
			const threeMaterial = await PolyHavenMaterialLoader.createThreeJSMaterial( completeMaterialConfig );

			setLoading( {
				isLoading: true,
				title: "Loading PolyHaven Material",
				status: "Applying to model...",
				progress: 75
			} );

			// Apply to selected object
			const oldMaterial = selectedObject.material;
			selectedObject.material = threeMaterial;

			// Dispose old material and its textures
			if ( oldMaterial && typeof oldMaterial.dispose === 'function' ) {

				// Dispose all texture maps to prevent memory leaks
				const textureProperties = [
					'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
					'emissiveMap', 'aoMap', 'alphaMap', 'displacementMap', 'lightMap',
					'envMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
					'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
					'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap'
				];

				textureProperties.forEach( prop => {

					if ( oldMaterial[ prop ] && typeof oldMaterial[ prop ].dispose === 'function' ) {

						try {

							oldMaterial[ prop ].dispose();

						} catch ( error ) {

							console.warn( `Error disposing texture ${prop}:`, error );

						}

					}

				} );

				// Finally dispose the material itself
				oldMaterial.dispose();

			}

			setLoading( {
				isLoading: true,
				title: "Loading PolyHaven Material",
				status: "Processing for path tracer...",
				progress: 90
			} );

			// Update path tracer with new material
			await PolyHavenMaterialLoader.updatePathTracerMaterial( selectedObject, completeMaterialConfig );

			toast( {
				title: "PolyHaven Material Applied",
				description: `${materialData.name} applied successfully`,
			} );

		} catch ( error ) {

			console.error( "Error applying PolyHaven material:", error );
			toast( {
				title: "Error Applying PolyHaven Material",
				description: error.message || "Unknown error occurred",
				variant: "destructive",
			} );

		} finally {

			useStore.getState().resetLoading();

		}

	}, [ setLoading, toast ] );

	const canApplyMaterial = !! ( selectedObject && selectedObject.material );

	return {
		applyPolyHavenMaterial,
		canApplyMaterial,
		selectedObject
	};

};
