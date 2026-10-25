/**
 * HTML reports written to bench/results/ (git-ignored), self-contained so they open offline: a quality run, images
 * embedded, and the performance trend over the perf and A/B logs.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { diffHeatmap } from '../lib/metrics.js';
import { decodeDataURL, encodeDataURL, writeDataURL } from '../lib/png.js';
import { median } from '../lib/stats.js';
import { PATHS, PERF, QUALITY_GATES, TREND } from './config.js';
import { changedKeys, readTrend } from './perf.js';

const THUMB_WIDTH = 128;
const FULL_SIZE_FAILURES = 8;
const RANK = { fail: 0, moved: 1, identical: 2 };

/** @returns {'fail'|'moved'|'identical'} */
export function sceneState( entry ) {

	if ( entry.pass === false ) return 'fail';
	return entry.vsGolden?.identical ? 'identical' : 'moved';

}

/** Failing scenes first, then those that moved within the gates, then the bit-identical ones. */
export function orderResults( results ) {

	return [ ...results ].sort( ( a, b ) => RANK[ sceneState( a ) ] - RANK[ sceneState( b ) ] );

}

/**
 * Shrink by a whole factor to at most `maxWidth` pixels wide, each channel the mean of its block,
 * or its maximum — which keeps a lone changed pixel of a heatmap visible.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} image
 * @param {number} maxWidth
 * @param {'mean'|'max'} [reduce]
 * @returns {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }}
 */
export function downscale( image, maxWidth, reduce = 'mean' ) {

	const factor = Math.ceil( image.width / maxWidth );
	if ( factor <= 1 ) return image;

	const width = Math.floor( image.width / factor );
	const height = Math.floor( image.height / factor );
	const data = new Uint8ClampedArray( width * height * 4 );
	const src = image.data;
	const max = reduce === 'max';

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			for ( let c = 0; c < 4; c ++ ) {

				let acc = 0;

				for ( let dy = 0; dy < factor; dy ++ ) {

					const row = ( ( y * factor + dy ) * image.width + x * factor ) * 4 + c;

					for ( let dx = 0; dx < factor; dx ++ ) {

						const v = src[ row + dx * 4 ];
						acc = max ? Math.max( acc, v ) : acc + v;

					}

				}

				data[ ( y * width + x ) * 4 + c ] = max ? acc : acc / ( factor * factor );

			}

		}

	}

	return { width, height, data };

}

async function readDataURL( filePath ) {

	try {

		return `data:image/png;base64,${( await fs.readFile( filePath ) ).toString( 'base64' )}`;

	} catch ( error ) {

		if ( error.code === 'ENOENT' ) return null;
		throw error;

	}

}

/**
 * @param {{ results: Object[], fingerprint?: Object }} report - what `runQuality` returned
 * @param {Object} [options]
 * @param {Object[]} [options.scenes] - `bench.scenes()`, for each scene's spp and description
 * @param {{ commit: string, dirty: boolean }|null} [options.revision]
 * @param {string} [options.dir] - where the page and its full-size files go
 * @param {string} [options.goldenDir]
 * @param {string} [options.truthDir]
 * @returns {Promise<string>} path of the page
 */
