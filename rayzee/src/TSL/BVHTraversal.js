import {
	Fn,
	wgslFn,
	vec3,
	vec2,
	float,
	int,
	If,
	Loop,
	Break,
	select,
	abs,
	sign,
	min,
	normalize,
	mix,
	notEqual,
	lessThan,
	array,
	bool as tslBool,
} from 'three/tsl';

import { HitInfo } from './Struct.js';
import { getDatafromStorageBuffer } from './Common.js';

const MAX_STACK_DEPTH = 32;
const MAX_BVH_ITERATIONS = 512;
const BVH_STRIDE = 4;
const TRI_STRIDE = 8;
const HUGE_VAL = 1e8;

// Per-mesh visibility is now packed into the TLAS BLAS-pointer leaf's slot [2]
// by TLASBuilder.flatten() — eliminates the dedicated meshVisibility storage buffer.

// ================================================================================
// STACK HELPERS (Native WGSL array via TSL ArrayNode)
// ================================================================================

const createStack = () => array( 'int', MAX_STACK_DEPTH ).toVar();

// ================================================================================
// RAY INTERSECTION HELPERS (inlined for BVH traversal performance)
// ================================================================================

// Woop watertight intersection (Woop/Benthin/Wald 2013). Eliminates edge leakage
// at shared triangle edges that Möller-Trumbore exhibits under FP32. Per-ray shears
// are precomputed once via computeWoopRayParams; per-triangle test is FMA-friendly
// and uses sign-aware depth comparison so it works for any det orientation.
const RayTriangleGeometry = wgslFn( `
	fn RayTriangleGeometry( rayOrigin: vec3f, rayDir: vec3f, pA: vec3f, pB: vec3f, pC: vec3f, closestHitDst: f32, woopParams: vec4f ) -> vec4f {

		// Returns vec4(t, u, v, hit) where hit > 0.5 means intersection.
		// woopParams: (Sx, Sy, Sz, bitcast<f32>(packed kx|ky<<2|kz<<4))
		var result = vec4f( 1e20f, 0.0f, 0.0f, 0.0f );

		let Sx = woopParams.x;
		let Sy = woopParams.y;
		let Sz = woopParams.z;
		// Packed as regular f32 (values 0–42), not bitcast — avoids subnormal FTZ on Apple GPUs.
		let packed = i32( woopParams.w );
		let kx = packed & 3;
		let ky = ( packed >> 2 ) & 3;
		let kz = ( packed >> 4 ) & 3;

		let A = pA - rayOrigin;
		let B = pB - rayOrigin;
		let C = pC - rayOrigin;

		let Akz = A[ kz ];
		let Bkz = B[ kz ];
		let Ckz = C[ kz ];

		let Ax = A[ kx ] - Sx * Akz;
		let Ay = A[ ky ] - Sy * Akz;
		let Bx = B[ kx ] - Sx * Bkz;
		let By = B[ ky ] - Sy * Bkz;
		let Cx = C[ kx ] - Sx * Ckz;
		let Cy = C[ ky ] - Sy * Ckz;

		// Edge function tests — all three must share sign (or be exactly zero) for hit.
		let U = Cx * By - Cy * Bx;
		let V = Ax * Cy - Ay * Cx;
		let W = Bx * Ay - By * Ax;

		let neg = U < 0.0f || V < 0.0f || W < 0.0f;
		let pos = U > 0.0f || V > 0.0f || W > 0.0f;
		if ( !( neg && pos ) ) {

			let det = U + V + W;
			if ( det != 0.0f ) {

				let T = U * ( Sz * Akz ) + V * ( Sz * Bkz ) + W * ( Sz * Ckz );

				// Sign-aware bounds check on t (multiply both sides by sign(det) once).
				let detSign = select( -1.0f, 1.0f, det > 0.0f );
				let tSigned = T * detSign;
				let detAbs = abs( det );

				if ( tSigned > 0.0f && tSigned < closestHitDst * detAbs ) {

					// Match Möller-Trumbore convention: u = weight of B, v = weight of C.
					// In Woop's edge functions, U → weight of A, V → weight of B, W → weight of C.
					let invDet = 1.0f / det;
					result = vec4f( T * invDet, V * invDet, W * invDet, 1.0f );

				}

			}

		}

		return result;

	}
` );

