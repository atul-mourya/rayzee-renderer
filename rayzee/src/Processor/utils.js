import { SphereGeometry, Mesh, MeshPhysicalMaterial, Group, Object3D, Color, Vector3, ShaderMaterial, Vector2, Matrix4, GLSL3 } from 'three';
import { QuadMesh } from 'three/webgpu';
import { EngineEvents } from '../EngineEvents.js';

/** Every QuadMesh in the realm shares this one geometry (module-level in three). */
const _sharedQuadGeometry = /*@__PURE__*/ new QuadMesh( null ).geometry;

let _statusCallback = null;

/**
 * Set the callback that receives loading/stats events.
 * Called by PathTracerApp during initialization to wire events to the engine's EventDispatcher.
 */
export function setStatusCallback( cb ) {

	_statusCallback = cb;

}

export const resetLoading = () => _statusCallback?.( { type: EngineEvents.LOADING_RESET } );

export const updateLoading = ( loadingState ) => {

	_statusCallback?.( { type: EngineEvents.LOADING_UPDATE, ...loadingState } );

};

export const updateStats = ( statsUpdate ) => {

	_statusCallback?.( { type: EngineEvents.STATS_UPDATE, ...statsUpdate } );

};

// Raw frameCount is the user-facing sample count (one full-frame pass per frame).
export function getDisplaySamples( pathTracerStage ) {

	return pathTracerStage.frameCount || 0;

}

export function getNearestPowerOf2( size ) {

	return Math.pow( 2, Math.ceil( Math.log2( size ) ) );

}

export function disposeMaterial( material ) {

	if ( Array.isArray( material ) ) {

		material.forEach( mat => {

			if ( mat.userData && mat.userData.isFallback ) return;
			disposeMaterialTextures( mat );
			mat.dispose();

		} );

	} else {

		if ( material.userData && material.userData.isFallback ) return;
		disposeMaterialTextures( material );
		material.dispose();

	}

}

export function disposeMaterialTextures( material ) {

	if ( ! material ) return;

	const textures = [
		'alphaMap', 'aoMap', 'bumpMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'displacementMap',
		'emissiveMap', 'envMap', 'gradientMap', 'lightMap', 'map', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap',
		'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'thicknessMap', 'transmissionMap'
	];

	textures.forEach( texture => {

		if ( material[ texture ] ) {

			material[ texture ].dispose();
			material[ texture ] = null;

		}

	} );

}

export function distroyBuffers( { material, geometry, children } ) {

	material && disposeMaterial( material );
	geometry && geometry.dispose();

	if ( children.length > 0 ) {

		for ( const child of children ) {

			distroyBuffers( child );

		}

	}

}

/**
 * Disposes a renderer without leaking it.
 *
 * Three.js 0.184–0.185: `Renderer.dispose()` does not remove the 'resize' listener
 * it installs on `_canvasTarget`. The bound handler closes over the renderer,
 * pinning the entire WebGPU graph (Backend, Nodes, Bindings, Pipelines, GPUDevice,
 * every TSL node) alive indefinitely — confirmed via heap-snapshot retainer
 * analysis. See three/src/renderers/common/Renderer.js:292 (attach) and :2503
 * (dispose — missing removal).
 *
 * Renderers constructed with an external `device` do not destroy it here; three
 * only destroys a device it created itself.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 */
export function disposeRenderer( renderer ) {

	if ( ! renderer ) return;

	if ( renderer._canvasTarget && renderer._onCanvasTargetResize ) {

		renderer._canvasTarget.removeEventListener( 'resize', renderer._onCanvasTargetResize );

	}

	renderer.dispose();
	renderer._canvasTarget = null;

	// Three.js 0.185: `RenderObjects.dispose()` drops its chain maps without disposing the
	// render objects, so each one leaves behind the 'dispose' listener it registered on its
	// geometry. Full-screen passes render a QuadMesh, and every QuadMesh in the realm shares
	// one module-level geometry — so that listener list grows by one entry per renderer and
	// keeps RenderObject → RenderObjects → Bindings → Backend → GPUDevice reachable for the
	// page's lifetime. The chain maps are WeakMaps, so this list is the only handle on them.
	//
	// Clearing it also drops entries belonging to live renderers, which is safe: the
	// singleton geometry is never disposed, so none of these listeners can ever fire.
	const quadDisposeListeners = _sharedQuadGeometry._listeners?.dispose;
	if ( quadDisposeListeners ) quadDisposeListeners.length = 0;

}

