/**
 * MaterialDataManager.js
 * Manages material storage buffers, property read/write, texture arrays,
 * and feature scanning for the path tracing pipeline.
 *
 * Storage buffer nodes are created once and never replaced — only .value
 * is mutated to preserve TSL shader graph references after compilation.
 */

import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { storage } from 'three/tsl';
import { MATERIAL_DATA_LAYOUT as M, TRIANGLE_DATA_LAYOUT as T } from '../EngineDefaults.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'material' );

const PIXELS_PER_MATERIAL = M.SLOTS_PER_MATERIAL;
// Per-triangle float offsets used by _patchTriangleSideForMaterial / _patchTriangleBlockerForMaterial.
const TRI_MAT_IDX_OFFSET = T.UV_C_MAT_OFFSET + 2; // uvData2.z in shader
const TRI_SIDE_OFFSET = T.NORMAL_C_OFFSET + 3; // normalCData.w in shader
const TRI_BLOCKER_OFFSET = T.NORMAL_A_OFFSET + 3; // nA.w in shader (opaque-blocker fast path)

// Material properties that affect the shadow-ray opaque-blocker flag.
const BLOCKER_PROPS = new Set( [ 'transmission', 'transparent', 'opacity', 'alphaMode' ] );

export class MaterialDataManager {

	/**
	 * @param {Object} sdfs - SceneProcessor instance (for geometryExtractor & sceneFeatures)
	 */
	constructor( sdfs ) {

		this.sdfs = sdfs;

		// Material storage buffer
		this.materialStorageAttr = null;
		this.materialStorageNode = null;
		this.materialCount = 0;

		// Consolidated size-bucketed material texture arrays (see SceneProcessor._bucketTextures):
		//   srgbBuckets[K]  — albedo + emissive  (SRGBColorSpace)
		//   linearBuckets[K] — normal/bump/roughness/metalness/displacement
		// Each entry is a DataArrayTexture | null (null = empty bucket).
		this.srgbBuckets = null;
		this.linearBuckets = null;

		// uuid → packed (bucket,layer) index maps for the current scene, handed over by the
		// SceneProcessor that built the buckets. Let runtime material edits (updateMaterial)
		// re-pack a texture's index against the current bucket layout.
		this._srgbTexPacked = null;
		this._linearTexPacked = null;

		// Compiled features cache (for change detection)
		this.compiledFeatures = null;

		/**
		 * Optional callbacks set by the owning stage.
		 * @type {{ onReset?: Function, onFeaturesChanged?: Function, getTriangleData?: Function, onTriangleDataChanged?: Function }}
		 */
		this.callbacks = {};

	}

	// ===== STORAGE BUFFER MANAGEMENT =====

	/**
	 * Sets material data from raw Float32Array via storage buffer.
	 * @param {Float32Array} matImageData
	 */
	setMaterialData( matImageData ) {

		if ( ! matImageData ) return;

		const vec4Count = matImageData.length / 4;

		if ( this.materialStorageNode ) {

			this.materialStorageAttr = new StorageInstancedBufferAttribute( matImageData, 4 );
			this.materialStorageNode.value = this.materialStorageAttr;
			this.materialStorageNode.bufferCount = vec4Count;

		} else {

			this.materialStorageAttr = new StorageInstancedBufferAttribute( matImageData, 4 );
			this.materialStorageNode = storage( this.materialStorageAttr, 'vec4', vec4Count ).toReadOnly();

		}

		this.materialCount = Math.floor( vec4Count / PIXELS_PER_MATERIAL );
		log.debug( `${fmt.n( this.materialCount )} materials (storage buffer)` );

	}

	/**
	 * Get the material storage attribute (for dependent stages).
	 * @returns {StorageInstancedBufferAttribute|null}
	 */
	getStorageAttr() {

		return this.materialStorageAttr;

	}

	/**
	 * Get the material storage node (for shader graph).
	 * @returns {import('three/tsl').StorageNode|null}
	 */
	getStorageNode() {

		return this.materialStorageNode;

	}

	// ===== TEXTURE ARRAYS =====

	/**
	 * Bulk-assign material texture array references.
	 * @param {Object} textures
	 */
	setMaterialTextures( textures ) {

		if ( textures.srgbBuckets ) this.srgbBuckets = textures.srgbBuckets;
		if ( textures.linearBuckets ) this.linearBuckets = textures.linearBuckets;

	}

