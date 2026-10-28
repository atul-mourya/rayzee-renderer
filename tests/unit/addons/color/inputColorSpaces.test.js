import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinearSRGBColorSpace, NoColorSpace, SRGBColorSpace, Texture } from 'three';

const ocio = vi.hoisted( () => ( { runtime: null, info: null } ) );

vi.mock( '@/core/addons/color/OcioRuntime.js', () => ( {
	getRuntime: () => ocio.runtime,
	getConfigInfo: () => ocio.info,
} ) );

import {
	getInputVersion, bumpInputVersion, setInputOverride, clearInputOverrides, listInputOverrides, listFileRules,
	resolveInputSpace, isDataTexture, resolveTextureSpace, textureInputSpace,
} from '@/core/addons/color/InputColorSpaces.js';

const space = ( name, { aliases = [], isData = false } = {} ) => ( { name, aliases, isData } );

const config = ( { roles = [], colorSpaces = [], fileRules = [] } = {} ) => ( { roles, colorSpaces, fileRules } );

const ACES = config( {
	roles: [
		{ name: 'data', colorSpace: 'Raw' },
		{ name: 'texture_paint', colorSpace: 'sRGB Encoded Rec.709 (sRGB)' },
		{ name: 'scene_linear', colorSpace: 'ACEScg' },
	],
	colorSpaces: [
		space( 'ACEScg' ), space( 'ACEScct' ), space( 'Linear Rec.709 (sRGB)' ), space( 'sRGB Encoded Rec.709 (sRGB)' ),
		space( 'Raw', { isData: true } ), space( 'Non-Color', { aliases: [ 'Generic Data' ], isData: true } ),
	],
	fileRules: [
		{ index: 0, name: 'LogC', colorSpace: 'ACEScct', pattern: '*_logc*', extension: '*', regex: '', extra: 'dropped' },
		{ index: 1, name: 'Default', colorSpace: 'ACEScg', pattern: '', extension: '', regex: '' },
	],
} );

const matchFileRule = path => {

	if ( path.includes( '_logc' ) ) return { colorSpace: 'ACEScct', isDefaultRule: false, ruleIndex: 0, ruleName: 'LogC' };
	if ( path.includes( '_ghost' ) ) return { colorSpace: 'Missing', isDefaultRule: false, ruleIndex: 2, ruleName: 'Ghost' };
	return { colorSpace: 'ACEScg', isDefaultRule: true, ruleIndex: 1, ruleName: 'Default' };

};

const textureOf = ( colorSpace, extra = {} ) => Object.assign( new Texture(), { colorSpace }, extra );

describe( 'input colour spaces without a config', () => {

	beforeEach( () => {

		ocio.runtime = null;
		ocio.info = null;

	} );

	it( 'answers nothing, though a three.js data texture is data either way', () => {

		expect( resolveInputSpace( 'albedo.png', { threeColorSpace: SRGBColorSpace } ) ).toBeNull();
		expect( resolveTextureSpace( textureOf( SRGBColorSpace ) ) ).toBeNull();
		expect( textureInputSpace( textureOf( SRGBColorSpace ) ) ).toBeNull();
		expect( listFileRules() ).toEqual( [] );
		expect( isDataTexture( textureOf( NoColorSpace ) ) ).toBe( true );
		expect( isDataTexture( textureOf( SRGBColorSpace, { userData: { ocioColorSpace: 'Raw' } } ) ) ).toBe( false );
		expect( isDataTexture( null ) ).toBe( false );

	} );

} );