export function disposeObjectFromMemory( object, exeptions = [] ) {

	if ( ! object ) return;
	if ( exeptions.includes( object.name ) || object.isScene ) return;

	if ( object.isMaterial ) {

		disposeMaterial( object );
		return;

	}

	while ( object.children.length > 0 ) {

		for ( const child of object.children ) {

			disposeObjectFromMemory( child );

		}

	}

	distroyBuffers( object );

	object.removeFromParent();
	object.clear();

}



/**
 Metalness (increases left to right):
   0.00  0.25  0.50  0.75  1.00
   +-----------------------------> X
 1 |  o     o     o     o     o
   |
0.75  o     o     o     o     o
   |
0.50  o     o     o     o     o
   |
0.25  o     o     o     o     o
   |
 0 |  o     o     o     o     o
   v
   Y

Roughness (decreases bottom to top)

Legend:
o : Sphere
X : Metalness axis
Y : Roughness axis

Example sphere properties:
Top-left     : Metalness 0.00, Roughness 1.00 (Matte)
Top-right    : Metalness 1.00, Roughness 1.00 (Rough Metal)
Bottom-left  : Metalness 0.00, Roughness 0.00 (Glossy Dielectric)
Bottom-right : Metalness 1.00, Roughness 0.00 (Polished Metal)
Center       : Metalness 0.50, Roughness 0.50 (Semi-glossy, Semi-metallic)
 */

export function generateMaterialSpheres( rows = 5, columns = 5, spacing = 1.2 ) {

	const sphereGroup = new Group();
	const sphereGeometry = new SphereGeometry( 0.5, 32, 32 );

	for ( let i = 0; i < rows; i ++ ) {

		for ( let j = 0; j < columns; j ++ ) {

			const material = new MeshPhysicalMaterial( {
				metalness: j / ( columns - 1 ),
				roughness: i / ( rows - 1 ),
				color: 0xFFD700
			} );

			const sphere = new Mesh( sphereGeometry, material );
			sphere.position.set(
				( j - ( columns - 1 ) / 2 ) * spacing,
				( i - ( rows - 1 ) / 2 ) * spacing,
				0
			);

			// Add a label to the sphere
			const label = new Object3D();
			label.name = `Metalness: ${material.metalness.toFixed( 2 )}, Roughness: ${material.roughness.toFixed( 2 )}`;
			sphere.add( label );

			sphereGroup.add( sphere );

		}

	}

	return sphereGroup;

}

// ── Path Tracer Utilities (formerly PathTracerUtils static class) ──

export function updateCompletionThreshold( renderMode, maxFrames ) {

	return maxFrames;

}

export function createDebounceFunction( callback, delay ) {

	let timeoutId = null;
	let pendingValue = null;

	return function ( value ) {

		if ( timeoutId ) {

			clearTimeout( timeoutId );

		}

		pendingValue = value;
		timeoutId = setTimeout( () => {

			if ( pendingValue !== null ) {

				callback( pendingValue );

			}

			timeoutId = null;
			pendingValue = null;

		}, delay );

	};

}

export function createPathTracingMaterial( options ) {

	const {
		vertexShader,
		fragmentShader,
		uniforms = {},
		defines = {}
	} = options;

	return new ShaderMaterial( {
		name: 'PathTracingShader',
		defines: {
			MAX_SPHERE_COUNT: 0,
			MAX_DIRECTIONAL_LIGHTS: 0,
			MAX_AREA_LIGHTS: 0,
			MAX_POINT_LIGHTS: 0,
			MAX_SPOT_LIGHTS: 0,
			ENABLE_ACCUMULATION: '',
			...defines
		},
		uniforms: {
			resolution: { value: new Vector2() },
			cameraWorldMatrix: { value: new Matrix4() },
			cameraProjectionMatrixInverse: { value: new Matrix4() },
			frame: { value: 0 },
			...uniforms
		},
		vertexShader,
		fragmentShader,
		glslVersion: GLSL3
	} );

}

