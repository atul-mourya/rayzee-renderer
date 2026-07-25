// database.js
import { createLogger } from 'rayzee';

const log = createLogger( 'db' );

const DB_NAME = 'RenderResultsDB';
const DB_VERSION = 2; // Incremented to support AI image variants
const STORE_NAME = 'renders';

// Single instance of DB connection to avoid multiple open requests
let dbInstance = null;
let dbInitPromise = null;

/**
 * Initialize and open the database, ensuring schema is correct
 * This should be called once at app startup
 */
export const initDatabase = () => {

	if ( ! dbInitPromise ) {

		dbInitPromise = new Promise( ( resolve, reject ) => {

			// Check if IndexedDB is supported
			if ( ! window.indexedDB ) {

				log.error( "Your browser doesn't support IndexedDB" );
				reject( "IndexedDB not supported" );
				return;

			}

			const openRequest = indexedDB.open( DB_NAME, DB_VERSION );

			openRequest.onupgradeneeded = ( event ) => {

				log.debug( "Database upgrade needed, creating schema" );
				const db = event.target.result;

				// Create object store if it doesn't exist
				if ( ! db.objectStoreNames.contains( STORE_NAME ) ) {

					const objectStore = db.createObjectStore( STORE_NAME, {
						keyPath: 'id',
						autoIncrement: true
					} );

					// Create indices
					objectStore.createIndex( 'timestamp', 'timestamp', { unique: false } );
					log.debug( "Created object store and indices" );

				}

			};

			openRequest.onsuccess = ( event ) => {

				log.debug( "Database opened successfully" );
				dbInstance = event.target.result;

				// Check if the expected store exists
				if ( ! dbInstance.objectStoreNames.contains( STORE_NAME ) ) {

					log.warn( "Database opened but the renders store is missing. Recreating the database..." );
					dbInstance.close();

					// Recreate the database with a new version to force schema update
					const newVersion = DB_VERSION + 1;
					log.debug( `Reopening database with new version ${newVersion}` );

					const reopenRequest = indexedDB.open( DB_NAME, newVersion );

					reopenRequest.onupgradeneeded = ( event ) => {

						log.debug( "Recreating database schema" );
						const db = event.target.result;

						// Create the store
						const objectStore = db.createObjectStore( STORE_NAME, {
							keyPath: 'id',
							autoIncrement: true
						} );

						// Create indices
						objectStore.createIndex( 'timestamp', 'timestamp', { unique: false } );
						log.debug( "Recreated object store and indices" );

					};

					reopenRequest.onsuccess = ( event ) => {

						log.debug( "Database reopened successfully" );
						dbInstance = event.target.result;
						resolve( dbInstance );

					};

					reopenRequest.onerror = ( event ) => {

						log.error( "Error reopening database:", event.target.error );
						reject( event.target.error );

					};

				} else {

					resolve( dbInstance );

				}

			};

			openRequest.onerror = ( event ) => {

				log.error( "Error opening database:", event.target.error );
				reject( event.target.error );

			};

		} );

	}

	return dbInitPromise;

};

/**
 * Get the database instance, initializing if necessary
 */
export const getDatabase = async () => {

	if ( dbInstance ) {

		return dbInstance;

	}

	return initDatabase();

};

/**
 * Save a rendered image to the database
 */
export const saveRender = async ( data ) => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			// Create a new transaction for this operation
			const transaction = db.transaction( STORE_NAME, 'readwrite' );
			const store = transaction.objectStore( STORE_NAME );

			// Add the new render to the store
			const request = store.add( {
				image: data.image,
				colorCorrection: {
					brightness: data.colorCorrection.brightness,
					contrast: data.colorCorrection.contrast,
					saturation: data.colorCorrection.saturation,
					hue: data.colorCorrection.hue,
					exposure: data.colorCorrection.exposure,
					gamma: data.colorCorrection.gamma,
			 	},
				timestamp: new Date(),
				renderTime: data.renderTime || null,
				isEdited: data.isEdited || false,
				// AI-related fields (optional)
				aiPrompt: data.aiPrompt || null,
				aiGeneratedImage: data.aiGeneratedImage || null,
				sourceRenderId: data.sourceRenderId || null,
			} );

			request.onsuccess = () => {

				log.debug( "Render saved with ID:", request.result );
				resolve( request.result );

			};

			request.onerror = ( event ) => {

				log.error( "Error saving render:", event.target.error );
				reject( event.target.error );

			};

			transaction.oncomplete = () => {

				log.debug( 'Transaction completed successfully' );

			};

			transaction.onerror = ( event ) => {

				log.error( 'Transaction error:', event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		log.error( 'Error in saveRender:', error );
		throw error;

	}

};

/**
 * Get all renders from the database
 */
