/**
 * Triangle record: 5 uvec4 lanes (80 bytes). The buffer is declared `uvec4` so packed lanes
 * keep their exact bit pattern — a packSnorm2x16 result can land in the f32 NaN range, and an
 * f32 lane may canonicalise it (the same reason the G-buffer is uvec4). Positions and UVs are
 * written as f32 through a Float32Array view of the same memory and read back with
 * `uintBitsToFloat`, so they carry full precision; only normals are compressed.
 *
 * Was 32 floats (128 B) with 4 dead padding lanes. At 128 B the 2 GB V8 ArrayBuffer cap put a
 * hard ceiling of 16.7M triangles on the scene — 80 B lifts that to 26.8M and cuts geometry
 * VRAM by the same 37.5%. Each normal now rides in its position's spare .w lane, so the three
 * vec4 loads the intersection test already does carry the normals with them.
 */
export const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 20,

	POSITION_A_OFFSET: 0, // f32 xyz + packed normal A
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,

	NORMAL_A_PACKED_OFFSET: 3, // oct16 in each position's .w lane
	NORMAL_B_PACKED_OFFSET: 7,
	NORMAL_C_PACKED_OFFSET: 11,

	UV_AB_OFFSET: 12, // f32 uvA.xy, uvB.xy
	UV_C_OFFSET: 16, // f32 uvC.xy
	MATERIAL_FLAGS_OFFSET: 18, // materialIndex | side << 24 | shadowBlockerBits << 26 (two bits) | emitter side << 28
	MESH_INDEX_OFFSET: 19
};

export const TRI_MATERIAL_MASK = 0xffffff;
export const TRI_SIDE_SHIFT = 24; // 0 front, 1 back, 2 double
export const TRI_BLOCKER_SHIFT = 26; // 1 = blocks shadow rays whatever the settings
export const TRI_BLOCKER_ALPHA_SHIFT = 27; // 1 = blocks them unless alpha-cutout shadows are on
export const TRI_EMIT_SIDE_SHIFT = 28; // the faces that emit, as `side`: the material's emissiveSide, else its side

/**
 * How a shadow ray settles on this material without fetching it, mirroring traceShadowRay:
 * bit 0 set = always a blocker; bit 1 set = a blocker while alpha-cutout shadows are off
 * (MASK/BLEND with nothing else letting light through); 0 = light may pass, so the shadow
 * traversal has to find the nearest such surface.
 */
export function shadowBlockerBits( material ) {

	if ( ! material ) return 0;
	const solid = ( material.transmission || 0 ) === 0
		&& ( ( material.transparent | 0 ) === 0 || ( material.opacity ?? 1 ) >= 1 );
	if ( ! solid ) return 0;
	return ( material.alphaMode | 0 ) === 0 ? 1 : 2;

}

/**
 * Material index plus the per-triangle flags the shader reads without touching the
 * material buffer: `side` for inline culling, the two shadow-blocker bits and the emitting side.
 */
export function packTriangleFlags( materialIndex, material ) {

	return ( ( materialIndex & TRI_MATERIAL_MASK )
		| ( ( material?.side ?? 0 ) << TRI_SIDE_SHIFT )
		| ( shadowBlockerBits( material ) << TRI_BLOCKER_SHIFT )
		| ( ( material?.emissiveSide ?? material?.side ?? 0 ) << TRI_EMIT_SIDE_SHIFT ) ) >>> 0;

}

/**
 * Octahedral-encode a unit normal into one u32 (two snorm16). Worst-case error is ~0.03°,
 * well under what normal maps and barycentric interpolation already contribute.
 * A degenerate (zero-length) normal encodes as +Z rather than NaN.
 */
export function packNormalOct( x, y, z ) {

	const len = Math.sqrt( x * x + y * y + z * z );
	if ( len > 0 ) {

		x /= len; y /= len; z /= len;

	} else {

		x = 0; y = 0; z = 1;

	}

	const sum = Math.abs( x ) + Math.abs( y ) + Math.abs( z );
	let u = x / sum, v = y / sum;
	if ( z < 0 ) {

		const au = u, av = v;
		u = ( 1 - Math.abs( av ) ) * ( au >= 0 ? 1 : - 1 );
		v = ( 1 - Math.abs( au ) ) * ( av >= 0 ? 1 : - 1 );

	}

	const qu = Math.round( Math.min( 1, Math.max( - 1, u ) ) * 32767 ) & 0xffff;
	const qv = Math.round( Math.min( 1, Math.max( - 1, v ) ) * 32767 ) & 0xffff;
	return ( ( qv << 16 ) | qu ) >>> 0;

}

