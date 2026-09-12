import { describe, it, expect } from 'vitest';
import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping, CineonToneMapping,
	ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping, CustomToneMapping
} from 'three';
import { TONE_MAP_FNS } from '../../../rayzee/src/Processor/ToneMapCPU.js';
import { TONE_MAP_WGSL, toneMapMode } from '../../../rayzee/src/Processor/ToneMapWGSL.js';

// The OIDN output pack runs TONE_MAP_WGSL; renderToBuffer and AIUpscaler run TONE_MAP_FNS. They
// paint the same image, so a curve added to one and not the other is a silent colour shift.
describe( 'ToneMapWGSL / ToneMapCPU parity', () => {

	it( 'accepts exactly the tone-mapping modes the CPU table implements', () => {

		for ( const mode of TONE_MAP_FNS.keys() ) expect( toneMapMode( mode ) ).toBe( mode );

	} );

	it( 'falls back to ACES for anything the CPU table also falls back on', () => {

		expect( TONE_MAP_FNS.has( CustomToneMapping ) ).toBe( false );
		expect( toneMapMode( CustomToneMapping ) ).toBe( ACESFilmicToneMapping );
		expect( toneMapMode( 999 ) ).toBe( ACESFilmicToneMapping );

	} );

	it( 'switches on every supported mode in the shader', () => {

		const arms = TONE_MAP_WGSL.slice( TONE_MAP_WGSL.indexOf( 'fn tmCurve' ) );
		const covered = [
			NoToneMapping, LinearToneMapping, ReinhardToneMapping,
			CineonToneMapping, AgXToneMapping, NeutralToneMapping
		];
		for ( const mode of covered ) expect( arms ).toMatch( new RegExp( `case[^:]*\\b${mode}u\\b` ) );
		// ACES is the default arm, so it has no case label.
		expect( arms ).toMatch( /default:\s*\{\s*return tmAces/ );

	} );

	it( 'clamps negatives before the curve, as the CPU clampNegative wrapper does', () => {

		expect( TONE_MAP_WGSL ).toMatch( /let c = max\( cIn, vec3f\( 0\.0 \) \);/ );

	} );

	it( 'applies exposure, saturation, curve and sRGB in that order', () => {

		const body = TONE_MAP_WGSL.slice( TONE_MAP_WGSL.indexOf( 'fn toneMapPixel' ) );
		const order = [ 'linear * gain', 'tmSaturation', 'tmCurve', 'tmSrgb' ]
			.map( token => body.indexOf( token ) );
		expect( order.every( i => i >= 0 ) ).toBe( true );
		expect( order ).toEqual( [ ...order ].sort( ( a, b ) => a - b ) );

	} );

} );
