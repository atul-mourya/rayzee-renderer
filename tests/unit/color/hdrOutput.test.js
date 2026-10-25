/**
 * HDR on screen: a view's HDR version found in the config, baked for the canvas (1.0 = 100 nits), and the canvas
 * switched to a half-float, extended-range buffer while it shows one. Runs on the runtime's built-in ACES configs.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { HalfFloatType, NoToneMapping, AgXToneMapping } from 'three';
import { ColorManagement } from '@/core/addons/color/ColorManagement.js';
import { BasicColor } from '@/core/color/BasicColor.js';
import { hdrViewFor, isHdrDisplay, isDataView } from '@/core/addons/color/Displays.js';
import { XYZ_TO_CANVAS, encodeExtended, displayReferenceSpace, buildCanvasView } from '@/core/addons/color/OcioViews.js';
import { makeCpuSampler } from '@/core/addons/color/LutBake.js';
import { describeConfig, getRuntime } from '@/core/addons/color/OcioRuntime.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

const ACES2 = 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';
const ACES13 = 'ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4';
const SDR = { display: 'sRGB - Display', view: 'ACES 2.0 - SDR 100 nits (Rec.709)' };

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

const decode = v => Math.sign( v ) * ( Math.abs( v ) <= 0.04045 ? Math.abs( v ) / 12.92 : Math.pow( ( Math.abs( v ) + 0.055 ) / 1.055, 2.4 ) );

// The XYZ → RGB matrix of a set of primaries and white, from their chromaticities.
function xyzToRgb( [[ xr, yr ], [ xg, yg ], [ xb, yb ]], [ xw, yw ] ) {

	const col = ( x, y ) => [ x / y, 1, ( 1 - x - y ) / y ];
	const P = [ col( xr, yr ), col( xg, yg ), col( xb, yb ) ];
	const m = [ 0, 1, 2 ].map( r => [ P[ 0 ][ r ], P[ 1 ][ r ], P[ 2 ][ r ] ] );
	const inv = a => {

		const [[ a0, a1, a2 ], [ b0, b1, b2 ], [ c0, c1, c2 ]] = a;
		const d = a0 * ( b1 * c2 - b2 * c1 ) - a1 * ( b0 * c2 - b2 * c0 ) + a2 * ( b0 * c1 - b1 * c0 );
		return [
			[ ( b1 * c2 - b2 * c1 ) / d, ( a2 * c1 - a1 * c2 ) / d, ( a1 * b2 - a2 * b1 ) / d ],
			[ ( b2 * c0 - b0 * c2 ) / d, ( a0 * c2 - a2 * c0 ) / d, ( a2 * b0 - a0 * b2 ) / d ],
			[ ( b0 * c1 - b1 * c0 ) / d, ( a1 * c0 - a0 * c1 ) / d, ( a0 * b1 - a1 * b0 ) / d ],
		];

	};

	const w = col( xw, yw );
	const s = inv( m ).map( row => row[ 0 ] * w[ 0 ] + row[ 1 ] * w[ 1 ] + row[ 2 ] * w[ 2 ] );
	return inv( m.map( row => row.map( ( v, i ) => v * s[ i ] ) ) ).flat();

}

/** A renderer as far as colour management touches it, on an on-screen canvas. */
function fakeRenderer() {

	const backend = { parameters: {}, resized: 0, updateSize() {

		this.resized ++;

	} };
	return { toneMapping: AgXToneMapping, outputColorSpace: 'srgb', backend, domElement: new globalThis.HTMLCanvasElement() };

}

describe( 'canvas encoding', () => {

	it( 'uses the CSS Color 4 matrices of sRGB and Display P3', () => {

		const D65 = [ 0.3127, 0.3290 ];
		const srgb = xyzToRgb( [[ 0.64, 0.33 ], [ 0.30, 0.60 ], [ 0.15, 0.06 ]], D65 );
		const p3 = xyzToRgb( [[ 0.680, 0.320 ], [ 0.265, 0.690 ], [ 0.150, 0.060 ]], D65 );
		XYZ_TO_CANVAS.srgb.forEach( ( v, i ) => expect( v ).toBeCloseTo( srgb[ i ], 3 ) );
		XYZ_TO_CANVAS[ 'display-p3' ].forEach( ( v, i ) => expect( v ).toBeCloseTo( p3[ i ], 3 ) );

	} );

	it( 'extends the sRGB curve past 1 and mirrors it below 0', () => {

		expect( encodeExtended( 0 ) ).toBe( 0 );
		expect( encodeExtended( 1 ) ).toBeCloseTo( 1, 12 );
		expect( encodeExtended( 0.18 ) ).toBeCloseTo( 0.4614, 4 );
		expect( encodeExtended( - 0.18 ) ).toBe( - encodeExtended( 0.18 ) );
		expect( encodeExtended( 10 ) ).toBeGreaterThan( 2.5 );
		expect( decode( encodeExtended( 7.3 ) ) ).toBeCloseTo( 7.3, 10 );

	} );

} );

