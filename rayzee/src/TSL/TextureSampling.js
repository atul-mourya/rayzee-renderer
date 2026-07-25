import { Fn, wgslFn, float, vec2, vec3, vec4, int, If, normalize, cross, abs, atan, mix, clamp, texture, textureSize } from 'three/tsl';
import { DataArrayTexture, LinearFilter } from 'three';

import {
	UVCache,
	MaterialSamples,
	ExtMapResult,
} from './Struct.js';
import { TEXTURE_CONSTANTS } from '../EngineDefaults.js';

// ================================================================================
// CONSOLIDATED SIZE-BUCKETED MATERIAL TEXTURES
// ================================================================================
// Material maps are packed into two colorSpace pools (sRGB: albedo+emissive; linear:
// normal/bump/roughness/metalness/displacement), each split into MATERIAL_BUCKET_COUNT
// longest-edge size buckets so a small map no longer pays a large neighbour's footprint.
// A map's stored index encodes (bucket, layer) as bucket * BUCKET_LAYER_STRIDE + layer.
//
// The bucket texture nodes live at module level (same pattern as gobo/IES/shadowAlbedo):
// each stage sets them via setMaterialBucketTextures() right before building its graph,
// so each pipeline bakes in its own fresh nodes (avoiding cross-pipeline TextureNode
// caching, just like the per-type nodes did before).

const _STRIDE = TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE;

// Array<MATERIAL_BUCKET_COUNT> of texture nodes (never null — empty buckets get placeholders).
let _srgbBuckets = null;
let _linearBuckets = null;

/**
 * Set the bucket texture node arrays read by the sampling functions. Call before building
 * any graph that samples material textures (Shade / NormalDepth / Debug kernels).
 * @param {Array} srgb   sRGB pool nodes (albedo + emissive)
 * @param {Array} linear linear pool nodes (normal/bump/roughness/metalness/displacement)
 */
export function setMaterialBucketTextures( srgb, linear ) {

	_srgbBuckets = srgb;
	_linearBuckets = linear;

}

// Run `fn(node, layer)` inside a runtime branch that selects the bucket node a packed
// index points to. Emits one If/ElseIf arm per bucket; only the matching arm executes.
// Caller must guard packedIndex >= 0.
const withBucket = ( buckets, packedIndex, fn ) => {

	const bucket = packedIndex.div( int( _STRIDE ) ).toVar();
	const layer = packedIndex.sub( bucket.mul( int( _STRIDE ) ) ).toVar();
	// Block bodies, not concise arrows: an If() callback that yields a value makes TSL emit a
	// `return` inside an inline Fn(), which it comments out and warns about on every arm.
	let chain = If( bucket.equal( int( 0 ) ), () => {

		fn( buckets[ 0 ], layer );

	} );
	for ( let i = 1; i < buckets.length; i ++ ) {

		chain = chain.ElseIf( bucket.equal( int( i ) ), () => {

			fn( buckets[ i ], layer );

		} );

	}

	return chain;

};

// Sample the bucket a packed index points to. Caller must guard packedIndex >= 0.
export const sampleBucket = ( buckets, packedIndex, uv ) => {

	const result = vec4( 0.0 ).toVar();
	withBucket( buckets, packedIndex, ( node, layer ) => result.assign( texture( node, uv ).depth( layer ) ) );
	return result;

};

// Per-axis texel size (1/dims) of the bucket a packed displacement/bump index points to,
// for finite-difference derivative steps. Caller must guard packedIndex >= 0.
export const bucketTexelSize = ( buckets, packedIndex ) => {

	const ts = vec2( 1.0 ).toVar();
	withBucket( buckets, packedIndex, node => ts.assign( vec2( 1.0 ).div( vec2( textureSize( node ) ) ) ) );
	return ts;

};

// The linear-pool node set (displacement lives here) — for Displacement.js texel sizing.
export function getLinearBucketTextures() {

	return _linearBuckets;

}