/** Inverse of packNormalOct; writes into `out` (length >= 3) and returns it. */
export function unpackNormalOct( packed, out ) {

	const u = ( ( packed << 16 ) >> 16 ) / 32767;
	const v = ( packed >> 16 ) / 32767;
	let x = u, y = v, z = 1 - Math.abs( u ) - Math.abs( v );
	if ( z < 0 ) {

		const ax = x, ay = y;
		x = ( 1 - Math.abs( ay ) ) * ( ax >= 0 ? 1 : - 1 );
		y = ( 1 - Math.abs( ax ) ) * ( ay >= 0 ? 1 : - 1 );

	}

	const len = Math.sqrt( x * x + y * y + z * z ) || 1;
	out[ 0 ] = x / len; out[ 1 ] = y / len; out[ 2 ] = z / len;
	return out;

}

// Material data layout constants — single source of truth for material buffer offsets.
// Shared between CPU writers (TextureCreator, MaterialDataManager) and GPU readers (Common.js getMaterial).
export const MATERIAL_DATA_LAYOUT = {

	SLOTS_PER_MATERIAL: 35, // vec4 slots per material
	FLOATS_PER_MATERIAL: 140, // total floats per material (35 × 4)

	// ── Flat float offsets (CPU side) ────────────────────────────────
	// Used as: data[ materialIndex * FLOATS_PER_MATERIAL + offset ]
	// Ordered for cache-line coherence: shadow/culling → BxDF core → maps → extended → transforms

	// Slot 0: ior + transmission + thickness + emissiveIntensity   [shadow]
	IOR: 0, TRANSMISSION: 1, THICKNESS: 2, EMISSIVE_INTENSITY: 3,
	// Slot 1: attenuationColor.rgb + attenuationDistance            [shadow]
	ATTENUATION_COLOR: 4, ATTENUATION_DISTANCE: 7,
	// Slot 2: opacity + side + transparent + alphaTest              [shadow + culling]
	OPACITY: 8, SIDE: 9, TRANSPARENT: 10, ALPHA_TEST: 11,
	// Slot 3: alphaMode + depthWrite + normalScale + diffuseRoughness map index [shadow]
	ALPHA_MODE: 12, DEPTH_WRITE: 13, NORMAL_SCALE: 14, DIFFUSE_ROUGHNESS_MAP_INDEX: 15,
	// Slot 4: color.rgb + metalness                                 [BxDF core]
	COLOR: 16, METALNESS: 19,
	// Slot 5: emissive.rgb + roughness                              [BxDF core]
	EMISSIVE: 20, ROUGHNESS: 23,
	// Slot 6: map indices (albedo, normal, roughness, metalness)    [maps]
	ALBEDO_MAP_INDEX: 24, NORMAL_MAP_INDEX: 25, ROUGHNESS_MAP_INDEX: 26, METALNESS_MAP_INDEX: 27,
	// Slot 7: map indices (emissive, bump) + clearcoat              [maps]
	EMISSIVE_MAP_INDEX: 28, BUMP_MAP_INDEX: 29, CLEARCOAT: 30, CLEARCOAT_ROUGHNESS: 31,
	// Slot 8: dispersion + diffuseRoughness + sheen + sheenRoughness [extended BxDF]
	DISPERSION: 32, DIFFUSE_ROUGHNESS: 33, SHEEN: 34, SHEEN_ROUGHNESS: 35,
	// Slot 9: sheenColor.rgb + diffuseTransmission                 [extended BxDF]
	SHEEN_COLOR: 36, DIFFUSE_TRANSMISSION: 39,
	// Slot 10: specularIntensity + specularColor.rgb                [extended BxDF]
	SPECULAR_INTENSITY: 40, SPECULAR_COLOR: 41,
	// Slot 11: iridescence + iridescenceIOR + iridescenceThicknessRange [extended BxDF]
	IRIDESCENCE: 44, IRIDESCENCE_IOR: 45, IRIDESCENCE_THICKNESS_RANGE: 46,
	// Slot 12: bumpScale + displacementScale + displacementMapIndex + displacementBias
	BUMP_SCALE: 48, DISPLACEMENT_SCALE: 49, DISPLACEMENT_MAP_INDEX: 50, DISPLACEMENT_BIAS: 51,

	// ── Transform float offsets (8 floats each: Matrix3 elements 0–7; the GPU rebuilds the 9th) ──
	ALBEDO_TRANSFORM: 52,
	NORMAL_TRANSFORM: 60,
	ROUGHNESS_TRANSFORM: 68,
	METALNESS_TRANSFORM: 76,
	EMISSIVE_TRANSFORM: 84,
	BUMP_TRANSFORM: 92,
	DISPLACEMENT_TRANSFORM: 100,

	// ── Subsurface scattering (3 slots appended after transforms) ────
	// Slot 27: subsurfaceColor.rgb (scatter albedo) + subsurface weight
	SUBSURFACE_COLOR: 108, SUBSURFACE: 111,
	// Slot 28: subsurfaceRadius.rgb (mean free path) + radius scale
	SUBSURFACE_RADIUS: 112, SUBSURFACE_RADIUS_SCALE: 115,
	// Slot 29: subsurfaceAnisotropy g (116) + surface anisotropy (strength 117, rotation 118, map index 119)
	SUBSURFACE_ANISOTROPY: 116, ANISOTROPY: 117, ANISOTROPY_ROTATION: 118, ANISOTROPY_MAP_INDEX: 119,
	// Slot 30: extension-texture map indices A (transmission, clearcoat, clearcoatRoughness, sheenColor)
	TRANSMISSION_MAP_INDEX: 120, CLEARCOAT_MAP_INDEX: 121, CLEARCOAT_ROUGHNESS_MAP_INDEX: 122, SHEEN_COLOR_MAP_INDEX: 123,
	// Slot 31: extension-texture map indices B (sheenRoughness, iridescence, iridescenceThickness, specularIntensity)
	SHEEN_ROUGHNESS_MAP_INDEX: 124, IRIDESCENCE_MAP_INDEX: 125, IRIDESCENCE_THICKNESS_MAP_INDEX: 126, SPECULAR_INTENSITY_MAP_INDEX: 127,
	// Slot 32: extension-texture map index C (specularColor) + diffuseTransmissionColor.rgb
	SPECULAR_COLOR_MAP_INDEX: 128, DIFFUSE_TRANSMISSION_COLOR: 129,
	// Slot 33: extension-texture map indices D (diffuseTransmission, diffuseTransmissionColor) + the clear coat's normal
	// map index and scale; read only for a material with diffuse transmission or a coat
	DIFFUSE_TRANSMISSION_MAP_INDEX: 132, DIFFUSE_TRANSMISSION_COLOR_MAP_INDEX: 133,
	CLEARCOAT_NORMAL_MAP_INDEX: 134, CLEARCOAT_NORMAL_SCALE: 135,
	// Slot 34: bumpDistance + the bump map's own width and height + relativeIOR; read only for a bump-mapped material,
	// or a transmissive one while some material has a relative IOR
	BUMP_DISTANCE: 136, BUMP_MAP_WIDTH: 137, BUMP_MAP_HEIGHT: 138, RELATIVE_IOR: 139,

	// ── Vec4 slot indices (GPU/TSL side) ─────────────────────────────
	// Used with getDatafromStorageBuffer( buf, matIdx, int(slot), int(SLOTS_PER_MATERIAL) )
	SLOT: {
		IOR_TRANSMISSION: 0, // [shadow] ior, transmission, thickness, emissiveIntensity
		ATTENUATION: 1, // [shadow] attenuationColor, attenuationDistance
		OPACITY_ALPHA: 2, // [shadow+culling] opacity, side, transparent, alphaTest
		ALPHA_MODE: 3, // [shadow] alphaMode, depthWrite, normalScale, diffuseRoughness map index
		COLOR_METALNESS: 4, // [BxDF] color.rgb, metalness
		EMISSIVE_ROUGHNESS: 5, // [BxDF] emissive.rgb, roughness
		MAP_INDICES_A: 6, // [maps] albedo, normal, roughness, metalness
		MAP_INDICES_B: 7, // [maps] emissive, bump, clearcoat, clearcoatRoughness
		DISPERSION_SHEEN: 8, // [extended] dispersion, diffuseRoughness, sheen, sheenRoughness
		SHEEN_COLOR: 9, // [extended] sheenColor, diffuseTransmission
		SPECULAR: 10, // [extended] specularIntensity, specularColor
		IRIDESCENCE: 11, // [extended] iridescence, iridescenceIOR, iridescenceThicknessRange
		BUMP_DISPLACEMENT: 12, // bumpScale, displacementScale, displacementMapIndex, displacementBias
		ALBEDO_TRANSFORM_A: 13, ALBEDO_TRANSFORM_B: 14,
		NORMAL_TRANSFORM_A: 15, NORMAL_TRANSFORM_B: 16,
		ROUGHNESS_TRANSFORM_A: 17, ROUGHNESS_TRANSFORM_B: 18,
		METALNESS_TRANSFORM_A: 19, METALNESS_TRANSFORM_B: 20,
		EMISSIVE_TRANSFORM_A: 21, EMISSIVE_TRANSFORM_B: 22,
		BUMP_TRANSFORM_A: 23, BUMP_TRANSFORM_B: 24,
		DISPLACEMENT_TRANSFORM_A: 25, DISPLACEMENT_TRANSFORM_B: 26,
		SUBSURFACE_A: 27, // subsurfaceColor.rgb, subsurface weight
		SUBSURFACE_B: 28, // subsurfaceRadius.rgb, subsurfaceRadiusScale
		SUBSURFACE_C: 29, // subsurfaceAnisotropy g, anisotropy, anisotropyRotation, anisotropyMapIndex
		EXT_MAP_INDICES_A: 30, // transmission, clearcoat, clearcoatRoughness, sheenColor map indices
		EXT_MAP_INDICES_B: 31, // sheenRoughness, iridescence, iridescenceThickness, specularIntensity map indices
		EXT_MAP_INDICES_C: 32, // specularColor map index, diffuseTransmissionColor
		EXT_MAP_INDICES_D: 33, // diffuseTransmission, diffuseTransmissionColor, clearcoatNormal map indices, clearcoatNormalScale
		BUMP: 34, // bumpDistance, bump map width, height, relativeIOR
	},

};

