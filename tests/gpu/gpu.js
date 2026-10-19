import { WebGPURenderer } from 'three/webgpu';
import { Fn, instanceIndex, instancedArray } from 'three/tsl';
import { withSceneResources } from '@/core/TSL/SceneResources.js';

// A missing adapter is a broken setup, never a reason to pass: CI installs Mesa's software Vulkan driver.
const unavailable = globalThis.__rayzeeGPUUnavailable;
if ( unavailable ) throw new Error( `tests/gpu needs a WebGPU adapter: ${unavailable}` );

// A Mesa Vulkan driver, as CI's lavapipe describes itself: 'llvmpipe: Mesa 25.2.8 …'.
export const mesa = /\bMesa\b/.test( globalThis.__rayzeeGPUDescription );

function headlessCanvas() {

	let configuration = null;
	const context = {
		configure: ( config ) => void ( configuration = config ),
		unconfigure: () => void ( configuration = null ),
		getConfiguration: () => configuration,
	};

	return {
		width: 1, height: 1, style: {},
		getContext: ( type ) => ( type === 'webgpu' ? context : null ),
		addEventListener() {}, removeEventListener() {},
	};

}

export async function createRenderer() {

	const renderer = new WebGPURenderer( { canvas: headlessCanvas() } );
	await renderer.init();
	return renderer;

}

/**
 * Runs `fn` once per element on the GPU and returns the ArrayBuffer it wrote.
 * @param {Object<string, [ArrayLike<number>, string]>} inputs - name → [ data, TSL element type ]
 * @param {function(Object<string, Node>): Node} fn - gets each input's element by name
 * @param {{materialLayers?: Object<string, boolean>}} [resources] - the kernel's scene resources (SceneResources.js)
 */
export async function evaluate( renderer, count, inputs, outType, fn, resources = null ) {

	const buffers = Object.entries( inputs ).map( ( [ name, [ data, type ]] ) => [ name, instancedArray( data, type ) ] );
	const out = instancedArray( count, outType );

	const body = Fn( () => {

		const args = Object.fromEntries( buffers.map( ( [ name, buffer ] ) => [ name, buffer.element( instanceIndex ) ] ) );
		out.element( instanceIndex ).assign( fn( args ) );

	} )();
	const kernel = ( resources ? withSceneResources( body, resources ) : body ).compute( count );

	await renderer.computeAsync( kernel );
	return renderer.getArrayBufferAsync( out.value );

}
