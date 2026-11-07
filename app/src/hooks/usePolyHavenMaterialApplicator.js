import { useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { PolyHavenService } from '@/services/PolyHavenService';
import { PolyHavenMaterialLoader } from '@/services/PolyHavenMaterialLoader';
import { MaterialService } from '@/services/MaterialService';
import { getApp } from '@/lib/appProxy';

/**
 * Custom hook for handling PolyHaven material application to objects
 */
export const usePolyHavenMaterialApplicator = () => {

	const { toast } = useToast();
	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setLoading = useStore( ( state ) => state.setLoading );

	// Onto `target`, the selected object unless given (a material dropped on the view).
	const applyPolyHavenMaterial = useCallback( async ( materialData, target = useStore.getState().selectedObject ) => {

		if ( ! target ) {

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

			// Every part sharing the target's material takes the new one (MaterialService.replaceMaterial).
			const oldMaterial = target.material;
			PolyHavenMaterialLoader.fitDisplacement( target, threeMaterial );
			MaterialService.replaceMaterial( getApp()?.meshScene, oldMaterial, threeMaterial );
			target.material = threeMaterial;

			// Dispose old material and its textures
			if ( oldMaterial && typeof oldMaterial.dispose === 'function' ) {

				// Dispose all texture maps to prevent memory leaks
				const textureProperties = [
					'map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
					'emissiveMap', 'aoMap', 'alphaMap', 'displacementMap', 'lightMap',
					'envMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
					'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
					'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'diffuseRoughnessMap'
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
			await PolyHavenMaterialLoader.updatePathTracerMaterial( target, completeMaterialConfig );

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
