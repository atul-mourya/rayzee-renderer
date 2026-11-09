/**
 * The equal-area projection (`cameraProjection: 'equalArea'`) is pbrt-v4's spherical camera with its default mapping:
 * SphericalCamera::GenerateRay's EqualAreaSquareToSphere( uv ), y and z swapped, in a camera frame of image right, up
 * and forward — mirrored or not, as the pbrt importer leaves the camera.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { uniform, vec2, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { cameraRayOf, cameraRayUniforms } from '@/core/shaders/CameraRay.js';
import { CAMERA_PROJECTION_IDS } from '@/core/EngineDefaults.js';

const UVS = [];
for ( let v = 0.02; v < 1; v += 0.07 ) for ( let u = 0.03; u < 1; u += 0.07 ) UVS.push( u, v );

// pbrt-v4 util/math.cpp EqualAreaSquareToSphere.
function equalAreaSquareToSphere( px, py ) {

	const u = 2 * px - 1, v = 2 * py - 1, up = Math.abs( u ), vp = Math.abs( v );
	const signedDistance = 1 - ( up + vp ), r = 1 - Math.abs( signedDistance );
	const phi = ( r === 0 ? 1 : ( vp - up ) / r + 1 ) * Math.PI / 4;
	const z = Math.sign( signedDistance || 1 ) * ( 1 - r * r );
	const ring = r * Math.sqrt( Math.max( 2 - r * r, 0 ) );
	return [ Math.sign( u || 1 ) * Math.abs( Math.cos( phi ) ) * ring, Math.sign( v || 1 ) * Math.abs( Math.sin( phi ) ) * ring, z ];

}

function cameraMatrix( [ dx, dy, dz ], mirrored ) {

	const m = new Matrix4().lookAt( new Vector3(), new Vector3( - dx, - dy, - dz ), new Vector3( 0, 1, 0 ) );
	m.setPosition( 1, 2, 3 );
	if ( mirrored ) m.scale( new Vector3( - 1, 1, 1 ) );
	return m;

}

describeGPU( 'the equal-area panorama', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'draws pbrt\'s equal-area square in the camera\'s own frame, mirrored or not', async () => {

		for ( const mirrored of [ false, true ] ) for ( const look of [[ 0, 0, 1 ], [ 0.3, 0.6, 1 ], [ - 1, - 0.4, 0.2 ]] ) {

			const m = cameraMatrix( look, mirrored );
			const u = cameraRayUniforms();
			u.cameraProjection.value = CAMERA_PROJECTION_IDS.equalArea;
			const out = new Float32Array( await evaluate( renderer, UVS.length / 2, { uv: [ new Float32Array( UVS ), 'vec2' ] }, 'vec4',
				( a ) => vec4( cameraRayOf( vec2( a.uv ), uniform( m ), uniform( new Matrix4() ), u ).direction, 0 ) ) );
			const [ X, Y, B ] = [ 0, 1, 2 ].map( i => new Vector3().setFromMatrixColumn( m, i ).normalize() );
			for ( let i = 0; i < UVS.length / 2; i ++ ) {

				const [ ex, ey, ez ] = equalAreaSquareToSphere( UVS[ i * 2 ], UVS[ i * 2 + 1 ] );
				// pbrt swaps y and z: camera ( x, y, z ) = ( ex, ez, ey ), z forward.
				const want = X.clone().multiplyScalar( ex ).addScaledVector( Y, ez ).addScaledVector( B, - ey ).normalize().toArray();
				want.forEach( ( w, c ) => expect( out[ i * 4 + c ], `${look} ${mirrored ? 'mirrored' : ''} #${i}` ).toBeCloseTo( w, 4 ) );

			}

		}

	} );

	it( 'looks up at the centre, down at the corners, and round the horizon at the edges\' middles', async () => {

		// Hand-checked from pbrt's formula: centre r = 0 → +z (up after the swap); corners r = 0 → −z; edge middles r = 1, z = 0.
		const anchors = [[ 0.5, 0.5, 'up' ], [ 0, 0, 'down' ], [ 1, 1, 'down' ], [ 1, 0, 'down' ], [ 1, 0.5, 'right' ], [ 0, 0.5, 'left' ], [ 0.5, 1, 'forward' ], [ 0.5, 0, 'back' ], [ 0.75, 0.75, null ], [ 0.25, 0.5, null ]];
		const m = cameraMatrix( [ 0.3, 0.2, 1 ], false );
		const [ X, Y, B ] = [ 0, 1, 2 ].map( i => new Vector3().setFromMatrixColumn( m, i ).normalize() );
		const ways = { up: Y, down: Y.clone().negate(), right: X, left: X.clone().negate(), forward: B.clone().negate(), back: B };
		const u = cameraRayUniforms();
		u.cameraProjection.value = CAMERA_PROJECTION_IDS.equalArea;
		const out = new Float32Array( await evaluate( renderer, anchors.length, { uv: [ new Float32Array( anchors.flatMap( ( [ a, b ] ) => [ a, b ] ) ), 'vec2' ] }, 'vec4',
			( a ) => vec4( cameraRayOf( vec2( a.uv ), uniform( m ), uniform( new Matrix4() ), u ).direction, 0 ) ) );
		anchors.forEach( ( [ a, b, way ], i ) => {

			const d = new Vector3().fromArray( out, i * 4 );
			expect( [ ...d.toArray() ].every( Number.isFinite ) && Math.abs( d.length() - 1 ) < 1e-5, `${a}, ${b}` ).toBe( true );
			if ( way ) expect( d.dot( ways[ way ] ), `${a}, ${b} → ${way}` ).toBeCloseTo( 1, 5 );

		} );

	} );

} );
