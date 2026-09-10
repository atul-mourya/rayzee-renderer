// Emissive Triangle Sampling - Ported from emissive_sampling.fs
// Direct lighting from emissive triangles (next-event estimation)

import {
	Fn,
	vec3,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	dot,
	normalize,
	cross,
	length,
	max,
	sqrt,
	abs,
	clamp,
	select,
	sin,
	cos,
	acos,
	atan,
} from 'three/tsl';

import { struct } from './patches.js';
import { MIN_PDF, getDatafromStorageBuffer, powerHeuristic, MATERIAL_SLOTS, MATERIAL_SLOT, computeDotProductsAniso } from './Common.js';
import { getRandomSample1D, getRandomSample2D } from './Random.js';
import { calculateMaterialPDFFromDots } from './LightsSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { DotProducts } from './Struct.js';

// ================================================================================
// STRUCTS
// ================================================================================

export const EmissiveSample = struct( {
	position: 'vec3', // Sample point on emissive triangle
	normal: 'vec3', // Normal at sample point
	emission: 'vec3', // Emissive color * intensity
	direction: 'vec3', // Direction from hit point to sample
	distance: 'float', // Distance to emissive surface
	pdf: 'float', // Probability density
	area: 'float', // Triangle area
	cosThetaLight: 'float', // Cosine of angle on light surface
	valid: 'bool', // Whether sample is valid
} );

export const EmissiveContributionResult = struct( {
	contribution: 'vec3',
	hasEmissive: 'bool',
	emissionOnly: 'vec3', // For debug visualization
	distance: 'float', // Distance to emissive surface
} );

// ================================================================================
// HELPER FUNCTIONS
// ================================================================================

// Sample a point on a triangle using barycentric coordinates
export const sampleTriangle = Fn( ( [ v0, v1, v2, xi ] ) => {

	const sqrtU = sqrt( xi.x );
	const u = float( 1.0 ).sub( sqrtU );
	const v = xi.y.mul( sqrtU );
	const w = float( 1.0 ).sub( u ).sub( v );
	return v0.mul( u ).add( v1.mul( v ) ).add( v2.mul( w ) );

} );

// Calculate triangle area
export const triangleArea = Fn( ( [ v0, v1, v2 ] ) => {

	const edge1 = v1.sub( v0 );
	const edge2 = v2.sub( v0 );
	return length( cross( edge1, edge2 ) ).mul( 0.5 );

} );

// Compute solid angle subtended by a triangle from a point (Van Oosterom-Strackee formula)
export const sphericalTriangleSolidAngle = Fn( ( [ v0, v1, v2, p ] ) => {

	const A = normalize( v0.sub( p ) );
	const B = normalize( v1.sub( p ) );
	const C = normalize( v2.sub( p ) );

	const numerator = abs( dot( A, cross( B, C ) ) );
	const denominator = float( 1.0 ).add( dot( B, C ) ).add( dot( A, C ) ).add( dot( A, B ) );

	// atan(y, x) in TSL maps to WGSL atan2
	const solidAngle = float( 2.0 ).mul( atan( numerator, max( denominator, float( 1e-10 ) ) ) );

	return max( solidAngle, float( 0.0 ) );

} );

// Heuristic: use spherical sampling when triangle is close/large (Blender Cycles approach).
// Shared by the samplers AND the MIS pdf re-walks (EmissiveSampling + LightBVHSampling) —
// both sides MUST take the same branch or MIS partition-of-unity breaks.
export const useSphericalSampling = Fn( ( [ v0, v1, v2, hitPoint ] ) => {

	const e0 = v1.sub( v0 );
	const e1 = v2.sub( v0 );
	const e2 = v2.sub( v1 );
	const longestEdgeSq = max( dot( e0, e0 ), max( dot( e1, e1 ), dot( e2, e2 ) ) );

	const triNormal = cross( e0, e1 );
	const triNormalLenSq = dot( triNormal, triNormal );

	const result = tslBool( false ).toVar();

	If( triNormalLenSq.greaterThan( 1e-20 ), () => {

		const d = dot( triNormal, hitPoint.sub( v0 ) );
		// planeDist² = d² / |triNormal|²
		const planeDistSq = d.mul( d ).div( triNormalLenSq );

		// Sliver guard: Arvo spherical-triangle sampling is numerically unstable on
		// high-aspect slivers (NaN/garbage → colored fireflies). |triNormal|² = (2A)²
		// and 2A = longestEdge·height, so longestEdgeSq²/triNormalLenSq = (edge/height)².
		// Require aspect < 8 (64 = 8²), else fall back to stable area sampling.
		const notSliver = longestEdgeSq.mul( longestEdgeSq ).lessThan( triNormalLenSq.mul( 64.0 ) );

		result.assign( longestEdgeSq.greaterThan( planeDistSq ).and( notSliver ) );

	} );

	return result;

} );

