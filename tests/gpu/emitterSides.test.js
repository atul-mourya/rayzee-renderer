/**
 * An emitter's side test sees the same sides at any size: the density re-walks and the emitter-hit test once took
 * a raw cross product, which a small triangle's is under sideAccepts' threshold — a 3 cm bulb's density read 0 and
 * bidirectional counted its light twice. The sides are the emitting ones, which a one-sided light that is a surface on
 * both faces (pbrt's) keeps apart from its culling side.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DoubleSide, FrontSide, Mesh, MeshPhysicalMaterial, PlaneGeometry, Scene, Vector3 } from 'three';
import { Fn, instanceIndex, instancedArray, storage, vec3, vec4, float, int, normalize, select } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { describeGPU, createRenderer } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';
import { readPixels } from '@/core/output/TextureReadback.js';
import { TRI_SIDE_SHIFT, TRI_EMIT_SIDE_SHIFT, packNormalOct } from '@/core/scene/BufferLayout.js';
import { MATERIAL_SLOTS, MATERIAL_SLOT } from '@/core/shaders/Common.js';
import { calculateEmissiveLightPdf } from '@/core/shaders/EmissiveSampling.js';
import { sideAccepts } from '@/core/shaders/BVHTraversal.js';
import { windingNormal } from '@/core/shaders/HitFacet.js';

const LANES = 20;
// Culling side, emitting side.
const SIDES = [[ 0, 0 ], [ 1, 1 ], [ 2, 2 ], [ 2, 0 ]];
const SCALES = [ 1, 1e-3 ];
const CASES = SCALES.flatMap( ( scale ) => SIDES.map( ( [ side, emit ] ) => ( { scale, side, emit } ) ) );

describeGPU( 'emitter sides', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'accepts the sides a triangle emits from, however small it is', async () => {

		// One triangle a case in the z = 0 plane, wound towards +z, `scale` on a side.
		const data = new Uint32Array( CASES.length * LANES );
		const f = new Float32Array( data.buffer );
		const n = packNormalOct( 0, 0, 1 );
		CASES.forEach( ( { scale, side, emit }, i ) => {

			const x = i * 10;
			[[ x, 0 ], [ x + scale, 0 ], [ x, scale ]].forEach( ( [ px, py ], v ) => {

				f.set( [ px, py, 0 ], i * LANES + v * 4 );
				data[ i * LANES + v * 4 + 3 ] = n;

			} );
			data[ i * LANES + 18 ] = ( side << TRI_SIDE_SHIFT | emit << TRI_EMIT_SIDE_SHIFT ) >>> 0;

		} );

		const geo = new Uint32Array( CASES.length * 12 ), shade = new Uint32Array( CASES.length * 8 );
		for ( let i = 0; i < CASES.length; i ++ ) {

			geo.set( data.subarray( i * LANES, i * LANES + 12 ), i * 12 );
			shade.set( data.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

		}

		const tris = {
			geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', CASES.length * 3 ).toReadOnly(),
			shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', CASES.length * 2 ).toReadOnly(),
		};
		const material = new Float32Array( MATERIAL_SLOTS * 4 );
		material[ MATERIAL_SLOT.IOR_TRANSMISSION * 4 + 3 ] = 1;
		material.set( [ 1, 1, 1 ], MATERIAL_SLOT.EMISSIVE_ROUGHNESS * 4 );
		const materials = storage( new StorageInstancedBufferAttribute( material, 4 ), 'vec4', MATERIAL_SLOTS ).toReadOnly();
		const bvh = storage( new StorageInstancedBufferAttribute( new Float32Array( 16 ), 4 ), 'vec4', 4 ).toReadOnly();

		// Per case: seen from the front (+z), then from the back.
		const out = instancedArray( CASES.length * 2, 'vec4' );
		await renderer.computeAsync( Fn( () => {

			const tri = int( instanceIndex.div( 2 ) );
			const back = instanceIndex.mod( 2 ).equal( 1 );
			const scale = float( CASES.map( ( c ) => c.scale )[ 0 ] ).toVar();
			for ( let i = 1; i < CASES.length; i ++ ) scale.assign( select( tri.equal( int( i ) ), float( CASES[ i ].scale ), scale ) );
			const centre = vec3( float( tri ).mul( 10 ).add( scale.div( 3 ) ), scale.div( 3 ), 0 );
			const from = centre.add( vec3( 0, 0, select( back, float( - 2 ), float( 2 ) ).mul( scale ) ) ).toVar();
			// No placement: a runtime −1, as a constant one folds the unused transform's index out of bounds.
			const noLeaf = int( instanceIndex ).mul( 0 ).sub( 1 ).toVar();
			const toLight = normalize( centre.sub( from ) ).toVar();
			const pdf = calculateEmissiveLightPdf( tri, scale.mul( 2 ), toLight, from, tris, materials, float( 1 ), bvh, noLeaf );
			const shell = windingNormal( tris, bvh, tri, noLeaf );
			out.element( instanceIndex ).assign( vec4( pdf, float( sideAccepts( int( CASES[ 0 ].side ), toLight.dot( shell ) ) ), float( 0 ), float( 0 ) ) );

		} )().compute( CASES.length * 2 ) );

		const result = new Float32Array( await renderer.getArrayBufferAsync( out.value ) );
		CASES.forEach( ( { scale, side, emit }, i ) => {

			const emits = [ emit !== 1, emit !== 0 ];
			emits.forEach( ( yes, back ) => {

				const pdf = result[ ( i * 2 + back ) * 4 ];
				const name = `side ${side} emitting ${emit} at ${scale}, ${back ? 'back' : 'front'}`;
				if ( yes ) expect( pdf, name ).toBeGreaterThan( 0 );
				else expect( pdf, name ).toBe( 0 );

			} );
			// windingNormal is unit length: the front-side test it feeds flips with the view at any size.
			expect( result[ ( i * 2 ) * 4 + 1 ], `front of ${scale}` ).toBe( 1 );
			expect( result[ ( i * 2 + 1 ) * 4 + 1 ], `back of ${scale}` ).toBe( 0 );

		} );

	} );

} );

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
const ROOT = new URL( '../../', import.meta.url );
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

describeGPU( 'a light that emits from one face of a surface', () => {

	const SIZE = 32;
	let app;

	// Two black lights over a red sky, facing +z: one a surface on its front only, one on both faces emitting from
	// its front (pbrt's one-sided light).
	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );
		const light = ( name, x, side, emissiveSide ) => {

			const material = new MeshPhysicalMaterial( { color: 0x000000, roughness: 1, emissive: 0xffffff, emissiveIntensity: 1, side } );
			if ( emissiveSide !== undefined ) material.emissiveSide = emissiveSide;
			const mesh = new Mesh( new PlaneGeometry( 1.6, 1.6 ), material );
			mesh.name = name;
			mesh.position.x = x;
			return mesh;

		};

		await app.loadObject3D( new Scene().add( light( 'culled', - 1, FrontSide ), light( 'solid', 1, DoubleSide, FrontSide ) ), 'lights' );
		app.environmentManager.params.solidSkyColor.setRGB( 1, 0, 0 );
		await app.environmentManager.setMode( 'color' );
		// The kernels compile here, not in the test's time.
		await app.renderFrames( 1 );

	}, 60000 );

	afterAll( () => app?.dispose() );

	const shoot = async ( z ) => {

		app.camera.position.set( 0, 0, z );
		app.camera.lookAt( 0, 0, 0 );
		await app.renderFrames( 4 );
		const image = ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data;
		const at = ( name ) => {

			const p = app.sceneMeshes.find( ( m ) => m.name === name ).getWorldPosition( new Vector3() ).project( app.camera );
			const x = Math.round( ( p.x + 1 ) / 2 * SIZE - 0.5 ), y = Math.round( ( 1 - p.y ) / 2 * SIZE - 0.5 );
			return Array.from( image.subarray( ( y * SIZE + x ) * 4, ( y * SIZE + x ) * 4 + 3 ) );

		};

		return { culled: at( 'culled' ), solid: at( 'solid' ) };

	};

	it( 'glows from its front, and from behind is a dark surface rather than a hole', async () => {

		const front = await shoot( 4 );
		expect( front.solid ).toEqual( front.culled );
		expect( front.solid[ 0 ] ).toBeCloseTo( 1, 3 );

		const back = await shoot( - 4 );
		// The surface on its front only shows the sky through its back.
		expect( back.culled[ 0 ] ).toBeCloseTo( 1, 3 );
		expect( back.solid ).toEqual( [ 0, 0, 0 ] );

	}, 30000 );

	it( 'tells NRD its back is a surface and its front a light', async () => {

		app.denoisingManager.setDenoiserStrategy( 'nrd' );
		const roughnessSign = async ( z ) => {

			await shoot( z );
			const stage = app.stages.normalDepth;
			const raw = await readPixels( app.renderer, stage._shadingRT, SIZE, SIZE );
			const p = app.sceneMeshes.find( ( m ) => m.name === 'solid' ).getWorldPosition( new Vector3() ).project( app.camera );
			const x = Math.round( ( p.x + 1 ) / 2 * SIZE - 0.5 ), y = Math.round( ( 1 - p.y ) / 2 * SIZE - 0.5 );
			// .w is the roughness, negated on an emitter (NRD's material id); half floats keep the sign in bit 15.
			const w = raw[ ( ( SIZE - 1 - y ) * SIZE + x ) * 4 + 3 ];
			return raw instanceof Uint16Array ? ( w & 0x8000 ? - 1 : 1 ) : Math.sign( w );

		};

		expect( await roughnessSign( 4 ) ).toBe( - 1 );
		expect( await roughnessSign( - 4 ) ).toBe( 1 );
		app.denoisingManager.setDenoiserStrategy( 'none' );

	}, 30000 );

	it( 'lights its own back with none of its light, along its seams too', async () => {

		// A grey back seen at one bounce: the only light the light's own sampling could add there is its own, which
		// faces away. Rounding once let the triangle beside each seam through, a bright line along the diagonal.
		const solid = app.sceneMeshes.find( ( m ) => m.name === 'solid' );
		app.setMaterialProperty?.( solid.userData.materialIndex, 'color', [ 0.5, 0.5, 0.5 ] );
		app.camera.position.set( 1, 0, - 1.5 );
		app.camera.lookAt( 1, 0, 0 );
		const shot = async ( sampling ) => {

			app.settings.setMany( { maxBounces: 1, enableEmissiveTriangleSampling: sampling } );
			await app.renderFrames( 16 );
			return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

		};

		const off = await shot( false ), on = await shot( true );
		let most = 0;
		for ( let i = 0; i < on.length; i += 4 ) most = Math.max( most, Math.abs( on[ i + 1 ] - off[ i + 1 ] ) );
		// Green: the sky is red, so this is the panel's own light alone.
		expect( most ).toBeLessThan( 1e-4 );

	}, 30000 );

} );