// Compute Woop ray-space transform (Woop 2013, §3.1) — runs once per ray and
// amortizes across hundreds of triangle tests. Returns Sx/Sy/Sz shears plus the
// permuted axis indices packed via bitcast into the .w slot.
const computeWoopRayParams = wgslFn( `
	fn computeWoopRayParams( rayDir: vec3f ) -> vec4f {

		let absDir = abs( rayDir );

		// kz = argmax(|dir|)
		var kz: i32 = 0;
		if ( absDir.y >= absDir.x ) { kz = 1; }
		if ( absDir.z >= absDir[ u32( kz ) ] ) { kz = 2; }

		var kx: i32 = ( kz + 1 ) % 3;
		var ky: i32 = ( kx + 1 ) % 3;

		// Preserve triangle winding when the dominant axis component is negative.
		if ( rayDir[ u32( kz ) ] < 0.0f ) {
			let tmp = kx;
			kx = ky;
			ky = tmp;
		}

		let dz = rayDir[ u32( kz ) ];
		let Sx = rayDir[ u32( kx ) ] / dz;
		let Sy = rayDir[ u32( ky ) ] / dz;
		let Sz = 1.0f / dz;

		let packed = kx | ( ky << 2 ) | ( kz << 4 );
		return vec4f( Sx, Sy, Sz, f32( packed ) );

	}
` );

const fastRayAABBDst = wgslFn( `
	fn fastRayAABBDst( rayOrigin: vec3f, invDir: vec3f, boxMin: vec3f, boxMax: vec3f ) -> f32 {

		let t1 = ( boxMin - rayOrigin ) * invDir;
		let t2 = ( boxMax - rayOrigin ) * invDir;

		let tmin = min( t1, t2 );
		let tmax = max( t1, t2 );

		let tNear = max( max( tmin.x, tmin.y ), tmin.z );
		let tFar = min( min( tmax.x, tmax.y ), tmax.z ) * 1.00000024f; // Robust traversal: 2 ULP padding (Ize 2013)

		let isHit = tNear <= tFar && tFar > 0.0f;
		return select( 1e20f, max( tNear, 0.0f ), isHit );

	}
` );

// ================================================================================
// MAIN BVH TRAVERSAL
// ================================================================================
// Side culling is performed inline inside traverseBVH/traverseBVHShadow using
// the per-triangle side flag stored in normalCData.w (slot 5, .w channel).