// Arvo 1995 spherical triangle sampling struct
export const SphericalTriangleSampleResult = struct( {
	direction: 'vec3',
	position: 'vec3',
	solidAngle: 'float',
	valid: 'bool',
} );

// Safe normalize: returns zero vector instead of NaN for zero-length input
const safeNormalize = Fn( ( [ v ] ) => {

	const len = length( v );
	return select( len.greaterThan( 1e-10 ), v.div( len ), vec3( 0.0 ) );

} );

// Arvo 1995: Stratified Sampling of Spherical Triangles
// Samples a direction uniformly distributed in the solid angle subtended by a triangle
export const sampleSphericalTriangle = Fn( ( [ v0, v1, v2, hitPoint, xi ] ) => {

	const result = SphericalTriangleSampleResult( {
		direction: vec3( 0.0 ),
		position: vec3( 0.0 ),
		solidAngle: float( 0.0 ),
		valid: false,
	} ).toVar();

	// Step 1: Project triangle onto unit sphere
	const A = normalize( v0.sub( hitPoint ) );
	const B = normalize( v1.sub( hitPoint ) );
	const C = normalize( v2.sub( hitPoint ) );

	// Step 2: Compute solid angle
	const solidAngle = sphericalTriangleSolidAngle( v0, v1, v2, hitPoint );
	result.solidAngle.assign( solidAngle );

	If( solidAngle.greaterThan( 1e-7 ), () => {

		// Step 3: Compute dihedral angle alpha at vertex A
		// nAB = normal of great circle arc AB, nAC = normal of great circle arc AC
		const nAB = safeNormalize( cross( A, B ) );
		const nAC = safeNormalize( cross( A, C ) );
		const cosAlpha = clamp( dot( nAB, nAC ), - 1.0, 1.0 );
		const sinAlpha = sqrt( max( float( 1.0 ).sub( cosAlpha.mul( cosAlpha ) ), 0.0 ) );
		const alpha = acos( cosAlpha );

		// Step 4: Use u1 to select sub-triangle area
		const areaTarget = xi.x.mul( solidAngle );
		const phi = areaTarget.sub( alpha );
		const sinPhi = sin( phi );
		const cosPhi = cos( phi );

		// Cosine of arc from A to B (on unit sphere)
		const cosC = clamp( dot( A, B ), - 1.0, 1.0 );

		// Compute q (parameterizes C' on arc AC)
		const u_val = cosPhi.sub( cosAlpha );
		const v_val = sinPhi.add( sinAlpha.mul( cosC ) );

		const num = v_val.mul( cosPhi ).sub( u_val.mul( sinPhi ) ).mul( cosAlpha ).sub( v_val );
		const den = v_val.mul( sinPhi ).add( u_val.mul( cosPhi ) ).mul( sinAlpha );

		const q = clamp( select( abs( den ).greaterThan( 1e-10 ), num.div( den ), float( 1.0 ) ), - 1.0, 1.0 );

		// Step 5: Construct C' via Gram-Schmidt
		const cosB = dot( C, A );
		const cPerp = safeNormalize( C.sub( A.mul( cosB ) ) );
		const sinQ = sqrt( max( float( 1.0 ).sub( q.mul( q ) ), 0.0 ) );
		const cPrime = normalize( A.mul( q ).add( cPerp.mul( sinQ ) ) );

		// Step 6: Sample along arc B → C'
		const cosBCp = dot( cPrime, B );
		const z = float( 1.0 ).sub( xi.y.mul( float( 1.0 ).sub( cosBCp ) ) );
		const sinZ = sqrt( max( float( 1.0 ).sub( z.mul( z ) ), 0.0 ) );
		const bPerp = safeNormalize( cPrime.sub( B.mul( cosBCp ) ) );
		const w = normalize( B.mul( z ).add( bPerp.mul( sinZ ) ) );

		// Step 7: Ray-plane intersection to get surface point
		const geoNormal = normalize( cross( v1.sub( v0 ), v2.sub( v0 ) ) );
		const denom = dot( geoNormal, w );

		If( abs( denom ).greaterThan( 1e-10 ), () => {

			const t = dot( geoNormal, v0.sub( hitPoint ) ).div( denom );

			If( t.greaterThan( 0.0 ), () => {

				result.direction.assign( w );
				result.position.assign( hitPoint.add( w.mul( t ) ) );
				result.valid.assign( true );

			} );

		} );

	} );

	return result;

} );