describe( 'which view is the HDR version', () => {

	// Blender 5.1's displays, as `describeConfig()` has them.
	const view = ( name, colorSpace ) => ( { name, colorSpace } );
	const blender = {
		colorSpaces: [
			{ name: 'sRGB', encoding: '' }, { name: 'Display P3', encoding: '' },
			{ name: 'Rec.2100-PQ', encoding: 'hdr-video' }, { name: 'Rec.2100-HLG', encoding: 'hdr-video' },
			{ name: 'Non-Color', isData: true },
		],
		displays: [ 'sRGB', 'Display P3', 'Rec.2100-PQ', 'Rec.2100-HLG' ],
		views: {
			'sRGB': [ view( 'Standard', 'sRGB' ), view( 'ACES 2.0', 'sRGB' ), view( 'AgX', 'sRGB' ), view( 'Filmic', 'sRGB' ), view( 'Raw', 'Non-Color' ) ],
			'Display P3': [ view( 'AgX', 'Display P3' ) ],
			'Rec.2100-PQ': [
				view( 'Standard', 'Rec.2100-PQ' ), view( 'ACES 2.0 - HDR 500 nits', 'Rec.2100-PQ' ), view( 'ACES 2.0 - HDR 1000 nits', 'Rec.2100-PQ' ),
				view( 'ACES 2.0 - HDR 2000 nits', 'Rec.2100-PQ' ), view( 'ACES 2.0 - SDR', 'Rec.2100-PQ' ), view( 'AgX - HDR 1000 nits', 'Rec.2100-PQ' ),
				view( 'AgX - SDR', 'Rec.2100-PQ' ), view( 'Raw', 'Non-Color' ),
			],
			'Rec.2100-HLG': [ view( 'AgX - HDR 1000 nits', 'Rec.2100-HLG' ) ],
		},
	};

	it( 'takes the same tone mapping on an HDR display, at 1000 nits, PQ before HLG', () => {

		expect( hdrViewFor( blender, 'sRGB', 'AgX' ) ).toEqual( { display: 'Rec.2100-PQ', view: 'AgX - HDR 1000 nits' } );
		expect( hdrViewFor( blender, 'Display P3', 'AgX' ) ).toEqual( { display: 'Rec.2100-PQ', view: 'AgX - HDR 1000 nits' } );
		expect( hdrViewFor( blender, 'sRGB', 'ACES 2.0' ) ).toEqual( { display: 'Rec.2100-PQ', view: 'ACES 2.0 - HDR 1000 nits' } );

	} );

	it( 'keeps an untagged view as itself, and finds none for a curve with no HDR version or for data', () => {

		expect( hdrViewFor( blender, 'sRGB', 'Standard' ) ).toEqual( { display: 'Rec.2100-PQ', view: 'Standard' } );
		expect( hdrViewFor( blender, 'sRGB', 'Filmic' ) ).toBeNull();
		expect( hdrViewFor( blender, 'sRGB', 'Raw' ) ).toBeNull();
		expect( isDataView( blender, 'Rec.2100-PQ', 'Raw' ) ).toBe( true );
		expect( hdrViewFor( blender, 'Rec.2100-PQ', 'Raw' ) ).toBeNull();

	} );

	it( 'is a view on an HDR display itself', () => {

		expect( isHdrDisplay( blender, 'Rec.2100-HLG' ) ).toBe( true );
		expect( hdrViewFor( blender, 'Rec.2100-HLG', 'AgX - HDR 1000 nits' ) ).toEqual( { display: 'Rec.2100-HLG', view: 'AgX - HDR 1000 nits' } );

	} );

} );

