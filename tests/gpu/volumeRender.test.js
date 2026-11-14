/**
 * Volumes through the whole engine on Dawn: a white volume around a white sphere in a white sky renders the sky (every
 * scatter, its light and its shadow rays conserve energy), a black one lets through e^(−optical depth), an emitting
 * one gives the integral of its emission, and a hidden one nothing.
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { Group, Mesh, SphereGeometry, MeshPhysicalMaterial, Color, Vector3 } from 'three';
import { readFileSync } from 'node:fs';
import { VideoRenderManager } from '@/core/viewer/animation/VideoRenderManager.js';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';
import { Volume, VolumeGrid } from '@/core/scene/Volumes.js';

const ROOT = new URL( '../../', import.meta.url );
const SIZE = 32;

class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

describeGPU( 'volumes in the engine', () => {

	let app;

	const render = async ( samples ) => {

		await app.renderFrames( samples, { reset: true } );
		return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

	};

	// The mean of each channel over the pixels of a centred square `half` pixels from the middle.
	const centre = ( image, half = 2 ) => {

		const sum = [ 0, 0, 0 ];
		let n = 0;
		for ( let y = SIZE / 2 - half; y < SIZE / 2 + half; y ++ ) for ( let x = SIZE / 2 - half; x < SIZE / 2 + half; x ++ ) {

			for ( let c = 0; c < 3; c ++ ) sum[ c ] += image[ ( y * SIZE + x ) * 4 + c ];
			n ++;

		}

		return sum.map( ( s ) => s / n );

	};

	const load = async ( objects, sky ) => {

		await app.loadObject3D( new Group().add( ...objects ), 'volumes' );
		app.environmentManager.params.solidSkyColor.copy( sky );
		await app.environmentManager.setMode( 'color' );
		app.camera.position.set( 0, 0, 3 );
		app.camera.lookAt( 0, 0, 0 );

	};

	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );

	}, 60000 );

	afterAll( () => app?.dispose() );

	it( 'renders the sky through a white volume around a white sphere in a white sky', async () => {

		const cloud = new Volume( VolumeGrid.procedural( 'cloud', { resolution: 48 } ), { density: 12, anisotropy: 0.4 } );
		cloud.scale.setScalar( 2.4 );
		const ball = new Mesh( new SphereGeometry( 0.35, 48, 24 ), new MeshPhysicalMaterial( { color: 0xffffff, roughness: 1, metalness: 0 } ) );
		await load( [ cloud, ball ], new Color( 1, 1, 1 ) );
		app.settings.setMany( { maxBounces: 128 } );
		const image = await render( 64 );
		let sum = 0;
		for ( let i = 0; i < image.length; i += 4 ) sum += image[ i ] + image[ i + 1 ] + image[ i + 2 ];
		expect( image.every( Number.isFinite ) ).toBe( true );
		expect( sum / ( SIZE * SIZE * 3 ) ).toBeCloseTo( 1, 2 );
		app.settings.setMany( { maxBounces: 8 } );

	}, 120000 );

	it( 'lets through e^(−optical depth) of a black volume', async () => {

		const n = 16, sigma = 1.2;
		const block = new Volume( VolumeGrid.fromFunction( n, () => 1 ), { density: sigma, color: 0x000000 } );
		await load( [ block ], new Color( 1, 1, 1 ) );
		const [ r, g, b ] = centre( await render( 256 ), 1 );
		// Half a voxel at each face reads half the background: τ = σ ( 1 − 0.25 / n ).
		const expected = Math.exp( - sigma * ( 1 - 0.25 / n ) );
		for ( const c of [ r, g, b ] ) expect( Math.abs( c - expected ) ).toBeLessThan( 0.02 );

		// The scene holds a copy of what was loaded.
		app.stages.pathTracer.volumes[ 0 ].visible = false;
		await app.updateVolumes();
		for ( const c of centre( await render( 4 ), 1 ) ) expect( c ).toBeCloseTo( 1, 4 );

	}, 120000 );

	it( 'gives the integral of its emission, density or none', async () => {

		const n = 16;
		const glow = new Volume( VolumeGrid.fromFunction( n, () => 0 ), { density: 0, emissionGrid: VolumeGrid.fromFunction( n, () => 1 ), emissionStrength: 1.5, emissionColor: new Color( 1, 0.5, 0.25 ) } );
		await load( [ glow ], new Color( 0, 0, 0 ) );
		const length = 1 - 0.25 / n;
		const image = centre( await render( 64 ), 1 );
		[ 1, 0.5, 0.25 ].forEach( ( k, c ) => expect( Math.abs( image[ c ] - 1.5 * k * length ) ).toBeLessThan( 0.02 * k ) );

	}, 120000 );

	// The pixel ( x, y ) of a world point in the last render.
	const pixel = ( image, point ) => {

		app.camera.updateMatrixWorld();
		const p = new Vector3( ...point ).project( app.camera );
		const x = Math.round( ( p.x + 1 ) / 2 * SIZE - 0.5 ), y = Math.round( ( 1 - p.y ) / 2 * SIZE - 0.5 );
		return image[ ( y * SIZE + x ) * 4 ];

	};

	it( 'plays a run of VDB frames, each written in place, its slot grown when a frame outgrows it, no shader rebuilt', async () => {

		const names = [ 1, 2, 3, 4 ].map( ( n ) => `seq_000${n}.vdb` );
		const files = names.map( ( n ) => new File( [ readFileSync( new URL( `../unit/loaders/fixtures/vdb/${n}`, import.meta.url ) ) ], n ) );
		await app.loadFile( { files } );
		app.environmentManager.params.solidSkyColor.setRGB( 1, 1, 1 );
		await app.environmentManager.setMode( 'color' );
		const pt = app.stages.pathTracer;
		const [ volume ] = pt.volumes;
		volume.color.setRGB( 0, 0, 0 );
		volume.density = 30;
		await app.updateVolumes();
		app.camera.position.set( 0.5, 0, 4 );
		app.camera.lookAt( 0.5, 0, 0 );
		expect( app.sequences ).toEqual( [ volume.sequence ] );
		expect( app.timeline.duration ).toBeCloseTo( 4 / 24, 6 );
		expect( app.timeline.animates ).toBe( true );

		// The ball's centre each frame (x, a tenth of a unit a voxel); the last is the largest, sampled at load.
		const centres = [ 0, 0.4, 0.8, 1.0 ];
		let image = await render( 16 );
		const atlas = pt._volumeAtlas, builds = pt._kernelGeneration;
		expect( pixel( image, [ 0, 0, 0 ] ) ).toBeLessThan( 0.2 );
		expect( pixel( image, [ 0.4, 0, 0 ] ) ).toBeGreaterThan( 0.9 );
		for ( let k = 1; k < 4; k ++ ) {

			app.timeline.seek( k / 24 + 1e-4 );
			expect( await app.timeline.settled() ).toBe( true );
			image = await render( 16 );
			expect( pixel( image, [ centres[ k ], 0, 0 ] ) ).toBeLessThan( 0.2 );
			if ( k < 3 ) expect( pixel( image, [ centres[ k - 1 ] - 0.4, 0, 0 ] ) ).toBeGreaterThan( 0.9 );
			expect( pt._volumeAtlas ).toBe( atlas );
			expect( pt._kernelGeneration ).toBe( builds );

		}

		// A frame past the slot (one the sampling missed) grows it, once.
		app.timeline.seek( 0 );
		await app.timeline.settled();
		volume.reserve = [ 1, 1, 1 ];
		await pt.setVolumes( pt.volumes );
		const small = pt._volumeAtlas;
		app.timeline.seek( 3 / 24 + 1e-4 );
		await app.timeline.settled();
		expect( pt._volumeAtlas ).not.toBe( small );
		expect( volume.reserve[ 0 ] ).toBeGreaterThanOrEqual( volume.grid.width );
		// The compiled kernels read the new atlas: that frame's ball drawn, no rebuild.
		image = await render( 16 );
		expect( pt._kernelGeneration ).toBe( builds );
		expect( pixel( image, [ 1.0, 0, 0 ] ) ).toBeLessThan( 0.2 );
		expect( pixel( image, [ - 0.4, 0, 0 ] ) ).toBeGreaterThan( 0.9 );
		app.timeline.seek( 0 );
		expect( await app.timeline.settled() ).toBe( true );
		expect( pixel( await render( 16 ), [ 0, 0, 0 ] ) ).toBeLessThan( 0.2 );

		// A video steps the timeline: each frame shows the sequence's frame at its time.
		const shown = [];
		await new VideoRenderManager( app ).renderAnimation( {
			timeline: app.timeline, fps: 24, samplesPerFrame: 1, enableOIDN: false, captureFrame: false,
			onFrame: async () => void shown.push( volume.sequence.current ),
		} );
		expect( shown ).toEqual( [ 0, 1, 2, 3 ] );

	}, 120000 );

} );
