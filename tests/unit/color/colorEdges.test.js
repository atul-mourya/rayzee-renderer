/**
 * The edges the first audit found: pieces that were right in isolation and wrong in combination.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ColorManagement, findNativeLinearSpace, canvasColorSpaceFor } from '@/core/Color/ColorManagement.js';
import { getWorkingMatrix, setWorkingMatrix } from '@/core/Color/WorkingMatrix.js';
import { EmissiveTriangleBuilder } from '@/core/Processor/EmissiveTriangleBuilder.js';
import { configureAssets } from '@/core/AssetConfig.js';

const BUILTIN = 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

describe( 'finding the native linear space', () => {

	const cs = ( name, aliases = [], isData = false ) => ( { name, aliases, isData } );

	it( 'accepts an alias as readily as a name', () => {

		// Blender's spelling, with the ACES one only as an alias.
		expect( findNativeLinearSpace( { colorSpaces: [ cs( 'Linear Rec.709', [ 'Linear Rec.709 (sRGB)' ] ) ] } ) ).toBe( 'Linear Rec.709' );
		expect( findNativeLinearSpace( { colorSpaces: [ cs( 'scene', [ 'lin_rec709' ] ) ] } ) ).toBe( 'scene' );

	} );

	it( 'never picks a data space, and says so when nothing qualifies', () => {

		expect( findNativeLinearSpace( { colorSpaces: [ cs( 'lin_rec709', [], true ) ] } ) ).toBeNull();
		expect( findNativeLinearSpace( { colorSpaces: [ cs( 'ACEScg' ), cs( 'Linear P3-D65' ) ] } ) ).toBeNull();

	} );

} );

describe( 'which canvas colour space a display gets', () => {

	it( 'switches only for a display whose encoding is a canvas colour space', () => {

		expect( canvasColorSpaceFor( 'Display P3 - Display' ) ).toBe( 'display-p3' );
		expect( canvasColorSpaceFor( 'Display P3' ) ).toBe( 'display-p3' );
		// Same primaries, a 2.6 cinema gamma — not what display-p3 means.
		expect( canvasColorSpaceFor( 'P3-D65 - Display' ) ).toBe( 'srgb' );
		expect( canvasColorSpaceFor( 'Display P3 HDR - Display' ) ).toBe( 'srgb' );
		expect( canvasColorSpaceFor( 'Rec.2100-PQ - Display' ) ).toBe( 'srgb' );
		expect( canvasColorSpaceFor( 'sRGB - Display' ) ).toBe( 'srgb' );

	} );

} );

describe( 'the texture cache key', () => {

	it( 'changes when a map is read as a different colour space', async () => {

		const { TextureCreator } = await import( '@/core/Processor/TextureCreator.js' );
		const creator = new TextureCreator();
		const tex = { image: { width: 4, height: 4, src: 'albedo.png' }, colorSpace: 'srgb', userData: {} };

		const before = creator.textureCache.generateHash( [ tex ] );
		tex.userData.ocioColorSpace = 'ACEScct';
		expect( creator.textureCache.generateHash( [ tex ] ) ).not.toBe( before );

		delete tex.userData.ocioColorSpace;
		tex.colorSpace = 'srgb-linear';
		expect( creator.textureCache.generateHash( [ tex ] ) ).not.toBe( before );

	} );

} );

suite( 'with a config loaded', () => {

	let cm;

	beforeAll( async () => {

		cm = new ColorManagement();
		await cm.loadConfig( { builtin: BUILTIN, registerViews: false } );

	}, 120000 );

	afterAll( () => ColorManagement.resetAll() );

	it( 'names the unmanaged working space the way the config does', () => {

		expect( cm.workingSpaceAdopted ).toBe( false );
		expect( cm.workingSpace ).toBe( cm.nativeLinearSpace );

	} );

	it( 'round-trips an environment converted in place, and converts a regenerated one again', () => {

		const pixels = new Float32Array( [ 0.8, 0.2, 0.05, 1, 0.1, 0.6, 0.9, 1 ] );
		const original = Float32Array.from( pixels );
		const env = { image: { data: pixels }, userData: {}, needsUpdate: false };

		cm.setWorkingSpace( 'ACEScg' );
		expect( cm.convertTexturePixels( env ) ).toBe( true );
		expect( env.userData.__rayzeeColorSpace ).toBe( 'ACEScg' );
		const converted = Float32Array.from( pixels );
		expect( converted[ 0 ] ).not.toBeCloseTo( original[ 0 ], 3 );

		// Handed over again unchanged: must not be converted a second time.
		expect( cm.convertTexturePixels( env ) ).toBe( false );
		expect( Array.from( pixels ) ).toEqual( Array.from( converted ) );

		// Turned back off: converted back from what it holds, not refused for having been touched.
		cm.setWorkingSpace( null );
		expect( cm.convertTexturePixels( env ) ).toBe( true );
		for ( let i = 0; i < 8; i ++ ) expect( pixels[ i ] ).toBeCloseTo( original[ i ], 5 );

		// A sky regenerates into the same texture and clears the record; that is fresh data.
		cm.setWorkingSpace( 'ACEScg' );
		pixels.set( original );
		delete env.userData.__rayzeeColorSpace;
		expect( cm.convertTexturePixels( env ) ).toBe( true );
		expect( pixels[ 0 ] ).toBeCloseTo( converted[ 0 ], 5 );

		cm.setWorkingSpace( null );

	}, 120000 );

	it( 'converts emitters the lights are sampled from, not only the ones the camera sees', () => {

		const builder = new EmissiveTriangleBuilder();
		const unmanaged = [ 0.8, 0.2, 0.05 ];

		cm.setWorkingSpace( 'ACEScg' );
		const m = getWorkingMatrix();
		expect( m ).toBeTruthy();

		const want = [
			m[ 0 ] * 0.8 + m[ 1 ] * 0.2 + m[ 2 ] * 0.05,
			m[ 3 ] * 0.8 + m[ 4 ] * 0.2 + m[ 5 ] * 0.05,
			m[ 6 ] * 0.8 + m[ 7 ] * 0.2 + m[ 8 ] * 0.05,
		];

		// One emissive triangle, material 0.
		const tri = new Uint32Array( 20 );
		const f = new Float32Array( tri.buffer );
		f.set( [ 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0 ], 0 );
		tri[ 18 ] = 0;
		tri[ 19 ] = 0;
		const materials = [ { emissive: { r: unmanaged[ 0 ], g: unmanaged[ 1 ], b: unmanaged[ 2 ] }, emissiveIntensity: 1 } ];

		expect( builder.extractEmissiveTriangles( tri, materials, 1 ) ).toBe( 1 );
		const got = builder.emissiveTriangles[ 0 ].emissive;
		expect( got.r ).toBeCloseTo( want[ 0 ], 6 );
		expect( got.g ).toBeCloseTo( want[ 1 ], 6 );
		expect( got.b ).toBeCloseTo( want[ 2 ], 6 );

		cm.setWorkingSpace( null );
		expect( builder.extractEmissiveTriangles( tri, materials, 1 ) ).toBe( 1 );
		expect( builder.emissiveTriangles[ 0 ].emissive.r ).toBeCloseTo( 0.8, 6 );

	}, 120000 );

	it( 'drops a working space the next config does not have', async () => {

		cm.setWorkingSpace( 'ACEScg' );
		const events = [];
		const off = cm.on( 'workingSpace', w => events.push( w ) );

		// A config with no ACEScg at all. Keeping the name would make every conversion throw.
		await cm.loadConfig( {
			text: `ocio_profile_version: 2
roles:
  default: linear
  scene_linear: linear
  data: raw
file_rules:
  - !<Rule> {name: Default, colorspace: linear}
displays:
  sRGB:
    - !<View> {name: Raw, colorspace: raw}
colorspaces:
  - !<ColorSpace> {name: linear, encoding: scene-linear, isdata: false}
  - !<ColorSpace> {name: raw, isdata: true}
`,
			id: 'no-acescg',
			registerViews: false,
		} );

		off();
		expect( cm.workingSpaceAdopted ).toBe( false );
		// And the host is told, because its scene is still converted into the old space.
		expect( events ).toHaveLength( 1 );

		await cm.loadConfig( { builtin: BUILTIN, registerViews: false } );

	}, 120000 );

	it( 'leaves no working matrix behind when disposed', () => {

		const other = new ColorManagement();
		// Not the active instance, so it may not touch what the active one published.
		setWorkingMatrix( [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );
		other.dispose();
		expect( getWorkingMatrix() ).not.toBeNull();
		setWorkingMatrix( null );

	} );

} );