	/**
	 * Receive the scene's uuid→packed texture-index maps (from the SceneProcessor that bucketed).
	 * @param {Map|null} srgb
	 * @param {Map|null} linear
	 */
	setTexturePackMaps( srgb, linear ) {

		this._srgbTexPacked = srgb || null;
		this._linearTexPacked = linear || null;

	}

	/**
	 * Packed (bucket, layer) index for a Three.js texture against the current bucket layout,
	 * or -1 if it isn't bucketed (a genuinely new texture → needs rebuildMaterials).
	 * @param {import('three').Texture|null} texture
	 * @param {boolean} isSrgb - true for albedo/emissive pool, false for the linear pool
	 * @returns {number}
	 */
	getPackedTextureIndex( texture, isSrgb ) {

		if ( ! texture ) return - 1;
		const uuid = texture.source?.uuid ?? texture.uuid;
		const map = isSrgb ? this._srgbTexPacked : this._linearTexPacked;
		const packed = map?.get( uuid );
		return packed === undefined ? - 1 : packed;

	}

	/**
	 * Load consolidated bucket arrays + pack maps from the SceneProcessor.
	 */
	loadTexturesFromSdfs() {

		this.srgbBuckets = this.sdfs.srgbBucketTextures;
		this.linearBuckets = this.sdfs.linearBucketTextures;
		this.setTexturePackMaps( this.sdfs._srgbTexPacked, this.sdfs._linearTexPacked );

	}

	/**
	 * Get the consolidated bucket arrays.
	 * @returns {{ srgbBuckets: Array, linearBuckets: Array }}
	 */
	getTextureArrays() {

		return {
			srgbBuckets: this.srgbBuckets,
			linearBuckets: this.linearBuckets,
		};

	}

	// ===== MATERIAL PROPERTY UPDATES =====

