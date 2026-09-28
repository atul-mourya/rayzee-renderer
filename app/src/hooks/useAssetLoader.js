import { useCallback, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useStore, useAssetsStore, useEnvironmentStore } from '@/store';
import { AssetLoaderService } from '@/services/AssetLoaderService';
import { MODEL_FILES, DEBUG_MODELS } from '@/Constants';

/**
 * Custom hook for handling asset loading operations
 */
export const useAssetLoader = () => {

	const { toast } = useToast();
	const setLoading = useStore( ( state ) => state.setLoading );
	const {
		setMaterials,
		setSelectedEnvironmentIndex,
		setEnvironment
	} = useAssetsStore();

	// Initialize materials on mount
	useEffect( () => {

		const fetchMaterials = async () => {

			try {

				const processedMaterials = await AssetLoaderService.fetchMaterialCatalog();
				setMaterials( processedMaterials );

			} catch ( error ) {

				console.error( 'Error fetching materials:', error );
				toast( {
					title: "Error Loading Materials",
					description: "Failed to load material catalog",
					variant: "destructive",
				} );

			}

		};

		fetchMaterials();

	}, [ setMaterials, toast ] );

	// Shared model-load runner: show the loading overlay, run the async load, toast
	// success or (on error) toast + dismiss the overlay. Does not re-throw — callers
	// treat a failed load as handled. `describe` may be a string or fn(result).
	const runModelLoad = useCallback( async ( loading, run, { successTitle, describe, errorTitle } ) => {

		setLoading( { isLoading: true, ...loading } );

		try {

			const result = await run();
			toast( { title: successTitle, description: typeof describe === 'function' ? describe( result ) : describe } );
			return result;

		} catch ( error ) {

			if ( error?.code === 'LOAD_CANCELLED' ) {

				toast( { title: "Loading Cancelled", description: "The download was cancelled." } );

			} else {

				toast( { title: errorTitle, description: error.message, variant: "destructive" } );

			}

			useStore.getState().resetLoading();

		}

	}, [ setLoading, toast ] );

	// Replace the scene with a built-in catalog model by index.
	const loadModel = useCallback( ( value ) => runModelLoad(
		{ title: "Loading", status: "Loading Model..." },
		() => AssetLoaderService.loadExampleModel( parseInt( value ), MODEL_FILES ),
		{ successTitle: "Model Loaded Successfully", describe: r => r.modelName, errorTitle: "Error Loading Model" }
	), [ runModelLoad ] );

	// Append a model by URL to the current scene (does NOT replace it).
	const addModel = useCallback( ( url, name, options ) => runModelLoad(
		{ title: "Adding", status: "Adding Model..." },
		() => AssetLoaderService.addModel( url, name, options ),
		{ successTitle: "Model Added", describe: r => r.modelName, errorTitle: "Error Adding Model" }
	), [ runModelLoad ] );

	// Replace the scene with a model loaded from a URL (e.g. a Sketchfab GLB).
	const loadModelUrl = useCallback( ( url, name, options ) => runModelLoad(
		{ title: "Loading", status: "Loading Model..." },
		() => AssetLoaderService.loadModelUrl( url, name, options ),
		{ successTitle: "Model Loaded Successfully", describe: name || 'Model', errorTitle: "Error Loading Model" }
	), [ runModelLoad ] );

	// Append a model from the built-in catalog by index.
	const appendCatalogModel = useCallback( async ( value ) => {

		const modelFile = MODEL_FILES[ parseInt( value ) ];
		if ( ! modelFile ) return undefined;
		return addModel( modelFile.url, modelFile.name );

	}, [ addModel ] );

	const loadDebugModel = useCallback( ( value ) => runModelLoad(
		{ title: "Loading", status: "Loading Debug Model...", progress: 0 },
		() => AssetLoaderService.loadDebugModel( parseInt( value ), DEBUG_MODELS ),
		{ successTitle: "Model Loaded Successfully", describe: r => r.modelName, errorTitle: "Error Loading Model" }
	), [ runModelLoad ] );

	const loadEnvironment = useCallback( async ( envData ) => {

		if ( ! envData || ! envData.url ) return;

		// Update both environment and its index
		setEnvironment( envData );

		// Find and set the environment index
		const environmentStore = useEnvironmentStore.getState();
		const environments = environmentStore.environments || [];
		const index = environments.findIndex( env => env.id === envData.id );
		setSelectedEnvironmentIndex( index >= 0 ? index : null );

		setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 0 } );

		try {

			const result = await AssetLoaderService.loadEnvironment( envData );

			toast( {
				title: "Environment Loaded Successfully",
				description: result.environmentName,
			} );
			useStore.getState().resetLoading();

		} catch ( error ) {

			if ( error?.code === 'LOAD_CANCELLED' ) {

				toast( { title: "Loading Cancelled", description: "The download was cancelled." } );

			} else {

				console.error( "Environment loading error:", error );
				toast( {
					title: "Error Loading Environment",
					description: error.message,
					variant: "destructive",
				} );

			}

			useStore.getState().resetLoading();

		}

	}, [ setEnvironment, setSelectedEnvironmentIndex, setLoading, toast ] );

	return {
		loadModel,
		loadModelUrl,
		loadDebugModel,
		loadEnvironment,
		addModel,
		appendCatalogModel
	};

};
