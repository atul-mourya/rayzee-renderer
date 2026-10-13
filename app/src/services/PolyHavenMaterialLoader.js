import {
	MeshPhysicalMaterial,
	TextureLoader,
	Color,
	DoubleSide,
	FrontSide,
	BackSide,
	Vector3
} from 'three';
import { PolyHavenService } from './PolyHavenService';
import { getApp } from '@/lib/appProxy';


/**
 * Service class for loading and processing PolyHaven materials
 */
export class PolyHavenMaterialLoader {

	static textureLoader = new TextureLoader();
	static RELIEF_OF_TILE = 0.02; // Poly Haven's Blender files: 2–10 % of a texture's real width, 2 % for cobblestone
	static textureCache = new Map();

	/**
	 * Load a texture with caching
	 * @param {string} url - Texture URL
	 * @param {string} cacheKey - Cache key
	 * @returns {Promise<Texture>} Loaded texture
	 */
	static async loadTexture( url, cacheKey ) {

		if ( this.textureCache.has( cacheKey ) ) {

			return this.textureCache.get( cacheKey );

		}

		try {

			const texture = await this.textureLoader.loadAsync( url );

			// Configure texture
			texture.flipY = false;
			texture.generateMipmaps = true;
			texture.needsUpdate = true;

			this.textureCache.set( cacheKey, texture );
			return texture;

		} catch ( error ) {

			console.error( `Error loading texture ${url}:`, error );
			throw new Error( `Failed to load texture: ${error.message}` );

		}

	}

	/**
	 * Get the best available texture files for an asset
	 * @param {string} assetId - Asset ID
	 * @param {string} resolution - Target resolution
	 * @returns {Promise<Object>} Object containing texture file URLs
	 */
	static async getAssetTextureFiles( assetId, resolution = '2k' ) {

		try {

			const files = await PolyHavenService.getAssetFiles( assetId );
			const textureFiles = {};

			// Map of texture types to their common names
			const textureTypeMap = {
				'diff': 'map', // Diffuse/Color
				'disp': 'displacementMap', // Displacement
				'nor_gl': 'normalMap', // Normal (OpenGL)
				'nor_dx': 'normalMap', // Normal (DirectX) - fallback
				'rough': 'roughnessMap', // Roughness
				'metal': 'metalnessMap', // Metalness
				'ao': 'aoMap', // Ambient Occlusion
				'bump': 'bumpMap', // Bump
				'spec': 'specularMap', // Specular
				'alpha': 'alphaMap', // Alpha
				'opacity': 'alphaMap', // Opacity
				'emission': 'emissiveMap' // Emission
			};

			// Process each texture map type
			for ( const [ mapType, files_by_res ] of Object.entries( files ) ) {

				if ( typeof files_by_res === 'object' && files_by_res !== null ) {

					// Find the best available resolution
					const availableResolutions = Object.keys( files_by_res );
					const targetRes = availableResolutions.includes( resolution )
						? resolution
						: availableResolutions[ 0 ]; // Fallback to first available

					if ( targetRes && files_by_res[ targetRes ] ) {

						const formatFiles = files_by_res[ targetRes ];

						// Prefer JPG for diffuse, PNG for others, EXR for HDR maps
						let fileInfo = null;
						if ( formatFiles.jpg ) fileInfo = formatFiles.jpg;
						else if ( formatFiles.png ) fileInfo = formatFiles.png;
						else if ( formatFiles.exr ) fileInfo = formatFiles.exr;
						else if ( formatFiles.tiff ) fileInfo = formatFiles.tiff;
						else {

							// Get first available format
							const firstFormat = Object.values( formatFiles )[ 0 ];
							if ( firstFormat && firstFormat.url ) {

								fileInfo = firstFormat;

							}

						}

						if ( fileInfo ) {

							const threejsMapName = textureTypeMap[ mapType ] || mapType;
							textureFiles[ threejsMapName ] = {
								url: fileInfo.url,
								resolution: targetRes,
								mapType,
								size: fileInfo.size || 0,
								md5: fileInfo.md5 || null
							};

						}

					}

				}

			}

			return textureFiles;

		} catch ( error ) {

			console.error( `Error getting texture files for ${assetId}:`, error );
			throw new Error( `Failed to get texture files: ${error.message}` );

		}

	}