	/**
	 * Update a single material property in the storage buffer.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	updateMaterialProperty( materialIndex, property, value ) {

		if ( ! this.materialStorageAttr ) {

			log.warn( 'material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		switch ( property ) {

			case 'color':
				if ( value.r !== undefined ) {

					data[ stride + M.COLOR ] = value.r;
					data[ stride + M.COLOR + 1 ] = value.g;
					data[ stride + M.COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.COLOR ] = value[ 0 ];
					data[ stride + M.COLOR + 1 ] = value[ 1 ];
					data[ stride + M.COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'metalness': data[ stride + M.METALNESS ] = value; break;
			case 'emissive':
				if ( value.r !== undefined ) {

					data[ stride + M.EMISSIVE ] = value.r;
					data[ stride + M.EMISSIVE + 1 ] = value.g;
					data[ stride + M.EMISSIVE + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.EMISSIVE ] = value[ 0 ];
					data[ stride + M.EMISSIVE + 1 ] = value[ 1 ];
					data[ stride + M.EMISSIVE + 2 ] = value[ 2 ];

				}

				break;
			case 'roughness': data[ stride + M.ROUGHNESS ] = value; break;
			case 'ior': data[ stride + M.IOR ] = value; break;
			case 'transmission': data[ stride + M.TRANSMISSION ] = value; break;
			case 'thickness': data[ stride + M.THICKNESS ] = value; break;
			case 'emissiveIntensity': data[ stride + M.EMISSIVE_INTENSITY ] = value; break;
			case 'attenuationColor':
				if ( value.r !== undefined ) {

					data[ stride + M.ATTENUATION_COLOR ] = value.r;
					data[ stride + M.ATTENUATION_COLOR + 1 ] = value.g;
					data[ stride + M.ATTENUATION_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.ATTENUATION_COLOR ] = value[ 0 ];
					data[ stride + M.ATTENUATION_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.ATTENUATION_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'attenuationDistance': data[ stride + M.ATTENUATION_DISTANCE ] = value; break;
			case 'dispersion': data[ stride + M.DISPERSION ] = value; break;
			case 'sheen': data[ stride + M.SHEEN ] = value; break;
			case 'sheenRoughness': data[ stride + M.SHEEN_ROUGHNESS ] = value; break;
			case 'sheenColor':
				if ( value.r !== undefined ) {

					data[ stride + M.SHEEN_COLOR ] = value.r;
					data[ stride + M.SHEEN_COLOR + 1 ] = value.g;
					data[ stride + M.SHEEN_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.SHEEN_COLOR ] = value[ 0 ];
					data[ stride + M.SHEEN_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.SHEEN_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'specularIntensity': data[ stride + M.SPECULAR_INTENSITY ] = value; break;
			case 'specularColor':
				if ( value.r !== undefined ) {

					data[ stride + M.SPECULAR_COLOR ] = value.r;
					data[ stride + M.SPECULAR_COLOR + 1 ] = value.g;
					data[ stride + M.SPECULAR_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.SPECULAR_COLOR ] = value[ 0 ];
					data[ stride + M.SPECULAR_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.SPECULAR_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'iridescence': data[ stride + M.IRIDESCENCE ] = value; break;
			case 'iridescenceIOR': data[ stride + M.IRIDESCENCE_IOR ] = value; break;
			case 'iridescenceThicknessRange':
				if ( Array.isArray( value ) ) {

					data[ stride + M.IRIDESCENCE_THICKNESS_RANGE ] = value[ 0 ];
					data[ stride + M.IRIDESCENCE_THICKNESS_RANGE + 1 ] = value[ 1 ];

				}

				break;
			case 'clearcoat': data[ stride + M.CLEARCOAT ] = value; break;
			case 'clearcoatRoughness': data[ stride + M.CLEARCOAT_ROUGHNESS ] = value; break;
			case 'opacity': data[ stride + M.OPACITY ] = value; break;
			case 'side': data[ stride + M.SIDE ] = value;
				// Side is also mirrored into per-triangle data (NORMAL_C.w) so BVH
				// traversal can do side culling without reading the material buffer.
				this._patchTriangleSideForMaterial( materialIndex, value );
				break;
			case 'transparent': data[ stride + M.TRANSPARENT ] = value; break;
			case 'alphaTest': data[ stride + M.ALPHA_TEST ] = value; break;
			case 'alphaMode': data[ stride + M.ALPHA_MODE ] = value; break;
			case 'depthWrite': data[ stride + M.DEPTH_WRITE ] = value; break;
			case 'normalScale':
				if ( value.x !== undefined ) {

					data[ stride + M.NORMAL_SCALE ] = value.x;
					data[ stride + M.NORMAL_SCALE + 1 ] = value.y;

				} else if ( typeof value === 'number' ) {

					data[ stride + M.NORMAL_SCALE ] = value;
					data[ stride + M.NORMAL_SCALE + 1 ] = value;

				}

				break;
			case 'bumpScale': data[ stride + M.BUMP_SCALE ] = value; break;
			case 'displacementScale': data[ stride + M.DISPLACEMENT_SCALE ] = value; break;
			case 'subsurface': data[ stride + M.SUBSURFACE ] = value; break;
			case 'subsurfaceRadiusScale': data[ stride + M.SUBSURFACE_RADIUS_SCALE ] = value; break;
			case 'subsurfaceAnisotropy': data[ stride + M.SUBSURFACE_ANISOTROPY ] = value; break;
			case 'anisotropy': data[ stride + M.ANISOTROPY ] = value; break;
			case 'anisotropyRotation': data[ stride + M.ANISOTROPY_ROTATION ] = value; break;
			case 'subsurfaceColor':
				if ( value.r !== undefined ) {

					data[ stride + M.SUBSURFACE_COLOR ] = value.r;
					data[ stride + M.SUBSURFACE_COLOR + 1 ] = value.g;
					data[ stride + M.SUBSURFACE_COLOR + 2 ] = value.b;

				} else if ( Array.isArray( value ) ) {

					data[ stride + M.SUBSURFACE_COLOR ] = value[ 0 ];
					data[ stride + M.SUBSURFACE_COLOR + 1 ] = value[ 1 ];
					data[ stride + M.SUBSURFACE_COLOR + 2 ] = value[ 2 ];

				}

				break;
			case 'subsurfaceRadius':
				if ( Array.isArray( value ) ) {

					data[ stride + M.SUBSURFACE_RADIUS ] = value[ 0 ];
					data[ stride + M.SUBSURFACE_RADIUS + 1 ] = value[ 1 ];
					data[ stride + M.SUBSURFACE_RADIUS + 2 ] = value[ 2 ];

				} else if ( value.x !== undefined ) {

					data[ stride + M.SUBSURFACE_RADIUS ] = value.x;
					data[ stride + M.SUBSURFACE_RADIUS + 1 ] = value.y;
					data[ stride + M.SUBSURFACE_RADIUS + 2 ] = value.z;

				}

				break;
			default:
				log.warn( `unknown material property: ${property}` );
				return;

		}

		this.materialStorageAttr.needsUpdate = true;

		// Recompute triangle-data opaque-blocker flag when any input to it changes.
		if ( BLOCKER_PROPS.has( property ) ) {

			this._recomputeOpaqueBlockerForMaterial( materialIndex );

		}

		const featureProperties = [ 'transmission', 'clearcoat', 'sheen', 'iridescence', 'dispersion', 'transparent', 'opacity', 'alphaTest', 'subsurface' ];
		if ( featureProperties.includes( property ) ) {

			const featuresChanged = this.rescanMaterialFeatures();
			if ( featuresChanged ) {

				this._notifyFeaturesChanged();

			}

		}

		this._notifyReset();

	}

	/**
	 * Bulk-load an entire material object's data into the storage buffer.
	 * @param {number} materialIndex
	 * @param {Object} materialData
	 */
	updateMaterialDataFromObject( materialIndex, materialData ) {

		if ( ! this.materialStorageAttr ) {

			log.warn( 'material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		if ( materialData.color ) {

			data[ stride + M.COLOR ] = materialData.color.r ?? materialData.color[ 0 ] ?? 1;
			data[ stride + M.COLOR + 1 ] = materialData.color.g ?? materialData.color[ 1 ] ?? 1;
			data[ stride + M.COLOR + 2 ] = materialData.color.b ?? materialData.color[ 2 ] ?? 1;

		}

		data[ stride + M.METALNESS ] = materialData.metalness ?? 0;

		if ( materialData.emissive ) {

			data[ stride + M.EMISSIVE ] = materialData.emissive.r ?? materialData.emissive[ 0 ] ?? 0;
			data[ stride + M.EMISSIVE + 1 ] = materialData.emissive.g ?? materialData.emissive[ 1 ] ?? 0;
			data[ stride + M.EMISSIVE + 2 ] = materialData.emissive.b ?? materialData.emissive[ 2 ] ?? 0;

		}

		data[ stride + M.ROUGHNESS ] = materialData.roughness ?? 1;
		data[ stride + M.IOR ] = materialData.ior ?? 1.5;
		data[ stride + M.TRANSMISSION ] = materialData.transmission ?? 0;
		data[ stride + M.THICKNESS ] = materialData.thickness ?? 0.1;
		data[ stride + M.EMISSIVE_INTENSITY ] = materialData.emissiveIntensity ?? 1;

		if ( materialData.attenuationColor ) {

			data[ stride + M.ATTENUATION_COLOR ] = materialData.attenuationColor.r ?? materialData.attenuationColor[ 0 ] ?? 1;
			data[ stride + M.ATTENUATION_COLOR + 1 ] = materialData.attenuationColor.g ?? materialData.attenuationColor[ 1 ] ?? 1;
			data[ stride + M.ATTENUATION_COLOR + 2 ] = materialData.attenuationColor.b ?? materialData.attenuationColor[ 2 ] ?? 1;

		}

		data[ stride + M.ATTENUATION_DISTANCE ] = materialData.attenuationDistance ?? Infinity;
		data[ stride + M.DISPERSION ] = materialData.dispersion ?? 0;
		data[ stride + M.VISIBLE ] = 1; // Reserved slot (per-mesh visibility handled at BLAS-pointer level)
		data[ stride + M.SHEEN ] = materialData.sheen ?? 0;
		data[ stride + M.SHEEN_ROUGHNESS ] = materialData.sheenRoughness ?? 1;

		if ( materialData.sheenColor ) {

			data[ stride + M.SHEEN_COLOR ] = materialData.sheenColor.r ?? materialData.sheenColor[ 0 ] ?? 0;
			data[ stride + M.SHEEN_COLOR + 1 ] = materialData.sheenColor.g ?? materialData.sheenColor[ 1 ] ?? 0;
			data[ stride + M.SHEEN_COLOR + 2 ] = materialData.sheenColor.b ?? materialData.sheenColor[ 2 ] ?? 0;

		}

		data[ stride + M.SPECULAR_INTENSITY ] = materialData.specularIntensity ?? 1;

		if ( materialData.specularColor ) {

			data[ stride + M.SPECULAR_COLOR ] = materialData.specularColor.r ?? materialData.specularColor[ 0 ] ?? 1;
			data[ stride + M.SPECULAR_COLOR + 1 ] = materialData.specularColor.g ?? materialData.specularColor[ 1 ] ?? 1;
			data[ stride + M.SPECULAR_COLOR + 2 ] = materialData.specularColor.b ?? materialData.specularColor[ 2 ] ?? 1;

		}

		data[ stride + M.IRIDESCENCE ] = materialData.iridescence ?? 0;
		data[ stride + M.IRIDESCENCE_IOR ] = materialData.iridescenceIOR ?? 1.3;

		if ( materialData.iridescenceThicknessRange ) {

			data[ stride + M.IRIDESCENCE_THICKNESS_RANGE ] = materialData.iridescenceThicknessRange[ 0 ] ?? 100;
			data[ stride + M.IRIDESCENCE_THICKNESS_RANGE + 1 ] = materialData.iridescenceThicknessRange[ 1 ] ?? 400;

		}

		data[ stride + M.ALBEDO_MAP_INDEX ] = materialData.map ?? - 1;
		data[ stride + M.NORMAL_MAP_INDEX ] = materialData.normalMap ?? - 1;
		data[ stride + M.ROUGHNESS_MAP_INDEX ] = materialData.roughnessMap ?? - 1;
		data[ stride + M.METALNESS_MAP_INDEX ] = materialData.metalnessMap ?? - 1;
		data[ stride + M.EMISSIVE_MAP_INDEX ] = materialData.emissiveMap ?? - 1;
		data[ stride + M.BUMP_MAP_INDEX ] = materialData.bumpMap ?? - 1;

		data[ stride + M.CLEARCOAT ] = materialData.clearcoat ?? 0;
		data[ stride + M.CLEARCOAT_ROUGHNESS ] = materialData.clearcoatRoughness ?? 0;
		data[ stride + M.OPACITY ] = materialData.opacity ?? 1;
		data[ stride + M.SIDE ] = materialData.side ?? 0;
		// Mirror side into per-triangle data so BVH traversal avoids a material-buffer read.
		this._patchTriangleSideForMaterial( materialIndex, materialData.side ?? 0 );
		// Recompute shadow-ray opaque-blocker flag (reads alphaMode/transparent/transmission/opacity from buffer).
		this._recomputeOpaqueBlockerForMaterial( materialIndex );
		data[ stride + M.TRANSPARENT ] = materialData.transparent ?? 0;
		data[ stride + M.ALPHA_TEST ] = materialData.alphaTest ?? 0;
		data[ stride + M.ALPHA_MODE ] = materialData.alphaMode ?? 0;
		data[ stride + M.DEPTH_WRITE ] = materialData.depthWrite ?? 1;
		data[ stride + M.NORMAL_SCALE ] = materialData.normalScale?.x ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + M.NORMAL_SCALE + 1 ] = materialData.normalScale?.y ?? ( typeof materialData.normalScale === 'number' ? materialData.normalScale : 1 );
		data[ stride + M.BUMP_SCALE ] = materialData.bumpScale ?? 1;
		data[ stride + M.DISPLACEMENT_SCALE ] = materialData.displacementScale ?? 1;
		data[ stride + M.DISPLACEMENT_MAP_INDEX ] = materialData.displacementMap ?? - 1;

		// Subsurface scattering
		data[ stride + M.SUBSURFACE ] = materialData.subsurface ?? 0;
		if ( materialData.subsurfaceColor ) {

			data[ stride + M.SUBSURFACE_COLOR ] = materialData.subsurfaceColor.r ?? materialData.subsurfaceColor[ 0 ] ?? 1;
			data[ stride + M.SUBSURFACE_COLOR + 1 ] = materialData.subsurfaceColor.g ?? materialData.subsurfaceColor[ 1 ] ?? 1;
			data[ stride + M.SUBSURFACE_COLOR + 2 ] = materialData.subsurfaceColor.b ?? materialData.subsurfaceColor[ 2 ] ?? 1;

		}

		if ( materialData.subsurfaceRadius ) {

			data[ stride + M.SUBSURFACE_RADIUS ] = materialData.subsurfaceRadius[ 0 ] ?? 1;
			data[ stride + M.SUBSURFACE_RADIUS + 1 ] = materialData.subsurfaceRadius[ 1 ] ?? 0.2;
			data[ stride + M.SUBSURFACE_RADIUS + 2 ] = materialData.subsurfaceRadius[ 2 ] ?? 0.1;

		}

		data[ stride + M.SUBSURFACE_RADIUS_SCALE ] = materialData.subsurfaceRadiusScale ?? 1;
		data[ stride + M.SUBSURFACE_ANISOTROPY ] = materialData.subsurfaceAnisotropy ?? 0;

		// Surface specular anisotropy (map index defaults to -1 = none)
		data[ stride + M.ANISOTROPY ] = materialData.anisotropy ?? 0;
		data[ stride + M.ANISOTROPY_ROTATION ] = materialData.anisotropyRotation ?? 0;
		data[ stride + M.ANISOTROPY_MAP_INDEX ] = materialData.anisotropyMap ?? - 1;

		// Extension-texture map indices (packed bucket index, -1 = none)
		data[ stride + M.TRANSMISSION_MAP_INDEX ] = materialData.transmissionMap ?? - 1;
		data[ stride + M.CLEARCOAT_MAP_INDEX ] = materialData.clearcoatMap ?? - 1;
		data[ stride + M.CLEARCOAT_ROUGHNESS_MAP_INDEX ] = materialData.clearcoatRoughnessMap ?? - 1;
		data[ stride + M.SHEEN_COLOR_MAP_INDEX ] = materialData.sheenColorMap ?? - 1;
		data[ stride + M.SHEEN_ROUGHNESS_MAP_INDEX ] = materialData.sheenRoughnessMap ?? - 1;
		data[ stride + M.IRIDESCENCE_MAP_INDEX ] = materialData.iridescenceMap ?? - 1;
		data[ stride + M.IRIDESCENCE_THICKNESS_MAP_INDEX ] = materialData.iridescenceThicknessMap ?? - 1;
		data[ stride + M.SPECULAR_INTENSITY_MAP_INDEX ] = materialData.specularIntensityMap ?? - 1;
		data[ stride + M.SPECULAR_COLOR_MAP_INDEX ] = materialData.specularColorMap ?? - 1;

		// Texture transformation matrices (8 floats per slot = matrix elements[0..7];
		// element[8]=1 is reconstructed on the GPU by arrayToMat3, so it is NOT stored —
		// writing a 9th float here would spill into the next slot / subsurfaceColor).
		const identity = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
		const transformEntries = [
			{ key: 'mapMatrix', offset: M.ALBEDO_TRANSFORM },
			{ key: 'normalMapMatrices', offset: M.NORMAL_TRANSFORM },
			{ key: 'roughnessMapMatrices', offset: M.ROUGHNESS_TRANSFORM },
			{ key: 'metalnessMapMatrices', offset: M.METALNESS_TRANSFORM },
			{ key: 'emissiveMapMatrices', offset: M.EMISSIVE_TRANSFORM },
			{ key: 'bumpMapMatrices', offset: M.BUMP_TRANSFORM },
			{ key: 'displacementMapMatrices', offset: M.DISPLACEMENT_TRANSFORM }
		];

		for ( const { key, offset } of transformEntries ) {

			const matrix = materialData[ key ] ?? identity;
			for ( let i = 0; i < 8; i ++ ) {

				if ( stride + offset + i < data.length ) {

					data[ stride + offset + i ] = matrix[ i ];

				}

			}

		}

		this.materialStorageAttr.needsUpdate = true;

		const featuresChanged = this.rescanMaterialFeatures();
		if ( featuresChanged ) {

			this._notifyFeaturesChanged();

		}

		this._notifyReset();

	}