// Factory: the boxTests/triTests debug counters are compiled OUT of the hot closest-hit
// path (extend/normalDepth use traverseBVH = trackStats false) — only the debug viz reads
// them, and keeping them live across the traversal loop costs registers/occupancy.
const makeTraverseBVH = ( trackStats ) => Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	insideMedium, // optional: when true (ray inside a medium), bypass front/back culling
] ) => {

	// Interior medium rays (SSS/transmission) must be able to hit boundary faces from
	// either side to find the exit; exterior rays honor the authored side as before.
	const inMedium = insideMedium ?? tslBool( false );

	const closestHit = HitInfo( {
		didHit: false,
		dst: float( 1e20 ),
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	// Deferred attribute fetch: store closest triIndex + barycentrics during traversal,
	// compute hitPoint and UVs once after the loop
	const closestTriIdx = int( - 1 ).toVar();
	const closestU = float( 0.0 ).toVar();
	const closestV = float( 0.0 ).toVar();

	// Stack (native WGSL array — O(1) read/write)
	const stack = createStack();
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) ); // Root node

	// Compact axis-aligned ray handling with correct sign preservation
	const dirSign = mix( vec3( 1.0 ), sign( ray.direction ), notEqual( ray.direction, vec3( 0.0 ) ) );
	const invDir = mix(
		vec3( 1.0 ).div( ray.direction ),
		vec3( HUGE_VAL ).mul( dirSign ),
		lessThan( abs( ray.direction ), vec3( 1e-8 ) )
	).toVar();

	const rayOrigin = ray.origin;
	const rayDirection = ray.direction;

	// Woop watertight intersection: precompute per-ray shears + axis permutation.
	const woopParams = computeWoopRayParams( { rayDir: rayDirection } ).toVar();

	const iterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( iterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		iterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stack.element( stackPtr ).toVar();

		// New layout: 4 vec4 per node
		// Leaf: vec4(0) = [triOffset, triCount, 0, -1]
		// Inner: vec4(0) = [leftMin.xyz, leftChild], vec4(1) = [leftMax.xyz, rightChild],
		//        vec4(2) = [rightMin.xyz, 0], vec4(3) = [rightMax.xyz, 0]
		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );
		if ( trackStats ) closestHit.boxTests.addAssign( 1 );

		If( nodeData0.w.lessThan( 0.0 ), () => {

			// Leaf node — distinguish triangle leaf (-1) from BLAS-pointer leaf (-2)
			If( nodeData0.w.greaterThan( float( - 1.5 ) ), () => {

				// Triangle leaf (marker -1) — triOffset and triCount packed in vec4(0).xy
				const triStart = int( nodeData0.x ).toVar();
				const triCount = int( nodeData0.y ).toVar();

				// Process triangles in leaf
				Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

					if ( trackStats ) closestHit.triTests.addAssign( 1 );
					const triIndex = triStart.add( i ).toVar();

					// Fetch geometry first (3 fetches from storage buffer)
					const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
					const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
					const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

					const triResult = RayTriangleGeometry( { rayOrigin, rayDir: rayDirection, pA, pB, pC, closestHitDst: closestHit.dst, woopParams } );

					// RayTriangleGeometry already guarantees t < closestHit.dst when w > 0.5
					If( triResult.w.greaterThan( 0.5 ), () => {

						const t = triResult.x;
						const u = triResult.y;
						const v = triResult.z;

						// Fetch normals for side-culling (3 reads). Slot 7 (uvData2,
						// carries matIdx + meshIndex) is deferred to post-traversal —
						// it's only needed for the one winning triangle, not per candidate.
						// normalCData.w carries the per-triangle side flag (0/1/2).
						const nA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 3 ), int( TRI_STRIDE ) ).xyz;
						const nB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 4 ), int( TRI_STRIDE ) ).xyz;
						const normalCData = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 5 ), int( TRI_STRIDE ) );
						const nC = normalCData.xyz;
						const side = int( normalCData.w ).toVar();

						// Interpolate normal for the side-culling dot product (kept local,
						// not stored on closestHit — re-derived post-loop from closestTriIdx).
						const w = float( 1.0 ).sub( u ).sub( v );
						const rayDotNormal = rayDirection.dot(
							normalize( nA.mul( w ).add( nB.mul( u ) ).add( nC.mul( v ) ) )
						);

						// Side culling (inline; per-mesh visibility is at the BLAS-pointer level).
						// 0=front (reject back-facing), 1=back (reject front-facing), 2=double (pass).
						const sidePass = inMedium.or( side.equal( int( 2 ) ) )
							.or( side.equal( int( 0 ) ).and( rayDotNormal.lessThan( - 0.0001 ) ) )
							.or( side.equal( int( 1 ) ).and( rayDotNormal.greaterThan( 0.0001 ) ) );
						If( sidePass, () => {

							closestHit.didHit.assign( true );
							closestHit.dst.assign( t );

							// Defer normal/materialIndex/meshIndex/hitPoint/UV to post-traversal
							// (all re-derived from closestTriIdx after the loop exits).
							closestTriIdx.assign( triIndex );
							closestU.assign( u );
							closestV.assign( v );

						} );

					} );

				} );

				// If we found a very close hit, we can terminate early
				If( closestHit.didHit.and( closestHit.dst.lessThan( 0.001 ) ), () => {

					Break();

				} );

			} ).Else( () => {

				// BLAS-pointer leaf (marker -2) — push BLAS root onto stack if mesh is visible
				// nodeData0: [blasRootNodeIndex, meshIndex, visibility, -2]
				// Visibility is free-fetched with the leaf — no extra storage read.
				If( nodeData0.z.greaterThan( 0.5 ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( int( nodeData0.x ) );
					stackPtr.addAssign( 1 );

				} );

			} );

		} ).Else( () => {

			// Inner node — child AABBs stored in this node (4 reads total, no child fetches)
			const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );
			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const nodeData3 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 3 ), int( BVH_STRIDE ) );

			const leftChild = int( nodeData0.w ).toVar();
			const rightChild = int( nodeData1.w ).toVar();

			const dstA = fastRayAABBDst( { rayOrigin, invDir, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
			const dstB = fastRayAABBDst( { rayOrigin, invDir, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

			// Optimized early rejection
			const minDst = min( dstA, dstB );
			If( minDst.lessThan( closestHit.dst ), () => {

				// Improved node ordering with fewer conditionals
				const aCloser = dstA.lessThan( dstB );

				// Push far child first (processed last)
				If( select( aCloser, dstB, dstA ).lessThan( closestHit.dst ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( select( aCloser, rightChild, leftChild ) );
					stackPtr.addAssign( 1 );

				} );

				// Push near child second (processed first)
				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stack.element( stackPtr ).assign( select( aCloser, leftChild, rightChild ) );
					stackPtr.addAssign( 1 );

				} );

			} );

		} );

	} );

	// Deferred: compute normal, hitPoint, UVs, and fetch matIdx/meshIndex once for the final closest hit
	If( closestHit.didHit, () => {

		closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( closestHit.dst ) ) );

		const w = float( 1.0 ).sub( closestU ).sub( closestV );

		// Re-fetch the winning triangle's normals — trading 3 storage reads (once)
		// for ~3 regs freed across every BVH iteration.
		const nA = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 3 ), int( TRI_STRIDE ) ).xyz;
		const nB = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 4 ), int( TRI_STRIDE ) ).xyz;
		const nC = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 5 ), int( TRI_STRIDE ) ).xyz;
		closestHit.normal.assign( normalize( nA.mul( w ).add( nB.mul( closestU ) ).add( nC.mul( closestV ) ) ) );

		const uvData1 = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 6 ), int( TRI_STRIDE ) );
		const uvData2 = getDatafromStorageBuffer( triangleBuffer, closestTriIdx, int( 7 ), int( TRI_STRIDE ) );
		closestHit.uv.assign(
			uvData1.xy.mul( w ).add( uvData1.zw.mul( closestU ) ).add( uvData2.xy.mul( closestV ) )
		);
		closestHit.materialIndex.assign( int( uvData2.z ) );
		closestHit.meshIndex.assign( int( uvData2.w ) );
		closestHit.triangleIndex.assign( closestTriIdx );

	} );

	return closestHit;

} );

