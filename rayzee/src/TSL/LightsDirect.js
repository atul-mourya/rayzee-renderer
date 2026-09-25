// Lights Direct - Ported from lights_direct.fs
// Direct lighting calculations including shadow ray tracing
// and contribution calculations for all light types.

import {
	Fn,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	dot,
	cross,
	normalize,
	abs,
	max,
	min,
	length,
	sqrt,
	cos,
	clamp,
	smoothstep,
	select,
	uintBitsToFloat,
} from 'three/tsl';

import { Ray, ShadowMaterial, HitInfo } from './Struct.js';
import {
	REC709_LUMINANCE_COEFFICIENTS, getShadowMaterial, getDatafromStorageBuffer, instanceRows,
	instanceFaceNormalToWorld, TRI_STRIDE, getAlphaShadowsUniform, shadowFlagsSettle
} from './Common.js';
import { fresnelDielectric } from './Fresnel.js';
import { calculateBeerLawAbsorption } from './MaterialTransmission.js';
import { getTransformedUV, sampleBucket } from './TextureSampling.js';

// Module-level state for alpha-cutout shadow testing.
// Set by PathTracer before shade-graph construction.
let _shadowAlbedoMaps = null;

export { setAlphaShadowsUniform } from './Common.js';

/**
 * Set the sRGB bucket texture node array for alpha-aware shadow rays (albedo alpha).
 * Must be called before the shade graph is constructed.
 * @param {Array} buckets - K sRGB bucket texture nodes
 */
export function setShadowAlbedoMaps( buckets ) {

	_shadowAlbedoMaps = buckets;

}

// ================================================================================
// SHADOW RAY TRACING
// ================================================================================

