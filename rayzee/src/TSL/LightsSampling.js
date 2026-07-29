/**
 * LightsSampling.js - Light Sampling and Unified Direct Lighting
 *
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Direct lighting combines:
 *  - Stochastic discrete light / BRDF selection (area, point, spot, directional)
 *  - Deterministic environment NEE (always runs, two-strategy Veach MIS with implicit miss)
 *
 * Contains:
 *  - sampleRectAreaLight              — rectangle area light sampling
 *  - sampleSpotLightWithRadius        — spot light sampling with radius
 *  - samplePointLightWithAttenuation  — point light sampling with attenuation
 *  - sampleLightWithImportance        — importance-weighted light selection (3-pass)
 *  - calculateMaterialPDF             — material PDF for MIS
 *  - calculateDirectLightingUnified   — unified direct lighting (main entry)
 */

import {
	Fn,
	float,
	vec2,
	vec3,
	int,
	bool as tslBool,
	max,
	min,
	abs,
	sqrt,
	cos,
	sin,
	tan,
	dot,
	cross,
	normalize,
	mix,
	select,
	If,
	Loop,
} from 'three/tsl';

import {
	DirectionalLight, AreaLight, PointLight, SpotLight,
	LightSample,
	LIGHT_TYPE_DIRECTIONAL,
	LIGHT_TYPE_AREA,
	LIGHT_TYPE_POINT,
	LIGHT_TYPE_SPOT,
	getDirectionalLight,
	getAreaLight,
	getPointLight,
	getSpotLight,
	isDirectionValid,
	getDistanceAttenuation,
	getSpotAttenuation,
	intersectAreaLight,
	sampleSpotGoboMask,
	sampleDirectionalGoboMask,
	sampleIESProfile,
	sampleSphQuad,
	sphQuadSolidAngle,
} from './LightsCore.js';

import { MISStrategy, DotProducts, DirectLightingDual } from './Struct.js';
import {
	calculateDirectionalLightImportance,
	estimateLightImportance,
	calculatePointLightImportance,
	calculateSpotLightImportance,
	traceShadowRay,
} from './LightsDirect.js';

import { traverseBVHShadow } from './BVHTraversal.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { calculateBSDFSamplingPDFFromMaterial } from './MaterialProperties.js';
import { getRandomSample1D, getRandomSample2D, SAMPLER_DIM_AUX_BASE } from './Random.js';
import {
	selectOptimalMISStrategy,
	PI,
	PI_INV,
	EPSILON,
	powerHeuristic,
	balanceHeuristic,
	computeDotProductsAniso,
} from './Common.js';
import {
	sampleEquirectProbability,
} from './Environment.js';

const TWO_PI = 2.0 * PI;

// =============================================================================
// Light Sampling Functions
// =============================================================================

// Blender-style area-light spread: linearly attenuates emission as the receiver
// moves off the light's axis (gridded-softbox look). cosAngle = dot(-dir, normal),
// the emission cosine. spread = π (default) → full Lambertian hemisphere, no
// attenuation. Mirrors Cycles' area_light_spread_attenuation.
export const areaLightSpreadAttenuation = Fn( ( [ cosAngle, spread ] ) => {

	const att = float( 1.0 ).toVar();

	// Only attenuate for narrowed cones; at the π default tan(π/2)=∞ → skip.
	If( spread.lessThan( float( PI ).sub( 1e-3 ) ).and( cosAngle.greaterThan( 0.0 ) ), () => {

		const halfSpread = spread.mul( 0.5 ).toVar();
		const tanHalf = tan( halfSpread ).toVar();
		const sinA = sqrt( max( float( 1.0 ).sub( cosAngle.mul( cosAngle ) ), 0.0 ) );
		const tanA = sinA.div( max( cosAngle, 1e-4 ) );
		// Flux renormalization so narrowing the beam doesn't dim total power.
		const normSpread = select(
			halfSpread.greaterThan( 0.05 ),
			float( 1.0 ).div( max( tanHalf.sub( halfSpread ), 1e-6 ) ),
			float( 3.0 ).div( max( halfSpread.mul( halfSpread ).mul( halfSpread ), 1e-9 ) ),
		);
		att.assign( max( tanHalf.sub( tanA ).mul( normSpread ), 0.0 ) );

	} );

	return att;

} );

// Emitted radiance for an area light (Blender/Cycles parity):
//   L = color · power · (1/π) · (normalize ? 1/area : 1)
// The 1/π is the Lambertian emitter normalization; the 1/area (Normalize ON)
// keeps total radiant power constant as the light is resized.
export const areaLightRadiance = Fn( ( [ light ] ) => {

	const invArea = select( light.normalize.greaterThan( 0.5 ), float( 1.0 ).div( max( light.area, 1e-10 ) ), float( 1.0 ) );
	return light.color.mul( light.intensity ).mul( PI_INV ).mul( invArea );

} );

