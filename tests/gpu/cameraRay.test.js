/**
 * The thin lens: an aperture of radius f / 2N (focal length in mm, scaled by unitsPerMetre and
 * apertureScale), and a flat focal plane at focusDistance along the view axis. A panorama has no
 * single view axis, so there every ray focuses focusDistance away. Look mode sizes the aperture
 * from the blur asked for instead: dofBlur × focusDistance × tan( fov / 2 ), and dofBlur ×
 * focusDistance for an orthographic camera, whose rays are parallel and start on its image plane.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Vector2, Vector3, Vector4 } from 'three';
import { uniform, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { generateRayFromCamera } from '@/core/TSL/CameraRay.js';
import { Ray } from '@/core/TSL/Struct.js';
import { ViewCamera } from '@/core/managers/ViewCamera.js';
import { CAMERA_PROJECTION_IDS } from '@/core/EngineDefaults.js';

const FOCUS = 3.5;
const FOCAL_LENGTH = 85;
const F_STOP = 2.0;
const UNITS_PER_METRE = 2.5;
const APERTURE_SCALE = 0.8;
const RADIUS = FOCAL_LENGTH / ( 2 * F_STOP ) * 0.001 * UNITS_PER_METRE * APERTURE_SCALE;
const BLUR = 0.1;

const UVS = [[ 0.5, 0.5 ], [ 0.02, 0.03 ], [ 0.97, 0.05 ], [ 0.04, 0.96 ], [ 0.98, 0.97 ]];
const LENS_SAMPLES = 256;

const camera = new PerspectiveCamera( 70, 1.6, 0.1, 100 );
camera.position.set( 1.5, 2, 4 );
camera.lookAt( - 0.5, 0.3, 0 );
camera.updateMatrixWorld();
const forward = camera.getWorldDirection( new Vector3() );

const ortho = new ViewCamera( 70, 1.6, 0.1, 100 );
ortho.copy( camera );
ortho.orthographic = true;
ortho.orthoHalfHeight = 1.25;
ortho.zoom = 1.6;
ortho.updateProjectionMatrix();

const uvs = new Float32Array( UVS.length * LENS_SAMPLES * 2 );
const seeds = new Uint32Array( UVS.length * LENS_SAMPLES );
let lcg = 12345;
UVS.forEach( ( [ u, v ], p ) => {

	for ( let s = 0; s < LENS_SAMPLES; s ++ ) {

		const i = p * LENS_SAMPLES + s;
		uvs.set( [ u, v ], i * 2 );
		lcg = ( Math.imul( lcg, 1103515245 ) + 12345 ) >>> 0;
		seeds[ i ] = lcg;

	}

} );

async function trace( renderer, projection, look = false, dof = true ) {

	const view = projection === CAMERA_PROJECTION_IDS.orthographic ? ortho : camera;
	const args = [
		uniform( view.matrixWorld.clone() ), uniform( view.projectionMatrixInverse.clone() ),
		uniform( projection, 'int' ), uniform( new Vector2( - Math.PI, Math.PI ) ), uniform( new Vector2( - Math.PI / 2, Math.PI / 2 ) ), uniform( 0, 'int' ),
		uniform( dof ? 1 : 0, 'int' ), uniform( FOCAL_LENGTH ), uniform( F_STOP ), uniform( FOCUS ), uniform( UNITS_PER_METRE ), uniform( APERTURE_SCALE ), uniform( 1.0 ),
		uniform( look ? 1 : 0, 'int' ), uniform( BLUR ),
	];
	const run = pick => evaluate( renderer, seeds.length, { uv: [ uvs, 'vec2' ], seed: [ seeds, 'uint' ] }, 'vec4', a => {

		const ray = Ray.wrap( generateRayFromCamera( a.uv, a.seed.toVar(), ...args ) );
		return vec4( pick( ray ), 0 );

	} );

	const origins = new Float32Array( await run( r => r.origin ) );
	const directions = new Float32Array( await run( r => r.direction ) );
	return Array.from( seeds, ( _, i ) => ( {
		pixel: Math.floor( i / LENS_SAMPLES ),
		origin: new Vector3().fromArray( origins, i * 4 ),
		direction: new Vector3().fromArray( directions, i * 4 ),
	} ) );

}

function pinholeDirection( [ u, v ] ) {

	const p = new Vector4( u * 2 - 1, 1 - v * 2, 1, 1 ).applyMatrix4( camera.projectionMatrixInverse );
	return new Vector3( p.x / p.w, p.y / p.w, p.z / p.w ).transformDirection( camera.matrixWorld );

}

describeGPU( 'thin lens', () => {

	let renderer, perspective, panorama, look, orthoPinhole, orthoLens, orthoLook;

	beforeAll( async () => {

		const { perspective: pinhole, equirectangular, orthographic } = CAMERA_PROJECTION_IDS;
		renderer = await createRenderer();
		perspective = await trace( renderer, pinhole );
		panorama = await trace( renderer, equirectangular );
		look = await trace( renderer, pinhole, true );
		orthoPinhole = await trace( renderer, orthographic, false, false );
		orthoLens = await trace( renderer, orthographic );
		orthoLook = await trace( renderer, orthographic, true );

	} );

	afterAll( () => renderer?.dispose() );

	it( 'opens the aperture to f / 2N, scaled by unitsPerMetre and apertureScale', () => {

		let widest = 0;
		for ( const { origin } of perspective ) {

			const offset = origin.clone().sub( camera.position );
			expect( Math.abs( offset.dot( forward ) ) ).toBeLessThan( 1e-5 );
			widest = Math.max( widest, offset.length() );

		}

		expect( widest ).toBeLessThanOrEqual( RADIUS * 1.0001 );
		expect( widest ).toBeGreaterThan( RADIUS * 0.95 );

	} );

	it( 'in look mode, opens the aperture from the blur asked for, ignoring the lens settings', () => {

		const expected = BLUR * FOCUS * Math.tan( camera.fov * Math.PI / 360 );
		const widest = Math.max( ...look.map( ( { origin } ) => origin.distanceTo( camera.position ) ) );

		expect( widest ).toBeLessThanOrEqual( expected * 1.0001 );
		expect( widest ).toBeGreaterThan( expected * 0.95 );

	} );

	it( 'focuses a perspective camera on a flat plane at focusDistance along the view axis', () => {

		for ( const { pixel, origin, direction } of perspective ) {

			const t = ( FOCUS - origin.clone().sub( camera.position ).dot( forward ) ) / direction.dot( forward );
			const hit = origin.clone().addScaledVector( direction, t );
			const d0 = pinholeDirection( UVS[ pixel ] );
			const expected = camera.position.clone().addScaledVector( d0, FOCUS / d0.dot( forward ) );
			expect( hit.distanceTo( expected ), `uv ${UVS[ pixel ]}` ).toBeLessThan( 1e-4 * FOCUS );

		}

	} );

	it( 'focuses a panorama focusDistance away along every ray', () => {

		for ( let p = 0; p < UVS.length; p ++ ) {

			const rays = panorama.filter( r => r.pixel === p );
			const points = rays.map( ( { origin, direction } ) => {

				const o = origin.clone().sub( camera.position );
				const b = o.dot( direction );
				const t = - b + Math.sqrt( b * b - o.lengthSq() + FOCUS * FOCUS );
				return origin.clone().addScaledVector( direction, t );

			} );

			for ( const point of points ) expect( point.distanceTo( points[ 0 ] ), `uv ${UVS[ p ]}` ).toBeLessThan( 1e-4 * FOCUS );

		}

	} );

	it( 'shoots an orthographic camera\'s rays parallel, from where the Raycaster picks', () => {

		const raycaster = new Raycaster();
		for ( const { pixel, origin, direction } of orthoPinhole ) {

			const [ u, v ] = UVS[ pixel ];
			raycaster.setFromCamera( { x: u * 2 - 1, y: 1 - v * 2 }, ortho );
			expect( origin.distanceTo( raycaster.ray.origin ), `uv ${UVS[ pixel ]}` ).toBeLessThan( 1e-5 );
			expect( direction.dot( forward ) ).toBeCloseTo( 1, 6 );

		}

	} );

	it( 'focuses an orthographic camera on the plane focusDistance in front of its image plane', () => {

		for ( const { pixel, origin, direction } of orthoLens ) {

			const start = orthoPinhole.find( r => r.pixel === pixel ).origin;
			const t = ( FOCUS - origin.clone().sub( start ).dot( forward ) ) / direction.dot( forward );
			const hit = origin.clone().addScaledVector( direction, t );
			expect( hit.distanceTo( start.clone().addScaledVector( forward, FOCUS ) ), `uv ${UVS[ pixel ]}` ).toBeLessThan( 1e-4 * FOCUS );

		}

	} );

	it( 'in look mode, opens an orthographic lens to dofBlur × focusDistance', () => {

		const expected = BLUR * FOCUS;
		const widest = Math.max( ...orthoLook.map( ( { pixel, origin } ) => origin.distanceTo( orthoPinhole.find( r => r.pixel === pixel ).origin ) ) );

		expect( widest ).toBeLessThanOrEqual( expected * 1.0001 );
		expect( widest ).toBeGreaterThan( expected * 0.95 );

	} );

} );
