import { it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Scene, Mesh, PlaneGeometry, BoxGeometry, SphereGeometry, MeshPhysicalMaterial, Color, Vector3, Matrix3, RenderTarget, FloatType, DataTexture, RepeatWrapping, SRGBColorSpace } from 'three';
import { vec3, float } from 'three/tsl';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { openHeadless } from '@/core/viewer/Headless.js';
import { EngineEvents } from '@/core/EngineEvents.js';
import { MATERIAL_VALUE_SOURCE } from '@/core/scene/GeometryExtractor.js';
import { readPixels } from '@/core/output/TextureReadback.js';
import { encodeHDR } from '@/core/output/ImageEncoders.js';
import { OIDNDenoiser } from '@/core/viewer/denoise/OIDNDenoiser.js';

const ROOT = new URL( '../../', import.meta.url );
const SIZE = 32;
const SAMPLES = 4;

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

const mean = image => {

	let sum = 0;
	for ( let i = 0; i < image.length; i += 4 ) sum += image[ i ] + image[ i + 1 ] + image[ i + 2 ];
	return sum / ( image.length / 4 * 3 );

};

const maxDifference = ( a, b ) => a.reduce( ( max, v, i ) => Math.max( max, Math.abs( v - b[ i ] ) ), 0 );

const flatHDR = ( r, g, b ) => encodeHDR( { data: new Float32Array( 64 * 32 * 4 ).map( ( _, i ) => [ r, g, b, 1 ][ i % 4 ] ), width: 64, height: 32 } );

