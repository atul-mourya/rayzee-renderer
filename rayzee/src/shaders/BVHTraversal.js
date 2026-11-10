import { sceneResources } from './SceneResources.js';
import {
	Fn,
	wgslFn,
	vec3,
	vec4,
	vec2,
	float,
	int,
	If,
	Loop,
	Break,
	Continue,
	select,
	abs,
	sign,
	min,
	normalize,
	mix,
	notEqual,
	lessThan,
	array,
	uint,
	uvec3,
	uintBitsToFloat,
	floatBitsToUint,
	bool as tslBool,
} from 'three/tsl';

import {
	TRI_MATERIAL_MASK, TRI_SIDE_SHIFT, TRI_EMIT_SIDE_SHIFT, BVH_LEAF_MARKERS, BVH_MAX_INDEX, BVH_FOLDED_LEAF_MAX,
	TLAS_LEAF_IDENTITY, COPY_ENTRY, CLUSTER_FIRST_MASK, CLUSTER_COUNT_SHIFT, CLUSTER_SIZE, CLUSTER_ROOT_MASK, CLUSTER_COPY_HIDDEN,
	WIDE_NODE,
} from '../scene/BufferLayout.js';
import { HitInfo } from './Struct.js';
import {
	getDatafromStorageBuffer, storageRows, instanceRows, instanceNormalToWorld, unpackTriangleNormal, triangleRow, triangleGeoRows, shadowFlagsSettle,
	clusterLeaf,
} from './Common.js';
import { MIN_TRAVERSAL_STACK } from '../bvh/TraversalStack.js';

// Hang guard only — tripping it reports a MISS, which the shade kernel pays out as
// full-intensity environment. San Miguel needs ~1024; cost is flat from 1024 up.
const MAX_BVH_ITERATIONS = 4096;
const BVH_STRIDE = 4;
const HUGE_VAL = 1e8;

// Per-mesh visibility is now packed into the TLAS BLAS-pointer leaf's slot [2]
// by TLASBuilder.flatten() — eliminates the dedicated meshVisibility storage buffer.

// ================================================================================
// STACK HELPERS (Native WGSL array via TSL ArrayNode)
// ================================================================================

// Sized for the tree it walks (bvh/TraversalStack.js): a push past the end drops the nearer child.
const stackDepthOf = ( bvhBuffer ) => bvhBuffer.value?.traversalStack ?? MIN_TRAVERSAL_STACK;
const createStack = ( depth ) => array( 'int', depth ).toVar();

// Row k of BVH node `nodeIndex`. One buffer reads each row where it is used; over parts, `rows` are read in one branch.
const nodeRows = ( bvhBuffer, nodeIndex, rows = [ 0, 1, 2, 3 ] ) => {

	if ( ! bvhBuffer.isSplitStorage ) return ( k ) => getDatafromStorageBuffer( bvhBuffer, nodeIndex, int( k ), int( BVH_STRIDE ) );
	const read = storageRows( bvhBuffer, int( nodeIndex ).mul( BVH_STRIDE ), rows );
	return ( k ) => read[ rows.indexOf( k ) ];

};

// A negative stack entry is a leaf folded into its parent, `~( first << 4 | count )` as the parent
// stores it, so child slots are pushed as they are and a leaf needs no fetch.
const foldedFirst = ( entry ) => int( uint( entry.bitNot() ).shiftRight( uint( 4 ) ) );
const foldedCount = ( entry ) => int( uint( entry.bitNot() ).bitAnd( uint( BVH_FOLDED_LEAF_MAX ) ) );

/**
 * Clustered corners (scene/TriangleClusters.js): calls `test( triIndex, rowOf )` for each triangle of a leaf in order. A
 * leaf node holds what its layout needs in slot [2] and lanes 4–15 (clusterLeaf); a folded leaf reads each triangle's
 * corners through the per-triangle table.
 */
const eachClusteredTriangle = ( tris, first, count, leafNode, test ) => {

	const leaf = leafNode ? clusterLeaf( tris, floatBitsToUint( leafNode.data0.z ), leafNode.node ) : null;
	const triStart = int( first ).toVar();

	Loop( { start: int( 0 ), end: int( count ) }, ( { i } ) => {

		const triIndex = triStart.add( i ).toVar();
		const rows = triangleGeoRows( tris, triIndex, leaf && { ...leaf, slot: i } ).map( ( r ) => r.toVar() );
		test( triIndex, ( k ) => rows[ k ] );

	} );

};

// Leaf node tags sit from 2^30 up; in a folded BVH only to 2^31, where folded leaves begin.
const leafTagTest = ( folded ) => ( folded
	? ( tag ) => tag.shiftRight( uint( 30 ) ).equal( uint( 1 ) )
	: ( tag ) => tag.greaterThanEqual( uint( BVH_MAX_INDEX ) ) );

// Reciprocal ray direction with the axis-aligned cases pinned to a large signed value.
const buildInvDir = ( d ) => {

	const dirSign = mix( vec3( 1.0 ), sign( d ), notEqual( d, vec3( 0.0 ) ) );
	return mix( vec3( 1.0 ).div( d ), vec3( HUGE_VAL ).mul( dirSign ), lessThan( abs( d ), vec3( 1e-8 ) ) );

};

// The ray direction is deliberately left unnormalised through the transform: t then means
// the same thing either side of it, so closest-hit comparisons and the world-space hit
// point both survive without rescaling.
const toObjectPoint = ( rows, p ) => vec3(
	rows[ 0 ].xyz.dot( p ).add( rows[ 0 ].w ),
	rows[ 1 ].xyz.dot( p ).add( rows[ 1 ].w ),
	rows[ 2 ].xyz.dot( p ).add( rows[ 2 ].w )
);

const toObjectDir = ( rows, d ) => vec3(
	rows[ 0 ].xyz.dot( d ),
	rows[ 1 ].xyz.dot( d ),
	rows[ 2 ].xyz.dot( d )
);