suite( 'HDR versions in the ACES configs', () => {

	let cm;
	beforeAll( async () => {

		cm = new ColorManagement();

	}, 120000 );

	afterAll( () => {

		cm?.dispose();
		ColorManagement.resetAll();

	} );

	it( 'matches across ACES releases, preferring the P3 and EDR versions', async () => {

		await cm.loadConfig( { builtin: ACES13, registerViews: false } );
		expect( hdrViewFor( describeConfig(), 'sRGB - Display', 'ACES 1.0 - SDR Video' ) )
			.toEqual( { display: 'ST2084-P3-D65 - Display', view: 'ACES 1.1 - HDR Video (1000 nits & P3 lim)' } );

		await cm.loadConfig( { builtin: ACES2, registerViews: false } );
		const config = describeConfig();
		expect( hdrViewFor( config, SDR.display, SDR.view ) ).toEqual( { display: 'Display P3 HDR - Display', view: 'ACES 2.0 - HDR 1000 nits (P3 D65)' } );
		expect( hdrViewFor( config, SDR.display, 'Un-tone-mapped' ) ).toEqual( { display: 'Display P3 HDR - Display', view: 'Un-tone-mapped' } );
		expect( hdrViewFor( config, SDR.display, 'Raw' ) ).toBeNull();

	} );

	it( 'finds the display connection space even when the config lists it inactive', async () => {

		await cm.loadConfig( { builtin: ACES2, registerViews: false } );
		expect( describeConfig().colorSpaces.some( c => c.name === 'CIE XYZ-D65 - Display-referred' ) ).toBe( false );
		expect( displayReferenceSpace() ).toBe( 'CIE XYZ-D65 - Display-referred' );

	} );

	it( 'bakes what OCIO decodes, 1.0 at 100 nits, past 1 in the highlights', async () => {

		await cm.loadConfig( { builtin: ACES2, registerViews: false } );
		const shown = buildCanvasView( { display: 'Rec.2100-PQ - Display', view: 'ACES 2.0 - HDR 1000 nits (P3 D65)', source: 'ACEScg', canvas: 'srgb' } );
		const sample = makeCpuSampler( { data: shown.table.data, ...shown.ocio } );

		const p = getRuntime().config.createGroupTransformProcessor( [
			{ type: 'displayView', source: 'ACEScg', display: 'Rec.2100-PQ - Display', view: 'ACES 2.0 - HDR 1000 nits (P3 D65)' },
			{ type: 'colorSpace', source: 'Rec.2100-PQ - Display', destination: 'CIE XYZ-D65 - Display-referred' },
		] );
		const m = XYZ_TO_CANVAS.srgb;
		for ( const level of [ 0.02, 0.18, 1, 4, 16 ] ) {

			const xyz = new Float32Array( [ level, level, level, 1 ] );
			p.applyRGBAF32( xyz );
			const truth = m[ 3 ] * xyz[ 0 ] + m[ 4 ] * xyz[ 1 ] + m[ 5 ] * xyz[ 2 ];
			const out = [ 0, 0, 0 ];
			sample( level, level, level, out );
			expect( out[ 1 ] ).toBeCloseTo( encodeExtended( truth ), 2 );

		}

		p.dispose();

		const out = [ 0, 0, 0 ];
		sample( 0.18, 0.18, 0.18, out );
		expect( decode( out[ 1 ] ) ).toBeCloseTo( 0.145, 2 );
		sample( 16, 16, 16, out );
		expect( decode( out[ 1 ] ) ).toBeGreaterThan( 5 );
		expect( shown.error.mean ).toBeLessThan( 0.5 );
		expect( shown.ocio.for ).toBeNull();
		shown.dispose();

	} );

} );

