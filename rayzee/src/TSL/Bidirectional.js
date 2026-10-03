/**
 * Bidirectional path tracing — shared by the light pass, ConnectKernel and LightSplatKernel.
 * MIS is Georgiev 2012's dVCM/dVC recursion; every density comes from calculateMaterialPDF, both ways
 * round, so every strategy evaluates the same weights. With vertex merging (integrator 'vcm') a state also
 * carries `vm`, η² at its vertex (η = πr² · light paths, r that vertex's merge radius): Georgiev's dVM there is
 * dVC / η², so it is never stored.
 */

import {
	float, vec2, vec4, int, uint, If, max, select, abs, dot, length,
} from 'three/tsl';

import { getMaterial, MIN_ROUGHNESS, REC709_LUMINANCE_COEFFICIENTS } from './Common.js';
import { RayTracingMaterial, MaterialSamples, ExtMapResult } from './Struct.js';
import { sampleAllMaterialTextures, processAnisotropyMap, applyExtensionMaps, getTransformedUV } from './TextureSampling.js';
import { SAMPLER_DIM_AUX_BASE } from './Random.js';

// 1D dimensions of a camera vertex's bounce block (Random.js budget) picking its connection.
export const DIM_CONNECT_PATH = 16;
export const DIM_CONNECT_VERTEX = 17;
// Emission: 1D triangle pick, 2D point, 2D direction, 1D side, 1D sun or emitter, 2D sun direction, 2D disc point.
export const DIM_EMIT = SAMPLER_DIM_AUX_BASE + 2048;

// Light paths draw at pixels far below the image, so their sequences never repeat a camera path's.
export const LIGHT_PIXEL_ROW_OFFSET = 65536;

// Light tracing adds into u32 per channel: value · SPLAT_SCALE, rounded stochastically.
export const SPLAT_SCALE = 16384;
export const SPLAT_MAX = 4096;

// Pending-connection tags set the high bit: a light path's data in that lane is a positive float's bits.
export const PASS_TAG_BIT = 0x80000000;

const MIS_MAX = 1e30;

const finite = ( x ) => select( x.equal( x ), x, float( 0.0 ) ).clamp( 0.0, MIS_MAX );

export const lightPathPixel = ( index, resolution ) => {

	const w = uint( resolution.x );
	return vec2( float( uint( index ).mod( w ) ).add( 0.5 ), float( uint( index ).div( w ).add( uint( LIGHT_PIXEL_ROW_OFFSET ) ) ).add( 0.5 ) );

};

// The power heuristic (β = 2). The recursion stores every density ratio already raised to it.
export const mis = ( x ) => x.mul( x );

// MIS recursion: `state` holds two .toVar()s, { dVCM, dVC }, updated in place, and `vm` when merging.

/** Arriving at a vertex `dist` from the last one, at |cos| `cosIn` to its facet. */
export const misOnHit = ( state, dist, cosIn ) => {

	const c = max( cosIn, 1e-6 );
	state.dVCM.assign( finite( state.dVCM.mul( mis( dist.mul( dist ).div( c ) ) ) ) );
	state.dVC.assign( finite( state.dVC.div( mis( c ) ) ) );

};

/** Leaving through a delta lobe, a refraction or a subsurface boundary: nothing can connect here. */
export const misOnSpecular = ( state, cosOut ) => {

	state.dVC.assign( finite( state.dVC.mul( mis( cosOut ) ) ) );
	state.dVCM.assign( 0.0 );

};

/** Leaving by a BSDF sample; densities are solid angle, forward the sampler's and reverse its partner's. */
export const misOnScatter = ( state, cosOut, pdfForward, pdfReverse ) => {

	const p = max( pdfForward, 1e-12 );
	const partial = state.dVC.mul( mis( pdfReverse ) ).add( state.dVCM );
	state.dVC.assign( finite( mis( cosOut.div( p ) ).mul( finite( state.vm ? partial.add( state.vm ) : partial ) ) ) );
	state.dVCM.assign( finite( mis( float( 1.0 ).div( p ) ) ) );

};