// glTF/three.js spell "no volume absorption" as attenuationDistance = Infinity, while the GPU
// contract is `> 0 = on` (calculateBeerLawAbsorption). Every writer into ATTENUATION_DISTANCE
// collapses both spellings to 0 so no shader divides by Inf.
export const normalizeAttenuationDistance = d => ( Number.isFinite( d ) && d > 0 ? d : 0 );

/**
 * Node tags, written into slot [3] of a BVH node as a raw u32 bit pattern.
 *
 * Node indices, triangle offsets and counts are integers living inside a Float32Array. Written as
 * float *values* they round silently past 2^24 (16,777,216): in a 24M-node scene half of every
 * BLAS pointer landed on a neighbouring node and that geometry vanished from the render with no
 * error at all. Every one of those fields is written as a u32 bit pattern instead, exact to 2^30.
 *
 * Tags sit above {@link BVH_MAX_INDEX} so a single unsigned compare separates a leaf from an inner
 * node's left-child index. All three are ordinary finite floats — nothing lands in the NaN range,
 * which an f32 storage buffer is free to canonicalise.
 */
export const BVH_MAX_INDEX = 0x40000000; // 2^30

/**
 * Slot [1] of a BLAS-pointer leaf holds its placement index, which {@link BVH_MAX_INDEX} keeps
 * below 2^30. Bit 30 is therefore free to say the leaf's matrix is identity: geometry no other
 * placement shares is baked to world space at extraction, and a ray reaching it needs no
 * transform at all. Mask the bit off before using the slot as an index.
 */
