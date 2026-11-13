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
	// An image (data URI) and a canvas: no CSS reaches them.
	'components/ui/env-catalog.jsx': [ '#94a3b8' ],
	'components/layout/Viewports/StatsPanel.jsx': [ '#ffffff', '#1e293b' ],
	'components/ui/texture-preview.jsx': [ '#444', '#fff', '#333', '#999', '#222', '#666' ],
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
		for ( const m of text.matchAll( new RegExp( `<${name}\\b[^>]*>`, 'g' ) ) ) {

			found.push( { at: `${path.relative( ROOT, file )}:${text.slice( 0, m.index ).split( '\n' ).length}`, tag: m[ 0 ] } );

		}

	}

	return found;

}

function block( selector ) {

	for ( let start = CSS.indexOf( `${selector} {` ); start >= 0; start = CSS.indexOf( `${selector} {`, start + 1 ) ) {

		const text = CSS.slice( start, CSS.indexOf( '\n  }', start ) );
		if ( text.includes( '--background:' ) ) return text;

	}

	throw new Error( `no ${selector} block sets the tokens` );

}

function definedIn( text ) {

	return new Set( [ ...text.matchAll( /^\s*(--[\w-]+)\s*:/gm ) ].map( m => m[ 1 ] ) );

}

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

	it( 'every colour the theme maps is defined in both themes', () => {

		const theme = CSS.slice( CSS.indexOf( '@theme {' ), CSS.indexOf( '@layer base {' ) );
		const used = new Set( [ ...theme.matchAll( /--color-[\w-]+:\s*(?:hsl\()?var\((--[\w-]+)\)/g ) ].map( m => m[ 1 ] ) );
		const light = definedIn( block( ':root' ) );
		const dark = definedIn( block( '.dark' ) );

		expect( used.size ).toBeGreaterThan( 20 );
		expect( [ ...used ].filter( name => ! light.has( name ) ) ).toEqual( [] );
		// The dark theme sets every colour token the light one does, so no colour falls through to the light value.
		const colourTokens = [ ...light ].filter( name => name !== '--radius' );
		expect( colourTokens.filter( name => ! dark.has( name ) ) ).toEqual( [] );
		expect( [ ...dark ].filter( name => ! light.has( name ) ) ).toEqual( [] );

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
			// One-offs, not sizes: a 20 px square-cornered button, a 24 px round one on a catalog card.
			...tags( 'Button' ).filter( t => /\ssize="(?:sm|icon)"/.test( t.tag ) && /className="[^"]*\bh-[56]\b/.test( t.tag ) && ! /"h-5 text-xs px-2"|h-6 w-6 rounded-full/.test( t.tag ) ),
		];
		expect( restyled.map( t => t.at ) ).toEqual( [] );

	} );

	it( 'control labels use control-label, not opacity on text-xs', () => {

		expect( findings( /className="(?:opacity-50 text-xs|text-xs opacity-50)(?: (?:truncate|shrink-0))?"/g ) ).toEqual( [] );

	} );

	// They replaced text-[9px] / [10px] / [11px], which set no line height.
	it( 'the sizes below xs keep the line height they inherit', () => {

		expect( CSS.match( /--text-(?:3xs|xxs|2xs)--line-height/g ) ).toBeNull();

	} );

} );