// Note: traverseBVH is passed as a parameter to avoid circular dependency
export const traceShadowRay = Fn( ( [
	origin, dir, maxDist,
	// BVH traversal function and textures passed as parameters
	traverseBVHShadowFn,
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
] ) => {

	const transmittance = float( 1.0 ).toVar();
	const rayOrigin = origin.toVar();
	const remainingDist = float( maxDist ).toVar();

	const MAX_SHADOW_TRANSMISSIONS = 16;

	Loop( { start: int( 0 ), end: int( MAX_SHADOW_TRANSMISSIONS ) }, () => {

		const shadowRay = Ray( { origin: rayOrigin, direction: dir } );

		const shadowHit = HitInfo.wrap( traverseBVHShadowFn(
			shadowRay,
			bvhBuffer,
			triangleBuffer,
			remainingDist,
		) );

		// No hit within remaining distance to light
		If( shadowHit.didHit.not(), () => {

			Break();

		} );

		// Opaque fast-path: check the per-triangle blocker bit, set at extraction time when
		// alphaMode/transparent/transmission/opacity all indicate a fully opaque surface.
		// Short-circuits the 7-slot getShadowMaterial fetch and the whole alpha decision tree.
		const flags = getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 4 ), int( TRI_STRIDE ) ).z;
		If( shadowFlagsSettle( flags ), () => {

			transmittance.assign( 0.0 );
			Break();

		} );

		// Fetch material for the hit surface (thin reader: 7 slots instead of 27)
		const shadowMaterial = ShadowMaterial.wrap( getShadowMaterial( shadowHit.materialIndex, materialBuffer ) );

		// ---------------------------------------------------------------
		// Alpha-cutout handling (MASK / BLEND with albedo texture alpha)
		// Gated by runtime uniform + alphaMode check — zero overhead for opaque materials.
		// UV computation deferred here from BVH traversal: barycentrics stored in shadowHit.uv,
		// triangle index in shadowHit.triangleIndex. Actual UV interpolation only when needed.
		// ---------------------------------------------------------------
		const alphaCutout = tslBool( false ).toVar();

		const alphaShadows = getAlphaShadowsUniform();
		if ( alphaShadows ) If( alphaShadows.equal( int( 1 ) ), () => {

			// Sample texture alpha once (shared by MASK and BLEND paths).
			// Deferred UV: barycentrics in shadowHit.uv, triangle index in shadowHit.triangleIndex.
			const texAlpha = float( 1.0 ).toVar();

			if ( _shadowAlbedoMaps ) {

				If( shadowMaterial.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

					const baryU = shadowHit.uv.x;
					const baryV = shadowHit.uv.y;
					const baryW = float( 1.0 ).sub( baryU ).sub( baryV );
					const uvData1 = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 3 ), int( TRI_STRIDE ) ) );
					const uvData2 = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 4 ), int( TRI_STRIDE ) ).xy );
					const hitUV = uvData1.xy.mul( baryW ).add( uvData1.zw.mul( baryU ) ).add( uvData2.mul( baryV ) );
					const albedoUV = getTransformedUV( { uv: hitUV, transform: shadowMaterial.albedoTransform } );
					texAlpha.assign( sampleBucket( _shadowAlbedoMaps, shadowMaterial.albedoMapIndex, albedoUV ).a );

				} );

			}

			If( shadowMaterial.alphaMode.equal( int( 1 ) ), () => {

				// MASK mode: binary alpha cutout. Include opacity (=baseColorFactor.a) so
				// factor-only MASK cuts out; mirrors the BLEND branch and the camera path.
				const effectiveAlpha = shadowMaterial.color.a.mul( texAlpha ).mul( shadowMaterial.opacity );
				const cutoff = select( shadowMaterial.alphaTest.greaterThan( 0.0 ), shadowMaterial.alphaTest, float( 0.5 ) );
				If( effectiveAlpha.lessThan( cutoff ), () => {

					alphaCutout.assign( true );

				} );

			} ).ElseIf( shadowMaterial.alphaMode.equal( int( 2 ) ), () => {

				// BLEND mode: modulate transmittance by alpha
				const blendAlpha = clamp( shadowMaterial.color.a.mul( shadowMaterial.opacity ).mul( texAlpha ), 0.0, 1.0 );
				transmittance.mulAssign( float( 1.0 ).sub( blendAlpha ) );

				If( transmittance.lessThan( 1e-4 ), () => {

					transmittance.assign( 0.0 );
					Break();

				} );

				alphaCutout.assign( true );

			} );

		} );

		// ---------------------------------------------------------------
		// Surface interaction: alpha-skip, transmission, transparent, or opaque
		// ---------------------------------------------------------------
		If( alphaCutout, () => {

			// Alpha-transparent surface — advance ray past it
			const alphaEps = max( float( 1e-5 ), length( shadowHit.hitPoint ).mul( 1e-6 ) );
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( alphaEps ) ) );
			remainingDist.subAssign( shadowHit.dst.add( alphaEps ) );

		} ).ElseIf( shadowMaterial.transmission.greaterThan( 0.0 ), () => {

			// Deferred geometric-normal compute — refetch triangle positions and
			// derive the normal here so opaque/alpha-cutout shadow hits don't pay
			// the cross+normalize cost in BVH traversal.
			const pA = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 0 ), int( TRI_STRIDE ) ).xyz );
			const pB = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 1 ), int( TRI_STRIDE ) ).xyz );
			const pC = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, shadowHit.triangleIndex, int( 2 ), int( TRI_STRIDE ) ).xyz );
			// Positions are in the blocker's object space; the cross product is a normal, so
			// it rides the inverse-transpose back out rather than the forward matrix.
			const objNormal = normalize( cross( pB.sub( pA ), pC.sub( pA ) ) ).toVar();
			If( shadowHit.instanceLeaf.greaterThanEqual( int( 0 ) ), () => {

				objNormal.assign( normalize( instanceFaceNormalToWorld( instanceRows( bvhBuffer, shadowHit.instanceLeaf ), objNormal ) ) );

			} );

			const geomNormal = objNormal;
			shadowHit.normal.assign( geomNormal );

			const entering = dot( dir, geomNormal ).lessThan( 0.0 );
			const N = select( entering, geomNormal, geomNormal.negate() );

			// Apply absorption if exiting medium
			If( entering.not().and( shadowMaterial.attenuationDistance.greaterThan( 0.0 ) ), () => {

				const dist = length( shadowHit.hitPoint.sub( rayOrigin ) );
				const absorption = calculateBeerLawAbsorption(
					shadowMaterial.attenuationColor,
					shadowMaterial.attenuationDistance,
					dist,
				);
				transmittance.mulAssign( absorption.x.add( absorption.y ).add( absorption.z ).div( 3.0 ) );

			} );

			// Shadow rays go straight through, so both faces see the outside-in angle and eta.
			const fresnel = fresnelDielectric( abs( dot( dir, N ) ), max( shadowMaterial.ior, 1.0 ) );

			const matTransmittance = float( 1.0 ).sub( fresnel ).mul( shadowMaterial.transmission );
			transmittance.mulAssign( matTransmittance );

			// Early exit if almost no light passes through
			If( transmittance.lessThan( 1e-4 ), () => {

				transmittance.assign( 0.0 );
				Break();

			} );

			// Continue ray past transmissive surface
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( 0.001 ) ) );
			remainingDist.subAssign( shadowHit.dst.add( 0.001 ) );

		} ).ElseIf( shadowMaterial.transparent, () => {

			// Handle transparent materials
			transmittance.mulAssign( float( 1.0 ).sub( shadowMaterial.opacity ) );

			If( transmittance.lessThan( 1e-4 ), () => {

				transmittance.assign( 0.0 );
				Break();

			} );

			// Continue ray past transparent surface
			rayOrigin.assign( shadowHit.hitPoint.add( dir.mul( 0.001 ) ) );
			remainingDist.subAssign( shadowHit.dst.add( 0.001 ) );

		} ).Else( () => {

			// Fully opaque object blocks shadow ray
			transmittance.assign( 0.0 );
			Break();

		} );

	} );

	return transmittance;

} );