// Area light sampling — rectangle uses spherical-rectangle (Ureña 2013)
// solid-angle sampling (pdf = 1/S); disk/ellipse and degenerate rects fall back
// to uniform-area sampling with the dist²/(area·cos) area→solid-angle pdf.
export const sampleRectAreaLight = Fn( ( [ light, rayOrigin, ruv, lightSelectionPdf ] ) => {

	// Result variables (no early return in TSL)
	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_POINT ).toVar();

	// Validate light area to prevent NaN
	If( light.area.greaterThan( 0.0 ), () => {

		const sampledPos = vec3( 0.0 ).toVar();
		// >0 → pdf already in solid-angle measure (spherical-rect); <0 → use area conversion.
		const solidAnglePdf = float( - 1.0 ).toVar();

		If( light.shape.greaterThan( 0.5 ), () => {

			// Disk / ellipse: uniform sample on the unit disk, mapped through the
			// half-vectors. PDF handled via the area→solid-angle conversion below.
			const r = sqrt( ruv.x ).toVar();
			const theta = float( TWO_PI ).mul( ruv.y ).toVar();
			sampledPos.assign(
				light.position
					.add( light.u.mul( r.mul( cos( theta ) ) ) )
					.add( light.v.mul( r.mul( sin( theta ) ) ) )
			);

		} ).Else( () => {

			// Rectangle: spherical-rectangle solid-angle sampling.
			const corner = light.position.sub( light.u ).sub( light.v );
			const ex = light.u.mul( 2.0 );
			const ey = light.v.mul( 2.0 );
			const q = sampleSphQuad( rayOrigin, corner, ex, ey, ruv ).toVar();

			If( q.w.greaterThan( 0.0 ), () => {

				sampledPos.assign( q.xyz );
				solidAnglePdf.assign( q.w );

			} ).Else( () => {

				// Degenerate / tiny solid angle → uniform-area fallback.
				sampledPos.assign(
					light.position
						.add( light.u.mul( ruv.x.mul( 2.0 ).sub( 1.0 ) ) )
						.add( light.v.mul( ruv.y.mul( 2.0 ).sub( 1.0 ) ) )
				);

			} );

		} );

		const toLight = sampledPos.sub( rayOrigin ).toVar();
		const lightDistSq = dot( toLight, toLight ).toVar();

		// Guard against zero distance
		If( lightDistSq.greaterThanEqual( 1e-10 ), () => {

			const dist = sqrt( lightDistSq ).toVar();
			const direction = toLight.div( dist ).toVar();
			const cosAngle = dot( direction.negate(), light.normal ).toVar();

			ls_lightType.assign( int( LIGHT_TYPE_AREA ) );
			ls_distance.assign( dist );
			ls_direction.assign( direction );
			ls_emission.assign( areaLightRadiance( light ).mul( areaLightSpreadAttenuation( cosAngle, light.spread ) ) );

			// Spherical-rect: pdf = 1/S (solid angle). Else: dist²/(area·cos).
			const areaPdf = lightDistSq.div( max( light.area.mul( max( cosAngle, 0.001 ) ), 1e-10 ) );
			const dirPdf = select( solidAnglePdf.greaterThan( 0.0 ), solidAnglePdf, areaPdf );
			ls_pdf.assign( dirPdf.mul( lightSelectionPdf ) );
			ls_valid.assign( cosAngle.greaterThan( 0.0 ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// Enhanced spot light sampling with radius support
export const sampleSpotLightWithRadius = Fn( ( [ light, rayOrigin, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_SPOT ).toVar();

	const toLight = light.position.sub( rayOrigin ).toVar();
	// Guard via lengthSq so the sqrt is skipped on rejected (zero-distance) samples.
	const lightDistSq = dot( toLight, toLight ).toVar();

	// Guard against zero distance
	If( lightDistSq.greaterThanEqual( 1e-20 ), () => {

		const lightDist = sqrt( lightDistSq ).toVar();
		const lightDir = toLight.div( lightDist ).toVar();

		// Check cone attenuation
		const spotCosAngle = dot( lightDir.negate(), light.direction ).toVar();
		const coneCosAngle = cos( light.angle ).toVar();

		ls_direction.assign( lightDir );
		ls_distance.assign( lightDist );
		ls_pdf.assign( lightSelectionPdf );
		ls_valid.assign( spotCosAngle.greaterThanEqual( coneCosAngle ) );

		If( ls_valid, () => {

			// Penumbra: inner cone angle = outerAngle * (1 - penumbra)
			// Clamp penumbraCosAngle > coneCosAngle to avoid smoothstep UB when penumbra = 0
			const penumbraCosAngle = cos( light.angle.mul( float( 1.0 ).sub( light.penumbra ) ) ).max( coneCosAngle.add( 1e-5 ) ).toVar();
			const coneAttenuation = getSpotAttenuation( { coneCosine: coneCosAngle, penumbraCosine: penumbraCosAngle, angleCosine: spotCosAngle } );
			const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: light.distance, decayExponent: light.decay } );

			// Gobo projection mask + IES photometric profile — both 1.0 when not assigned.
			const goboMask = sampleSpotGoboMask( light, lightDir );
			const iesProfile = sampleIESProfile( light, lightDir );

			ls_emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ).mul( coneAttenuation ).mul( goboMask ).mul( iesProfile ) );

		} );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// Enhanced point light sampling with distance attenuation
export const samplePointLightWithAttenuation = Fn( ( [ light, rayOrigin, lightSelectionPdf ] ) => {

	const ls_valid = tslBool( false ).toVar();
	const ls_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const ls_emission = vec3( 0.0 ).toVar();
	const ls_distance = float( 0.0 ).toVar();
	const ls_pdf = float( 0.0 ).toVar();
	const ls_lightType = int( LIGHT_TYPE_POINT ).toVar();

	const toLight = light.position.sub( rayOrigin ).toVar();
	// Guard via lengthSq so the sqrt is skipped on rejected (zero-distance) samples.
	const lightDistSq = dot( toLight, toLight ).toVar();

	// Guard against zero distance
	If( lightDistSq.greaterThanEqual( 1e-20 ), () => {

		const lightDist = sqrt( lightDistSq ).toVar();
		const lightDir = toLight.div( lightDist );

		// Calculate distance attenuation using the light's actual distance and decay properties
		const distanceAttenuation = getDistanceAttenuation( { lightDistance: lightDist, cutoffDistance: light.distance, decayExponent: light.decay } );

		ls_lightType.assign( int( LIGHT_TYPE_POINT ) );
		ls_direction.assign( lightDir );
		ls_distance.assign( lightDist );
		ls_emission.assign( light.color.mul( light.intensity ).mul( distanceAttenuation ) );
		ls_pdf.assign( lightSelectionPdf );
		ls_valid.assign( tslBool( true ) );

	} );

	return LightSample( {
		valid: ls_valid,
		direction: ls_direction,
		emission: ls_emission,
		distance: ls_distance,
		pdf: ls_pdf,
		lightType: ls_lightType,
	} );

} );

// =============================================================================
// Importance-Weighted Light Sampling
// =============================================================================

// Single-pass weighted-reservoir sampling: each light's importance is evaluated
// exactly once. Compared to the previous 3-pass CDF (sum-then-walk-then-sample)
// this halves the importance evaluations and storage-buffer reads per NEE call.
// Selection rule: with seen_weight = sum of weights so far, replace current
// winner with this candidate with probability w_i / seen_weight. Result is
// unbiased; PDF = winnerImportance / totalWeight, identical to the CDF form.
export const sampleLightWithImportance = Fn( ( [
	rayOrigin, normal, material, randomSeed, bounceIndex, rngState,
	pixelCoord, resolution, frame, dimBase,
	// Light buffers + counts
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
] ) => {

	// Result variables
	const r_valid = tslBool( false ).toVar();
	const r_direction = vec3( 0.0, 1.0, 0.0 ).toVar();
	const r_emission = vec3( 0.0 ).toVar();
	const r_distance = float( 0.0 ).toVar();
	const r_pdf = float( 0.0 ).toVar();
	const r_lightType = int( LIGHT_TYPE_POINT ).toVar();

	const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

	If( totalLights.greaterThan( int( 0 ) ), () => {

		const totalWeight = float( 0.0 ).toVar();

		// Reservoir state: winning light's type/index/importance.
		const selectedType = int( - 1 ).toVar(); // 0=dir, 1=area, 2=point, 3=spot
		const selectedIdx = int( - 1 ).toVar();
		const selectedImportance = float( 0.0 ).toVar();

		// =====================================================================
		// SINGLE PASS: reservoir-sample across all four light type buffers
		// =====================================================================

		If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numDirectionalLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( i.lessThan( int( 16 ) ), () => {

					const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, i ) );
					const importance = calculateDirectionalLightImportance( light, normal, material, bounceIndex ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						getRandomSample1D( pixelCoord, int( 0 ),
							int( SAMPLER_DIM_AUX_BASE + 64 + 0 * 16 ).add( i ), rngState, resolution, frame
						).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 0 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );

				} );

			} );

		} );

		If( numAreaLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( i.lessThan( int( 16 ) ), () => {

					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );
					const importance = select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, rayOrigin, normal, material ), float( 0.0 ) ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						getRandomSample1D( pixelCoord, int( 0 ),
							int( SAMPLER_DIM_AUX_BASE + 64 + 1 * 16 ).add( i ), rngState, resolution, frame
						).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 1 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );

				} );

			} );

		} );

		If( numPointLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numPointLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( i.lessThan( int( 16 ) ), () => {

					const light = PointLight.wrap( getPointLight( pointLightsBuffer, i ) );
					const importance = calculatePointLightImportance( light, rayOrigin, normal, material ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						getRandomSample1D( pixelCoord, int( 0 ),
							int( SAMPLER_DIM_AUX_BASE + 64 + 2 * 16 ).add( i ), rngState, resolution, frame
						).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 2 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );

				} );

			} );

		} );

		If( numSpotLights.greaterThan( int( 0 ) ), () => {

			Loop( { start: int( 0 ), end: numSpotLights, type: 'int', condition: '<' }, ( { i } ) => {

				If( i.lessThan( int( 16 ) ), () => {

					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, i ) );
					const importance = calculateSpotLightImportance( light, rayOrigin, normal, material ).toVar();
					totalWeight.addAssign( importance );
					If( importance.greaterThan( 0.0 ).and(
						getRandomSample1D( pixelCoord, int( 0 ),
							int( SAMPLER_DIM_AUX_BASE + 64 + 3 * 16 ).add( i ), rngState, resolution, frame
						).mul( totalWeight ).lessThan( importance )
					), () => {

						selectedType.assign( 3 );
						selectedIdx.assign( i );
						selectedImportance.assign( importance );

					} );

				} );

			} );

		} );

		// =====================================================================
		// Fallback: Uniform Sampling if no importance
		// =====================================================================

		If( totalWeight.lessThanEqual( 0.0 ), () => {

			const lightSelection = randomSeed.x.mul( float( totalLights ) );
			const selectedLight = int( lightSelection ).toVar();
			// Guard division by zero
			const lightSelectionPdf = float( 1.0 ).div( max( float( totalLights ), 1.0 ) ).toVar();

			r_pdf.assign( lightSelectionPdf );
			const sampled = tslBool( false ).toVar();
			const currentIdx = int( 0 ).toVar();

			// Directional lights fallback
			If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numDirectionalLights ) ) ), () => {

					const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const dirGoboMask = sampleDirectionalGoboMask( light, rayOrigin );
						r_direction.assign( normalize( light.direction ) );
						r_emission.assign( light.color.mul( light.intensity ).mul( dirGoboMask ) );
						r_distance.assign( 1e6 );
						r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
						r_valid.assign( tslBool( true ) );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numDirectionalLights );

			} );

			// Area lights fallback
			If( numAreaLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numAreaLights ) ) ), () => {

					const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const uv = vec2( randomSeed.y, getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 15 ) ), rngState, resolution, frame ) ).toVar();
						const areaSample = LightSample.wrap( sampleRectAreaLight( light, rayOrigin, uv, lightSelectionPdf ) );
						r_valid.assign( areaSample.valid );
						r_direction.assign( areaSample.direction );
						r_emission.assign( areaSample.emission );
						r_distance.assign( areaSample.distance );
						r_pdf.assign( areaSample.pdf );
						r_lightType.assign( areaSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numAreaLights );

			} );

			// Point lights fallback
			If( numPointLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numPointLights ) ) ), () => {

					const light = PointLight.wrap( getPointLight( pointLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const ptSample = LightSample.wrap( samplePointLightWithAttenuation( light, rayOrigin, lightSelectionPdf ) );
						r_valid.assign( ptSample.valid );
						r_direction.assign( ptSample.direction );
						r_emission.assign( ptSample.emission );
						r_distance.assign( ptSample.distance );
						r_pdf.assign( ptSample.pdf );
						r_lightType.assign( ptSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );
				currentIdx.addAssign( numPointLights );

			} );

			// Spot lights fallback
			If( numSpotLights.greaterThan( int( 0 ) ), () => {

				If( sampled.not().and( selectedLight.greaterThanEqual( currentIdx ) ).and( selectedLight.lessThan( currentIdx.add( numSpotLights ) ) ), () => {

					const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, selectedLight.sub( currentIdx ) ) );

					If( light.intensity.greaterThan( 0.0 ), () => {

						const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, lightSelectionPdf ) );
						r_valid.assign( spotSample.valid );
						r_direction.assign( spotSample.direction );
						r_emission.assign( spotSample.emission );
						r_distance.assign( spotSample.distance );
						r_pdf.assign( spotSample.pdf );
						r_lightType.assign( spotSample.lightType );
						sampled.assign( tslBool( true ) );

					} );

				} );

			} );

		} ).Else( () => {

			// =================================================================
			// Sample the reservoir-selected light. selectedType / selectedIdx /
			// selectedImportance were populated during the single-pass walk above.
			// =================================================================

			// Guard division by zero
			const pdf = selectedImportance.div( max( totalWeight, 1e-10 ) ).toVar();

			// Directional light sampling
			If( selectedType.equal( int( 0 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, selectedIdx ) );

				const direction = normalize( light.direction ).toVar();
				const dirPdf = float( 1.0 ).toVar();

				If( light.angle.greaterThan( 0.0 ), () => {

					const cosHalfAngle = cos( light.angle.mul( 0.5 ) ).toVar();
					const cosTheta = mix( cosHalfAngle, float( 1.0 ), randomSeed.y ).toVar();
					const sinTheta = sqrt( max( float( 0.0 ), float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) ).toVar();
					const phi = float( TWO_PI ).mul( getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 14 ) ), rngState, resolution, frame ) ).toVar();

					const w = normalize( light.direction ).toVar();
					const u = normalize( cross(
						select( abs( w.x ).greaterThan( 0.9 ), vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ) ),
						w
					) ).toVar();
					const v = cross( w, u ).toVar();

					direction.assign( normalize(
						w.mul( cosTheta ).add( u.mul( cos( phi ) ).add( v.mul( sin( phi ) ) ).mul( sinTheta ) )
					) );
					// Guard division: (1.0 - cosHalfAngle) could be zero if angle is 0
					const solidAngle = float( TWO_PI ).mul( max( float( 1.0 ).sub( cosHalfAngle ), 1e-10 ) );
					dirPdf.assign( float( 1.0 ).div( solidAngle ) );

				} );

				const dirGoboMask = sampleDirectionalGoboMask( light, rayOrigin );
				r_direction.assign( direction );
				r_emission.assign( light.color.mul( light.intensity ).mul( dirGoboMask ) );
				r_distance.assign( 1e6 );
				r_pdf.assign( dirPdf.mul( pdf ) );
				r_lightType.assign( int( LIGHT_TYPE_DIRECTIONAL ) );
				r_valid.assign( tslBool( true ) );

			} );

			// Area light sampling
			If( selectedType.equal( int( 1 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, selectedIdx ) );
				const uv = vec2( randomSeed.y, getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 15 ) ), rngState, resolution, frame ) ).toVar();
				const areaSample = LightSample.wrap( sampleRectAreaLight( light, rayOrigin, uv, pdf ) );
				r_valid.assign( areaSample.valid );
				r_direction.assign( areaSample.direction );
				r_emission.assign( areaSample.emission );
				r_distance.assign( areaSample.distance );
				r_pdf.assign( areaSample.pdf );
				r_lightType.assign( areaSample.lightType );

			} );

			// Point light sampling
			If( selectedType.equal( int( 2 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = PointLight.wrap( getPointLight( pointLightsBuffer, selectedIdx ) );
				const ptSample = LightSample.wrap( samplePointLightWithAttenuation( light, rayOrigin, pdf ) );
				r_valid.assign( ptSample.valid );
				r_direction.assign( ptSample.direction );
				r_emission.assign( ptSample.emission );
				r_distance.assign( ptSample.distance );
				r_pdf.assign( ptSample.pdf );
				r_lightType.assign( ptSample.lightType );

			} );

			// Spot light sampling
			If( selectedType.equal( int( 3 ) ).and( selectedIdx.greaterThanEqual( int( 0 ) ) ), () => {

				const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, selectedIdx ) );
				const spotSample = LightSample.wrap( sampleSpotLightWithRadius( light, rayOrigin, pdf ) );
				r_valid.assign( spotSample.valid );
				r_direction.assign( spotSample.direction );
				r_emission.assign( spotSample.emission );
				r_distance.assign( spotSample.distance );
				r_pdf.assign( spotSample.pdf );
				r_lightType.assign( spotSample.lightType );

			} );

		} ); // End of Else (totalWeight > 0)

	} ); // End of totalLights > 0

	return LightSample( {
		valid: r_valid,
		direction: r_direction,
		emission: r_emission,
		distance: r_distance,
		pdf: r_pdf,
		lightType: r_lightType,
	} );

} );

