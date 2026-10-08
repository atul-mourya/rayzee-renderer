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
import { namedScattering, dipoleReflectance, albedoForReflectance } from './PBRTScattering.js';

// Normal-incidence reflectance approximations for pbrt's named conductor spectra.
const METAL_ALBEDO = {
	au: [ 1.0, 0.78, 0.34 ], gold: [ 1.0, 0.78, 0.34 ],
	cu: [ 0.95, 0.64, 0.54 ], copper: [ 0.95, 0.64, 0.54 ],
	ag: [ 0.97, 0.96, 0.91 ], silver: [ 0.97, 0.96, 0.91 ],
	al: [ 0.91, 0.92, 0.92 ], aluminium: [ 0.91, 0.92, 0.92 ], aluminum: [ 0.91, 0.92, 0.92 ],
	mgo: [ 0.9, 0.9, 0.9 ], tio2: [ 0.9, 0.9, 0.9 ]
};

const DEFAULT_METAL = [ 0.92, 0.92, 0.92 ];

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

	const p = params[ name ];
	return p && typeof p.value[ 0 ] === 'number' ? p.value[ 0 ] : dflt;

}

export function pString( params, name, dflt ) {

	const p = params[ name ];
	return p && typeof p.value[ 0 ] === 'string' ? p.value[ 0 ] : dflt;

}

export function pBool( params, name, dflt ) {

	const v = params[ name ]?.value?.[ 0 ];
	return v === undefined ? dflt : v === true || v === 'true';

}

/**
 * Resolve a spectrum/color/float-valued parameter to an RGB triple and/or a
 * texture. Returns `{ rgb, texture }` — exactly one is typically non-null.
 * @returns {Promise<{rgb:number[]|null, texture:import('three').Texture|null}>}
 */
export async function resolveSpectrum( params, name, ctx, dfltRGB = null ) {

	const p = params[ name ];
	if ( ! p ) return { rgb: dfltRGB, texture: null };

	// Reference to a named texture.
	if ( p.type === 'texture' ) {

		const texName = p.value[ 0 ];
		const tex = await ctx.resolveNamedTexture( texName );
		if ( tex && tex.texture ) return { rgb: tex.constant ?? null, texture: tex.texture };
		if ( tex && tex.constant ) return { rgb: tex.constant, texture: null };
		ctx.warn( `texture "${texName}" could not be resolved` );
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

		return { rgb: blackbodyToRGB( p.value[ 0 ] ), texture: null };

	}

	if ( p.type === 'spectrum' ) {

		// Named spectrum (e.g. "metal-Au-eta") or sampled [lambda val ...].
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

	return { rgb: dfltRGB, texture: null };

}

function namedMetalKey( s ) {

	const m = s.toLowerCase().match( /metal-([a-z]+)/ );
	if ( m ) return m[ 1 ];
	for ( const k of Object.keys( METAL_ALBEDO ) ) if ( s.toLowerCase().includes( k ) ) return k;
	return null;

}

// A float parameter's value, or a float texture's mean (`ctx.floatTextureMean`); null when absent or unreadable.
async function floatOrMean( params, name, ctx ) {

	const p = params[ name ];
	if ( ! p ) return null;
	if ( typeof p.value[ 0 ] === 'number' ) return p.value[ 0 ];
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

	const remap = params.remaproughness?.value?.[ 0 ];
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

	const p = params[ key ];
	if ( p?.type === 'texture' ) return ( await ctx.textureMeanRGB?.( p.value[ 0 ] ) ) ?? dflt;
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

	const eta = pFloat( params, 'eta', 1.33 );
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

// A conductor's colour: `reflectance`, else normal-incidence Fresnel of `eta`/`k` (under `prefix` for a coated
// conductor). pbrt's default is copper.
async function applyConductorColor( mat, params, ctx, prefix, applyAlbedo, setColor ) {

	const refl = await resolveSpectrum( params, 'reflectance', ctx, null );
	const etaP = params[ `${prefix}eta` ], kP = params[ `${prefix}k` ];
	const etaNamed = etaP && etaP.type === 'spectrum' && typeof etaP.value[ 0 ] === 'string';

	if ( refl.rgb || refl.texture ) {

		applyAlbedo( refl );

	} else if ( etaP && kP && ! etaNamed ) {

		// Normal-incidence reflectance from complex IOR: ((η-1)²+k²)/((η+1)²+k²).
		const eta = ( await resolveSpectrum( params, `${prefix}eta`, ctx, [ 0.2, 0.92, 1.1 ] ) ).rgb;
		const k = ( await resolveSpectrum( params, `${prefix}k`, ctx, [ 3.9, 2.45, 2.14 ] ) ).rgb;
		const fr = ( n, kk ) => ( ( n - 1 ) ** 2 + kk ** 2 ) / ( ( n + 1 ) ** 2 + kk ** 2 );
		setColor( [ fr( eta[ 0 ], k[ 0 ] ), fr( eta[ 1 ], k[ 1 ] ), fr( eta[ 2 ], k[ 2 ] ) ] );

	} else if ( etaP ) {

		// Named conductor spectrum → metal albedo table.
		setColor( ( await resolveSpectrum( params, `${prefix}eta`, ctx, DEFAULT_METAL ) ).rgb || DEFAULT_METAL );

	} else {

		setColor( METAL_ALBEDO.cu ); // pbrt-v4 default conductor is copper

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
	const mat = new MeshPhysicalMaterial( { side: DoubleSide, roughness: 1, metalness: 0 } );

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
			await applyRoughness( mat, 'roughness', params, 0.1, ctx );
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
			mat.ior = pFloat( params, 'eta', 1.5 );
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
			// The engine splits its diffuse lobe by `diffuseTransmission`: reflecting (1 − dt) · base, transmitting
			// dt · colour. dt = max(T) makes both exact whenever max(R) + max(T) ≤ 1.
			const scale = pFloat( params, 'scale', 1 );
			const unit = ( v ) => Math.min( 1, Math.max( 0, scale * v ) );
			const trans = await resolveSpectrum( params, 'transmittance', ctx, [ 0.25, 0.25, 0.25 ] );
			const T = trans.rgb ? trans.rgb.map( unit ) : [ 0.5, 0.5, 0.5 ];
			const dt = Math.min( 0.99, Math.max( ...T ) );
			const refl = await resolveSpectrum( params, 'reflectance', ctx, [ 0.25, 0.25, 0.25 ] );
			const base = ( v ) => Math.min( 1, unit( v ) / ( 1 - dt ) );
			applyAlbedo( { texture: refl.texture, rgb: refl.rgb ? refl.rgb.map( base ) : ( refl.texture ? [ 1, 1, 1 ].map( base ) : null ) } );
			if ( trans.texture ) ctx.warn( 'diffusetransmission: a textured "transmittance" is not supported — using 0.5' );
			mat.diffuseTransmission = dt;
			mat.diffuseTransmissionColor = new Color().setRGB( ...T.map( ( v ) => ( dt > 0 ? Math.min( 1, v / dt ) : 1 ) ) );
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
			const matNames = params.materials?.value || [];
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
				mat.color.lerpColors( matA.color, matB.color, t );
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
					mat.diffuseTransmissionColor = new Color().lerpColors( matA.diffuseTransmissionColor ?? new Color( 1, 1, 1 ), matB.diffuseTransmissionColor ?? new Color( 1, 1, 1 ), t );

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

	mat.roughness = Math.max( 0, Math.min( 1, mat.roughness ) );
	return mat;

}
