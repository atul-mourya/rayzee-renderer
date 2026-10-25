import { create } from 'zustand';
import { DEFAULT_STATE } from '@/Constants';
import { getApp } from '@/lib/appProxy';

// Light store
export const useLightStore = create( set => ( {
	...DEFAULT_STATE,
	showLightHelper: DEFAULT_STATE.showLightHelper,
	lights: [],
	selectedLightIndex: null,
	setSelectedLightIndex: idx => set( { selectedLightIndex: idx } ),
	setLights: lights => set( { lights } ),
	updateLight: ( idx, prop, val ) => set( s => {

		const lights = [ ...s.lights ];
		if ( ! lights[ idx ] ) return s;

		// React Compiler memoises components by prop reference — mutating the
		// descriptor in place keeps the same reference and skips re-renders.
		// Always replace lights[idx] with a fresh object so children re-render.
		const value = Array.isArray( val ) ? val[ 0 ] : val;
		lights[ idx ] = { ...lights[ idx ], [ prop ]: value };

		// Square/disk area lights drive both dimensions from a single "Size"
		// control, and switching to a uniform shape collapses height onto width.
		if ( prop === 'size' ) {

			delete lights[ idx ].size;
			lights[ idx ].width = value;
			lights[ idx ].height = value;

		} else if ( prop === 'shape' && ( value === 'square' || value === 'disk' ) ) {

			lights[ idx ].height = lights[ idx ].width;

		}

		// Update the actual Three.js light object
		const app = getApp();

		if ( app ) {

			const light = app.scene.getObjectByProperty( 'uuid', lights[ idx ].uuid );
			if ( light ) {

				if ( prop === 'intensity' ) {

					light.intensity = value;

				} else if ( prop === 'visible' ) {

					light.visible = !! value;

				} else if ( prop === 'color' ) {

					light.color.set( value );

				} else if ( prop === 'position' ) {

					const pos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
					light.position.set( ...pos );

				} else if ( prop === 'angle' ) {

					// UI is degrees, engine is radians. Spot cone half-angle is a real three.js
					// property; the sun's angular diameter is ours, so it goes on userData —
					// see the matching read in LightManager._buildDescriptor.
					if ( light.type === 'SpotLight' ) {

						light.angle = value * ( Math.PI / 180 );

					} else if ( light.type === 'DirectionalLight' ) {

						light.userData.angle = value * ( Math.PI / 180 );

					}

				} else if ( prop === 'target' ) {

					if ( light.type === 'SpotLight' ) {

						const targetPos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
						light.target.position.set( ...targetPos );
						light.target.updateMatrixWorld();

					} else if ( light.type === 'RectAreaLight' ) {

						const targetPos = Array.isArray( val ) ? val : [ value.x || value[ 0 ], value.y || value[ 1 ], value.z || value[ 2 ] ];
						light.lookAt( ...targetPos );
						light.updateMatrixWorld();

					}

				} else if ( prop === 'width' || prop === 'height' ) {

					if ( light.type === 'RectAreaLight' ) {

						light[ prop ] = value;

					}

				} else if ( prop === 'size' ) {

					if ( light.type === 'RectAreaLight' ) {

						light.width = value;
						light.height = value;

					}

				} else if ( prop === 'normalize' || prop === 'spread' || prop === 'shape' ) {

					if ( light.type === 'RectAreaLight' ) {

						if ( prop === 'spread' ) {

							// UI is degrees; engine stores radians on userData.
							light.userData.spread = value * ( Math.PI / 180 );

						} else if ( prop === 'normalize' ) {

							light.userData.normalize = !! value;

						} else {

							light.userData.shape = value; // 'square' | 'rectangle' | 'disk' | 'ellipse'
							if ( value === 'square' || value === 'disk' ) light.height = light.width;

						}

					}

				} else if ( prop === 'temperature' || prop === 'useTemperature' || prop === 'exposure' ) {

					// Blender-style emission tint/stops — applies to every light type.
					light.userData[ prop ] = prop === 'useTemperature' ? !! value : value;

				} else if ( prop === 'distance' || prop === 'penumbra' || prop === 'decay' ) {

					if ( light.type === 'SpotLight' || ( prop !== 'penumbra' && light.type === 'PointLight' ) ) {

						light[ prop ] = value;

					}

				} else if ( prop === 'ies' || prop === 'iesIntensity' ) {

					if ( light.type === 'SpotLight' && app.iesManager ) {

						if ( prop === 'ies' ) {

							const current = lights[ idx ].iesIntensity ?? 1.0;
							const result = app.iesManager.setSpotLightProfile( light.uuid, value || null, current );
							lights[ idx ].iesIntensity = current;

							// Mirror engine-applied auto values back into the store so
							// the corresponding sliders + readouts reflect the new state.
							if ( result?.suggestedAngle != null ) lights[ idx ].angle = result.suggestedAngle * 180 / Math.PI;
							if ( result?.suggestedPenumbra != null ) lights[ idx ].penumbra = result.suggestedPenumbra;
							if ( result?.suggestedDecay != null ) lights[ idx ].decay = result.suggestedDecay;
							lights[ idx ].fixtureLumens = value ? ( result?.fixtureLumens ?? null ) : null;

						} else {

							const name = lights[ idx ].ies || null;
							if ( name ) app.iesManager.setSpotLightProfile( light.uuid, name, value, { applyAutoCone: false } );

						}

					}

				} else if ( prop === 'gobo' || prop === 'goboIntensity' || prop === 'goboInverted' || prop === 'goboScale' ) {

					const goboCompat = light.type === 'SpotLight' || light.type === 'DirectionalLight';
					if ( goboCompat && app.goboManager ) {

						if ( prop === 'gobo' ) {

							const current = lights[ idx ].goboIntensity ?? 1.0;
							const inverted = lights[ idx ].goboInverted ?? false;
							const scale = lights[ idx ].goboScale ?? 5.0;
							app.goboManager.setLightGobo( light.uuid, value || null, { intensity: current, inverted, scale } );
							lights[ idx ].goboIntensity = current;
							if ( ! value ) lights[ idx ].goboInverted = false;

						} else if ( prop === 'goboIntensity' ) {

							const name = lights[ idx ].gobo || null;
							const inverted = lights[ idx ].goboInverted ?? false;
							const scale = lights[ idx ].goboScale ?? 5.0;
							if ( name ) app.goboManager.setLightGobo( light.uuid, name, { intensity: value, inverted, scale } );

						} else if ( prop === 'goboInverted' ) {

							app.goboManager.setLightGoboInverted( light.uuid, !! value );

						} else if ( prop === 'goboScale' ) {

							app.goboManager.setLightGoboScale( light.uuid, value );

						}

					}

				}

				if ( app.lightManager?.sync ) {

					app.lightManager.sync();

				}

				app.reset();

			}

		}

		return { lights };

	} ),

	// Add light to scene
	addLight: ( lightType ) => {

		const app = getApp();
		if ( ! app ) return;

		const newLight = app.lightManager.add( lightType );
		if ( newLight ) {

			set( s => ( { lights: [ ...s.lights, newLight ], selectedLightIndex: s.lights.length } ) );
			window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

		}

	},

	// Remove light from scene
	removeLight: ( lightIndex ) => {

		const app = getApp();
		if ( ! app ) return;

		set( s => {

			if ( lightIndex < 0 || lightIndex >= s.lights.length ) return s;

			const lightToRemove = s.lights[ lightIndex ];
			const success = app.lightManager.remove( lightToRemove.uuid );

			if ( success ) {

				window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );
				const newLights = s.lights.filter( ( _, idx ) => idx !== lightIndex );
				let newSelected = s.selectedLightIndex;
				if ( newSelected === lightIndex ) {

					newSelected = newLights.length > 0 ? Math.min( lightIndex, newLights.length - 1 ) : null;

				} else if ( newSelected !== null && newSelected > lightIndex ) {

					newSelected = newSelected - 1;

				}

				return { lights: newLights, selectedLightIndex: newSelected };

			}

			return s;

		} );

	},

	// Toggle area light helper visibility
	handleShowLightHelperChange: ( val ) => {

		set( { showLightHelper: val } );
		const app = getApp();
		if ( app ) {

			app.lightManager.showHelpers( val );
			app.refreshFrame();

		}

	},

	// Clear all lights
	clearAllLights: () => {

		const app = getApp();
		if ( ! app ) return;

		app.lightManager.clear();
		set( { lights: [], selectedLightIndex: null } );
		window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );

	},
} ) );