// =============================================================================
// Material PDF Calculation for MIS
// =============================================================================

// PDF computation given precomputed dot products. Use this when the caller
// already has dots from a paired evaluateMaterialResponseFromDots invocation
// to avoid recomputing H + dots.
// BSDF-sampling density for MIS — must be the exact function the sampler draws from, or the two
// strategies' weights stop summing to 1.
export const calculateMaterialPDFFromDots = Fn( ( [ material, dots ] ) => {

	return max( calculateBSDFSamplingPDFFromMaterial( material, dots ), 1e-8 );

} );

export const calculateMaterialPDF = Fn( ( [ viewDir, lightDir, normal, material ] ) => {

	const dots = DotProducts.wrap( computeDotProductsAniso( normal, viewDir, lightDir, material ) );
	return calculateMaterialPDFFromDots( material, dots );

} );

// Total light-selection weight at a shading point, replicating the NEE reservoir's
// importance accumulation (same per-type importance fns, same per-type 16-light cap + order).
// Used to reconstruct the exact NEE selection pdf for MIS on the BSDF-hit path —
// the analogue of Cycles' light_tree_pdf re-walk. Without it, the BSDF-hit MIS
// partner assumes uniform 1/N selection, which disagrees with the importance-
// weighted NEE selection and biases the power-heuristic weights.
export const computeTotalLightImportance = Fn( ( [
	rayOrigin, normal, material, bounceIndex,
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
] ) => {

	const totalWeight = float( 0.0 ).toVar();

	If( numDirectionalLights.greaterThan( int( 0 ) ), () => {

		Loop( { start: int( 0 ), end: numDirectionalLights, type: 'int', condition: '<' }, ( { i } ) => {

			If( i.lessThan( int( 16 ) ), () => {

				const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, i ) );
				totalWeight.addAssign( calculateDirectionalLightImportance( light, normal, material, bounceIndex ) );

			} );

		} );

	} );

	If( numAreaLights.greaterThan( int( 0 ) ), () => {

		Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

			If( i.lessThan( int( 16 ) ), () => {

				const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );
				totalWeight.addAssign( select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, rayOrigin, normal, material ), float( 0.0 ) ) );

			} );

		} );

	} );

	If( numPointLights.greaterThan( int( 0 ) ), () => {

		Loop( { start: int( 0 ), end: numPointLights, type: 'int', condition: '<' }, ( { i } ) => {

			If( i.lessThan( int( 16 ) ), () => {

				const light = PointLight.wrap( getPointLight( pointLightsBuffer, i ) );
				totalWeight.addAssign( calculatePointLightImportance( light, rayOrigin, normal, material ) );

			} );

		} );

	} );

	If( numSpotLights.greaterThan( int( 0 ) ), () => {

		Loop( { start: int( 0 ), end: numSpotLights, type: 'int', condition: '<' }, ( { i } ) => {

			If( i.lessThan( int( 16 ) ), () => {

				const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, i ) );
				totalWeight.addAssign( calculateSpotLightImportance( light, rayOrigin, normal, material ) );

			} );

		} );

	} );

	return totalWeight;

} );

