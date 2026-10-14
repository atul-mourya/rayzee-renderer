/**
 * HTML report of a quality run, written to bench/results/ (git-ignored), images embedded so it opens offline.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { diffHeatmap } from '../lib/metrics.js';
import { decodeDataURL, encodeDataURL, writeDataURL } from '../lib/png.js';
import { PATHS, QUALITY_GATES } from './config.js';

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
