/**
 * processBump: a bump map's slope is taken over one texel of the map as authored, so packing that stretches or shrinks
 * its layer (a larger bucket, the size cap) leaves the bump as strong as at its own size. A map stored at its own size
 * renders exactly as before.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataArrayTexture, DataTexture, DirectionalLight, LinearFilter, Mesh, MeshPhysicalMaterial, PlaneGeometry, RepeatWrapping, Scene } from 'three';
import { int, float, vec3, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { processBump, buildBucketTextureNodes } from '@/core/shaders/TextureSampling.js';
import { arrayToMat3 } from '@/core/shaders/Common.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';

const NATIVE = 64;
const ROOT = new URL( '../../', import.meta.url );

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

// h(u) = 256u at every texel centre: a ramp bilinear reads exactly, whatever the stored width.
function ramp( width ) {

	const data = new Uint8Array( width * NATIVE * 4 );
	for ( let y = 0; y < NATIVE; y ++ ) for ( let x = 0; x < width; x ++ ) data.fill( Math.round( 256 * ( x + 0.5 ) / width ), ( y * width + x ) * 4, ( y * width + x ) * 4 + 4 );
	const t = new DataArrayTexture( data, width, NATIVE, 1 );
	t.minFilter = t.magFilter = LinearFilter;
	t.wrapS = t.wrapT = RepeatWrapping;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return t;

}

describeGPU( 'bump', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const uvs = new Float32Array( 64 * 4 );
	for ( let i = 0; i < 64; i ++ ) uvs.set( [ 0.2 + 0.4 * ( i % 8 ) / 8, 0.2 + 0.4 * Math.floor( i / 8 ) / 8, 0, 0 ], i * 4 );

	// The shading normal on a z-up surface; `native` is the map's authored width × height, 0 × 0 when unknown.
	const bump = async ( map, native, scale ) => new Float32Array( await evaluate( renderer, 64, { uv: [ uvs, 'vec4' ] }, 'vec4', ( { uv } ) => {

		const material = {
			bumpMapIndex: int( 0 ), bumpScale: float( scale ),
			bumpTransform: arrayToMat3( { data1: vec4( 1, 0, native[ 0 ], 0 ), data2: vec4( 1, native[ 1 ], 0, 0 ) } ),
		};
		return vec4( processBump( vec3( 0, 0, 1 ), material, { bumpUV: uv.xy } ), 0 );

	}, { linearBuckets: buildBucketTextureNodes( [ map ] ) } ) );

	const maxDifference = ( a, b ) => a.reduce( ( m, v, i ) => Math.max( m, Math.abs( v - b[ i ] ) ), 0 );

	it( 'keeps a map at its own size exactly as it was, and a stretched or shrunk one as strong', async () => {

		const native = ramp( NATIVE ), stretched = ramp( NATIVE * 2 ), shrunk = ramp( NATIVE / 2 );
		for ( const scale of [ 0.5, 2, 20 ] ) {

			const asAuthored = await bump( native, [ NATIVE, NATIVE ], scale );
			const tilt = Math.hypot( asAuthored[ 0 ], asAuthored[ 1 ] );
			expect( tilt ).toBeGreaterThan( 0.002 );

			// The stored size is the step when the map's own is unknown: today's behaviour, bit for bit.
			expect( asAuthored ).toEqual( await bump( native, [ 0, 0 ], scale ) );

			expect( maxDifference( await bump( stretched, [ NATIVE, NATIVE ], scale ), asAuthored ) ).toBeLessThan( tilt * 0.02 );
			expect( maxDifference( await bump( shrunk, [ NATIVE, NATIVE ], scale ), asAuthored ) ).toBeLessThan( tilt * 0.02 );

			// Stepping a stored texel instead halves the stretched map's slope.
			const storedStep = await bump( stretched, [ 0, 0 ], scale );
			expect( maxDifference( storedStep, asAuthored ) ).toBeGreaterThan( tilt * 0.3 );

		}

	} );

} );

describeGPU( 'bump strength in a scene', () => {

	let app;
	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		app = await openHeadless( { width: 64, height: 64, strict: false, settings: { maxBounces: 1 } } );
		await app.environmentManager.setMode( 'color' );

	}, 60000 );
	afterAll( () => app?.dispose() );

	// Height stripes, 4 across.
	const heights = ( size ) => {

		const data = new Uint8Array( size * size * 4 );
		for ( let i = 0; i < size * size; i ++ ) data.fill( Math.round( 128 + 120 * Math.sin( 2 * Math.PI * 4 * ( i % size ) / size ) ), i * 4, i * 4 + 4 );
		const t = new DataTexture( data, size, size );
		t.needsUpdate = true;
		return t;

	};

	const render = async ( bumpMap, others = [] ) => {

		const plane = new Mesh( new PlaneGeometry( 2, 2 ), new MeshPhysicalMaterial( { bumpMap, bumpScale: 1, roughness: 1 } ) );
		plane.rotation.x = - Math.PI / 2;
		const sun = new DirectionalLight( 0xffffff, 3 );
		sun.position.set( 5, 1, 0 );
		await app.loadObject3D( new Scene().add( plane, sun, ...others ), 'bump' );
		app.camera.position.set( 0, 2.5, 0.001 );
		app.camera.lookAt( 0, 0, 0 );
		await app.renderFrames( 16 );
		return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

	};

	const rmse = ( a, b ) => Math.sqrt( a.reduce( ( sum, v, i ) => sum + ( ( i & 3 ) === 3 ? 0 : ( v - b[ i ] ) ** 2 ), 0 ) / ( a.length * 0.75 ) );

	it( 'is as strong packed into a larger array as alone', async () => {

		const flat = await render( null );
		const alone = await render( heights( NATIVE ) );
		// Four more data maps, out of view: the planner shares one 128² array between the bump map and the smallest.
		const others = [ 128, 256, 512, 1024 ].map( ( size, i ) => {

			const m = new Mesh( new PlaneGeometry( 0.1, 0.1 ), new MeshPhysicalMaterial( { roughnessMap: heights( size ) } ) );
			m.position.set( 10 + i, - 5, 10 );
			return m;

		} );
		const packed = await render( heights( NATIVE ), others );
		const arrays = app.stages.pathTracer.materialData.linearBuckets.filter( Boolean ).map( ( t ) => [ t.image.width, t.image.depth ] );
		expect( arrays ).toContainEqual( [ 128, 2 ] );

		// Of the bump's whole effect: 0.64 apart stepping one stored texel, 0.14 stepping its own (the stretch resamples it).
		expect( rmse( packed, alone ) ).toBeLessThan( 0.3 * rmse( flat, alone ) );

	}, 120000 );

} );
