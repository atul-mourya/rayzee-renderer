import { describe, it, expect } from 'vitest';
import { DirectionalLight, PointLight, SpotLight, Vector3 } from 'three';
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';
import { decodePFM } from '@/core/addons/archives/pbrt/PFM.js';
import { blackbodyRGB, sampledEmissionRGB } from '@/core/addons/archives/pbrt/PBRTMaterials.js';

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

	// pbrt-v4 (local build) looking straight at a two-sided diffuse area light, 16² pixels × 4096 spp, averaged: linear
	// Rec.709 out of its default cie1931 sensor. Half-float output and spectral noise leave ~0.001.
	const PBRT_BLACKBODY = {
		1000: [ 4.60002, 0.03953, - 0.09003 ], 1500: [ 3.26479, 0.43400, - 0.06421 ], 1900: [ 2.63970, 0.61344, - 0.00009 ],
		2300: [ 2.22511, 0.72767, 0.08928 ], 2856: [ 1.84534, 0.82603, 0.23335 ], 4000: [ 1.41416, 0.92397, 0.53332 ],
		5500: [ 1.14453, 0.97099, 0.86205 ], 6000: [ 1.08890, 0.97837, 0.95264 ], 6500: [ 1.04343, 0.98360, 1.03465 ],
		10000: [ 0.87200, 0.99467, 1.43018 ], 20000: [ 0.74835, 0.98961, 1.84434 ], 40000: [ 0.70105, 0.98339, 2.04559 ],
	};
	// The engine cannot emit a negative channel: 0, the others as bright as pbrt shows them.
	const clipped = ( rgb ) => rgb.map( v => Math.max( 0, v ) );
	const expectRGB = ( got, want, tolerance = 0.003 ) => {

		expect( got ).toHaveLength( want.length );
		want.forEach( ( v, i ) => expect( Math.abs( got[ i ] - v ) ).toBeLessThan( tolerance ) );

	};

	it( 'gives a blackbody pbrt\'s own colour, from 1000 to 40000 K', () => {

		for ( const [ kelvin, rgb ] of Object.entries( PBRT_BLACKBODY ) ) expectRGB( blackbodyRGB( + kelvin ), clipped( rgb ) );
		expect( blackbodyRGB( 0 ) ).toEqual( [ 0, 0, 0 ] );
		expect( blackbodyRGB( - 300 ) ).toEqual( [ 0, 0, 0 ] );

	} );

	// pbrt would reflect the curve itself, peaking at 1; kept as the hue, and reported.
	it( 'gives a blackbody read as a surface colour its hue at most 1, reported', async () => {

		const { group, parameters } = await build( `Material "diffuse" "blackbody reflectance" [ 2300 ]` );
		const { color } = group.getObjectByProperty( 'isMesh', true ).material;
		const want = PBRT_BLACKBODY[ 2300 ].map( v => v / PBRT_BLACKBODY[ 2300 ][ 0 ] );
		expectRGB( [ color.r, color.g, color.b ], want, 0.002 );
		expect( parameters.approximated ).toEqual( { 'Material diffuse: reflectance': 1 } );

	} );

	it( 'gives a sampled emission spectrum pbrt\'s colour, dark outside its samples', () => {

		expectRGB( sampledEmissionRGB( [ 400, 0.2, 500, 1, 600, 0.5, 700, 0.1 ] ), [ 0.54578, 1.15500, 0.80245 ] );
		// Hard band edges: a looser tolerance.
		expectRGB( sampledEmissionRGB( [ 600, 1, 650, 1 ] ), clipped( [ 5.41945, - 0.20416, - 0.08403 ] ), 0.016 );
		expectRGB( sampledEmissionRGB( [ 450, 3, 470, 0, 520, 2 ] ), clipped( [ - 1.43776, 1.52908, 2.92403 ] ), 0.006 );
		expectRGB( sampledEmissionRGB( [ 900, 1, 950, 1 ] ), [ 0, 0, 0 ] );

	} );

	it( 'colours an area light by its blackbody, scale on top', async () => {

		const { group, parameters } = await build( `AreaLightSource "diffuse" "blackbody L" [ 2300 ] "float scale" 2` );
		const { emissive, emissiveIntensity } = group.getObjectByProperty( 'isMesh', true ).material;
		expectRGB( [ emissive.r, emissive.g, emissive.b ].map( v => v * emissiveIntensity ), PBRT_BLACKBODY[ 2300 ].map( v => 2 * v ), 0.006 );
		expect( parameters.approximated ).toEqual( {} );

	} );

	it( 'colours a lamp by its blackbody, illuminant A or sampled spectrum as pbrt does', async () => {

		const colour = async ( spectrum ) => {

			const { group, parameters } = await build( `LightSource "point" ${spectrum}` );
			const [ point ] = lamps( group, PointLight );
			const c = point.color.clone().multiplyScalar( point.intensity / ( 4 * Math.PI ) );
			return { rgb: [ c.r, c.g, c.b ], approximated: parameters.approximated };

		};

		const blackbody = await colour( '"blackbody I" [ 6500 ]' );
		expectRGB( blackbody.rgb, PBRT_BLACKBODY[ 6500 ] );
		expect( blackbody.approximated ).toEqual( {} );
		// pbrt's render of "stdillum-A"
		expectRGB( ( await colour( '"spectrum I" "stdillum-A"' ) ).rgb, [ 1.84554, 0.82598, 0.23328 ] );
		const sampled = await colour( '"spectrum I" [ 400 0.2 500 1 600 0.5 700 0.1 ]' );
		expectRGB( sampled.rgb, [ 0.54578, 1.15500, 0.80245 ] );
		expect( sampled.approximated ).toEqual( {} );
		const d65 = await colour( '"spectrum I" "stdillum-D65"' );
		expectRGB( d65.rgb, [ 1, 1, 1 ], 1e-6 );
		expect( d65.approximated ).toEqual( {} );
		// pbrt's F2 is not white; its table is not kept, so the lamp is white and says so.
		expect( ( await colour( '"spectrum I" "stdillum-F2"' ) ).approximated ).toEqual( { 'LightSource point: I': 1 } );

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