	/**
	 * Convenience wrapper: convert a Three.js Material to data and update storage.
	 * @param {number} materialIndex
	 * @param {import('three').Material} material
	 */
	updateMaterial( materialIndex, material ) {

		const completeMaterialData = this.sdfs.geometryExtractor.createMaterialObject( material );

		// createMaterialObject returns stale per-type indices; re-pack each map to the packed
		// (bucket, layer) index for the CURRENT bucket layout. -1 for a texture not yet bucketed
		// (a genuinely new map → the caller must rebuildMaterials to add it to a bucket array).
		if ( this._srgbTexPacked || this._linearTexPacked ) {

			completeMaterialData.map = this.getPackedTextureIndex( material.map, true );
			completeMaterialData.emissiveMap = this.getPackedTextureIndex( material.emissiveMap, true );
			completeMaterialData.normalMap = this.getPackedTextureIndex( material.normalMap, false );
			completeMaterialData.bumpMap = this.getPackedTextureIndex( material.bumpMap, false );
			completeMaterialData.roughnessMap = this.getPackedTextureIndex( material.roughnessMap, false );
			completeMaterialData.metalnessMap = this.getPackedTextureIndex( material.metalnessMap, false );
			completeMaterialData.displacementMap = this.getPackedTextureIndex( material.displacementMap, false );
			completeMaterialData.anisotropyMap = this.getPackedTextureIndex( material.anisotropyMap, false );
			// Extension maps — color maps (sheenColor, specularColor) are sRGB; the rest are data (linear)
			completeMaterialData.transmissionMap = this.getPackedTextureIndex( material.transmissionMap, false );
			completeMaterialData.clearcoatMap = this.getPackedTextureIndex( material.clearcoatMap, false );
			completeMaterialData.clearcoatRoughnessMap = this.getPackedTextureIndex( material.clearcoatRoughnessMap, false );
			completeMaterialData.sheenColorMap = this.getPackedTextureIndex( material.sheenColorMap, true );
			completeMaterialData.sheenRoughnessMap = this.getPackedTextureIndex( material.sheenRoughnessMap, false );
			completeMaterialData.iridescenceMap = this.getPackedTextureIndex( material.iridescenceMap, false );
			completeMaterialData.iridescenceThicknessMap = this.getPackedTextureIndex( material.iridescenceThicknessMap, false );
			completeMaterialData.specularIntensityMap = this.getPackedTextureIndex( material.specularIntensityMap, false );
			completeMaterialData.specularColorMap = this.getPackedTextureIndex( material.specularColorMap, true );

		}

		this.updateMaterialDataFromObject( materialIndex, completeMaterialData );

	}

