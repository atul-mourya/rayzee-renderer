import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeDataURL, encodeDataURL, readPNG, writePNG } from '../../../bench/lib/png.js';
import { QUALITY_GATES } from '../../../bench/runner/config.js';
import {
	describeChanges, downscale, driftFlag, orderResults, sceneState, trendModel, writeQualityReport, writeTrendReport,
} from '../../../bench/runner/report.js';

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

	describe( 'trend', () => {

		const machine = { vendor: 'apple', architecture: 'metal-3', renderSize: '256x256' };
		const work = ( extra = {} ) => ( { triangles: 100, sun: false, camera: [ 0, 0, 9 ], settings: { maxBounces: 4 }, ...extra } );
		const run = ( at, scenes, extra = {} ) => ( {
			at, fingerprint: machine, revision: { commit: 'c'.repeat( 40 ), dirty: false },
			scenes: Object.entries( scenes ).map( ( [ scene, value ] ) => ( {
				scene, medianGpuMs: Array.isArray( value ) ? value[ 0 ] : value, p95GpuMs: 1, cv: 0.1, loadMs: 10,
				...( Array.isArray( value ) && { workload: value[ 1 ] } ),
			} ) ),
			...extra,
		} );
		const link = ( at, base, head, scenes ) => ( {
			at, fingerprint: machine, base: { ref: base, commit: base }, head: { ref: head, commit: head },
			scenes: Object.entries( scenes ).map( ( [ scene, [ baseMs, headMs, workloadChanges = [] ]] ) => ( {
				scene, baseMs, headMs, deltaPct: ( headMs / baseMs - 1 ) * 100, floorPct: 8, verdict: 'unchanged', workloadChanges,
			} ) ),
		} );

		it( 'flags a scene only when every recent run sits past its earlier median by enough', () => {

			const flat = [ 1, 1.02, 0.98, 1, 1.01 ];
			expect( driftFlag( [ ...flat, 1.2, 1.25, 1.22 ] ).direction ).toBe( 'slower' );
			expect( driftFlag( [ ...flat, 0.8, 0.85, 0.82 ] ).direction ).toBe( 'faster' );
			// One fast run among the recent ones: the median moved, but not every run did.
			expect( driftFlag( [ ...flat, 1.2, 0.95, 1.22 ] ).direction ).toBeNull();
			expect( driftFlag( [ ...flat, 1.05, 1.06, 1.07 ] ).direction ).toBeNull();
			expect( driftFlag( [ 1, 1, 1, 2, 2 ] ) ).toBeNull();

		} );

		it( 'says what changed in a scene', () => {

			expect( describeChanges( work(), work( { sun: true, camera: [ 0, 1, 9 ], lights: { directional: 1 } } ) ) )
				.toEqual( [ 'sun: false → true', 'camera moved', 'lights: none → directional 1' ] );
			expect( describeChanges( work(), { ...work(), settings: { maxBounces: 4 } } ) ).toEqual( [] );

		} );

		it( 'breaks a scene\'s line where it changed and judges only what came after', () => {

			const runs = [ 1, 1, 1, 1, 1, 1 ].map( ( v, i ) => run( `2026-01-0${i + 1}`, { s: [ v, work() ] } ) );
			for ( let i = 0; i < 6; i ++ ) runs.push( run( `2026-02-0${i + 1}`, { s: [ 2, work( { sun: true } ) ] } ) );

			const [ scene ] = trendModel( runs, [] ).scenes;
			expect( scene.breaks ).toEqual( [ { run: 6, after: 5, changes: [ 'sun: false → true' ] } ] );
			expect( scene.drift.pct ).toBeCloseTo( 0 );

		} );

		it( 'plots compute where a run measured it, and breaks the line where the measure changed', () => {

			const runs = [
				run( '2026-01-01', { s: 2 } ),
				{ ...run( '2026-01-02', {} ), measure: 'compute', scenes: [ { scene: 's', computeMs: 1, computeP95Ms: 1.1, cv: 0.01, loadMs: 1 } ] },
			];

			const [ scene ] = trendModel( runs, [] ).scenes;
			expect( scene.points.map( ( p ) => p.ms ) ).toEqual( [ 2, 1 ] );
			expect( scene.breaks ).toEqual( [ { run: 1, after: 0, changes: [ 'measured: compute + render passes → compute passes' ] } ] );

		} );

		it( 'keeps an entry\'s own measure, so a denoise line never reads as a change of measure', () => {

			const entry = { scene: 'oidn-fast', measure: 'oidn', computeMs: 40, computeP95Ms: 41, cv: 0.01, loadMs: null };
			const runs = [ 1, 2 ].map( ( d ) => ( { ...run( `2026-01-0${d}`, {} ), measure: 'compute', scenes: [ entry ] } ) );

			const [ scene ] = trendModel( runs, [] ).scenes;
			expect( scene.measure ).toBe( 'oidn' );
			expect( scene.breaks ).toEqual( [] );

		} );

		it( 'draws no break across runs that did not record a workload, and leaves out machines with fewer runs', () => {

			const runs = [
				run( '2026-01-01', { s: [ 1, work() ] } ),
				run( '2026-01-02', { s: 1 } ),
				run( '2026-01-03', { s: [ 1, work() ] } ),
				run( '2026-01-04', { s: 9 }, { fingerprint: { ...machine, architecture: 'other' } } ),
			];

			const model = trendModel( runs, [] );
			expect( model.runs ).toHaveLength( 3 );
			expect( model.otherMachines ).toBe( 1 );
			expect( model.scenes[ 0 ].breaks ).toEqual( [] );

		} );

		it( 'chains A/B runs where each base is the previous head, and multiplies their changes', () => {

			const links = [
				link( '2026-01-01', 'v0', 'v1', { a: [ 1, 1 ], b: [ 1, 1 ] } ),
				link( '2026-01-02', 'v1', 'v2', { a: [ 1, 1.1 ], b: [ 1, 1 ] } ),
				link( '2026-01-03', 'x', 'v2', { a: [ 1, 5 ] } ),
				link( '2026-01-04', 'v2', 'v3', { a: [ 1, 1.1 ], b: [ 1, 1, [ 'sun' ]], c: [ 1, 1 ] } ),
			];

			const { ab } = trendModel( [], links );
			expect( ab.chain.map( ( l ) => l.base.ref ) ).toEqual( [ 'v0', 'v1', 'v2' ] );
			expect( ab.cumulative.get( 'a' ).pct ).toBeCloseTo( 21 );
			expect( ab.cumulative.get( 'b' ) ).toEqual( { pct: 0, changed: true } );
			expect( ab.cumulative.get( 'c' ) ).toBeNull();
			expect( ab.scenes ).toEqual( [ 'a', 'b', 'c' ] );

		} );

		it( 'writes one offline page, with or without an A/B log', async () => {

			const root = await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-trend-' ) );
			try {

				const perfLog = path.join( root, 'perf.jsonl' );
				const runs = [ 1, 1.1, 0.9, 1, 5, 1 ].map( ( v, i ) => run( `2026-01-0${i + 1}T00:00:00Z`, { '<s>': v }, i === 2 ? { revision: null } : {} ) );
				await fs.writeFile( perfLog, runs.map( ( r ) => JSON.stringify( r ) ).join( '\n' ) );

				const html = await fs.readFile( await writeTrendReport( { perfLog, abLog: path.join( root, 'none.jsonl' ), dir: root } ), 'utf8' );
				expect( html ).toContain( 'id="&lt;s&gt;"' );
				expect( html ).toContain( 'No A/B runs logged yet' );
				expect( html ).toContain( 'commit not recorded' );
				expect( html ).toContain( 'off the chart' );
				expect( html.match( /class="pt open"/g ) ).toHaveLength( 2 );
				expect( html ).not.toMatch( /(src|href)="https?:/ );

			} finally {

				await fs.rm( root, { recursive: true, force: true } );

			}

		} );

	} );

} );
