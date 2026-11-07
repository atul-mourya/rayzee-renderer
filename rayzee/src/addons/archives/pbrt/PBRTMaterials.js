/**
 * Translate pbrt-v4 materials and textures to THREE.MeshPhysicalMaterial.
 *
 * pbrt's BxDF model (diffuse / conductor / dielectric / coateddiffuse / ...) is
 * mapped onto the Disney-style parameters the engine reads off a
 * MeshPhysicalMaterial (see GeometryExtractor.createMaterialObject). The mapping
 * is intentionally lossy — spectral data, measured BRDFs, and layered BxDFs are
 * approximated to RGB. Anything unrecognized falls back to a neutral diffuse.
 */

import { MeshPhysicalMaterial, Color, DoubleSide } from 'three';
import { namedScattering } from './PBRTScattering.js';
import { dipoleReflectance, albedoForReflectance } from '../../../materials/Scattering.js';
import { approximated, param } from './PBRTParser.js';
import { uvKey } from './PBRTTextureBake.js';

// pbrt's named metals at normal incidence, ( (η−1)² + k² ) / ( (η+1)² + k² ) of their `metal-X-eta` and `metal-X-k`
// tables (pbrt-v4 src/pbrt/util/spectrum.cpp) through CIE 1931 under D65, as linear Rec.709. Gold leaves the gamut
// (red 1.022) and is scaled to 1, as Real-Time Rendering's table has it; Ag, Al, Cu and brass match that table.
const AU = [ 1, 0.7657, 0.3360 ], CU = [ 0.9553, 0.6376, 0.5382 ], AG = [ 0.9715, 0.9599, 0.9153 ], AL = [ 0.9132, 0.9215, 0.9245 ];
const METAL_ALBEDO = {
	au: AU, gold: AU, cu: CU, copper: CU, ag: AG, silver: AG, al: AL, aluminium: AL, aluminum: AL,
	cuzn: [ 0.9096, 0.7783, 0.4228 ], mgo: [ 0.0720, 0.0731, 0.0749 ], tio2: [ 0.2322, 0.2446, 0.2727 ]
};

const DEFAULT_METAL = [ 0.92, 0.92, 0.92 ];