suite( 'HDR output on the canvas', () => {

	let issues, cm, renderer;

	beforeAll( () => {

		globalThis.HTMLCanvasElement ??= class HTMLCanvasElement {};

	} );

	afterEach( () => {

		cm?.dispose();
		ColorManagement.resetAll();

	} );

	async function start() {

		issues = new IssueLog();
		cm = new ColorManagement( { issues } );
		renderer = fakeRenderer();
		cm.attachRenderer( renderer );
		await cm.loadConfig( { builtin: ACES2, registerViews: false } );
		return cm.setView( SDR );

	}

	it( 'shows the HDR version on a half-float canvas, and the view itself again when turned off', async () => {

		const sdr = await start();
		const events = [];
		cm.on( 'canvas', t => events.push( t ) );

		cm.setHdrOutput( true );
		expect( cm.canvasTransform ).toBeTypeOf( 'function' );
		expect( renderer.backend.parameters.outputType ).toBe( HalfFloatType );
		expect( renderer.backend.resized ).toBe( 1 );
		expect( renderer.toneMapping ).toBe( sdr.id );
		expect( cm.status().hdr ).toEqual( { on: true, showing: true, view: 'ACES 2.0 - HDR 1000 nits (P3 D65) (Display P3 HDR - Display)', reason: null } );

		cm.setHdrOutput( false );
		expect( cm.canvasTransform ).toBeNull();
		expect( renderer.backend.parameters.outputType ).toBeUndefined();
		expect( cm.status().hdr ).toEqual( { on: false, showing: false, view: null, reason: null } );
		expect( events.map( t => typeof t ) ).toEqual( [ 'function', 'object' ] );

	} );

	it( 'follows the view, and says when one has no HDR version', async () => {

		await start();
		cm.setHdrOutput( true );
		const first = cm.canvasTransform;

		cm.setView( { display: SDR.display, view: 'Un-tone-mapped' } );
		expect( cm.canvasTransform ).not.toBe( first );
		expect( cm.status().hdr.view ).toMatch( /^Un-tone-mapped/ );

		cm.setView( { display: SDR.display, view: 'Raw' } );
		expect( cm.canvasTransform ).toBeNull();
		expect( renderer.backend.parameters.outputType ).toBeUndefined();
		expect( cm.status().hdr ).toMatchObject( { on: true, showing: false, reason: 'no-hdr-version' } );

	} );

	it( 'bakes a view for an HDR display already converted, and only widens the canvas for it', async () => {

		await start();
		const entry = cm.setView( { display: 'Rec.2100-PQ - Display', view: 'ACES 2.0 - HDR 1000 nits (P3 D65)' } );
		expect( entry.ocio ).toMatchObject( { emulated: true, canvas: 'display-p3' } );
		expect( cm.canvasColorSpace ).toBe( 'display-p3' );
		expect( cm.canvasTransform ).toBeNull();
		expect( renderer.backend.parameters.outputType ).toBeUndefined();

		cm.setHdrOutput( true );
		expect( cm.canvasTransform ).toBeNull();
		expect( renderer.backend.parameters.outputType ).toBe( HalfFloatType );
		expect( cm.status().hdr.showing ).toBe( true );

	} );

	it( 'lets None through unclamped, and has no HDR version of a built-in curve', async () => {

		await start();
		cm.setHdrOutput( true );
		cm.setActiveView( NoToneMapping );
		expect( cm.canvasTransform ).toBeNull();
		expect( renderer.backend.parameters.outputType ).toBe( HalfFloatType );
		expect( cm.status().hdr.showing ).toBe( true );

		cm.setActiveView( AgXToneMapping );
		expect( renderer.backend.parameters.outputType ).toBeUndefined();
		expect( cm.status().hdr.reason ).toBe( 'no-hdr-version' );

	} );

	it( 'resets what Chrome copies the canvas from whenever its format or colour space changes', async () => {

		await start();
		// Chrome keeps the colour space and format a canvas had at its first copy; setting its width again resets that.
		let configuration = { format: 'bgra8unorm', colorSpace: 'srgb', toneMapping: { mode: 'standard' } };
		const context = { configure: c => {

			configuration = { ...c };

		}, getConfiguration: () => configuration };
		const canvas = new globalThis.HTMLCanvasElement();
		let width = 512, resets = 0;
		Object.defineProperty( canvas, 'width', { get: () => width, set: v => {

			width = v;
			resets ++;

		} } );
		canvas.getContext = () => context;
		renderer.domElement = canvas;

		cm.setView( { display: 'Display P3 - Display', view: 'ACES 2.0 - SDR 100 nits (P3 D65)' } );
		expect( configuration.colorSpace ).toBe( 'display-p3' );
		expect( resets ).toBe( 1 );

		// three.js configuring again after a resize, with no colour space: kept, nothing changed, no reset.
		context.configure( { format: 'bgra8unorm', toneMapping: { mode: 'standard' } } );
		expect( configuration.colorSpace ).toBe( 'display-p3' );
		expect( resets ).toBe( 1 );

		// The HDR canvas is another format.
		context.configure( { format: 'rgba16float', toneMapping: { mode: 'extended' } } );
		expect( resets ).toBe( 2 );
		expect( width ).toBe( 512 );

	} );

	it( 'never switches a canvas that is not on screen', async () => {

		await start();
		renderer.domElement = { getContext: () => null };
		cm.setHdrOutput( true );
		expect( renderer.backend.parameters.outputType ).toBeUndefined();
		expect( cm.status().hdr ).toMatchObject( { on: true, showing: false, reason: 'no-screen' } );

	} );

	it( 'saves the HDR version, and shows it from the file before any config loads', async () => {

		const sdr = await start();
		const viewFile = await cm.saveBakedView( sdr.id );
		const hdrFile = await cm.saveBakedView( sdr.id, { hdr: true } );
		cm.dispose();
		ColorManagement.resetAll();

		cm = new ColorManagement();
		renderer = fakeRenderer();
		cm.attachRenderer( renderer );
		const entry = await cm.loadBakedView( viewFile );
		cm.setActiveView( entry.id );
		cm.setHdrOutput( true );
		expect( cm.status().hdr ).toMatchObject( { showing: false, reason: 'needs-config' } );

		expect( ( await cm.loadBakedView( hdrFile ) ).id ).toBe( entry.id );
		expect( cm.status().hdr ).toMatchObject( { showing: true, reason: null } );
		expect( cm.status().hdr.view ).toMatch( /HDR 1000 nits/ );
		expect( renderer.backend.parameters.outputType ).toBe( HalfFloatType );
		expect( renderer.toneMapping ).toBe( entry.id );

		// A picture saved now shows again from that file, still with no config: the Results page needs no runtime.
		expect( cm.hdrVersionOf( { ...cm.activeView } ).table.tsl ).toBe( cm.canvasTransform );
		expect( cm.hdrVersionOf( { ...cm.activeView }, 'ACEScg' ) ).toEqual( { reason: 'needs-config' } );

	} );

	it( 'keeps the last four HDR versions, so switching back needs no bake', async () => {

		await start();
		cm.setHdrOutput( true );
		const shown = {};
		const views = [ SDR.view, 'Un-tone-mapped', 'Video (colorimetric)' ];
		for ( const view of views ) {

			cm.setView( { display: SDR.display, view, size: 17 } );
			shown[ view ] = cm.canvasTransform;

		}

		for ( const view of views ) {

			cm.setView( { display: SDR.display, view, size: 17 } );
			expect( cm.canvasTransform, view ).toBe( shown[ view ] );

		}

		const disposed = [];
		for ( const t of cm._recentCanvasViews.values() ) {

			const dispose = t.dispose;
			t.dispose = () => {

				disposed.push( t.name );
				dispose();

			};

		}

		cm.setView( { display: 'Display P3 - Display', view: 'ACES 2.0 - SDR 100 nits (P3 D65)', size: 17 } );
		cm.setView( { display: 'Display P3 - Display', view: 'Un-tone-mapped', size: 17 } );
		expect( cm._recentCanvasViews.size ).toBe( 4 );
		expect( disposed ).toHaveLength( 1 );
		expect( disposed[ 0 ] ).toMatch( /^ACES 2\.0 - HDR/ );

	} );

	it( 'finds a saved picture\'s HDR version, the very one the screen used while it is held', async () => {

		await start();
		cm.setHdrOutput( true );
		// As getProvenance() records the view beside a saved picture.
		const view = { ...cm.activeView };
		expect( cm.hdrVersionOf( view ).table.tsl ).toBe( cm.canvasTransform );

		// Baked from light in another space, and kept with the screen's recent ones.
		const built = cm.hdrVersionOf( view, 'ACEScg' );
		expect( built.table.ocio ).toMatchObject( { display: 'Display P3 HDR - Display', source: 'ACEScg', for: { display: SDR.display, view: SDR.view } } );
		expect( cm.hdrVersionOf( view, 'ACEScg' ).table ).toBe( built.table );
		expect( [ ...cm._recentCanvasViews.values() ] ).toContain( built.table );

		expect( cm.hdrVersionOf( { ...view, view: 'Raw' } ) ).toEqual( { reason: 'no-hdr-version' } );
		expect( cm.hdrVersionOf( { ...view, configId: 'elsewhere' }, 'ACEScg2065' ) ).toEqual( { reason: 'other-config' } );

	} );

	it( 'rebakes the HDR version for a new working space', async () => {

		await start();
		cm.setHdrOutput( true );
		const before = cm.canvasTransform;
		cm.setWorkingSpace( 'ACEScg' );
		expect( cm.canvasTransform ).toBeTypeOf( 'function' );
		expect( cm.canvasTransform ).not.toBe( before );

	} );

} );

describe( 'the renderer core', () => {

	it( 'has no HDR without the colour add-on', () => {

		const issues = new IssueLog();
		const color = new BasicColor( { issues } );
		color.setHdrOutput( true );
		expect( color.canvasTransform ).toBeNull();
		expect( color.status().hdr ).toEqual( { on: false, showing: false, view: null, reason: null } );
		expect( issues.list.map( i => i.code ) ).toEqual( [ ISSUE_CODES.CAPABILITY_MISSING ] );
		color.dispose();

	} );

} );