// 1×1 white placeholder array so empty-bucket branches always reference a valid node.
export function makeBucketPlaceholder() {

	const t = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
	t.minFilter = LinearFilter;
	t.magFilter = LinearFilter;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return t;

}

// Build MATERIAL_BUCKET_COUNT texture nodes from a bucket array (DataArrayTexture | null per
// bucket). Null buckets get a fresh placeholder. Each caller builds its OWN nodes so each
// pipeline bakes in independent TextureNodes (no cross-pipeline caching).
export function buildBucketTextureNodes( bucketArrays ) {

	const K = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT;
	const nodes = [];
	for ( let i = 0; i < K; i ++ ) {

		const arr = bucketArrays && bucketArrays[ i ];
		nodes.push( texture( arr || makeBucketPlaceholder() ) );

	}

	return nodes;

}

// Update in-place the .value of bucket nodes from a fresh bucket array (model change).
export function refreshBucketTextureNodes( nodes, bucketArrays ) {

	if ( ! nodes || ! bucketArrays ) return;
	for ( let i = 0; i < nodes.length; i ++ ) {

		if ( bucketArrays[ i ] && nodes[ i ] ) nodes[ i ].value = bucketArrays[ i ];

	}

}

// ================================================================================
// FAST UTILITY FUNCTIONS
// ================================================================================

export const isIdentityTransform = /*@__PURE__*/ wgslFn( `
	fn isIdentityTransform( transform: mat3x3f ) -> bool {
		return transform[0][0] == 1.0f
			&& transform[1][1] == 1.0f
			&& transform[0][1] == 0.0f
			&& transform[1][0] == 0.0f
			&& transform[2][0] == 0.0f
			&& transform[2][1] == 0.0f;
	}
` );

export const getTransformedUV = /*@__PURE__*/ wgslFn( `
	fn getTransformedUV( uv: vec2f, transform: mat3x3f ) -> vec2f {
		if ( !isIdentityTransform( transform ) ) {
			return fract( vec2f(
				transform[0][0] * uv.x + transform[1][0] * uv.y + transform[2][0],
				transform[0][1] * uv.x + transform[1][1] * uv.y + transform[2][1]
			) );
		}
		return uv;
	}
`, [ isIdentityTransform ] );

export const materialHasTextures = Fn( ( [ material ] ) => {

	return material.albedoMapIndex.greaterThanEqual( int( 0 ) )
		.or( material.normalMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.roughnessMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.emissiveMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.bumpMapIndex.greaterThanEqual( int( 0 ) ) )
		.or( material.displacementMapIndex.greaterThanEqual( int( 0 ) ) );

} );

// Fast transform hash for equality checking
export const hashTransform = /*@__PURE__*/ wgslFn( `
	fn hashTransform( t: mat3x3f ) -> f32 {
		return t[0][0] + t[1][1] * 7.0f + t[2][0] * 13.0f + t[2][1] * 17.0f;
	}
` );

// Fast transform equality using hash comparison
export const transformsEqual = /*@__PURE__*/ wgslFn( `
	fn transformsEqual( a: mat3x3f, b: mat3x3f ) -> i32 {
		let hashA = hashTransform( a );
		let hashB = hashTransform( b );
		if ( abs( hashA - hashB ) < 0.001f ) {
			if ( abs( a[0][0] - b[0][0] ) < 0.001f
				&& abs( a[1][1] - b[1][1] ) < 0.001f
				&& abs( a[2][0] - b[2][0] ) < 0.001f
				&& abs( a[2][1] - b[2][1] ) < 0.001f ) {
				return 1;
			}
		}
		return 0;
	}
`, [ hashTransform ] );

// ================================================================================
// OPTIMIZED UV CACHE WITH REDUNDANCY DETECTION
// ================================================================================