// Georgiev (40)-(46): `lead` is the other side's density of reaching this end, `reverse` this end's density back.
export const misPartial = ( lead, state, reverse ) => {

	const partial = state.dVCM.add( state.dVC.mul( mis( reverse ) ) );
	return finite( finite( mis( lead ) ).mul( finite( state.vm ? partial.add( state.vm ) : partial ) ) );

};

// Vertex merging's radius at p: a few pixels' footprint seen from the camera (`mergeConst` + `mergeSlope` · distance),
// at least `mergeMin`. A function of position alone, so both subpaths weigh a merge at any vertex alike.
export const mergeRadiusAt = ( bdpt, p ) =>
	max( bdpt.mergeConst.add( bdpt.mergeSlope.mul( length( p.sub( bdpt.cameraPosition ) ) ) ), bdpt.mergeMin );

// η = πr² · light paths: a merge's density over a connection's, there.
export const mergeEta = ( bdpt, radius ) => radius.mul( radius ).mul( Math.PI ).mul( float( bdpt.lightPaths ) );

/**
 * η² at p as the weights take it, a state's `vm` (Georgiev's vmFactor, per vertex): η scaled by `mergeTrust`. Any
 * density the strategies agree on still sums their weights to one; trust below 1 hands light other strategies can
 * also reach back to them, unblurred, and leaves light only a merge reaches (a caustic in a mirror) all to merging.
 */
export const mergeVmAt = ( bdpt, p ) => {

	const eta = mergeEta( bdpt, mergeRadiusAt( bdpt, p ) ).mul( bdpt.mergeTrust );
	return eta.mul( eta );

};

// Georgiev (38)-(39), a merge at a camera vertex: each side's sum, `density` the camera vertex's BSDF density
// (of the light's arrival direction for the light side, back along its own for the camera side); `vc` = 1 / η².
export const misMergePartial = ( state, density, vc ) => finite( finite( state.dVCM.add( state.dVC.mul( mis( density ) ) ) ).mul( vc ) );

export const misWeight = ( wLight, wCamera ) => float( 1.0 ).div( float( 1.0 ).add( finite( wLight ) ).add( finite( wCamera ) ) );

// Verification: a view keeps one strategy, MIS-weighted, or alone at full weight (+ STRATEGY_ALONE).
export const STRATEGY = { ALL: 0, HIT: 1, NEE: 2, CONNECT: 3, LIGHT_TRACE: 4, MERGE: 5 };
export const STRATEGY_ALONE = 8;

export const strategyWeight = ( view, strategy, weight, alone = float( 1.0 ) ) =>
	select( view.equal( uint( STRATEGY.ALL ) ).or( view.equal( uint( strategy ) ) ), weight,
		select( view.equal( uint( strategy + STRATEGY_ALONE ) ), alone, float( 0.0 ) ) );

// Chance a light path leaves this side of a triangle toward `cosToward` (cosine to the winding normal).
export const emitterSideProbability = ( side, cosToward ) => select( side.equal( int( 2 ) ), float( 0.5 ),
	select( side.equal( int( 1 ) ), select( cosToward.lessThan( 0.0 ), float( 1.0 ), float( 0.0 ) ),
		select( cosToward.greaterThan( 0.0 ), float( 1.0 ), float( 0.0 ) ) ) );

/** Area density of a light path's start on a triangle with this emission — power over total, per area. */
export const emitterAreaPdf = ( emission, totalPower, share = 1 ) =>
	max( dot( emission, REC709_LUMINANCE_COEFFICIENTS ), 0.0 ).div( max( totalPower, 1e-10 ) ).mul( share );

// The sun as a light subpath start: a direction over its disc, then a point on the scene's bounding disc at `discPdf`
// (LightGuide.js guidedDiscPdf).
export const sunEmissionPdf = ( bdpt, sunParams, discPdf ) => bdpt.sunPick.mul( discPdf ).div( max( sunParams.y, 1e-30 ) );

// Where a light subpath starts, in its pick table's order (`sourceCdf`, a running sum); each lamp list follows
// at `sourceOffsets[ type ]`, by LIGHT_TYPE. A light path's origin code is its triangle, or −1 − its source.
export const SOURCE = { SUN: 0, EMITTERS: 1, ENVIRONMENT: 2, LAMPS: 3 };