// pbrt's named glasses, ( λ nm, eta ) pairs: pbrt-v4 src/pbrt/util/spectrum.cpp (from refractiveindex.info, CC0).
const GLASS_ETA = {
	'glass-BK7': [
		300, 1.5527702635739, 322, 1.5458699289209, 344, 1.5404466868331, 366, 1.536090527917, 388, 1.53252773217,
		410, 1.529568767224, 432, 1.5270784291406, 454, 1.5249578457324, 476, 1.5231331738499, 498, 1.5215482528369,
		520, 1.5201596882463, 542, 1.5189334783109, 564, 1.5178426478869, 586, 1.516865556749, 608, 1.5159846691816,
		630, 1.5151856452759, 652, 1.5144566604975, 674, 1.513787889767, 696, 1.5131711117948, 718, 1.5125994024544,
		740, 1.5120668948646, 762, 1.5115685899969, 784, 1.5111002059336, 806, 1.5106580569705, 828, 1.5102389559626,
		850, 1.5098401349174, 872, 1.5094591800239, 894, 1.5090939781792, 916, 1.5087426727363
	],
	'glass-BAF10': [
		350, 1.7126880848268, 371, 1.7044510025682, 393, 1.6978539633931, 414, 1.6924597573902, 436, 1.6879747521657,
		457, 1.6841935148947, 479, 1.6809676313681, 500, 1.6781870617363, 522, 1.6757684467878, 543, 1.6736474831891,
		565, 1.6717737892968, 586, 1.6701073530462, 608, 1.6686160168249, 629, 1.6672736605352, 651, 1.6660588657981,
		672, 1.6649539185393, 694, 1.6639440538738, 715, 1.6630168772865, 737, 1.6621619159417, 758, 1.6613702672977,
		780, 1.6606343213443, 801, 1.6599475391478, 823, 1.6593042748862, 844, 1.6586996317841, 866, 1.6581293446924,
		887, 1.6575896837763, 909, 1.6570773750475
	],
	'glass-FK51A': [
		290, 1.5145777204082, 312, 1.5092112868865, 334, 1.5049961987453, 356, 1.5016153970446, 378, 1.4988558885761,
		400, 1.496569610433, 422, 1.4946506898002, 444, 1.4930216011953, 466, 1.4916244098644, 488, 1.49041505042,
		511, 1.4893594837084, 533, 1.4884310526027, 555, 1.4876086240083, 577, 1.486875258765, 599, 1.486217243501,
		621, 1.4856233753353, 643, 1.4850844262039, 665, 1.4845927367446, 687, 1.484141904927, 709, 1.483726544853,
		732, 1.4833420981287, 754, 1.4829846850495, 776, 1.482650986233, 798, 1.4823381477539, 820, 1.4820437045732,
		842, 1.4817655183243, 864, 1.481501726448, 886, 1.4812507003621, 908, 1.4810110108734
	],
	'glass-LASF9': [
		370, 1.9199725545705, 391, 1.9057858245373, 412, 1.8945401582481, 433, 1.8854121949451, 455, 1.877863643024,
		476, 1.8715257028176, 497, 1.8661362648008, 519, 1.8615034773283, 540, 1.8574834752011, 561, 1.8539661699122,
		583, 1.8508658556, 604, 1.8481148099285, 625, 1.8456588222442, 646, 1.8434539988324, 668, 1.8414644361915,
		689, 1.8396604975285, 710, 1.8380175167434, 732, 1.8365148106821, 753, 1.8351349171703, 774, 1.8338630007484,
		796, 1.8326863845545, 817, 1.8315941782006, 838, 1.8305769794709, 859, 1.8296266333424, 881, 1.8287360359155,
		902, 1.8278989738228
	],
	'glass-F5': [
		370, 1.7286549847245, 391, 1.7170151864402, 412, 1.7079037179421, 433, 1.7005724270177, 455, 1.6945472844297,
		476, 1.6895110487297, 497, 1.685242265691, 519, 1.6815810964, 540, 1.678409006027, 561, 1.6756360973958,
		583, 1.6731928929908, 604, 1.6710248234743, 625, 1.6690884260039, 646, 1.6673486579281, 668, 1.6657769585173,
		689, 1.6643498246044, 710, 1.6630477468358, 732, 1.6618544037398, 753, 1.6607560432197, 774, 1.6597410023473,
		796, 1.6587993305922, 817, 1.6579224913632, 838, 1.6571031234995, 859, 1.6563348491305, 881, 1.6556121177295,
		902, 1.654930078671
	],
	'glass-F10': [
		380, 1.7905788948419, 401, 1.7776074571692, 422, 1.7673620572474, 443, 1.7590649148507, 464, 1.7522127524444,
		486, 1.7464635698826, 507, 1.741575877046, 528, 1.7373738218659, 549, 1.7337260730259, 570, 1.7305324562829,
		592, 1.7277151818026, 613, 1.7252129043714, 634, 1.7229765939984, 655, 1.7209665988467, 676, 1.719150514229,
		698, 1.7175016091415, 719, 1.7159976462946, 740, 1.7146199848831, 761, 1.7133528897994, 782, 1.7121829937648,
		804, 1.7110988742233, 825, 1.7100907173852, 846, 1.7091500491754, 867, 1.7082695180523, 888, 1.7074427184169,
		910, 1.7066640460471
	],
	'glass-F11': [
		370, 1.8700216173234, 391, 1.8516255860581, 412, 1.8374707714715, 433, 1.8262323798466, 455, 1.8170946940119,
		476, 1.8095242343848, 497, 1.803155581666, 519, 1.7977291183308, 540, 1.7930548640505, 561, 1.7889903663666,
		583, 1.7854266026774, 604, 1.7822786683156, 625, 1.7794794394722, 646, 1.7769751487395, 668, 1.7747222267051,
		689, 1.7726850031375, 710, 1.770834004936, 732, 1.7691446766161, 753, 1.7675964052635, 774, 1.7661717683505,
		796, 1.764855947008, 817, 1.7636362637211, 838, 1.7625018146862, 859, 1.7614431749629, 881, 1.7604521601554,
		902, 1.7595216323879
	]
};

/** Crude blackbody-temperature → linear RGB (Planckian locus approximation). */
function blackbodyToRGB( kelvin ) {

	const t = Math.max( 1000, Math.min( 40000, kelvin ) ) / 100;
	let r, g, b;

	if ( t <= 66 ) {

		r = 255;
		g = 99.47 * Math.log( t ) - 161.12;

	} else {

		r = 329.7 * Math.pow( t - 60, - 0.1332 );
		g = 288.12 * Math.pow( t - 60, - 0.0755 );

	}

	if ( t >= 66 ) b = 255;
	else if ( t <= 19 ) b = 0;
	else b = 138.52 * Math.log( t - 10 ) - 305.04;

	const clamp = v => Math.max( 0, Math.min( 255, v ) ) / 255;
	// sRGB → approx linear
	return [ clamp( r ) ** 2.2, clamp( g ) ** 2.2, clamp( b ) ** 2.2 ];

}

// ── param accessors ────────────────────────────────────────────────