// Compute barycentric coordinates of a point on a triangle plane (Cramer's rule)
export const barycentricFromPoint = Fn( ( [ point, v0, v1, v2 ] ) => {

	const e0 = v1.sub( v0 );
	const e1 = v2.sub( v0 );
	const d = point.sub( v0 );
	const d00 = dot( e0, e0 );
	const d01 = dot( e0, e1 );
	const d11 = dot( e1, e1 );
	const d20 = dot( d, e0 );
	const d21 = dot( d, e1 );
	const invDenom = float( 1.0 ).div( max( d00.mul( d11 ).sub( d01.mul( d01 ) ), float( 1e-10 ) ) );
	const v = d11.mul( d20 ).sub( d01.mul( d21 ) ).mul( invDenom );
	const w = d00.mul( d21 ).sub( d01.mul( d20 ) ).mul( invDenom );
	const u = float( 1.0 ).sub( v ).sub( w );
	return vec3( u, v, w );

} );

// Interpolate triangle normals using barycentric coordinates
export const interpolateNormal = Fn( ( [ n0, n1, n2, xi ] ) => {

	const sqrtU = sqrt( xi.x );
	const u = float( 1.0 ).sub( sqrtU );
	const v = xi.y.mul( sqrtU );
	const w = float( 1.0 ).sub( u ).sub( v );
	return normalize( n0.mul( u ).add( n1.mul( v ) ).add( n2.mul( w ) ) );

} );

// Check if a material is emissive
export const isEmissive = Fn( ( [ material ] ) => {

	return material.emissiveIntensity.greaterThan( 0.0 ).and( length( material.emissive ).greaterThan( 0.0 ) );

} );

// ================================================================================
// TRIANGLE DATA ACCESS
// ================================================================================

const TRI_STRIDE = 8;
const EMISSIVE_STRIDE = 2; // 2 vec4s per emissive entry

export const TriangleData = struct( {
	v0: 'vec3', v1: 'vec3', v2: 'vec3',
	n0: 'vec3', n1: 'vec3', n2: 'vec3',
	materialIndex: 'int',
} );

// Fetch triangle vertices from storage buffer
// Returns data packed in a struct-like way
export const fetchTriangleData = Fn( ( [ triangleIndex, triangleBuffer ] ) => {

	// Positions
	const pos0 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 0 ), int( TRI_STRIDE ) );
	const pos1 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 1 ), int( TRI_STRIDE ) );
	const pos2 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 2 ), int( TRI_STRIDE ) );

	// Normals
	const norm0 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 3 ), int( TRI_STRIDE ) );
	const norm1 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 4 ), int( TRI_STRIDE ) );
	const norm2 = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 5 ), int( TRI_STRIDE ) );

	// Material index (stored in last vec4)
	const uvMat = getDatafromStorageBuffer( triangleBuffer, triangleIndex, int( 7 ), int( TRI_STRIDE ) );

	// Return all data as a struct
	return TriangleData( {
		v0: pos0.xyz, v1: pos1.xyz, v2: pos2.xyz,
		n0: norm0.xyz, n1: norm1.xyz, n2: norm2.xyz,
		materialIndex: int( uvMat.z ),
	} );

} );

