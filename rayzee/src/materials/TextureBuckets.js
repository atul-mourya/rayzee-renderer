// Texture processing constants
export const TEXTURE_CONSTANTS = {
	VEC4_PER_BVH_NODE: 4,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: Math.min( typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4, 6 ),
	BUFFER_POOL_SIZE: 20,
	CANVAS_POOL_SIZE: 12,
	CACHE_SIZE_LIMIT: 50,
	// Hardware ceiling for a single texture-array dimension (WebGPU maxTextureDimension2D
	// guaranteed minimum). The configurable maxTextureSize setting is clamped to this.
	MAX_TEXTURE_SIZE: 8192,
	// Default cap applied when no maxTextureSize is supplied (engine standalone use).
	DEFAULT_MAX_TEXTURE_SIZE: 4096,
	// Per-map-type ceiling before bucketing; the real cap is per (pool, bucket) in _bucketTextures.
	MAX_TEXTURES_LIMIT: 4 * 256,
	// Array shapes per colorSpace pool. Material maps are grouped into this many
	// (width, height) classes so a small or oddly-shaped map no longer pays a large
	// neighbour's footprint. 4 → ~8 bound material arrays (4 sRGB + 4 linear).
	MATERIAL_BUCKET_COUNT: 4,
	// Packing stride: a map's stored index encodes bucketId * BUCKET_LAYER_STRIDE + layer.
	// Also the per-bucket layer cap. Kept at the WebGPU portable maxTextureArrayLayers floor (256)
	// so a consolidated bucket (which merges several map types of one size) stays portable.
	BUCKET_LAYER_STRIDE: 256,
};

// An RGBA8 row upload must be a multiple of 256 bytes, so bucket widths land on 64 texels.
const BUCKET_WIDTH_ALIGN = 64;

export function alignBucketWidth( width, maxTextureSize ) {

	const aligned = Math.ceil( Math.max( 1, width ) / BUCKET_WIDTH_ALIGN ) * BUCKET_WIDTH_ALIGN;
	return Math.min( maxTextureSize, Math.max( TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH, aligned ) );

}

function bucketOf( units ) {

	let width = 0, height = 0, count = 0;
	for ( const unit of units ) {

		width = Math.max( width, unit.width );
		height = Math.max( height, unit.height );
		count += unit.count;

	}

	return { units, width, height, count };

}

// Footprint times layer count.
function bucketCost( bucket, maxTextureSize ) {

	return alignBucketWidth( bucket.width, maxTextureSize ) * bucket.height * bucket.count * 4;

}

function totalCost( buckets, maxTextureSize ) {

	return buckets.reduce( ( sum, b ) => sum + bucketCost( b, maxTextureSize ), 0 );

}

// Repeatedly fuse the pair of buckets whose union wastes least, until `count` remain.
function mergeDown( buckets, count, maxTextureSize ) {

	let current = buckets.slice();

	while ( current.length > count ) {

		let best = null;

		for ( let i = 0; i < current.length; i ++ ) {

			for ( let j = i + 1; j < current.length; j ++ ) {

				const fused = bucketOf( current[ i ].units.concat( current[ j ].units ) );
				const delta = bucketCost( fused, maxTextureSize )
					- bucketCost( current[ i ], maxTextureSize ) - bucketCost( current[ j ], maxTextureSize );
				if ( ! best || delta < best.delta ) best = { i, j, delta, fused };

			}

		}

		current = current.filter( ( _, k ) => k !== best.i && k !== best.j ).concat( [ best.fused ] );

	}

	return current;

}

// The pre-shape-aware layout, kept as a rival opening: square scenes still do well on it.
function ladderBuckets( units, count, maxTextureSize ) {

	const ladder = [];
	for ( let i = count - 1; i >= 0; i -- ) {

		ladder.push( Math.max( TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH, Math.round( maxTextureSize / Math.pow( 2, i ) ) ) );

	}

	const bins = ladder.map( () => [] );

	for ( const unit of units ) {

		const longest = Math.pow( 2, Math.ceil( Math.log2( Math.max( unit.width, unit.height ) ) ) );
		let slot = ladder.findIndex( size => longest <= size );
		if ( slot < 0 ) slot = ladder.length - 1;
		bins[ slot ].push( unit );

	}

	return bins.filter( bin => bin.length ).map( bucketOf );

}