// =============================================================================
// Unified Direct Lighting System
// =============================================================================

// Optimized direct lighting function with importance-based sampling and better MIS
export const calculateDirectLightingUnified = Fn( ( [
	// Surface hit data
	hitPoint, hitNormal, material,
	// View direction
	viewDir,
	// BRDF sample (DirectionSample fields)
	brdfSampleDirection, brdfSamplePdf, brdfSampleValue,
	// Tracing context
	bounceIndex, rngState,
	// Sampler context — NEE's continuous variates come off the sampler keyed on
	// (pixel, dimension, frame). dimBase is this bounce's block; see Random.js budget.
	pixelCoord, resolution, frame, dimBase,
	// Light data
	directionalLightsBuffer, numDirectionalLights,
	areaLightsBuffer, numAreaLights,
	pointLightsBuffer, numPointLights,
	spotLightsBuffer, numSpotLights,
	// Shadow ray resources
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
	// Environment resources
	envTexture, environmentIntensity, envMatrix,
	envCDFTexture,
	envTotalSum, envCompensationDelta, envResolution,
	enableEnvironmentLight,
	// Shadow catcher: when true, also accumulate the unoccluded (visibility=1) reference
	// at every light/env site so the caller can form a shadow ratio. Dead path otherwise.
	wantUnoccluded,
] ) => {

	const totalContribution = vec3( 0.0 ).toVar();
	// Unoccluded reference (visibility forced to 1) — only filled when wantUnoccluded.
	const unoccludedContribution = vec3( 0.0 ).toVar();
	const rayOrigin = hitPoint.add( hitNormal.mul( 0.001 ) ).toVar();

	// Binds BVH params so shadow-ray sites at varying call depths use a 3-arg call
	const shadow = Fn( ( [ origin, dir, maxDist ] ) =>
		traceShadowRay( origin, dir, maxDist, traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer )
	);

	// Early exit for highly emissive surfaces
	If( material.emissiveIntensity.lessThanEqual( 10.0 ), () => {

		// Adaptive MIS Strategy Selection
		const currentThroughput = vec3( 1.0 ).toVar();
		const misResult = MISStrategy.wrap( selectOptimalMISStrategy(
			material.roughness, material.metalness, bounceIndex, currentThroughput
		) );

		// Extract MIS fields to mutable variables
		// (env is handled deterministically below, not part of stochastic selection)
		const useBRDFSampling = misResult.useBRDFSampling.toVar();
		const useLightSampling = misResult.useLightSampling.toVar();
		const brdfWeight = misResult.brdfWeight.toVar();
		const lightWeight = misResult.lightWeight.toVar();

		// Adaptive light processing
		const totalLights = numDirectionalLights.add( numAreaLights ).add( numPointLights ).add( numSpotLights ).toVar();

		const importanceThreshold = float( 0.001 ).mul( float( 1.0 ).add( float( bounceIndex ).mul( 0.5 ) ) ).toVar();

		// Check if discrete lights exist
		const hasDiscreteLights = totalLights.greaterThan( int( 0 ) ).toVar();

		// Calculate total sampling weight for stochastic {lights, BRDF} selection
		const totalSamplingWeight = float( 0.0 ).toVar();

		If( useLightSampling.and( hasDiscreteLights ), () => {

			totalSamplingWeight.addAssign( lightWeight );

		} );

		If( useBRDFSampling, () => {

			totalSamplingWeight.addAssign( brdfWeight );

		} );

		If( totalSamplingWeight.lessThanEqual( 0.0 ), () => {

			totalSamplingWeight.assign( 1.0 );
			useBRDFSampling.assign( tslBool( true ) );
			brdfWeight.assign( 1.0 );

		} );

		// Determine sampling technique: stochastic {lights, BRDF}
		const rand = getRandomSample1D( pixelCoord, int( 0 ), dimBase, rngState, resolution, frame ).toVar();
		const sampleLights = tslBool( false ).toVar();
		const sampleBRDF = tslBool( false ).toVar();

		// Calculate effective weights for probability (only include light weight if lights exist)
		const effectiveLightWeight = select( hasDiscreteLights, lightWeight, float( 0.0 ) );
		// Guard division
		const invTotalSamplingWeight = float( 1.0 ).div( max( totalSamplingWeight, 1e-10 ) );
		const cumulativeLight = effectiveLightWeight.mul( invTotalSamplingWeight );

		If( rand.lessThan( cumulativeLight ).and( useLightSampling ).and( hasDiscreteLights ), () => {

			sampleLights.assign( tslBool( true ) );

		} ).ElseIf( useBRDFSampling, () => {

			sampleBRDF.assign( tslBool( true ) );

		} ).ElseIf( hasDiscreteLights, () => {

			// Fallback to light sampling only if lights exist
			sampleLights.assign( tslBool( true ) );

		} );

		// =====================================================================
		// LIGHT SAMPLING PATH
		// =====================================================================

		If( sampleLights, () => {

			// Importance-weighted light sampling
			const lightRandom = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 2 ) ), rngState, resolution, frame ).toVar();
			const lightSample = LightSample.wrap( sampleLightWithImportance(
				rayOrigin, hitNormal, material, lightRandom, bounceIndex, rngState,
				pixelCoord, resolution, frame, dimBase,
				directionalLightsBuffer, numDirectionalLights,
				areaLightsBuffer, numAreaLights,
				pointLightsBuffer, numPointLights,
				spotLightsBuffer, numSpotLights,
			) );

			If( lightSample.valid.and( lightSample.pdf.greaterThan( 0.0 ) ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, lightSample.direction ) ).toVar();
				const lightImportance = lightSample.emission.x.add( lightSample.emission.y ).add( lightSample.emission.z );

				If( NoL.greaterThan( 0.0 ).and( lightImportance.mul( NoL ).greaterThan( importanceThreshold ) ).and( isDirectionValid( { direction: lightSample.direction, surfaceNormal: hitNormal } ) ), () => {

					const shadowDistance = min( lightSample.distance.sub( 0.001 ), float( 1000.0 ) );
					const visibility = shadow( rayOrigin, lightSample.direction, shadowDistance );

					If( visibility.greaterThan( 0.0 ).or( wantUnoccluded ), () => {

						// Share H + dot products between BRDF eval and PDF — otherwise each
						// would recompute normalize(V+L) + 5 dot products independently.
						const sharedDots = DotProducts.wrap( computeDotProductsAniso( hitNormal, viewDir, lightSample.direction, material ) );
						const brdfValue = evaluateMaterialResponseFromDots( material, sharedDots );
						const bPdf = calculateMaterialPDFFromDots( material, sharedDots ).toVar();

						const misW = float( 1.0 ).toVar();

						If( bPdf.greaterThan( 0.0 ).and( useBRDFSampling ), () => {

							const lightPdfWeighted = lightSample.pdf.mul( lightWeight );
							const brdfPdfWeighted = bPdf.mul( brdfWeight );

							// Apply power heuristic only for area lights — the BRDF path can
							// intersect area lights, so both strategies contribute and MIS is valid.
							// Point/spot/directional lights are delta or non-intersectable by the
							// BRDF path, so MIS would only reduce energy without compensation.
							If( lightSample.lightType.equal( int( LIGHT_TYPE_AREA ) ), () => {

								misW.assign( powerHeuristic( { pdf1: lightPdfWeighted, pdf2: brdfPdfWeighted } ) );

							} );

						} );

						// Base contribution WITHOUT visibility; shadowed = base × visibility (identical to the
						// pre-dual-sum math), unoccluded = base × 1 (shadow-catcher reference only).
						const baseContribution = lightSample.emission.mul( brdfValue ).mul( NoL ).mul( misW ).div( max( lightSample.pdf, 1e-10 ) ).mul( totalSamplingWeight ).div( max( lightWeight, 1e-10 ) );
						totalContribution.addAssign( baseContribution.mul( visibility ) );
						If( wantUnoccluded, () => {

							unoccludedContribution.addAssign( baseContribution );

						} );

					} );

				} );

			} );

		} );

		// =====================================================================
		// BRDF SAMPLING PATH
		// =====================================================================

		If( sampleBRDF, () => {

			If( brdfSamplePdf.greaterThan( 0.0 ).and( useBRDFSampling ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, brdfSampleDirection ) ).toVar();

				If( NoL.greaterThan( 0.0 ).and( isDirectionValid( { direction: brdfSampleDirection, surfaceNormal: hitNormal } ) ), () => {

					// Check intersection with area lights
					If( numAreaLights.greaterThan( int( 0 ) ), () => {

						const foundIntersection = tslBool( false ).toVar();
						const maxImportance = float( 0.0 ).toVar();
						const maxImportanceLight = int( - 1 ).toVar();

						// Track best match (no early break)
						Loop( { start: int( 0 ), end: numAreaLights, type: 'int', condition: '<' }, ( { i } ) => {

							const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, i ) );

							If( light.intensity.greaterThan( 0.0 ), () => {

								const lightImp = estimateLightImportance( light, hitPoint, hitNormal, material ).toVar();

								If( lightImp.greaterThanEqual( importanceThreshold ), () => {

									const hitDistance = intersectAreaLight( light, rayOrigin, brdfSampleDirection ).toVar();

									If( hitDistance.greaterThan( 0.0 ), () => {

										If( lightImp.greaterThan( maxImportance ), () => {

											maxImportance.assign( lightImp );
											maxImportanceLight.assign( i );

										} );
										foundIntersection.assign( tslBool( true ) );

									} );

								} );

							} );

						} );

						If( foundIntersection.and( maxImportanceLight.greaterThanEqual( int( 0 ) ) ), () => {

							const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, maxImportanceLight ) );
							const hitDistance = intersectAreaLight( light, rayOrigin, brdfSampleDirection ).toVar();

							If( hitDistance.greaterThan( 0.0 ), () => {

								const shadowDistance = min( hitDistance.sub( 0.001 ), float( 1000.0 ) );
								const visibility = shadow( rayOrigin, brdfSampleDirection, shadowDistance );

								If( visibility.greaterThan( 0.0 ).or( wantUnoccluded ), () => {

									const lightFacing = max( float( 0.0 ), dot( brdfSampleDirection, light.normal ).negate() ).toVar();

									If( lightFacing.greaterThan( 0.0 ), () => {

										const lightDistSq = hitDistance.mul( hitDistance );

										// Directional pdf must match the NEE sampler: 1/S (spherical-rect)
										// for rectangles, dist²/(area·cos) for disk/ellipse + degenerate rects.
										const corner = light.position.sub( light.u ).sub( light.v );
										const sAngle = sphQuadSolidAngle( rayOrigin, corner, light.u.mul( 2.0 ), light.v.mul( 2.0 ) ).toVar();
										const areaPdf = lightDistSq.div( max( light.area.mul( lightFacing ), EPSILON ) );
										const dirPdf = select(
											light.shape.lessThan( 0.5 ).and( sAngle.greaterThan( 1e-5 ) ),
											float( 1.0 ).div( max( sAngle, 1e-10 ) ),
											areaPdf,
										).toVar();

										// Selection pdf consistent with the importance-weighted NEE reservoir
										// (Cycles light_tree_pdf re-walk). Falls back to uniform 1/N only when
										// total importance is zero, matching the NEE fallback.
										const selImp = estimateLightImportance( light, rayOrigin, hitNormal, material );
										const totalImp = computeTotalLightImportance(
											rayOrigin, hitNormal, material, bounceIndex,
											directionalLightsBuffer, numDirectionalLights,
											areaLightsBuffer, numAreaLights,
											pointLightsBuffer, numPointLights,
											spotLightsBuffer, numSpotLights,
										).toVar();
										const selPdf = select(
											totalImp.greaterThan( 0.0 ),
											selImp.div( max( totalImp, 1e-10 ) ),
											float( 1.0 ).div( max( float( totalLights ), 1.0 ) ),
										);
										const lightPdf = dirPdf.mul( selPdf ).toVar();

										const brdfPdfWeighted = brdfSamplePdf.mul( brdfWeight );
										const lightPdfWeighted = lightPdf.mul( lightWeight );
										const misW = powerHeuristic( { pdf1: brdfPdfWeighted, pdf2: lightPdfWeighted } ).toVar();

										const lightEmission = areaLightRadiance( light ).mul( areaLightSpreadAttenuation( lightFacing, light.spread ) );
										// Base contribution WITHOUT visibility (see discrete-light site).
										const baseContribution = lightEmission.mul( brdfSampleValue ).mul( NoL ).mul( misW ).div( max( brdfSamplePdf, 1e-10 ) ).mul( totalSamplingWeight ).div( max( brdfWeight, 1e-10 ) );
										totalContribution.addAssign( baseContribution.mul( visibility ) );
										If( wantUnoccluded, () => {

											unoccludedContribution.addAssign( baseContribution );

										} );

									} );

								} );

							} );

						} );

					} ); // End numAreaLights > 0

				} );

			} );

		} );

		// =====================================================================
		// DETERMINISTIC ENVIRONMENT NEE
		// Always runs (not stochastic) — forms a two-strategy Veach MIS
		// estimator together with the implicit miss check in the main loop.
		// =====================================================================

		If( enableEnvironmentLight, () => {

			const envRandom = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 1 ) ), rngState, resolution, frame ).toVar();
			const envColor = vec3( 0.0 ).toVar();

			// Sample direction + PDF + color from importance-sampled environment
			const envSampleResult = sampleEquirectProbability(
				envTexture, envCDFTexture,
				envMatrix, environmentIntensity, envTotalSum, envCompensationDelta, envResolution, envRandom, envColor
			).toVar();

			const envDirection = envSampleResult.xyz.toVar();
			const envPdf = envSampleResult.w.toVar();

			If( envPdf.greaterThan( 0.0 ), () => {

				const NoL = max( float( 0.0 ), dot( hitNormal, envDirection ) ).toVar();

				If( NoL.greaterThan( 0.0 ).and( isDirectionValid( { direction: envDirection, surfaceNormal: hitNormal } ) ), () => {

					const visibility = shadow( rayOrigin, envDirection, float( 1000.0 ) );

					If( visibility.greaterThan( 0.0 ).or( wantUnoccluded ), () => {

						// Share H + dots between env BRDF/PDF — same redundancy fix as the
						// discrete-light path above.
						const envDots = DotProducts.wrap( computeDotProductsAniso( hitNormal, viewDir, envDirection, material ) );
						const brdfValue = evaluateMaterialResponseFromDots( material, envDots );
						const bPdf = calculateMaterialPDFFromDots( material, envDots ).toVar();

						// Balance heuristic for env MIS — optimal for MIS-compensated PDFs (Karlík et al. 2019).
						// The implicit path uses material combinedPdf as prevBouncePdf at the miss check.
						const misW = select(
							bPdf.greaterThan( 0.0 ),
							balanceHeuristic( { pdf1: envPdf, pdf2: bPdf } ),
							float( 1.0 )
						).toVar();

						// Base contribution WITHOUT visibility (deterministic estimator; no stochastic scaling).
						const baseContribution = envColor.mul( brdfValue ).mul( NoL ).mul( misW ).div( max( envPdf, 1e-10 ) );
						totalContribution.addAssign( baseContribution.mul( visibility ) );
						If( wantUnoccluded, () => {

							unoccludedContribution.addAssign( baseContribution );

						} );

					} );

				} );

			} );

		} );

	} ); // End emissiveIntensity check

	// EMISSIVE TRIANGLE DIRECT LIGHTING
	// NOTE: Emissive triangle sampling is handled separately in pathtracer_core.fs
	// to bypass firefly suppression. Do not add it here to avoid double-counting.

	return DirectLightingDual( { shadowed: totalContribution, unoccluded: unoccludedContribution } );

} );