export const computeUVCache = Fn( ( [ baseUV, material ] ) => {

	// Pre-compute transform hashes for batch comparison
	const albedoHash = hashTransform( { t: material.albedoTransform } ).toVar();
	const normalHash = hashTransform( { t: material.normalTransform } ).toVar();
	const metalnessHash = hashTransform( { t: material.metalnessTransform } ).toVar();
	const roughnessHash = hashTransform( { t: material.roughnessTransform } ).toVar();
	const emissiveHash = hashTransform( { t: material.emissiveTransform } ).toVar();
	const bumpHash = hashTransform( { t: material.bumpTransform } ).toVar();

	const HASH_TOLERANCE = 0.001;
	const albedoNormalSame = abs( albedoHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const normalBumpSame = abs( normalHash.sub( bumpHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const metalRoughSame = abs( metalnessHash.sub( roughnessHash ) ).lessThan( HASH_TOLERANCE ).toVar();
	const albedoEmissiveSame = abs( albedoHash.sub( emissiveHash ) ).lessThan( HASH_TOLERANCE ).toVar();

	const allSameUV = albedoNormalSame
		.and( abs( albedoHash.sub( metalnessHash ) ).lessThan( HASH_TOLERANCE ) )
		.and( abs( albedoHash.sub( emissiveHash ) ).lessThan( HASH_TOLERANCE ) )
		.and( abs( albedoHash.sub( bumpHash ) ).lessThan( HASH_TOLERANCE ) )
		.toVar();

	const albedoUV = vec2( 0.0 ).toVar();
	const normalUV = vec2( 0.0 ).toVar();
	const metalnessUV = vec2( 0.0 ).toVar();
	const roughnessUV = vec2( 0.0 ).toVar();
	const emissiveUV = vec2( 0.0 ).toVar();
	const bumpUV = vec2( 0.0 ).toVar();
	const normalBumpSameUV = normalBumpSame.or( allSameUV );
	const metalRoughSameUV = metalRoughSame.or( allSameUV );
	const albedoEmissiveSameUV = albedoEmissiveSame.or( allSameUV );

	If( allSameUV, () => {

		const sharedUV = getTransformedUV( { uv: baseUV, transform: material.albedoTransform } );
		albedoUV.assign( sharedUV );
		normalUV.assign( sharedUV );
		metalnessUV.assign( sharedUV );
		roughnessUV.assign( sharedUV );
		emissiveUV.assign( sharedUV );
		bumpUV.assign( sharedUV );

	} ).Else( () => {

		// Always compute albedo as reference
		albedoUV.assign( getTransformedUV( { uv: baseUV, transform: material.albedoTransform } ) );

		// Reuse albedo UV for matching hashes
		normalUV.assign( albedoNormalSame.select( albedoUV, getTransformedUV( { uv: baseUV, transform: material.normalTransform } ) ) );
		emissiveUV.assign( albedoEmissiveSame.select( albedoUV, getTransformedUV( { uv: baseUV, transform: material.emissiveTransform } ) ) );

		// Handle bump UV with dependency chain optimization
		If( normalBumpSame, () => {

			bumpUV.assign( normalUV );

		} ).ElseIf( abs( bumpHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

			bumpUV.assign( albedoUV );

		} ).Else( () => {

			bumpUV.assign( getTransformedUV( { uv: baseUV, transform: material.bumpTransform } ) );

		} );

		// Handle metalness/roughness pair
		If( metalRoughSame, () => {

			metalnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.metalnessTransform } ) );
			roughnessUV.assign( metalnessUV );

		} ).Else( () => {

			If( abs( metalnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( albedoUV );

			} ).ElseIf( abs( metalnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				metalnessUV.assign( normalUV );

			} ).Else( () => {

				metalnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.metalnessTransform } ) );

			} );

			If( abs( roughnessHash.sub( albedoHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( albedoUV );

			} ).ElseIf( abs( roughnessHash.sub( normalHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( normalUV );

			} ).ElseIf( abs( roughnessHash.sub( metalnessHash ) ).lessThan( HASH_TOLERANCE ), () => {

				roughnessUV.assign( metalnessUV );

			} ).Else( () => {

				roughnessUV.assign( getTransformedUV( { uv: baseUV, transform: material.roughnessTransform } ) );

			} );

		} );

	} );

	return UVCache( {
		albedoUV,
		normalUV,
		metalnessUV,
		roughnessUV,
		emissiveUV,
		bumpUV,
		allSameUV,
		normalBumpSameUV,
		metalRoughSameUV,
		albedoEmissiveSameUV,
	} );

} );