// Hot path (extend/normalDepth): no debug counters. Debug viz uses traverseBVHDebug.
export const traverseBVH = /*@__PURE__*/ makeTraverseBVH( false );
export const traverseBVHDebug = /*@__PURE__*/ makeTraverseBVH( true );

// ================================================================================
// SHADOW RAY TRAVERSAL (OPTIMIZED - early exit on any hit)
// ================================================================================

export const traverseBVHShadow = Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	maxShadowDist,
] ) => {

	const closestHit = HitInfo( {
		didHit: false,
		dst: maxShadowDist,
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	const stack = createStack();
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) );

	const dirSign = mix( vec3( 1.0 ), sign( ray.direction ), notEqual( ray.direction, vec3( 0.0 ) ) );
	const invDir = mix(
		vec3( 1.0 ).div( ray.direction ),
		vec3( HUGE_VAL ).mul( dirSign ),
		lessThan( abs( ray.direction ), vec3( 1e-8 ) )
	).toVar();

	// Woop watertight intersection: precompute per-ray shears + axis permutation.
	const woopParams = computeWoopRayParams( { rayDir: ray.direction } ).toVar();

	const sIterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( closestHit.didHit.not() ).and( sIterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		sIterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const nodeIndex = stack.element( stackPtr ).toVar();

		const nodeData0 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 0 ), int( BVH_STRIDE ) );

		If( nodeData0.w.lessThan( 0.0 ), () => {

			// Leaf node — distinguish triangle leaf (-1) from BLAS-pointer leaf (-2)
			If( nodeData0.w.greaterThan( float( - 1.5 ) ), () => {

				// Triangle leaf (marker -1) — triOffset and triCount packed in vec4(0).xy
				const triStart = int( nodeData0.x ).toVar();
				const triCount = int( nodeData0.y ).toVar();

				Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

					const triIndex = triStart.add( i ).toVar();

					const pA = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 0 ), int( TRI_STRIDE ) ).xyz;
					const pB = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 1 ), int( TRI_STRIDE ) ).xyz;
					const pC = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 2 ), int( TRI_STRIDE ) ).xyz;

					const triResult = RayTriangleGeometry( { rayOrigin: ray.origin, rayDir: ray.direction, pA, pB, pC, closestHitDst: closestHit.dst, woopParams } );

					If( triResult.w.greaterThan( 0.5 ), () => {

						// Per-mesh visibility handled at BLAS-pointer level — accept any hit
						const uvData2 = getDatafromStorageBuffer( triangleBuffer, triIndex, int( 7 ), int( TRI_STRIDE ) );

						closestHit.didHit.assign( true );
						closestHit.dst.assign( triResult.x );
						closestHit.materialIndex.assign( int( uvData2.z ) );
						closestHit.meshIndex.assign( int( uvData2.w ) );

						// Hit point is cheap (origin + dir*t). Geometric normal is deferred
						// to traceShadowRay — only the transmission branch needs it, so we
						// skip the cross+normalize for the (much more common) opaque-blocker
						// and alpha-cutout paths. Normal stays vec3(0) from struct init.
						closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( triResult.x ) ) );

						// Store barycentrics + triangle index for deferred UV computation.
						// Actual UV interpolation happens in traceShadowRay only when
						// the material needs alpha testing — zero overhead for opaque hits.
						closestHit.uv.assign( vec2( triResult.y, triResult.z ) );
						closestHit.triangleIndex.assign( triIndex );

						// Shadow ray only needs any hit — skip remaining triangles in leaf
						Break();

					} );

				} );

			} ).Else( () => {

				// BLAS-pointer leaf (marker -2) — push BLAS root onto stack if mesh is visible
				// nodeData0: [blasRootNodeIndex, meshIndex, visibility, -2]
				If( nodeData0.z.greaterThan( 0.5 ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( int( nodeData0.x ) );
					stackPtr.addAssign( 1 );

				} );

			} );

		} ).Else( () => {

			// Inner node — child AABBs stored in this node
			const nodeData1 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 1 ), int( BVH_STRIDE ) );
			const nodeData2 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 2 ), int( BVH_STRIDE ) );
			const nodeData3 = getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( 3 ), int( BVH_STRIDE ) );

			const leftChild = int( nodeData0.w ).toVar();
			const rightChild = int( nodeData1.w ).toVar();

			const dstA = fastRayAABBDst( { rayOrigin: ray.origin, invDir, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
			const dstB = fastRayAABBDst( { rayOrigin: ray.origin, invDir, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

			// Distance-ordered traversal — nearer child first for faster any-hit
			// termination. SA build ordering improves cache locality (larger-SA
			// child = left = first in DFS flat layout).
			const minDst = min( dstA, dstB );
			If( minDst.lessThan( closestHit.dst ), () => {

				const aCloser = dstA.lessThan( dstB );

				// Push far child first (processed last)
				If( select( aCloser, dstB, dstA ).lessThan( closestHit.dst ).and( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ) ), () => {

					stack.element( stackPtr ).assign( select( aCloser, rightChild, leftChild ) );
					stackPtr.addAssign( 1 );

				} );

				// Push near child second (processed first)
				If( stackPtr.lessThan( int( MAX_STACK_DEPTH ) ), () => {

					stack.element( stackPtr ).assign( select( aCloser, leftChild, rightChild ) );
					stackPtr.addAssign( 1 );

				} );

			} );

		} );

	} );

	return closestHit;

} );
