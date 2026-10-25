import { create } from 'zustand';
import * as THREE from 'three';
import { translucencyToScale, SSS_PRESETS } from '@/Constants';
import { deriveAlphaMode } from 'rayzee';
import { getApp } from '@/lib/appProxy';
import { useStore } from './ui.js';

// Material store
export const useMaterialStore = create( ( set, get ) => ( {
	updateMaterialProperty: ( prop, val ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		try {

			obj.material[ prop ] = val;
			obj.material.needsUpdate = true;

			const idx = obj.userData?.materialIndex ?? 0;
			const app = getApp();
			if ( ! app ) {

				console.warn( "Path tracer not available" );
				return;

			}

			app.setMaterialProperty( idx, prop, val );


		} catch ( error ) {

			console.error( `Error updating material property ${prop}:`, error );

		}

	},

	// Texture property handlers - update texture transforms in material data texture
	handleTextureOffsetChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].offset.set( value.x, value.y );
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture offset for ${textureName}:`, error );

		}

	},

	handleTextureRepeatChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].repeat.set( value.x, value.y );
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture repeat for ${textureName}:`, error );

		}

	},

	handleTextureFlipYChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].flipY = value;
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture flipY for ${textureName}:`, error );

		}

	},

	handleTextureRotationChange: ( textureName, value ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material || ! obj.material[ textureName ] ) return;

		try {

			// Update the actual texture
			obj.material[ textureName ].rotation = value * Math.PI / 180; // Convert degrees to radians
			obj.material[ textureName ].needsUpdate = true;

			// Update the material data texture with the new transform
			get().updateTextureTransform( textureName, obj.material[ textureName ] );

		} catch ( error ) {

			console.error( `Error updating texture rotation for ${textureName}:`, error );

		}

	},

	updateTextureTransform: ( textureName, texture ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material ) return;

		const materialIndex = obj.userData?.materialIndex ?? 0;
		const app = getApp();

		if ( ! app ) {

			console.warn( "Path tracer not available" );
			return;

		}

		// Create transform matrix from texture properties
		const transform = new Float32Array( 9 ); // 3x3 matrix
		const sx = texture.repeat.x;
		const sy = texture.repeat.y;
		const ox = texture.offset.x;
		const oy = texture.offset.y;
		const rotation = texture.rotation ?? 0; // rotation in radians

		// Calculate rotation matrix components
		const cos = Math.cos( rotation );
		const sin = Math.sin( rotation );

		// Combined transform matrix with rotation, scale, and offset
		// T * R * S where T = translation, R = rotation, S = scale
		// [sx*cos  -sx*sin  ox]
		// [sy*sin   sy*cos  oy]
		// [0        0       1 ]
		transform[ 0 ] = sx * cos; // m00
		transform[ 1 ] = - sx * sin; // m01
		transform[ 2 ] = ox; // m02
		transform[ 3 ] = sy * sin; // m10
		transform[ 4 ] = sy * cos; // m11
		transform[ 5 ] = oy; // m12
		transform[ 6 ] = 0; // m20
		transform[ 7 ] = 0; // m21
		transform[ 8 ] = 1; // m22

		// Update the appropriate transform in material data texture
		app.setTextureTransform( materialIndex, textureName, transform );

	},

	// Material handlers (shortened)
	handleColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.color ) {

			obj.material.color.set( val );
			get().updateMaterialProperty( 'color', obj.material.color );

		}

	},
	handleRoughnessChange: val => get().updateMaterialProperty( 'roughness', val[ 0 ] ),
	handleMetalnessChange: val => get().updateMaterialProperty( 'metalness', val[ 0 ] ),
	handleDiffuseRoughnessChange: val => get().updateMaterialProperty( 'diffuseRoughness', val[ 0 ] ),
	handleIorChange: val => get().updateMaterialProperty( 'ior', val[ 0 ] ),
	handleTransmissionChange: val => get().updateMaterialProperty( 'transmission', val[ 0 ] ),
	handleAttenuationColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;
		if ( ! obj.material.attenuationColor?.isColor ) obj.material.attenuationColor = new THREE.Color();
		obj.material.attenuationColor.set( val );
		get().updateMaterialProperty( 'attenuationColor', obj.material.attenuationColor );

	},
	// The control spells "off" as 0 (and can hand back a string or NaN mid-edit); the material
	// stores glTF/three.js's Infinity. The engine normalizes both to its `0 = off` buffer contract.
	handleAttenuationDistanceChange: val => {

		const d = Number( val );
		get().updateMaterialProperty( 'attenuationDistance', Number.isFinite( d ) && d > 0 ? d : Infinity );

	},
	handleDispersionChange: val => get().updateMaterialProperty( 'dispersion', val[ 0 ] ),
	handleSubsurfaceChange: val => get().updateMaterialProperty( 'subsurface', val[ 0 ] ),
	handleSubsurfaceAnisotropyChange: val => get().updateMaterialProperty( 'subsurfaceAnisotropy', val[ 0 ] ),
	handleSubsurfaceColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;
		if ( ! obj.material.subsurfaceColor?.isColor ) obj.material.subsurfaceColor = new THREE.Color( val );
		else obj.material.subsurfaceColor.set( val );
		get().updateMaterialProperty( 'subsurfaceColor', obj.material.subsurfaceColor );

	},
	handleSubsurfaceRadiusChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;
		const arr = Array.isArray( val ) ? val : [ val.x, val.y, val.z ];
		obj.material.subsurfaceRadius = arr;
		get().updateMaterialProperty( 'subsurfaceRadius', arr );

	},
	// Artist-facing translucency dial → drives the engine's radius-scale multiplier.
	handleSubsurfaceTranslucencyChange: val => get().updateMaterialProperty( 'subsurfaceRadiusScale', translucencyToScale( val[ 0 ] ) ),
	handleDiffuseTransmissionChange: val => get().updateMaterialProperty( 'diffuseTransmission', val[ 0 ] ),
	handleDiffuseTransmissionColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.material ) return;
		// An engine property three.js does not have, so the Color may not exist yet.
		if ( ! obj.material.diffuseTransmissionColor?.isColor ) obj.material.diffuseTransmissionColor = new THREE.Color( val );
		else obj.material.diffuseTransmissionColor.set( val );
		get().updateMaterialProperty( 'diffuseTransmissionColor', obj.material.diffuseTransmissionColor );

	},
	// Apply a named SSS preset. The radius is derived from the object's world-space size so the
	// look is scale-invariant: radius = ratio × bboxDiagonal × depth (see SSS_PRESETS).
	applySubsurfacePreset: presetName => {

		const preset = SSS_PRESETS.find( p => p.name === presetName );
		if ( ! preset ) return;
		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;
		const app = getApp();
		if ( ! app ) return;

		const mat = obj.material;
		const idx = obj.userData?.materialIndex ?? 0;

		// World-space size → scale-invariant radius.
		obj.updateWorldMatrix( true, false );
		const size = new THREE.Box3().setFromObject( obj ).getSize( new THREE.Vector3() );
		const diag = size.length() || 1;
		const r = diag * preset.depth;
		const radius = [ r * preset.radius[ 0 ], r * preset.radius[ 1 ], r * preset.radius[ 2 ] ];

		const setProp = ( prop, value ) => {

			mat[ prop ] = value;
			app.setMaterialProperty( idx, prop, value );

		};

		setProp( 'metalness', 0 );
		setProp( 'roughness', preset.roughness );
		setProp( 'ior', preset.ior );
		setProp( 'subsurface', preset.weight );
		setProp( 'subsurfaceRadius', radius );
		setProp( 'subsurfaceRadiusScale', 1.0 );
		setProp( 'subsurfaceAnisotropy', preset.g );

		if ( ! mat.subsurfaceColor?.isColor ) mat.subsurfaceColor = new THREE.Color();
		mat.subsurfaceColor.set( preset.scatter );
		app.setMaterialProperty( idx, 'subsurfaceColor', mat.subsurfaceColor );

		if ( preset.base ) {

			mat.color.set( preset.base );
			app.setMaterialProperty( idx, 'color', mat.color );

		}

		mat.needsUpdate = true;
		// Refresh the Material panel so its sliders re-read the preset values.
		window.dispatchEvent( new Event( 'MaterialUpdate' ) );
		app.reset();

	},
	handleEmissiveIntensityChange: val => get().updateMaterialProperty( 'emissiveIntensity', val[ 0 ] ),
	handleClearcoatChange: val => get().updateMaterialProperty( 'clearcoat', val[ 0 ] ),
	handleClearcoatRoughnessChange: val => get().updateMaterialProperty( 'clearcoatRoughness', val[ 0 ] ),
	handleOpacityChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		// Update opacity property
		const opacity = val[ 0 ];
		obj.material.opacity = opacity;
		get().updateMaterialProperty( 'opacity', opacity );

		get().syncAlphaMode();

	},
	handleSideChange: val => get().updateMaterialProperty( 'side', val ),
	handleEmissiveChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.emissive ) {

			obj.material.emissive.set( val );
			get().updateMaterialProperty( 'emissive', obj.material.emissive );

		}

	},
	handleTransparentChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		// Update transparent property
		obj.material.transparent = val;
		get().updateMaterialProperty( 'transparent', val ? 1 : 0 );

		get().syncAlphaMode();

	},
	handleAlphaTestChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		obj.material.alphaTest = val[ 0 ];
		get().updateMaterialProperty( 'alphaTest', val[ 0 ] );
		get().syncAlphaMode();

	},

	/**
	 * Re-derive alphaMode from the material's current alpha inputs. Every control that touches
	 * transparency has to call this: alphaMode is the only alpha field the shader reads, so a
	 * control that moves alphaTest/transparent/opacity without it is inert.
	 */
	syncAlphaMode: () => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		get().updateMaterialProperty( 'alphaMode', deriveAlphaMode( obj.material ) );

	},
	handleSheenChange: val => get().updateMaterialProperty( 'sheen', val[ 0 ] ),
	handleSheenRoughnessChange: val => get().updateMaterialProperty( 'sheenRoughness', val[ 0 ] ),
	handleAnisotropyChange: val => get().updateMaterialProperty( 'anisotropy', val[ 0 ] ),
	// Slider is in degrees; the material/engine expect radians.
	handleAnisotropyRotationChange: val => get().updateMaterialProperty( 'anisotropyRotation', val[ 0 ] * Math.PI / 180 ),
	handleSheenColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.sheenColor ) {

			obj.material.sheenColor.set( val );
			get().updateMaterialProperty( 'sheenColor', obj.material.sheenColor );

		}

	},
	handleSpecularIntensityChange: val => get().updateMaterialProperty( 'specularIntensity', val[ 0 ] ),
	handleSpecularColorChange: val => {

		const obj = useStore.getState().selectedObject;
		if ( obj?.material?.specularColor ) {

			obj.material.specularColor.set( val );
			get().updateMaterialProperty( 'specularColor', obj.material.specularColor );

		}

	},
	handleIridescenceChange: val => get().updateMaterialProperty( 'iridescence', val[ 0 ] ),
	handleIridescenceIORChange: val => get().updateMaterialProperty( 'iridescenceIOR', val[ 0 ] ),
	handleIridescenceThicknessRangeChange: val => get().updateMaterialProperty( 'iridescenceThicknessRange', val ),
	handleNormalScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		get().updateMaterialProperty( 'normalScale', value );

		// Also update the material object directly for UI consistency
		const obj = useStore.getState().selectedObject;
		if ( obj?.material ) {

			obj.material.normalScale = value;
			obj.material.needsUpdate = true;

		}

	},
	handleBumpScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		get().updateMaterialProperty( 'bumpScale', value );

		// Also update the material object directly for UI consistency
		const obj = useStore.getState().selectedObject;
		if ( obj?.material ) {

			obj.material.bumpScale = value;
			obj.material.needsUpdate = true;

		}

	},

	// Displacement mapping handlers
	handleDisplacementScaleChange: val => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;
		const material = useStore.getState().selectedObject?.material;
		if ( ! material ) return;

		// The grey that stays on the surface, kept through a drag to 0 and back.
		const midLevel = material.displacementScale
			? - ( material.displacementBias ?? 0 ) / material.displacementScale
			: material.userData.displacementMidLevel ?? 0;
		material.userData.displacementMidLevel = midLevel;
		get().updateMaterialProperty( 'displacementScale', value );
		get().updateMaterialProperty( 'displacementBias', - midLevel * value );

	},

	/**
	 * Toggle material feature groups on/off with smart default values.
	 *
	 * This handler enables or disables material feature groups (clearcoat, volumetric/transmission,
	 * iridescence, sheen, dispersion) by updating the main feature property and applying sensible
	 * defaults for supporting properties when enabling.
	 *
	 * Strategy:
	 * - When enabling: Set main property to default value, apply smart defaults for supporting properties
	 * - When disabling: Only set main property to 0, preserve supporting properties for next enable
	 *
	 * @param {string} featureName - Feature to toggle: 'clearcoat', 'volumetric', 'iridescence', 'sheen', 'dispersion'
	 * @param {boolean} enabled - True to enable feature, false to disable
	 *
	 * @example
	 * // Enable transmission with smart defaults
	 * handleToggleFeature('volumetric', true);
	 * // Sets: transmission=1.0, ior=1.5 (if unset)
	 *
	 * // Disable transmission
	 * handleToggleFeature('volumetric', false);
	 * // Sets: transmission=0, preserves ior and attenuation values
	 */

	/**
	 * Change or add a texture on the selected material.
	 * Loads the image file, assigns it to the material slot, and triggers a full material rebuild.
	 * @param {string} textureName - Material texture slot (e.g., 'map', 'normalMap', 'roughnessMap')
	 * @param {File} file - Image file from file input
	 */
	handleTextureChange: async ( textureName, file ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		let url;
		try {

			const { TextureLoader, RepeatWrapping, SRGBColorSpace, LinearSRGBColorSpace } = await import( 'three' );
			url = URL.createObjectURL( file );
			const loader = new TextureLoader();
			const newTexture = await loader.loadAsync( url );

			// Configure texture
			newTexture.wrapS = RepeatWrapping;
			newTexture.wrapT = RepeatWrapping;
			newTexture.name = file.name;

			// Albedo/emissive maps use sRGB; others use linear
			const srgbMaps = [ 'map', 'emissiveMap' ];
			newTexture.colorSpace = srgbMaps.includes( textureName )
				? SRGBColorSpace
				: LinearSRGBColorSpace;

			// Preserve existing transform if replacing
			const existing = obj.material[ textureName ];
			if ( existing?.isTexture ) {

				newTexture.offset.copy( existing.offset );
				newTexture.repeat.copy( existing.repeat );
				newTexture.rotation = existing.rotation;
				existing.dispose();

			}

			// Assign to material
			obj.material[ textureName ] = newTexture;
			obj.material.needsUpdate = true;

			// Rebuild all material textures on the GPU
			const app = getApp();
			if ( app ) {

				await app.rebuildMaterials();
				app.reset();

			}

			// Notify UI
			window.dispatchEvent( new Event( 'MaterialUpdate' ) );

		} catch ( error ) {

			console.error( `Error changing texture ${textureName}:`, error );

		} finally {

			if ( url ) URL.revokeObjectURL( url );

		}

	},

	/**
	 * Remove a texture from the selected material slot.
	 * @param {string} textureName - Material texture slot to clear
	 */
	handleTextureRemove: async ( textureName ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		try {

			const existing = obj.material[ textureName ];
			if ( existing?.isTexture ) existing.dispose();

			obj.material[ textureName ] = null;
			obj.material.needsUpdate = true;

			const app = getApp();
			if ( app ) {

				await app.rebuildMaterials();
				app.reset();

			}

			window.dispatchEvent( new Event( 'MaterialUpdate' ) );

		} catch ( error ) {

			console.error( `Error removing texture ${textureName}:`, error );

		}

	},

	handleToggleFeature: ( featureName, enabled ) => {

		const obj = useStore.getState().selectedObject;
		if ( ! obj?.isMesh || ! obj.material ) return;

		// Enabling subsurface applies a scale-correct default preset — the raw defaults
		// ([1,0.2,0.1] world units) are microscopic at most object scales, so SSS would
		// look invisible. A preset sizes the radius to this object so it reads immediately.
		if ( featureName === 'subsurface' && enabled ) {

			get().applySubsurfacePreset( 'wax' );
			return;

		}

		try {

			// Feature default values and property mappings
			// Strategy: Only set main property when toggling, preserve supporting properties
			const FEATURE_CONFIGS = {
				clearcoat: {
					properties: {
						clearcoat: enabled ? 1.0 : 0
						// Preserve clearcoatRoughness - only set main property
					},
					// Set sensible defaults for supporting properties when enabling (only if currently 0)
					smartDefaults: enabled ? {
						clearcoatRoughness: { value: 0.1, condition: () => obj.material.clearcoatRoughness === 0 }
					} : {}
				},
				volumetric: {
					properties: {
						transmission: enabled ? 1.0 : 0
						// Preserve ior, attenuationDistance - only set main property
					},
					// Set sensible defaults for supporting properties when enabling (only if currently 0)
					smartDefaults: enabled ? {
						// A MeshStandardMaterial carries no `ior` at all, so an undefined value has to
						// count as unset — otherwise the engine's load-time metal default (2.5) sticks.
						ior: { value: 1.5, condition: () => ! ( obj.material.ior > 1.0 ) }
					} : {},
					colorDefaults: enabled ? {
						attenuationColor: { value: '#ffffff', condition: () => true }
					} : {}
				},
				subsurface: {
					// Enabling routes through applySubsurfacePreset (scale-correct radius + look),
					// so only the disable path reaches here — no smart/color defaults needed.
					properties: {
						subsurface: enabled ? 1.0 : 0
					}
				},
				iridescence: {
					properties: {
						iridescence: enabled ? 0.5 : 0
					},
					smartDefaults: enabled ? {
						iridescenceIOR: { value: 1.3, condition: () => obj.material.iridescenceIOR === 1.0 },
						iridescenceThicknessRange: { value: [ 100, 400 ], condition: () => obj.material.iridescenceThicknessRange?.[ 0 ] === 0 }
					} : {}
				},
				sheen: {
					properties: {
						sheen: enabled ? 0.5 : 0
					},
					smartDefaults: enabled ? {
						sheenRoughness: { value: 0.5, condition: () => obj.material.sheenRoughness === 0 }
					} : {},
					colorDefaults: enabled ? {
						sheenColor: { value: '#ffffff', condition: () => true }
					} : {}
				},
				anisotropy: {
					properties: {
						anisotropy: enabled ? 0.5 : 0
					}
				},
				translucency: {
					properties: {
						diffuseTransmission: enabled ? 0.5 : 0
					},
					colorDefaults: enabled ? {
						diffuseTransmissionColor: { value: '#ffffff', condition: () => ! obj.material.diffuseTransmissionColor?.isColor }
					} : {}
				},
				dispersion: {
					properties: {
						dispersion: enabled ? 0.02 : 0
					}
				},
				transparency: {
					properties: {
						transparent: enabled ? 1 : 0, // Store as number for material texture
						opacity: enabled ? ( obj.material.opacity === 1.0 ? 0.5 : obj.material.opacity ) : 1.0
					// Preserve alphaTest - only set main properties
					},
					smartDefaults: enabled ? {
						alphaTest: { value: 0, condition: () => true } // Ensure alphaTest is 0 when using opacity
					} : {}
				}
			};

			const config = FEATURE_CONFIGS[ featureName ];
			if ( ! config ) {

				console.warn( `Unknown feature: ${featureName}` );
				return;

			}

			// Update main feature properties
			Object.entries( config.properties ).forEach( ( [ prop, value ] ) => {

				// Always set the property, even if it doesn't exist yet
				// This allows enabling features that weren't initially configured
				obj.material[ prop ] = value;
				get().updateMaterialProperty( prop, value );

			} );

			// Apply smart defaults (only when enabling and condition is met)
			if ( config.smartDefaults ) {

				Object.entries( config.smartDefaults ).forEach( ( [ prop, { value, condition } ] ) => {

					// Always set if condition is met, even if property doesn't exist yet
					if ( condition() ) {

						obj.material[ prop ] = value;
						get().updateMaterialProperty( prop, value );

					}

				} );

			}

			// Apply color defaults
			if ( config.colorDefaults ) {

				Object.entries( config.colorDefaults ).forEach( ( [ prop, { value: hexValue, condition } ] ) => {

					if ( condition() ) {

						// Initialize Color object if it doesn't exist
						if ( ! obj.material[ prop ]?.isColor ) {

							obj.material[ prop ] = new THREE.Color( hexValue );

						} else {

							obj.material[ prop ].set( hexValue );

						}

						get().updateMaterialProperty( prop, obj.material[ prop ] );

					}

				} );

			}

			// Force material update
			obj.material.needsUpdate = true;

			// Force Zustand store update by updating selectedObject reference
			// This ensures React components re-render with the new material values
			set( { selectedObject: obj } );

			// Trigger shader recompilation by resetting the path tracer
			const app = getApp();
			if ( app ) {

				app.reset();
				app.reset();

			}

			// Dispatch event for UI update (important for reactive state)
			window.dispatchEvent( new Event( 'MaterialUpdate' ) );


		} catch ( error ) {

			console.error( `Error toggling feature ${featureName}:`, error );

		}

	},

} ) );
