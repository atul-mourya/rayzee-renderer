/**
 * The kernels carry the traversal stack the tree they were built for needed. A tree that needs more (an added object, a
 * BLAS rebuilt in place) rebuilds them; one that needs less keeps them until the next build.
 */
import { describe, it, expect, vi } from 'vitest';
import { PathTracer } from '@/core/pathtracer/PathTracer.js';

// Only what render() reads before the rebuild: no layers to add, no light or fog change. Built kernels leave it at the
// stop test.
function makeStage( compiled, needed ) {

	return Object.assign( Object.create( PathTracer.prototype ), {
		isReady: true,
		_wavefrontReady: true,
		isComplete: true,
		_lightBufferRealloc: false,
		_outputsChanged: false,
		numPointLights: { value: 0 },
		numSpotLights: { value: 0 },
		_compiledLightRadius: false,
		fogDensity: { value: 0 },
		_compiledFog: false,
		_compiledStack: compiled,
		bvhStorageAttr: { traversalStack: needed },
		_kernelManager: { dispose: vi.fn() },
		_buildWavefrontKernels: vi.fn( function () {

			this._wavefrontReady = true;
			this._outputsChanged = false;
			this._compiledStack = this._stackNeeded();

		} ),
	} );

}

describe( 'traversal stack rebuild', () => {

	it( 'rebuilds the kernels for a tree that needs a deeper stack, once', () => {

		const stage = makeStage( 40, 48 );
		stage.render();
		stage.render();
		expect( stage._buildWavefrontKernels ).toHaveBeenCalledTimes( 1 );
		expect( stage._compiledStack ).toBe( 48 );

	} );

	it( 'keeps them for a tree that needs no more', () => {

		for ( const needed of [ 40, 48, undefined ] ) {

			const stage = makeStage( 48, needed );
			stage.render();
			expect( stage._buildWavefrontKernels ).not.toHaveBeenCalled();

		}

	} );

} );