export function pFloat( params, name, dflt ) {

	const p = param( params, name );
	if ( p && p.type !== 'float' && p.type !== 'integer' ) approximated( params, name );
	return p && typeof p.value[ 0 ] === 'number' ? p.value[ 0 ] : dflt;

}

// The Fraunhofer lines glTF's dispersion is defined on, nm.
const F_LINE = 486.134, D_LINE = 587.562, C_LINE = 656.281;

// A spectrum of ( λ value ) pairs at λ nm: linear between its samples, held at its ends.
function spectrumAt( v, lambda ) {

	const n = v.length - ( v.length % 2 );
	if ( lambda <= v[ 0 ] ) return v[ 1 ];
	for ( let i = 2; i < n; i += 2 ) {

		if ( lambda <= v[ i ] ) return v[ i - 1 ] + ( v[ i + 1 ] - v[ i - 1 ] ) * ( lambda - v[ i - 2 ] ) / ( v[ i ] - v[ i - 2 ] );

	}

	return v[ n - 1 ];

}

/**
 * An index of refraction as glTF gives glass one: a float, or a spectrum (λ value pairs, or a named glass) as its value at
 * the d line and `dispersion`, 20 / its Abbe number ( n_d − 1 ) / ( n_F − n_C ). A spectrum rising from F to C gets
 * none, and counts as approximated.
 * @returns {{ ior: number, dispersion: number }}
 */
function pEta( params, name, dflt ) {

	const p = param( params, name );
	const v = p?.type === 'spectrum' && ( GLASS_ETA[ p.value[ 0 ] ] ?? p.value );
	if ( typeof v?.[ 0 ] !== 'number' ) return { ior: pFloat( params, name, dflt ), dispersion: 0 };
	if ( v.length < 2 ) {

		approximated( params, name );
		return { ior: dflt, dispersion: 0 };

	}

	const ior = spectrumAt( v, D_LINE );
	const spread = spectrumAt( v, F_LINE ) - spectrumAt( v, C_LINE );
	if ( spread > 0 && ior > 1 ) return { ior, dispersion: 20 * spread / ( ior - 1 ) };
	if ( spread !== 0 ) approximated( params, name );
	return { ior, dispersion: 0 };

}

export function pString( params, name, dflt ) {

	const p = param( params, name );
	return p && typeof p.value[ 0 ] === 'string' ? p.value[ 0 ] : dflt;

}

export function pBool( params, name, dflt ) {

	const v = param( params, name )?.value?.[ 0 ];
	return v === undefined ? dflt : v === true || v === 'true';

}

/**
 * Resolve a spectrum/color/float-valued parameter to an RGB triple and/or a
 * texture. Returns `{ rgb, texture }` — exactly one is typically non-null.
 * @returns {Promise<{rgb:number[]|null, texture:import('three').Texture|null}>}
 */
export async function resolveSpectrum( params, name, ctx, dfltRGB = null ) {

	const p = param( params, name );
	if ( ! p ) return { rgb: dfltRGB, texture: null };

	// Reference to a named texture.
	if ( p.type === 'texture' ) {

		const texName = p.value[ 0 ];
		const tex = await ctx.resolveNamedTexture( texName );
		if ( tex && tex.texture ) return { rgb: tex.constant ?? null, texture: tex.texture };
		if ( tex && tex.constant ) return { rgb: tex.constant, texture: null };
		ctx.warn( `texture "${texName}" could not be resolved` );
		approximated( params, name );
		return { rgb: dfltRGB, texture: null };

	}

	if ( p.type === 'rgb' || p.type === 'color' ) {

		return { rgb: [ p.value[ 0 ], p.value[ 1 ], p.value[ 2 ] ], texture: null };

	}

	if ( p.type === 'float' ) {

		const v = p.value[ 0 ];
		return { rgb: [ v, v, v ], texture: null };

	}

	if ( p.type === 'blackbody' ) {

		approximated( params, name );
		return { rgb: blackbodyToRGB( p.value[ 0 ] ), texture: null };

	}

	if ( p.type === 'spectrum' ) {

		// Named spectrum (e.g. "metal-Au-eta") or sampled [lambda val ...].
		approximated( params, name );
		if ( typeof p.value[ 0 ] === 'string' ) {

			const key = namedMetalKey( p.value[ 0 ] );
			if ( key && METAL_ALBEDO[ key ] ) return { rgb: METAL_ALBEDO[ key ].slice(), texture: null };
			ctx.warn( `named spectrum "${p.value[ 0 ]}" approximated to gray` );
			return { rgb: [ 0.5, 0.5, 0.5 ], texture: null };

		}

		// Sampled spectrum → average value as gray (coarse).
		let sum = 0, count = 0;
		for ( let i = 1; i < p.value.length; i += 2 ) {

			sum += p.value[ i ]; count ++;

		}

		const v = count ? sum / count : 0.5;
		return { rgb: [ v, v, v ], texture: null };

	}

	approximated( params, name );
	return { rgb: dfltRGB, texture: null };

}