export const TLAS_LEAF_IDENTITY = 0x40000000;
export const TLAS_PLACEMENT_MASK = 0x3fffffff;

export const BVH_LEAF_MARKERS = {
	TRIANGLE_LEAF: 0x40000000, // leaf containing triangle references
	BLAS_POINTER_LEAF: 0x40000001, // TLAS leaf pointing to a BLAS root node
	FRONTIER: 0x40000002, // parallel-build placeholder, overwritten during assembly
	CLUSTER_LEAF: 0x40000003, // TLAS leaf over up to CLUSTER_SIZE copies of one object (copy clusters)
};

// An inner node of up to four children in an object's 4-wide tree (bvh/WideBVH.js, the compact layout).
export const WIDE_NODE = 0x40000010;

/**
 * Copy clusters, for a TLAS over millions of copies: a leaf holds up to CLUSTER_SIZE neighbouring copies, and each
 * copy's world-to-object rows are a record of RECORD_VEC4 vec4s behind the BLASes (48 B, against 64 B of leaf node and
 * 64 B of inner node a copy without them). Leaf slots:
 *   0       first record | ( count − 1 ) << CLUSTER_COUNT_SHIFT; copy k's record is first + k
 *   1       byte a: the f32 exponent field of axis a's step, a power of two
 *   2, 4, 5 the union box's min (x, y, z)
 *   3       CLUSTER_LEAF
 *   6–8     copy k's box min on axis 0–2, in steps from the union's min, byte k
 *   9–11    the same for its max
 *   12 + k  copy k's object root | TLAS_LEAF_IDENTITY (its record is identity) | CLUSTER_COPY_HIDDEN
 * A traversal stack entry `COPY_ENTRY | leaf << 2 | k` enters copy k: node indices stay below it, folded leaves start at
 * 2^31, so a leaf index and a record index must each stay below 2^28.
 */
