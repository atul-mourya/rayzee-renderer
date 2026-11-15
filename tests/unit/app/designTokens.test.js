import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { cn } from '@/lib/utils';

// The app's colours, sizes and shadows come from the tokens in app/src/index.css (docs/design/DESIGN_SYSTEM.md): no raw
// palette colour or one-off size in a component, and every token defined in both themes.

const ROOT = path.resolve( __dirname, '../../../app/src' );
const CSS = readFileSync( path.join( ROOT, 'index.css' ), 'utf8' );

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const RAW_COLOUR = new RegExp( `\\b(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret|placeholder)-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?\\b`, 'g' );
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
// A colour written into an arbitrary value (`shadow-[…_oklch(…)]`, `bg-[rgb(…)]`) dodges the tokens just the same.
const COLOUR_FUNCTION = /\[[^\]\s"]*(?<![a-zA-Z])(?:oklch|oklab|rgba?|hsla?)\(/g;
const VAR_REF = /var\(\s*(--[\w-]+)/g;
const ARBITRARY_TEXT = /\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/g;

// Colours that are data, not chrome: each says why.
const ALLOWED = {
	// The convergence legend names the colours the engine's overlay draws (Compositor's overlayColor).
	'components/layout/RightSideBar/PathTracerTab.jsx': [ 'bg-red-500', 'bg-yellow-400', 'bg-neutral-400', 'bg-blue-500' ],
	// Material defaults are material values.
	'components/layout/RightSideBar/MaterialTab.jsx': [ '#ffffff', '#000000' ],
	'components/ui/colorinput.jsx': [ '#000000' ],
	// A sample value in the reference page.
	'components/DesignSystem.jsx': [ '#3a5f7d' ],
	// A canvas: no CSS reaches it.
	'components/layout/Viewports/StatsPanel.jsx': [ '#ffffff', '#1e293b' ],
	'components/ui/texture-preview.jsx': [ '#444', '#fff', '#333', '#999', '#222', '#666' ],
};

// Buttons and fields written out of ui/: pictures, tiles and rows rather than buttons. A new one is a Button, or a
// line here.
const OWN_BUTTONS = {
	'components/layout/RightSideBar/AITab.jsx': 2, // a reference's remove mark, a picture to start from
	'components/layout/RightSideBar/ColorManagementSection.jsx': 1, // a section's disclosure row
	'components/layout/RightSideBar/LightsTab.jsx': 3, // gobo and IES tiles and their picker
	'components/layout/TopBar/RecentDialog.jsx': 1, // a recent scene's row
	'components/layout/Viewports/StatsMeter.jsx': 1, // a value over the render, typed into when clicked
};
const OWN_FIELDS = {
	'components/layout/LeftSideBar/Outliner.jsx': 1, // the scene list's search, in its header
	'components/layout/Viewports/StatsMeter.jsx': 1, // a value typed over the render
};

const ICON_SIZES = [ 10, 12, 14, 16 ];

// ui/ parts the reference page leaves out: seen inside another part, or only in their one place.
const NOT_ON_PAGE = {
	InteractionContextMenu: 'the viewport\'s right-click menu',
	card: 'inside the Assets browser',
	'draggable-input': 'inside Vector3',
	'items-catalog': 'the Assets browser',
	'linkable-vector2': 'a texture\'s repeat and offset',
	resizable: 'the panels\' splitters',
	'texture-preview': 'a material\'s texture',
	toast: 'through Toaster',
	toggle: 'inside ToggleGroup',
	trackpad: 'the camera\'s trackpad',
};

function sources( dir ) {

	return readdirSync( dir, { withFileTypes: true } ).flatMap( entry => {

		const full = path.join( dir, entry.name );
		if ( entry.isDirectory() ) return sources( full );
		return /\.(jsx|js)$/.test( entry.name ) ? [ full ] : [];

	} );

}

const COMPONENTS = sources( path.join( ROOT, 'components' ) );

function findings( pattern ) {

	const found = [];
	for ( const file of COMPONENTS ) {

		const name = path.relative( ROOT, file ).split( path.sep ).join( '/' );
		const allowed = ALLOWED[ name ] ?? [];
		const lines = readFileSync( file, 'utf8' ).split( '\n' );
		lines.forEach( ( line, i ) => {

			for ( const match of line.matchAll( pattern ) ) {

				if ( ! allowed.includes( match[ 0 ] ) ) found.push( `${name}:${i + 1} ${match[ 0 ]}` );

			}

		} );

	}

	return found;

}

// The selector's block that sets the colour tokens (:root also sets the font, in another block).
// Every `<Name …>` opening tag in the components, however its attributes are laid out.
function tags( name ) {

	const found = [];
	for ( const file of COMPONENTS ) {

		const text = readFileSync( file, 'utf8' );
		// An attribute's `{…}` may hold `=>` and one level of braces.
		for ( const m of text.matchAll( new RegExp( `<${name}\\b(?:[^>"{]|"[^"]*"|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*>`, 'g' ) ) ) {

			const file_ = path.relative( ROOT, file ).split( path.sep ).join( '/' );
			found.push( { file: file_, at: `${file_}:${text.slice( 0, m.index ).split( '\n' ).length}`, tag: m[ 0 ] } );

		}

	}

	return found;

}

// The token block under `selector` that sets `marker` (:root also sets the font, in another block).
function block( selector, marker ) {

	for ( let start = CSS.indexOf( `${selector} {` ); start >= 0; start = CSS.indexOf( `${selector} {`, start + 1 ) ) {

		const text = CSS.slice( start, CSS.indexOf( '\n  }', start ) );
		if ( text.includes( marker ) ) return text;

	}

	throw new Error( `no ${selector} block sets ${marker}` );

}

function definedIn( text ) {

	return new Map( [ ...text.matchAll( /^\s*(--[\w-]+)\s*:\s*([^;]+);/gm ) ].map( m => [ m[ 1 ], m[ 2 ].trim() ] ) );

}

const MAPPED = new Set( [ ...CSS.slice( CSS.indexOf( '@theme {' ), CSS.indexOf( '@layer base {' ) ).matchAll( /--color-[\w-]+:\s*(?:hsl\()?var\((--[\w-]+)\)/g ) ].map( m => m[ 1 ] ) );

describe( 'design tokens', () => {

	it( 'components use no raw palette colours', () => {

		expect( findings( RAW_COLOUR ) ).toEqual( [] );

	} );

	it( 'components use no hex colours', () => {

		expect( findings( HEX ) ).toEqual( [] );

	} );

	it( 'components write no colour functions into arbitrary values', () => {

		expect( findings( COLOUR_FUNCTION ) ).toEqual( [] );

	} );

	it( 'every var() a component names is defined', () => {

		const defined = new Set( [ ...CSS.matchAll( /(--[\w-]+)\s*:/g ) ].map( m => m[ 1 ] ) );
		const radix = name => name.startsWith( '--radix-' ) || name.startsWith( '--tw-' );
		const missing = [];
		for ( const file of COMPONENTS ) {

			for ( const m of readFileSync( file, 'utf8' ).matchAll( VAR_REF ) ) {

				if ( ! defined.has( m[ 1 ] ) && ! radix( m[ 1 ] ) ) missing.push( `${path.relative( ROOT, file )} ${m[ 1 ]}` );

			}

		}

		expect( missing ).toEqual( [] );

	} );

	it( 'components use the type scale, not pixel sizes', () => {

		expect( findings( ARBITRARY_TEXT ) ).toEqual( [] );

	} );

	it( 'every colour is written once for both themes, or once in each', () => {

		const shared = definedIn( block( ':root', '--scrim:' ) );
		const light = definedIn( block( ':root:not(.dark)', '--background:' ) );
		const dark = definedIn( block( '.dark', '--background:' ) );

		expect( MAPPED.size ).toBeGreaterThan( 20 );
		expect( [ ...MAPPED ].filter( name => ! shared.has( name ) && ! light.has( name ) ) ).toEqual( [] );
		// Each theme sets the same tokens, so neither falls through to the other's value.
		expect( [ ...light.keys() ].filter( name => ! dark.has( name ) ) ).toEqual( [] );
		expect( [ ...dark.keys() ].filter( name => ! light.has( name ) ) ).toEqual( [] );
		// A value both themes share is written once: two copies drift apart.
		expect( [ ...light ].filter( ( [ name, value ] ) => dark.get( name ) === value ).map( ( [ name ] ) => name ) ).toEqual( [] );
		expect( [ ...shared.keys() ].filter( name => light.has( name ) ) ).toEqual( [] );

	} );

	// An HSL token as sRGB; `[ colour, alpha, under ]` is the colour at that alpha over another, composited as CSS does.
	function srgb( value ) {

		if ( Array.isArray( value ) ) {

			const [ over, alpha, under ] = value;
			return srgb( over ).map( ( c, i ) => alpha * c + ( 1 - alpha ) * srgb( under )[ i ] );

		}

		const [ h, s, l ] = value.split( /\s+/ ).map( parseFloat );
		const k = n => ( n + h / 30 ) % 12, a_ = ( s / 100 ) * Math.min( l / 100, 1 - l / 100 );
		return [ 0, 8, 4 ].map( n => l / 100 - a_ * Math.max( - 1, Math.min( k( n ) - 3, 9 - k( n ), 1 ) ) );

	}

	// WCAG 2's contrast: relative luminance of sRGB, (lighter + 0.05) / (darker + 0.05).
	function contrast( a, b ) {

		const luminance = ( value ) => {

			const linear = srgb( value ).map( c => ( c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4 ) );
			return 0.2126 * linear[ 0 ] + 0.7152 * linear[ 1 ] + 0.0722 * linear[ 2 ];

		};

		const [ hi, lo ] = [ luminance( a ), luminance( b ) ].sort( ( x, y ) => y - x );
		return ( hi + 0.05 ) / ( lo + 0.05 );

	}

	it( 'text reads at WCAG AA (4.5:1) on every surface and on the hover grey, in both themes', () => {

		const low = [];
		for ( const [ theme, tokens ] of [[ 'light', definedIn( block( ':root:not(.dark)', '--background:' ) ) ], [ 'dark', definedIn( block( '.dark', '--background:' ) ) ]] ) {

			const pairs = [[ '--primary-foreground', '--primary' ]];
			for ( const text of [ '--foreground', '--muted-foreground', '--primary' ] ) {

				for ( const surface of [ '--background', '--card', '--popover', '--accent', '--muted', '--secondary' ] ) pairs.push( [ text, surface ] );

			}

			for ( const [ text, surface ] of pairs ) {

				const ratio = contrast( tokens.get( text ), tokens.get( surface ) );
				if ( ! ( ratio >= 4.5 ) ) low.push( `${theme} ${text} on ${surface}: ${ratio.toFixed( 2 )}` );

			}

		}

		expect( low ).toEqual( [] );

		// Text on a blue tint (a chosen tab, the loading percent): the tint is primary at 15–30 % over a surface.
		for ( const [ theme, tokens ] of [[ 'light', definedIn( block( ':root:not(.dark)', '--background:' ) ) ], [ 'dark', definedIn( block( '.dark', '--background:' ) ) ]] ) {

			for ( const surface of [ '--background', '--card', '--popover', '--accent', '--muted', '--secondary' ] ) {

				for ( const alpha of [ 0.15, 0.2, 0.3 ] ) {

					const ratio = contrast( tokens.get( '--primary-tint-foreground' ), [ tokens.get( '--primary' ), alpha, tokens.get( surface ) ] );
					if ( ! ( ratio >= 4.5 ) ) low.push( `${theme} --primary-tint-foreground on --primary/${alpha * 100} over ${surface}: ${ratio.toFixed( 2 )}` );

				}

			}

		}

		expect( low ).toEqual( [] );
		// The focus ring and the blue fills are not text: 3:1 against the page.
		for ( const tokens of [ definedIn( block( ':root:not(.dark)', '--background:' ) ), definedIn( block( '.dark', '--background:' ) ) ] ) {

			for ( const mark of [ '--ring', '--primary' ] ) expect( contrast( tokens.get( mark ), tokens.get( '--background' ) ) ).toBeGreaterThanOrEqual( 3 );

		}

		// The formula, against WebAIM's checker: #767676 on white is 4.54:1.
		expect( contrast( '0 0% 46.27%', '0 0% 100%' ) ).toBeCloseTo( 4.54, 2 );

	} );

	it( 'blue text sits on a blue tint only as primary-tint-foreground', () => {

		const lines = COMPONENTS.flatMap( file => readFileSync( file, 'utf8' ).split( '\n' ).map( ( line, i ) => [ `${path.relative( ROOT, file )}:${i + 1}`, line ] ) );
		expect( lines.filter( ( [ , line ] ) => /\bbg-primary\/[1-3]\d\b/.test( line ) && /\btext-primary\b(?!-)/.test( line ) ).map( ( [ at ] ) => at ) ).toEqual( [] );

	} );

	it( 'the reference page shows every colour', () => {

		const page = readFileSync( path.join( ROOT, 'components/DesignSystem.jsx' ), 'utf8' );
		expect( [ ...MAPPED ].map( name => name.slice( 2 ) ).filter( name => ! page.includes( `"${name}"` ) ) ).toEqual( [] );

	} );

	it( 'nothing asks for a colour or movement fade', () => {

		// Turned off on purpose (a19dc9a4, "remove unnecessary animations"); the class would only say otherwise.
		expect( findings( /\btransition-(?:colors|transform)\b/g ) ).toEqual( [] );

	} );

	it( 'flat shadows are empty shadows, never none', () => {

		// Tailwind joins ring and shadow in one box-shadow list; a `none` in it drops the whole list (ring-2 shadow-sm).
		expect( CSS.match( /--shadow[\w-]*:\s*none/g ) ).toBeNull();

	} );

	it( 'cn keeps a token size beside a token colour, and the float shadow in place of the default', () => {

		expect( cn( 'text-xxs', 'text-muted-foreground' ) ).toBe( 'text-xxs text-muted-foreground' );
		expect( cn( 'text-2xs text-muted-foreground', 'text-primary' ) ).toBe( 'text-2xs text-primary' );
		expect( cn( 'text-xs', 'text-3xs' ) ).toBe( 'text-3xs' );
		expect( cn( 'shadow-md', 'shadow-float' ) ).toBe( 'shadow-float' );

	} );

	// A shape the components own, written again where one is used, is a copy that drifts.
	it( 'components take their shape from the shared ones, not from overrides where they are used', () => {

		const restyled = [
			...tags( 'SelectTrigger' ).filter( t => /className="[^"]*\bh-5 rounded-full/.test( t.tag ) ),
			...tags( 'ToggleGroupItem' ).filter( t => /className="text-xs px-3 h-5"/.test( t.tag ) ),
			...tags( 'TabsTrigger' ).filter( t => /className="(?:flex flex-col items-center py-2|text-xs rounded-full|text-xs truncate py-2)"/.test( t.tag ) ),
			...tags( 'TabsList' ).filter( t => /className="[^"]*\b(?:relative grid w-full|h-auto p-0)\b/.test( t.tag ) ),
			// One-offs, not sizes: a 20 px square-cornered button, a 24 px round one on a catalog card.
			...tags( 'Button' ).filter( t => /\ssize="(?:sm|icon)"/.test( t.tag ) && /className="[^"]*\bh-[56]\b/.test( t.tag ) && ! /"h-5 text-xs px-2"|h-6 w-6 rounded-full/.test( t.tag ) ),
		];
		expect( restyled.map( t => t.at ) ).toEqual( [] );

	} );

	it( 'buttons and fields come from ui/, except the ones listed', () => {

		const count = ( name, skip ) => {

			const counts = {};
			for ( const t of tags( name ) ) {

				if ( t.file.startsWith( 'components/ui/' ) || t.file === 'components/DesignSystem.jsx' || skip?.test( t.tag ) ) continue;
				counts[ t.file ] = ( counts[ t.file ] ?? 0 ) + 1;

			}

			return counts;

		};

		expect( count( 'button' ) ).toEqual( OWN_BUTTONS );
		expect( count( 'input', /type="file"/ ) ).toEqual( OWN_FIELDS );

	} );

	it( 'chips over a picture are Chip', () => {

		// A scrim or AI fill with padding and a text size, written where it is used.
		expect( findings( /className="(?=[^"]*\bbg-(?:scrim|ai-\d{3})\b)(?=[^"]*\btext-(?:xs|2xs|xxs)\b)(?=[^"]*\bpx-)[^"]*"/g ) ).toEqual( [] );

	} );

	it( 'icons use the icon sizes', () => {

		const off = {};
		for ( const file of COMPONENTS ) {

			const name = path.relative( ROOT, file ).split( path.sep ).join( '/' );
			for ( const m of readFileSync( file, 'utf8' ).matchAll( /\bsize=\{(\d+)\}/g ) ) {

				if ( ! ICON_SIZES.includes( Number( m[ 1 ] ) ) ) ( off[ name ] ??= [] ).push( Number( m[ 1 ] ) );

			}

		}

		expect( off ).toEqual( {} );

	} );

	it( 'the reference page shows every shared part', () => {

		const page = readFileSync( path.join( ROOT, 'components/DesignSystem.jsx' ), 'utf8' );
		const parts = readdirSync( path.join( ROOT, 'components/ui' ) ).filter( f => f.endsWith( '.jsx' ) ).map( f => f.slice( 0, - 4 ) );
		expect( parts.filter( p => ! page.includes( `"@/components/ui/${p}"` ) && ! NOT_ON_PAGE[ p ] ) ).toEqual( [] );
		expect( Object.keys( NOT_ON_PAGE ).filter( p => ! parts.includes( p ) || page.includes( `"@/components/ui/${p}"` ) ) ).toEqual( [] );

	} );

	it( 'control labels use control-label, not opacity on text-xs', () => {

		expect( findings( /className="(?:opacity-50 text-xs|text-xs opacity-50)(?: (?:truncate|shrink-0))?"/g ) ).toEqual( [] );

	} );

	// They replaced text-[9px] / [10px] / [11px], which set no line height.
	it( 'the sizes below xs keep the line height they inherit', () => {

		expect( CSS.match( /--text-(?:3xs|xxs|2xs)--line-height/g ) ).toBeNull();

	} );

} );