// Calculate light PDF for a given triangle hit (solid angle measure)
// Used by PathTracerCore for MIS weighting of bounce-hit emissive surfaces
// Uses same heuristic as sampleEmissiveTriangle for MIS consistency
export const calculateEmissiveLightPdf = Fn( ( [
	triangleIndex, hitDistance, rayDir, shadingPoint, triangleBuffer, materialBuffer, emissiveTotalPower,
] ) => {

	const triData = TriangleData.wrap( fetchTriangleData( triangleIndex, triangleBuffer ) );
	const area = triangleArea( triData.v0, triData.v1, triData.v2 );

	// Targeted material read: only fetch emissive data (2 vec4s instead of full 27)
	const matData1 = getDatafromStorageBuffer( materialBuffer, triData.materialIndex, int( MATERIAL_SLOT.EMISSIVE_ROUGHNESS ), MATERIAL_SLOTS );
	const matData2 = getDatafromStorageBuffer( materialBuffer, triData.materialIndex, int( MATERIAL_SLOT.IOR_TRANSMISSION ), MATERIAL_SLOTS );
	// Rec.709 luma — must match EmissiveTriangleBuilder's power weighting for MIS consistency.
	const luma = matData1.x.mul( 0.2126 ).add( matData1.y.mul( 0.7152 ) ).add( matData1.z.mul( 0.0722 ) );
	const power = max( luma.mul( matData2.a ).mul( area ), float( 1e-10 ) );
	const selectionPdf = power.div( max( emissiveTotalPower, float( 1e-10 ) ) );

	const result = float( 0.0 ).toVar();

	// Same heuristic as sampleEmissiveTriangle — ensures MIS consistency
	If( useSphericalSampling( triData.v0, triData.v1, triData.v2, shadingPoint ), () => {

		// Spherical: PDF = (power/totalPower) / solidAngle
		const solidAngle = sphericalTriangleSolidAngle( triData.v0, triData.v1, triData.v2, shadingPoint );
		result.assign( selectionPdf.div( max( solidAngle, float( 1e-10 ) ) ) );

	} ).Else( () => {

		// Area: PDF = (power/totalPower) / area, converted to solid angle
		const geoNormal = normalize( cross( triData.v1.sub( triData.v0 ), triData.v2.sub( triData.v0 ) ) );
		const cosLight = max( dot( rayDir.negate(), geoNormal ), 0.001 );
		const distSq = hitDistance.mul( hitDistance );
		const pdfArea = selectionPdf.div( area );
		result.assign( pdfArea.mul( distSq ).div( cosLight ) );

	} );

	return max( result, MIN_PDF );

} );

// ================================================================================
// EMISSIVE TRIANGLE SAMPLING
// ================================================================================

// Binary search in CDF for importance-weighted triangle selection
// CDF values are stored in the .b channel of the emissive buffer.
// `emissiveOffset` is the vec4-element offset into the packed light buffer
// where emissive entries start (0 if using a non-packed buffer).
const binarySearchCDF = Fn( ( [ emissiveTriangleBuffer, emissiveOffset, emissiveTriangleCount, rand ] ) => {

	const lo = int( 0 ).toVar();
	const hi = emissiveTriangleCount.sub( 1 ).toVar();

	Loop( lo.lessThan( hi ), () => {

		const mid = lo.add( hi ).div( 2 ).toVar();
		const cdfVal = emissiveTriangleBuffer.element( emissiveOffset.add( mid.mul( int( EMISSIVE_STRIDE ) ) ) ).b;

		If( cdfVal.lessThan( rand ), () => {

			lo.assign( mid.add( 1 ) );

		} ).Else( () => {

			hi.assign( mid );

		} );

	} );

	return lo;

} );