	/**
	 * Update texture transform matrix for a material's texture slot.
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Array<number>} transformMatrix - 9-element matrix
	 */
	updateTextureTransform( materialIndex, textureName, transformMatrix ) {

		if ( ! this.materialStorageAttr ) {

			log.warn( 'material storage buffer not available' );
			return;

		}

		const data = this.materialStorageAttr.array;
		const stride = materialIndex * M.FLOATS_PER_MATERIAL;

		const transformOffsets = {
			'map': M.ALBEDO_TRANSFORM,
			'normalMap': M.NORMAL_TRANSFORM,
			'roughnessMap': M.ROUGHNESS_TRANSFORM,
			'metalnessMap': M.METALNESS_TRANSFORM,
			'emissiveMap': M.EMISSIVE_TRANSFORM,
			'bumpMap': M.BUMP_TRANSFORM,
			'displacementMap': M.DISPLACEMENT_TRANSFORM
		};

		const offset = transformOffsets[ textureName ];
		if ( offset === undefined ) {

			log.warn( `unknown texture name for transform update: ${textureName}` );
			return;

		}

		// 8 floats per slot (matrix elements[0..7]); element[8]=1 is GPU-reconstructed.
		// Writing 9 would clobber the next transform slot's first element.
		for ( let i = 0; i < 8; i ++ ) {

			if ( stride + offset + i < data.length ) {

				data[ stride + offset + i ] = transformMatrix[ i ];

			}

		}

		this.materialStorageAttr.needsUpdate = true;
		this._notifyReset();

	}