// ================================================================================
// PROCESSING FUNCTIONS
// ================================================================================

export const processAlbedo = Fn( ( [ material, uvCache ] ) => {

	const result = material.color.toVar();

	If( material.albedoMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const albedoSample = sampleBucket( _srgbBuckets, material.albedoMapIndex, uvCache.albedoUV ).toVar();
		// sRGB→linear handled by GPU hardware (sRGB bucket arrays carry SRGBColorSpace → rgba8unorm-srgb)
		result.assign( vec4( material.color.rgb.mul( albedoSample.rgb ), material.color.a.mul( albedoSample.a ) ) );

	} );

	return result;

} );

export const processMetalnessRoughness = Fn( ( [ material, uvCache ] ) => {

	const metalness = material.metalness.toVar();
	const roughness = material.roughness.toVar();

	If( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ).and( material.metalnessMapIndex.equal( material.roughnessMapIndex ) ), () => {

		// Same packed index → same bucket layer (e.g. ORM) → sample once.
		const sample = sampleBucket( _linearBuckets, material.metalnessMapIndex, uvCache.metalnessUV );
		metalness.assign( material.metalness.mul( sample.b ) );
		roughness.assign( material.roughness.mul( sample.g ) );

	} ).Else( () => {

		If( material.metalnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

			const metSample = sampleBucket( _linearBuckets, material.metalnessMapIndex, uvCache.metalnessUV );
			metalness.assign( material.metalness.mul( metSample.b ) );

		} );

		If( material.roughnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

			const rghSample = sampleBucket( _linearBuckets, material.roughnessMapIndex, uvCache.roughnessUV );
			roughness.assign( material.roughness.mul( rghSample.g ) );

		} );

	} );

	return vec2( metalness, roughness );

} );

export const processNormal = Fn( ( [ geometryNormal, material, uvCache ] ) => {

	const result = geometryNormal.toVar();

	If( material.normalMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const normalSample = sampleBucket( _linearBuckets, material.normalMapIndex, uvCache.normalUV );
		const normalMap = normalSample.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
		normalMap.x.mulAssign( material.normalScale.x );
		normalMap.y.assign( normalMap.y.negate().mul( material.normalScale.x ) );

		// Fast TBN construction
		const up = abs( geometryNormal.z ).lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, geometryNormal ) );
		const bitangent = cross( geometryNormal, tangent );

		result.assign( normalize(
			tangent.mul( normalMap.x ).add( bitangent.mul( normalMap.y ) ).add( geometryNormal.mul( normalMap.z ) )
		) );

	} );

	return result;

} );

export const processBump = Fn( ( [ currentNormal, material, uvCache ] ) => {

	const result = currentNormal.toVar();

	If( material.bumpMapIndex.greaterThanEqual( int( 0 ) ).and( material.bumpScale.greaterThan( 0.0 ) ), () => {

		// Taps + texel size come from the SELECTED bucket node (its real dimensions), so the
		// finite-difference step is correct per bucket — done inside one bucket-branch.
		const bumpNormal = vec3( 0.0, 0.0, 1.0 ).toVar();
		withBucket( _linearBuckets, material.bumpMapIndex, ( node, layer ) => {

			const texelSize = vec2( 1.0 ).div( vec2( textureSize( node ) ) ).toVar();
			const h_c = texture( node, uvCache.bumpUV ).depth( layer ).r;
			const h_u = texture( node, vec2( uvCache.bumpUV.x.add( texelSize.x ), uvCache.bumpUV.y ) ).depth( layer ).r;
			const h_v = texture( node, vec2( uvCache.bumpUV.x, uvCache.bumpUV.y.add( texelSize.y ) ) ).depth( layer ).r;
			const gradient = vec2( h_u.sub( h_c ), h_v.sub( h_c ) ).mul( material.bumpScale );
			bumpNormal.assign( normalize( vec3( gradient.x.negate(), gradient.y.negate(), 1.0 ) ) );

		} );

		// Build TBN matrix using current normal
		const up = abs( currentNormal.z ).lessThan( 0.999 ).select( vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, currentNormal ) );
		const bitangent = cross( currentNormal, tangent );

		const perturbedNormal = tangent.mul( bumpNormal.x ).add( bitangent.mul( bumpNormal.y ) ).add( currentNormal.mul( bumpNormal.z ) );
		result.assign( normalize( mix( currentNormal, perturbedNormal, clamp( material.bumpScale, 0.0, 1.0 ) ) ) );

	} );

	return result;

} );