export const CLUSTER_SIZE = 4;
export const CLUSTER_FIRST_MASK = 0x0fffffff;
export const CLUSTER_COUNT_SHIFT = 28;
export const CLUSTER_ROOT_MASK = 0x3fffffff;
export const CLUSTER_COPY_HIDDEN = 0x80000000;
export const COPY_ENTRY = 0x40000000;
export const RECORD_VEC4 = 3;

/**
 * A copy record packed to 8 lanes (the compact layout): a copy is a position, a rotation and three
 * scales, so its world-to-object rows S⁻¹·Rᵀ·[ I | −t ] keep as
 *   0–2  t, the copy's origin in world space (f32)
 *   3–4  R as a unit quaternion, the largest component dropped and the other three in COMPACT_ROTATION_BITS each
 *        (≈ 1.35e-6 a step), then which one was dropped
 *   5–7  1 / scale per axis (f32), the last negative for a mirroring copy
 * Shear has no place in it (packCopyRecord returns how far the rows are from orthogonal): a copy sheared past
 * COPY_SHEAR_LIMIT keeps its 12 lanes in an overflow table behind the packed records, its slot holding the index there
 * in lane 3 and COPY_FULL_RECORD in lane 4.
 */
export const COMPACT_RECORD_LANES = 8;
const COMPACT_ROTATION_BITS = 20;
export const COPY_SHEAR_LIMIT = 1e-5;
export const COPY_FULL_RECORD = 0x80000000;
const ROTATION_MAX = ( 1 << COMPACT_ROTATION_BITS ) - 1;

/**
 * `count` copy records of 12 lanes (`src`), one job of a build spread over workers. Without `slotBase` how many are
 * sheared past COPY_SHEAR_LIMIT; with it each packed (COMPACT_RECORD_LANES), a sheared one's slot naming its whole
 * record in the overflow table from `slotBase` on, and those records (`full`) with their places (`sheared`).
 * @returns {{ sheared: number|Uint32Array, packed?: Float32Array, full?: Float32Array }}
 */
