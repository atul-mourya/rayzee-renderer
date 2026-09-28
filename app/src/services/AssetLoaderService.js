import { getApp } from '@/lib/appProxy';

/**
 * Service class for handling asset loading operations
 */
export class AssetLoaderService {

	/**
	 * Load a model from the example models list
	 * @param {number} modelIndex - Index of the model to load
	 * @param {Array} modelFiles - Array of model file definitions
	 * @returns {Promise} Promise that resolves when model is loaded
	 */
	static async loadExampleModel( modelIndex, modelFiles ) {

		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( modelIndex < 0 || modelIndex >= modelFiles.length ) {

			throw new Error( `Invalid model index: ${modelIndex}` );

		}

		const modelFile = modelFiles[ modelIndex ];

		try {

			await app.loadExampleModels( modelIndex, modelFiles );
			return {
				success: true,
				modelName: modelFile.name,
				message: `${modelFile.name} loaded successfully`
			};

		} catch ( error ) {

			if ( error.code === 'LOAD_CANCELLED' ) throw error;
			throw new Error( `Failed to load ${modelFile.name}: ${error.message}` );

		}

	}

	/**
	 * Replace the scene with a model loaded from a URL.
	 * @param {string} url - Model URL (.glb / .gltf)
	 * @param {string} [name]
	 * @param {{cacheKey?: string}} [options] - download-cache key for a link that expires
	 * @returns {Promise<{success:boolean, modelName:string}>}
	 */
	static async loadModelUrl( url, name, options = {} ) {

		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		try {

			await app.loadModel( url, options );
			return { success: true, modelName: name || 'Model' };

		} catch ( error ) {

			if ( error.code === 'LOAD_CANCELLED' ) throw error;
			throw new Error( `Failed to load ${name || 'model'}: ${error.message}` );

		}

	}

	/**
	 * Append a model by URL to the current scene (does NOT replace it).
	 * @param {string} url - Model URL (.glb / .gltf)
	 * @param {string} [name] - Display name for the scene-object list
	 * @param {{cacheKey?: string}} [options] - download-cache key for a link that expires
	 * @returns {Promise<{success:boolean, id:string, modelName:string}>}
	 */
	static async addModel( url, name, options = {} ) {

		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		try {

			const id = await app.addModel( url, { name, cacheKey: options.cacheKey } );
			return { success: true, id, modelName: name || 'Model' };

		} catch ( error ) {

			if ( error.code === 'LOAD_CANCELLED' ) throw error;
			throw new Error( `Failed to add ${name || 'model'}: ${error.message}` );

		}

	}

	/**
	 * Load a debug model
	 * @param {number} modelIndex - Index of the debug model to load
	 * @param {Array} debugModels - Array of debug model definitions
	 * @returns {Promise} Promise that resolves when model is loaded
	 */
	static async loadDebugModel( modelIndex, debugModels ) {

		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( modelIndex < 0 || modelIndex >= debugModels.length ) {

			throw new Error( `Invalid debug model index: ${modelIndex}` );

		}

		const debugModel = debugModels[ modelIndex ];

		try {

			await app.loadModel( debugModel.url );
			return {
				success: true,
				modelName: debugModel.name,
				message: `${debugModel.name} loaded successfully`
			};

		} catch ( error ) {

			if ( error.code === 'LOAD_CANCELLED' ) throw error;
			throw new Error( `Failed to load ${debugModel.name}: ${error.message}` );

		}

	}

	/**
	 * Load an environment map
	 * @param {Object} envData - Environment data object
	 * @returns {Promise} Promise that resolves when environment is loaded
	 */
	static async loadEnvironment( envData ) {

		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		if ( ! envData || ! envData.url ) {

			throw new Error( 'Invalid environment data provided' );

		}

		try {

			// Handle custom environment uploads
			if ( envData.id === 'custom-upload' && envData.name ) {

				const app = getApp();
				if ( app?.assetLoader ) {

					app.assetLoader.uploadedFileInfo = {
						name: envData.name,
						url: envData.url
					};

				}

			}

			await app.loadEnvironment( envData.url );
			return {
				success: true,
				environmentName: envData.name,
				message: `${envData.name} loaded successfully`
			};

		} catch ( error ) {

			if ( error.code === 'LOAD_CANCELLED' ) throw error;
			throw new Error( `Failed to load ${envData.name}: ${error.message || "Unknown error"}` );

		}

	}

	/**
	 * Fetch materials from API
	 * @returns {Promise<Array>} Promise that resolves to processed materials array
	 */
	static async fetchMaterialCatalog() {

		try {

			const response = await fetch( 'https://api.physicallybased.info/materials' );

			if ( ! response.ok ) {

				throw new Error( `HTTP error! status: ${response.status}` );

			}

			const data = await response.json();

			// Process materials to add preview property and ensure categories are arrays
			const processedMaterials = data.map( ( mData ) => ( {
				...mData,
				preview: mData.reference && mData.reference.length > 0 ? mData.reference[ 0 ] : null,
				categories: Array.isArray( mData.category ) ? mData.category : ( mData.category ? [ mData.category ] : [] ),
				source: 'physicallybased'
			} ) );

			return processedMaterials;

		} catch ( error ) {

			throw new Error( `Failed to fetch material catalog: ${error.message}` );

		}

	}

	/**
	 * Extract categories from current materials dataset
	 * @param {Array} materials - Array of materials
	 * @returns {Object} Categories with material counts
	 */
	static extractCategoriesFromMaterials( materials ) {

		const categoryCount = {};

		materials.forEach( material => {

			if ( material.categories && Array.isArray( material.categories ) ) {

				material.categories.forEach( category => {

					if ( category && typeof category === 'string' ) {

						categoryCount[ category ] = ( categoryCount[ category ] || 0 ) + 1;

					}

				} );

			}

		} );

		return categoryCount;

	}

	/**
	 * Filter materials by category
	 * @param {Array} materials - Array of materials
	 * @param {Array<string>} categories - Categories to filter by
	 * @returns {Array} Filtered materials
	 */
	static filterMaterialsByCategories( materials, categories = null ) {

		if ( ! categories || categories.length === 0 ) {

			return materials;

		}

		return materials.filter( material => {

			if ( ! material.categories || ! Array.isArray( material.categories ) ) {

				return false;

			}

			// Check if material has any of the specified categories
			return categories.some( category =>
				material.categories.some( matCategory =>
					matCategory.toLowerCase() === category.toLowerCase()
				)
			);

		} );

	}

	/**
	 * Fetch materials filtered by categories
	 * @param {Array<string>} categories - Optional categories to filter by
	 * @param {number} limit - Maximum number of materials to return
	 * @returns {Promise<Array>} Filtered materials array
	 */
	static async fetchMaterialsByCategories( categories = null, limit = 50 ) {

		try {

			// Fetch all materials
			const allMaterials = await this.fetchMaterialCatalog();

			// Filter by categories if specified
			const filteredMaterials = this.filterMaterialsByCategories( allMaterials, categories );

			// Apply limit
			const limitedMaterials = limit > 0 ? filteredMaterials.slice( 0, limit ) : filteredMaterials;

			return limitedMaterials;

		} catch ( error ) {

			throw new Error( `Failed to fetch materials by categories: ${error.message}` );

		}

	}

	/**
	 * Reset path tracer after loading operations
	 */
	static resetPathTracer() {

		const app = getApp();
		if ( app?.reset ) {

			app.reset();

		}

	}

}
