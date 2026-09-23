/**
 * The seven view transforms three.js ships, as registry entries.
 *
 * Moved here verbatim from `ToneMapCPU.js` and `ToneMapGPU.js` so that one list feeds the CPU
 * readback, the WGSL readback, the live canvas and the host's menu. The maths is unchanged —
 * `tests/unit/color/builtinViews.test.js` hashes the output against the values these produced
 * before the move.
 *
 * All seven are scene-referred in, **linear** out: the renderer's output pass and the readback
 * both apply the sRGB transfer afterwards. An OCIO view is the other kind — see `outputEncoded`
 * in `ViewTransforms.js`.
 */

import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
} from 'three';

const clamp01 = x => Math.min( Math.max( x, 0 ), 1 );

// Distinct from linearToneMap on purpose: three.js returns early for NoToneMapping without
// applying exposure, so this one must ignore it.
function noToneMap( r, g, b, _exposure, out ) {

	out[ 0 ] = clamp01( r );
	out[ 1 ] = clamp01( g );
	out[ 2 ] = clamp01( b );

}

function linearToneMap( r, g, b, exposure, out ) {

	out[ 0 ] = clamp01( r * exposure );
	out[ 1 ] = clamp01( g * exposure );
	out[ 2 ] = clamp01( b * exposure );

}

function reinhardToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;
	out[ 0 ] = clamp01( r / ( r + 1 ) );
	out[ 1 ] = clamp01( g / ( g + 1 ) );
	out[ 2 ] = clamp01( b / ( b + 1 ) );

}

function cineonToneMap( r, g, b, exposure, out ) {

	r = Math.max( r * exposure - 0.004, 0 );
	g = Math.max( g * exposure - 0.004, 0 );
	b = Math.max( b * exposure - 0.004, 0 );
	const f = c => Math.pow( ( c * ( 6.2 * c + 0.5 ) ) / ( c * ( 6.2 * c + 1.7 ) + 0.06 ), 2.2 );
	out[ 0 ] = f( r );
	out[ 1 ] = f( g );
	out[ 2 ] = f( b );

}

function acesFilmicToneMap( r, g, b, exposure, out ) {

	r = r * exposure / 0.6;
	g = g * exposure / 0.6;
	b = b * exposure / 0.6;

	let ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
	let ig = 0.07600 * r + 0.90834 * g + 0.01566 * b;
	let ib = 0.02840 * r + 0.13383 * g + 0.83777 * b;

	const f = v => {

		const a = v * ( v + 0.0245786 ) - 0.000090537;
		const d = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
		return a / d;

	};

	ir = f( ir ); ig = f( ig ); ib = f( ib );

	out[ 0 ] = clamp01( 1.60475 * ir - 0.53108 * ig - 0.07367 * ib );
	out[ 1 ] = clamp01( - 0.10208 * ir + 1.10813 * ig - 0.00605 * ib );
	out[ 2 ] = clamp01( - 0.00327 * ir - 0.07276 * ig + 1.07602 * ib );

}

function agxToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;

	let cr = 0.6274 * r + 0.3293 * g + 0.0433 * b;
	let cg = 0.0691 * r + 0.9195 * g + 0.0113 * b;
	let cb = 0.0164 * r + 0.0880 * g + 0.8956 * b;

	let ar = 0.856627153315983 * cr + 0.0951212405381588 * cg + 0.0482516061458583 * cb;
	let ag = 0.137318972929847 * cr + 0.761241990602591 * cg + 0.101439036467562 * cb;
	let ab = 0.11189821299995 * cr + 0.0767994186031903 * cg + 0.811302368396859 * cb;

	const AgxMinEv = - 12.47393, AgxMaxEv = 4.026069, range = AgxMaxEv - AgxMinEv;
	ar = clamp01( ( Math.log2( Math.max( ar, 1e-10 ) ) - AgxMinEv ) / range );
	ag = clamp01( ( Math.log2( Math.max( ag, 1e-10 ) ) - AgxMinEv ) / range );
	ab = clamp01( ( Math.log2( Math.max( ab, 1e-10 ) ) - AgxMinEv ) / range );

	const approx = x => {

		const x2 = x * x, x4 = x2 * x2;
		return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;

	};

	ar = approx( ar ); ag = approx( ag ); ab = approx( ab );

	let or = 1.1271005818144368 * ar - 0.11060664309660323 * ag - 0.016493938717834573 * ab;
	let og = - 0.1413297634984383 * ar + 1.157823702216272 * ag - 0.016493938717834257 * ab;
	let ob = - 0.14132976349843826 * ar - 0.11060664309660294 * ag + 1.2519364065950405 * ab;

	or = Math.pow( Math.max( 0, or ), 2.2 );
	og = Math.pow( Math.max( 0, og ), 2.2 );
	ob = Math.pow( Math.max( 0, ob ), 2.2 );

	out[ 0 ] = clamp01( 1.6605 * or - 0.5876 * og - 0.0728 * ob );
	out[ 1 ] = clamp01( - 0.1246 * or + 1.1329 * og - 0.0083 * ob );
	out[ 2 ] = clamp01( - 0.0182 * or - 0.1006 * og + 1.1187 * ob );

}

function neutralToneMap( r, g, b, exposure, out ) {

	const StartCompression = 0.8 - 0.04;
	const Desaturation = 0.15;

	r *= exposure; g *= exposure; b *= exposure;

	const x = Math.min( r, Math.min( g, b ) );
	const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;

	r -= offset; g -= offset; b -= offset;

	const peak = Math.max( r, Math.max( g, b ) );

	if ( peak < StartCompression ) {

		out[ 0 ] = r; out[ 1 ] = g; out[ 2 ] = b;
		return;

	}

	const d = 1 - StartCompression;
	const newPeak = 1 - d * d / ( peak + d - StartCompression );
	const scale = newPeak / peak;
	r *= scale; g *= scale; b *= scale;
	const gFactor = 1 - 1 / ( Desaturation * ( peak - newPeak ) + 1 );

	out[ 0 ] = r + ( newPeak - r ) * gFactor;
	out[ 1 ] = g + ( newPeak - g ) * gFactor;
	out[ 2 ] = b + ( newPeak - b ) * gFactor;

}

const REINHARD_WGSL = /* wgsl */ `
fn tm_reinhard( c: vec3<f32> ) -> vec3<f32> {
	return clamp( c / ( c + vec3<f32>( 1.0 ) ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}
`;

const CINEON_WGSL = /* wgsl */ `
fn tm_cineon( c0: vec3<f32> ) -> vec3<f32> {
	let c = max( c0 - vec3<f32>( 0.004 ), vec3<f32>( 0.0 ) );
	let v = ( c * ( 6.2 * c + vec3<f32>( 0.5 ) ) ) / ( c * ( 6.2 * c + vec3<f32>( 1.7 ) ) + vec3<f32>( 0.06 ) );
	return pow( max( v, vec3<f32>( 0.0 ) ), vec3<f32>( 2.2 ) );
}
`;

const ACES_WGSL = /* wgsl */ `
fn tm_aces( c0: vec3<f32> ) -> vec3<f32> {
	let c = c0 / 0.6;
	let m_in = mat3x3<f32>(
		vec3<f32>( 0.59719, 0.07600, 0.02840 ),
		vec3<f32>( 0.35458, 0.90834, 0.13383 ),
		vec3<f32>( 0.04823, 0.01566, 0.83777 ) );
	let v = m_in * c;
	let a = v * ( v + vec3<f32>( 0.0245786 ) ) - vec3<f32>( 0.000090537 );
	let b = v * ( 0.983729 * v + vec3<f32>( 0.4329510 ) ) + vec3<f32>( 0.238081 );
	let m_out = mat3x3<f32>(
		vec3<f32>( 1.60475, -0.10208, -0.00327 ),
		vec3<f32>( -0.53108, 1.10813, -0.07276 ),
		vec3<f32>( -0.07367, -0.00605, 1.07602 ) );
	return clamp( m_out * ( a / b ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}
`;