	// ===== FEATURE SCANNING =====

	/**
	 * Scan all materials to detect which advanced features are in use.
	 * @returns {boolean} True if features changed
	 */
	rescanMaterialFeatures() {

		if ( ! this.materialStorageAttr?.array ) {

			log.warn( 'material storage buffer not available for feature scanning' );
			return false;

		}

		const data = this.materialStorageAttr.array;
		const materialCount = this.sdfs.materialCount || 1;

		const newFeatures = {
			hasClearcoat: false,
			hasTransmission: false,
			hasDispersion: false,
			hasIridescence: false,
			hasSheen: false,
			hasTransparency: false,
			hasSubsurface: false,
			hasMultiLobeMaterials: false,
			hasMRTOutputs: true
		};

		for ( let i = 0; i < materialCount; i ++ ) {

			const stride = i * M.FLOATS_PER_MATERIAL;

			const transmission = data[ stride + M.TRANSMISSION ];
			const dispersion = data[ stride + M.DISPERSION ];
			const sheen = data[ stride + M.SHEEN ];
			const iridescence = data[ stride + M.IRIDESCENCE ];
			const clearcoat = data[ stride + M.CLEARCOAT ];
			const opacity = data[ stride + M.OPACITY ];
			const transparent = data[ stride + M.TRANSPARENT ];
			const alphaTest = data[ stride + M.ALPHA_TEST ];
			const subsurface = data[ stride + M.SUBSURFACE ];

			if ( clearcoat > 0 ) newFeatures.hasClearcoat = true;
			if ( transmission > 0 ) newFeatures.hasTransmission = true;
			if ( dispersion > 0 ) newFeatures.hasDispersion = true;
			if ( iridescence > 0 ) newFeatures.hasIridescence = true;
			if ( sheen > 0 ) newFeatures.hasSheen = true;
			if ( transparent > 0 || opacity < 1.0 || alphaTest > 0 ) newFeatures.hasTransparency = true;
			if ( subsurface > 0 ) newFeatures.hasSubsurface = true;

			const featureCount = [
				clearcoat > 0,
				transmission > 0,
				iridescence > 0,
				sheen > 0
			].filter( Boolean ).length;

			if ( featureCount >= 2 ) {

				newFeatures.hasMultiLobeMaterials = true;

			}

		}

		const oldFeaturesJSON = JSON.stringify( this.sdfs.sceneFeatures );
		const newFeaturesJSON = JSON.stringify( newFeatures );
		const changed = oldFeaturesJSON !== newFeaturesJSON;

		if ( changed ) {

			this.sdfs.sceneFeatures = newFeatures;

		}

		return changed;

	}

