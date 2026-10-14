import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeDataURL, encodeDataURL, readPNG, writePNG } from '../../../bench/lib/png.js';
import { QUALITY_GATES } from '../../../bench/runner/config.js';
import { downscale, orderResults, sceneState, writeQualityReport } from '../../../bench/runner/report.js';

const SIZE = 256;

function solid( rgb, size = SIZE ) {

	const data = new Uint8ClampedArray( size * size * 4 );
	for ( let i = 0; i < data.length; i += 4 ) data.set( [ ...rgb, 255 ], i );
	return { width: size, height: size, data };

}

function withPixel( image, x, y, rgb ) {

	const data = new Uint8ClampedArray( image.data );
	data.set( [ ...rgb, 255 ], ( y * image.width + x ) * 4 );
	return { ...image, data };

}

const entry = ( scene, pass, identical, extra = {} ) => ( {
	scene, pass, failures: [], vsGolden: { rmse: identical ? 0 : 0.001, identical, fractionOverThreshold: 0 }, ...extra,
} );

const imageSources = ( html ) => [ ...html.matchAll( /<img src="(data:image\/png;base64,[^"]+)"/g ) ].map( ( m ) => m[ 1 ] );

describe( 'bench quality report', () => {

	it( 'orders failures, then moved scenes, then bit-identical ones, keeping corpus order within each', () => {

		const results = [
			entry( 'a', true, true ), entry( 'b', false, true ), entry( 'c', true, false ),
			entry( 'd', false, false ), entry( 'e', true, true ),
		];

		expect( orderResults( results ).map( ( r ) => r.scene ) ).toEqual( [ 'b', 'd', 'c', 'a', 'e' ] );
		expect( results.map( sceneState ) ).toEqual( [ 'identical', 'fail', 'moved', 'fail', 'identical' ] );

	} );

	it( 'counts a scene with no golden as moved, not identical', () => {

		expect( sceneState( { scene: 'x', pass: true } ) ).toBe( 'moved' );

	} );

	it( 'downscales by the block mean, or keeps a lone hot pixel with max', () => {

		const image = withPixel( solid( [ 0, 0, 0 ], 4 ), 1, 1, [ 200, 100, 40 ] );

		const mean = downscale( image, 2 );
		expect( [ mean.width, mean.height ] ).toEqual( [ 2, 2 ] );
		expect( Array.from( mean.data.slice( 0, 4 ) ) ).toEqual( [ 50, 25, 10, 255 ] );

		const max = downscale( image, 2, 'max' );
		expect( Array.from( max.data.slice( 0, 4 ) ) ).toEqual( [ 200, 100, 40, 255 ] );
		expect( Array.from( max.data.slice( 4, 8 ) ) ).toEqual( [ 0, 0, 0, 255 ] );

		expect( downscale( image, 8 ) ).toBe( image );

	} );

	describe( 'writeQualityReport', () => {

		let root;
		let dirs;

		beforeEach( async () => {

			root = await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-report-' ) );
			dirs = { dir: path.join( root, 'results' ), goldenDir: path.join( root, 'golden' ), truthDir: path.join( root, 'truth' ) };

		} );

		afterEach( async () => {

			await fs.rm( root, { recursive: true, force: true } );

		} );

		it( 'writes one offline page: failures first at full size with a heatmap, identical scenes as a thumbnail', async () => {

			const grey = solid( [ 120, 120, 120 ] );
			const moved = withPixel( grey, 10, 20, [ 255, 0, 0 ] );

			for ( const id of [ 'same', 'broken', 'drift' ] ) {

				await writePNG( path.join( dirs.goldenDir, `${id}.png` ), grey );
				await writePNG( path.join( dirs.truthDir, `${id}.png` ), grey );

			}

			const results = [
				entry( 'same', true, true, { capture: encodeDataURL( grey ) } ),
				entry( 'drift', true, false, { capture: encodeDataURL( moved ) } ),
				entry( 'broken', false, false, {
					capture: encodeDataURL( moved ),
					failures: [ 'GOLDEN: RMSE 0.00412 exceeds 0.002 <b>' ],
					vsGolden: { rmse: 0.00412, identical: false, fractionOverThreshold: 0 },
					furnace: { ratio: 0.9, deviation: 0.1, blessed: 0.999 },
				} ),
			];

			const file = await writeQualityReport( { results }, { ...dirs, scenes: [ { id: 'broken', covers: 'a test scene', spp: 64 } ] } );
			const html = await fs.readFile( file, 'utf8' );

			expect( file ).toBe( path.join( dirs.dir, 'quality.html' ) );
			expect( html.indexOf( 'id="broken"' ) ).toBeLessThan( html.indexOf( 'id="drift"' ) );
			expect( html.indexOf( 'id="drift"' ) ).toBeLessThan( html.indexOf( 'id="same"' ) );
			expect( html ).toContain( '&lt;b&gt;' );
			expect( html ).toContain( 'a test scene · 64 spp' );
			expect( html ).toContain( `≤ ${QUALITY_GATES.golden.maxRmse}` );
			expect( html ).toMatch( /<td class="num bad"[^>]*>0\.00412<\/td>/ );
			expect( html ).toMatch( /<td class="num bad"[^>]*>0\.90000<\/td>/ );
			expect( html ).toContain( 'prefers-color-scheme: dark' );
			expect( html ).not.toMatch( /(src|href)="https?:/ );

			// broken: golden, current, difference and truth at full size; drift: the four as
			// thumbnails; same: one thumbnail.
			const sizes = imageSources( html ).map( ( src ) => decodeDataURL( src ).width );
			expect( sizes ).toEqual( [ SIZE, SIZE, SIZE, SIZE, 128, 128, 128, 128, 128 ] );

			const heat = await readPNG( path.join( dirs.dir, 'quality', 'broken-diff.png' ) );
			expect( Array.from( heat.data.slice( ( 20 * SIZE + 10 ) * 4, ( 20 * SIZE + 10 ) * 4 + 4 ) ) ).toEqual( [ 255, 0, 0, 255 ] );
			expect( Array.from( heat.data.slice( 0, 4 ) ) ).toEqual( [ 0, 0, 0, 255 ] );

			// The drift heatmap's thumbnail still shows its one changed pixel.
			const driftThumb = decodeDataURL( imageSources( html )[ 6 ] );
			expect( driftThumb.data[ ( 10 * 128 + 5 ) * 4 ] ).toBe( 255 );

			expect( ( await fs.readdir( path.join( dirs.dir, 'quality' ) ) ).sort() )
				.toEqual( [ 'broken-diff.png', 'broken.png', 'drift-diff.png', 'drift.png' ] );
			expect( html ).toContain( 'href="../golden/same.png"' );
			expect( html ).toContain( 'href="quality/broken-diff.png"' );

		} );

		it( 'says what is missing instead of failing when a scene has no golden or truth', async () => {

			const results = [ { scene: 'new', pass: false, failures: [ 'no golden on disk' ], capture: encodeDataURL( solid( [ 9, 9, 9 ], 4 ) ) } ];
			const html = await fs.readFile( await writeQualityReport( { results }, dirs ), 'utf8' );

			expect( html ).toContain( 'no golden to compare' );
			expect( html ).toContain( 'no ground truth on disk' );
			expect( imageSources( html ) ).toHaveLength( 1 );

		} );

		it( 'clears the previous run’s files', async () => {

			const stale = path.join( dirs.dir, 'quality', 'gone-diff.png' );
			await writePNG( stale, solid( [ 0, 0, 0 ], 2 ) );
			await writeQualityReport( { results: [] }, dirs );

			await expect( fs.access( stale ) ).rejects.toThrow();

		} );

	} );

} );