export function packCopyRange( src, count, slotBase = null ) {

	const OUT = COMPACT_RECORD_LANES, counting = slotBase === null;
	const packed = new Float32Array( counting ? OUT : count * OUT ), u = new Uint32Array( packed.buffer );
	const sheared = [];
	for ( let k = 0; k < count; k ++ ) {

		const o = counting ? 0 : k * OUT;
		if ( packCopyRecord( src, k * 12, packed, u, o ) <= COPY_SHEAR_LIMIT ) continue;
		sheared.push( k );
		if ( counting ) continue;
		packed.fill( 0, o, o + OUT );
		u[ o + 3 ] = slotBase + sheared.length - 1;
		u[ o + 4 ] = COPY_FULL_RECORD;

	}

	if ( counting ) return { sheared: sheared.length };
	const full = new Float32Array( sheared.length * 12 );
	sheared.forEach( ( k, i ) => full.set( src.subarray( k * 12, k * 12 + 12 ), i * 12 ) );
	return { packed, full, sheared: Uint32Array.from( sheared ) };

}

/** Packs the 12-lane record at `src[ so ]` into `f` / `u` (f32 and u32 views of one buffer) at `o`; returns its shear. */
export function packCopyRecord( src, so, f, u, o ) {

	// Row i of S⁻¹·Rᵀ is column i of R over scale i: R's columns are the rows made unit, n the inverse scales.
	let n0 = Math.hypot( src[ so ], src[ so + 1 ], src[ so + 2 ] ) || 1;
	const n1 = Math.hypot( src[ so + 4 ], src[ so + 5 ], src[ so + 6 ] ) || 1;
	let n2 = Math.hypot( src[ so + 8 ], src[ so + 9 ], src[ so + 10 ] ) || 1;
	const a0 = src[ so ] / n0, a1 = src[ so + 1 ] / n0, a2 = src[ so + 2 ] / n0;
	const b0 = src[ so + 4 ] / n1, b1 = src[ so + 5 ] / n1, b2 = src[ so + 6 ] / n1;
	let c0 = src[ so + 8 ] / n2, c1 = src[ so + 9 ] / n2, c2 = src[ so + 10 ] / n2;
	if ( a0 * ( b1 * c2 - b2 * c1 ) - a1 * ( b0 * c2 - b2 * c0 ) + a2 * ( b0 * c1 - b1 * c0 ) < 0 ) {

		n2 = - n2;
		c0 = - c0;
		c1 = - c1;
		c2 = - c2;

	}

	const shear = Math.max( Math.abs( a0 * b0 + a1 * b1 + a2 * b2 ), Math.abs( a0 * c0 + a1 * c1 + a2 * c2 ), Math.abs( b0 * c0 + b1 * c1 + b2 * c2 ) );

	// Quaternion of R, whose columns are a, b, c (Shepperd).
	let x, y, z, w;
	const trace = a0 + b1 + c2;
	if ( trace > 0 ) {

		const s = Math.sqrt( trace + 1 ) * 2;
		x = ( b2 - c1 ) / s; y = ( c0 - a2 ) / s; z = ( a1 - b0 ) / s; w = s / 4;

	} else if ( a0 > b1 && a0 > c2 ) {

		const s = Math.sqrt( 1 + a0 - b1 - c2 ) * 2;
		x = s / 4; y = ( b0 + a1 ) / s; z = ( c0 + a2 ) / s; w = ( b2 - c1 ) / s;

	} else if ( b1 > c2 ) {

		const s = Math.sqrt( 1 + b1 - a0 - c2 ) * 2;
		x = ( b0 + a1 ) / s; y = s / 4; z = ( c1 + b2 ) / s; w = ( c0 - a2 ) / s;

	} else {

		const s = Math.sqrt( 1 + c2 - a0 - b1 ) * 2;
		x = ( c0 + a2 ) / s; y = ( c1 + b2 ) / s; z = s / 4; w = ( a1 - b0 ) / s;

	}

	// The largest component dropped (made positive), the other three in order.
	const ax = Math.abs( x ), ay = Math.abs( y ), az = Math.abs( z ), aw = Math.abs( w );
	const big = ax >= ay && ax >= az && ax >= aw ? 0 : ay >= az && ay >= aw ? 1 : az >= aw ? 2 : 3;
	const largest = big === 0 ? x : big === 1 ? y : big === 2 ? z : w;
	const scale = ( largest < 0 ? - 1 : 1 ) / Math.hypot( x, y, z, w ) * Math.SQRT2 * 0.5 * ROTATION_MAX;
	const level = ( v ) => Math.min( ROTATION_MAX, Math.max( 0, Math.round( v * scale + 0.5 * ROTATION_MAX ) ) );
	const r0 = level( big === 0 ? y : x ), r1 = level( big <= 1 ? z : y ), r2 = level( big <= 2 ? w : z );

	// t = −R·S·w: the point the rows send to the object's origin.
	const w0 = src[ so + 3 ] / n0, w1 = src[ so + 7 ] / n1, w2 = src[ so + 11 ] / n2;
	f[ o ] = - ( a0 * w0 + b0 * w1 + c0 * w2 );
	f[ o + 1 ] = - ( a1 * w0 + b1 * w1 + c1 * w2 );
	f[ o + 2 ] = - ( a2 * w0 + b2 * w1 + c2 * w2 );
	u[ o + 3 ] = ( r0 | ( ( r1 & 0xfff ) << 20 ) ) >>> 0;
	u[ o + 4 ] = ( ( r1 >>> 12 ) | ( r2 << 8 ) | ( big << 28 ) ) >>> 0;
	f[ o + 5 ] = n0;
	f[ o + 6 ] = n1;
	f[ o + 7 ] = n2;
	return shear;

}

