import { SphereGeometry, Mesh, MeshPhysicalMaterial, Group, Object3D, ShaderMaterial, Vector2, Matrix4, GLSL3, Box3 } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { EngineEvents } from './EngineEvents.js';

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

// A message: unlike a timer it is not throttled in a background tab, and unlike scheduler.yield it queues behind the
// page's own timers and posted renders instead of running ahead of them.
function nextTask() {

	if ( typeof MessageChannel === 'undefined' ) return new Promise( resolve => setTimeout( resolve, 0 ) );
	return new Promise( resolve => {

		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {

			port1.close();
			resolve();

		};

		port2.postMessage( null );

	} );

}

/**
 * For a long loop on the main thread: the returned function gives the page one task turn, to redraw, once `ms` have
 * passed since the last, and returns null in between.
 */
export function timeSlicer( ms = 50 ) {

	let since = performance.now();
	const resume = () => {

		since = performance.now();

	};

	return () => ( performance.now() - since < ms ? null : nextTask().then( resume ) );

}

/** InstancedMesh.computeBoundingBox, bit for bit, for each instanced mesh under `object` without a box yet. */
export function computeInstanceBoundingBoxes( object ) {

	object.traverse( mesh => {

		if ( ! mesh.isInstancedMesh || mesh.boundingBox !== null ) return;
		const geometry = mesh.geometry;
		if ( geometry.boundingBox === null ) geometry.computeBoundingBox();
		const box = mesh.boundingBox = new Box3();
		const local = geometry.boundingBox;
		if ( local.isEmpty() ) return;

		const xs = [ local.min.x, local.max.x ], ys = [ local.min.y, local.max.y ], zs = [ local.min.z, local.max.z ];
		const m = mesh.instanceMatrix.array;
		let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = - Infinity, y1 = - Infinity, z1 = - Infinity;
		for ( let i = 0, o = 0; i < mesh.count; i ++, o += 16 ) {

			const e0 = m[ o ], e1 = m[ o + 1 ], e2 = m[ o + 2 ], e3 = m[ o + 3 ], e4 = m[ o + 4 ], e5 = m[ o + 5 ], e6 = m[ o + 6 ], e7 = m[ o + 7 ];
			const e8 = m[ o + 8 ], e9 = m[ o + 9 ], e10 = m[ o + 10 ], e11 = m[ o + 11 ], e12 = m[ o + 12 ], e13 = m[ o + 13 ], e14 = m[ o + 14 ], e15 = m[ o + 15 ];
			for ( let c = 0; c < 8; c ++ ) {

				const x = xs[ c >> 2 ], y = ys[ ( c >> 1 ) & 1 ], z = zs[ c & 1 ];
				// Vector3.applyMatrix4's operations, in its order.
				const w = 1 / ( e3 * x + e7 * y + e11 * z + e15 );
				const px = ( e0 * x + e4 * y + e8 * z + e12 ) * w;
				const py = ( e1 * x + e5 * y + e9 * z + e13 ) * w;
				const pz = ( e2 * x + e6 * y + e10 * z + e14 ) * w;
				x0 = Math.min( x0, px ); y0 = Math.min( y0, py ); z0 = Math.min( z0, pz );
				x1 = Math.max( x1, px ); y1 = Math.max( y1, py ); z1 = Math.max( z1, pz );

			}

		}

		box.min.set( x0, y0, z0 );
		box.max.set( x1, y1, z1 );

	} );

}

// Raw frameCount is the user-facing sample count (one full-frame pass per frame).
export function getDisplaySamples( pathTracerStage ) {

	return pathTracerStage.frameCount || 0;

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
		'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'thicknessMap', 'transmissionMap',
		'diffuseTransmissionMap', 'diffuseTransmissionColorMap',
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
 * A second renderer on `device` — the view overlay's, a saved picture's. Its backend claims the device's single
 * uncaptured-error slot during init(); that is handed back, so the owner's handler keeps receiving errors.
 * @param {GPUDevice} device
 * @param {Object} parameters - WebGPURenderer's, `canvas` among them
 */
export async function createRendererOnDevice( device, parameters ) {

	const handler = device.onuncapturederror;
	const renderer = new WebGPURenderer( { ...parameters, device } );
	await renderer.init();
	device.onuncapturederror = handler;
	renderer.setPixelRatio( 1.0 );
	return renderer;

}

/**
 * Disposes a renderer without leaking it.
 *
 * Three.js 0.184–0.186: `Renderer.dispose()` does not remove the 'resize' listener
 * it installs on `_canvasTarget`. The bound handler closes over the renderer,
 * pinning the entire WebGPU graph (Backend, Nodes, Bindings, Pipelines, GPUDevice,
 * every TSL node) alive indefinitely — confirmed via heap-snapshot retainer
 * analysis. See `Renderer.js` (attach in the constructor, still absent from
 * `dispose()` in r186). Re-check on every upgrade; drop this when upstream fixes it.
 *
 * Renderers constructed with an external `device` do not destroy it here; three
 * only destroys a device it created itself.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @returns {?Promise<void>} Settles once the backend is torn down.
 */
export function disposeRenderer( renderer ) {

	if ( ! renderer ) return;

	if ( renderer._canvasTarget && renderer._onCanvasTargetResize ) {

		renderer._canvasTarget.removeEventListener( 'resize', renderer._onCanvasTargetResize );

	}

	// r186+ `dispose()` is async and settles once the backend is torn down; anything that
	// measures memory straight afterwards has to await the returned promise.
	const disposed = renderer.dispose();
	renderer._canvasTarget = null;
	return disposed;

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

/** Frees only geometry the engine allocated inside an adopted model; the rest is the host's. */
export function disposeEngineOwnedResources( object ) {

	object?.traverse( ( child ) => {

		if ( child.geometry?.userData?.__rayzeeOwned ) child.geometry.dispose();

	} );

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