function namedMetalKey( s ) {

	const m = s.toLowerCase().match( /metal-([a-z0-9]+)/ );
	if ( m ) return m[ 1 ];
	for ( const k of Object.keys( METAL_ALBEDO ) ) if ( s.toLowerCase().includes( k ) ) return k;
	return null;

}

// A float parameter's value, or a float texture's mean (`ctx.floatTextureMean`); null when absent or unreadable.
async function floatOrMean( params, name, ctx ) {

	const p = param( params, name );
	if ( ! p ) return null;
	if ( typeof p.value[ 0 ] === 'number' ) return p.value[ 0 ];
	approximated( params, name );
	if ( p.type === 'texture' ) return ( await ctx.floatTextureMean?.( p.value[ 0 ] ) ) ?? null;
	return null;

}

/**
 * The engine's roughness for pbrt's `roughness` or anisotropic `uroughness`/`vroughness` (their α averaged), under
 * `prefix` for a layer (`conductor.`, `interface.`); a textured roughness counts as its mean. pbrt-v4 takes GGX
 * α = √roughness (`remaproughness`, the default) or α = roughness; the engine's GGX takes α = roughness². Passing
 * pbrt's number through made `remaproughness false` 0.1 an α of 0.01, a near mirror. `dflt` is the engine's.
 */
const remapsRoughness = ( params ) => {

	const remap = param( params, 'remaproughness' )?.value?.[ 0 ];
	return remap !== false && remap !== 'false';

};

async function resolveRoughness( params, dflt, ctx, prefix = '' ) {

	const remap = remapsRoughness( params );
	const alpha = ( r ) => ( remap ? Math.sqrt( Math.max( r, 0 ) ) : r );
	let a = null;
	const r = await floatOrMean( params, `${prefix}roughness`, ctx );
	if ( r !== null ) a = alpha( r );
	else {

		const u = await floatOrMean( params, `${prefix}uroughness`, ctx );
		const v = await floatOrMean( params, `${prefix}vroughness`, ctx );
		if ( u !== null ) a = v !== null ? ( alpha( u ) + alpha( v ) ) / 2 : alpha( u );

	}

	return a === null ? dflt : Math.sqrt( Math.max( a, 0 ) );

}

/**
 * Sets `target` (`roughness` or `clearcoatRoughness`) as resolveRoughness does, except that a textured roughness becomes
 * a roughness map with the remap baked in (`ctx.bakeFloatMap`), the value 1 multiplying it.
 */
async function applyRoughness( mat, target, params, dflt, ctx, prefix = '' ) {

	const single = params[ `${prefix}roughness` ];
	const keys = single ? [ `${prefix}roughness` ] : [ `${prefix}uroughness`, `${prefix}vroughness` ].filter( ( key ) => params[ key ] );
	if ( ctx.bakeFloatMap && keys.some( ( key ) => params[ key ].type === 'texture' ) ) {

		const remap = remapsRoughness( params );
		const alpha = ( r ) => ( remap ? Math.sqrt( Math.max( r, 0 ) ) : Math.max( r, 0 ) );
		const map = await ctx.bakeFloatMap( params, keys, ( values ) => Math.sqrt( values.reduce( ( sum, r ) => sum + alpha( r ), 0 ) / values.length ) );
		if ( map ) {

			mat[ `${target}Map` ] = map;
			mat[ target ] = 1;
			return;

		}

	}

	mat[ target ] = await resolveRoughness( params, dflt, ctx, prefix );

}

// A spectrum parameter as one RGB; a texture counts as its mean (`ctx.textureMeanRGB`).
async function spectrumMean( params, key, ctx, dflt ) {

	const p = param( params, key );
	if ( p?.type === 'texture' ) {

		approximated( params, key );
		return ( await ctx.textureMeanRGB?.( p.value[ 0 ] ) ) ?? dflt;

	}

	return ( await resolveSpectrum( params, key, ctx, dflt ) ).rgb ?? dflt;

}

// pbrt's default subsurface medium (materials.cpp), mm⁻¹.
const SUBSURFACE_SIGMA_A = [ 0.0011, 0.0024, 0.014 ];
const SUBSURFACE_SIGMA_S = [ 2.55, 3.21, 3.77 ];

/**
 * pbrt's `subsurface` as the engine's random walk under a dielectric boundary of `eta`: σt = σa + σs (times `scale`),
 * single-scattering albedo σs / σt, mean free path 1 / σt. The coefficients come as pbrt takes them — a named medium
 * (g 0), `sigma_a` and `sigma_s`, or a `reflectance` and `mfp` (scaled) inverted through the dipole — and default to
 * pbrt's. The base colour is the reflectance the dipole gives, for what reads it as an albedo.
 */
