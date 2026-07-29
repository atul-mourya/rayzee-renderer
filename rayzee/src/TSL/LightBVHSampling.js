// Light BVH Sampling - GPU-side stochastic Light BVH traversal
// Single-path descent: at each inner node pick left or right proportional to power/dist²

import {
	Fn,
	vec3,
	float,
	int,
	bool as tslBool,
	If,
	Loop,
	Break,
	dot,
	sqrt,
	max,
	clamp,
	select,
	normalize,
	cross,
	length,
} from 'three/tsl';
import { MIN_PDF } from './Common.js';
import { getRandomSample1D, getRandomSample2D } from './Random.js';
import {
	EmissiveSample,
	sampleTriangle,
	interpolateNormal,
	fetchTriangleData,
	TriangleData,
	sampleSphericalTriangle,
	barycentricFromPoint,
	useSphericalSampling,
	sphericalTriangleSolidAngle,
	triangleArea,
	SphericalTriangleSampleResult,
} from './EmissiveSampling.js';

// Number of TSL structs / layout constants
const LBVH_STRIDE = 4; // 4 vec4s per node
const EMISSIVE_STRIDE = 2; // 2 vec4s per emissive entry (matches EmissiveSampling.js)
const MAX_LBVH_DEPTH = 32;

// ================================================================================
// LIGHT-BVH NODE IMPORTANCE (Conty-Estevez & Kulla 2018 / PBRT-v4 BVHLightSampler)
// ================================================================================
// cos((thetaA - thetaB) clamped to >= 0). cosA > cosB ⇒ thetaA < thetaB ⇒ diff clamped to 0.
const cosSubClamped = Fn( ( [ sinThetaA, cosThetaA, sinThetaB, cosThetaB ] ) => {

	return select( cosThetaA.greaterThan( cosThetaB ), float( 1.0 ), cosThetaA.mul( cosThetaB ).add( sinThetaA.mul( sinThetaB ) ) );

} );

// sin((thetaA - thetaB) clamped to >= 0).
const sinSubClamped = Fn( ( [ sinThetaA, cosThetaA, sinThetaB, cosThetaB ] ) => {

	return select( cosThetaA.greaterThan( cosThetaB ), float( 0.0 ), sinThetaA.mul( cosThetaB ).sub( cosThetaA.mul( sinThetaB ) ) );

} );

// Importance of a Light-BVH node for a shading point (power × orientation × inverse-square),
// θ_e = π/2 (diffuse emitters). cosThetaO = -1 ⇒ whole-sphere cone (never culled by orientation).
// SHARED by both the stochastic descent and the MIS pdf re-walk — they MUST stay byte-identical.
export const lbvhNodeImportance = Fn( ( [ nMin, power, nMax, coneAxis, cosThetaO, hitPoint ] ) => {

	const center = nMin.add( nMax ).mul( 0.5 );
	const diagLen = length( nMax.sub( nMin ) );
	const toCenter = hitPoint.sub( center );
	const d2c = max( dot( toCenter, toCenter ), float( 1e-12 ) );
	// PBRT distance clamp (note: clamps to diagLen/2, a length not a square — matches PBRT)
	const d2 = max( d2c, diagLen.mul( 0.5 ) );

	const wi = toCenter.div( sqrt( d2c ) ); // direction from cluster center to shading point
	const cosThetaW = dot( coneAxis, wi );
	const sinThetaW = sqrt( max( float( 1.0 ).sub( cosThetaW.mul( cosThetaW ) ), float( 0.0 ) ) );

	// Half-angle subtended by the cluster's bounding sphere from the shading point.
	const r2 = diagLen.mul( diagLen ).mul( 0.25 );
	const sin2ThetaB = clamp( r2.div( d2c ), float( 0.0 ), float( 1.0 ) );
	const cosThetaB = select( d2c.lessThan( r2 ), float( - 1.0 ), sqrt( max( float( 1.0 ).sub( sin2ThetaB ), float( 0.0 ) ) ) );
	const sinThetaB = sqrt( max( float( 1.0 ).sub( cosThetaB.mul( cosThetaB ) ), float( 0.0 ) ) );

	const sinThetaO = sqrt( max( float( 1.0 ).sub( cosThetaO.mul( cosThetaO ) ), float( 0.0 ) ) );

	// cosThetap = cos( (theta_w - theta_o - theta_b) clamped >= 0 )
	const cosThetaX = cosSubClamped( sinThetaW, cosThetaW, sinThetaO, cosThetaO );
	const sinThetaX = sinSubClamped( sinThetaW, cosThetaW, sinThetaO, cosThetaO );
	const cosThetap = cosSubClamped( sinThetaX, cosThetaX, sinThetaB, cosThetaB );

	// θ_e = π/2 ⇒ cosThetaE = 0; cluster cannot illuminate the point when cosThetap <= 0.
	const imp = select( cosThetap.greaterThan( float( 0.0 ) ), power.mul( cosThetap ).div( d2 ), float( 0.0 ) );
	return max( imp, float( 0.0 ) );

} );