// Fold the glTF anisotropyTexture (RG = tangent-space direction, B = strength) into scalar
// (strength, rotationRadians) per three.js: anisotropy · R(rotation) · (normalize(rg·2−1)·b).
// Caller guarantees anisotropyMapIndex >= 0. `uv` is pre-transformed by the caller (albedo transform).
export const processAnisotropyMap = Fn( ( [ material, uv ] ) => {

	const result = vec2( material.anisotropy, material.anisotropyRotation ).toVar();

	const s = sampleBucket( _linearBuckets, material.anisotropyMapIndex, uv ).toVar();
	const texDir = s.rg.mul( 2.0 ).sub( 1.0 ).toVar();
	const dlen = texDir.length().toVar();

	If( dlen.greaterThan( 1e-4 ), () => {

		const u = texDir.div( dlen ).mul( s.b ).toVar(); // unit direction × texture strength
		const c = material.anisotropyRotation.cos();
		const sn = material.anisotropyRotation.sin();
		const vx = material.anisotropy.mul( c.mul( u.x ).sub( sn.mul( u.y ) ) );
		const vy = material.anisotropy.mul( sn.mul( u.x ).add( c.mul( u.y ) ) );
		result.assign( vec2( clamp( vx.mul( vx ).add( vy.mul( vy ) ).sqrt(), 0.0, 1.0 ), atan( vy, vx ) ) );

	} ).Else( () => {

		result.assign( vec2( 0.0, material.anisotropyRotation ) );

	} );

	return result;

} );

// Fold the glTF extension textures into their scalar factors, per KHR_materials_* / three.js
// channel conventions. Returns the modulated scalars (unchanged where a map is absent). `uv` is
// pre-transformed by the caller with the material's albedo KHR_texture_transform (extension maps
// share the base UV set/transform in practice). Color maps (sheenColor, specularColor) read the
// sRGB pool; data maps read the linear pool.
export const applyExtensionMaps = Fn( ( [ material, uv ] ) => {

	const r = ExtMapResult( {
		transmission: material.transmission,
		clearcoat: material.clearcoat,
		clearcoatRoughness: material.clearcoatRoughness,
		sheenColor: material.sheenColor,
		sheenRoughness: material.sheenRoughness,
		iridescence: material.iridescence,
		iridescenceThickness: material.iridescenceThicknessRange.y, // default = max (no-texture behavior)
		specularIntensity: material.specularIntensity,
		specularColor: material.specularColor,
	} ).toVar();

	If( material.transmissionMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.transmission.assign( r.transmission.mul( sampleBucket( _linearBuckets, material.transmissionMapIndex, uv ).r ) );

	} );
	If( material.clearcoatMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.clearcoat.assign( r.clearcoat.mul( sampleBucket( _linearBuckets, material.clearcoatMapIndex, uv ).r ) );

	} );
	If( material.clearcoatRoughnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.clearcoatRoughness.assign( r.clearcoatRoughness.mul( sampleBucket( _linearBuckets, material.clearcoatRoughnessMapIndex, uv ).g ) );

	} );
	If( material.sheenColorMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.sheenColor.assign( r.sheenColor.mul( sampleBucket( _srgbBuckets, material.sheenColorMapIndex, uv ).rgb ) );

	} );
	If( material.sheenRoughnessMapIndex.greaterThanEqual( int( 0 ) ), () => {

		// clamp to [0.05,1] to keep parity with the sample/PDF floor applied in ShadeKernel
		r.sheenRoughness.assign( clamp( r.sheenRoughness.mul( sampleBucket( _linearBuckets, material.sheenRoughnessMapIndex, uv ).a ), 0.05, 1.0 ) );

	} );
	If( material.iridescenceMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.iridescence.assign( r.iridescence.mul( sampleBucket( _linearBuckets, material.iridescenceMapIndex, uv ).r ) );

	} );
	If( material.iridescenceThicknessMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const g = sampleBucket( _linearBuckets, material.iridescenceThicknessMapIndex, uv ).g;
		r.iridescenceThickness.assign( mix( material.iridescenceThicknessRange.x, material.iridescenceThicknessRange.y, g ) );

	} );
	If( material.specularIntensityMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.specularIntensity.assign( r.specularIntensity.mul( sampleBucket( _linearBuckets, material.specularIntensityMapIndex, uv ).a ) );

	} );
	If( material.specularColorMapIndex.greaterThanEqual( int( 0 ) ), () => {

		r.specularColor.assign( r.specularColor.mul( sampleBucket( _srgbBuckets, material.specularColorMapIndex, uv ).rgb ) );

	} );

	return r;

} );

