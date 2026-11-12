import { describe, it, expect, vi, afterEach } from 'vitest';
import { Matrix4 } from 'three';
import { NormalDepth } from '@/core/viewer/denoise/NormalDepth.js';

const KEYS = [ 'pathtracer:normalDepth', 'pathtracer:prevNormalDepth', 'pathtracer:shadingNormal' ];

function stage() {

	let finish;
	const renderer = {
		compileComputeAsync: vi.fn( () => new Promise( r => ( finish = r ) ) ),
		compute: vi.fn(),
		copyTextureToTexture: vi.fn(),
	};
	const pathTracer = { uniforms: { get: () => ( { value: new Matrix4() } ) } };
	const nd = new NormalDepth( renderer, { pathTracer, width: 4, height: 4 } );
	nd._syncStorageBuffers = () => true;
	nd.cameraRay.sync = () => {};

	const textures = new Map( KEYS.map( k => [ k, { stale: true } ] ) );
	const context = {
		setTexture: ( k, v ) => textures.set( k, v ),
		getTexture: k => textures.get( k ),
		removeTexture: k => textures.delete( k ),
	};
	return { nd, renderer, context, textures, finish: () => finish() };

}

afterEach( () => vi.unstubAllGlobals() );

describe( 'NormalDepth — its pass compiles', () => {

	it( 'in the background, and runs once compiled', async () => {

		vi.stubGlobal( 'requestAnimationFrame', () => 0 );
		const { nd, renderer, context, textures, finish } = stage();

		nd.render( context );
		expect( renderer.compileComputeAsync ).toHaveBeenCalledWith( nd._computeNode );
		expect( renderer.compute ).not.toHaveBeenCalled();
		expect( nd.compiling ).toBeInstanceOf( Promise );
		// The scene before's G-buffer is not left for the denoisers meanwhile.
		expect( KEYS.some( k => textures.has( k ) ) ).toBe( false );

		finish();
		await nd.compiling;
		expect( nd.compiling ).toBe( null );
		nd.render( context );
		expect( renderer.compute ).toHaveBeenCalledTimes( 1 );
		expect( KEYS.every( k => textures.get( k )?.isTexture ) ).toBe( true );

	} );

	it( 'from startCompile(), so the first frame a driver loop draws has it', async () => {

		vi.stubGlobal( 'requestAnimationFrame', () => 0 );
		const { nd, renderer, context, finish } = stage();

		nd.startCompile();
		expect( renderer.compileComputeAsync ).toHaveBeenCalledTimes( 1 );
		expect( nd.compiling ).toBeInstanceOf( Promise );
		nd.startCompile();
		expect( renderer.compileComputeAsync ).toHaveBeenCalledTimes( 1 );

		finish();
		await nd.compiling;
		nd.render( context );
		expect( renderer.compute ).toHaveBeenCalledTimes( 1 );

		// Disabled, it builds nothing.
		const off = stage();
		off.nd.enabled = false;
		off.nd.startCompile();
		expect( off.renderer.compileComputeAsync ).not.toHaveBeenCalled();

	} );

	it( 'at its first dispatch where nothing can compile in the background', () => {

		vi.stubGlobal( 'requestAnimationFrame', undefined );
		const { nd, renderer, context } = stage();

		nd.render( context );
		expect( renderer.compileComputeAsync ).not.toHaveBeenCalled();
		expect( renderer.compute ).toHaveBeenCalledTimes( 1 );

	} );

} );
