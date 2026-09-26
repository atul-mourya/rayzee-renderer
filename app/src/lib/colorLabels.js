/**
 * What the colour-management menus show an artist, derived from what an OCIO config carries.
 *
 * OCIO's own guidance for applications is to build menus from each item's UI name, family and
 * description, filtered by category — the config authors put that data there for this. The ACES
 * configs tag colour spaces `working-space` and `texture`; Blender's has no tags but groups spaces
 * into families and names its looks per view. Every rule here reads that data rather than a list of
 * names kept in the app, so a studio config gets the same treatment.
 *
 * Plain functions over the config description, so they are tested without a browser.
 */

const BUILTIN = /^(cg|studio)-config-v([\d.]+)_aces-v([\d.]+)_ocio-v([\d.]+)$/;

/** Parse a built-in config name, or null for anything else. */
export function parseBuiltinConfig( name ) {

	const m = BUILTIN.exec( String( name ?? '' ).replace( /^ocio:\/\//, '' ) );
	if ( ! m ) return null;
	return { kind: m[ 1 ], version: m[ 2 ], aces: m[ 3 ], ocio: m[ 4 ] };

}

const newer = ( a, b ) => {

	const pa = a.split( '.' ).map( Number ), pb = b.split( '.' ).map( Number );
	for ( let i = 0; i < Math.max( pa.length, pb.length ); i ++ ) {

		if ( ( pa[ i ] ?? 0 ) !== ( pb[ i ] ?? 0 ) ) return ( pa[ i ] ?? 0 ) > ( pb[ i ] ?? 0 );

	}

	return false;

};

/**
 * The runtime's built-in configs as an artist should see them: one entry per ACES version, the
 * newest CG config of it. Older builds render the same ACES and Studio configs only add camera
 * spaces, so neither is offered; a pipeline pinned to one loads its folder.
 *
 * @returns {{ presets: Array<{ value, label, description, hint }> }}
 */
export function builtinConfigOptions( builtins ) {

	const best = new Map();
	for ( const b of builtins ) {

		const p = parseBuiltinConfig( b.name );
		if ( ! p || p.kind !== 'cg' ) continue;
		const held = best.get( p.aces );
		if ( ! held || newer( p.version, held.p.version ) ) best.set( p.aces, { b, p } );

	}

	const presets = [ ...best.values() ]
		.sort( ( x, y ) => ( newer( x.p.aces, y.p.aces ) ? - 1 : 1 ) )
		.map( ( { b, p }, i ) => ( {
			value: b.name, label: `ACES ${p.aces}`, description: b.uiName,
			hint: i === 0 ? 'film and VFX standard, latest' : 'film and VFX standard, previous',
		} ) );

	return { presets };

}

function builtinConfigLabel( name ) {

	const p = parseBuiltinConfig( name );
	if ( ! p ) return null;
	return `ACES ${p.aces}${p.kind === 'studio' ? ' Studio' : ''} (v${p.version})`;

}

/** A short name for whichever config is loaded. */
export function configLabel( config, presets = [] ) {

	if ( ! config ) return 'None';
	const preset = presets.find( p => p.value === config.id );
	if ( preset ) return preset.label;
	return builtinConfigLabel( config.id ) ?? config.name ?? config.id;

}

/** "sRGB - Display" → "sRGB". The suffix is an ACES naming convention, not information. */
export function displayLabel( name ) {

	return String( name ).replace( /\s+-\s+display$/i, '' );

}

const withoutParens = s => s.replace( /\s*\([^)]*\)\s*$/, '' ).trim();

/**
 * Short labels for one display's views, as a Map from view name.
 *
 * "ACES 2.0 - SDR 100 nits (Rec.709)" is "ACES 2.0" — the rest restates the display. Detail comes
 * back only where two views would otherwise read the same, the HDR displays especially, where
 * "(P3 D65)" and "(Rec.2020)" are all that tell two views apart.
 */
export function viewLabels( views ) {

	const names = views.map( v => ( typeof v === 'string' ? v : v.name ) );
	const parts = names.map( n => {

		const at = n.indexOf( ' - ' );
		return at < 0 ? { head: n, tail: '' } : { head: n.slice( 0, at ), tail: n.slice( at + 3 ) };

	} );

	const count = keys => keys.reduce( ( m, k ) => m.set( k, ( m.get( k ) ?? 0 ) + 1 ), new Map() );

	let labels = parts.map( p => p.head );
	let seen = count( labels );
	labels = labels.map( ( l, i ) => ( seen.get( l ) > 1 && parts[ i ].tail ? `${parts[ i ].head} · ${withoutParens( parts[ i ].tail )}` : l ) );
	seen = count( labels );
	labels = labels.map( ( l, i ) => ( seen.get( l ) > 1 && parts[ i ].tail ? `${parts[ i ].head} · ${parts[ i ].tail}` : l ) );

	return new Map( names.map( ( n, i ) => [ n, labels[ i ] ] ) );

}

const TECHNICAL_LOOK = /gamut compression|^lmt\b/i;

/**
 * The looks that belong with a view, as Blender presents them.
 *
 * A look named "<view> - Punchy" is that view's, and is offered as "Punchy". When a view has looks
 * of its own, only those are offered; otherwise the unprefixed looks are. Measured against Blender:
 * with AgX it accepts only the "AgX - …" looks, with Standard or Filmic only the plain contrast ones.
 *
 * Technical looks — gamut compression, LMTs — come back separately: they fix camera footage, they
 * are not a grade, and a list that mixes the two invites the wrong choice.
 *
 * @returns {{ creative: Array<{ value, label, description }>, technical: Array<{ value, label, description }> }}
 */
export function looksForView( looks, viewName, allViewNames = [] ) {

	const prefixOf = look => allViewNames.find( v => look.name.startsWith( `${v} - ` ) ) ?? null;
	const own = looks.filter( l => prefixOf( l ) === viewName );
	const pool = own.length ? own : looks.filter( l => prefixOf( l ) === null );

	const creative = [], technical = [];
	for ( const l of pool ) {

		const bare = own.length ? l.name.slice( viewName.length + 3 ) : l.name;
		const isTechnical = TECHNICAL_LOOK.test( l.name ) || TECHNICAL_LOOK.test( l.description ?? '' );
		const label = isTechnical ? bare.replace( /^aces\s+[\d.]+\s+/i, '' ) : bare;
		( isTechnical ? technical : creative ).push( { value: l.name, label, description: l.description || l.name, hint: hintFrom( LOOK_HINTS, label ) } );

	}

	return { creative, technical };

}

const KNOWN_WORKING = /(rec\.?\s*709|rec\.?\s*2020|acescg|p3)/i;

/** "Linear Rec.709 (sRGB)" → "Rec.709", "Linear P3-D65" → "P3-D65". */
export function workingSpaceLabel( name ) {

	return String( name ).replace( /^linear\s+/i, '' ).replace( /\s*\(srgb\)\s*$/i, '' );

}

/**
 * The spaces worth rendering in, native one first.
 *
 * A config that tags them (`working-space`, linear) is taken at its word. One that does not falls
 * back to the linear family, narrowed to the well-known gamuts — Blender, with its whole linear
 * family to choose from, offers only Rec.709, Rec.2020 and ACEScg. The interchange space is never
 * offered: ACES2065-1 is for archive and handover, and its primaries lie outside visible colour.
 */
export function workingSpaceOptions( config, nativeSpace ) {

	if ( ! config ) return [];

	const interchange = config.roles?.aces_interchange ?? null;
	const spaces = config.colorSpaces.filter( c => ! c.isData && c.name !== interchange );
	const linear = c => c.encoding === 'scene-linear' || ( ! c.encoding && /linear/i.test( c.family ?? '' ) ) || c.name === config.sceneLinear;

	let picked = spaces.filter( c => ( c.categories ?? [] ).some( k => k.toLowerCase() === 'working-space' ) && linear( c ) );
	if ( picked.length === 0 ) picked = spaces.filter( c => linear( c ) && KNOWN_WORKING.test( c.name ) );

	const names = [ ...new Set( [ nativeSpace, config.sceneLinear, ...picked.map( c => c.name ) ].filter( Boolean ) ) ];
	return names
		.filter( n => spaces.some( c => c.name === n ) || n === nativeSpace )
		.map( n => ( {
			value: n,
			label: workingSpaceLabel( n ),
			description: n === nativeSpace
				? `${n} — what the engine renders in without colour management. Existing scenes look as they always have.`
				: `${n}${n === config.sceneLinear ? ' — the space this config names for rendering' : ''}`,
			native: n === nativeSpace,
			hint: n === nativeSpace ? 'standard; scenes look as they always have' : hintFrom( WORKING_SPACE_HINTS, n ),
		} ) );

}

const SPACE_ALIASES = {
	'sRGB Encoded Rec.709 (sRGB)': 'sRGB',
	'Linear Rec.709 (sRGB)': 'Linear Rec.709',
};

/** A short name for a colour space in a texture or export menu. */
export function spaceLabel( name ) {

	if ( SPACE_ALIASES[ name ] ) return SPACE_ALIASES[ name ];
	return String( name ).replace( /\s+-\s+(display|texture)$/i, '' );

}

const groupByFamily = spaces => {

	const groups = new Map();
	for ( const c of spaces ) {

		const family = ( c.family || 'Other' ).split( /[/|]/ )[ 0 ];
		if ( ! groups.has( family ) ) groups.set( family, [] );
		groups.get( family ).push( { value: c.name, label: spaceLabel( c.name ), description: c.description || c.name } );

	}

	return [ ...groups ].map( ( [ family, items ] ) => ( { family, items } ) );

};

/**
 * Colour spaces a texture can be in, grouped by family.
 *
 * The config's `texture` tag where it has one — in the ACES config that is sRGB, the gamma
 * encodings, the linear gamuts, ACEScg and Raw, and not the display spaces. Without tags, every
 * non-display space, as Blender offers.
 */
export function textureSpaceGroups( config ) {

	if ( ! config ) return [];

	const tagged = config.colorSpaces.filter( c => ( c.categories ?? [] ).some( k => k.toLowerCase() === 'texture' ) );
	const spaces = tagged.length ? tagged : config.colorSpaces.filter( c => ! /display/i.test( c.family ?? '' ) );
	return groupByFamily( spaces );

}

/**
 * Spaces an EXR can be delivered in: scene-referred ones. An EXR carries light, so a display space
 * there is almost always a mistake; the interchange space leads, since delivery is what it is for.
 */
export function exportSpaceOptions( config ) {

	if ( ! config ) return [];

	const interchange = config.roles?.aces_interchange ?? null;
	const linear = config.colorSpaces.filter( c => ! c.isData && ( c.encoding === 'scene-linear' || ( ! c.encoding && /linear/i.test( c.family ?? '' ) ) ) );
	linear.sort( ( a, b ) => ( b.name === interchange ) - ( a.name === interchange ) );
	return linear.map( c => ( {
		value: c.name,
		label: spaceLabel( c.name ),
		description: c.name === interchange ? `${c.name} — the ACES interchange space, for delivery and archive` : ( c.description || c.name ),
		hint: hintFrom( EXPORT_SPACE_HINTS, c.name ),
	} ) );

}

// One-line hints for artists, first match wins, so the specific names sit above the general ones.
const SCREEN_HINTS = [
	[ /hlg/i, 'HDR broadcast' ],
	[ /st-?2084.*p3|p3.*st-?2084/i, 'HDR mastering monitors' ],
	[ /pq|st-?2084/i, 'HDR10 TV' ],
	[ /hdr/i, 'Apple HDR screens' ],
	[ /display p3/i, 'Apple and wide-colour screens' ],
	[ /p3-d65|dci/i, 'cinema projectors' ],
	[ /1886/i, 'TV and video' ],
	[ /2020/i, 'wide-colour TV' ],
	[ /gamma 2\.2/i, 'monitors set to gamma 2.2' ],
	[ /srgb/i, 'most monitors and laptops' ],
];

const TONE_MAPPING_HINTS = [
	[ /false colou?r/i, 'exposure check' ],
	[ /filmic log|\blog\b/i, 'flat log image for grading (technical)' ],
	[ /^raw$|^none$|un-?tone-?mapped/i, 'no conversion (technical)' ],
	[ /agx/i, 'natural, film-like (recommended)' ],
	[ /neutral/i, 'accurate product colours' ],
	[ /aces/i, 'film and VFX standard' ],
	[ /filmic/i, "Blender's older film look" ],
	[ /standard/i, 'no highlight roll-off' ],
	[ /reinhard/i, 'soft, simple curve' ],
	[ /cineon/i, 'film-scan curve' ],
	[ /linear/i, 'no curve; highlights clip' ],
];

const WORKING_SPACE_HINTS = [
	[ /acescg/i, 'wide gamut for ACES pipelines' ],
	[ /2020/i, 'wide gamut for HDR and TV work' ],
	[ /p3/i, 'wide gamut, as on Apple and cinema screens' ],
	[ /e-?gamut/i, "FilmLight's very wide gamut" ],
];

const EXPORT_SPACE_HINTS = [
	[ /2065/i, 'archive and hand-off to other studios' ],
	[ /acescg/i, 'compositing in an ACES pipeline' ],
	[ /709|srgb/i, 'most compositing apps' ],
	[ /2020|p3/i, 'wide-gamut compositing' ],
	[ /e-?gamut/i, 'grading in Baselight' ],
];

// Only where the name leaves the effect unclear: "High Contrast" needs no second line.
const LOOK_HINTS = [
	[ /^punchy$/i, 'richer colour, darker overall' ],
	[ /^gr[ae]yscale$|black and white/i, 'black and white' ],
	[ /^base contrast$/i, "the tone mapping's own contrast" ],
	[ /gamut compression/i, 'tames over-saturated camera colours' ],
];

const hintFrom = ( rules, name ) => rules.find( ( [ re ] ) => re.test( name ) )?.[ 1 ] ?? null;

/** What a Screen option is for, in a few words — "Rec.1886" means nothing to most artists. */
export const screenHint = name => hintFrom( SCREEN_HINTS, String( name ) );

/** What a Tone Mapping option does, in a few words. Works for OCIO views and the built-in curves alike. */
export const toneMappingHint = name => hintFrom( TONE_MAPPING_HINTS, String( name ) );

const HDR_ENCODINGS = new Set( [ 'hdr-video', 'edr-video' ] );
const HDR_DISPLAY_NAME = /(^|[^a-z])(hdr|pq|hlg|st-?2084|2100)([^a-z]|$)/i;

/**
 * Whether a display is HDR, the way Blender splits its Display menu. A config says so itself: the
 * colour space a display's views land in carries `encoding: hdr-video`, or `edr-video` for Apple's
 * extended range. ACES configs call that space `<USE_DISPLAY_NAME>`, meaning the display's own.
 * The name is the fallback, for configs that leave encoding out.
 */
export function isHdrDisplay( config, display ) {

	const encodingOf = new Map();
	for ( const c of config?.colorSpaces ?? [] ) {

		for ( const n of [ c.name, ...( c.aliases ?? [] ) ] ) encodingOf.set( n, c.encoding );

	}

	const spaceOf = v => ( v.colorSpace === '<USE_DISPLAY_NAME>' ? display : v.colorSpace );
	const encodings = ( config?.views?.[ display ] ?? [] ).map( v => encodingOf.get( spaceOf( v ) ) ).filter( Boolean );
	if ( encodings.length ) return encodings.some( e => HDR_ENCODINGS.has( e ) );
	return HDR_DISPLAY_NAME.test( display );

}

/**
 * Displays split into SDR and HDR. A display this screen cannot show as intended is still offered
 * (a render graded for a TV, a file for a cinema), but its tooltip says the screen shows it converted.
 *
 * @param {{ p3: boolean }} screen - what the screen reports
 */
export function displaySections( config, canvasFit, screen = { p3: false } ) {

	const sdr = [], hdr = [];
	for ( const d of config?.displays ?? [] ) {

		const fit = canvasFit( d );
		const native = fit === 'srgb' || ( fit === 'display-p3' && screen.p3 );
		const label = displayLabel( d );
		const entry = { value: d, label, native, hint: screenHint( d ), description: native ? d : `${label} — this screen shows it converted` };
		( isHdrDisplay( config, d ) ? hdr : sdr ).push( entry );

	}

	return { sdr, hdr };

}
