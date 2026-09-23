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
 * The runtime's built-in configs as an artist should see them: one entry per ACES version — the
 * newest CG config of it — and everything else kept, but out of the way.
 *
 * @returns {{ presets: Array<{ value, label, description }>, others: Array<{ value, label, description }> }}
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
		.map( ( { b, p } ) => ( { value: b.name, label: `ACES ${p.aces}`, description: b.uiName } ) );

	const chosen = new Set( presets.map( p => p.value ) );
	const others = builtins
		.filter( b => ! chosen.has( b.name ) )
		.map( b => ( { value: b.name, label: builtinConfigLabel( b.name ) ?? b.uiName, description: b.uiName } ) );

	return { presets, others };

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
		( isTechnical ? technical : creative ).push( { value: l.name, label, description: l.description || l.name } );

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
	} ) );

}

/**
 * Displays split into what this screen can show as intended and the rest.
 *
 * The rest are still worth choosing — a render graded for a TV, a saved file for a cinema — but the
 * screen shows them converted, and an artist should know that before trusting what they see.
 *
 * @param {{ p3: boolean }} screen - what the screen reports
 */
export function displayGroups( displays, canvasFit, screen = { p3: false } ) {

	const here = [], elsewhere = [];
	for ( const d of displays ) {

		const fit = canvasFit( d );
		const shown = fit === 'srgb' || ( fit === 'display-p3' && screen.p3 );
		( shown ? here : elsewhere ).push( { value: d, label: displayLabel( d ), description: d } );

	}

	return { here, elsewhere };

}
