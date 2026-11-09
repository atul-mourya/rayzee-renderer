/**
 * The panorama a pbrt spherical camera asks for (PBRTSceneBuilder PBRT_PANORAMA) is pbrt-v4's equirectangular image:
 * SphericalCamera::GenerateRay's θ = π v, φ = 2π u, ( sin θ cos φ, cos θ, sin θ sin φ ) in a camera frame of image
 * right, up and forward — mirrored or not, as the importer leaves the camera. A levelled horizon keeps a mirror too.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { uniform, vec2, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { cameraRayOf, cameraRayUniforms } from '@/core/shaders/CameraRay.js';
import { CAMERA_PROJECTION_IDS } from '@/core/EngineDefaults.js';

const UVS = [];
for ( let v = 0.05; v < 1; v += 0.15 ) for ( let u = 0.03; u < 1; u += 0.08 ) UVS.push( u, v );

// A camera at ( 1, 2, 3 ) looking along ( dx, dy, dz ), mirrored in x as the importer may leave it.
function cameraMatrix( [ dx, dy, dz ], mirrored ) {

	const m = new Matrix4().lookAt( new Vector3(), new Vector3( - dx, - dy, - dz ), new Vector3( 0, 1, 0 ) );
	m.setPosition( 1, 2, 3 );
	if ( mirrored ) m.scale( new Vector3( - 1, 1, 1 ) );
	return m;

}

function pbrtDirections( m ) {

	const [ X, Y, B ] = [ 0, 1, 2 ].map( i => new Vector3().setFromMatrixColumn( m, i ).normalize() );
	const Z = B.negate();
	const out = [];
	for ( let i = 0; i < UVS.length; i += 2 ) {

		const theta = Math.PI * UVS[ i + 1 ], phi = 2 * Math.PI * UVS[ i ];
		out.push( X.clone().multiplyScalar( Math.sin( theta ) * Math.cos( phi ) ).addScaledVector( Y, Math.cos( theta ) ).addScaledVector( Z, Math.sin( theta ) * Math.sin( phi ) ).toArray() );

	}

	return out;

}

describeGPU( 'a pbrt spherical camera\'s panorama', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const directions = async ( m, lon, level ) => {

		const u = cameraRayUniforms();
		u.cameraProjection.value = CAMERA_PROJECTION_IDS.equirectangular;
		u.panoLonRange.value.set( lon[ 0 ], lon[ 1 ] ).multiplyScalar( Math.PI / 180 );
		u.panoLatRange.value.set( - Math.PI / 2, Math.PI / 2 );
		u.panoLevelHorizon.value = level ? 1 : 0;
		const out = new Float32Array( await evaluate( renderer, UVS.length / 2, { uv: [ new Float32Array( UVS ), 'vec2' ] }, 'vec4',
			( a ) => vec4( cameraRayOf( vec2( a.uv ), uniform( m ), uniform( new Matrix4() ), u ).direction, 0 ) ) );
		return Array.from( { length: UVS.length / 2 }, ( _, i ) => Array.from( out.slice( i * 4, i * 4 + 3 ) ) );

	};

	it( 'draws pbrt\'s image from longitude 90° to −270° in the camera\'s own frame, mirrored or not', async () => {

		for ( const mirrored of [ false, true ] ) for ( const look of [[ 0, 0, 1 ], [ 0.3, 0.6, 1 ], [ - 1, - 0.4, 0.2 ]] ) {

			const m = cameraMatrix( look, mirrored );
			const got = await directions( m, [ 90, - 270 ], false );
			pbrtDirections( m ).forEach( ( want, i ) => want.forEach( ( w, c ) => expect( got[ i ][ c ], `${look} ${mirrored ? 'mirrored' : ''} #${i}` ).toBeCloseTo( w, 4 ) ) );

		}

	} );

	it( 'levels the horizon without turning a mirrored camera\'s panorama round', async () => {

		for ( const mirrored of [ false, true ] ) {

			// Level already: levelling changes nothing.
			const m = cameraMatrix( [ 0.4, 0, 1 ], mirrored );
			const free = await directions( m, [ - 180, 180 ], false ), levelled = await directions( m, [ - 180, 180 ], true );
			free.forEach( ( d, i ) => d.forEach( ( v, c ) => expect( levelled[ i ][ c ], `${mirrored ? 'mirrored' : ''} #${i}` ).toBeCloseTo( v, 4 ) ) );

		}

	} );

} );