// Copy clusters (BufferLayout CLUSTER_LEAF): a leaf pushes a COPY_ENTRY for each copy whose byte box the ray reaches,
// farthest first so the nearest is entered first, as an inner node orders its children; popping one moves the ray into
// that copy and pushes its object's root.

// Compare-swaps sorting up to four ascending.
const SORT_NETWORKS = [[], [], [[ 0, 1 ]], [[ 0, 1 ], [ 1, 2 ], [ 0, 1 ]], [[ 0, 1 ], [ 2, 3 ], [ 0, 2 ], [ 1, 3 ], [ 1, 2 ]]];

const pushHitCopies = ( node, nodeIndex, nodeData0, origin, invDir, stack, stackPtr, limit, stackDepth ) => {

	const d1 = node( 1 );
	const d2 = node( 2 );
	const base = vec3( nodeData0.z, d1.x, d1.y ).toVar();
	const exps = floatBitsToUint( nodeData0.y ).toVar();
	const stepOf = ( a ) => uintBitsToFloat( exps.shiftRight( uint( a * 8 ) ).bitAnd( uint( 255 ) ).shiftLeft( uint( 23 ) ) );
	const step = vec3( stepOf( 0 ), stepOf( 1 ), stepOf( 2 ) ).toVar();
	const lo = [ floatBitsToUint( d1.z ).toVar(), floatBitsToUint( d1.w ).toVar(), floatBitsToUint( d2.x ).toVar() ];
	const hi = [ floatBitsToUint( d2.y ).toVar(), floatBitsToUint( d2.z ).toVar(), floatBitsToUint( d2.w ).toVar() ];
	const count = int( floatBitsToUint( nodeData0.x ).shiftRight( uint( CLUSTER_COUNT_SHIFT ) ).bitAnd( uint( 3 ) ) ).add( 1 ).toVar();
	const byte = ( word, k ) => float( word.shiftRight( uint( k * 8 ) ).bitAnd( uint( 255 ) ) );

	const dist = [], slot = [];
	for ( let k = 0; k < CLUSTER_SIZE; k ++ ) {

		const boxMin = base.add( vec3( byte( lo[ 0 ], k ), byte( lo[ 1 ], k ), byte( lo[ 2 ], k ) ).mul( step ) );
		const boxMax = base.add( vec3( byte( hi[ 0 ], k ), byte( hi[ 1 ], k ), byte( hi[ 2 ], k ) ).mul( step ) );
		const d = fastRayAABBDst( { rayOrigin: origin, invDir, boxMin, boxMax } );
		dist.push( select( int( k ).lessThan( count ).and( d.lessThan( limit ) ), d, float( 1e30 ) ).toVar() );
		slot.push( int( k ).toVar() );

	}

	for ( const [ a, b ] of SORT_NETWORKS[ CLUSTER_SIZE ] ) {

		If( dist[ b ].lessThan( dist[ a ] ), () => {

			const td = float( dist[ a ] ).toVar(), ts = int( slot[ a ] ).toVar();
			dist[ a ].assign( dist[ b ] ); slot[ a ].assign( slot[ b ] );
			dist[ b ].assign( td ); slot[ b ].assign( ts );

		} );

	}

	for ( let k = CLUSTER_SIZE - 1; k >= 0; k -- ) {

		If( dist[ k ].lessThan( limit ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

			stack.element( stackPtr ).assign( int( uint( COPY_ENTRY ).bitOr( uint( nodeIndex ).shiftLeft( uint( 2 ) ) ).bitOr( uint( slot[ k ] ) ) ) );
			stackPtr.addAssign( 1 );

		} );

	}

};

// Four quantised boxes (a wide node, bvh/WideBVH.js: copy-cluster bytes) against a ray, as vec4s: a plane's distance is
// one multiply-add from its byte, t = q · step · invDir + ( base − origin ) · invDir. Children past `count` and misses
// read 1e30.
const wideBoxDistances = wgslFn( `
	fn wideBoxDistances( lo: vec3<u32>, hi: vec3<u32>, scale: vec3f, offset: vec3f, count: u32, limit: f32 ) -> vec4f {

		let sh = vec4<u32>( 0u, 8u, 16u, 24u );
		let lx = vec4f( ( vec4<u32>( lo.x ) >> sh ) & vec4<u32>( 255u ) ) * scale.x + offset.x;
		let hx = vec4f( ( vec4<u32>( hi.x ) >> sh ) & vec4<u32>( 255u ) ) * scale.x + offset.x;
		let ly = vec4f( ( vec4<u32>( lo.y ) >> sh ) & vec4<u32>( 255u ) ) * scale.y + offset.y;
		let hy = vec4f( ( vec4<u32>( hi.y ) >> sh ) & vec4<u32>( 255u ) ) * scale.y + offset.y;
		let lz = vec4f( ( vec4<u32>( lo.z ) >> sh ) & vec4<u32>( 255u ) ) * scale.z + offset.z;
		let hz = vec4f( ( vec4<u32>( hi.z ) >> sh ) & vec4<u32>( 255u ) ) * scale.z + offset.z;
		let tNear = max( max( min( lx, hx ), min( ly, hy ) ), min( lz, hz ) );
		let tFar = min( min( max( lx, hx ), max( ly, hy ) ), max( lz, hz ) ) * 1.00000024f;
		let hit = ( tNear <= tFar ) & ( tFar > vec4f( 0.0f ) ) & ( tNear < vec4f( limit ) ) & ( vec4<u32>( 0u, 1u, 2u, 3u ) < vec4<u32>( count ) );
		return select( vec4f( 1e30f ), max( tNear, vec4f( 0.0f ) ), hit );

	}
` );

