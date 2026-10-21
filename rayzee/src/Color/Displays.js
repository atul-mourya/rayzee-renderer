/**
 * The canvas colour space a display's encoding *is*, by its name: sRGB, or "Display P3" (P3 primaries with the sRGB
 * curve). Every other display — Rec.1886 and gamma 2.2's curves, cinema P3, Rec.2020, HDR — the canvas shows converted.
 * With a config loaded the engine measures this instead (`ColorManagement.displayFit`).
 *
 * @returns {'srgb'|'display-p3'|null}
 */
export function displayCanvasFit( display ) {

	const name = String( display ?? '' );
	if ( /(hdr|pq|hlg|2100|st2084)/i.test( name ) ) return null;
	if ( /^display\s*p3\b/i.test( name ) ) return 'display-p3';
	if ( /^srgb\b(?!.*(p3|2020))/i.test( name ) ) return 'srgb';
	return null;

}

const HDR_ENCODINGS = new Set( [ 'hdr-video', 'edr-video' ] );
const HDR_DISPLAY_NAME = /(^|[^a-z])(hdr|pq|hlg|st-?2084|2100)([^a-z]|$)/i;

/** The encodings of the colour spaces a display's views land in. ACES configs name that space `<USE_DISPLAY_NAME>`. */
function displayEncodings( config, display ) {

	const encodingOf = new Map();
	for ( const c of config?.colorSpaces ?? [] ) {

		for ( const n of [ c.name, ...( c.aliases ?? [] ) ] ) encodingOf.set( n, c.encoding );

	}

	const spaceOf = v => ( v.colorSpace === '<USE_DISPLAY_NAME>' ? display : v.colorSpace );
	return ( config?.views?.[ display ] ?? [] ).map( v => encodingOf.get( spaceOf( v ) ) ).filter( Boolean );

}

/**
 * Whether a display is HDR, the way Blender splits its Display menu: its colour space says `encoding: hdr-video`, or
 * `edr-video` for Apple's extended range. The name is the fallback, for configs that leave encoding out.
 * @param {Object} config - as `describeConfig()`
 */
export function isHdrDisplay( config, display ) {

	const encodings = displayEncodings( config, display );
	if ( encodings.length ) return encodings.some( e => HDR_ENCODINGS.has( e ) );
	return HDR_DISPLAY_NAME.test( display );

}

const HDR_PEAK_NITS = 1000;

// "ACES 2.0 - HDR 1000 nits (P3 D65)" → "aces 2.0".
const viewFamily = name => String( name ).replace( /\([^)]*\)/g, ' ' ).split( /\s+-\s+/ )[ 0 ].trim().replace( /\s+/g, ' ' ).toLowerCase();
const unversioned = family => family.replace( /\s*\d+(\.\d+)*$/, '' );
const viewRange = name => ( /\bHDR\b/i.test( name ) ? 'hdr' : /\bSDR\b/i.test( name ) ? 'sdr' : null );

function ranksBefore( a, b ) {

	const i = a.findIndex( ( v, k ) => v !== b[ k ] );
	return i >= 0 && a[ i ] < b[ i ];

}

const dataSpaces = config => new Set( ( config?.colorSpaces ?? [] ).filter( c => c.isData ).flatMap( c => [ c.name, ...( c.aliases ?? [] ) ] ) );

/** Whether a view shows data as it is ("Raw"): there is nothing to convert for a screen. */
export function isDataView( config, display, view ) {

	return dataSpaces( config ).has( config?.views?.[ display ]?.find( v => v.name === view )?.colorSpace );

}

/** Whether two views are one tone mapping for different displays: "AgX" and "AgX - HDR 1000 nits", not "ACES 1.3" and "ACES 2.0". */
export function sameToneMapping( a, b ) {

	return viewFamily( a ) === viewFamily( b );

}

// Across releases too: ACES 1.3's "ACES 1.0 - SDR Video" and "ACES 1.1 - HDR Video".
const related = ( a, b ) => unversioned( viewFamily( a ) ) === unversioned( viewFamily( b ) );

// Lower ranks first: the same family before another release of it, the range the display shows, the same name, 1000
// nits on an HDR display, P3.
function rankView( from, to, hdr ) {

	const range = viewRange( to );
	const nits = Number( /(\d+)\s*nits/i.exec( to )?.[ 1 ] ?? HDR_PEAK_NITS );
	return [
		viewFamily( to ) === viewFamily( from ) ? 0 : 1,
		( hdr ? range === 'hdr' : range !== 'hdr' ) ? 0 : 1,
		to === from ? 0 : 1,
		hdr ? Math.abs( Math.log2( nits / HDR_PEAK_NITS ) ) : 0,
		/p3/i.test( to ) ? 0 : 1,
	];

}

function bestView( config, view, target ) {

	const isData = dataSpaces( config );
	const hdr = isHdrDisplay( config, target );
	let best = null;
	for ( const v of config?.views?.[ target ] ?? [] ) {

		if ( isData.has( v.colorSpace ) || ! related( view, v.name ) ) continue;
		const rank = rankView( view, v.name, hdr );
		if ( ! best || ranksBefore( rank, best.rank ) ) best = { view: v.name, rank };

	}

	return best;

}

/**
 * The view on display `target` with the same tone mapping as `view` on `display`: "AgX" on sRGB is "AgX - HDR 1000 nits"
 * on Rec.2100-PQ and back again. Null when `target` has none.
 * @param {Object} config - as `describeConfig()`
 */
export function matchingView( config, display, view, target ) {

	if ( isDataView( config, display, view ) ) {

		const isData = dataSpaces( config );
		return config?.views?.[ target ]?.find( v => isData.has( v.colorSpace ) )?.name ?? null;

	}

	return bestView( config, view, target )?.view ?? null;

}

/**
 * The same tone mapping on one of the config's HDR displays (Blender's "AgX" → "AgX - HDR 1000 nits"); an untagged view
 * ("Standard") is its own. Prefers 1000 nits, P3, an EDR display, then PQ.
 *
 * @param {Object} config - as `describeConfig()`
 * @returns {?{ display: string, view: string }} null when the config has none
 */
export function hdrViewFor( config, display, view ) {

	if ( isDataView( config, display, view ) ) return null;
	if ( isHdrDisplay( config, display ) ) return { display, view };
	if ( viewRange( view ) === 'hdr' ) return null;

	let best = null;
	for ( const d of config?.displays ?? [] ) {

		if ( ! isHdrDisplay( config, d ) ) continue;
		const match = bestView( config, view, d );
		const untagged = viewRange( match?.view ) === null;
		if ( ! match || viewRange( match.view ) === 'sdr' || ( untagged && ( match.rank[ 0 ] || viewRange( view ) !== null ) ) ) continue;

		const rank = [ ...match.rank, displayEncodings( config, d ).includes( 'edr-video' ) ? 0 : /pq|st-?2084/i.test( d ) ? 1 : 2 ];
		if ( ! best || ranksBefore( rank, best.rank ) ) best = { display: d, view: match.view, rank };

	}

	return best && { display: best.display, view: best.view };

}