export const processEmissive = Fn( ( [ material, uvCache ] ) => {

	const emissionBase = material.emissive.mul( material.emissiveIntensity ).toVar();

	If( material.emissiveMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const emissiveSample = sampleBucket( _srgbBuckets, material.emissiveMapIndex, uvCache.emissiveUV ).toVar();
		// sRGB→linear handled by GPU hardware (sRGB bucket arrays carry SRGBColorSpace → rgba8unorm-srgb)
		emissionBase.assign( emissionBase.mul( emissiveSample.rgb ) );

	} );

	return emissionBase;

} );

// ================================================================================
// MAIN BATCHED SAMPLING FUNCTION
// ================================================================================

export const sampleAllMaterialTextures = Fn( ( [ material, uv, geometryNormal ] ) => {

	const albedo = vec4( 0.0 ).toVar();
	const emissive = vec3( 0.0 ).toVar();
	const metalness = float( 0.0 ).toVar();
	const roughness = float( 0.0 ).toVar();
	const normal = vec3( 0.0 ).toVar();
	const hasTextures = materialHasTextures( material ).toVar();

	// Always use base material values first
	albedo.assign( material.color );
	emissive.assign( material.emissive.mul( material.emissiveIntensity ) );
	metalness.assign( material.metalness );
	roughness.assign( material.roughness );
	normal.assign( geometryNormal );

	If( hasTextures, () => {

		// Compute optimized UV cache with redundancy detection
		const uvCache = UVCache.wrap( computeUVCache( uv, material ) ).toVar();

		// Process samples (bucket nodes read from module-level state)
		albedo.assign( processAlbedo( material, uvCache ) );

		const metalRough = processMetalnessRoughness( material, uvCache );
		metalness.assign( metalRough.x );
		roughness.assign( metalRough.y );

		const currentNormal = processNormal( geometryNormal, material, uvCache ).toVar();
		normal.assign( processBump( currentNormal, material, uvCache ) );

		emissive.assign( processEmissive( material, uvCache ) );

	} );

	return MaterialSamples( { albedo, emissive, metalness, roughness, normal, hasTextures } );

} );

// Sample displacement map (linear pool) at given UV coordinates.
export const sampleDisplacementMap = Fn( ( [ displacementMapIndex, uv, transform ] ) => {

	const result = float( 0.0 ).toVar();

	If( displacementMapIndex.greaterThanEqual( int( 0 ) ), () => {

		const transformedUV = getTransformedUV( { uv, transform } );
		result.assign( sampleBucket( _linearBuckets, displacementMapIndex, transformedUV ).r );

	} );

	return result;

} );
