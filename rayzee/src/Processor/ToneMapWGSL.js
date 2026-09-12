/**
 * WGSL tone mapping, a transcription of ToneMapCPU.js.
 *
 * The two must stay identical: the same image is produced on the CPU by `toneMapToRGBA8`
 * (renderToBuffer, upscaler) and on the GPU by this (the OIDN output pack). Order is part of
 * the contract — exposure, saturation, clamp-negative, curve, sRGB OETF — and moving any step
 * shifts every mid-tone.
 */
import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
} from 'three';

const SUPPORTED = new Set( [
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
] );

/**
 * Three.js ToneMapping constant → shader mode. Anything unsupported falls back to ACES,
 * matching `TONE_MAP_FNS.get( x ) || TONE_MAP_FNS.get( ACESFilmicToneMapping )`.
 * @param {number} toneMapping
 * @returns {number}
 */
export function toneMapMode( toneMapping ) {

	return SUPPORTED.has( toneMapping ) ? toneMapping : ACESFilmicToneMapping;

}

/**
 * Prelude defining `toneMapPixel( linear, gain, saturation, mode ) -> vec3f` (sRGB, [0,1]).
 * Concatenate ahead of a kernel that wants it.
 */
export const TONE_MAP_WGSL = /* wgsl */`
fn tmSaturation( c: vec3f, saturation: f32 ) -> vec3f {
	if ( saturation == 1.0 ) { return c; }
	let luma = dot( c, vec3f( 0.2126, 0.7152, 0.0722 ) );
	return vec3f( luma ) + ( c - vec3f( luma ) ) * saturation;
}

fn tmSrgb1( c: f32 ) -> f32 {
	if ( c <= 0.0031308 ) { return 12.92 * c; }
	return 1.055 * pow( c, 1.0 / 2.4 ) - 0.055;
}

fn tmSrgb( c: vec3f ) -> vec3f {
	return vec3f( tmSrgb1( c.r ), tmSrgb1( c.g ), tmSrgb1( c.b ) );
}

fn tmReinhard( c: vec3f ) -> vec3f {
	return clamp( c / ( c + vec3f( 1.0 ) ), vec3f( 0.0 ), vec3f( 1.0 ) );
}

fn tmCineon1( x: f32 ) -> f32 {
	let c = max( x - 0.004, 0.0 );
	return pow( ( c * ( 6.2 * c + 0.5 ) ) / ( c * ( 6.2 * c + 1.7 ) + 0.06 ), 2.2 );
}

fn tmCineon( c: vec3f ) -> vec3f {
	return vec3f( tmCineon1( c.r ), tmCineon1( c.g ), tmCineon1( c.b ) );
}

fn tmAcesFit( c: f32 ) -> f32 {
	return ( c * ( c + 0.0245786 ) - 0.000090537 ) / ( c * ( 0.983729 * c + 0.4329510 ) + 0.238081 );
}

fn tmAces( cIn: vec3f ) -> vec3f {
	let c = cIn / 0.6;
	var i = vec3f(
		0.59719 * c.r + 0.35458 * c.g + 0.04823 * c.b,
		0.07600 * c.r + 0.90834 * c.g + 0.01566 * c.b,
		0.02840 * c.r + 0.13383 * c.g + 0.83777 * c.b
	);
	i = vec3f( tmAcesFit( i.r ), tmAcesFit( i.g ), tmAcesFit( i.b ) );
	let o = vec3f(
		 1.60475 * i.r - 0.53108 * i.g - 0.07367 * i.b,
		-0.10208 * i.r + 1.10813 * i.g - 0.00605 * i.b,
		-0.00327 * i.r - 0.07276 * i.g + 1.07602 * i.b
	);
	return clamp( o, vec3f( 0.0 ), vec3f( 1.0 ) );
}

fn tmAgxApprox( x: f32 ) -> f32 {
	let x2 = x * x;
	let x4 = x2 * x2;
	return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn tmAgx( r: vec3f ) -> vec3f {
	let c = vec3f(
		0.6274 * r.r + 0.3293 * r.g + 0.0433 * r.b,
		0.0691 * r.r + 0.9195 * r.g + 0.0113 * r.b,
		0.0164 * r.r + 0.0880 * r.g + 0.8956 * r.b
	);
	var a = vec3f(
		0.856627153315983 * c.r + 0.0951212405381588 * c.g + 0.0482516061458583 * c.b,
		0.137318972929847 * c.r + 0.761241990602591  * c.g + 0.101439036467562  * c.b,
		0.11189821299995  * c.r + 0.0767994186031903 * c.g + 0.811302368396859  * c.b
	);

	let agxMinEv = -12.47393;
	let agxMaxEv = 4.026069;
	let range = agxMaxEv - agxMinEv;
	a = clamp( ( log2( max( a, vec3f( 1e-10 ) ) ) - vec3f( agxMinEv ) ) / range, vec3f( 0.0 ), vec3f( 1.0 ) );
	a = vec3f( tmAgxApprox( a.r ), tmAgxApprox( a.g ), tmAgxApprox( a.b ) );

	var o = vec3f(
		 1.1271005818144368  * a.r - 0.11060664309660323 * a.g - 0.016493938717834573 * a.b,
		-0.1413297634984383  * a.r + 1.157823702216272   * a.g - 0.016493938717834257 * a.b,
		-0.14132976349843826 * a.r - 0.11060664309660294 * a.g + 1.2519364065950405   * a.b
	);
	o = pow( max( o, vec3f( 0.0 ) ), vec3f( 2.2 ) );

	return clamp( vec3f(
		 1.6605 * o.r - 0.5876 * o.g - 0.0728 * o.b,
		-0.1246 * o.r + 1.1329 * o.g - 0.0083 * o.b,
		-0.0182 * o.r - 0.1006 * o.g + 1.1187 * o.b
	), vec3f( 0.0 ), vec3f( 1.0 ) );
}

fn tmNeutral( cIn: vec3f ) -> vec3f {
	let startCompression = 0.8 - 0.04;
	let desaturation = 0.15;

	let x = min( cIn.r, min( cIn.g, cIn.b ) );
	var offset = 0.04;
	if ( x < 0.08 ) { offset = x - 6.25 * x * x; }

	var c = cIn - vec3f( offset );
	let peak = max( c.r, max( c.g, c.b ) );
	if ( peak < startCompression ) { return c; }

	let d = 1.0 - startCompression;
	let newPeak = 1.0 - d * d / ( peak + d - startCompression );
	c = c * ( newPeak / peak );
	let gFactor = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );

	return c + ( vec3f( newPeak ) - c ) * gFactor;
}

fn tmCurve( cIn: vec3f, mode: u32 ) -> vec3f {
	// Three.js clamps the fragment output before tone mapping ("force unsigned floats"), and
	// AgX/Neutral mix negatives across channels rather than clipping them.
	let c = max( cIn, vec3f( 0.0 ) );
	switch mode {
		case 0u, 1u: { return clamp( c, vec3f( 0.0 ), vec3f( 1.0 ) ); }
		case 2u: { return tmReinhard( c ); }
		case 3u: { return tmCineon( c ); }
		case 6u: { return tmAgx( c ); }
		case 7u: { return tmNeutral( c ); }
		default: { return tmAces( c ); }
	}
}

fn toneMapPixel( linear: vec3f, gain: f32, saturation: f32, mode: u32 ) -> vec3f {
	var c = linear * gain;
	c = tmSaturation( c, saturation );
	c = tmCurve( c, mode );
	return tmSrgb( c );
}
`;