export const sourcePick = ( bdpt, source ) => {

	const s = int( source );
	return bdpt.sourceCdf.element( s ).sub( select( s.greaterThan( int( 0 ) ), bdpt.sourceCdf.element( max( s.sub( int( 1 ) ), int( 0 ) ) ), float( 0.0 ) ) );

};

export const lampSource = ( bdpt, type, index ) => select( type.equal( int( 0 ) ), int( bdpt.sourceOffsets[ 0 ] ),
	select( type.equal( int( 1 ) ), int( bdpt.sourceOffsets[ 1 ] ), select( type.equal( int( 2 ) ), int( bdpt.sourceOffsets[ 2 ] ), int( bdpt.sourceOffsets[ 3 ] ) ) ) ).add( index );

export const sourceLampType = ( bdpt, source ) => select( source.lessThan( int( bdpt.sourceOffsets[ 1 ] ) ), int( 0 ),
	select( source.lessThan( int( bdpt.sourceOffsets[ 2 ] ) ), int( 1 ), select( source.lessThan( int( bdpt.sourceOffsets[ 3 ] ) ), int( 2 ), int( 3 ) ) ) );

export const sourceLampIndex = ( bdpt, source, type ) => source.sub( select( type.equal( int( 0 ) ), int( bdpt.sourceOffsets[ 0 ] ),
	select( type.equal( int( 1 ) ), int( bdpt.sourceOffsets[ 1 ] ), select( type.equal( int( 2 ) ), int( bdpt.sourceOffsets[ 2 ] ), int( bdpt.sourceOffsets[ 3 ] ) ) ) ) );

// The material at a stored vertex, folded as ShadeKernel folds it; its shading normal is already stored.
export function resolveSurfaceMaterial( materialIndex, uv, N, materialBuffer ) {

	const material = RayTracingMaterial.wrap( getMaterial( int( materialIndex ), materialBuffer ) ).toVar();
	material.normalMapIndex.assign( int( - 1 ) );
	material.bumpMapIndex.assign( int( - 1 ) );
	material.displacementMapIndex.assign( int( - 1 ) );

	const samples = MaterialSamples.wrap( sampleAllMaterialTextures( material, uv, N, vec4( 0.0 ) ) ).toVar();
	const rawRough = samples.roughness.toVar();

	material.color.assign( samples.albedo );
	material.metalness.assign( samples.metalness.clamp( 0.0, 1.0 ) );
	material.roughness.assign( samples.roughness.clamp( MIN_ROUGHNESS, 1.0 ) );
	material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) );

	const extUV = getTransformedUV( { uv, transform: material.albedoTransform } ).toVar();

	If( material.anisotropyMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const aniso = processAnisotropyMap( material, extUV ).toVar();
		material.anisotropy.assign( aniso.x );
		material.anisotropyRotation.assign( aniso.y );

	} );

	const ext = ExtMapResult.wrap( applyExtensionMaps( material, extUV ) ).toVar();
	material.transmission.assign( ext.transmission );
	material.clearcoat.assign( ext.clearcoat );
	material.clearcoatRoughness.assign( ext.clearcoatRoughness );
	material.sheenColor.assign( ext.sheenColor );
	material.sheenRoughness.assign( ext.sheenRoughness );
	material.iridescence.assign( ext.iridescence );
	material.iridescenceThicknessRange.assign( vec2( material.iridescenceThicknessRange.x, ext.iridescenceThickness ) );
	material.specularIntensity.assign( ext.specularIntensity );
	material.specularColor.assign( ext.specularColor );

	If( rawRough.lessThan( MIN_ROUGHNESS ).and( material.anisotropy.equal( 0.0 ) ).and( material.clearcoat.equal( 0.0 ) )
		.and( material.transmission.equal( 0.0 ) ).and( material.subsurface.equal( 0.0 ) ), () => {

		material.roughness.assign( 0.0 );

	} );

	return material;

}

// The light end's cosine with the shading-normal correction (Veach 5.3.2): |V·N| |d·Ng| / |V·Ng|.
export const lightEndCosine = ( V, N, facetN, toOther ) =>
	abs( dot( V, N ) ).mul( abs( dot( toOther, facetN ) ) ).div( max( abs( dot( V, facetN ) ), 1e-4 ) );