	/**
	 * Inject shader preprocessor defines based on detected features.
	 */
	injectMaterialFeatureDefines() {

		const features = this.sdfs.sceneFeatures;

		if ( ! features ) {

			log.warn( 'no sceneFeatures detected, skipping define injection' );
			return;

		}

		const featuresJSON = JSON.stringify( features );
		const featuresChanged = ! this.compiledFeatures || this.compiledFeatures !== featuresJSON;

		if ( ! featuresChanged ) {

			return;

		}

		// For TSL, we can't inject defines into the shader at runtime
		// Instead, we would need to conditionally generate the shader
		// For now, log the features for debugging
		log.debug( 'material features:', features );

		this.compiledFeatures = featuresJSON;

	}

	// ===== PRIVATE CALLBACKS =====

	/** @private */
	_notifyReset() {

		if ( this.callbacks.onReset ) {

			this.callbacks.onReset();

		}

	}

	/** @private */
	_notifyFeaturesChanged() {

		this.injectMaterialFeatureDefines();

	}

	/**
	 * Rewrite the per-triangle `side` flag (NORMAL_C.w) for every triangle whose
	 * materialIndex matches. Linear over triangles because there's no reverse
	 * index — side edits are a rare UI action so the scan cost is acceptable.
	 * @private
	 */
	/**
	 * Re-derive the shadow-ray opaque-blocker flag for a material from its
	 * current buffer values and patch NORMAL_A.w on every matching triangle.
	 * Kept in sync with the blocker definition in GeometryExtractor.
	 * @private
	 */
	_recomputeOpaqueBlockerForMaterial( materialIndex ) {

		const matBuf = this.materialStorageAttr?.array;
		if ( ! matBuf ) return;

		const matStride = materialIndex * M.FLOATS_PER_MATERIAL;
		const alphaMode = matBuf[ matStride + M.ALPHA_MODE ] | 0;
		const transparent = matBuf[ matStride + M.TRANSPARENT ] | 0;
		const transmission = matBuf[ matStride + M.TRANSMISSION ] || 0;
		const opacity = matBuf[ matStride + M.OPACITY ] ?? 1;
		const isOpaqueBlocker = ( alphaMode === 0 && transparent === 0 && transmission === 0 && opacity >= 1 ) ? 1.0 : 0.0;

		this._patchTriangleFlagForMaterial( materialIndex, TRI_BLOCKER_OFFSET, isOpaqueBlocker );

	}