// Sample from emissive triangle index using CDF importance sampling.
// `emissiveTriangleBuffer` may be the shared packed light buffer; `emissiveVec4Offset`
// gives the vec4 offset where emissive entries begin.
export const sampleEmissiveTriangle = Fn( ( [
	hitPoint, surfaceNormal,
	rngState,
	pixelCoord, resolution, frame, dimBase,
	emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
	triangleBuffer,
] ) => {

	const result = EmissiveSample( {
		position: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		emission: vec3( 0.0 ),
		direction: vec3( 0.0 ),
		distance: float( 0.0 ),
		pdf: float( 0.0 ),
		area: float( 0.0 ),
		cosThetaLight: float( 0.0 ),
		valid: false,
	} ).toVar();

	// Check if we have emissive triangles
	If( emissiveTriangleCount.greaterThan( int( 0 ) ), () => {

		// CDF importance-weighted triangle selection (brighter triangles sampled more)
		const randEmissive = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 1 ) ), rngState, resolution, frame );
		const emissiveIndex = binarySearchCDF( emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, randEmissive ).toVar();

		// Fetch emissive triangle data from packed light buffer (2 vec4s per entry)
		// vec4[0] = (triangleIndex, power, cdf, selectionPdf)
		// vec4[1] = (emission.r, emission.g, emission.b, area)
		const baseIdx = emissiveVec4Offset.add( emissiveIndex.mul( int( EMISSIVE_STRIDE ) ) );
		const emissiveData0 = emissiveTriangleBuffer.element( baseIdx );
		const emissiveData1 = emissiveTriangleBuffer.element( baseIdx.add( 1 ) );
		const triangleIndex = int( emissiveData0.r );
		const samplePower = max( emissiveData0.g, float( 1e-10 ) );
		const emission = emissiveData1.xyz;
		const area = emissiveData1.w;

		// Fetch triangle geometry
		const triData = TriangleData.wrap( fetchTriangleData( triangleIndex, triangleBuffer ) );

		const xi = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 3 ) ), rngState, resolution, frame ).toVar();

		const geoNormal = normalize( cross( triData.v1.sub( triData.v0 ), triData.v2.sub( triData.v0 ) ) );

		// Heuristic: spherical sampling for close/large triangles, area for far/small
		If( useSphericalSampling( triData.v0, triData.v1, triData.v2, hitPoint ), () => {

			// ---- SPHERICAL TRIANGLE SAMPLING (Arvo 1995) ----
			const sphResult = SphericalTriangleSampleResult.wrap(
				sampleSphericalTriangle( triData.v0, triData.v1, triData.v2, hitPoint, xi )
			);

			If( sphResult.valid.and( sphResult.solidAngle.greaterThan( 1e-7 ) ), () => {

				const dir = sphResult.direction;
				const samplePos = sphResult.position;

				const surfaceFacing = dot( dir, surfaceNormal );
				const emissiveFacing = dot( dir, geoNormal.negate() );

				If( surfaceFacing.greaterThan( 0.0 ).and( emissiveFacing.greaterThan( 0.0 ) ), () => {

					// Interpolate normal at sampled point via barycentric coords
					const bary = barycentricFromPoint( samplePos, triData.v0, triData.v1, triData.v2 );
					const sampleNormal = normalize(
						triData.n0.mul( bary.x ).add( triData.n1.mul( bary.y ) ).add( triData.n2.mul( bary.z ) )
					);

					const dist = length( samplePos.sub( hitPoint ) );

					// PDF: CDF selection (power/totalPower) * uniform solid angle (1/solidAngle)
					const pdfSolidAngle = samplePower
						.div( max( emissiveTotalPower, float( 1e-10 ) ) )
						.div( sphResult.solidAngle );

					result.position.assign( samplePos );
					result.normal.assign( sampleNormal );
					result.emission.assign( emission );
					result.direction.assign( dir );
					result.distance.assign( dist );
					result.pdf.assign( max( pdfSolidAngle, MIN_PDF ) );
					result.area.assign( area );
					result.cosThetaLight.assign( emissiveFacing );
					result.valid.assign( true );

				} );

			} );

		} ).Else( () => {

			// ---- AREA SAMPLING (existing, for far/small triangles) ----
			const samplePos = sampleTriangle( triData.v0, triData.v1, triData.v2, xi );
			const sampleNormal = interpolateNormal( triData.n0, triData.n1, triData.n2, xi );

			const toEmissive = samplePos.sub( hitPoint );
			const distSq = dot( toEmissive, toEmissive );
			const dist = sqrt( distSq );
			const dir = toEmissive.div( dist );

			const surfaceFacing = dot( dir, surfaceNormal );
			const emissiveFacing = dot( dir, sampleNormal.negate() );

			If( surfaceFacing.greaterThan( 0.0 ).and( emissiveFacing.greaterThan( 0.0 ) ), () => {

				// PDF: CDF selection (power/totalPower) * uniform area (1/area)
				// Converted to solid angle: pdfArea * distSq / cosLight
				const pdfArea = samplePower.div( max( emissiveTotalPower, float( 1e-10 ) ).mul( area ) );
				const pdfSolidAngle = pdfArea.mul( distSq ).div( emissiveFacing );

				result.position.assign( samplePos );
				result.normal.assign( sampleNormal );
				result.emission.assign( emission );
				result.direction.assign( dir );
				result.distance.assign( dist );
				result.pdf.assign( max( pdfSolidAngle, MIN_PDF ) );
				result.area.assign( area );
				result.cosThetaLight.assign( emissiveFacing );
				result.valid.assign( true );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// EMISSIVE TRIANGLE DIRECT LIGHTING CONTRIBUTION
// ================================================================================

// Note: traceShadowRay and calculateRayOffset are passed as Fn parameters to
// avoid a circular module dependency. BRDF evaluation no longer goes through a
// callback — we import the FromDots variant directly so we can share dot
// products with the PDF call below.

export const calculateEmissiveTriangleContributionDebug = Fn( ( [
	hitPoint, normal, geomNormal, viewDir, material,
	bounceIndex, rngState,
	pixelCoord, resolution, frame, dimBase,
	emissiveBoost,
	emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
	triangleBuffer,
	// Callback functions to avoid circular deps
	traceShadowRayFn,
	calculateRayOffsetFn,
] ) => {

	const result = EmissiveContributionResult( {
		contribution: vec3( 0.0 ),
		hasEmissive: false,
		emissionOnly: vec3( 0.0 ),
		distance: float( 0.0 ),
	} ).toVar();

	// No rough-diffuse secondary-bounce skip: dropping NEE while the emissive-hit MIS still
	// down-weights BSDF hits deletes emitter energy from deep GI.

	// Sample emissive triangle (CDF importance-weighted)
	const emissiveSample = EmissiveSample.wrap( sampleEmissiveTriangle(
		hitPoint, normal, rngState,
		pixelCoord, resolution, frame, dimBase,
		emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
		triangleBuffer,
	) );

	If( emissiveSample.valid.and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

		result.hasEmissive.assign( true );
		result.emissionOnly.assign( emissiveSample.emission );
		result.distance.assign( emissiveSample.distance );

		// Check geometric validity
		const NoL = max( float( 0.0 ), dot( normal, emissiveSample.direction ) );

		If( NoL.greaterThan( 0.0 ).and( dot( emissiveSample.direction, geomNormal ).greaterThan( 0.0 ) ), () => {

			// Calculate ray offset for shadow ray
			const rayOffset = calculateRayOffsetFn( hitPoint, geomNormal, material );
			const rayOrigin = hitPoint.add( rayOffset );

			// Trace shadow ray
			const shadowDist = emissiveSample.distance.sub( 0.001 );
			const visibility = traceShadowRayFn( rayOrigin, emissiveSample.direction, shadowDist );

			If( visibility.greaterThan( 0.0 ), () => {

				// Share H + dot products between BRDF eval and PDF (computeDotProducts
				// would otherwise run twice with identical inputs).
				const dots = DotProducts.wrap( computeDotProductsAniso( normal, viewDir, emissiveSample.direction, material ) );
				const brdfValue = evaluateMaterialResponseFromDots( material, dots );
				const brdfPdf = calculateMaterialPDFFromDots( material, dots );

				// MIS weight: balance light sampling vs BRDF sampling
				const misWeight = select(
					brdfPdf.greaterThan( 0.0 ),
					powerHeuristic( { pdf1: emissiveSample.pdf, pdf2: brdfPdf } ),
					float( 1.0 )
				);

				// MC estimator: Le * brdf * cos_surface / pdf_solidAngle
				// emissiveBoost is an additional user-controlled intensity multiplier
				result.contribution.assign(
					emissiveSample.emission.mul( brdfValue ).mul( NoL )
						.div( emissiveSample.pdf ).mul( visibility ).mul( emissiveBoost ).mul( misWeight )
				);

			} );

		} );

	} );

	return result;

} );

// Wrapper that returns just the contribution vec3
export const calculateEmissiveTriangleContribution = Fn( ( [
	hitPoint, normal, geomNormal, viewDir, material,
	bounceIndex, rngState,
	pixelCoord, resolution, frame, dimBase,
	emissiveBoost,
	emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
	triangleBuffer,
	traceShadowRayFn,
	calculateRayOffsetFn,
] ) => {

	const result = EmissiveContributionResult.wrap( calculateEmissiveTriangleContributionDebug(
		hitPoint, normal, geomNormal, viewDir, material,
		bounceIndex, rngState,
		pixelCoord, resolution, frame, dimBase,
		emissiveBoost,
		emissiveTriangleBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
		triangleBuffer,
		traceShadowRayFn,
		calculateRayOffsetFn,
	) );
	return result.contribution;

} );