// A wide node's hit children, nearest pushed last so it is popped first.
const pushWideChildren = ( node, nodeData0, origin, invDir, stack, stackPtr, limit, stackDepth ) => {

	const d1 = node( 1 );
	const d2 = node( 2 );
	const refs = floatBitsToUint( node( 3 ) ).toVar();
	const exps = floatBitsToUint( nodeData0.y ).toVar();
	const stepOf = ( a ) => uintBitsToFloat( exps.shiftRight( uint( a * 8 ) ).bitAnd( uint( 255 ) ).shiftLeft( uint( 23 ) ) );
	const d = wideBoxDistances( {
		lo: uvec3( floatBitsToUint( d1.z ), floatBitsToUint( d1.w ), floatBitsToUint( d2.x ) ),
		hi: uvec3( floatBitsToUint( d2.y ), floatBitsToUint( d2.z ), floatBitsToUint( d2.w ) ),
		scale: vec3( stepOf( 0 ), stepOf( 1 ), stepOf( 2 ) ).mul( invDir ),
		offset: vec3( nodeData0.z, d1.x, d1.y ).sub( origin ).mul( invDir ),
		count: floatBitsToUint( nodeData0.x ),
		limit,
	} ).toVar();

	const dist = [ d.x.toVar(), d.y.toVar(), d.z.toVar(), d.w.toVar() ];
	const ref = [ int( refs.x ).toVar(), int( refs.y ).toVar(), int( refs.z ).toVar(), int( refs.w ).toVar() ];

	for ( const [ a, b ] of SORT_NETWORKS[ 4 ] ) {

		const swap = dist[ b ].lessThan( dist[ a ] ).toVar();
		const da = select( swap, dist[ b ], dist[ a ] ).toVar(), db = select( swap, dist[ a ], dist[ b ] ).toVar();
		const ra = select( swap, ref[ b ], ref[ a ] ).toVar(), rb = select( swap, ref[ a ], ref[ b ] ).toVar();
		dist[ a ].assign( da );
		dist[ b ].assign( db );
		ref[ a ].assign( ra );
		ref[ b ].assign( rb );

	}

	for ( let k = 3; k >= 0; k -- ) {

		If( dist[ k ].lessThan( limit ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

			stack.element( stackPtr ).assign( ref[ k ] );
			stackPtr.addAssign( 1 );

		} );

	}

};

// ================================================================================
// RAY INTERSECTION HELPERS (inlined for BVH traversal performance)
// ================================================================================