// ================================================================================
// RAY OFFSET CALCULATION
// ================================================================================

export const calculateRayOffset = Fn( ( [ hitPoint, normal, material ] ) => {

	// Base epsilon scaled by scene size; adjusted by material properties below.
	const materialEpsilon = max( float( 1e-4 ), length( hitPoint ).mul( 1e-6 ) ).toVar();

	If( material.transmission.greaterThan( 0.0 ), () => {

		// Transmissive materials need larger offsets
		materialEpsilon.mulAssign( 2.0 );

	} );

	If( material.roughness.lessThan( 0.1 ), () => {

		// Smooth materials are more sensitive to precision issues
		materialEpsilon.mulAssign( 1.5 );

	} );

	return normal.mul( materialEpsilon );

} );

// ================================================================================
// LIGHT IMPORTANCE ESTIMATION
// ================================================================================

export const calculateDirectionalLightImportance = Fn( ( [ light, normal, material, bounceIndex ] ) => {

	const NoL = max( float( 0.0 ), dot( normal, light.direction ) );
	const result = float( 0.0 ).toVar();

	If( NoL.greaterThan( 0.0 ), () => {

		const intensity = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

		// Material-specific weighting
		const materialWeight = float( 1.0 ).toVar();
		If( material.metalness.greaterThan( 0.7 ), () => {

			materialWeight.assign( 1.5 );

		} ).ElseIf( material.roughness.greaterThan( 0.8 ), () => {

			materialWeight.assign( 0.7 );

		} );

		// Reduce importance on secondary bounces
		const bounceWeight = float( 1.0 ).div( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) );

		result.assign( intensity.mul( NoL ).mul( materialWeight ).mul( bounceWeight ) );

	} );

	return result;

} );

