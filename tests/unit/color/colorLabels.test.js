/**
 * What the artist sees, from real configs: the built-in ACES CG config and, when installed,
 * Blender's own. Made-up fixtures would only test the rules against my idea of a config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	builtinConfigOptions, configLabel, displayLabel, viewLabels, looksForView,
	workingSpaceOptions, textureSpaceGroups, exportSpaceOptions, displayGroups, spaceLabel,
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

	it( 'puts displays this screen cannot show apart from the ones it can', () => {

		const displays = [ 'sRGB - Display', 'Display P3 - Display', 'Rec.2100-PQ - Display', 'P3-D65 - Display' ];
		const sdr = displayGroups( displays, displayCanvasFit, { p3: false } );
		expect( sdr.here.map( d => d.label ) ).toEqual( [ 'sRGB' ] );

		const p3 = displayGroups( displays, displayCanvasFit, { p3: true } );
		expect( p3.here.map( d => d.label ) ).toEqual( [ 'sRGB', 'Display P3' ] );
		expect( p3.elsewhere.map( d => d.label ) ).toEqual( [ 'Rec.2100-PQ', 'P3-D65' ] );

	} );

} );

suite( 'the ACES CG config', () => {

	let config, native;

	beforeAll( async () => {

		resetOcio();
		config = await loadConfig( { builtin: 'cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } );
		native = findNativeLinearSpace( getConfigInfo() );

	}, 120000 );

	it( 'offers one preset per ACES version, newest CG config of each, and keeps the rest aside', async () => {

		const { presets, others } = builtinConfigOptions( await listBuiltinConfigs() );
		expect( presets.map( p => p.label ) ).toEqual( [ 'ACES 2.0', 'ACES 1.3' ] );
		expect( presets[ 0 ].value ).toBe( 'cg-config-v4.0.0_aces-v2.0_ocio-v2.5' );
		expect( others.length ).toBe( 6 );
		expect( others.every( o => o.label.startsWith( 'ACES ' ) ) ).toBe( true );
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

	} );

	it( 'offers the working spaces Blender offers, from families alone', () => {

		const labels = workingSpaceOptions( config, native ).map( o => o.label );
		expect( labels[ 0 ] ).toBe( 'Rec.709' );
		expect( labels ).toEqual( expect.arrayContaining( [ 'Rec.709', 'Rec.2020', 'ACEScg' ] ) );
		expect( labels ).not.toContain( 'ACES2065-1' );

	} );

} );