export async function writeQualityReport( report, {
	scenes = [], revision = null, dir = PATHS.results, goldenDir = PATHS.golden, truthDir = PATHS.truth,
} = {} ) {

	const assets = path.join( dir, 'quality' );
	await fs.rm( assets, { recursive: true, force: true } );
	await fs.mkdir( assets, { recursive: true } );

	const link = ( file ) => path.relative( dir, file ).split( path.sep ).join( '/' );
	const specs = new Map( scenes.map( ( s ) => [ s.id, s ] ) );
	const cards = [];
	let fullSize = 0;

	for ( const entry of orderResults( report.results ) ) {

		const id = entry.scene;
		const state = sceneState( entry );
		const card = { entry, state, spec: specs.get( id ) };
		const goldenFile = path.join( goldenDir, `${id}.png` );
		const current = decodeDataURL( entry.capture );

		if ( state === 'identical' ) {

			card.thumb = { src: encodeDataURL( downscale( current, THUMB_WIDTH ) ), href: link( goldenFile ) };
			cards.push( card );
			continue;

		}

		card.full = state === 'fail' && fullSize ++ < FULL_SIZE_FAILURES;
		const shown = ( url, image, reduce = 'mean' ) => (
			card.full ? url : encodeDataURL( downscale( image ?? decodeDataURL( url ), THUMB_WIDTH, reduce ) )
		);

		const golden = await readDataURL( goldenFile );
		const currentFile = path.join( assets, `${id}.png` );
		await writeDataURL( currentFile, entry.capture );

		let difference = { label: 'difference', missing: golden ? 'bit-identical to the golden' : 'no golden to compare' };

		if ( golden && ! entry.vsGolden?.identical ) {

			const heat = diffHeatmap( decodeDataURL( golden ), current );
			const heatURL = encodeDataURL( heat );
			const heatFile = path.join( assets, `${id}-diff.png` );
			await writeDataURL( heatFile, heatURL );
			difference = { label: 'difference', src: shown( heatURL, heat, 'max' ), href: link( heatFile ), scale: heat.scale };

		}

		const truthFile = path.join( truthDir, `${id}.png` );
		const truth = await readDataURL( truthFile );

		card.panels = [
			golden
				? { label: 'golden', src: shown( golden ), href: link( goldenFile ) }
				: { label: 'golden', missing: 'no golden on disk' },
			{ label: 'current', src: shown( entry.capture, current ), href: link( currentFile ) },
			difference,
			truth
				? { label: 'ground truth', src: shown( truth ), href: link( truthFile ) }
				: { label: 'ground truth', missing: 'no ground truth on disk' },
		];
		cards.push( card );

	}

	const file = path.join( dir, 'quality.html' );
	await fs.writeFile( file, qualityReportHTML( {
		cards, fingerprint: report.fingerprint, revision, generatedAt: new Date(),
	} ) );
	return file;

}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const esc = ( value ) => String( value ).replace( /[&<>"']/g, ( c ) => ESCAPES[ c ] );
const isNumber = ( v ) => typeof v === 'number' && Number.isFinite( v );
const fixed = ( v, digits ) => ( isNumber( v ) ? v.toFixed( digits ) : '—' );
const percent = ( v, digits ) => ( isNumber( v ) ? `${( v * 100 ).toFixed( digits )} %` : '—' );
const signedPercent = ( v, digits ) => ( isNumber( v ) ? `${v >= 0 ? '+' : ''}${( v * 100 ).toFixed( digits )} %` : '—' );
const BADGE = { fail: 'FAIL', moved: 'moved', identical: 'identical' };

function cell( text, bad = false, title = '' ) {

	return `<td class="num${bad ? ' bad' : ''}"${title ? ` title="${esc( title )}"` : ''}>${esc( text ?? '—' )}</td>`;

}

function metricCells( entry ) {

	const { golden, truth, furnace } = QUALITY_GATES;
	const g = entry.vsGolden;
	const t = entry.vsTruth;
	const f = entry.furnace;
	const blessedDeviation = isNumber( f?.blessed ) ? Math.abs( f.blessed - 1 ) : null;

	return [
		cell( g && fixed( g.rmse, 5 ), g?.rmse > golden.maxRmse ),
		cell( g && percent( g.fractionOverThreshold, 3 ), g?.fractionOverThreshold > golden.maxFractionOverThreshold ),
		cell(
			t && ( isNumber( entry.rmseIncrease ) ? `${fixed( t.rmse, 5 )} (${signedPercent( entry.rmseIncrease, 2 )})` : fixed( t.rmse, 5 ) ),
			entry.rmseIncrease > truth.maxRmseIncrease,
			isNumber( t?.blessedRmse ) ? `blessed ${t.blessedRmse.toFixed( 5 )}` : ''
		),
		cell( t && fixed( t.ssim, 4 ) ),
		cell( isNumber( entry.biasRatio ) ? signedPercent( entry.biasRatio - 1, 3 ) : null, Math.abs( entry.biasRatio - 1 ) > truth.maxBiasRatioDelta ),
		cell(
			f && fixed( f.ratio, 5 ),
			blessedDeviation !== null && f.deviation > blessedDeviation + furnace.maxDeviationIncrease,
			blessedDeviation !== null ? `blessed ${f.blessed.toFixed( 5 )}` : ''
		),
	].join( '' );

}

function panelHTML( panel ) {

	if ( panel.missing ) {

		return `<figure><div class="missing">${esc( panel.missing )}</div><figcaption>${esc( panel.label )}</figcaption></figure>`;

	}

	const ramp = isNumber( panel.scale )
		? `<span class="scale muted"><span class="ramp"></span> 0 – ${panel.scale.toPrecision( 3 )}</span>`
		: '';

	return `<figure><a href="${esc( panel.href )}"><img src="${panel.src}" alt="${esc( panel.label )}"></a>` +
		`<figcaption>${esc( panel.label )}${ramp}</figcaption></figure>`;

}

function cardHTML( { entry, state, spec, panels, full } ) {

	const about = [
		spec?.covers,
		spec?.spp && `${spec.spp} spp`,
		spec?.truthSpp && `truth ${spec.truthSpp} spp`,
	].filter( Boolean ).join( ' · ' );
	const failures = entry.failures?.length
		? `<ul class="failures">${entry.failures.map( ( f ) => `<li>${esc( f )}</li>` ).join( '' )}</ul>`
		: '';

	return `<section class="card" id="${esc( entry.scene )}">` +
		`<h2><span class="badge ${state}">${BADGE[ state ]}</span> ${esc( entry.scene )}</h2>` +
		( about ? `<p class="muted">${esc( about )}</p>` : '' ) +
		failures +
		`<div class="panels${full ? '' : ' small'}">${panels.map( panelHTML ).join( '' )}</div></section>`;

}

/**
 * @param {Object} model
 * @param {Object[]} model.cards - `{ entry, state, spec?, panels? | thumb? }`, in display order
 * @param {Object} [model.fingerprint]
 * @param {{ commit: string, dirty: boolean }|null} [model.revision]
 * @param {Date} model.generatedAt
 * @returns {string}
 */
function qualityReportHTML( { cards, fingerprint, revision, generatedAt } ) {

	const { golden, truth, furnace } = QUALITY_GATES;
	const count = ( state ) => cards.filter( ( c ) => c.state === state ).length;
	const failed = count( 'fail' );
	const meta = [
		`${generatedAt.toISOString().replace( 'T', ' ' ).slice( 0, 19 )} UTC`,
		revision && `${revision.commit.slice( 0, 8 )}${revision.dirty ? ' + uncommitted changes' : ''}`,
		fingerprint && `${fingerprint.vendor} ${fingerprint.architecture}, ${fingerprint.renderSize}`,
	].filter( Boolean ).join( ' · ' );

	const rows = cards.map( ( card ) => `<tr><td><a href="#${esc( card.entry.scene )}">${esc( card.entry.scene )}</a></td>` +
		`<td><span class="badge ${card.state}">${BADGE[ card.state ]}</span></td>${metricCells( card.entry )}</tr>` ).join( '\n' );

	const detailed = cards.filter( ( c ) => c.panels ).map( cardHTML ).join( '\n' );
	const thumbs = cards.filter( ( c ) => c.thumb ).map( ( { entry, thumb } ) =>
		`<figure id="${esc( entry.scene )}"><a href="${esc( thumb.href )}"><img src="${thumb.src}" alt="${esc( entry.scene )}"></a>` +
		`<figcaption>${esc( entry.scene )}</figcaption></figure>` ).join( '\n' );

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bench quality report</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d8dee4; --card: #f6f8fa; --pass: #1a7f37; --fail: #cf222e; --moved: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --card: #161b22; --pass: #3fb950; --fail: #ff7b72; --moved: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1280px; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 4px; }
a { color: inherit; }
.muted { color: var(--muted); }
.summary { margin: 0 0 16px; }
.summary .fail { color: var(--fail); }
.summary .pass { color: var(--pass); }
.table-scroll { overflow-x: auto; margin-bottom: 24px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { font-weight: 600; vertical-align: bottom; }
th small { display: block; font-weight: 400; color: var(--muted); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.bad { color: var(--fail); font-weight: 600; }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.badge.fail { color: var(--fail); }
.badge.moved { color: var(--moved); }
.badge.identical { color: var(--pass); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
.failures { color: var(--fail); margin: 4px 0 8px; padding-left: 20px; }
.panels { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 256px), 1fr)); gap: 12px; margin-top: 8px; }
.panels.small { grid-template-columns: repeat(auto-fill, minmax(128px, 160px)); }
figure { margin: 0; }
figure img { display: block; width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); }
figcaption { margin-top: 4px; }
.missing { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; text-align: center; padding: 8px; border: 1px dashed var(--line); color: var(--muted); }
.scale { display: block; white-space: nowrap; font-size: 12px; }
.ramp { display: inline-block; width: 48px; height: 8px; vertical-align: middle; background: linear-gradient(to right, #000, #00f, #0ff, #ff0, #f00); border: 1px solid var(--line); }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); gap: 12px; }
.thumbs img { image-rendering: auto; }
.thumbs figcaption { font-size: 12px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>Bench quality report</h1>
<p class="muted">${esc( meta )}</p>
<p class="summary">${cards.length} scenes: <strong class="${failed ? 'fail' : 'pass'}">${failed} failed</strong>, ${count( 'moved' )} moved within the gates, ${count( 'identical' )} bit-identical to their golden.</p>
<div class="table-scroll"><table>
<thead><tr><th>scene</th><th>verdict</th>
<th>RMSE vs golden<small>≤ ${golden.maxRmse}</small></th>
<th>pixels off golden<small>≤ ${percent( golden.maxFractionOverThreshold, 2 )} (luminance Δ &gt; ${golden.pixelThreshold})</small></th>
<th>RMSE vs truth<small>rise ≤ ${percent( truth.maxRmseIncrease, 0 )} over blessed</small></th>
<th>SSIM vs truth<small>not gated</small></th>
<th>energy bias<small>≤ ±${percent( truth.maxBiasRatioDelta, 2 )}</small></th>
<th>furnace ratio<small>|1 − ratio| may grow ≤ ${( furnace.maxDeviationIncrease * 100 ).toFixed( 1 )} pp</small></th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${detailed ? `<p class="muted">Difference: each pixel's largest change in any linear-light channel against the golden, black → blue → cyan → yellow → red on a square-root scale, red being the scene's largest change (the number under the map). The first ${FULL_SIZE_FAILURES} failing scenes are shown at full size, the rest as thumbnails (a difference thumbnail keeps each block's hottest pixel). Click an image for its full-size file.</p>\n${detailed}` : ''}
${thumbs ? `<h2>Bit-identical to the golden</h2>\n<div class="thumbs">\n${thumbs}\n</div>` : ''}
</body>
</html>
`;

}

const byTime = ( a, b ) => ( a.at < b.at ? - 1 : a.at > b.at ? 1 : 0 );

// Runs before 2026-10-14 summed compute and render timestamps; the render part overlaps the compute on Apple GPUs.
const MEASURES = { total: 'compute + render passes', compute: 'compute passes', oidn: 'OIDN network, a denoise' };

function showValue( value ) {

	if ( value === undefined || value === null ) return 'none';
	if ( Array.isArray( value ) ) return value.length ? value.join( ', ' ) : 'none';
	if ( typeof value === 'object' ) return Object.entries( value ).map( ( [ k, v ] ) => `${k} ${JSON.stringify( v )}` ).join( ', ' ) || 'none';
	return String( value );

}

/** One line per changed workload key, e.g. `sun: false → true`. */
export function describeChanges( before, after ) {

	return ( changedKeys( before, after ) ?? [] ).map( ( key ) => ( key === 'camera'
		? 'camera moved'
		: `${key}: ${showValue( before[ key ] )} → ${showValue( after[ key ] )}` ) );

}

/**
 * How a scene's last `recentRuns` runs compare with the runs before them; `direction` is set only when all of them sit
 * on one side of the earlier median and their own median is `flagPct` away.
 *
 * @param {number[]} values - oldest first
 * @returns {?{ earlier: number, recent: number, pct: number, direction: ?('slower'|'faster') }}
 */
export function driftFlag( values, { recentRuns = TREND.recentRuns, flagPct = TREND.flagPct } = {} ) {

	if ( values.length < recentRuns * 2 ) return null;

	const recentValues = values.slice( - recentRuns );
	const earlier = median( values.slice( 0, - recentRuns ) );
	const recent = median( recentValues );
	const pct = ( recent / earlier - 1 ) * 100;
	let direction = null;
	if ( pct >= flagPct && Math.min( ...recentValues ) > earlier ) direction = 'slower';
	if ( pct <= - flagPct && Math.max( ...recentValues ) < earlier ) direction = 'faster';
	return { earlier, recent, pct, direction };

}

/**
 * The trend page's data. Only runs on the machine with the most runs count (the newer on a tie); a scene's line breaks
 * where its workload changed, and only the stretch after its last break is judged. A/B links chain where one's base is
 * the previous one's head, the longest such chain ending at the newest link.
 *
 * @param {Object[]} perfRuns - perf.jsonl
 * @param {Object[]} abRuns - ab.jsonl
 */
export function trendModel( perfRuns, abRuns, options = {} ) {

	const { recentRuns, flagPct, abColumns } = { ...TREND, ...options };
	const all = [ ...perfRuns, ...abRuns ].sort( byTime );
	const count = ( fingerprint ) => all.filter( ( run ) => changedKeys( run.fingerprint, fingerprint )?.length === 0 ).length;
	const machine = all.reduceRight( ( best, run ) => ( count( run.fingerprint ) > count( best ) ? run.fingerprint : best ), all.at( - 1 )?.fingerprint ?? null );
	const onMachine = ( run ) => changedKeys( run.fingerprint, machine )?.length === 0;
	const runs = perfRuns.filter( onMachine ).sort( byTime );
	const links = abRuns.filter( onMachine ).sort( byTime );

	const scenes = new Map();
	runs.forEach( ( run, index ) => {

		for ( const entry of run.scenes ) {

			if ( ! scenes.has( entry.scene ) ) scenes.set( entry.scene, { id: entry.scene, points: [], breaks: [], workload: null, measure: null } );
			const scene = scenes.get( entry.scene );
			const measure = entry.measure ?? run.measure ?? 'total';
			const changes = entry.workload && scene.workload ? describeChanges( scene.workload, entry.workload ) : [];
			if ( scene.measure && measure !== scene.measure ) changes.unshift( `measured: ${MEASURES[ scene.measure ]} → ${MEASURES[ measure ]}` );
			if ( changes.length ) scene.breaks.push( { run: index, after: scene.points.at( - 1 ).run, changes } );
			scene.workload = entry.workload ?? scene.workload;
			scene.measure = measure;
			scene.points.push( {
				run: index, ms: entry.computeMs ?? entry.medianGpuMs, p95: entry.computeP95Ms ?? entry.p95GpuMs, cv: entry.cv,
				loadMs: entry.loadMs, segment: scene.breaks.length,
			} );

		}

	} );

	for ( const scene of scenes.values() ) {

		scene.median = median( scene.points.map( ( p ) => p.ms ) );
		const current = scene.points.filter( ( p ) => p.segment === scene.breaks.length );
		scene.drift = driftFlag( current.map( ( p ) => p.ms ), { recentRuns, flagPct } );

	}

	const rank = ( scene ) => ( { slower: 0, faster: 1 } )[ scene.drift?.direction ] ?? 2;
	const ordered = [ ...scenes.values() ].sort( ( a, b ) => rank( a ) - rank( b ) );

	const longest = new Map();
	const chainTo = ( link ) => {

		if ( ! longest.has( link ) ) {

			const before = links.filter( ( l ) => l.head.commit === link.base.commit && l.at < link.at && l.measure === link.measure ).map( chainTo );
			longest.set( link, [ ...before.reduceRight( ( best, c ) => ( c.length > best.length ? c : best ), [] ), link ] );

		}

		return longest.get( link );

	};

	const chain = links.length ? chainTo( links.at( - 1 ) ) : [];

	const shown = links.slice( - abColumns );
	const abScenes = [ ...new Set( [ ...shown ].reverse().flatMap( ( l ) => l.scenes.map( ( s ) => s.scene ) ) ) ];
	const cumulative = new Map( abScenes.map( ( id ) => {

		let ratio = 1;
		let changed = false;
		for ( const step of chain ) {

			const entry = step.scenes.find( ( s ) => s.scene === id );
			if ( ! entry ) return [ id, null ];
			ratio *= entry.headMs / entry.baseMs;
			changed ||= entry.workloadChanges?.length > 0;

		}

		return [ id, { pct: ( ratio - 1 ) * 100, changed } ];

	} ) );

	return {
		machine,
		runs,
		otherMachines: perfRuns.length - runs.length,
		scenes: ordered,
		ab: { links: shown, chain, scenes: abScenes, cumulative, otherMachines: abRuns.length - links.length },
	};

}

/** Subject line of each commit git still has. */
async function commitSubjects( commits ) {

	if ( ! commits.length ) return new Map();
	try {

		const { stdout } = await promisify( execFile )(
			'git', [ 'log', '--no-walk', '--ignore-missing', '--format=%H%x09%s', ...commits ], { cwd: PATHS.repoRoot }
		);
		return new Map( stdout.split( '\n' ).filter( Boolean ).map( ( line ) => line.split( '\t' ) ) );

	} catch {

		return new Map();

	}

}

/**
 * Writes bench/results/trend.html from bench/baselines/perf.jsonl and ab.jsonl.
 *
 * @returns {Promise<string>} the file written
 */
export async function writeTrendReport( { perfLog = PATHS.perfLog, abLog = PATHS.abLog, dir = PATHS.results } = {} ) {

	const model = trendModel( await readTrend( perfLog ), await readTrend( abLog ) );
	const commits = [ ...new Set( [
		...model.runs.map( ( r ) => r.revision?.commit ),
		...model.ab.links.flatMap( ( l ) => [ l.base.commit, l.head.commit ] ),
	].filter( Boolean ) ) ];

	await fs.mkdir( dir, { recursive: true } );
	const file = path.join( dir, 'trend.html' );
	await fs.writeFile( file, trendReportHTML( model, { subjects: await commitSubjects( commits ), generatedAt: new Date() } ) );
	return file;

}

const CHART = { width: 320, height: 132, left: 40, right: 52, top: 14, bottom: 22 };

function niceCeil( value ) {

	if ( ! ( value > 0 ) ) return 1;
	const step = 10 ** Math.floor( Math.log10( value ) );
	return [ 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 ].map( ( m ) => m * step ).find( ( v ) => v >= value );

}

const ms = ( v ) => ( v >= 10 ? v.toFixed( 1 ) : v.toFixed( 2 ) );
const day = ( at ) => at.slice( 0, 10 );
const signed = ( pct, digits = 1 ) => `${pct >= 0 ? '+' : '−'}${Math.abs( pct ).toFixed( digits )} %`;

function runNote( run, subjects ) {

	const commit = run.revision?.commit;
	const lines = [ `${run.at.slice( 0, 16 ).replace( 'T', ' ' )} UTC` ];
	if ( commit ) lines.push( `${commit.slice( 0, 8 )} ${( subjects.get( commit ) ?? '' ).slice( 0, 72 )}`.trim() );
	else lines.push( 'commit not recorded' );
	if ( run.revision?.dirty ) lines.push( 'with uncommitted changes' );
	if ( run.only ) lines.push( `partial run (--only ${run.only.join( ',' )})` );
	return lines;

}

function sceneChart( scene, runs, subjects ) {

	const { width: W, height: H, left, right, top, bottom } = CHART;
	const n = runs.length;
	const x = ( run ) => left + ( n > 1 ? run / ( n - 1 ) : 0.5 ) * ( W - left - right );
	const cap = scene.median * TREND.clampRatio;
	const yMax = niceCeil( Math.max( ...scene.points.filter( ( p ) => p.ms <= cap ).map( ( p ) => p.ms ) ) * 1.05 );
	const y = ( v ) => ( v > cap ? top : top + ( 1 - Math.min( v, yMax ) / yMax ) * ( H - top - bottom ) );
	const parts = [];

	for ( const v of [ 0, yMax / 2, yMax ] ) {

		parts.push( `<line class="grid" x1="${left}" x2="${W - right}" y1="${y( v )}" y2="${y( v )}"/>` );
		parts.push( `<text class="tick" x="${left - 6}" y="${y( v ) + 4}" text-anchor="end">${+ v.toFixed( 2 )}</text>` );

	}

	parts.push( `<text class="tick" x="${x( 0 )}" y="${H - 6}" text-anchor="start">${day( runs[ 0 ].at ).slice( 5 )}</text>` );
	if ( n > 1 ) parts.push( `<text class="tick" x="${x( n - 1 )}" y="${H - 6}" text-anchor="end">${day( runs[ n - 1 ].at ).slice( 5 )}</text>` );

	for ( const b of scene.breaks ) {

		const bx = ( x( b.after ) + x( b.run ) ) / 2;
		const tip = esc( [ 'scene changed', ...b.changes ].join( '\n' ) );
		parts.push( `<line class="break" x1="${bx}" x2="${bx}" y1="${top}" y2="${H - bottom}"/>` );
		parts.push( `<rect class="mark-break" x="${bx - 3.5}" y="${top - 7}" width="7" height="7" transform="rotate(45 ${bx} ${top - 3.5})"/>` );
		parts.push( `<rect class="hit" x="${bx - 6}" y="${top - 12}" width="12" height="${H - bottom - top + 12}" data-tip="${tip}"/>` );

	}

	for ( let segment = 0; segment <= scene.breaks.length; segment ++ ) {

		const points = scene.points.filter( ( p ) => p.segment === segment );
		if ( points.length > 1 ) parts.push( `<path class="line" d="${points.map( ( p, i ) => `${i ? 'L' : 'M'}${x( p.run ).toFixed( 1 )} ${y( p.ms ).toFixed( 1 )}` ).join( '' )}"/>` );

	}

	const per = scene.measure === 'oidn' ? 'a denoise' : 'a sample';
	for ( const p of scene.points ) {

		const run = runs[ p.run ];
		const committed = run.revision?.commit && ! run.revision.dirty;
		const px = x( p.run );
		const py = y( p.ms );
		const tip = esc( [
			...runNote( run, subjects ),
			`${ms( p.ms )} ms ${per}${p.ms > cap ? ' (off the chart)' : ''}, p95 ${ms( p.p95 )}, cv ${Math.round( p.cv * 100 )} %`,
			...( p.loadMs == null ? [] : [ `load ${( p.loadMs / 1000 ).toFixed( 2 )} s` ] ),
		].join( '\n' ) );

		parts.push( p.ms > cap
			? `<path class="pt" d="M${px} ${top - 5}l5 8h-10z"/>`
			: `<circle class="pt${committed ? '' : ' open'}" cx="${px}" cy="${py}" r="4"/>` );
		parts.push( `<circle class="hit" cx="${px}" cy="${py}" r="9" data-tip="${tip}"/>` );

	}

	const last = scene.points.at( - 1 );
	parts.push( `<text class="end" x="${x( last.run ) + 8}" y="${y( last.ms ) + 4}">${ms( last.ms )}</text>` );

	const label = `${scene.id}: ${scene.points.length} runs, latest ${ms( last.ms )} ms ${per}`;
	return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc( label )}">${parts.join( '' )}</svg>`;

}

function flagHTML( drift ) {

	if ( ! drift?.direction ) return '';
	const slower = drift.direction === 'slower';
	return `<span class="flag ${drift.direction}"><span class="icon" aria-hidden="true">${slower ? '▲' : '▼'}</span>` +
		`${Math.abs( drift.pct ).toFixed( 0 )} % ${drift.direction}</span>`;

}

function abCell( entry ) {

	if ( ! entry ) return '<td class="num muted">—</td>';
	const changed = entry.workloadChanges?.length
		? ` <span class="changed" title="scene changed: ${esc( entry.workloadChanges.join( ', ' ) )}">◆</span>`
		: '';
	const rounds = entry.roundsPct ? `, rounds ${entry.roundsPct.map( ( d ) => signed( d ) ).join( ' / ' )}` : '';
	const title = `${ms( entry.baseMs )} → ${ms( entry.headMs )} ms, noise floor ±${entry.floorPct.toFixed( 1 )} %${rounds}, ${entry.verdict}`;
	const icon = { slower: '▲ ', faster: '▼ ' }[ entry.verdict ] ?? '';
	return `<td class="num ${entry.verdict}" title="${esc( title )}">` +
		`${icon ? `<span class="icon" aria-hidden="true">${icon}</span>` : ''}${signed( entry.deltaPct )}${entry.verdict === 'inconclusive' ? ' ?' : ''}${changed}</td>`;

}

function abSectionHTML( ab, subjects ) {

	const intro = '<h2>Release to release</h2>' +
		'<p class="muted">Each column is one <code>bench:ab</code> run on committed code: both sides timed in alternating rounds in one browser, ' +
		`so the machine's own drift cancels. ▲ slower and ▼ faster are changes past the noise floor (at least ${PERF.abUnchangedPct} %); ` +
		'a plain number is within it, and ? had too much spread to judge. The last column multiplies chained runs together: a small change ' +
		'repeated release after release adds up there faster than the noise does. ◆ marks a scene that itself changed between the two sides.</p>';

	if ( ! ab.links.length ) {

		return `${intro}<p>No A/B runs logged yet. <code>npm run bench:release</code> compares the newest release with the one before it; ` +
			'any <code>npm run bench:ab -- &lt;ref&gt;</code> on a clean working tree is logged too.</p>';

	}

	const name = ( side ) => side.ref ?? side.commit.slice( 0, 8 );
	const head = ab.links.map( ( l ) => `<th class="num" title="${esc( `${l.base.commit.slice( 0, 8 )} ${subjects.get( l.base.commit ) ?? ''}\n→ ${l.head.commit.slice( 0, 8 )} ${subjects.get( l.head.commit ) ?? ''}` )}">` +
		`${esc( name( l.base ) )} → ${esc( name( l.head ) )}<small>${day( l.at )}</small></th>` ).join( '' );
	const since = ab.chain.length > 1
		? `<th class="num">${esc( name( ab.chain[ 0 ].base ) )} → ${esc( name( ab.chain.at( - 1 ).head ) )}<small>${ab.chain.length} runs chained</small></th>`
		: '';
	const rows = ab.scenes.map( ( id ) => {

		const total = ab.cumulative.get( id );
		const totalCell = since
			? `<td class="num">${total ? `${signed( total.pct )}${total.changed ? ' <span class="changed" title="the scene changed along the way">◆</span>' : ''}` : '—'}</td>`
			: '';
		return `<tr><td>${esc( id )}</td>${ab.links.map( ( l ) => abCell( l.scenes.find( ( s ) => s.scene === id ) ) ).join( '' )}${totalCell}</tr>`;

	} ).join( '\n' );

	return `${intro}<div class="table-scroll"><table class="ab"><thead><tr><th>scene</th>${head}${since}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`;

}

function trendReportHTML( model, { subjects, generatedAt } ) {

	const { runs, scenes, machine } = model;
	const slower = scenes.filter( ( s ) => s.drift?.direction === 'slower' ).length;
	const faster = scenes.filter( ( s ) => s.drift?.direction === 'faster' ).length;
	const meta = [
		`${generatedAt.toISOString().replace( 'T', ' ' ).slice( 0, 16 )} UTC`,
		machine && `${machine.vendor} ${machine.architecture}, ${machine.renderSize}`,
		runs.length && `${runs.length} runs, ${day( runs[ 0 ].at )} to ${day( runs.at( - 1 ).at )}`,
		model.otherMachines + model.ab.otherMachines > 0 && `${model.otherMachines + model.ab.otherMachines} runs from other machines left out`,
	].filter( Boolean ).join( ' · ' );

	const cards = scenes.map( ( scene ) => {

		const d = scene.drift;
		const sub = d ? `last ${TREND.recentRuns} runs ${ms( d.recent )} ms against ${ms( d.earlier )} before (${signed( d.pct, 0 )})` : 'too few runs to judge';
		return `<section class="chart" id="${esc( scene.id )}"><h3>${esc( scene.id )} ${flagHTML( d )}</h3>` +
			`<p class="muted">${esc( sub )}</p>${sceneChart( scene, runs, subjects )}</section>`;

	} ).join( '\n' );

	const tableRows = scenes.map( ( scene ) => {

		const d = scene.drift;
		return `<tr><td><a href="#${esc( scene.id )}">${esc( scene.id )}</a></td><td class="num">${scene.points.length}</td>` +
			`<td class="num">${ms( scene.points.at( - 1 ).ms )}</td><td class="num">${d ? ms( d.earlier ) : '—'}</td>` +
			`<td class="num">${d ? ms( d.recent ) : '—'}</td><td class="num">${d ? signed( d.pct ) : '—'}</td>` +
			`<td>${flagHTML( d )}${scene.breaks.length ? ` <span class="muted">changed ${scene.breaks.length}×</span>` : ''}</td></tr>`;

	} ).join( '\n' );

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bench performance trend</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --page: #f9f9f7; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --series: #2a78d6; --critical: #d03b3b; --good: #0ca30c; --ring: rgba(11,11,11,0.10); }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --surface: #1a1a19; --page: #0d0d0d; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835; --series: #3987e5; --ring: rgba(255,255,255,0.10); } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1280px; padding: 16px; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 4px; }
h3 { font-size: 14px; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; overflow-wrap: anywhere; }
p { margin: 4px 0 8px; }
a { color: inherit; }
code { font-size: 13px; }
.muted { color: var(--ink-2); }
.key { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 16px; color: var(--ink-2); }
.key svg { display: inline-block; width: 12px; height: 12px; vertical-align: middle; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.chart { background: var(--surface); border: 1px solid var(--ring); border-radius: 8px; padding: 10px 10px 4px; }
.chart p { font-size: 12px; margin: 2px 0 4px; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.break { stroke: var(--axis); stroke-width: 1; }
.mark-break { fill: var(--ink-2); }
.tick, .end { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.end { fill: var(--ink-2); }
.line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.pt { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
.pt.open { fill: var(--surface); stroke: var(--series); }
.key .pt { stroke: var(--page); }
.key .pt.open { fill: var(--page); stroke: var(--series); }
.hit { fill: transparent; cursor: default; }
.flag { font-size: 12px; font-weight: 600; white-space: nowrap; }
.flag .icon, td.slower .icon, td.faster .icon { font-size: 10px; margin-right: 3px; }
.flag.slower .icon, td.slower .icon { color: var(--critical); }
.flag.faster .icon, td.faster .icon { color: var(--good); }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--surface); }
table.ab { width: auto; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
th { font-weight: 600; vertical-align: bottom; }
th small { display: block; font-weight: 400; color: var(--ink-2); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td.slower, td.faster { font-weight: 600; }
td.unchanged, td.inconclusive { color: var(--ink-2); }
td.inconclusive { font-style: italic; }
.changed { color: var(--ink-2); }
details { margin-top: 24px; }
summary { cursor: pointer; font-weight: 600; }
#tip { position: fixed; z-index: 1; max-width: 360px; padding: 6px 8px; border-radius: 6px; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); box-shadow: 0 2px 8px rgba(0,0,0,0.15); font-size: 12px; white-space: pre-line; pointer-events: none; }
</style>
</head>
<body>
<h1>Bench performance trend</h1>
<p class="muted">${esc( meta )}</p>
${runs.length ? `<p>GPU milliseconds of ray tracing (the compute passes) a sample, from <code>bench</code> / <code>bench:perf</code>, at 256²: one pass a run, so a single point is not evidence. ` +
`Runs before 2026-10-14 also counted the display passes, whose timestamps overlap the tracing on Apple GPUs and read either ~0 or most of it, so each line breaks where the measure changed. ` +
`<code>oidn-fast</code> and <code>oidn-high</code> are milliseconds a 1920×1080 denoise instead: OIDN's network on the GPU. ` +
`Runs are evenly spaced, oldest on the left; hover a point for its date and commit. ` +
`A scene is flagged when its last ${TREND.recentRuns} runs all sit past its earlier median and their median is ${TREND.flagPct} % or more away. ` +
`<strong>${slower} slower</strong>, <strong>${faster} faster</strong> of ${scenes.length} scenes.</p>
<div class="key"><span><svg width="12" height="12"><circle class="pt" cx="6" cy="6" r="4"/></svg> committed code</span>` +
`<span><svg width="12" height="12"><circle class="pt open" cx="6" cy="6" r="4"/></svg> uncommitted changes, or commit not recorded</span>` +
`<span><svg width="12" height="12"><path class="pt" d="M6 1l5 8h-10z"/></svg> off the top (over ${TREND.clampRatio}× the scene's median)</span>` +
`<span><svg width="12" height="12"><rect class="mark-break" x="3" y="3" width="6" height="6" transform="rotate(45 6 6)"/></svg> the scene itself changed (hover for what)</span></div>
<div class="charts">
${cards}
</div>` : '<p>No perf runs logged yet: <code>npm run bench:perf</code> adds one.</p>'}
${abSectionHTML( model.ab, subjects )}
${runs.length ? `<details><summary>Table view</summary><div class="table-scroll"><table>
<thead><tr><th>scene</th><th class="num">runs</th><th class="num">latest ms</th><th class="num">earlier ms</th><th class="num">last ${TREND.recentRuns} ms</th><th class="num">change</th><th></th></tr></thead>
<tbody>
${tableRows}
</tbody></table></div></details>` : ''}
<div id="tip" hidden></div>
<script>
const tip = document.getElementById( 'tip' );
const place = ( e ) => {
	tip.style.left = Math.min( e.clientX + 12, innerWidth - tip.offsetWidth - 8 ) + 'px';
	tip.style.top = Math.min( e.clientY + 12, innerHeight - tip.offsetHeight - 8 ) + 'px';
};
document.addEventListener( 'pointerover', ( e ) => {
	const target = e.target.closest( '[data-tip]' );
	tip.hidden = ! target;
	if ( target ) { tip.textContent = target.getAttribute( 'data-tip' ); place( e ); }
} );
document.addEventListener( 'pointermove', ( e ) => { if ( ! tip.hidden ) place( e ); } );
</script>
</body>
</html>
`;

}
