// Lights Direct - Ported from lights_direct.fs
// Direct lighting calculations including shadow ray tracing
// and contribution calculations for all light types.

import { sceneResources, usesGlass, usesSeeThrough, usesTransmissionMaps } from './SceneResources.js';
import {
	Fn,
	float,
	vec3,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	Continue,
	uint,
	vec2,
	intBitsToFloat,
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

import { Ray, ShadowMaterial } from './Struct.js';
import {
	REC709_LUMINANCE_COEFFICIENTS, getShadowMaterial, instanceRows,
	instanceFaceNormalToWorld, triangleRow, triangleGeoRows, offsetRayOrigin,
	getDatafromStorageBuffer, MATERIAL_SLOT, MATERIAL_SLOTS, transmissionTint, kernelFunction,
} from './Common.js';
import { fresnelDielectric } from './Fresnel.js';
import { calculateBeerLawAbsorption } from './MaterialTransmission.js';
import { getTransformedUV, sampleBucket } from './TextureSampling.js';
import { fogTransmittance } from './Fog.js';
import { volumeTransmittance } from './Volume.js';
import { shadowSurfaceLane, traverseBVHShadow, traverseBVHShadowCameraCulled } from './BVHTraversal.js';
import { TRI_MATERIAL_MASK } from '../scene/BufferLayout.js';

// ================================================================================
// SHADOW RAY TRACING
// ================================================================================

// A walk keeps the nearest SHADOW_SURFACES surfaces light passes; a ray resolves SHADOW_SURFACE_BUDGET of them, then
// lets the light through. ⚠️ Every walk sets up 5 ints a kept surface: more than 4 slowed the small scenes.
const SHADOW_SURFACES = 4;
const SHADOW_SURFACE_BUDGET = 16;

// The light that gets through, as a colour: glass tints it as a camera path through it is tinted. Where glass blocks
// (`refractiveBlocks`) nothing is coloured, so the result is a float; in a scene without glass a number carries it.
// Where no material lets light through, any hit blocks. Else a walk (`shadowWalk`, BVHTraversal's) keeps the surfaces
// light passes, resolved after it nearest first. One that may yet block ends its walk at itself: where every one may
// (glass blocks, or the scene's only such surfaces are alpha-tested), one is kept a walk.
const makeTraceShadowRay = ( refractiveBlocks, shadowWalk = traverseBVHShadow ) => kernelFunction( 'traceShadowRay', {
	origin: 'vec3', dir: 'vec3', maxDist: 'float', return: refractiveBlocks ? 'float' : 'vec3',
}, ( [
	origin, dir, maxDist,
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
], builder ) => {

	const { alphaShadows, shadowAlbedoMaps, linearBuckets, fog, volumes } = sceneResources( builder );
	const glass = ! refractiveBlocks && usesGlass( builder );
	const transmissionMaps = glass && usesTransmissionMaps( builder );
	const transmittance = ( glass ? vec3( 1.0 ) : float( 1.0 ) ).toVar();
	const block = () => transmittance.assign( glass ? vec3( 0.0 ) : float( 0.0 ) );
	const faint = () => ( glass ? max( transmittance.x, max( transmittance.y, transmittance.z ) ) : transmittance ).lessThan( 1e-4 );
	// As values: the loop below is the first reader of `dir`, and an expression read there first is zero after it.
	const segment = fog || volumes ? { from: vec3( origin ).toVar(), dir: vec3( dir ).toVar(), length: float( maxDist ).toVar() } : null;

	// One surface light may pass, built inside the loop over them (Break() leaves it): `travelled()` is the distance
	// since the surface before, `pass()` moves on past this one.
	const surface = ( shadowHit, travelled, pass ) => {

		// Fetch material for the hit surface (thin reader: 7 slots instead of 27)
		const shadowMaterial = ShadowMaterial.wrap( getShadowMaterial( shadowHit.materialIndex, materialBuffer ) );

		// The hit's texture coordinates through the albedo transform, which Shade reads the extension maps with too.
		const hitTextureUV = () => {

			const baryU = shadowHit.uv.x;
			const baryV = shadowHit.uv.y;
			const baryW = float( 1.0 ).sub( baryU ).sub( baryV );
			const uvData1 = uintBitsToFloat( triangleRow( triangleBuffer, shadowHit.triangleIndex, 3 ) );
			const uvData2 = uintBitsToFloat( triangleRow( triangleBuffer, shadowHit.triangleIndex, 4 ).xy );
			const hitUV = uvData1.xy.mul( baryW ).add( uvData1.zw.mul( baryU ) ).add( uvData2.mul( baryV ) );
			return getTransformedUV( { uv: hitUV, transform: shadowMaterial.albedoTransform } );

		};

		// ---------------------------------------------------------------
		// Alpha-cutout handling (MASK / BLEND with albedo texture alpha)
		// Gated by runtime uniform + alphaMode check — zero overhead for opaque materials.
		// UV computation deferred here from BVH traversal: barycentrics stored in shadowHit.uv,
		// triangle index in shadowHit.triangleIndex. Actual UV interpolation only when needed.
		// ---------------------------------------------------------------
		const alphaCutout = tslBool( false ).toVar();

		if ( alphaShadows ) If( alphaShadows.equal( int( 1 ) ), () => {

			// Sample texture alpha once (shared by MASK and BLEND paths).
			// Deferred UV: barycentrics in shadowHit.uv, triangle index in shadowHit.triangleIndex.
			const texAlpha = float( 1.0 ).toVar();

			if ( shadowAlbedoMaps ) {

				If( shadowMaterial.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

					texAlpha.assign( sampleBucket( shadowAlbedoMaps, shadowMaterial.albedoMapIndex, hitTextureUV() ).a );

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

				If( faint(), () => {

					block();
					Break();

				} );

				alphaCutout.assign( true );

			} );

		} );

		// ---------------------------------------------------------------
		// Surface interaction: alpha-skip, transmission, transparent, or opaque
		// ---------------------------------------------------------------
		If( alphaCutout, () => {

			pass();

		} ).ElseIf( shadowMaterial.transmission.greaterThan( 0.0 ), ! glass ? () => {

			block();
			Break();

		} : () => {

			let transmission = shadowMaterial.transmission;
			if ( transmissionMaps ) {

				// glTF's transmission is the factor × the map's R: where the map is black the surface is opaque.
				transmission = transmission.toVar();
				const mapIndex = int( getDatafromStorageBuffer( materialBuffer, shadowHit.materialIndex, int( MATERIAL_SLOT.EXT_MAP_INDICES_A ), int( MATERIAL_SLOTS ) ).r ).toVar();
				If( mapIndex.greaterThanEqual( int( 0 ) ), () => {

					transmission.mulAssign( sampleBucket( linearBuckets, mapIndex, hitTextureUV() ).r );

				} );

			}

			// Deferred geometric-normal compute — refetch triangle positions and
			// derive the normal here so opaque/alpha-cutout shadow hits don't pay
			// the cross+normalize cost in BVH traversal.
			const [ pA, pB, pC ] = triangleGeoRows( triangleBuffer, shadowHit.triangleIndex ).map( ( row ) => uintBitsToFloat( row.xyz ) );
			// Positions are in the blocker's object space; the cross product is a normal, so
			// it rides the inverse-transpose back out rather than the forward matrix.
			const objNormal = normalize( cross( pB.sub( pA ), pC.sub( pA ) ) ).toVar();
			If( shadowHit.instanceLeaf.greaterThanEqual( int( 0 ) ), () => {

				objNormal.assign( normalize( instanceFaceNormalToWorld( instanceRows( bvhBuffer, shadowHit.instanceLeaf ), objNormal ) ) );

			} );

			const geomNormal = objNormal;

			const entering = dot( dir, geomNormal ).lessThan( 0.0 );
			const N = select( entering, geomNormal, geomNormal.negate() );

			// Apply absorption if exiting medium
			If( entering.not().and( shadowMaterial.attenuationDistance.greaterThan( 0.0 ) ), () => {

				transmittance.mulAssign( calculateBeerLawAbsorption(
					shadowMaterial.attenuationColor,
					shadowMaterial.attenuationDistance,
					travelled(),
				) );

			} );

			// Each face tints the light by the base colour and its map, as it tints a camera path's refraction.
			const tint = getDatafromStorageBuffer( materialBuffer, shadowHit.materialIndex, int( MATERIAL_SLOT.COLOR_METALNESS ), int( MATERIAL_SLOTS ) ).rgb.toVar();
			if ( shadowAlbedoMaps ) If( shadowMaterial.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

				tint.mulAssign( sampleBucket( shadowAlbedoMaps, shadowMaterial.albedoMapIndex, hitTextureUV() ).rgb );

			} );

			// Shadow rays go straight through, so both faces see the outside-in angle and eta.
			const fresnel = fresnelDielectric( abs( dot( dir, N ) ), max( shadowMaterial.ior, 1.0 ) );

			transmittance.mulAssign( transmissionTint( tint ).mul( float( 1.0 ).sub( fresnel ).mul( transmission ) ) );

			// Early exit if almost no light passes through
			If( faint(), () => {

				block();
				Break();

			} );

			pass();

		} ).ElseIf( shadowMaterial.transparent, () => {

			// Handle transparent materials
			transmittance.mulAssign( float( 1.0 ).sub( shadowMaterial.opacity ) );

			If( faint(), () => {

				block();
				Break();

			} );

			pass();

		} ).Else( () => {

			// Fully opaque object blocks shadow ray
			block();
			Break();

		} );

	};

	const seeThrough = usesSeeThrough( builder );

	if ( ! seeThrough ) {

		If( shadowWalk( Ray( { origin, direction: dir } ), bvhBuffer, triangleBuffer, maxDist ), () => {

			block();

		} );

	} else {

		const rayOrigin = origin.toVar();
		const remainingDist = float( maxDist ).toVar();

		const resolved = int( 0 ).toVar();

		Loop( { start: int( 0 ), end: int( SHADOW_SURFACE_BUDGET ), name: 'shadowWalks' }, () => {

			const eager = refractiveBlocks || seeThrough < 2;
			const surfaces = {
				cap: eager ? 1 : SHADOW_SURFACES, eager, alphaShadows,
				count: int( 0 ).toVar(), limit: float( remainingDist ).toVar(),
			};

			If( shadowWalk( Ray( { origin: rayOrigin, direction: dir } ), bvhBuffer, triangleBuffer, remainingDist, surfaces ), () => {

				block();
				Break();

			} );

			// Nearest first: a medium's absorption is over the distance since the surface before. `from` is where that
			// stretch starts, a step past the last surface; one within the step is skipped.
			const lastT = float( - 1.0 ).toVar();
			const lastK = int( - 1 ).toVar();
			const from = float( 0.0 ).toVar();

			Loop( { start: int( 0 ), end: surfaces.count, name: 'shadowSurface' }, () => {

				const pick = int( - 1 ).toVar();
				const pickT = float( 1e30 ).toVar();
				Loop( { start: int( 0 ), end: surfaces.count, name: 'shadowScan' }, ( { shadowScan } ) => {

					const t = intBitsToFloat( shadowSurfaceLane( surfaces, shadowScan, 2 ) ).toVar();
					const later = t.greaterThan( lastT ).or( t.equal( lastT ).and( shadowScan.greaterThan( lastK ) ) );
					If( later.and( t.lessThan( pickT ) ), () => {

						pick.assign( shadowScan );
						pickT.assign( t );

					} );

				} );
				lastT.assign( pickT );
				lastK.assign( pick );

				If( pickT.greaterThan( surfaces.limit ).or( resolved.greaterThanEqual( int( SHADOW_SURFACE_BUDGET ) ) ), () => {

					Break();

				} );

				If( pickT.lessThanEqual( from ), () => {

					Continue();

				} );

				resolved.addAssign( 1 );

				const triangleIndex = shadowSurfaceLane( surfaces, pick, 0 ).toVar();
				const hitPoint = rayOrigin.add( dir.mul( pickT ) ).toVar();

				surface( {
					triangleIndex,
					instanceLeaf: shadowSurfaceLane( surfaces, pick, 1 ).toVar(),
					uv: vec2( intBitsToFloat( shadowSurfaceLane( surfaces, pick, 3 ) ), intBitsToFloat( shadowSurfaceLane( surfaces, pick, 4 ) ) ).toVar(),
					materialIndex: int( triangleRow( triangleBuffer, triangleIndex, 4 ).z.bitAnd( uint( TRI_MATERIAL_MASK ) ) ).toVar(),
				}, () => pickT.sub( from ), () => {

					from.assign( pickT.add( max( float( 1e-5 ), length( hitPoint ).mul( 1e-6 ) ) ) );

				} );

			} );

			// A surface stopped the light, the walk reached the ray's end, or the budget is spent.
			If( faint().or( surfaces.limit.greaterThanEqual( remainingDist ) ).or( resolved.greaterThanEqual( int( SHADOW_SURFACE_BUDGET ) ) ), () => {

				Break();

			} );

			rayOrigin.addAssign( dir.mul( from ) );
			remainingDist.subAssign( from );

		} );

	}

	let light = fog ? transmittance.mul( fogTransmittance( fog, segment.from, segment.dir, segment.length ) ) : transmittance;
	if ( volumes ) {

		light = light.toVar();
		If( ( glass ? max( light.x, max( light.y, light.z ) ) : light ).greaterThan( 0.0 ), () => {

			light.mulAssign( volumeTransmittance( volumes, segment.from, segment.dir, segment.length ) );

		} );

	}

	return refractiveBlocks || glass ? light : vec3( light );

} );