export function validateAndUpdateUniforms( material, updates ) {

	let hasChanges = false;

	Object.entries( updates ).forEach( ( [ key, value ] ) => {

		if ( material.uniforms[ key ] &&
			! areValuesEqual( material.uniforms[ key ].value, value ) ) {

			material.uniforms[ key ].value = value;
			hasChanges = true;

		}

	} );

	return hasChanges;

}

export function areValuesEqual( a, b ) {

	if ( a === b ) return true;

	if ( a && b && typeof a.equals === 'function' ) {

		return a.equals( b );

	}

	if ( Array.isArray( a ) && Array.isArray( b ) ) {

		if ( a.length !== b.length ) return false;
		return a.every( ( val, index ) => areValuesEqual( val, b[ index ] ) );

	}

	if ( a && b && typeof a === 'object' && typeof b === 'object' ) {

		const keysA = Object.keys( a );
		const keysB = Object.keys( b );
		if ( keysA.length !== keysB.length ) return false;
		return keysA.every( key => areValuesEqual( a[ key ], b[ key ] ) );

	}

	return false;

}

export function calculateAccumulationAlpha( frameValue, isInteractionMode = false ) {

	// Full-frame progressive accumulation: each frame is one complete pass.
	return isInteractionMode ? 1.0 : 1.0 / ( frameValue + 1 );

}

export function createPerformanceMonitor() {

	let startTime = 0;
	let endTime = 0;
	let frameCount = 0;
	let totalTime = 0;

	return {
		start() {

			startTime = performance.now();

		},

		end() {

			endTime = performance.now();
			const frameTime = endTime - startTime;
			totalTime += frameTime;
			frameCount ++;
			return frameTime;

		},

		getAverageFrameTime() {

			return frameCount > 0 ? totalTime / frameCount : 0;

		},

		getFPS() {

			const avgFrameTime = this.getAverageFrameTime();
			return avgFrameTime > 0 ? 1000 / avgFrameTime : 0;

		},

		reset() {

			frameCount = 0;
			totalTime = 0;

		}
	};

}

export function optimizeShaderDefines( defines, state ) {

	const optimized = { ...defines };

	if ( ! state.enableAccumulation ) {

		delete optimized.ENABLE_ACCUMULATION;

	}

	if ( state.sphereCount === 0 ) {

		optimized.MAX_SPHERE_COUNT = 0;

	}

	return optimized;

}

export function clamp( value, min, max ) {

	return Math.min( Math.max( value, min ), max );

}

export function lerp( a, b, t ) {

	return a + ( b - a ) * clamp( t, 0, 1 );

}

export function isRenderComplete( frameValue, renderMode, maxFrames ) {

	return frameValue >= maxFrames;

}

export function getCurrentSampleCount( frameValue ) {

	return frameValue;

}