const AGX_WGSL = /* wgsl */ `
fn tm_agx( c0: vec3<f32> ) -> vec3<f32> {
	let m_in = mat3x3<f32>(
		vec3<f32>( 0.6274, 0.0691, 0.0164 ),
		vec3<f32>( 0.3293, 0.9195, 0.0880 ),
		vec3<f32>( 0.0433, 0.0113, 0.8956 ) );
	let m_agx = mat3x3<f32>(
		vec3<f32>( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3<f32>( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3<f32>( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );

	var v = m_agx * ( m_in * c0 );

	let minEv = -12.47393;
	let maxEv = 4.026069;
	v = clamp( ( log2( max( v, vec3<f32>( 1e-10 ) ) ) - vec3<f32>( minEv ) ) / ( maxEv - minEv ),
		vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );

	let x2 = v * v;
	let x4 = x2 * x2;
	v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v
		- vec3<f32>( 0.00232 );

	let m_out = mat3x3<f32>(
		vec3<f32>( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
		vec3<f32>( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
		vec3<f32>( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );
	let o = pow( max( m_out * v, vec3<f32>( 0.0 ) ), vec3<f32>( 2.2 ) );

	let m_srgb = mat3x3<f32>(
		vec3<f32>( 1.6605, -0.1246, -0.0182 ),
		vec3<f32>( -0.5876, 1.1329, -0.1006 ),
		vec3<f32>( -0.0728, -0.0083, 1.1187 ) );
	return clamp( m_srgb * o, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}
`;

const NEUTRAL_WGSL = /* wgsl */ `
fn tm_neutral( c0: vec3<f32> ) -> vec3<f32> {
	let startCompression = 0.8 - 0.04;
	let desaturation = 0.15;

	let x = min( c0.r, min( c0.g, c0.b ) );
	var offset = 0.04;
	if ( x < 0.08 ) { offset = x - 6.25 * x * x; }
	var c = c0 - vec3<f32>( offset );

	let peak = max( c.r, max( c.g, c.b ) );
	if ( peak < startCompression ) { return c; }

	let d = 1.0 - startCompression;
	let newPeak = 1.0 - d * d / ( peak + d - startCompression );
	c = c * ( newPeak / peak );
	let gFactor = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
	return mix( c, vec3<f32>( newPeak ), gFactor );
}
`;

/** The seven, in the order a host menu should show them. */
export const BUILTIN_VIEWS = [
	// `appliesExposure: false` is three.js's own behaviour, not an oversight: ToneMappingNode
	// returns early for NoToneMapping without applying `toneMappingExposure`, so a readback that
	// applied it would paint brighter than the viewport it replaces.
	{ id: NoToneMapping, name: 'None', wgslConst: 'TM_NONE', cpu: noToneMap, wgsl: null, call: null, appliesExposure: false },
	{ id: LinearToneMapping, name: 'Linear', wgslConst: 'TM_LINEAR', cpu: linearToneMap, wgsl: null, call: null },
	{ id: ReinhardToneMapping, name: 'Reinhard', wgslConst: 'TM_REINHARD', cpu: reinhardToneMap, wgsl: REINHARD_WGSL, call: 'tm_reinhard( c )' },
	{ id: CineonToneMapping, name: 'Cineon', wgslConst: 'TM_CINEON', cpu: cineonToneMap, wgsl: CINEON_WGSL, call: 'tm_cineon( c )' },
	{ id: ACESFilmicToneMapping, name: 'ACES Filmic', wgslConst: 'TM_ACES', cpu: acesFilmicToneMap, wgsl: ACES_WGSL, call: 'tm_aces( c )' },
	{ id: AgXToneMapping, name: 'AgX', wgslConst: 'TM_AGX', cpu: agxToneMap, wgsl: AGX_WGSL, call: 'tm_agx( c )' },
	{ id: NeutralToneMapping, name: 'Neutral', wgslConst: 'TM_NEUTRAL', cpu: neutralToneMap, wgsl: NEUTRAL_WGSL, call: 'tm_neutral( c )' },
].map( v => ( { source: 'builtin', outputEncoded: false, appliesExposure: true, ...v } ) );