describeGPU( 'the engine headless on Dawn', () => {

	let app, baseline, sky, fetchWeights;

	const render = async ( samples = SAMPLES ) => {

		await app.renderFrames( samples );
		return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

	};

	const meshIndex = name => app.sceneMeshes.findIndex( m => m.name === name );
	const meshNamed = name => app.sceneMeshes[ meshIndex( name ) ];
	const materialOf = name => meshNamed( name ).userData.materialIndex;

	const pixelOf = name => {

		const p = meshNamed( name ).getWorldPosition( new Vector3() ).project( app.camera );
		return [ Math.round( ( p.x + 1 ) / 2 * SIZE - 0.5 ), Math.round( ( 1 - p.y ) / 2 * SIZE - 0.5 ) ];

	};

	const rgb = ( image, [ x, y ] ) => Array.from( image.subarray( ( y * SIZE + x ) * 4, ( y * SIZE + x ) * 4 + 3 ) );

	async function readCanvas() {

		const device = app.renderer.backend.device;
		const texture = app.canvas.getContext( 'webgpu' ).getCurrentTexture();
		const buffer = device.createBuffer( { size: 256 * SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer( { texture }, { buffer, bytesPerRow: 256 }, [ SIZE, SIZE ] );
		device.queue.submit( [ encoder.finish() ] );
		await buffer.mapAsync( GPUMapMode.READ );

		const raw = new Uint8Array( buffer.getMappedRange() );
		const [ r, b ] = texture.format === 'bgra8unorm' ? [ 2, 0 ] : [ 0, 2 ];
		const out = new Uint8Array( SIZE * SIZE * 4 );
		for ( let p = 0; p < SIZE * SIZE; p ++ ) {

			const s = Math.floor( p / SIZE ) * 256 + ( p % SIZE ) * 4;
			out.set( [ raw[ s + r ], raw[ s + 1 ], raw[ s + b ], raw[ s + 3 ] ], p * 4 );

		}

		buffer.unmap();
		buffer.destroy();
		return out;

	}

	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		// Off the network should the denoiser ever load.
		configureAssets( { oidnWeightsBaseUrl: new URL( 'tests/__nothing__/', ROOT ).href } );
		fetchWeights = vi.spyOn( OIDNDenoiser.prototype, '_fetchWeights' );
		app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );

		const floor = new Mesh( new PlaneGeometry( 8, 8 ), new MeshPhysicalMaterial( { name: 'floor', color: 0xb0b0b0, roughness: 0.8 } ) );
		floor.name = 'floor';
		floor.rotation.x = - Math.PI / 2;
		const box = new Mesh( new BoxGeometry( 1, 1, 1 ), new MeshPhysicalMaterial( { name: 'box', color: 0x4f7dd6, roughness: 0.4 } ) );
		box.name = 'box';
		box.position.set( - 0.8, 0.5, 0 );
		const ball = new Mesh( new SphereGeometry( 0.5, 16, 8 ), new MeshPhysicalMaterial( { name: 'ball', color: 0xffc36b, roughness: 0.5 } ) );
		ball.name = 'ball';
		ball.position.set( 0.8, 0.5, 0 );

		await app.loadObject3D( new Scene().add( floor, box, ball ), 'test' );
		sky = new Color( 0xe8edf2 );
		app.environmentManager.params.solidSkyColor.copy( sky );
		await app.environmentManager.setMode( 'color' );
		app.camera.position.set( 0, 1.4, 4.2 );
		app.camera.lookAt( 0, 0.5, 0 );
		baseline = await render();
		app.clearIssues();

	}, 60000 );

	afterAll( () => app?.dispose() );

	it( 'renders a lit image: the sky where nothing is hit, each object in its own colour', async () => {

		expect( baseline.every( Number.isFinite ) ).toBe( true );
		expect( rgb( baseline, [ 0, 0 ] )[ 0 ] ).toBeCloseTo( sky.r, 4 );
		expect( rgb( baseline, [ 0, 0 ] )[ 2 ] ).toBeCloseTo( sky.b, 4 );

		const [ ballR, ballG, ballB ] = rgb( baseline, pixelOf( 'ball' ) );
		expect( ballR ).toBeGreaterThan( ballG );
		expect( ballG ).toBeGreaterThan( ballB );
		const [ boxR, , boxB ] = rgb( baseline, pixelOf( 'box' ) );
		expect( boxB ).toBeGreaterThan( 3 * boxR );

		const { mode, render: shot, scene } = app.getProvenance();
		expect( mode ).toMatchObject( { headless: true, deterministic: true } );
		// Off, so its weights were never asked for.
		expect( app.denoisingManager.denoiser.enabled ).toBe( false );
		expect( fetchWeights ).not.toHaveBeenCalled();
		expect( shot ).toMatchObject( { width: SIZE, height: SIZE, samples: SAMPLES } );
		expect( scene ).toMatchObject( { kind: 'object3d', name: 'test' } );
		const triangles = app.sceneMeshes.reduce( ( n, { geometry } ) => n + ( geometry.index ?? geometry.attributes.position ).count / 3, 0 );
		expect( app.getStatistics() ).toMatchObject( { triangleCount: triangles, hasBVH: true } );
		expect( app.getModelBounds().max.y ).toBeCloseTo( 1, 5 );
		expect( app.getSceneMinY() ).toBeCloseTo( 0, 5 );
		expect( app.getMemoryInfo().current ).toBeGreaterThan( 0 );

	} );

	it( 'renders the same samples bit for bit, one generate and final write a sample', async () => {

		const kernels = app.stages.pathTracer._kernelManager;
		kernels.enableProfiling( true );
		const again = await render();
		kernels.enableProfiling( false );
		const calls = Object.fromEntries( kernels.getProfileReport().map( row => [ row.name, row.calls ] ) );

		expect( maxDifference( again, baseline ) ).toBe( 0 );
		expect( calls ).toMatchObject( { generate: SAMPLES, finalWrite: SAMPLES } );
		expect( calls.extend ).toBeGreaterThan( SAMPLES );
		expect( calls.shade ).toBe( calls.extend );
		expect( Object.values( kernels.getTimingReport() ).filter( k => k.eager ).every( k => k.compiledOnce ) ).toBe( true );

	} );

	it( 'shows on the canvas the picture a readback returns', async () => {

		const picture = await app.renderToBuffer();
		expect( app.getCanvas() ).toBe( app.canvas );
		expect( picture ).toMatchObject( { colorSpace: 'srgb', toneMappedOn: 'gpu', source: 'accumulation' } );
		expect( maxDifference( await readCanvas(), picture.data ) ).toBeLessThanOrEqual( 2 );

	} );

	it( 'grades the picture, not the light', async () => {

		app.settings.set( 'saturation', 0 );
		app.getCanvas();
		const grey = await readCanvas();
		const picture = await app.renderToBuffer();
		app.settings.set( 'saturation', 1 );

		for ( const [ r, g, b ] of [ rgb( grey, pixelOf( 'ball' ) ), rgb( picture.data, pixelOf( 'ball' ) ) ] ) {

			expect( Math.abs( r - g ) ).toBeLessThanOrEqual( 1 );
			expect( Math.abs( r - b ) ).toBeLessThanOrEqual( 1 );

		}

		expect( maxDifference( ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data, baseline ) ).toBe( 0 );

	} );

	it( 'keeps coverage as alpha when the background is transparent', async () => {

		app.settings.set( 'transparentBackground', true );
		await app.renderFrames( SAMPLES );
		const picture = await app.renderToBuffer( { preserveAlpha: true } );
		app.getCanvas();
		const canvas = await readCanvas();
		app.settings.set( 'transparentBackground', false );

		const alpha = ( data, [ x, y ] ) => data[ ( y * SIZE + x ) * 4 + 3 ];
		for ( const data of [ picture.data, canvas ] ) {

			expect( alpha( data, [ 0, 0 ] ) ).toBe( 0 );
			expect( alpha( data, pixelOf( 'ball' ) ) ).toBe( 255 );

		}

	} );

	it( 'shows a canvas transform on screen while a picture keeps the view', async () => {

		const compositor = app.stages.compositor;
		const context = app.pipeline.context;
		compositor.setCanvasTransform( () => vec3( 0.5 ) );
		expect( compositor.showsCanvasTransform ).toBe( true );

		compositor.render( context );
		const shown = await readCanvas();
		const target = new RenderTarget( SIZE, SIZE, { type: FloatType, depthBuffer: false } );
		expect( compositor.renderShown( context, target ) ).toBe( true );
		const light = await readPixels( app.renderer, target, SIZE, SIZE );
		target.dispose();
		const exr = await app.exportImage( { format: 'exr', asShown: true } );

		compositor.setCanvasTransform( null );
		expect( compositor.renderShown( context, target ) ).toBe( false );
		app.getCanvas();
		const picture = await readCanvas();

		expect( shown.every( ( v, i ) => i % 4 === 3 || Math.abs( v - 128 ) <= 1 ) ).toBe( true );
		// The canvas's sRGB 0.5, decoded to light.
		expect( light[ 0 ] ).toBeCloseTo( 0.214, 3 );
		expect( exr.colorSpace ).toBe( 'srgb-linear' );
		expect( maxDifference( picture, ( await app.renderToBuffer() ).data ) ).toBeLessThanOrEqual( 2 );

	} );

	it( 'shows and reads back the first picture a denoiser publishes', async () => {

		const context = app.pipeline.context;
		const published = new DataTexture( new Float32Array( SIZE * SIZE * 4 ).fill( 0.25 ), SIZE, SIZE );
		published.type = FloatType;
		published.needsUpdate = true;
		context.setTexture( 'oidn:output', published );
		const display = await app.renderToBuffer( { colorSpace: 'linear', source: 'display' } );
		const accumulation = await app.renderToBuffer( { colorSpace: 'linear' } );
		app.getCanvas();
		const canvas = await readCanvas();
		context.removeTexture( 'oidn:output' );
		published.dispose();
		const fallback = await app.renderToBuffer( { colorSpace: 'linear', source: 'display' } );

		expect( display.source ).toBe( 'oidn' );
		expect( display.data.every( ( v, i ) => i % 4 === 3 || Math.abs( v - 0.25 ) < 1e-3 ) ).toBe( true );
		expect( canvas.every( ( v, i ) => v === canvas[ i % 4 ] ) ).toBe( true );
		expect( maxDifference( accumulation.data, baseline ) ).toBe( 0 );
		expect( fallback.source ).toBe( 'accumulation' );
		expect( maxDifference( fallback.data, baseline ) ).toBe( 0 );

	} );

	it( 'scales the shown picture by a display gain', async () => {

		const compositor = app.stages.compositor;
		compositor.setDisplayGain( () => float( 0 ) );
		app.getCanvas();
		const dark = await readCanvas();
		compositor.setDisplayGain( null );
		app.getCanvas();

		expect( dark.every( ( v, i ) => i % 4 === 3 || v === 0 ) ).toBe( true );
		expect( maxDifference( await readCanvas(), ( await app.renderToBuffer() ).data ) ).toBeLessThanOrEqual( 2 );

	} );

	it( 'marks every pixel unconverged under the overlay before the minimum samples', async () => {

		app.settings.set( 'convergenceOverlay', true );
		app.getCanvas();
		const overlay = await readCanvas();
		app.settings.set( 'convergenceOverlay', false );
		app.getCanvas();

		const [ r, , b ] = rgb( overlay, [ 0, 0 ] );
		expect( app.settings.get( 'adaptiveMinSamples' ) ).toBeGreaterThan( SAMPLES );
		expect( r - b ).toBeGreaterThan( 60 );
		expect( maxDifference( await readCanvas(), ( await app.renderToBuffer() ).data ) ).toBeLessThanOrEqual( 2 );

	} );

	it( 'holds a solid backdrop at the manual exposure while the exposure moves', async () => {

		const background = app.settings.get( 'backgroundColor' );
		app.settings.set( 'backgroundColor', '#808080' );
		app.settings.set( 'showBackground', false );
		app.settings.set( 'exposure', 1 );
		await app.renderFrames( SAMPLES );
		app.getCanvas();
		const before = await readCanvas();
		const pictureBefore = await app.renderToBuffer();
		// What auto exposure does: the renderer's exposure moves, the manual one stays.
		const exposure = app.renderer.toneMappingExposure;
		app.renderer.toneMappingExposure = 4;
		app.getCanvas();
		const after = await readCanvas();
		const pictureAfter = await app.renderToBuffer();
		app.renderer.toneMappingExposure = exposure;
		app.settings.set( 'showBackground', true );
		app.settings.set( 'backgroundColor', background );

		const at = pixelOf( 'ball' );
		expect( rgb( before, [ 0, 0 ] )[ 0 ] ).toBeGreaterThan( 50 );
		expect( maxDifference( rgb( after, [ 0, 0 ] ), rgb( before, [ 0, 0 ] ) ) ).toBeLessThanOrEqual( 2 );
		expect( maxDifference( rgb( pictureAfter.data, [ 0, 0 ] ), rgb( pictureBefore.data, [ 0, 0 ] ) ) ).toBeLessThanOrEqual( 2 );
		expect( rgb( after, at )[ 0 ] ).toBeGreaterThan( rgb( before, at )[ 0 ] + 20 );
		expect( rgb( pictureAfter.data, at )[ 0 ] ).toBeGreaterThan( rgb( pictureBefore.data, at )[ 0 ] + 20 );

	} );

	it( 'writes PNG, 16-bit PNG, EXR and Radiance HDR files', async () => {

		const bytes = async file => new Uint8Array( await file.blob.arrayBuffer() );
		const exr = await app.exportImage( { format: 'exr', passes: [ 'depth', 'albedo' ] } );
		const png = await bytes( await app.exportImage( { format: 'png' } ) );
		const png16 = await bytes( await app.exportImage( { format: 'png', bitDepth: 16 } ) );
		const hdr = await bytes( await app.exportImage( { format: 'hdr' } ) );
		const header = new DataView( png.buffer );

		expect( new TextDecoder().decode( png.subarray( 1, 4 ) ) ).toBe( 'PNG' );
		expect( [ header.getUint32( 16 ), header.getUint32( 20 ), png[ 24 ] ] ).toEqual( [ SIZE, SIZE, 8 ] );
		expect( png16[ 24 ] ).toBe( 16 );
		expect( new TextDecoder().decode( png ) ).toContain( 'Rayzee' );
		expect( new DataView( ( await bytes( exr ) ).buffer ).getUint32( 0, true ) ).toBe( 20000630 );
		expect( exr.passes ).toEqual( [ 'depth' ] );
		expect( app.issues.map( issue => issue.code ) ).toContain( 'output.pass_unavailable' );
		expect( new TextDecoder().decode( hdr.subarray( 0, 10 ) ) ).toBe( '#?RADIANCE' );
		expect( app.exportInfo() ).toEqual( { width: SIZE, height: SIZE, upscaled: null, hdr: false, layers: { albedo: false, normal: false, depth: true } } );

	} );

	it( 'writes the denoisers\' albedo and normal guides while they are on', async () => {

		const stage = app.stages.pathTracer;
		stage.setAuxGBufferEnabled( true );
		const color = await render();
		const aux = await stage.readAuxBuffers();
		const exr = await app.exportImage( { format: 'exr', passes: [ 'albedo', 'normal', 'depth' ] } );
		const layers = app.exportInfo().layers;
		stage.setAuxGBufferEnabled( false );

		const ball = meshNamed( 'ball' ).material.color;
		expect( maxDifference( color, baseline ) ).toBe( 0 );
		expect( exr.passes ).toEqual( [ 'albedo', 'normal', 'depth' ] );
		expect( layers ).toEqual( { albedo: true, normal: true, depth: true } );
		expect( rgb( aux.albedo, pixelOf( 'ball' ) )[ 0 ] ).toBeCloseTo( ball.r, 1 );
		expect( rgb( aux.albedo, pixelOf( 'ball' ) )[ 2 ] ).toBeCloseTo( ball.b, 1 );
		expect( rgb( aux.normal, [ SIZE / 2, SIZE - 1 ] ) ).toEqual( [ 0.5, 1, 0.5 ].map( v => expect.closeTo( v, 2 ) ) );

	} );

	it( 'runs no frame loop of three\'s, and takes its frame step for each frame rendered', async () => {

		expect( app.renderer._animation._requestId ).toBeNull();
		const before = app.renderer.info.frame;
		await app.renderFrames( 3, { reset: true } );
		expect( app.renderer.info.frame - before ).toBeGreaterThanOrEqual( 3 );
		expect( app.renderer._animation._requestId ).toBeNull();

	} );

	it( 'times every kernel on the GPU', async () => {

		expect( app.enableGPUTiming( true ) ).toBe( true );
		await render();
		const frame = await app.getGPUTimings();
		const { kernels, total } = await app.getKernelGPUTimings();
		app.enableGPUTiming( false );

		expect( frame.compute ).toBeGreaterThan( 0 );
		expect( kernels.extend ).toBeGreaterThan( 0 );
		expect( kernels.shade ).toBeGreaterThan( 0 );
		expect( Object.values( kernels ).reduce( ( sum, ms ) => sum + ms, 0 ) ).toBeLessThanOrEqual( total + 1e-6 );
		expect( await app.getGPUTimings() ).toBeNull();

	} );

	it( 'draws a debug view through its own kernel, compiled at first use', async () => {

		app.settings.set( 'visMode', 1 );
		const normals = await render( 1 );
		app.settings.set( 'visMode', 0 );
		const back = await render();

		const [ r, g, b ] = rgb( normals, [ SIZE / 2, SIZE - 1 ] );
		expect( g ).toBeGreaterThan( r + 0.3 );
		expect( g ).toBeGreaterThan( b + 0.3 );
		expect( app.stages.pathTracer._kernelManager.getTimingReport().debug ).toMatchObject( { eager: false, compiledOnce: true } );
		expect( maxDifference( back, baseline ) ).toBe( 0 );

	} );

	it( 'sizes the bounce kernels on the GPU to the same image', async () => {

		app.setDeterministicMode( true, { pinDispatch: false } );
		const sized = await render();
		expect( app.isDeterministic ).toBe( false );
		app.setDeterministicMode( false );
		app.setDeterministicMode( true );
		const pinned = await render();

		expect( Math.abs( mean( sized ) / mean( baseline ) - 1 ) ).toBeLessThan( 0.01 );
		expect( app.isDeterministic ).toBe( true );
		expect( maxDifference( pinned, baseline ) ).toBe( 0 );

	} );

	it( 'takes a dropped HDR file, or one by URL, as the sky', async () => {

		const loaded = vi.fn();
		app.addEventListener( EngineEvents.ENVIRONMENT_LOADED, loaded );
		await app.loadFile( new File( [ await flatHDR( 0.25, 0.5, 1 ) ], 'blue.hdr' ) );
		const dropped = await render();
		const url = URL.createObjectURL( new Blob( [ await flatHDR( 1, 0.25, 0.25 ) ] ) );
		await app.loadEnvironment( url );
		URL.revokeObjectURL( url );
		const fetched = await render();
		app.removeEventListener( EngineEvents.ENVIRONMENT_LOADED, loaded );
		await app.environmentManager.setMode( 'color' );

		expect( rgb( dropped, [ 0, 0 ] ) ).toEqual( [ 0.25, 0.5, 1 ].map( v => expect.closeTo( v, 1 ) ) );
		expect( rgb( fetched, [ 0, 0 ] ) ).toEqual( [ 1, 0.25, 0.25 ].map( v => expect.closeTo( v, 1 ) ) );
		expect( loaded ).toHaveBeenCalledTimes( 2 );
		expect( maxDifference( await render(), baseline ) ).toBe( 0 );

	}, 30000 );

	it( 'moves a mesh with its placement and puts it back exactly', async () => {

		const ball = meshNamed( 'ball' );
		const at = pixelOf( 'ball' );
		const resets = vi.fn();
		app.addEventListener( EngineEvents.RENDER_RESET, resets );

		ball.position.y += 10;
		ball.updateMatrixWorld();
		app.updateMeshTransforms( [ meshIndex( 'ball' ) ] );
		expect( resets ).toHaveBeenCalled();
		const moved = await render();

		ball.position.y -= 10;
		ball.updateMatrixWorld();
		app.updateMeshTransforms( [ meshIndex( 'ball' ) ] );
		const back = await render();
		app.removeEventListener( EngineEvents.RENDER_RESET, resets );

		const [ r, , b ] = rgb( moved, at );
		expect( r - b ).toBeLessThan( 0.2 );
		expect( maxDifference( back, baseline ) ).toBe( 0 );

	} );

	it( 'hides a mesh and shows it again', async () => {

		const at = pixelOf( 'ball' );
		const uuid = meshNamed( 'ball' ).uuid;
		app.setMeshVisibility( meshIndex( 'ball' ), false );
		const hidden = await render();
		expect( app.setMeshVisibilityByUuid( uuid, true ) ).toBe( true );
		const shown = await render();
		expect( app.setMeshVisibilityByUuid( uuid, visible => ! visible ) ).toBe( false );
		const toggled = await render();
		app.setMeshVisibilityByUuid( uuid, true );

		expect( app.setMeshVisibilityByUuid( 'no such object', true ) ).toBeNull();
		expect( maxDifference( rgb( hidden, at ), rgb( baseline, at ) ) ).toBeGreaterThan( 0.2 );
		expect( maxDifference( shown, baseline ) ).toBe( 0 );
		expect( maxDifference( toggled, hidden ) ).toBe( 0 );

	} );

	it( 'recolours a material, makes it a light, and restores it', async () => {

		const index = materialOf( 'ball' );
		const at = pixelOf( 'ball' );
		const color = meshNamed( 'ball' ).material.color.clone();
		expect( app.getMaterialProperty( index, 'roughness' ) ).toBeCloseTo( 0.5, 5 );
		expect( app.getMaterialPropertySource( index, 'color' ) ).toBe( MATERIAL_VALUE_SOURCE.MATERIAL );

		app.setMaterialProperty( index, 'color', new Color( 1, 0, 0 ) );
		const red = await render();
		expect( app.getMaterialPropertySource( index, 'color' ) ).toBe( MATERIAL_VALUE_SOURCE.HOST );

		app.setMaterialProperty( index, 'emissive', new Color( 1, 1, 1 ) );
		app.setMaterialProperty( index, 'emissiveIntensity', 20 );
		const lit = await render();
		expect( app.hasEmissiveGeometry() ).toBe( true );

		app.setMaterialProperty( index, 'emissiveIntensity', 0 );
		app.setMaterialProperty( index, 'emissive', new Color( 0, 0, 0 ) );
		app.setMaterialProperty( index, 'color', color );
		expect( app.hasEmissiveGeometry() ).toBe( false );
		const back = await render();

		const [ r, g ] = rgb( red, at );
		expect( g / r ).toBeLessThan( 0.1 );
		expect( Math.min( ...rgb( lit, at ) ) ).toBeGreaterThan( 5 );
		expect( maxDifference( back, baseline ) ).toBe( 0 );

	} );

	it( 'deforms a mesh in place and refits it back', async () => {

		const box = meshNamed( 'box' );
		const index = meshIndex( 'box' );
		const { index: triangles, attributes } = box.geometry;
		const center = box.getWorldPosition( new Vector3() );
		const positions = scale => {

			const out = new Float32Array( triangles.count * 3 );
			const v = new Vector3();
			for ( let i = 0; i < triangles.count; i ++ ) {

				v.fromBufferAttribute( attributes.position, triangles.getX( i ) ).applyMatrix4( box.matrixWorld );
				v.sub( center ).multiplyScalar( scale ).add( center ).toArray( out, i * 3 );

			}

			return out;

		};

		app.refitBLASes( [ index ], mesh => mesh === index ? positions( 1.5 ) : null );
		// The background SAH rebuild swaps in with a reset of its own, which would cut a render short.
		await vi.waitFor( () => expect( app._sdf._pendingRebuilds.size ).toBe( 0 ) );
		const grown = await render();
		await app.refitBVH( mesh => mesh === index ? positions( 1 ) : null );

		expect( Math.abs( mean( grown ) - mean( baseline ) ) ).toBeGreaterThan( 0.01 );
		expect( maxDifference( await render(), baseline ) ).toBe( 0 );

	} );

	it( 'carries hidden objects, material edits and settings across a scene state', async () => {

		const index = materialOf( 'ball' );
		const color = meshNamed( 'ball' ).material.color.clone();
		const bounces = app.settings.get( 'maxBounces' );
		const edit = ( hidden, tint, maxBounces ) => {

			meshNamed( 'box' ).visible = ! hidden;
			app.updateAllMeshVisibility();
			app.setMaterialProperty( index, 'color', tint );
			app.settings.set( 'maxBounces', maxBounces );

		};

		edit( true, new Color( 0, 1, 0 ), 2 );
		const edited = await render();
		const state = JSON.parse( JSON.stringify( app.exportSceneState() ) );
		edit( false, color, bounces );
		const undone = await render();

		const { skipped } = await app.importSceneState( state );
		const restored = await render();
		const boxHidden = ! meshNamed( 'box' ).visible;
		meshNamed( 'ball' ).material.color.copy( color );
		edit( false, color, bounces );

		expect( skipped ).toEqual( [] );
		expect( boxHidden ).toBe( true );
		expect( maxDifference( undone, edited ) ).toBeGreaterThan( 0.1 );
		expect( maxDifference( restored, edited ) ).toBe( 0 );

	} );

	it( 'continues a render from a checkpoint bit for bit', async () => {

		expect( maxDifference( await render(), baseline ) ).toBe( 0 );
		const checkpoint = await app.captureRenderCheckpoint();
		await app.renderFrames( SAMPLES, { reset: false } );
		const continued = ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

		await render();
		app.restoreRenderCheckpoint( checkpoint );
		await app.renderFrames( SAMPLES, { reset: false } );
		const resumed = ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

		expect( checkpoint.samples ).toBe( SAMPLES );
		expect( app.getFrameCount() ).toBe( 2 * SAMPLES );
		expect( maxDifference( continued, baseline ) ).toBeGreaterThan( 0 );
		expect( maxDifference( resumed, continued ) ).toBe( 0 );

	} );

	it( 'renders at another size and back', async () => {

		expect( app.setCanvasSize( 24, 16 ) ).toEqual( { width: 24, height: 16 } );
		await app.renderFrames( SAMPLES );
		const small = await app.renderToBuffer( { colorSpace: 'linear' } );
		app.setCanvasSize( SIZE, SIZE );

		expect( [ small.width, small.height, small.data.length ] ).toEqual( [ 24, 16, 24 * 16 * 4 ] );
		expect( small.data.every( Number.isFinite ) ).toBe( true );
		expect( maxDifference( await render(), baseline ) ).toBe( 0 );

	} );

	it( 'renders until the sample ceiling', async () => {

		app.settings.set( 'maxSamples', 6 );
		const done = await app.renderUntilComplete( { denoise: false } );

		expect( done ).toMatchObject( { samples: 6, retiredBy: 'samples', denoised: false } );
		expect( app.isComplete() ).toBe( true );

	} );

	it( 'renders the same scene with bidirectional and vertex-merging integrators', async () => {

		const path = mean( await render( 16 ) );
		for ( const integrator of [ 'bidirectional', 'vcm' ] ) {

			app.settings.set( 'integrator', integrator );
			expect( app.stages.pathTracer.integrator ).toBe( integrator );
			const image = await render( 16 );
			expect( image.every( Number.isFinite ) ).toBe( true );
			expect( mean( image ) / path ).toBeCloseTo( 1, 2 );

		}

		app.settings.set( 'integrator', 'path' );
		expect( maxDifference( await render(), baseline ) ).toBe( 0 );

	}, 30000 );

	it( 'adds an object to the scene, hides it, removes it, and refuses its state on another scene', async () => {

		const marker = new Mesh( new SphereGeometry( 0.3, 12, 6 ), new MeshPhysicalMaterial( { name: 'marker', color: 0xff0000 } ) );
		marker.name = 'marker';
		marker.position.set( 0, 0.3, 1.5 );
		const id = await app.addModelFromObject3D( marker, { name: 'marker' } );
		expect( app.getSceneObject( id ) ).toBeTruthy();
		const at = pixelOf( 'marker' );
		const added = await render();
		expect( app.setSceneObjectVisibility( id, false ) ).toBe( false );
		const hidden = await render();
		const state = app.exportSceneState();
		expect( await app.removeSceneObject( id ) ).toBe( true );
		expect( app.getSceneObject( id ) ).toBeNull();
		const removed = await render();

		state.settings.notASetting = 1;
		const { skipped } = await app.importSceneState( state );

		const [ r, g ] = rgb( added, at );
		expect( g / r ).toBeLessThan( 0.2 );
		expect( maxDifference( rgb( hidden, at ), rgb( baseline, at ) ) ).toBeLessThan( 0.05 );
		expect( maxDifference( removed, baseline ) ).toBe( 0 );
		expect( skipped.map( entry => entry.section ) ).toEqual( [ 'appended', 'scene', 'settings' ] );
		expect( maxDifference( await render(), baseline ) ).toBe( 0 );

	}, 30000 );

	it( 'textures a material, moves the texture and reinterprets its colours', async () => {

		const material = meshNamed( 'floor' ).material;
		const index = materialOf( 'floor' );
		const checker = new DataTexture( new Uint8Array( [ 200, 200, 200, 255, 60, 60, 60, 255, 60, 60, 60, 255, 200, 200, 200, 255 ] ), 2, 2 );
		checker.wrapS = checker.wrapT = RepeatWrapping;
		checker.colorSpace = SRGBColorSpace;
		checker.needsUpdate = true;
		material.map = checker;
		material.needsUpdate = true;
		await app.rebuildMaterials();
		const textured = await render();

		app.setTextureTransform( index, 'map', new Matrix3().setUvTransform( 0.25, 0, 4, 4, 0, 0, 0 ).elements );
		const moved = await render();
		app.setTextureTransform( index, 'map', checker.matrix.elements );
		await app.setTextureColorSpace( checker, 'linear' );
		const linear = await render();
		await app.setTextureColorSpace( checker, null );

		expect( maxDifference( textured, baseline ) ).toBeGreaterThan( 0.1 );
		expect( maxDifference( moved, textured ) ).toBeGreaterThan( 0.1 );
		expect( mean( linear ) ).toBeGreaterThan( mean( textured ) * 1.05 );
		expect( checker.colorSpace ).toBe( SRGBColorSpace );
		expect( maxDifference( await render(), textured ) ).toBe( 0 );

	}, 30000 );

	it( 'renders nothing but the sky once the scene is unloaded', async () => {

		const unloaded = vi.fn();
		app.addEventListener( EngineEvents.SCENE_UNLOADED, unloaded );
		app.unloadScene();
		const empty = await render();
		app.removeEventListener( EngineEvents.SCENE_UNLOADED, unloaded );

		expect( unloaded ).toHaveBeenCalledOnce();
		expect( maxDifference( empty, empty.map( ( _, i ) => [ sky.r, sky.g, sky.b, 1 ][ i % 4 ] ) ) ).toBeLessThan( 1e-4 );

	}, 30000 );

	it( 'disposes cleanly and lets the device go', async () => {

		const device = app.renderer.backend.device;
		app.dispose();
		app.dispose();

		expect( app.isInitialized ).toBe( false );
		expect( app.stages ).toEqual( {} );
		expect( ( await device.lost ).reason ).toBe( 'destroyed' );

	} );

} );
