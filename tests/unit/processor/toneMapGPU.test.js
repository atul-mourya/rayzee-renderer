import { describe, it, expect } from 'vitest';
import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
} from 'three';
import { TONE_MAP_WGSL, PackedToneMapper } from '@/core/Processor/ToneMapGPU.js';

// The GPU curve itself needs a device, so it is checked on real hardware by `bench:upscale`
// (`toneMapParity`). What can be checked here is that the shader still names every curve the CPU
// registry knows about, and that the mode constants are the Three.js ones — a mismatch there would
// silently select the wrong curve rather than fail.

describe( 'TONE_MAP_WGSL', () => {

	it( 'declares a mode constant per Three.js tone mapping value', () => {

		const expected = {
			TM_NONE: NoToneMapping,
			TM_LINEAR: LinearToneMapping,
			TM_REINHARD: ReinhardToneMapping,
			TM_CINEON: CineonToneMapping,
			TM_ACES: ACESFilmicToneMapping,
			TM_AGX: AgXToneMapping,
			TM_NEUTRAL: NeutralToneMapping,
		};

		for ( const [ name, value ] of Object.entries( expected ) ) {

			expect( TONE_MAP_WGSL ).toContain( `const ${name}: u32 = ${value}u;` );

		}

	} );

	it( 'implements every non-trivial curve', () => {

		for ( const fn of [ 'tm_reinhard', 'tm_cineon', 'tm_aces', 'tm_agx', 'tm_neutral' ] ) {

			expect( TONE_MAP_WGSL ).toContain( `fn ${fn}(` );
			expect( TONE_MAP_WGSL ).toContain( `${fn}( c )` );

		}

	} );

	it( 'exposes the entry points the passes call', () => {

		expect( TONE_MAP_WGSL ).toContain( 'fn rayzee_tone_map(' );
		expect( TONE_MAP_WGSL ).toContain( 'fn rayzee_linear_to_srgb(' );
		expect( TONE_MAP_WGSL ).toContain( 'fn rayzee_to_u8(' );

	} );

	it( 'keeps the half-level rounding the CPU readback has always had', () => {

		// `toneMapToRGBA8` writes `srgb * 255 + 0.5` into a Uint8ClampedArray, which rounds again.
		// Dropping the extra half here would shift every neural-pass image against the OIDN and
		// Real-ESRGAN readbacks, which still go through the CPU function.
		expect( TONE_MAP_WGSL ).toContain( 'round( srgb * 255.0 + vec3<f32>( 0.5 ) )' );

	} );

} );

describe( 'PackedToneMapper', () => {

	it( 'refuses to run before a size is set', async () => {

		const mapper = new PackedToneMapper( {} );
		await expect( mapper.toRGBA8( {} ) ).rejects.toThrow( /ensureSize/ );

	} );

	it( 'refuses to run once disposed', async () => {

		const mapper = new PackedToneMapper( {} );
		mapper.dispose();
		await expect( mapper.toRGBA8( {} ) ).rejects.toThrow( /disposed/ );

	} );

	it( 'is idempotent on dispose', () => {

		const mapper = new PackedToneMapper( {} );
		mapper.dispose();
		expect( () => mapper.dispose() ).not.toThrow();

	} );

} );
