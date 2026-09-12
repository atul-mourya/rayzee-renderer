import { describe, it, expect } from 'vitest';
import {
	alignBucketWidth,
	getTextureBucketId,
	packTextureIndex,
	planTextureBuckets,
	TEXTURE_CONSTANTS,
} from '@/core/EngineDefaults.js';

const CAP = 4096;
const K = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT;

const cost = ( sizes, shapes ) => sizes.reduce( ( sum, s ) => {

	const shape = shapes[ getTextureBucketId( s.width, s.height, shapes ) ];
	return sum + shape.width * shape.height * 4;

}, 0 );

describe( 'alignBucketWidth', () => {

	it( 'rounds up to the 64-texel row alignment', () => {

		expect( alignBucketWidth( 1, CAP ) ).toBe( 64 );
		expect( alignBucketWidth( 64, CAP ) ).toBe( 64 );
		expect( alignBucketWidth( 65, CAP ) ).toBe( 128 );
		expect( alignBucketWidth( 2000, CAP ) ).toBe( 2048 );

	} );

	it( 'never exceeds the cap', () => {

		expect( alignBucketWidth( 5000, CAP ) ).toBe( CAP );

	} );

} );

describe( 'planTextureBuckets', () => {

	it( 'keeps every distinct shape when they fit the budget', () => {

		const shapes = planTextureBuckets( [
			{ width: 64, height: 64 },
			{ width: 256, height: 256 },
		], CAP, K );

		expect( shapes ).toEqual( [ { width: 64, height: 64 }, { width: 256, height: 256 } ] );

	} );

	it( 'never returns more buckets than the budget', () => {

		const sizes = [];
		for ( let i = 1; i <= 40; i ++ ) sizes.push( { width: i * 61, height: i * 17 } );

		expect( planTextureBuckets( sizes, CAP, K ).length ).toBeLessThanOrEqual( K );

	} );

	it( 'covers every texture at its native size', () => {

		const sizes = [
			{ width: 2000, height: 453 }, { width: 1200, height: 1199 }, { width: 400, height: 400 },
			{ width: 100, height: 3676 }, { width: 63, height: 250 }, { width: 512, height: 512 },
			{ width: 2048, height: 1269 }, { width: 700, height: 497 },
		];
		const shapes = planTextureBuckets( sizes, CAP, K );

		for ( const s of sizes ) {

			const shape = shapes[ getTextureBucketId( s.width, s.height, shapes ) ];
			expect( shape.width ).toBeGreaterThanOrEqual( s.width );
			expect( shape.height ).toBeGreaterThanOrEqual( s.height );

		}

	} );

	it( 'beats the longest-edge ladder on mixed aspect ratios', () => {

		// Wide banners and tall strips: a longest-edge ladder squares both off.
		const sizes = [];
		for ( let i = 0; i < 20; i ++ ) sizes.push( { width: 2000 - i, height: 400 + i } );
		for ( let i = 0; i < 20; i ++ ) sizes.push( { width: 400 + i, height: 2000 - i } );

		const shapes = planTextureBuckets( sizes, CAP, K );
		const ladderCost = sizes.length * 2048 * 2048 * 4;

		expect( cost( sizes, shapes ) ).toBeLessThan( ladderCost / 2 );

	} );

	it( 'clamps shapes to the cap', () => {

		const shapes = planTextureBuckets( [ { width: 9000, height: 12000 } ], 2048, K );

		expect( shapes[ 0 ].width ).toBeLessThanOrEqual( 2048 );
		expect( shapes[ 0 ].height ).toBeLessThanOrEqual( 2048 );

	} );

	it( 'handles an empty pool', () => {

		expect( planTextureBuckets( [], CAP, K ) ).toEqual( [] );

	} );

} );

describe( 'getTextureBucketId', () => {

	it( 'picks the cheapest bucket that covers the texture', () => {

		const shapes = [ { width: 64, height: 64 }, { width: 256, height: 256 }, { width: 2048, height: 512 } ];

		expect( getTextureBucketId( 64, 64, shapes ) ).toBe( 0 );
		expect( getTextureBucketId( 200, 200, shapes ) ).toBe( 1 );
		expect( getTextureBucketId( 1000, 400, shapes ) ).toBe( 2 );

	} );

	it( 'falls back to the largest bucket when nothing covers it', () => {

		const shapes = [ { width: 64, height: 64 }, { width: 256, height: 256 } ];

		expect( getTextureBucketId( 4096, 4096, shapes ) ).toBe( 1 );

	} );

} );

describe( 'packTextureIndex', () => {

	it( 'round-trips every (bucket, layer) the budget allows', () => {

		const stride = TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE;

		for ( const bucket of [ 0, 1, K - 1 ] ) {

			for ( const layer of [ 0, 1, stride - 1 ] ) {

				const packed = packTextureIndex( bucket, layer );
				expect( Math.floor( packed / stride ) ).toBe( bucket );
				expect( packed % stride ).toBe( layer );

			}

		}

	} );

	it( 'stays inside the extractor ceiling', () => {

		const max = packTextureIndex( K - 1, TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE - 1 );
		expect( max ).toBeLessThan( TEXTURE_CONSTANTS.MAX_TEXTURES_LIMIT );

	} );

} );