export const estimateLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const dist = length( toLight );
	const distSq = dist.mul( dist );

	const lightDir = toLight.div( dist );
	const NoL = max( dot( normal, lightDir ), 0.0 );
	const result = float( 0.0 ).toVar();

	If( NoL.greaterThan( 0.0 ), () => {

		const lightFacing = max( dot( lightDir, light.normal ).negate(), 0.0 );

		If( lightFacing.greaterThan( 0.0 ), () => {

			// Diffuse irradiance ∝ L·Ω·cosθ·cosθ′, Ω bounded by the hemisphere. Unit-free.
			const solidAngle = min( light.area.div( max( distSq, 1e-12 ) ), float( 2.0 * Math.PI ) );
			const invArea = select( light.normalize.greaterThan( 0.5 ), float( 1.0 ).div( max( light.area, 1e-10 ) ), float( 1.0 ) );
			const radiance = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) ).mul( invArea );

			// Material-aware weighting
			const materialFactor = float( 1.0 ).toVar();

			If( material.metalness.greaterThan( 0.7 ), () => {

				materialFactor.mulAssign( 1.5 );
				If( material.roughness.lessThan( 0.3 ), () => {

					materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.5 ) ) );

				} );

			} );

			If( material.transmission.greaterThan( 0.5 ), () => {

				materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.3 ) ) );

			} );

			result.assign( radiance.mul( solidAngle ).mul( NoL ).mul( lightFacing ).mul( materialFactor ) );

		} );

	} );

	return result;

} );

export const calculatePointLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const distSq = dot( toLight, toLight );
	const result = float( 0.0 ).toVar();

	If( distSq.greaterThanEqual( 0.001 ), () => {

		const dist = sqrt( distSq );
		const lightDir = toLight.div( dist );
		const NoL = max( float( 0.0 ), dot( normal, lightDir ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const distanceFactor = float( 1.0 ).div( max( distSq, 0.1 ) );
			const power = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

			const materialFactor = float( 1.0 ).toVar();

			If( material.metalness.greaterThan( 0.7 ), () => {

				materialFactor.mulAssign( 1.5 );
				If( material.roughness.lessThan( 0.3 ), () => {

					materialFactor.mulAssign( float( 1.0 ).add( float( 1.0 ).sub( material.roughness ).mul( 0.4 ) ) );

				} );

			} );

			If( material.roughness.greaterThan( 0.6 ), () => {

				materialFactor.mulAssign( 0.9 );

			} );

			If( material.transmission.greaterThan( 0.5 ), () => {

				materialFactor.mulAssign( float( 1.0 ).add( material.transmission.mul( 0.2 ) ) );

			} );

			result.assign( power.mul( distanceFactor ).mul( NoL ).mul( materialFactor ) );

		} );

	} );

	return result;

} );

export const calculateSpotLightImportance = Fn( ( [ light, hitPoint, normal, material ] ) => {

	const toLight = light.position.sub( hitPoint );
	const distSq = dot( toLight, toLight );
	const result = float( 0.0 ).toVar();

	If( distSq.greaterThanEqual( 0.001 ), () => {

		const lightDir = toLight.div( sqrt( distSq ) );
		const NoL = max( float( 0.0 ), dot( normal, lightDir ) );

		If( NoL.greaterThan( 0.0 ), () => {

			const spotCosAngle = dot( lightDir.negate(), light.direction );
			const coneCosAngle = cos( light.angle );

			If( spotCosAngle.greaterThanEqual( coneCosAngle ), () => {

				const distanceFactor = float( 1.0 ).div( max( distSq, 0.01 ) );
				const coneAttenuation = smoothstep( coneCosAngle, coneCosAngle.add( 0.1 ), spotCosAngle );
				const intensity = light.intensity.mul( dot( light.color, REC709_LUMINANCE_COEFFICIENTS ) );

				const materialWeight = select(
					material.metalness.greaterThan( 0.7 ), float( 1.5 ),
					select( material.roughness.greaterThan( 0.8 ), float( 0.8 ), float( 1.0 ) )
				);

				result.assign( intensity.mul( distanceFactor ).mul( coneAttenuation ).mul( NoL ).mul( materialWeight ) );

			} );

		} );

	} );

	return result;

} );

