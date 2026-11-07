/**
 * processBump: a bump map's slope is taken over one texel of the map as authored, so packing that stretches or shrinks
 * its layer (a larger bucket, the size cap) leaves the bump as strong as at its own size. With a bumpDistance the
 * normal is the bumped surface's own, whatever the surface's size (a repeat shortens the axes: uvTangent.test.js);
 * without, it tilts along the map's U and V.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataArrayTexture, DataTexture, DirectionalLight, LinearFilter, Mesh, MeshPhysicalMaterial, PlaneGeometry, RepeatWrapping, Scene, Vector2 } from 'three';
import { int, float, vec2, vec3, vec4, mat3 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { processBump, buildBucketTextureNodes, NO_UV_AXES } from '@/core/shaders/TextureSampling.js';
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

	// The shading normal on a z-up surface; `native` is the map's authored width × height, 0 × 0 when unknown. `T`, `B`:
	// the surface's dP/du and dP/dv.
	const bump = async ( map, native, scale, { distance = 0, T = null, B = null } = {} ) => new Float32Array( await evaluate( renderer, 64, { uv: [ uvs, 'vec4' ] }, 'vec4', ( { uv } ) => {

		const material = { bumpMapIndex: int( 0 ), bumpScale: float( scale ), bumpDistance: float( distance ), bumpMapSize: vec2( ...native ) };
		const axes = T ? mat3( vec3( ...T ), vec3( ...B ), vec3( 0 ) ) : NO_UV_AXES;
		return vec4( processBump( vec3( 0, 0, 1 ), material, { bumpUV: uv.xy }, axes ), 0 );

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

	// The ramp rises 4/255 a texel, 256/255 over the map.
	const RISE = 256 / 255;

	it( 'gives a bumpDistance its true slope, however large the surface or mirrored its uv', async () => {

		const map = ramp( NATIVE );
		for ( const [ distance, L ] of [[ 0.01, 1 ], [ 0.05, 2 ], [ - 0.02, 0.5 ]] ) {

			for ( const B of [[ 0, L, 0 ], [ 0, - L, 0 ]] ) {

				const n = await bump( map, [ NATIVE, NATIVE ], 1, { distance, T: [ L, 0, 0 ], B } );
				for ( let i = 0; i < 64; i ++ ) {

					// Rising along +x by distance · RISE over L: the normal leans back by that slope.
					expect( n[ i * 4 ] / n[ i * 4 + 2 ] ).toBeCloseTo( - distance * RISE / L, 5 );
					expect( n[ i * 4 + 1 ] ).toBeCloseTo( 0, 6 );

				}

			}

		}

	} );

	it( 'presses a negative bumpScale in, as three.js does', async () => {

		const map = ramp( NATIVE );
		const axes = { T: [ 1, 0, 0 ], B: [ 0, 1, 0 ] };
		const raised = await bump( map, [ NATIVE, NATIVE ], 2, axes );
		const pressed = await bump( map, [ NATIVE, NATIVE ], - 2, axes );
		for ( let i = 0; i < 64; i ++ ) {

			expect( raised[ i * 4 ] ).toBeLessThan( - 0.002 );
			expect( pressed[ i * 4 ] ).toBeCloseTo( - raised[ i * 4 ], 6 );

		}

	} );

	it( 'tilts a bumpScale along the map\'s U axis', async () => {

		// U runs along +y: the ramp rises that way, so the normal leans to −y.
		const n = await bump( ramp( NATIVE ), [ NATIVE, NATIVE ], 2, { T: [ 0, 1, 0 ], B: [ - 1, 0, 0 ] } );
		for ( let i = 0; i < 64; i ++ ) {

			expect( n[ i * 4 + 1 ] ).toBeLessThan( - 0.002 );
			expect( n[ i * 4 ] ).toBeCloseTo( 0, 6 );

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

	// Rows top down, as an image file holds them; `pixel( row )` gives one row's RGBA.
	const imageRows = ( size, pixel, flipY ) => {

		const data = new Uint8Array( size * size * 4 );
		for ( let r = 0; r < size; r ++ ) for ( let x = 0; x < size; x ++ ) data.set( pixel( r ), ( r * size + x ) * 4 );
		const t = new DataTexture( data, size, size );
		t.flipY = flipY;
		t.needsUpdate = true;
		return t;

	};

	it( 'reads a normal map stored bottom up (three\'s TextureLoader) as the same picture stored top down (glTF)', async () => {

		// Normals leaning up and down the image, 20° at most: green is the lean towards the image's top.
		const normals = ( flipY ) => imageRows( NATIVE, ( r ) => {

			const lean = 0.36 * Math.cos( 2 * Math.PI * 4 * r / NATIVE ), l = Math.hypot( lean, 1 );
			return [ 128, Math.round( 127.5 + 127.5 * lean / l ), Math.round( 127.5 + 127.5 / l ), 255 ];

		}, flipY );

		const shade = async ( material, { topDown = false } = {} ) => {

			const geometry = new PlaneGeometry( 2, 2 );
			// A top-down image has v run down it: flip the plane's v so the picture lands where it did.
			if ( topDown ) for ( let i = 0, uv = geometry.attributes.uv; i < uv.count; i ++ ) uv.setY( i, 1 - uv.getY( i ) );
			const plane = new Mesh( geometry, new MeshPhysicalMaterial( { roughness: 1, ...material } ) );
			plane.rotation.x = - Math.PI / 2;
			const sun = new DirectionalLight( 0xffffff, 3 );
			sun.position.set( 0, 2, 5 );
			await app.loadObject3D( new Scene().add( plane, sun ), 'normal' );
			app.camera.position.set( 0, 2.5, 0.001 );
			app.camera.lookAt( 0, 0, 0 );
			await app.renderFrames( 16 );
			return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

		};

		const flat = await shade( {} );
		const bottomUp = await shade( { normalMap: normals( true ) } );
		// GLTFLoader's derivative-tangent material: normalScale.y negated.
		const topDown = await shade( { normalMap: normals( false ), normalScale: new Vector2( 1, - 1 ) }, { topDown: true } );

		// Read the other way up, the lean turned over: further from the picture (1.1×) than no map at all.
		expect( rmse( bottomUp, topDown ) ).toBeLessThan( 0.02 * rmse( flat, topDown ) );

	}, 120000 );

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