// Both openings above are greedy and stop short on mixed aspects; moving one shape at a time
// to whichever bucket makes the pool cheapest recovers the difference.
function refine( buckets, maxTextureSize ) {

	let current = buckets;

	for ( let pass = 0; pass < 8; pass ++ ) {

		let improved = false;

		for ( const unit of current.flatMap( b => b.units ) ) {

			const from = current.findIndex( b => b.units.includes( unit ) );
			if ( from < 0 ) continue;

			for ( let to = 0; to < current.length; to ++ ) {

				if ( to === from ) continue;

				const moved = [];
				for ( let i = 0; i < current.length; i ++ ) {

					if ( i === from ) {

						const rest = current[ i ].units.filter( u => u !== unit );
						if ( rest.length ) moved.push( bucketOf( rest ) );

					} else if ( i === to ) moved.push( bucketOf( current[ i ].units.concat( [ unit ] ) ) );
					else moved.push( current[ i ] );

				}

				if ( totalCost( moved, maxTextureSize ) < totalCost( current, maxTextureSize ) ) {

					current = moved;
					improved = true;
					break;

				}

			}

		}

		if ( ! improved ) break;

	}

	return current;

}

/**
 * Choose up to `count` array shapes for one colorSpace pool. Grouping by longest edge alone
 * forces a 2000x453 banner into a 2048x2048 array; grouping on both axes does not.
 *
 * @param {Array<{width: number, height: number}>} sizes - every texture in the pool
 * @param {number} maxTextureSize
 * @param {number} [count]
 * @returns {Array<{width: number, height: number}>} ascending by footprint
 */
export function planTextureBuckets( sizes, maxTextureSize, count = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT ) {

	const distinct = new Map();

	for ( const { width, height } of sizes ) {

		const w = Math.min( maxTextureSize, Math.max( 1, width || 1 ) );
		const h = Math.min( maxTextureSize, Math.max( 1, height || 1 ) );
		const key = `${w}x${h}`;
		const seen = distinct.get( key );
		if ( seen ) seen.count ++;
		else distinct.set( key, { width: w, height: h, count: 1 } );

	}

	const units = [ ...distinct.values() ];
	let buckets = units.map( unit => bucketOf( [ unit ] ) );

	if ( buckets.length > count ) {

		const ladder = ladderBuckets( units, count, maxTextureSize );
		const merged = mergeDown( buckets, count, maxTextureSize );
		buckets = totalCost( ladder, maxTextureSize ) < totalCost( merged, maxTextureSize ) ? ladder : merged;
		buckets = refine( buckets, maxTextureSize );

	}

	return buckets
		.map( b => ( { width: alignBucketWidth( b.width, maxTextureSize ), height: b.height } ) )
		.sort( ( a, b ) => a.width * a.height - b.width * b.height );

}

/**
 * Index of the cheapest planned bucket that can hold a texture at its native size.
 * A texture larger than every bucket lands in the largest and is downscaled there.
 *
 * @param {number} width
 * @param {number} height
 * @param {Array<{width: number, height: number}>} shapes - from {@link planTextureBuckets}
 * @returns {number}
 */
export function getTextureBucketId( width, height, shapes ) {

	const w = Math.max( 1, width || 1 );
	const h = Math.max( 1, height || 1 );
	for ( let i = 0; i < shapes.length; i ++ ) if ( shapes[ i ].width >= w && shapes[ i ].height >= h ) return i;
	return Math.max( 0, shapes.length - 1 );

}

// Pack (bucketId, layer) into the single int slot a material map index occupies.
export function packTextureIndex( bucketId, layer ) {

	return bucketId * TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE + layer;

}