async function applySubsurface( mat, params, ctx ) {

	const { ior: eta, dispersion } = pEta( params, 'eta', 1.33 );
	if ( dispersion > 0 ) approximated( params, 'eta' );
	const scale = pFloat( params, 'scale', 1 );
	const scaled = ( rgb ) => rgb.map( ( v ) => Math.max( 0, v * scale ) );
	let g = pFloat( params, 'g', 0 );
	let sigmaA, sigmaS;

	const name = pString( params, 'name', '' );
	const named = name ? namedScattering( name ) : null;
	if ( name && ! named ) ctx.warn( `subsurface: no medium named "${name}" — using pbrt's default` );

	if ( named ) {

		sigmaA = scaled( named.sigmaA );
		sigmaS = scaled( named.sigmaS );
		g = 0;

	} else if ( params.sigma_a && params.sigma_s ) {

		sigmaA = scaled( await spectrumMean( params, 'sigma_a', ctx, SUBSURFACE_SIGMA_A ) );
		sigmaS = scaled( await spectrumMean( params, 'sigma_s', ctx, SUBSURFACE_SIGMA_S ) );

	} else if ( params.reflectance && ! name ) {

		const reflectance = await spectrumMean( params, 'reflectance', ctx, [ 0.5, 0.5, 0.5 ] );
		const mfp = scaled( params.mfp ? await spectrumMean( params, 'mfp', ctx, [ 1, 1, 1 ] ) : [ 1, 1, 1 ] );
		sigmaA = [];
		sigmaS = [];
		for ( let c = 0; c < 3; c ++ ) {

			const sigmaT = 1 / Math.max( mfp[ c ], 1e-9 );
			// The reduced albedo σ′s / ( σa + σ′s ), σ′s = ( 1 − g ) σs, back to σs at this σt.
			const reduced = albedoForReflectance( reflectance[ c ], eta );
			sigmaS[ c ] = reduced * sigmaT / ( 1 - g + reduced * g );
			sigmaA[ c ] = sigmaT - sigmaS[ c ];

		}

	} else {

		sigmaA = scaled( SUBSURFACE_SIGMA_A );
		sigmaS = scaled( SUBSURFACE_SIGMA_S );

	}

	const sigmaT = sigmaA.map( ( a, c ) => a + sigmaS[ c ] );
	mat.subsurface = 1;
	mat.subsurfaceColor = new Color( ...sigmaT.map( ( t, c ) => ( t > 0 ? sigmaS[ c ] / t : 0 ) ) );
	mat.subsurfaceRadius = sigmaT.map( ( t ) => ( t > 0 ? 1 / t : 1e6 ) );
	mat.subsurfaceRadiusScale = 1;
	mat.subsurfaceAnisotropy = Math.max( - 0.99, Math.min( 0.99, g ) );
	mat.ior = eta;
	mat.metalness = 0;
	mat.color.setRGB( ...sigmaT.map( ( t, c ) => {

		const reducedS = ( 1 - g ) * sigmaS[ c ];
		return t > 0 ? dipoleReflectance( reducedS / ( sigmaA[ c ] + reducedS ), eta ) : 0;

	} ) );
	await applyRoughness( mat, 'roughness', params, 0, ctx );

}

// Two maps read through one UV transform: the same repeat, offset and generated uv set; `b` null is the mesh's own uv.
const oneMapping = ( a, b ) => a === b || ( a.repeat.x === ( b?.repeat.x ?? 1 ) && a.repeat.y === ( b?.repeat.y ?? 1 )
	&& a.offset.x === ( b?.offset.x ?? 0 ) && a.offset.y === ( b?.offset.y ?? 0 )
	&& uvKey( a.userData.pbrtUV ) === uvKey( b?.userData.pbrtUV ) );

// pbrt-v4's default conductor, copper, as RGB.
const COPPER_ETA = [ 0.2, 0.92, 1.1 ], COPPER_K = [ 3.9, 2.45, 2.14 ];
const isNamedSpectrum = ( p ) => p?.type === 'spectrum' && typeof p.value[ 0 ] === 'string';