	/**
	 * Create a Three.js material from PolyHaven material configuration
	 * @param {Object} materialConfig - Material configuration object
	 * @returns {Promise<MeshPhysicalMaterial>} Three.js material
	 */
	static async createThreeJSMaterial( materialConfig ) {

		try {

			console.log( 'Creating Three.js material from PolyHaven config:', materialConfig.name );

			// Create base material
			const material = new MeshPhysicalMaterial( {
				name: materialConfig.name,
			} );

			// Apply basic properties
			if ( materialConfig.color ) {

				material.color = new Color( ...materialConfig.color );

			}

			if ( materialConfig.emissive ) {

				material.emissive = new Color( ...materialConfig.emissive );

			}

			if ( materialConfig.attenuationColor ) {

				material.attenuationColor = new Color( ...materialConfig.attenuationColor );

			}

			if ( materialConfig.specularColor ) {

				material.specularColor = new Color( ...materialConfig.specularColor );

			}

			if ( materialConfig.sheenColor ) {

				material.sheenColor = new Color( ...materialConfig.sheenColor );

			}

			// Apply numeric properties
			const numericProps = [
				'metalness', 'roughness', 'emissiveIntensity', 'transmission',
				'opacity', 'ior', 'clearcoat', 'clearcoatRoughness',
				'sheen', 'sheenRoughness', 'specularIntensity',
				'iridescence', 'iridescenceIOR', 'attenuationDistance'
			];

			numericProps.forEach( prop => {

				if ( typeof materialConfig[ prop ] === 'number' ) {

					material[ prop ] = materialConfig[ prop ];

				}

			} );

			// Apply boolean properties
			if ( typeof materialConfig.transparent === 'boolean' ) {

				material.transparent = materialConfig.transparent;

			}

			// Apply side property
			if ( typeof materialConfig.side === 'number' ) {

				const sideMap = { 0: FrontSide, 1: BackSide, 2: DoubleSide };
				material.side = sideMap[ materialConfig.side ] || FrontSide;

			}

			// Load and apply textures
			if ( materialConfig.textureFiles ) {

				const texturePromises = [];

				Object.entries( materialConfig.textureFiles ).forEach( ( [ mapName, fileInfo ] ) => {

					const texturePromise = this.loadTexture(
						fileInfo.url,
						`${materialConfig.assetId}_${mapName}_${fileInfo.resolution}`
					).then( texture => {

						material[ mapName ] = texture;

						// Special handling for normal maps
						if ( mapName === 'normalMap' ) {

							material.normalScale.set( 1, 1 );

						}

						// Enable transparency if alpha map is present
						if ( mapName === 'alphaMap' ) {

							material.transparent = true;

						}

					} ).catch( error => {

						console.warn( `Failed to load texture ${mapName} for ${materialConfig.name}:`, error );

					} );

					texturePromises.push( texturePromise );

				} );

				// Wait for all textures to load
				await Promise.allSettled( texturePromises );

			}

			material.needsUpdate = true;

			console.log( `Created Three.js material "${materialConfig.name}" with ${Object.keys( materialConfig.textureFiles || {} ).length} textures` );

			return material;

		} catch ( error ) {

			console.error( 'Error creating Three.js material:', error );
			throw new Error( `Failed to create Three.js material: ${error.message}` );

		}

	}