	/**
	 * Generic helper: patch a single per-triangle float at `triOffset` for every
	 * triangle whose materialIndex matches, then fire onTriangleDataChanged.
	 * @private
	 */
	_patchTriangleFlagForMaterial( materialIndex, triOffset, value ) {

		const triInfo = this.callbacks.getTriangleData?.();
		const triData = triInfo?.array;
		const triCount = triInfo?.count | 0;
		if ( ! triData || triCount === 0 ) return;

		const stride = T.FLOATS_PER_TRIANGLE;
		let patched = 0;
		for ( let i = 0; i < triCount; i ++ ) {

			const base = i * stride;
			if ( triData[ base + TRI_MAT_IDX_OFFSET ] === materialIndex ) {

				triData[ base + triOffset ] = value;
				patched ++;

			}

		}

		if ( patched > 0 && this.callbacks.onTriangleDataChanged ) {

			this.callbacks.onTriangleDataChanged();

		}

	}

	_patchTriangleSideForMaterial( materialIndex, sideValue ) {

		this._patchTriangleFlagForMaterial( materialIndex, TRI_SIDE_OFFSET, sideValue );

	}

	// ===== DISPOSAL =====

	dispose() {

		this.materialStorageAttr = null;
		this.materialStorageNode = null;
		this.materialCount = 0;
		this.srgbBuckets = null;
		this.linearBuckets = null;
		this._srgbTexPacked = null;
		this._linearTexPacked = null;
		this.compiledFeatures = null;

	}

}