/** The 12-lane world-to-object rows of the packed record at `o`, into `out` from `oo`, as the GPU decodes them. */
export function unpackCopyRecord( f, u, o, out, oo = 0 ) {

	const lo = u[ o + 3 ], hi = u[ o + 4 ];
	const v = [ lo & ROTATION_MAX, ( lo >>> 20 ) | ( ( hi & 0xff ) << 12 ), ( hi >>> 8 ) & ROTATION_MAX ].map( ( x ) => ( x * ( 2 / ROTATION_MAX ) - 1 ) * Math.SQRT1_2 );
	const big = Math.sqrt( Math.max( 0, 1 - v[ 0 ] * v[ 0 ] - v[ 1 ] * v[ 1 ] - v[ 2 ] * v[ 2 ] ) );
	const q = v.slice();
	q.splice( hi >>> 28, 0, big );
	const [ x, y, z, qw ] = q;
	const cols = [
		[ 1 - 2 * ( y * y + z * z ), 2 * ( x * y + qw * z ), 2 * ( x * z - qw * y ) ],
		[ 2 * ( x * y - qw * z ), 1 - 2 * ( x * x + z * z ), 2 * ( y * z + qw * x ) ],
		[ 2 * ( x * z + qw * y ), 2 * ( y * z - qw * x ), 1 - 2 * ( x * x + y * y ) ],
	];
	for ( let i = 0; i < 3; i ++ ) {

		const r = cols[ i ].map( ( c ) => c * f[ o + 5 + i ] );
		out.set( [ ...r, - ( r[ 0 ] * f[ o ] + r[ 1 ] * f[ o + 1 ] + r[ 2 ] * f[ o + 2 ] ) ], oo + i * 4 );

	}

	return out;

}

const _f32 = new Float32Array( 1 );
const _u32 = new Uint32Array( _f32.buffer );

/** The f32 nearest `x` that is not above it. */
function f32Down( x ) {

	const f = Math.fround( x );
	if ( f <= x ) return f;
	_f32[ 0 ] = f;
	_u32[ 0 ] += f > 0 ? - 1 : 1;
	return _f32[ 0 ];

}

/** Four f32 steps at the larger magnitude of `a` and `b`: what an f32 sum near them can be off by, with room. */
function f32Pad( a, b ) {

	return Math.max( Math.abs( a ), Math.abs( b ), 1e-30 ) * 2 ** - 21;

}

const BASE_SLOT = [ 2, 4, 5 ];

/**
 * A cluster leaf's boxes (slots 1, 2 and 4–11 at float offset `o`): the union of `count` copies' world boxes (`boxes`,
 * 6 a copy), then each as bytes of it. Everything is rounded outward by a few f32 steps of its own size, so the GPU's
 * f32 decode never culls a copy from a ray that reaches it — far from the origin a byte step can be finer than one f32
 * step. The exact union goes to `out` at `outOff`.
 */
