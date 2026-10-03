import { describe, it, expect } from 'vitest';
import { DirectionalLight, PointLight, SpotLight, Vector3 } from 'three';
import { loadPBRTScene } from '@/core/Processor/PBRT/index.js';
import { decodePFM } from '@/core/Processor/PBRT/PFM.js';

const enc = new TextEncoder();

async function build( world ) {

	return loadPBRTScene( {
		vfs: { 'scene.pbrt': enc.encode( `LookAt 0 0 5  0 0 0  0 1 0\nCamera "perspective"\nWorldBegin\n${world}\nShape "sphere"\n` ) },
		plyParser: () => null,
		imageFromBytes: async () => null,
	} );

}

const lamps = ( group, Type ) => group.children.filter( c => c instanceof Type );
const aim = ( light ) => light.target.getWorldPosition( new Vector3() ).sub( light.getWorldPosition( new Vector3() ) ).normalize();

describe( 'pbrt lights', () => {

	it( 'maps a distant light to a directional lamp giving irradiance L × scale', async () => {

		const { group, environment } = await build( `
			AttributeBegin
				Rotate 90 0 1 0
				LightSource "distant" "rgb L" [ 2 4 1 ] "float scale" 2.5 "point3 from" [ 0 0 0 ] "point3 to" [ 0 0 1 ]
			AttributeEnd` );
		const [ sun ] = lamps( group, DirectionalLight );
		group.updateMatrixWorld( true );

		expect( environment ).toBeNull();
		expect( sun.intensity ).toBeCloseTo( 10 );
		expect( sun.color.toArray() ).toEqual( [ 0.5, 1, 0.25 ] );
		expect( sun.userData.__luxConverted ).toBe( true );
		const [ x, y, z ] = aim( sun ).toArray();
		expect( [ x, Math.abs( y ), Math.abs( z ) ] ).toEqual( [ expect.closeTo( 1 ), expect.closeTo( 0 ), expect.closeTo( 0 ) ] );

	} );

	it( 'maps point and spot lights to 4π × their radiant intensity', async () => {

		const { group } = await build( `
			LightSource "point" "rgb I" [ 3 3 3 ] "point3 from" [ 1 2 3 ]
			LightSource "point" "float power" 100
			LightSource "spot" "rgb I" [ 1 1 1 ] "float scale" 2 "float coneangle" 30 "float conedeltaangle" 10 "point3 from" [ 0 4 0 ] "point3 to" [ 0 0 0 ]` );
		const [ point, powered ] = lamps( group, PointLight );
		const [ spot ] = lamps( group, SpotLight );
		group.updateMatrixWorld( true );

		expect( point.intensity ).toBeCloseTo( 12 * Math.PI );
		expect( point.position.toArray() ).toEqual( [ 1, 2, 3 ] );
		expect( point.userData.__candelaConverted ).toBe( true );
		expect( powered.intensity ).toBeCloseTo( 100 );

		expect( spot.intensity ).toBeCloseTo( 8 * Math.PI );
		expect( spot.angle ).toBeCloseTo( Math.PI / 6 );
		// The engine's falloff starts ( 1 − cos cone ) × penumbra inside the cone edge, pbrt's at cos( cone − delta ).
		const cosEnd = Math.cos( Math.PI / 6 );
		expect( cosEnd + ( 1 - cosEnd ) * spot.penumbra ).toBeCloseTo( Math.cos( 20 * Math.PI / 180 ) );
		expect( aim( spot ).y ).toBeCloseTo( - 1 );

	} );

	it( 'brings a blackbody light to luminance 1, as pbrt does', async () => {

		const { group } = await build( `LightSource "point" "blackbody I" [ 3000 ]` );
		const [ point ] = lamps( group, PointLight );
		const c = point.color.clone().multiplyScalar( point.intensity / ( 4 * Math.PI ) );
		expect( 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b ).toBeCloseTo( 1 );
		expect( c.r ).toBeGreaterThan( c.b );

	} );

} );

describe( 'PFM', () => {

	const pfm = ( header, floats, little ) => {

		const head = enc.encode( header );
		const bytes = new Uint8Array( head.length + floats.length * 4 );
		bytes.set( head );
		const view = new DataView( bytes.buffer, head.length );
		floats.forEach( ( v, i ) => view.setFloat32( i * 4, v, little ) );
		return bytes;

	};

	it( 'reads RGB rows bottom first in either byte order, scaled by |scale|', () => {

		const rows = [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ];
		const little = decodePFM( pfm( 'PF\n2 2\n-1.0\n', rows, true ) );
		expect( [ little.width, little.height ] ).toEqual( [ 2, 2 ] );
		expect( [ ...little.data.slice( 0, 8 ) ] ).toEqual( [ 1, 2, 3, 1, 4, 5, 6, 1 ] );

		const big = decodePFM( pfm( 'PF\n2 2\n2\n', rows, false ) );
		expect( big.data[ 12 ] ).toBe( 20 );

	} );

	it( 'reads grey images into all three channels and rejects others', () => {

		const grey = decodePFM( pfm( 'Pf 1 1 -1 ', [ 0.5 ], true ) );
		expect( [ ...grey.data ] ).toEqual( [ 0.5, 0.5, 0.5, 1 ] );
		expect( () => decodePFM( enc.encode( 'P6\n1 1\n255\n' ) ) ).toThrow();
		expect( () => decodePFM( pfm( 'PF\n2 2\n-1\n', [ 1, 2 ], true ) ) ).toThrow( /truncated/ );

	} );

} );
