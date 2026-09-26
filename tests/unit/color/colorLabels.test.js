/**
 * What the artist sees, from real configs: the built-in ACES CG config and, when installed,
 * Blender's own. Made-up fixtures would only test the rules against my idea of a config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	builtinConfigOptions, configLabel, displayLabel, viewLabels, looksForView,
	workingSpaceOptions, textureSpaceGroups, exportSpaceOptions, displaySections, isHdrDisplay, spaceLabel,
	screenHint, toneMappingHint,
} from '@/lib/colorLabels.js';
import { displayCanvasFit } from '@/core/Color/Displays.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { loadConfig, listBuiltinConfigs, resetOcio } from '@/core/Color/OcioRuntime.js';
import { findNativeLinearSpace } from '@/core/Color/ColorManagement.js';
import { getConfigInfo } from '@/core/Color/OcioRuntime.js';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

const BLENDER = '/Applications/Blender.app/Contents/Resources/5.1/datafiles/colormanagement';

describe( 'labels that need no config', () => {

	it( 'drops the ACES display suffix and nothing else', () => {

		expect( displayLabel( 'sRGB - Display' ) ).toBe( 'sRGB' );
		expect( displayLabel( 'Rec.2100-PQ - Display' ) ).toBe( 'Rec.2100-PQ' );
		expect( displayLabel( 'Display P3' ) ).toBe( 'Display P3' );

	} );

	it( 'shortens a view to its name, adding detail only where two would collide', () => {

		const sdr = viewLabels( [ 'ACES 2.0 - SDR 100 nits (Rec.709)', 'Un-tone-mapped', 'Raw' ] );
		expect( sdr.get( 'ACES 2.0 - SDR 100 nits (Rec.709)' ) ).toBe( 'ACES 2.0' );
		expect( sdr.get( 'Raw' ) ).toBe( 'Raw' );

		// The PQ display's views differ only in their brackets.
		const pq = viewLabels( [
			'ACES 2.0 - HDR 1000 nits (P3 D65)', 'ACES 2.0 - HDR 1000 nits (Rec.2020)', 'ACES 2.0 - SDR 100 nits (Rec.709)',
		] );
		const all = [ ...pq.values() ];
		expect( new Set( all ).size ).toBe( 3 );
		expect( pq.get( 'ACES 2.0 - SDR 100 nits (Rec.709)' ) ).toBe( 'ACES 2.0 · SDR 100 nits' );
		expect( pq.get( 'ACES 2.0 - HDR 1000 nits (Rec.2020)' ) ).toBe( 'ACES 2.0 · HDR 1000 nits (Rec.2020)' );

	} );

	it( 'names common colour spaces the way an artist says them', () => {

		expect( spaceLabel( 'sRGB Encoded Rec.709 (sRGB)' ) ).toBe( 'sRGB' );
		expect( spaceLabel( 'Linear Rec.709 (sRGB)' ) ).toBe( 'Linear Rec.709' );
		expect( spaceLabel( 'ACEScg' ) ).toBe( 'ACEScg' );

	} );

	it( 'says in plain words what each screen is for', () => {

		const hints = [ 'sRGB', 'Display P3', 'Rec.1886', 'Rec.2020', 'Rec.2100-PQ', 'Rec.2100-HLG' ].map( screenHint );
		expect( hints ).toEqual( [
			'most monitors and laptops', 'Apple and wide-colour screens', 'TV and video', 'wide-colour TV', 'HDR10 TV', 'HDR broadcast',
		] );

		expect( screenHint( 'Display P3 HDR - Display' ) ).toBe( 'Apple HDR screens' );
		expect( screenHint( 'ST2084-P3-D65 - Display' ) ).toBe( 'HDR mastering monitors' );
		expect( screenHint( 'P3-D65 - Display' ) ).toBe( 'cinema projectors' );
		expect( screenHint( 'Rec.1886 Rec.709 - Display' ) ).toBe( 'TV and video' );
		expect( screenHint( 'Some Studio LUT' ) ).toBeNull();

	} );

	it( 'says in plain words what each tone mapping does, config views and built-in curves alike', () => {

		expect( toneMappingHint( 'AgX' ) ).toBe( 'natural, film-like (recommended)' );
		expect( toneMappingHint( 'AgX - HDR 1000 nits' ) ).toBe( 'natural, film-like (recommended)' );
		expect( toneMappingHint( 'Standard' ) ).toBe( 'no highlight roll-off' );
		expect( toneMappingHint( 'Filmic' ) ).toBe( "Blender's older film look" );
		expect( toneMappingHint( 'Filmic Log' ) ).toMatch( /log image/ );
		expect( toneMappingHint( 'Khronos PBR Neutral' ) ).toBe( 'accurate product colours' );
		expect( toneMappingHint( 'False Color' ) ).toBe( 'exposure check' );
		expect( toneMappingHint( 'Raw' ) ).toMatch( /technical/ );

		expect( toneMappingHint( 'ACES Filmic' ) ).toBe( 'film and VFX standard' );
		expect( toneMappingHint( 'Neutral' ) ).toBe( 'accurate product colours' );
		expect( toneMappingHint( 'None' ) ).toMatch( /no conversion/ );

	} );

	it( 'splits displays into SDR and HDR, and says which this screen shows converted', () => {

		const view = colorSpace => [ { name: 'Standard', colorSpace } ];
		const config = {
			displays: [ 'sRGB - Display', 'Display P3 - Display', 'Rec.2100-PQ - Display', 'P3-D65 - Display', 'ST2084-P3-D65 - Display' ],
			views: {
				'sRGB - Display': view( 'sRGB - Display' ),
				'Display P3 - Display': view( 'Display P3 - Display' ),
				'Rec.2100-PQ - Display': view( 'pq display' ),
				'P3-D65 - Display': view( 'P3-D65 - Display' ),
				'ST2084-P3-D65 - Display': view( 'unlisted space' ),
			},
			colorSpaces: [
				{ name: 'sRGB - Display', encoding: 'sdr-video' },
				{ name: 'Display P3 - Display', encoding: 'sdr-video' },
				{ name: 'PQ Rec.2020 - Display', aliases: [ 'pq display' ], encoding: 'hdr-video' },
				{ name: 'P3-D65 - Display', encoding: '' },
			],
		};

		const onSrgb = displaySections( config, displayCanvasFit, { p3: false } );
		expect( onSrgb.sdr.map( d => d.label ) ).toEqual( [ 'sRGB', 'Display P3', 'P3-D65' ] );
		expect( onSrgb.hdr.map( d => d.label ) ).toEqual( [ 'Rec.2100-PQ', 'ST2084-P3-D65' ] );
		expect( onSrgb.sdr.filter( d => d.native ).map( d => d.label ) ).toEqual( [ 'sRGB' ] );
		expect( onSrgb.sdr[ 1 ].description ).toMatch( /shows it converted/ );
		expect( onSrgb.hdr[ 0 ].hint ).toBe( 'HDR10 TV' );

		const onP3 = displaySections( config, displayCanvasFit, { p3: true } );
		expect( onP3.sdr.filter( d => d.native ).map( d => d.label ) ).toEqual( [ 'sRGB', 'Display P3' ] );

		expect( isHdrDisplay( config, 'P3-D65 - Display' ) ).toBe( false );
		expect( isHdrDisplay( config, 'ST2084-P3-D65 - Display' ) ).toBe( true );

	} );

} );

suite( 'the ACES CG config', () => {

	let config, native;

	beforeAll( async () => {

		resetOcio();
		config = await loadConfig( { builtin: 'cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } );
		native = findNativeLinearSpace( getConfigInfo() );

	}, 120000 );

	it( 'offers one preset per ACES version, newest CG config of each, and nothing else', async () => {

		const builtins = await listBuiltinConfigs();
		const { presets, ...rest } = builtinConfigOptions( builtins );
		expect( presets.map( p => p.label ) ).toEqual( [ 'ACES 2.0', 'ACES 1.3' ] );
		expect( presets[ 0 ].value ).toBe( 'cg-config-v4.0.0_aces-v2.0_ocio-v2.5' );
		expect( presets.map( p => p.hint ) ).toEqual( [ 'film and VFX standard, latest', 'film and VFX standard, previous' ] );
		expect( builtins.length ).toBeGreaterThan( presets.length );
		expect( rest ).toEqual( {} );
		expect( configLabel( config, presets ) ).toBe( 'ACES 2.0' );

	} );

	it( 'offers only the spaces the config tags for rendering, native first, never the interchange space', () => {

		const options = workingSpaceOptions( config, native );
		expect( options[ 0 ] ).toMatchObject( { value: native, label: 'Rec.709', native: true } );
		expect( options.map( o => o.label ) ).toEqual( [ 'Rec.709', 'ACEScg', 'P3-D65' ] );
		expect( options.some( o => o.value === 'ACES2065-1' ) ).toBe( false );
		// Tagged working-space but log, so not somewhere to render.
		expect( options.some( o => o.value === 'ACEScct' ) ).toBe( false );

	} );

	it( 'offers textures only what the config tags as a texture space, grouped by family', () => {

		const groups = textureSpaceGroups( config );
		const names = groups.flatMap( g => g.items.map( i => i.value ) );
		expect( groups.map( g => g.family ) ).toEqual( [ 'ACES', 'Utility' ] );
		expect( names ).toContain( 'sRGB Encoded Rec.709 (sRGB)' );
		// Read from the tags, not guessed: the config describes every space with its categories.
		expect( config.colorSpaces.find( c => c.name === 'ACEScg' ).categories ).toContain( 'texture' );
		expect( names.some( n => /- Display$/.test( n ) ) ).toBe( false );

	} );

	it( 'offers an EXR scene-referred spaces, the interchange space first', () => {

		const options = exportSpaceOptions( config );
		expect( options[ 0 ].value ).toBe( 'ACES2065-1' );
		expect( options.every( o => ! /Display|Encoded/.test( o.value ) ) ).toBe( true );

	} );

	it( 'files its PQ and HLG displays under HDR and the rest under SDR', () => {

		const { sdr, hdr } = displaySections( config, displayCanvasFit, { p3: false } );
		expect( sdr.map( d => d.label ) ).toContain( 'sRGB' );
		expect( hdr.length ).toBeGreaterThan( 0 );
		expect( hdr.map( d => d.label ) ).toEqual( expect.arrayContaining( [ 'Rec.2100-PQ', 'ST2084-P3-D65', 'Display P3 HDR' ] ) );
		for ( const d of sdr ) expect( d.value ).not.toMatch( /PQ|HLG|2084|HDR/i );

	} );

	it( 'files the gamut compression look as technical, not creative', () => {

		const views = config.views[ 'sRGB - Display' ].map( v => v.name );
		const { creative, technical } = looksForView( config.looks, 'ACES 2.0 - SDR 100 nits (Rec.709)', views );
		expect( creative ).toEqual( [] );
		expect( technical.map( l => l.label ) ).toEqual( [ 'Reference Gamut Compression' ] );

	} );

} );

const blenderSuite = available && existsSync( BLENDER ) ? describe : describe.skip;

blenderSuite( "Blender's config", () => {

	let config, native;

	beforeAll( async () => {

		resetOcio();
		const walk = d => readdirSync( d ).flatMap( n => {

			const p = join( d, n );
			return statSync( p ).isDirectory() ? walk( p ) : [ p ];

		} );
		const files = walk( BLENDER ).map( p => ( { relativePath: relative( BLENDER, p ), data: readFileSync( p ) } ) );
		config = await loadConfig( { files, configPath: 'config.ocio', id: 'colormanagement' } );
		native = findNativeLinearSpace( getConfigInfo() );

	}, 120000 );

	it( 'shows looks the way Blender does: a view with its own gets only those, prefix dropped', () => {

		const views = config.views.sRGB.map( v => v.name );

		const agx = looksForView( config.looks, 'AgX', views );
		expect( agx.creative.map( l => l.label ) ).toContain( 'Punchy' );
		expect( agx.creative.some( l => l.label === 'Medium Contrast' ) ).toBe( false );

		const standard = looksForView( config.looks, 'Standard', views );
		expect( standard.creative.map( l => l.label ) ).toContain( 'Medium Contrast' );
		expect( standard.creative.some( l => l.label.includes( 'Punchy' ) ) ).toBe( false );

		const aces = looksForView( config.looks, 'ACES 2.0', views );
		expect( aces.creative ).toEqual( [] );
		expect( aces.technical.map( l => l.label ) ).toEqual( [ 'Reference Gamut Compression' ] );
		expect( aces.technical[ 0 ].hint ).toBe( 'tames over-saturated camera colours' );

		const hintOf = label => agx.creative.find( l => l.label === label )?.hint;
		expect( hintOf( 'Punchy' ) ).toBe( 'richer colour, darker overall' );
		expect( hintOf( 'Greyscale' ) ).toBe( 'black and white' );
		expect( hintOf( 'Base Contrast' ) ).toBe( "the tone mapping's own contrast" );
		expect( hintOf( 'High Contrast' ) ).toBeNull();

	} );

	it( 'splits its displays into SDR and HDR exactly as Blender\'s Display menu does', () => {

		const { sdr, hdr } = displaySections( config, displayCanvasFit, { p3: false } );
		expect( sdr.map( d => d.label ) ).toEqual( [ 'sRGB', 'Display P3', 'Rec.1886', 'Rec.2020' ] );
		expect( hdr.map( d => d.label ) ).toEqual( [ 'Rec.2100-PQ', 'Rec.2100-HLG' ] );

	} );

	it( 'says what each render and EXR space is for', () => {

		const renderIn = Object.fromEntries( workingSpaceOptions( config, native ).map( o => [ o.label, o.hint ] ) );
		expect( renderIn[ 'Rec.709' ] ).toBe( 'standard; scenes look as they always have' );
		expect( renderIn.ACEScg ).toBe( 'wide gamut for ACES pipelines' );
		expect( renderIn[ 'Rec.2020' ] ).toBe( 'wide gamut for HDR and TV work' );
		expect( renderIn[ 'DCI-P3 D65' ] ).toBe( 'wide gamut, as on Apple and cinema screens' );

		const exr = Object.fromEntries( exportSpaceOptions( config ).map( o => [ o.value, o.hint ] ) );
		expect( exr[ 'ACES2065-1' ] ).toBe( 'archive and hand-off to other studios' );
		expect( exr.ACEScg ).toBe( 'compositing in an ACES pipeline' );
		expect( exr[ 'Linear Rec.709' ] ).toBe( 'most compositing apps' );
		expect( exr[ 'Linear Rec.2020' ] ).toBe( 'wide-gamut compositing' );
		expect( exr[ 'Linear FilmLight E-Gamut' ] ).toBe( 'grading in Baselight' );

	} );

	it( 'offers the working spaces Blender offers, from families alone', () => {

		const labels = workingSpaceOptions( config, native ).map( o => o.label );
		expect( labels[ 0 ] ).toBe( 'Rec.709' );
		expect( labels ).toEqual( expect.arrayContaining( [ 'Rec.709', 'Rec.2020', 'ACEScg' ] ) );
		expect( labels ).not.toContain( 'ACES2065-1' );

	} );

} );