export function encodeClusterBoxes( data, idx, o, boxes, count, out, outOff ) {

	let exponents = 0;
	for ( let a = 0; a < 3; a ++ ) {

		let lo = Infinity, hi = - Infinity;
		for ( let k = 0; k < count; k ++ ) {

			lo = Math.min( lo, boxes[ k * 6 + a ] );
			hi = Math.max( hi, boxes[ k * 6 + 3 + a ] );

		}

		if ( out ) {

			out[ outOff + a ] = lo;
			out[ outOff + 3 + a ] = hi;

		}

		// Every copy hidden (a group's members all are): the far point box no ray enters.
		if ( ! ( lo <= hi ) ) {

			data[ o + BASE_SLOT[ a ] ] = BVH_EMPTY_BOX;
			idx[ o + 6 + a ] = 0;
			idx[ o + 9 + a ] = 0;
			continue;

		}

		const pad = f32Pad( lo, hi );
		const base = f32Down( lo - pad );
		let e = Math.max( - 126, Math.ceil( Math.log2( ( hi + pad - base ) / 255 ) ) );
		while ( Math.fround( base + 255 * 2 ** e ) < hi + pad ) e ++;
		const step = 2 ** e;
		data[ o + BASE_SLOT[ a ] ] = base;
		exponents |= ( e + 127 ) << ( a * 8 );
		let qLo = 0, qHi = 0;
		for ( let k = 0; k < count; k ++ ) {

			const kLo = boxes[ k * 6 + a ], kHi = boxes[ k * 6 + 3 + a ];
			const kPad = f32Pad( kLo, kHi );
			qLo |= Math.max( 0, Math.min( 255, Math.floor( ( kLo - kPad - base ) / step ) ) ) << ( k * 8 );
			qHi |= Math.max( 0, Math.min( 255, Math.ceil( ( kHi + kPad - base ) / step ) ) ) << ( k * 8 );

		}

		idx[ o + 6 + a ] = qLo >>> 0;
		idx[ o + 9 + a ] = qHi >>> 0;

	}

	idx[ o + 1 ] = exponents >>> 0;

}

/**
 * A triangle leaf of at most this many triangles is folded into its parent: the child's slot ([3]
 * or [7]) holds `~( first << 4 | count )`, the very value traversal pushes, so an inner node is
 * read exactly as before and only popping a negative entry differs. Node indices stay below
 * {@link BVH_MAX_INDEX}, leaf tags between it and 2^31, folded leaves from 2^31 up — so the count
 * has four bits and the first triangle must stay below {@link BVH_FOLDED_FIRST_LIMIT}.
 */
export const BVH_FOLDED_LEAF_MAX = 15;
export const BVH_FOLDED_FIRST_LIMIT = 1 << 27;

/**
 * A child no ray may enter — a hidden part of a grouped object — is stored as a point box this far out: its distance
 * along any ray exceeds every hit, so it is never pushed. Refits read it back as empty. An inverted box (min > max)
 * will not do: the slab test swaps the planes and the ray enters it everywhere.
 */
export const BVH_EMPTY_BOX = 1e30;

/** A u32 view over a float buffer, for writing index fields as exact bit patterns. */
export function bvhIndexView( f32 ) {

	return new Uint32Array( f32.buffer, f32.byteOffset, f32.length );

}

/**
 * Refuse to build a BVH whose indices would collide with the leaf tags.
 *
 * Throws rather than degrades: the failure this replaces was a scene that rendered with half its
 * geometry silently missing, which is far worse than a scene that refuses to load. Guarding the
 * totals covers every individual write, since no index can exceed the count it indexes into.
 *
 * @param {number} count - node or triangle total about to be indexed
 * @param {string} what - what the count is, for the message
 * @throws {RangeError}
 */
export function assertBVHIndexFits( count, what ) {

	if ( count >= BVH_MAX_INDEX ) {

		throw new RangeError(
			`${what} is ${count.toLocaleString()}, at or past the BVH index limit of ` +
			`${BVH_MAX_INDEX.toLocaleString()}. Node indices are stored as u32 bit patterns and the ` +
			'leaf tags occupy everything above that.'
		);

	}

	return count;

}