/**
 * Sample one emissive triangle using the Light BVH for spatially-aware importance sampling.
 *
 * Tree descent:
 *   - Start at root (nodeIndex = 0)
 *   - At each inner node: pick child proportional to childPower / max(dist²_to_child_center, 0.01)
 *   - At leaf: pick one triangle proportional to its power
 *   - Accumulate selection PDF as product of per-level probabilities
 *
 * Returns an EmissiveSample struct.
 */
export const sampleLightBVHTriangle = Fn( ( [
	hitPoint, surfaceNormal,
	rngState,
	pixelCoord, resolution, frame, dimBase,
	lbvhBuffer,
	emissiveTriangleBuffer,
	emissiveVec4Offset,
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

	// Accumulated selection PDF (product of per-level choice probabilities)
	const selectionPdf = float( 1.0 ).toVar();
	const nodeIndex = int( 0 ).toVar();
	const foundLeaf = tslBool( false ).toVar();

	// Hierarchical sample warping: ONE variate recycled down the descent and into the leaf scan,
	// rescaled to [0,1) after each choice. A per-level draw has no fixed dimension to key on
	// (depth varies per pixel), so the descent — which dominates emissive-NEE variance — would
	// otherwise stay white-noise however well the point-on-triangle pair is sampled. Unbiased:
	// the rescaled value is uniform conditional on the branch taken; selectionPdf is unchanged.
	const u = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 1 ) ), rngState, resolution, frame ).toVar();

	// Tree descent: at most MAX_LBVH_DEPTH iterations
	Loop( MAX_LBVH_DEPTH, () => {

		// Read this node's data (d0 not needed during descent — only at leaf)
		const base = nodeIndex.mul( int( LBVH_STRIDE ) );
		const d1 = lbvhBuffer.element( base.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]
		const d2 = lbvhBuffer.element( base.add( int( 2 ) ) ); // [leftChild/emissiveStart, rightChild/emissiveCount, 0, 0]

		const isLeaf = d1.w.greaterThan( 0.5 );

		If( isLeaf, () => {

			foundLeaf.assign( tslBool( true ) );
			Break();

		} );

		// Inner node: compute importance for each child
		const leftChildIdx = int( d2.x );
		const rightChildIdx = int( d2.y );

		// Read left child
		const lBase = leftChildIdx.mul( int( LBVH_STRIDE ) );
		const ld0 = lbvhBuffer.element( lBase ); // [minX, minY, minZ, totalPower]
		const ld1 = lbvhBuffer.element( lBase.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]

		// Read right child
		const rBase = rightChildIdx.mul( int( LBVH_STRIDE ) );
		const rd0 = lbvhBuffer.element( rBase ); // [minX, minY, minZ, totalPower]
		const rd1 = lbvhBuffer.element( rBase.add( int( 1 ) ) ); // [maxX, maxY, maxZ, isLeaf]

		// Conty-Kulla importance: power × orientation-cone × inverse-square (shared with the MIS re-walk).
		// d3 = [coneAxis, cosThetaO]; cosThetaO = -1 ⇒ whole-sphere cone (never culled by orientation).
		const ld3 = lbvhBuffer.element( lBase.add( int( 3 ) ) );
		const rd3 = lbvhBuffer.element( rBase.add( int( 3 ) ) );
		const lImportance = lbvhNodeImportance( ld0.xyz, ld0.w, ld1.xyz, ld3.xyz, ld3.w, hitPoint );
		const rImportance = lbvhNodeImportance( rd0.xyz, rd0.w, rd1.xyz, rd3.xyz, rd3.w, hitPoint );
		const totalImportance = lImportance.add( rImportance );

		If( totalImportance.lessThanEqual( float( 0.0 ) ), () => {

			// Both importances zero — fall back to left child (no PDF update)
			nodeIndex.assign( leftChildIdx );

		} ).Else( () => {

			// Probability of choosing left child
			const pLeft = lImportance.div( totalImportance );

			If( u.lessThan( pLeft ), () => {

				// Choose left child
				u.assign( clamp( u.div( max( pLeft, float( 1e-6 ) ) ), 0.0, 0.999999 ) );
				selectionPdf.mulAssign( pLeft );
				nodeIndex.assign( leftChildIdx );

			} ).Else( () => {

				// Choose right child
				const pRight = float( 1.0 ).sub( pLeft ).toVar();
				u.assign( clamp( u.sub( pLeft ).div( max( pRight, float( 1e-6 ) ) ), 0.0, 0.999999 ) );
				selectionPdf.mulAssign( pRight );
				nodeIndex.assign( rightChildIdx );

			} );

		} );

	} );

	// If we found a leaf, sample a triangle from it
	If( foundLeaf, () => {

		const base = nodeIndex.mul( int( LBVH_STRIDE ) );
		const d0 = lbvhBuffer.element( base ); // [minX, minY, minZ, totalPower]
		const d2 = lbvhBuffer.element( base.add( int( 2 ) ) ); // [emissiveStart, emissiveCount, 0, 0]

		const emissiveStart = int( d2.x );
		const emissiveCount = int( d2.y );
		const leafTotalPower = max( d0.w, float( 1e-10 ) );

		// Sample one triangle proportional to power within the leaf
		// Linear scan: pick random threshold against cumulative power sum
		const randLeaf = u.mul( leafTotalPower );
		const cumPower = float( 0.0 ).toVar();

		// Default to last entry as fallback
		const selectedEmissiveIndex = emissiveStart.add( emissiveCount.sub( int( 1 ) ) ).toVar();
		const selectedPower = float( 1e-10 ).toVar();

		Loop( { start: int( 0 ), end: emissiveCount }, ( { i } ) => {

			const entryIdx = emissiveStart.add( i );
			const baseIdx = emissiveVec4Offset.add( entryIdx.mul( int( EMISSIVE_STRIDE ) ) );
			const emData0 = emissiveTriangleBuffer.element( baseIdx );
			const triPower = max( emData0.g, float( 0.0 ) );
			cumPower.addAssign( triPower );

			If( cumPower.greaterThanEqual( randLeaf ).and( triPower.greaterThan( float( 0.0 ) ) ), () => {

				selectedEmissiveIndex.assign( entryIdx );
				selectedPower.assign( triPower );
				Break();

			} );

		} );

		// Incorporate leaf selection PDF: selectedPower / leafTotalPower
		selectionPdf.mulAssign( selectedPower.div( leafTotalPower ) );

		// Now sample the selected triangle (same path as flat CDF sampling)
		const baseIdx = emissiveVec4Offset.add( selectedEmissiveIndex.mul( int( EMISSIVE_STRIDE ) ) );
		const emissiveData0 = emissiveTriangleBuffer.element( baseIdx );
		const emissiveData1 = emissiveTriangleBuffer.element( baseIdx.add( int( 1 ) ) );

		const triangleIndex = int( emissiveData0.r );
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

			If( sphResult.valid.and( sphResult.solidAngle.greaterThan( float( 1e-7 ) ) ), () => {

				const dir = sphResult.direction;
				const samplePos = sphResult.position;

				const surfaceFacing = dot( dir, surfaceNormal );
				const emissiveFacing = dot( dir, geoNormal.negate() );

				If( surfaceFacing.greaterThan( float( 0.0 ) ).and( emissiveFacing.greaterThan( float( 0.0 ) ) ), () => {

					// Interpolate normal at sampled point via barycentric coords
					const barycentricCoords = barycentricFromPoint( samplePos, triData.v0, triData.v1, triData.v2 );
					const sampleNormal = normalize(
						triData.n0.mul( barycentricCoords.x )
							.add( triData.n1.mul( barycentricCoords.y ) )
							.add( triData.n2.mul( barycentricCoords.z ) )
					);

					const dist = length( samplePos.sub( hitPoint ) );

					// PDF: selectionPdf / solidAngle (in solid angle measure)
					const pdfSolidAngle = selectionPdf.div( max( sphResult.solidAngle, float( 1e-10 ) ) );

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

			// ---- AREA SAMPLING (for far/small triangles) ----
			const samplePos = sampleTriangle( triData.v0, triData.v1, triData.v2, xi );
			const sampleNormal = interpolateNormal( triData.n0, triData.n1, triData.n2, xi );

			const toEmissive = samplePos.sub( hitPoint );
			const distSq = dot( toEmissive, toEmissive );
			const dist = sqrt( distSq );
			const dir = toEmissive.div( dist );

			const surfaceFacing = dot( dir, surfaceNormal );
			const emissiveFacing = dot( dir, sampleNormal.negate() );

			If( surfaceFacing.greaterThan( float( 0.0 ) ).and( emissiveFacing.greaterThan( float( 0.0 ) ) ), () => {

				// PDF: selectionPdf / area, converted to solid angle: pdfArea * distSq / cosLight
				const pdfArea = selectionPdf.div( max( area, float( 1e-10 ) ) );
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
// LIGHT-BVH MIS PDF (re-walk)
// ================================================================================
// Computes the solid-angle pdf that sampleLightBVHTriangle WOULD assign to a given emissive
// triangle hit by a BSDF bounce, by re-walking the exact stochastic descent along the triangle's
// stored bit-trail. Required so the bounce-hit MIS weight uses the SAME light pdf the NEE sampler
// used — without this the MIS partition-of-unity breaks (a real bias).
//
// lightBuffer packs [ LBVH nodes | emissive entries | bit-trail map ]. The bit-trail map holds one
// float per absolute triangleIndex (4 packed per vec4): the root→leaf left(0)/right(1) choices.
export const calculateLightBVHPdf = Fn( ( [
	triangleIndex, hitDistance, rayDir, shadingPoint,
	lightBuffer, emissiveVec4Offset, reverseMapVec4Offset, triangleBuffer,
] ) => {

	const result = float( 0.0 ).toVar();

	const triIdx = int( triangleIndex ).toVar();

	// Fetch this triangle's bit-trail (4 packed per vec4). -1 ⇒ not in the BVH (shouldn't happen on
	// an emissive hit) → leave pdf 0 (MIS falls back to BSDF-only).
	const packed = lightBuffer.element( reverseMapVec4Offset.add( triIdx.shiftRight( int( 2 ) ) ) );
	const lane = triIdx.bitAnd( int( 3 ) );
	const trailF = select( lane.equal( int( 0 ) ), packed.x,
		select( lane.equal( int( 1 ) ), packed.y,
			select( lane.equal( int( 2 ) ), packed.z, packed.w ) ) ).toVar();

	If( trailF.greaterThanEqual( float( 0.0 ) ), () => {

		const trail = int( trailF ).toVar();
		const selectionPdf = float( 1.0 ).toVar();
		const nodeIndex = int( 0 ).toVar();
		const depth = int( 0 ).toVar();
		const foundLeaf = tslBool( false ).toVar();

		Loop( MAX_LBVH_DEPTH, () => {

			const base = nodeIndex.mul( int( LBVH_STRIDE ) );
			const d1 = lightBuffer.element( base.add( int( 1 ) ) ); // [max, isLeaf]

			If( d1.w.greaterThan( 0.5 ), () => {

				foundLeaf.assign( tslBool( true ) );
				Break();

			} );

			const d2 = lightBuffer.element( base.add( int( 2 ) ) ); // [left, right]
			const leftChildIdx = int( d2.x );
			const rightChildIdx = int( d2.y );

			const lBase = leftChildIdx.mul( int( LBVH_STRIDE ) );
			const ld0 = lightBuffer.element( lBase );
			const ld1 = lightBuffer.element( lBase.add( int( 1 ) ) );
			const ld3 = lightBuffer.element( lBase.add( int( 3 ) ) );
			const rBase = rightChildIdx.mul( int( LBVH_STRIDE ) );
			const rd0 = lightBuffer.element( rBase );
			const rd1 = lightBuffer.element( rBase.add( int( 1 ) ) );
			const rd3 = lightBuffer.element( rBase.add( int( 3 ) ) );

			const lImp = lbvhNodeImportance( ld0.xyz, ld0.w, ld1.xyz, ld3.xyz, ld3.w, shadingPoint );
			const rImp = lbvhNodeImportance( rd0.xyz, rd0.w, rd1.xyz, rd3.xyz, rd3.w, shadingPoint );
			const totalImp = lImp.add( rImp );

			// Trail bit at this depth: 0 → left, 1 → right. Mirror the descent's choice logic EXACTLY.
			const goRight = trail.shiftRight( depth ).bitAnd( int( 1 ) ).equal( int( 1 ) );

			If( totalImp.lessThanEqual( float( 0.0 ) ), () => {

				// Descent forces left with no pdf update; if the trail goes right it is unreachable.
				If( goRight, () => {

					selectionPdf.assign( float( 0.0 ) );
					nodeIndex.assign( rightChildIdx );

				} ).Else( () => {

					nodeIndex.assign( leftChildIdx );

				} );

			} ).Else( () => {

				const pLeft = lImp.div( totalImp );
				If( goRight, () => {

					selectionPdf.mulAssign( float( 1.0 ).sub( pLeft ) );
					nodeIndex.assign( rightChildIdx );

				} ).Else( () => {

					selectionPdf.mulAssign( pLeft );
					nodeIndex.assign( leftChildIdx );

				} );

			} );

			depth.addAssign( int( 1 ) );

		} );

		If( foundLeaf.and( selectionPdf.greaterThan( float( 0.0 ) ) ), () => {

			// Leaf: power-weighted within-leaf selection prob for the target triangle (matches the sampler).
			const base = nodeIndex.mul( int( LBVH_STRIDE ) );
			const d0 = lightBuffer.element( base );
			const d2 = lightBuffer.element( base.add( int( 2 ) ) );
			const emissiveStart = int( d2.x );
			const emissiveCount = int( d2.y );
			const leafTotalPower = max( d0.w, float( 1e-10 ) );

			const targetPower = float( 0.0 ).toVar();
			Loop( { start: int( 0 ), end: emissiveCount }, ( { i } ) => {

				const entryIdx = emissiveStart.add( i );
				const emData0 = lightBuffer.element( emissiveVec4Offset.add( entryIdx.mul( int( EMISSIVE_STRIDE ) ) ) );
				If( int( emData0.r ).equal( triIdx ), () => {

					targetPower.assign( max( emData0.g, float( 0.0 ) ) );
					Break();

				} );

			} );

			selectionPdf.mulAssign( targetPower.div( leafTotalPower ) );

			// Convert selection pdf → solid-angle measure using the SAME heuristic as the sampler.
			const triData = TriangleData.wrap( fetchTriangleData( triIdx, triangleBuffer ) );
			If( useSphericalSampling( triData.v0, triData.v1, triData.v2, shadingPoint ), () => {

				const solidAngle = sphericalTriangleSolidAngle( triData.v0, triData.v1, triData.v2, shadingPoint );
				result.assign( selectionPdf.div( max( solidAngle, float( 1e-10 ) ) ) );

			} ).Else( () => {

				const geoNormal = normalize( cross( triData.v1.sub( triData.v0 ), triData.v2.sub( triData.v0 ) ) );
				const cosLight = max( dot( rayDir.negate(), geoNormal ), float( 0.001 ) );
				const area = triangleArea( triData.v0, triData.v1, triData.v2 );
				const distSq = hitDistance.mul( hitDistance );
				const pdfArea = selectionPdf.div( max( area, float( 1e-10 ) ) );
				result.assign( pdfArea.mul( distSq ).div( cosLight ) );

			} );

		} );

	} );

	return max( result, MIN_PDF );

} );