describe( 'input colour spaces', () => {

	beforeEach( () => {

		ocio.info = ACES;
		ocio.runtime = { matchFileRule: vi.fn( matchFileRule ) };

	} );

	afterEach( () => {

		clearInputOverrides();

	} );

	it( 'bumps the version whenever an answer could change', () => {

		const start = getInputVersion();
		bumpInputVersion();
		setInputOverride( 'plate', 'ACEScct' );
		clearInputOverrides();
		expect( getInputVersion() ).toBe( start + 3 );
		clearInputOverrides();
		expect( getInputVersion() ).toBe( start + 3 );

	} );

	it( 'honours an override first, the newest when several match', () => {

		setInputOverride( 'textures/', 'Linear Rec.709 (sRGB)' );
		setInputOverride( /_logc\.exr$/, 'ACEScg' );
		expect( listInputOverrides() ).toEqual( [
			{ match: '/_logc\\.exr$/', colorSpace: 'ACEScg' },
			{ match: 'textures/', colorSpace: 'Linear Rec.709 (sRGB)' },
		] );

		expect( resolveInputSpace( 'textures/plate_logc.exr' ) ).toEqual( { colorSpace: 'ACEScg', via: 'override', rule: null } );
		expect( resolveInputSpace( 'textures/wall_logc.png' ) ).toEqual( { colorSpace: 'Linear Rec.709 (sRGB)', via: 'override', rule: null } );
		expect( ocio.runtime.matchFileRule ).not.toHaveBeenCalled();

	} );

	it( 'takes a file rule that names this file over what three.js assumed', () => {

		expect( resolveInputSpace( 'shots/plate_logc.exr', { threeColorSpace: SRGBColorSpace } ) )
			.toEqual( { colorSpace: 'ACEScct', via: 'rule', rule: { index: 0, name: 'LogC' } } );

	} );

	it( 'prefers three.js over the default rule, and the default rule over nothing', () => {

		expect( resolveInputSpace( 'albedo.png', { threeColorSpace: SRGBColorSpace } ) ).toEqual( { colorSpace: 'sRGB Encoded Rec.709 (sRGB)', via: 'three', rule: null } );
		expect( resolveInputSpace( 'albedo.png' ) ).toEqual( { colorSpace: 'ACEScg', via: 'rule', rule: { index: 1, name: 'Default', isDefault: true } } );
		expect( resolveInputSpace( 'albedo_ghost.png' ) ).toBeNull();
		expect( resolveInputSpace( null ) ).toBeNull();

	} );

	it( 'maps three.js\'s spaces onto the config\'s roles, then its names', () => {

		const three = ( info, colorSpace ) => {

			ocio.info = info;
			return resolveInputSpace( null, { threeColorSpace: colorSpace } )?.colorSpace ?? null;

		};

		expect( three( ACES, NoColorSpace ) ).toBe( 'Raw' );
		expect( three( ACES, SRGBColorSpace ) ).toBe( 'sRGB Encoded Rec.709 (sRGB)' );
		expect( three( ACES, LinearSRGBColorSpace ) ).toBe( 'Linear Rec.709 (sRGB)' );
		expect( three( ACES, 'display-p3' ) ).toBeNull();

		const picking = config( { roles: [ { name: 'color_picking', colorSpace: 'sRGB - Texture' } ] } );
		expect( three( picking, SRGBColorSpace ) ).toBe( 'sRGB - Texture' );

		const named = config( { colorSpaces: [ space( 'sRGB - Display' ), space( 'sRGB Texture' ), space( 'Linear sRGB' ), space( 'lin_rec709' ) ] } );
		expect( three( named, SRGBColorSpace ) ).toBe( 'sRGB Texture' );
		expect( three( named, LinearSRGBColorSpace ) ).toBe( 'lin_rec709' );
		expect( three( config( { colorSpaces: [ space( 'Linear sRGB' ) ] } ), LinearSRGBColorSpace ) ).toBe( 'Linear sRGB' );
		expect( three( config( { roles: [ { name: 'scene_linear', colorSpace: 'ACEScg' } ] } ), LinearSRGBColorSpace ) ).toBe( 'ACEScg' );
		expect( three( config( { colorSpaces: [ space( 'sRGB - Display' ) ] } ), SRGBColorSpace ) ).toBeNull();
		expect( three( config(), NoColorSpace ) ).toBeNull();

	} );

	it( 'treats a texture as data when three.js or its tag says so', () => {

		expect( isDataTexture( textureOf( NoColorSpace ) ) ).toBe( true );
		expect( isDataTexture( textureOf( SRGBColorSpace, { userData: { ocioColorSpace: 'Generic Data' } } ) ) ).toBe( true );
		expect( isDataTexture( textureOf( SRGBColorSpace, { userData: { ocioColorSpace: 'ACEScg' } } ) ) ).toBe( false );
		expect( isDataTexture( textureOf( SRGBColorSpace ) ) ).toBe( false );

	} );

	it( 'resolves a texture by its tag, then by where it came from', () => {

		expect( resolveTextureSpace( textureOf( SRGBColorSpace, { userData: { ocioColorSpace: 'ACEScct' } } ) ) ).toEqual( { colorSpace: 'ACEScct', via: 'tag', rule: null } );
		expect( resolveTextureSpace( textureOf( SRGBColorSpace, { userData: { ocioColorSpace: 'Unknown' } } ) ) ).toBeNull();
		expect( resolveTextureSpace( textureOf( NoColorSpace ) ) ).toBeNull();
		expect( resolveTextureSpace( null ) ).toBeNull();

		const logc = { via: 'rule', colorSpace: 'ACEScct' };
		expect( resolveTextureSpace( textureOf( SRGBColorSpace ), 'given_logc.exr' ) ).toMatchObject( logc );
		expect( resolveTextureSpace( textureOf( SRGBColorSpace, { userData: { sourcePath: 'source_logc.exr' } } ) ) ).toMatchObject( logc );
		expect( resolveTextureSpace( textureOf( SRGBColorSpace, { name: 'named_logc.exr' } ) ) ).toMatchObject( logc );
		expect( resolveTextureSpace( textureOf( SRGBColorSpace, { image: { src: 'blob_logc.png' } } ) ) ).toMatchObject( logc );
		expect( ocio.runtime.matchFileRule.mock.calls.map( c => c[ 0 ] ) ).toEqual( [ 'given_logc.exr', 'source_logc.exr', 'named_logc.exr', 'blob_logc.png' ] );

		expect( textureInputSpace( textureOf( LinearSRGBColorSpace ) ) ).toBe( 'Linear Rec.709 (sRGB)' );
		expect( textureInputSpace( textureOf( NoColorSpace ) ) ).toBeNull();

	} );

	it( 'lists the config\'s file rules as a host shows them', () => {

		expect( listFileRules() ).toEqual( [
			{ index: 0, name: 'LogC', colorSpace: 'ACEScct', pattern: '*_logc*', extension: '*', regex: '' },
			{ index: 1, name: 'Default', colorSpace: 'ACEScg', pattern: '', extension: '', regex: '' },
		] );

	} );

} );