export function formatDuration( milliseconds ) {

	if ( milliseconds < 1000 ) {

		return `${milliseconds.toFixed( 0 )}ms`;

	}

	const seconds = milliseconds / 1000;
	if ( seconds < 60 ) {

		return `${seconds.toFixed( 1 )}s`;

	}

	const minutes = Math.floor( seconds / 60 );
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds.toFixed( 0 )}s`;

}

export function createLRUCache( maxSize ) {

	const cache = new Map();

	return {
		get( key ) {

			if ( cache.has( key ) ) {

				const value = cache.get( key );
				cache.delete( key );
				cache.set( key, value );
				return value;

			}

			return undefined;

		},

		set( key, value ) {

			if ( cache.has( key ) ) {

				cache.delete( key );

			} else if ( cache.size >= maxSize ) {

				const firstKey = cache.keys().next().value;
				cache.delete( firstKey );

			}

			cache.set( key, value );

		},

		clear() {

			cache.clear();

		},

		size() {

			return cache.size;

		}
	};

}

export function getDisneyUniforms( material ) {

	// Default Disney BRDF uniform values
	const defaults = {
		baseColor: new Color( 0xffffff ),
		subsurface: 0.0,
		metallic: 0.0,
		specular: 0.5,
		specularTint: 0.0,
		roughness: 0.5,
		anisotropic: 0.0,
		sheen: 0.0,
		sheenTint: 0.5,
		clearcoat: 0.0,
		clearcoatGloss: 0.0,
		ior: 1.5,
		transmission: 0.0,
		opacity: 1.0,
		emissive: new Color( 0x000000 ),
		emissiveIntensity: 1.0
	};

	// Initialize uniforms object with default values wrapped in uniform objects
	const uniforms = Object.entries( defaults ).reduce( ( acc, [ key, value ] ) => {

		acc[ key ] = { value: value };
		return acc;

	}, {} );

	// If no material is provided, return default uniforms
	if ( ! material ) return uniforms;

	// Map material properties to Disney uniforms
	if ( material.isMeshStandardMaterial ) {

		uniforms.baseColor.value = material.color;
		uniforms.roughness.value = material.roughness;
		uniforms.metallic.value = material.metallic;
		uniforms.emissive.value = material.emissive;
		uniforms.emissiveIntensity.value = material.emissiveIntensity;
		uniforms.opacity.value = material.opacity;

		// Extract maps if they exist
		if ( material.map ) {

			uniforms.baseColorMap = { value: material.map };

		}

		if ( material.roughnessMap ) {

			uniforms.roughnessMap = { value: material.roughnessMap };

		}

		if ( material.metalnessMap ) {

			uniforms.metallicMap = { value: material.metalnessMap };

		}

		if ( material.normalMap ) {

			uniforms.normalMap = { value: material.normalMap };
			uniforms.normalScale = { value: material.normalScale };

		}

		if ( material.emissiveMap ) {

			uniforms.emissiveMap = { value: material.emissiveMap };

		}

	} else if ( material.isMeshPhysicalMaterial ) {

		// Include all MeshStandardMaterial properties
		uniforms.baseColor.value = material.color;
		uniforms.roughness.value = material.roughness;
		uniforms.metallic.value = material.metallic;
		uniforms.emissive.value = material.emissive;
		uniforms.emissiveIntensity.value = material.emissiveIntensity;
		uniforms.opacity.value = material.opacity;

		// Add physical material specific properties
		uniforms.clearcoat.value = material.clearcoat;
		uniforms.clearcoatGloss.value = 1 - material.clearcoatRoughness;
		uniforms.ior.value = material.ior;
		uniforms.transmission.value = material.transmission;

		// Extract maps
		if ( material.clearcoatMap ) {

			uniforms.clearcoatMap = { value: material.clearcoatMap };

		}

		if ( material.clearcoatRoughnessMap ) {

			uniforms.clearcoatGlossMap = { value: material.clearcoatRoughnessMap };

		}

		if ( material.clearcoatNormalMap ) {

			uniforms.clearcoatNormalMap = { value: material.clearcoatNormalMap };

		}

		if ( material.transmissionMap ) {

			uniforms.transmissionMap = { value: material.transmissionMap };

		}

	} else if ( material.isMeshBasicMaterial ||
             material.isMeshLambertMaterial ||
             material.isMeshPhongMaterial ) {

		// Basic conversion for simpler materials
		uniforms.baseColor.value = material.color;
		uniforms.opacity.value = material.opacity;
		uniforms.emissive.value = material.emissive || new Color( 0x000000 );

		// Estimate roughness and metallic from shininess if available
		if ( 'shininess' in material ) {

			uniforms.roughness.value = 1 - Math.min( 1, material.shininess / 100 );
			uniforms.specular.value = material.specular ?
				( material.specular.r + material.specular.g + material.specular.b ) / 3 :
				0.5;

		}

		// Extract maps
		if ( material.map ) {

			uniforms.baseColorMap = { value: material.map };

		}

	}

	// Add common Three.js uniform values needed for shading
	uniforms.cameraPosition = { value: new Vector3() };
	uniforms.time = { value: 0 };

	return uniforms;

}

