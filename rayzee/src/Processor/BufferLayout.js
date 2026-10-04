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
	MATERIAL_FLAGS_OFFSET: 18, // materialIndex | side << 24 | shadowBlockerBits << 26 (two bits)
	MESH_INDEX_OFFSET: 19
};

export const TRI_MATERIAL_MASK = 0xffffff;
export const TRI_SIDE_SHIFT = 24; // 0 front, 1 back, 2 double
export const TRI_BLOCKER_SHIFT = 26; // 1 = blocks shadow rays whatever the settings
export const TRI_BLOCKER_ALPHA_SHIFT = 27; // 1 = blocks them unless alpha-cutout shadows are on

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
 * material buffer: `side` for inline culling and the two shadow-blocker bits.
 */
export function packTriangleFlags( materialIndex, material ) {

	return ( ( materialIndex & TRI_MATERIAL_MASK )
		| ( ( material?.side ?? 0 ) << TRI_SIDE_SHIFT )
		| ( shadowBlockerBits( material ) << TRI_BLOCKER_SHIFT ) ) >>> 0;

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

	SLOTS_PER_MATERIAL: 34, // vec4 slots per material
	FLOATS_PER_MATERIAL: 136, // total floats per material (34 × 4)

	// ── Flat float offsets (CPU side) ────────────────────────────────
	// Used as: data[ materialIndex * FLOATS_PER_MATERIAL + offset ]
	// Ordered for cache-line coherence: shadow/culling → BxDF core → maps → extended → transforms

	// Slot 0: ior + transmission + thickness + emissiveIntensity   [shadow]
	IOR: 0, TRANSMISSION: 1, THICKNESS: 2, EMISSIVE_INTENSITY: 3,
	// Slot 1: attenuationColor.rgb + attenuationDistance            [shadow]
	ATTENUATION_COLOR: 4, ATTENUATION_DISTANCE: 7,
	// Slot 2: opacity + side + transparent + alphaTest              [shadow + culling]
	OPACITY: 8, SIDE: 9, TRANSPARENT: 10, ALPHA_TEST: 11,
	// Slot 3: alphaMode + depthWrite + normalScale                  [shadow]
	ALPHA_MODE: 12, DEPTH_WRITE: 13, NORMAL_SCALE: 14,
	// Slot 4: color.rgb + metalness                                 [BxDF core]
	COLOR: 16, METALNESS: 19,
	// Slot 5: emissive.rgb + roughness                              [BxDF core]
	EMISSIVE: 20, ROUGHNESS: 23,
	// Slot 6: map indices (albedo, normal, roughness, metalness)    [maps]
	ALBEDO_MAP_INDEX: 24, NORMAL_MAP_INDEX: 25, ROUGHNESS_MAP_INDEX: 26, METALNESS_MAP_INDEX: 27,
	// Slot 7: map indices (emissive, bump) + clearcoat              [maps]
	EMISSIVE_MAP_INDEX: 28, BUMP_MAP_INDEX: 29, CLEARCOAT: 30, CLEARCOAT_ROUGHNESS: 31,
	// Slot 8: dispersion + visible + sheen + sheenRoughness         [extended BxDF]
	DISPERSION: 32, VISIBLE: 33, SHEEN: 34, SHEEN_ROUGHNESS: 35,
	// Slot 9: sheenColor.rgb + diffuseTransmission                 [extended BxDF]
	SHEEN_COLOR: 36, DIFFUSE_TRANSMISSION: 39,
	// Slot 10: specularIntensity + specularColor.rgb                [extended BxDF]
	SPECULAR_INTENSITY: 40, SPECULAR_COLOR: 41,
	// Slot 11: iridescence + iridescenceIOR + iridescenceThicknessRange [extended BxDF]
	IRIDESCENCE: 44, IRIDESCENCE_IOR: 45, IRIDESCENCE_THICKNESS_RANGE: 46,
	// Slot 12: bumpScale + displacementScale + displacementMapIndex + (padding)
	BUMP_SCALE: 48, DISPLACEMENT_SCALE: 49, DISPLACEMENT_MAP_INDEX: 50,

	// ── Transform float offsets (8 floats each: 7 matrix values + 1 padding) ──
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
	// Slot 33: extension-texture map indices D (diffuseTransmission, diffuseTransmissionColor) + 2 reserved;
	// read only for a material with diffuse transmission
	DIFFUSE_TRANSMISSION_MAP_INDEX: 132, DIFFUSE_TRANSMISSION_COLOR_MAP_INDEX: 133,

	// ── Vec4 slot indices (GPU/TSL side) ─────────────────────────────
	// Used with getDatafromStorageBuffer( buf, matIdx, int(slot), int(SLOTS_PER_MATERIAL) )
	SLOT: {
		IOR_TRANSMISSION: 0, // [shadow] ior, transmission, thickness, emissiveIntensity
		ATTENUATION: 1, // [shadow] attenuationColor, attenuationDistance
		OPACITY_ALPHA: 2, // [shadow+culling] opacity, side, transparent, alphaTest
		ALPHA_MODE: 3, // [shadow] alphaMode, depthWrite, normalScale
		COLOR_METALNESS: 4, // [BxDF] color.rgb, metalness
		EMISSIVE_ROUGHNESS: 5, // [BxDF] emissive.rgb, roughness
		MAP_INDICES_A: 6, // [maps] albedo, normal, roughness, metalness
		MAP_INDICES_B: 7, // [maps] emissive, bump, clearcoat, clearcoatRoughness
		DISPERSION_SHEEN: 8, // [extended] dispersion, visible, sheen, sheenRoughness
		SHEEN_COLOR: 9, // [extended] sheenColor, diffuseTransmission
		SPECULAR: 10, // [extended] specularIntensity, specularColor
		IRIDESCENCE: 11, // [extended] iridescence, iridescenceIOR, iridescenceThicknessRange
		BUMP_DISPLACEMENT: 12, // bumpScale, displacementScale, displacementMapIndex
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
		EXT_MAP_INDICES_D: 33, // diffuseTransmission, diffuseTransmissionColor map indices + 2 reserved
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
};

/**
 * A triangle leaf of at most this many triangles is folded into its parent: the child's slot ([3]
 * or [7]) holds `~( first << 4 | count )`, the very value traversal pushes, so an inner node is
 * read exactly as before and only popping a negative entry differs. Node indices stay below
 * {@link BVH_MAX_INDEX}, leaf tags between it and 2^31, folded leaves from 2^31 up — so the count
 * has four bits and the first triangle must stay below {@link BVH_FOLDED_FIRST_LIMIT}.
 */
export const BVH_FOLDED_LEAF_MAX = 15;
export const BVH_FOLDED_FIRST_LIMIT = 1 << 27;

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
