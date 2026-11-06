import localEnvironmentsData from '../data/local_environments.json';
import { getApp } from '@/lib/appProxy';
import { ASSETS_BASE_URL } from '@/Constants';
import { listSource } from '@/lib/catalog';

/**
 * Service class for handling environment/HDRI operations
 * Data-driven approach with centralized configuration
 */
export class EnvironmentService {

	/**
	 * Cache for processed environments with full URLs
	 * @private
	 */
	static _processedEnvironments = null;

	/**
	 * Get base URL for HDRI assets
	 * @private
	 * @returns {string} Base URL for HDRI files
	 */
	static _getBaseUrl() {

		return `${ASSETS_BASE_URL}/hdri/`;

	}

	/**
	 * Process raw environment data into full environment objects with URLs
	 * @private
	 * @param {Array} rawEnvironments - Raw environment data from JSON
	 * @returns {Array} Processed environment objects with full URLs
	 */
	static _processEnvironments( rawEnvironments ) {

		const baseUrl = this._getBaseUrl();

		return rawEnvironments.map( env => ( {
			id: env.id,
			name: env.name,
			preview: env.preview ? `${baseUrl}${env.preview}` : null,
			url: `${baseUrl}${env.file}`,
			categories: env.categories || [],
			tags: env.tags || [],
			resolution: env.resolution,
			source: 'local'
		} ) );

	}

	/**
	 * Get all local environments with full URLs (lazy loaded and cached)
	 * @private
	 * @returns {Array} All processed local environments
	 */
	static _getAllEnvironments() {

		if ( ! this._processedEnvironments ) {

			this._processedEnvironments = this._processEnvironments( localEnvironmentsData );

		}

		return this._processedEnvironments;

	}

	/**
	 * Get available local HDRI categories dynamically from actual data
	 * @returns {Object} Categories with counts
	 */
	static getLocalEnvironmentCategories() {

		const environments = this._getAllEnvironments();
		return this.extractCategoriesFromEnvironments( environments );

	}

	/**
	 * Extract categories from environments array with counts
	 * @param {Array} environments - Array of environment objects
	 * @returns {Object} Categories with counts (only non-zero counts)
	 */
	static extractCategoriesFromEnvironments( environments ) {

		const categoryCount = {};

		environments.forEach( env => {

			if ( env.categories && Array.isArray( env.categories ) ) {

				env.categories.forEach( category => {

					if ( category && typeof category === 'string' ) {

						categoryCount[ category ] = ( categoryCount[ category ] || 0 ) + 1;

					}

				} );

			}

		} );

		// Remove categories with 0 count and return
		return Object.fromEntries(
			Object.entries( categoryCount ).filter( ( [ , count ] ) => count > 0 )
		);

	}

	/**
	 * Search environments by name, tags, or categories
	 * @param {string} query - Search query
	 * @returns {Array} Matching environments
	 */
	static searchEnvironments( query ) {

		if ( ! query || typeof query !== 'string' ) {

			return this._getAllEnvironments();

		}

		const normalizedQuery = query.toLowerCase().trim();
		const allEnvironments = this._getAllEnvironments();

		return allEnvironments.filter( env => {

			// Search in name
			if ( env.name.toLowerCase().includes( normalizedQuery ) ) {

				return true;

			}

			// Search in categories
			if ( env.categories.some( cat => cat.toLowerCase().includes( normalizedQuery ) ) ) {

				return true;

			}

			// Search in tags
			if ( env.tags.some( tag => tag.toLowerCase().includes( normalizedQuery ) ) ) {

				return true;

			}

			return false;

		} );

	}

	/**
	 * Get environment by ID
	 * @param {string} id - Environment ID
	 * @returns {Object|null} Environment object or null if not found
	 */
	static getEnvironmentById( id ) {

		if ( ! id ) {

			return null;

		}

		const allEnvironments = this._getAllEnvironments();
		return allEnvironments.find( env => env.id === id ) || null;

	}

	/**
	 * Validate environment data object
	 * @private
	 * @param {Object} envData - Environment data to validate
	 * @throws {Error} If validation fails
	 */
	static _validateEnvironmentData( envData ) {

		if ( ! envData ) {

			throw new Error( 'Environment data is required' );

		}

		if ( ! envData.url || typeof envData.url !== 'string' ) {

			throw new Error( 'Invalid environment data: URL is required and must be a string' );

		}

		if ( ! envData.name || typeof envData.name !== 'string' ) {

			throw new Error( 'Invalid environment data: name is required and must be a string' );

		}

	}

	/**
	 * Load an environment/HDRI into the path tracer
	 * @param {Object} envData - Environment data object with url and name
	 * @returns {Promise<Object>} Promise that resolves with success info
	 * @throws {Error} If app not initialized or loading fails
	 */
	static async loadEnvironment( envData ) {

		// Validate app is initialized
		const app = getApp();
		if ( ! app ) {

			throw new Error( 'PathTracer app not initialized' );

		}

		// Validate environment data
		this._validateEnvironmentData( envData );

		try {

			// Handle custom environment uploads (preserve file info)
			if ( envData.id === 'custom-upload' && envData.name ) {

				if ( app?.assetLoader ) {

					app.assetLoader.uploadedFileInfo = {
						name: envData.name,
						url: envData.url
					};

				}

			}

			// Load environment into path tracer
			await app.loadEnvironment( envData.url );

			return {
				success: true,
				environmentName: envData.name,
				message: `${envData.name} loaded successfully`
			};

		} catch ( error ) {

			throw new Error( `Failed to load ${envData.name}: ${error.message || 'Unknown error'}` );

		}

	}

	/**
	 * Get statistics about available environments
	 * @returns {Object} Statistics object
	 */
	static getStatistics() {

		const allEnvironments = this._getAllEnvironments();
		const categories = this.getLocalEnvironmentCategories();

		return {
			totalEnvironments: allEnvironments.length,
			totalCategories: Object.keys( categories ).length,
			categories: categories,
			resolutions: this._getResolutionBreakdown( allEnvironments )
		};

	}

	/**
	 * Get breakdown of environments by resolution
	 * @private
	 * @param {Array} environments - Array of environments
	 * @returns {Object} Resolution counts
	 */
	static _getResolutionBreakdown( environments ) {

		const resolutions = {};

		environments.forEach( env => {

			const res = env.resolution || 'unknown';
			resolutions[ res ] = ( resolutions[ res ] || 0 ) + 1;

		} );

		return resolutions;

	}

	/**
	 * Clear cached environment data (useful for testing or dynamic updates)
	 */
	static clearCache() {

		this._processedEnvironments = null;

	}

}

export const FeaturedEnvironments = listSource( {
	NAME: 'Featured',
	CATALOG: 'current-source-environments',
	CATEGORY_CATALOG: 'current-source-environment-categories',
	noun: 'environments',
	load: () => EnvironmentService._getAllEnvironments(),
} );