// Woop watertight intersection (Woop/Benthin/Wald 2013). Eliminates edge leakage
// at shared triangle edges that Möller-Trumbore exhibits under FP32. Per-ray shears
// are precomputed once via computeWoopFromInvDir; per-triangle test is FMA-friendly
// and uses sign-aware depth comparison so it works for any det orientation.
// guardT: reject t within its own rounding error. Closest-hit rays need it to leave a large triangle; shadow rays
// start lifted off their surface and skip it — its registers cost Shade's shadow traversal ~4 %.
const rayTriangle = ( name, guardT ) => wgslFn( `
	fn ${ name }( rayOrigin: vec3f, rayDir: vec3f, pA: vec3f, pB: vec3f, pC: vec3f, closestHitDst: f32, woopParams: vec4f ) -> vec4f {

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

${ guardT ? `
				// t must clear its own rounding error (pbrt-v4 Triangle::Intersect, γn = n·2⁻²⁴ / (1 − n·2⁻²⁴)), or a
				// ray leaving a large triangle can hit it again: its error grows with the distance to the vertices.
				let maxZ = max( max( abs( Sz * Akz ), abs( Sz * Bkz ) ), abs( Sz * Ckz ) );
				let maxX = max( max( abs( Ax ), abs( Bx ) ), abs( Cx ) );
				let maxY = max( max( abs( Ay ), abs( By ) ), abs( Cy ) );
				let maxE = max( max( abs( U ), abs( V ) ), abs( W ) );
				let deltaX = 2.98023e-7f * ( maxX + maxZ );
				let deltaY = 2.98023e-7f * ( maxY + maxZ );
				let deltaE = 2.0f * ( 1.19209e-7f * maxX * maxY + deltaY * maxX + deltaX * maxY );
				let errT = 3.0f * maxZ * ( 3.57628e-7f * maxE + deltaE );
` : '' }
				if ( tSigned > ${ guardT ? 'errT' : '0.0f' } && tSigned < closestHitDst * detAbs ) {

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

const RayTriangleGeometry = rayTriangle( 'RayTriangleGeometry', true );
const RayTriangleGeometryShadow = rayTriangle( 'RayTriangleGeometryShadow', false );

// Compute Woop ray-space transform (Woop 2013, §3.1) — runs once per ray and
// amortizes across hundreds of triangle tests. Returns Sx/Sy/Sz shears plus the
// permuted axis indices packed via bitcast into the .w slot.
// The reciprocal direction is always built first, and its dominant-axis lane IS Sz; the two
// shears are the other components times it. Three fewer divides per call than dividing afresh.
const computeWoopFromInvDir = wgslFn( `
	fn computeWoopFromInvDir( rayDir: vec3f, invDir: vec3f ) -> vec4f {

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

		let Sz = invDir[ u32( kz ) ];
		let Sx = rayDir[ u32( kx ) ] * Sz;
		let Sy = rayDir[ u32( ky ) ] * Sz;

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

// Side from a triangle's flags word (row 4 .z): 0 front, 1 back, 2 double.
export const triangleSide = ( flags ) => int( flags.shiftRight( uint( TRI_SIDE_SHIFT ) ).bitAnd( uint( 3 ) ) );

// The faces an emitter emits from, as triangleSide: its own when the material has one, else its surface's side.
export const emitterSide = ( flags ) => int( flags.shiftRight( uint( TRI_EMIT_SIDE_SHIFT ) ).bitAnd( uint( 3 ) ) );

// Whether a face of this side is seen by a ray; rayDotNormal < 0 is a front hit.
export const sideAccepts = ( side, rayDotNormal ) => side.equal( int( 2 ) )
	.or( side.equal( int( 0 ) ).and( rayDotNormal.lessThan( - 0.0001 ) ) )
	.or( side.equal( int( 1 ) ).and( rayDotNormal.greaterThan( 0.0001 ) ) );

// Factory: the boxTests/triTests debug counters are compiled OUT of the hot closest-hit
// path (extend/normalDepth use traverseBVH = trackStats false) — only the debug viz reads
// them, and keeping them live across the traversal loop costs registers/occupancy.
const makeTraverseBVH = ( trackStats ) => Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	insideMedium, // optional: when true (ray inside a medium), bypass front/back culling
	cullBackFaces, // optional, default true: false hits either side, as shadow rays do
] ) => {

	// Culling is for what the camera sees through; a bounce culling it leaks light through hollow models.
	const eitherSide = ( insideMedium ?? tslBool( false ) ).or( ( cullBackFaces ?? tslBool( true ) ).not() ).toVar();

	// Folded leaves cost up to 4 % of traversal, so only a BVH built with them gets that code.
	// Objects' trees 4-wide (bvh/WideBVH.js) fold their leaves too; a wide node's tag sits among the leaf tags.
	const wide = bvhBuffer.value?.wide === true;
	const folded = wide || bvhBuffer.value?.foldedLeaves === true;
	const isLeafTag = wide ? ( tag ) => leafTagTest( true )( tag ).and( tag.notEqual( uint( WIDE_NODE ) ) ) : leafTagTest( folded );
	const stackDepth = stackDepthOf( bvhBuffer );

	const closestHit = HitInfo( {
		didHit: false,
		dst: float( 1e20 ),
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		instanceLeaf: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	// Deferred attribute fetch: store closest triIndex + barycentrics during traversal,
	// compute hitPoint and UVs once after the loop
	const closestTriIdx = int( - 1 ).toVar();
	const closestU = float( 0.0 ).toVar();
	const closestV = float( 0.0 ).toVar();

	// Stack (native WGSL array — O(1) read/write)
	const stack = createStack( stackDepth );
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) ); // Root node

	// Triangles sit in each instance's own space, so the ray is what moves: `world*` stays
	// put, `ray*`/`invDir`/`woopParams` are rewritten on entering a BLAS and never restored.
	const worldOrigin = vec3( ray.origin ).toVar();
	const worldDirection = vec3( ray.direction ).toVar();
	const worldInvDir = buildInvDir( worldDirection ).toVar();
	const worldWoop = computeWoopFromInvDir( { rayDir: worldDirection, invDir: worldInvDir } ).toVar();

	const rayOrigin = vec3( worldOrigin ).toVar();
	const rayDirection = vec3( worldDirection ).toVar();
	const invDir = vec3( worldInvDir ).toVar();
	const woopParams = vec4( worldWoop ).toVar();

	// The TLAS leaf the ray is inside, or -1; dropping below `instExit` on the stack clears it.
	const instLeaf = int( - 1 ).toVar();
	const instExit = int( 0 ).toVar();
	const hitInstLeaf = int( - 1 ).toVar();

	// Built over copy clusters: the copies' transforms are records from vec4 `copyRecordBase` (BufferLayout).
	const clustered = bvhBuffer.value?.copyRecordBase !== undefined;
	const enterCopy = ( entry ) => {

		const leaf = int( uint( entry ).bitAnd( uint( ~ COPY_ENTRY >>> 0 ) ).shiftRight( uint( 2 ) ) );
		const k = uint( entry ).bitAnd( uint( 3 ) ).toVar();
		const node = nodeRows( bvhBuffer, leaf, [ 0, 3 ] );
		const head = node( 0 );
		const words = floatBitsToUint( node( 3 ) ).toVar();
		const word = select( k.equal( uint( 0 ) ), words.x, select( k.equal( uint( 1 ) ), words.y, select( k.equal( uint( 2 ) ), words.z, words.w ) ) ).toVar();

		If( word.bitAnd( uint( CLUSTER_COPY_HIDDEN ) ).equal( uint( 0 ) ), () => {

			If( word.bitAnd( uint( TLAS_LEAF_IDENTITY ) ).equal( uint( 0 ) ), () => {

				const record = int( floatBitsToUint( head.x ).bitAnd( uint( CLUSTER_FIRST_MASK ) ).add( k ) ).toVar();
				const rows = instanceRows( bvhBuffer, record );
				const localDir = toObjectDir( rows, worldDirection ).toVar();

				rayOrigin.assign( toObjectPoint( rows, worldOrigin ) );
				rayDirection.assign( localDir );
				const localInv = buildInvDir( localDir ).toVar();
				invDir.assign( localInv );
				woopParams.assign( computeWoopFromInvDir( { rayDir: localDir, invDir: localInv } ) );
				instLeaf.assign( record );
				instExit.assign( stackPtr );

			} ).Else( () => {

				rayOrigin.assign( worldOrigin );
				rayDirection.assign( worldDirection );
				invDir.assign( worldInvDir );
				woopParams.assign( worldWoop );
				instLeaf.assign( int( - 1 ) );

			} );

			stack.element( stackPtr ).assign( int( word.bitAnd( uint( CLUSTER_ROOT_MASK ) ) ) );
			stackPtr.addAssign( 1 );

		} );

	};

	// Emitted once per leaf kind, in its own branch: hoisted below both, the range stayed live
	// through the inner-node path and cost 9–13 % of traversal time.
	const testLeaf = ( first, count, leafNode = null ) => {

		if ( triangleBuffer.clustered ) {

			eachClusteredTriangle( triangleBuffer, first, count, leafNode, testTriangle );
			stopIfTouching();
			return;

		}

		const triStart = int( first ).toVar();
		const triCount = int( count ).toVar();

		Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

			const triIndex = triStart.add( i ).toVar();
			testTriangle( triIndex, ( row ) => triangleRow( triangleBuffer, triIndex, row ).toVar() );

		} );

		stopIfTouching();

	};

	// Three fetches carry positions AND the packed normals in their .w lanes.
	function testTriangle( triIndex, rowOf ) {

		if ( trackStats ) closestHit.triTests.addAssign( 1 );
		const recA = rowOf( 0 );
		const recB = rowOf( 1 );
		const recC = rowOf( 2 );
		const pA = uintBitsToFloat( recA.xyz );
		const pB = uintBitsToFloat( recB.xyz );
		const pC = uintBitsToFloat( recC.xyz );

		const triResult = RayTriangleGeometry( { rayOrigin, rayDir: rayDirection, pA, pB, pC, closestHitDst: closestHit.dst, woopParams } );

		// RayTriangleGeometry already guarantees t < closestHit.dst when w > 0.5
		If( triResult.w.greaterThan( 0.5 ), () => {

			const t = triResult.x;
			const u = triResult.y;
			const v = triResult.z;

			// Normals came with the positions; only the side flag needs a fetch, and
			// slot 4 also carries matIdx/meshIndex, deferred to post-traversal.
			const nA = unpackTriangleNormal( recA.w );
			const nB = unpackTriangleNormal( recB.w );
			const nC = unpackTriangleNormal( recC.w );
			const side = triangleSide( triangleRow( triangleBuffer, triIndex, 4 ).z ).toVar();

			// Interpolate normal for the side-culling dot product (kept local,
			// not stored on closestHit — re-derived post-loop from closestTriIdx).
			const w = float( 1.0 ).sub( u ).sub( v );
			const rayDotNormal = rayDirection.dot(
				normalize( nA.mul( w ).add( nB.mul( u ) ).add( nC.mul( v ) ) )
			);

			// Side culling (inline; per-mesh visibility is at the BLAS-pointer level).
			If( eitherSide.or( sideAccepts( side, rayDotNormal ) ), () => {

				closestHit.didHit.assign( true );
				closestHit.dst.assign( t );

				// Defer normal/materialIndex/meshIndex/hitPoint/UV to post-traversal
				// (all re-derived from closestTriIdx after the loop exits).
				closestTriIdx.assign( triIndex );
				closestU.assign( u );
				closestV.assign( v );
				hitInstLeaf.assign( instLeaf );

			} );

		} );

	}

	// If we found a very close hit, we can terminate early
	function stopIfTouching() {

		If( closestHit.didHit.and( closestHit.dst.lessThan( 0.001 ) ), () => {

			Break();

		} );

	}

	const iterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( iterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		iterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const entry = stack.element( stackPtr ).toVar();
		instLeaf.assign( select( stackPtr.lessThan( instExit ), int( - 1 ), instLeaf ) );

		const visitNode = () => {

			const nodeIndex = entry;
			const node = nodeRows( bvhBuffer, nodeIndex );

			// 4 vec4 per node
			// Leaf: vec4(0) = [triOffset, triCount, 0, TRIANGLE_LEAF]
			// Inner: vec4(0) = [leftMin.xyz, leftChild], vec4(1) = [leftMax.xyz, rightChild],
			//        vec4(2) = [rightMin.xyz, 0], vec4(3) = [rightMax.xyz, 0]
			const nodeData0 = node( 0 );
			if ( trackStats ) closestHit.boxTests.addAssign( 1 );

			// Slot [3] carries a u32 bit pattern: an inner node's left child, or a leaf tag. Stored as
			// float VALUES these rounded past 2^24 and sent the ray to a neighbouring node, which
			// silently erased geometry from large scenes.
			const nodeTag = floatBitsToUint( nodeData0.w ).toVar();

			If( isLeafTag( nodeTag ), () => {

				If( nodeTag.equal( uint( BVH_LEAF_MARKERS.TRIANGLE_LEAF ) ), () => {

					testLeaf( floatBitsToUint( nodeData0.x ), floatBitsToUint( nodeData0.y ), { data0: nodeData0, node } );

				} ).Else( clustered ? () => {

					pushHitCopies( node, nodeIndex, nodeData0, worldOrigin, worldInvDir, stack, stackPtr, closestHit.dst, stackDepth );

				} : () => {

					// BLAS-pointer leaf — enter the instance if the mesh is visible.
					// nodeData0: [blasRootNodeIndex, meshIndex, visibility, -2]; slots 4..15 hold
					// the world-to-object matrix. Visibility is free-fetched with the leaf.
					If( nodeData0.z.greaterThan( 0.5 ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

						// A baked placement already sits in world space; only a transformed one moves the ray.
						If( floatBitsToUint( nodeData0.y ).bitAnd( uint( TLAS_LEAF_IDENTITY ) ).equal( uint( 0 ) ), () => {

							const rows = [ node( 1 ), node( 2 ), node( 3 ) ];
							const localDir = toObjectDir( rows, worldDirection ).toVar();

							rayOrigin.assign( toObjectPoint( rows, worldOrigin ) );
							rayDirection.assign( localDir );
							const localInv = buildInvDir( localDir ).toVar();
							invDir.assign( localInv );
							woopParams.assign( computeWoopFromInvDir( { rayDir: localDir, invDir: localInv } ) );
							instLeaf.assign( nodeIndex );
							instExit.assign( stackPtr );

						} ).Else( () => {

							rayOrigin.assign( worldOrigin );
							rayDirection.assign( worldDirection );
							invDir.assign( worldInvDir );
							woopParams.assign( worldWoop );
							instLeaf.assign( int( - 1 ) );

						} );

						stack.element( stackPtr ).assign( int( floatBitsToUint( nodeData0.x ) ) );
						stackPtr.addAssign( 1 );

					} );

				} );

			} ).Else( () => {

				// Binary in the top level; under compactLayout an object's tree is 4-wide.
				const binary = () => {

					// Inner node — child AABBs stored in this node (4 reads total, no child fetches)
					const nodeData1 = node( 1 );
					const nodeData2 = node( 2 );
					const nodeData3 = node( 3 );

					const leftChild = int( nodeTag ).toVar();
					const rightChild = int( floatBitsToUint( nodeData1.w ) ).toVar();

					const inInst = instLeaf.greaterThanEqual( int( 0 ) );
					const boxOrigin = select( inInst, rayOrigin, worldOrigin ).toVar();
					const boxInv = select( inInst, invDir, worldInvDir ).toVar();
					const dstA = fastRayAABBDst( { rayOrigin: boxOrigin, invDir: boxInv, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
					const dstB = fastRayAABBDst( { rayOrigin: boxOrigin, invDir: boxInv, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

					// Optimized early rejection
					const minDst = min( dstA, dstB );
					If( minDst.lessThan( closestHit.dst ), () => {

						// Improved node ordering with fewer conditionals
						const aCloser = dstA.lessThan( dstB );

						// Push far child first (processed last)
						If( select( aCloser, dstB, dstA ).lessThan( closestHit.dst ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

							stack.element( stackPtr ).assign( select( aCloser, rightChild, leftChild ) );
							stackPtr.addAssign( 1 );

						} );

						// Push near child second (processed first)
						If( stackPtr.lessThan( int( stackDepth ) ), () => {

							stack.element( stackPtr ).assign( select( aCloser, leftChild, rightChild ) );
							stackPtr.addAssign( 1 );

						} );

					} );

				};

				if ( wide ) If( nodeTag.equal( uint( WIDE_NODE ) ), () => {

					const inInst = instLeaf.greaterThanEqual( int( 0 ) );
					pushWideChildren( node, nodeData0, select( inInst, rayOrigin, worldOrigin ).toVar(), select( inInst, invDir, worldInvDir ).toVar(),
						stack, stackPtr, closestHit.dst, stackDepth );

				} ).Else( binary );
				else binary();

			} );


		};

		// A copy continues the loop: the visit nested in an Else overflowed the JS stack building the island's kernels.
		const dispatch = clustered ? () => {

			If( entry.greaterThanEqual( int( COPY_ENTRY ) ), () => {

				enterCopy( entry );
				Continue();

			} );
			visitNode();

		} : visitNode;

		// Only a folded BVH has negative entries: a leaf folded into its parent, tested with no fetch.
		if ( folded ) If( entry.lessThan( int( 0 ) ), () => testLeaf( foldedFirst( entry ), foldedCount( entry ) ) ).Else( dispatch );
		else dispatch();

	} );

	// Deferred: compute normal, hitPoint, UVs, and fetch matIdx/meshIndex once for the final closest hit
	If( closestHit.didHit, () => {

		closestHit.hitPoint.assign( ray.origin.add( ray.direction.mul( closestHit.dst ) ) );

		const w = float( 1.0 ).sub( closestU ).sub( closestV );

		// Re-fetch the winning triangle's normals — trading 3 storage reads (once)
		// for ~3 regs freed across every BVH iteration.
		const geoRows = triangleGeoRows( triangleBuffer, closestTriIdx ).map( ( row ) => row.toVar() );
		const [ nA, nB, nC ] = geoRows.map( ( row ) => unpackTriangleNormal( row.w ) );
		const objectNormal = normalize( nA.mul( w ).add( nB.mul( closestU ) ).add( nC.mul( closestV ) ) ).toVar();
		If( hitInstLeaf.greaterThanEqual( int( 0 ) ), () => {

			objectNormal.assign( normalize( instanceNormalToWorld( instanceRows( bvhBuffer, hitInstLeaf ), objectNormal ) ) );

		} );

		closestHit.normal.assign( objectNormal );

		const uvData1 = uintBitsToFloat( triangleRow( triangleBuffer, closestTriIdx, 3 ) );
		const uvData2 = triangleRow( triangleBuffer, closestTriIdx, 4 ).toVar();
		closestHit.uv.assign(
			uvData1.xy.mul( w ).add( uvData1.zw.mul( closestU ) ).add( uintBitsToFloat( uvData2.xy ).mul( closestV ) )
		);
		closestHit.materialIndex.assign( int( uvData2.z.bitAnd( uint( TRI_MATERIAL_MASK ) ) ) );
		closestHit.meshIndex.assign( int( uvData2.w ) );
		closestHit.instanceLeaf.assign( hitInstLeaf );
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

// cameraCulled: skip the faces a camera ray along −direction would cull, for a ray standing in for one.
const makeTraverseBVHShadow = ( cameraCulled ) => Fn( ( [
	ray,
	bvhBuffer,
	triangleBuffer,
	maxShadowDist,
], builder ) => {

	const { alphaShadows } = sceneResources( builder );

	// Objects' trees 4-wide (bvh/WideBVH.js) fold their leaves too; a wide node's tag sits among the leaf tags.
	const wide = bvhBuffer.value?.wide === true;
	const folded = wide || bvhBuffer.value?.foldedLeaves === true;
	const isLeafTag = wide ? ( tag ) => leafTagTest( true )( tag ).and( tag.notEqual( uint( WIDE_NODE ) ) ) : leafTagTest( folded );
	const stackDepth = stackDepthOf( bvhBuffer );

	const closestHit = HitInfo( {
		didHit: false,
		dst: maxShadowDist,
		hitPoint: vec3( 0.0 ),
		normal: vec3( 0.0 ),
		uv: vec2( 0.0 ),
		materialIndex: int( - 1 ),
		meshIndex: int( - 1 ),
		instanceLeaf: int( - 1 ),
		boxTests: int( 0 ),
		triTests: int( 0 ),
	} ).toVar();

	const stack = createStack( stackDepth );
	const stackPtr = int( 1 ).toVar();
	stack.element( int( 0 ) ).assign( int( 0 ) );

	// Same instance-space scheme as traverseBVH: the ray moves, the triangles do not.
	const worldOrigin = vec3( ray.origin ).toVar();
	const worldDirection = vec3( ray.direction ).toVar();
	const worldInvDir = buildInvDir( worldDirection ).toVar();
	const worldWoop = computeWoopFromInvDir( { rayDir: worldDirection, invDir: worldInvDir } ).toVar();

	const rayOrigin = vec3( worldOrigin ).toVar();
	const rayDirection = vec3( worldDirection ).toVar();
	const invDir = vec3( worldInvDir ).toVar();
	const woopParams = vec4( worldWoop ).toVar();

	const instLeaf = int( - 1 ).toVar();
	const instExit = int( 0 ).toVar();
	const blocked = tslBool( false ).toVar();

	// Built over copy clusters: the copies' transforms are records from vec4 `copyRecordBase` (BufferLayout).
	const clustered = bvhBuffer.value?.copyRecordBase !== undefined;
	const enterCopy = ( entry ) => {

		const leaf = int( uint( entry ).bitAnd( uint( ~ COPY_ENTRY >>> 0 ) ).shiftRight( uint( 2 ) ) );
		const k = uint( entry ).bitAnd( uint( 3 ) ).toVar();
		const node = nodeRows( bvhBuffer, leaf, [ 0, 3 ] );
		const head = node( 0 );
		const words = floatBitsToUint( node( 3 ) ).toVar();
		const word = select( k.equal( uint( 0 ) ), words.x, select( k.equal( uint( 1 ) ), words.y, select( k.equal( uint( 2 ) ), words.z, words.w ) ) ).toVar();

		If( word.bitAnd( uint( CLUSTER_COPY_HIDDEN ) ).equal( uint( 0 ) ), () => {

			If( word.bitAnd( uint( TLAS_LEAF_IDENTITY ) ).equal( uint( 0 ) ), () => {

				const record = int( floatBitsToUint( head.x ).bitAnd( uint( CLUSTER_FIRST_MASK ) ).add( k ) ).toVar();
				const rows = instanceRows( bvhBuffer, record );
				const localDir = toObjectDir( rows, worldDirection ).toVar();

				rayOrigin.assign( toObjectPoint( rows, worldOrigin ) );
				rayDirection.assign( localDir );
				const localInv = buildInvDir( localDir ).toVar();
				invDir.assign( localInv );
				woopParams.assign( computeWoopFromInvDir( { rayDir: localDir, invDir: localInv } ) );
				instLeaf.assign( record );
				instExit.assign( stackPtr );

			} ).Else( () => {

				rayOrigin.assign( worldOrigin );
				rayDirection.assign( worldDirection );
				invDir.assign( worldInvDir );
				woopParams.assign( worldWoop );
				instLeaf.assign( int( - 1 ) );

			} );

			stack.element( stackPtr ).assign( int( word.bitAnd( uint( CLUSTER_ROOT_MASK ) ) ) );
			stackPtr.addAssign( 1 );

		} );

	};

	const testLeaf = ( first, count, leafNode = null ) => {

		if ( triangleBuffer.clustered ) {

			eachClusteredTriangle( triangleBuffer, first, count, leafNode, testTriangle );
			return;

		}

		const triStart = int( first ).toVar();
		const triCount = int( count ).toVar();

		Loop( { start: int( 0 ), end: triCount }, ( { i } ) => {

			const triIndex = triStart.add( i ).toVar();
			testTriangle( triIndex, ( row ) => triangleRow( triangleBuffer, triIndex, row ) );

		} );

	};

	function testTriangle( triIndex, rowOf ) {

		const pA = uintBitsToFloat( rowOf( 0 ).xyz );
		const pB = uintBitsToFloat( rowOf( 1 ).xyz );
		const pC = uintBitsToFloat( rowOf( 2 ).xyz );

		const triResult = RayTriangleGeometryShadow( { rayOrigin, rayDir: rayDirection, pA, pB, pC, closestHitDst: closestHit.dst, woopParams } );

		If( triResult.w.greaterThan( 0.5 ), () => {

			// Per-mesh visibility is handled at the BLAS-pointer level.
			const uvData2 = triangleRow( triangleBuffer, triIndex, 4 ).toVar();

			const record = () => {

				closestHit.didHit.assign( true );
				closestHit.dst.assign( triResult.x );
				closestHit.materialIndex.assign( int( uvData2.z.bitAnd( uint( TRI_MATERIAL_MASK ) ) ) );
				closestHit.meshIndex.assign( int( uvData2.w ) );
				closestHit.instanceLeaf.assign( instLeaf );

				// Hit point is cheap (origin + dir*t). Geometric normal is deferred
				// to traceShadowRay — only the transmission branch needs it, so we
				// skip the cross+normalize for the (much more common) opaque-blocker
				// and alpha-cutout paths. Normal stays vec3(0) from struct init.
				closestHit.hitPoint.assign( worldOrigin.add( worldDirection.mul( triResult.x ) ) );

				closestHit.uv.assign( vec2( triResult.y, triResult.z ) );
				closestHit.triangleIndex.assign( triIndex );

				// An opaque blocker settles the ray. A surface light passes through has to be
				// the nearest one, or the layers behind the first find are never counted.
				If( shadowFlagsSettle( uvData2.z, alphaShadows ), () => {

					blocked.assign( true );
					Break();

				} );

			};

			if ( cameraCulled ) {

				const w = float( 1.0 ).sub( triResult.y ).sub( triResult.z );
				const n = normalize( unpackTriangleNormal( rowOf( 0 ).w ).mul( w )
					.add( unpackTriangleNormal( rowOf( 1 ).w ).mul( triResult.y ) )
					.add( unpackTriangleNormal( rowOf( 2 ).w ).mul( triResult.z ) ) );
				If( sideAccepts( triangleSide( uvData2.z ), rayDirection.dot( n ).negate() ), record );

			} else record();


		} );

	}

	const sIterCount = int( 0 ).toVar();

	Loop( stackPtr.greaterThan( int( 0 ) ).and( blocked.not() ).and( sIterCount.lessThan( int( MAX_BVH_ITERATIONS ) ) ), () => {

		sIterCount.addAssign( 1 );
		stackPtr.subAssign( 1 );
		const entry = stack.element( stackPtr ).toVar();
		instLeaf.assign( select( stackPtr.lessThan( instExit ), int( - 1 ), instLeaf ) );

		const visitNode = () => {

			const nodeIndex = entry;
			const node = nodeRows( bvhBuffer, nodeIndex );
			const nodeData0 = node( 0 );

			// Slot [3] carries a u32 bit pattern: an inner node's left child, or a leaf tag. Stored as
			// float VALUES these rounded past 2^24 and sent the ray to a neighbouring node, which
			// silently erased geometry from large scenes.
			const nodeTag = floatBitsToUint( nodeData0.w ).toVar();

			If( isLeafTag( nodeTag ), () => {

				If( nodeTag.equal( uint( BVH_LEAF_MARKERS.TRIANGLE_LEAF ) ), () => {

					testLeaf( floatBitsToUint( nodeData0.x ), floatBitsToUint( nodeData0.y ), { data0: nodeData0, node } );

				} ).Else( clustered ? () => {

					pushHitCopies( node, nodeIndex, nodeData0, worldOrigin, worldInvDir, stack, stackPtr, closestHit.dst, stackDepth );

				} : () => {

					// BLAS-pointer leaf — enter the instance if the mesh is visible.
					If( nodeData0.z.greaterThan( 0.5 ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

						// A baked placement already sits in world space; only a transformed one moves the ray.
						If( floatBitsToUint( nodeData0.y ).bitAnd( uint( TLAS_LEAF_IDENTITY ) ).equal( uint( 0 ) ), () => {

							const rows = [ node( 1 ), node( 2 ), node( 3 ) ];
							const localDir = toObjectDir( rows, worldDirection ).toVar();

							rayOrigin.assign( toObjectPoint( rows, worldOrigin ) );
							rayDirection.assign( localDir );
							const localInv = buildInvDir( localDir ).toVar();
							invDir.assign( localInv );
							woopParams.assign( computeWoopFromInvDir( { rayDir: localDir, invDir: localInv } ) );
							instLeaf.assign( nodeIndex );
							instExit.assign( stackPtr );

						} ).Else( () => {

							rayOrigin.assign( worldOrigin );
							rayDirection.assign( worldDirection );
							invDir.assign( worldInvDir );
							woopParams.assign( worldWoop );
							instLeaf.assign( int( - 1 ) );

						} );

						stack.element( stackPtr ).assign( int( floatBitsToUint( nodeData0.x ) ) );
						stackPtr.addAssign( 1 );

					} );

				} );

			} ).Else( () => {

				// Binary in the top level; under compactLayout an object's tree is 4-wide.
				const binary = () => {

					// Inner node — child AABBs stored in this node
					const nodeData1 = node( 1 );
					const nodeData2 = node( 2 );
					const nodeData3 = node( 3 );

					const leftChild = int( nodeTag ).toVar();
					const rightChild = int( floatBitsToUint( nodeData1.w ) ).toVar();

					const inInst = instLeaf.greaterThanEqual( int( 0 ) );
					const boxOrigin = select( inInst, rayOrigin, worldOrigin ).toVar();
					const boxInv = select( inInst, invDir, worldInvDir ).toVar();
					const dstA = fastRayAABBDst( { rayOrigin: boxOrigin, invDir: boxInv, boxMin: nodeData0.xyz, boxMax: nodeData1.xyz } ).toVar();
					const dstB = fastRayAABBDst( { rayOrigin: boxOrigin, invDir: boxInv, boxMin: nodeData2.xyz, boxMax: nodeData3.xyz } ).toVar();

					// Distance-ordered traversal — nearer child first for faster any-hit
					// termination. SA build ordering improves cache locality (larger-SA
					// child = left = first in DFS flat layout).
					const minDst = min( dstA, dstB );
					If( minDst.lessThan( closestHit.dst ), () => {

						const aCloser = dstA.lessThan( dstB );

						// Push far child first (processed last)
						If( select( aCloser, dstB, dstA ).lessThan( closestHit.dst ).and( stackPtr.lessThan( int( stackDepth ) ) ), () => {

							stack.element( stackPtr ).assign( select( aCloser, rightChild, leftChild ) );
							stackPtr.addAssign( 1 );

						} );

						// Push near child second (processed first)
						If( stackPtr.lessThan( int( stackDepth ) ), () => {

							stack.element( stackPtr ).assign( select( aCloser, leftChild, rightChild ) );
							stackPtr.addAssign( 1 );

						} );

					} );

				};

				if ( wide ) If( nodeTag.equal( uint( WIDE_NODE ) ), () => {

					const inInst = instLeaf.greaterThanEqual( int( 0 ) );
					pushWideChildren( node, nodeData0, select( inInst, rayOrigin, worldOrigin ).toVar(), select( inInst, invDir, worldInvDir ).toVar(),
						stack, stackPtr, closestHit.dst, stackDepth );

				} ).Else( binary );
				else binary();

			} );


		};

		// A copy continues the loop: the visit nested in an Else overflowed the JS stack building the island's kernels.
		const dispatch = clustered ? () => {

			If( entry.greaterThanEqual( int( COPY_ENTRY ) ), () => {

				enterCopy( entry );
				Continue();

			} );
			visitNode();

		} : visitNode;

		// Only a folded BVH has negative entries: a leaf folded into its parent, tested with no fetch.
		if ( folded ) If( entry.lessThan( int( 0 ) ), () => testLeaf( foldedFirst( entry ), foldedCount( entry ) ) ).Else( dispatch );
		else dispatch();

	} );

	return closestHit;

} );

export const traverseBVHShadow = /*@__PURE__*/ makeTraverseBVHShadow( false );
export const traverseBVHShadowCameraCulled = /*@__PURE__*/ makeTraverseBVHShadow( true );
