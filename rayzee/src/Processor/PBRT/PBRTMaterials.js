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

/**
 * The engine's roughness for pbrt's `roughness` or anisotropic `uroughness`/`vroughness` (their α averaged). pbrt-v4
 * takes GGX α = √roughness (`remaproughness`, the default) or α = roughness; the engine's GGX takes α = roughness².
 * Passing pbrt's number through made `remaproughness false` 0.1 an α of 0.01, a near mirror. `dflt` is the engine's.
 */
function resolveRoughness( params, dflt ) {

	const remap = params.remaproughness?.value?.[ 0 ];
	const alpha = ( r ) => ( remap === false || remap === 'false' ? r : Math.sqrt( Math.max( r, 0 ) ) );
	let a = null;
	if ( params.roughness && typeof params.roughness.value[ 0 ] === 'number' ) a = alpha( params.roughness.value[ 0 ] );
	else {

		const u = pFloat( params, 'uroughness', null );
		const v = pFloat( params, 'vroughness', null );
		if ( u !== null ) a = v !== null ? ( alpha( u ) + alpha( v ) ) / 2 : alpha( u );

	}

	return a === null ? dflt : Math.sqrt( Math.max( a, 0 ) );

}

/**
 * Build a MeshPhysicalMaterial from a pbrt material definition.
 * @param {{type:string, params:object}} def
 * @param {object} ctx - { resolveNamedTexture, warn }
 * @returns {Promise<MeshPhysicalMaterial>}
 */
export async function buildMaterial( def, ctx ) {

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

			const refl = await resolveSpectrum( params, 'reflectance', ctx, null );
			const etaP = params.eta, kP = params.k;
			const etaNamed = etaP && etaP.type === 'spectrum' && typeof etaP.value[ 0 ] === 'string';

			if ( refl.rgb || refl.texture ) {

				applyAlbedo( refl );

			} else if ( etaP && kP && ! etaNamed ) {

				// Normal-incidence reflectance from complex IOR: ((η-1)²+k²)/((η+1)²+k²).
				const eta = ( await resolveSpectrum( params, 'eta', ctx, [ 0.2, 0.92, 1.1 ] ) ).rgb;
				const k = ( await resolveSpectrum( params, 'k', ctx, [ 3.9, 2.45, 2.14 ] ) ).rgb;
				const fr = ( n, kk ) => ( ( n - 1 ) ** 2 + kk ** 2 ) / ( ( n + 1 ) ** 2 + kk ** 2 );
				setColor( [ fr( eta[ 0 ], k[ 0 ] ), fr( eta[ 1 ], k[ 1 ] ), fr( eta[ 2 ], k[ 2 ] ) ] );

			} else if ( etaP ) {

				// Named conductor spectrum → metal albedo table.
				setColor( ( await resolveSpectrum( params, 'eta', ctx, DEFAULT_METAL ) ).rgb || DEFAULT_METAL );

			} else {

				setColor( METAL_ALBEDO.cu ); // pbrt-v4 default conductor is copper

			}

			mat.metalness = 1;
			mat.roughness = resolveRoughness( params, 0.1 );
			break;

		}

		case 'dielectric':
		case 'thindielectric': {

			mat.transmission = 1;
			mat.metalness = 0;
			mat.color.setRGB( 1, 1, 1 );
			mat.ior = pFloat( params, 'eta', 1.5 );
			mat.roughness = resolveRoughness( params, 0 );
			mat.thickness = type === 'thindielectric' ? 0 : pFloat( params, 'thickness', 0 );
			break;

		}

		case 'coateddiffuse': {

			applyAlbedo( await resolveSpectrum( params, 'reflectance', ctx, [ 0.5, 0.5, 0.5 ] ) );
			mat.roughness = 0.6;
			mat.metalness = 0;
			mat.clearcoat = 1;
			mat.clearcoatRoughness = resolveRoughness( params, 0 );
			break;

		}

		case 'diffusetransmission': {

			const trans = await resolveSpectrum( params, 'transmittance', ctx, [ 0.25, 0.25, 0.25 ] );
			applyAlbedo( await resolveSpectrum( params, 'reflectance', ctx, [ 0.25, 0.25, 0.25 ] ) );
			mat.transmission = trans.rgb ? ( trans.rgb[ 0 ] + trans.rgb[ 1 ] + trans.rgb[ 2 ] ) / 3 : 0.5;
			mat.roughness = 1;
			mat.ior = 1.0;
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
			const t = Math.max( 0, Math.min( 1, pFloat( params, 'amount', 0.5 ) ) );
			const defA = matNames[ 0 ] ? ctx.namedMaterials?.get( matNames[ 0 ] ) : null;
			const defB = matNames[ 1 ] ? ctx.namedMaterials?.get( matNames[ 1 ] ) : null;

			if ( defA && defB ) {

				const [ matA, matB ] = await Promise.all( [ buildMaterial( defA, ctx ), buildMaterial( defB, ctx ) ] );
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
				mat.emissiveIntensity = lerp( matA.emissiveIntensity ?? 0, matB.emissiveIntensity ?? 0 );
				// Maps can't be lerped — pick the dominant side.
				mat.map = ( t < 0.5 ? matA.map : matB.map ) || null;
				break;

			}

			ctx.warn( `material "mix" — could not resolve inner materials [${matNames.join( ', ' )}], falling back to diffuse` );
			mat.color.set( new Color( 0.6, 0.6, 0.6 ) );
			break;

		}

		case 'subsurface':
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

	mat.roughness = Math.max( 0, Math.min( 1, mat.roughness ) );
	return mat;

}