	/**
	 * Sizes the displacement to the texture as drawn on `object`, mid-grey on the surface.
	 * @param {Object3D} object - the mesh the material is on
	 * @param {Material} material
	 */
	static fitDisplacement( object, material ) {

		const geometry = object.geometry;
		const position = geometry?.attributes.position;
		const uv = geometry?.attributes.uv;
		if ( ! material.displacementMap || ! position || ! uv ) return;

		object.updateWorldMatrix( true, false );
		const index = geometry.index;
		const triangles = Math.floor( ( index ? index.count : position.count ) / 3 );
		const stride = Math.max( 1, Math.floor( triangles / 10000 ) );
		const a = new Vector3(), b = new Vector3(), c = new Vector3();
		let worldArea = 0, uvArea = 0;

		for ( let t = 0; t < triangles; t += stride ) {

			const [ i0, i1, i2 ] = [ 0, 1, 2 ].map( k => index ? index.getX( t * 3 + k ) : t * 3 + k );
			a.fromBufferAttribute( position, i0 ).applyMatrix4( object.matrixWorld );
			b.fromBufferAttribute( position, i1 ).applyMatrix4( object.matrixWorld ).sub( a );
			c.fromBufferAttribute( position, i2 ).applyMatrix4( object.matrixWorld ).sub( a );
			worldArea += b.cross( c ).length();
			uvArea += Math.abs( ( uv.getX( i1 ) - uv.getX( i0 ) ) * ( uv.getY( i2 ) - uv.getY( i0 ) ) - ( uv.getX( i2 ) - uv.getX( i0 ) ) * ( uv.getY( i1 ) - uv.getY( i0 ) ) );

		}

		if ( ! ( worldArea > 0 && uvArea > 0 ) ) return;
		const { repeat } = material.displacementMap;
		const tileWidth = Math.sqrt( worldArea / uvArea / Math.abs( repeat.x * repeat.y ) );
		material.displacementScale = this.RELIEF_OF_TILE * tileWidth;
		material.displacementBias = - 0.5 * material.displacementScale;

	}

	/**
	 * Update path tracer with new material properties
	 * @param {Object} selectedObject - The selected object
	 * @param {Object} materialConfig - Material configuration
	 */
	static async updatePathTracerMaterial( selectedObject, materialConfig ) {

		try {

			console.log( 'Updating path tracer with PolyHaven material:', materialConfig.name );

			// Update path tracer materials if available
			const app = getApp();
			if ( app ) {

				// Add a small delay to ensure Three.js material updates are complete
				await new Promise( resolve => setTimeout( resolve, 100 ) );

				// Use the new material rebuild method
				await app.rebuildMaterials();

				console.log( 'Path tracer successfully updated with new material' );

			} else {

				console.warn( 'Path tracer not available for material update' );

			}

			// Trigger material update event for MaterialTab to refresh (after path tracer update)
			window.dispatchEvent( new CustomEvent( 'MaterialUpdate', {
				detail: {
					object: selectedObject,
					material: selectedObject.material,
					source: 'polyhaven',
					config: materialConfig
				}
			} ) );

		} catch ( error ) {

			console.error( 'Error updating path tracer material:', error );

			// Try to trigger a UI refresh even if path tracer update failed
			try {

				window.dispatchEvent( new CustomEvent( 'MaterialUpdate', {
					detail: {
						object: selectedObject,
						material: selectedObject.material,
						source: 'polyhaven',
						config: materialConfig,
						error: error.message
					}
				} ) );

			} catch ( eventError ) {

				console.error( 'Failed to dispatch material update event:', eventError );

			}

			// Don't throw here as the material was already applied to the Three.js object
			console.warn( 'Material applied to Three.js object but path tracer update failed' );

		}

	}

	/**
	 * Dispose of cached textures to free memory
	 * @param {string} assetId - Optional asset ID to dispose specific textures
	 */
	static disposeCachedTextures( assetId = null ) {

		if ( assetId ) {

			// Dispose specific asset textures
			const keysToRemove = [];
			this.textureCache.forEach( ( texture, key ) => {

				if ( key.startsWith( `${assetId}_` ) ) {

					texture.dispose();
					keysToRemove.push( key );

				}

			} );

			keysToRemove.forEach( key => this.textureCache.delete( key ) );

		} else {

			// Dispose all cached textures
			this.textureCache.forEach( texture => texture.dispose() );
			this.textureCache.clear();

		}

	}

}