// A conductor's colour: `reflectance`; else the metal table for a named eta or k — exact for one metal's pair, and
// standing for that metal's eta and k alike when alone (another metal's, or a number, beside it is unused); else
// normal-incidence Fresnel of a measured eta and k, copper's for one not given (under `prefix` for a coated
// conductor). Neither given is copper.
async function applyConductorColor( mat, params, ctx, prefix, applyAlbedo, setColor ) {

	const refl = await resolveSpectrum( params, 'reflectance', ctx, null );
	const etaKey = `${prefix}eta`, kKey = `${prefix}k`;
	const etaP = params[ etaKey ], kP = params[ kKey ];

	if ( refl.rgb || refl.texture ) {

		applyAlbedo( refl );

	} else if ( isNamedSpectrum( etaP ) || isNamedSpectrum( kP ) ) {

		const [ key, other, otherKey ] = isNamedSpectrum( etaP ) ? [ etaKey, kP, kKey ] : [ kKey, etaP, etaKey ];
		const metal = namedMetalKey( param( params, key ).value[ 0 ] );
		const paired = isNamedSpectrum( other ) && namedMetalKey( other.value[ 0 ] ) === metal;
		if ( paired && METAL_ALBEDO[ metal ] ) {

			param( params, otherKey );
			setColor( METAL_ALBEDO[ metal ] );

		} else {

			setColor( ( await resolveSpectrum( params, key, ctx, DEFAULT_METAL ) ).rgb || DEFAULT_METAL );
			if ( paired ) approximated( params, otherKey );

		}

	} else if ( etaP || kP ) {

		// ((η-1)²+k²)/((η+1)²+k²); a texture's mean is not read here, so it takes copper's value.
		const measured = async ( key, dflt ) => {

			if ( ! params[ key ] ) return dflt;
			const { rgb, texture } = await resolveSpectrum( params, key, ctx, dflt );
			if ( texture || ! rgb ) approximated( params, key );
			return ( ! texture && rgb ) || dflt;

		};

		const eta = await measured( etaKey, COPPER_ETA ), k = await measured( kKey, COPPER_K );
		const fr = ( n, kk ) => ( ( n - 1 ) ** 2 + kk ** 2 ) / ( ( n + 1 ) ** 2 + kk ** 2 );
		setColor( [ fr( eta[ 0 ], k[ 0 ] ), fr( eta[ 1 ], k[ 1 ] ), fr( eta[ 2 ], k[ 2 ] ) ] );

	} else {

		setColor( METAL_ALBEDO.cu );

	}

	mat.metalness = 1;

}

/**
 * Build a MeshPhysicalMaterial from a pbrt material definition.
 * @param {{type:string, params:object}} def
 * @param {object} ctx - { resolveNamedTexture, warn }
 * @returns {Promise<MeshPhysicalMaterial>}
 */