export const traceShadowRay = /*@__PURE__*/ makeTraceShadowRay( false );

// For the bidirectional strategies: their light paths carry what refracts, so glass must block.
export const traceShadowRayRefractiveOpaque = /*@__PURE__*/ makeTraceShadowRay( true );

// Light tracing's ray to the camera: glass blocks, and the faces the camera would cull are passed.
export const traceShadowRayCameraCulled = /*@__PURE__*/ makeTraceShadowRay( true, traverseBVHShadowCameraCulled );

// ================================================================================
// RAY OFFSET CALCULATION
// ================================================================================

// Vector from hitPoint to its ray spawn point (offsetRayOrigin), for callers that add it themselves.
export const calculateRayOffset = Fn( ( [ hitPoint, normal ] ) => offsetRayOrigin( hitPoint, normal ).sub( hitPoint ) );

// ================================================================================
// LIGHT IMPORTANCE ESTIMATION
// ================================================================================

// A light's cosine for importance: either side for a surface that passes light through diffusely.
const importanceCosine = ( normal, direction, material ) => select(
	material.diffuseTransmission.greaterThan( 0.0 ), abs( dot( normal, direction ) ), max( float( 0.0 ), dot( normal, direction ) ),
);

export const calculateDirectionalLightImportance = Fn( ( [ light, normal, material, bounceIndex ] ) => {

	const NoL = importanceCosine( normal, light.direction, material );
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
	const NoL = importanceCosine( normal, lightDir, material );
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
		const NoL = importanceCosine( normal, lightDir, material );

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
		const NoL = importanceCosine( normal, lightDir, material );

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