export const getAllRenders = async () => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readonly' );
			const store = transaction.objectStore( STORE_NAME );

			// Get all records and sort by timestamp (newest first)
			const request = store.getAll();

			request.onsuccess = () => {

				const results = request.result;
				log.debug( `Retrieved ${results.length} renders from database` );

				// Check for data integrity and sort by timestamp (newest first)
				if ( results && results.length > 0 ) {

					// Log the first result for debugging
					if ( results[ 0 ] ) {

						log.debug( 'Sample render data:', {
							hasImage: Boolean( results[ 0 ].image ),
							imageType: typeof results[ 0 ].image,
							imageLength: typeof results[ 0 ].image === 'string' ? results[ 0 ].image.length : 'N/A',
							hasTimestamp: Boolean( results[ 0 ].timestamp ),
							timestamp: results[ 0 ].timestamp ? new Date( results[ 0 ].timestamp ).toISOString() : 'N/A'
						} );

					}

					// Sort by timestamp (newest first)
					const sortedResults = results
						.filter( item => item && item.image && item.timestamp )
						.sort( ( a, b ) => new Date( b.timestamp ) - new Date( a.timestamp ) );

					log.debug( `After filtering and sorting: ${sortedResults.length} renders` );
					resolve( sortedResults );

				} else {

					log.debug( 'No renders found in database' );
					resolve( [] );

				}

			};

			request.onerror = ( event ) => {

				log.error( "Error getting renders:", event.target.error );
				reject( event.target.error );

			};

			transaction.onerror = ( event ) => {

				log.error( "Transaction error in getAllRenders:", event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		log.error( 'Error in getAllRenders:', error );
		return [];

	}

};
// Add this function to your database.js file

/**
 * Delete a render from the database by ID
 */
export const deleteRender = async ( id ) => {

	try {

	  const db = await getDatabase();

	  return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readwrite' );
			const store = transaction.objectStore( STORE_NAME );

			// Delete the render with the given ID
			const request = store.delete( id );

			request.onsuccess = () => {

		  log.debug( `Render with ID ${id} deleted successfully` );
		  resolve( true );

			};

			request.onerror = ( event ) => {

		  log.error( `Error deleting render with ID ${id}:`, event.target.error );
		  reject( event.target.error );

			};

			transaction.oncomplete = () => {

		  log.debug( 'Delete transaction completed successfully' );

			};

			transaction.onerror = ( event ) => {

		  log.error( 'Delete transaction error:', event.target.error );
		  reject( event.target.error );

			};

		} );

	} catch ( error ) {

	  log.error( 'Error in deleteRender:', error );
	  throw error;

	}

};

/**
 * get render by ID
 */
export const getRenderById = async ( id ) => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readonly' );
			const store = transaction.objectStore( STORE_NAME );

			// Get the render with the given ID
			const request = store.get( id );

			request.onsuccess = () => {

				log.debug( `Render with ID ${id} retrieved successfully` );
				resolve( request.result );

			};

			request.onerror = ( event ) => {

				log.error( `Error retrieving render with ID ${id}:`, event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		log.error( 'Error in getRenderById:', error );
		throw error;

	}

};

/**
 * Update an existing render with AI-generated image variant
 */
export const updateRenderWithAI = async ( id, aiPrompt, aiGeneratedImage ) => {

	try {

		const db = await getDatabase();

		return new Promise( ( resolve, reject ) => {

			const transaction = db.transaction( STORE_NAME, 'readwrite' );
			const store = transaction.objectStore( STORE_NAME );

			// First get the existing render
			const getRequest = store.get( id );

			getRequest.onsuccess = () => {

				const render = getRequest.result;

				if ( ! render ) {

					reject( new Error( `Render with ID ${id} not found` ) );
					return;

				}

				// Update with AI data
				render.aiPrompt = aiPrompt;
				render.aiGeneratedImage = aiGeneratedImage;

				// Save the updated render
				const putRequest = store.put( render );

				putRequest.onsuccess = () => {

					log.debug( `Render with ID ${id} updated with AI variant` );
					resolve( true );

				};

				putRequest.onerror = ( event ) => {

					log.error( `Error updating render with ID ${id}:`, event.target.error );
					reject( event.target.error );

				};

			};

			getRequest.onerror = ( event ) => {

				log.error( `Error retrieving render with ID ${id}:`, event.target.error );
				reject( event.target.error );

			};

			transaction.oncomplete = () => {

				log.debug( 'Update transaction completed successfully' );

			};

			transaction.onerror = ( event ) => {

				log.error( 'Update transaction error:', event.target.error );
				reject( event.target.error );

			};

		} );

	} catch ( error ) {

		log.error( 'Error in updateRenderWithAI:', error );
		throw error;

	}

};