export async function buildMaterial( def, ctx ) {

	// Built already, by the USD importer.
	if ( def?.material ) return def.material;

	const type = def?.type || 'diffuse';
	const params = def?.params || {};
	ctx.trackParams?.( params, `Material ${type}`, 'type' );
	const mat = new MeshPhysicalMaterial( { side: DoubleSide, roughness: 1, metalness: 0 } );
	// pbrt's eta is the surface's own ratio, inside over outside.
	mat.relativeIOR = true;

	const setColor = ( rgb ) => {

		if ( rgb ) mat.color.setRGB( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );

	};

	// Apply a resolved reflectance to the base color + map. A `scale` texture
	// yields BOTH an rgb tint and a texture — keep the tint as color so three
	// multiplies map×color. A plain imagemap (no tint) neutralizes color to white.
	const applyAlbedo = ( refl ) => {

		setColor( refl.rgb );
		if ( refl.texture ) {

			mat.map = refl.texture;
			if ( ! refl.rgb ) mat.color.setRGB( 1, 1, 1 );

		}

	};

	switch ( type ) {

		case 'diffuse': {

			// Lambertian: no dielectric specular layer, which MeshPhysicalMaterial has by default.
			applyAlbedo( await resolveSpectrum( params, 'reflectance', ctx, [ 0.5, 0.5, 0.5 ] ) );
			mat.roughness = 1;
			mat.metalness = 0;
			mat.specularIntensity = 0;
			break;

		}

		case 'conductor':
		case 'metal': {

			await applyConductorColor( mat, params, ctx, '', applyAlbedo, setColor );
			// pbrt's roughness defaults to 0, a mirror.
			await applyRoughness( mat, 'roughness', params, 0, ctx );
			break;

		}

		case 'coatedconductor': {

			// A conductor under a dielectric coat; pbrt's roughnesses default to 0 for both.
			await applyConductorColor( mat, params, ctx, 'conductor.', applyAlbedo, setColor );
			await applyRoughness( mat, 'roughness', params, 0, ctx, 'conductor.' );
			mat.clearcoat = 1;
			await applyRoughness( mat, 'clearcoatRoughness', params, 0, ctx, 'interface.' );
			break;

		}

		case 'dielectric':
		case 'thindielectric': {

			mat.transmission = 1;
			mat.metalness = 0;
			mat.color.setRGB( 1, 1, 1 );
			const eta = pEta( params, 'eta', 1.5 );
			mat.ior = eta.ior;
			// A thin dielectric bends no light, so its spectrum splits no colours.
			if ( type === 'dielectric' ) mat.dispersion = eta.dispersion;
			else if ( eta.dispersion > 0 ) approximated( params, 'eta' );
			await applyRoughness( mat, 'roughness', params, 0, ctx );
			mat.thickness = type === 'thindielectric' ? 0 : pFloat( params, 'thickness', 0 );
			break;

		}

		case 'coateddiffuse': {

			applyAlbedo( await resolveSpectrum( params, 'reflectance', ctx, [ 0.5, 0.5, 0.5 ] ) );
			mat.roughness = 0.6;
			mat.metalness = 0;
			mat.clearcoat = 1;
			await applyRoughness( mat, 'clearcoatRoughness', params, 0, ctx );
			break;

		}

		case 'diffusetransmission': {

			// pbrt reflects R and transmits T, both diffusely and both × `scale`, clamped to [0, 1]; no specular layer.
			// The engine splits its diffuse lobe by `diffuseTransmission`: reflecting (1 − dt) · colour · map, transmitting
			// dt · its colour · its map. dt = T's peak (its brightest texel × tint × scale); each colour is its lobe's
			// peak over its share × its map's brightest texel (`ctx.textureMaxRGB`, else taken as 1), so both are exact at
			// every texel pbrt does not clamp while max R + max T ≤ 1. A mapped colour may pass 1; colour × map stays ≤ 1.
			// `userData.pbrtFlat` keeps each colour at its peak, for where its map is dropped.
			const scale = pFloat( params, 'scale', 1 );
			const unit = ( v ) => Math.min( 1, Math.max( 0, scale * v ) );
			const lobe = async ( key ) => {

				const { rgb, texture } = await resolveSpectrum( params, key, ctx, [ 0.25, 0.25, 0.25 ] );
				const name = texture ? param( params, key )?.value[ 0 ] : null;
				const most = ( name && await ctx.textureMaxRGB?.( name ) ) || [ 1, 1, 1 ];
				return { texture, most, peak: ( rgb ?? [ 1, 1, 1 ] ).map( ( v, c ) => unit( v * most[ c ] ) ) };

			};

			const R = await lobe( 'reflectance' ), T = await lobe( 'transmittance' );
			const dt = Math.min( 0.99, Math.max( ...T.peak ) );
			const flat = ( l, share ) => l.peak.map( ( v ) => ( share > 0 ? Math.min( 1, v / share ) : 1 ) );
			const mapped = ( l, share ) => flat( l, share ).map( ( v, c ) => ( l.texture && l.most[ c ] > 0 ? v / l.most[ c ] : v ) );
			// T's map is read on the reflectance map's transform (the extension maps share it): another mapping is flat.
			const shared = T.texture && oneMapping( T.texture, R.texture );
			if ( T.texture && ! shared ) {

				ctx.warn( 'diffusetransmission: a textured "transmittance" mapped unlike its reflectance — flat at its brightest' );
				approximated( params, 'transmittance' );

			}

			mat.color.setRGB( ...mapped( R, 1 - dt ) );
			mat.map = R.texture ?? null;
			mat.diffuseTransmission = dt;
			mat.diffuseTransmissionColor = new Color().setRGB( ...( shared ? mapped( T, dt ) : flat( T, dt ) ) );
			if ( shared ) mat.diffuseTransmissionColorMap = T.texture;
			if ( R.texture || shared ) mat.userData.pbrtFlat = { color: flat( R, 1 - dt ), diffuseTransmissionColor: flat( T, dt ) };
			mat.roughness = 1;
			mat.metalness = 0;
			mat.specularIntensity = 0;
			break;

		}

		case 'interface':
		case 'none':
		case '': {

			// Medium boundary with no surface scattering — render as clear passthrough.
			mat.transmission = 1;
			mat.ior = 1.0;
			mat.roughness = 0;
			mat.color.setRGB( 1, 1, 1 );
			break;

		}

		case 'mix': {

			// pbrt blends two named materials by `amount`. Without a real layered BxDF
			// we lerp the two resolved MeshPhysicalMaterials' scalar/color properties
			// — physically loose but visually faithful, and crucially silent on success
			// instead of warning per shape. Recursive: mix-in-mix terminates as the
			// chain bottoms out at a non-mix.
			const matNames = param( params, 'materials' )?.value || [];
			let t = Math.max( 0, Math.min( 1, pFloat( params, 'amount', 0.5 ) ) );
			const defA = matNames[ 0 ] ? ctx.namedMaterials?.get( matNames[ 0 ] ) : null;
			const defB = matNames[ 1 ] ? ctx.namedMaterials?.get( matNames[ 1 ] ) : null;

			if ( defA && defB ) {

				const [ matA, matB ] = await Promise.all( [ buildMaterial( defA, ctx ), buildMaterial( defB, ctx ) ] );
				// pbrt picks the second material where a texture amount says so; its colours are baked by that
				// texture (`ctx.bakeMaterialMix`) and the rest is weighed by the texture's mean.
				const amountP = params.amount;
				const baked = amountP?.type === 'texture' ? await ctx.bakeMaterialMix?.( matA, matB, amountP.value[ 0 ] ) : null;
				if ( baked ) t = baked.mean;
				const lerp = ( a, b ) => a * ( 1 - t ) + b * t;
				// A colour made for its map's brightest texel (diffusetransmission's pbrtFlat) mixes at that peak, so the
				// dominant side's map darkens it and never takes it past 1.
				const flatOf = ( m, key ) => ( m.userData.pbrtFlat ? new Color( ...m.userData.pbrtFlat[ key ] ) : m[ key ] );
				mat.color.lerpColors( flatOf( matA, 'color' ), flatOf( matB, 'color' ), t );
				mat.roughness = lerp( matA.roughness, matB.roughness );
				mat.metalness = lerp( matA.metalness, matB.metalness );
				mat.ior = lerp( matA.ior ?? 1.5, matB.ior ?? 1.5 );
				mat.transmission = lerp( matA.transmission ?? 0, matB.transmission ?? 0 );
				mat.thickness = lerp( matA.thickness ?? 0, matB.thickness ?? 0 );
				mat.clearcoat = lerp( matA.clearcoat ?? 0, matB.clearcoat ?? 0 );
				mat.clearcoatRoughness = lerp( matA.clearcoatRoughness ?? 0, matB.clearcoatRoughness ?? 0 );
				mat.emissive.lerpColors( matA.emissive, matB.emissive, t );
				const dtA = matA.diffuseTransmission ?? 0, dtB = matB.diffuseTransmission ?? 0;
				if ( dtA > 0 || dtB > 0 ) {

					mat.diffuseTransmission = lerp( dtA, dtB );
					const white = new Color( 1, 1, 1 );
					mat.diffuseTransmissionColor = new Color().lerpColors( flatOf( matA, 'diffuseTransmissionColor' ) ?? white, flatOf( matB, 'diffuseTransmissionColor' ) ?? white, t );
					mat.diffuseTransmissionColorMap = ( t < 0.5 ? matA : matB ).diffuseTransmissionColorMap ?? null;

				}

				mat.emissiveIntensity = lerp( matA.emissiveIntensity ?? 0, matB.emissiveIntensity ?? 0 );
				// Maps can't be lerped — pick the dominant side, unless the amount's own texture baked them together.
				mat.map = ( t < 0.5 ? matA.map : matB.map ) || null;
				mat.normalMap = ( t < 0.5 ? matA.normalMap : matB.normalMap ) || null;
				if ( baked?.texture ) {

					mat.map = baked.texture;
					mat.color.setRGB( 1, 1, 1 );

				}

				break;

			}

			ctx.warn( `material "mix" — could not resolve inner materials [${matNames.join( ', ' )}], falling back to diffuse` );
			mat.color.set( new Color( 0.6, 0.6, 0.6 ) );
			break;

		}

		case 'subsurface': {

			await applySubsurface( mat, params, ctx );
			break;

		}

		case 'hair':
		case 'measured': {

			ctx.warn( `material "${type}" not supported — using diffuse approximation` );
			const refl = await resolveSpectrum( params, 'reflectance', ctx, [ 0.5, 0.5, 0.5 ] );
			setColor( refl.rgb );
			mat.roughness = 1;
			break;

		}

		default: {

			ctx.warn( `unknown material "${type}" — using neutral diffuse` );
			mat.color.set( new Color( 0.6, 0.6, 0.6 ) );
			break;

		}

	}

	const normalMap = pString( params, 'normalmap', null );
	if ( normalMap && ctx.resolveNormalMap ) mat.normalMap = await ctx.resolveNormalMap( normalMap );
	// pbrt shades a coat in the same normal-mapped frame as what it covers.
	if ( mat.clearcoat > 0 && mat.normalMap ) mat.clearcoatNormalMap = mat.normalMap;

	// pbrt-v4 bump-maps through `displacement`, a height in scene units.
	if ( param( params, 'displacement' )?.type === 'texture' && ctx.heightMap ) {

		const height = await ctx.heightMap( params, 'displacement' );
		if ( height ) {

			mat.bumpMap = height.map;
			mat.bumpDistance = height.distance;

		}

	}

	mat.roughness = Math.max( 0, Math.min( 1, mat.roughness ) );
	return mat;

}
