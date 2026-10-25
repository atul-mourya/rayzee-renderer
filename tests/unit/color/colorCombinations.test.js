/**
 * Every display × view a config offers, against what OCIO says that display emits: what the canvas holds, decoded in
 * the canvas colour space, must be the display's light — whether the canvas shows it as it is (sRGB, Display P3) or
 * converted (Rec.1886, Rec.2020, cinema P3, PQ, HLG). Plus the Screen switch keeping the tone mapping, and the HDR
 * switch for each view. Runs on the runtime's ACES configs, and Blender's when its files are here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HalfFloatType } from 'three';
import { ColorManagement } from '@/core/addons/color/ColorManagement.js';
import { isDataView, isHdrDisplay, matchingView, hdrViewFor, sameToneMapping } from '@/core/addons/color/Displays.js';
import { XYZ_TO_CANVAS, displayReferenceSpace } from '@/core/addons/color/OcioViews.js';
import { unshape, makeCpuSampler } from '@/core/addons/color/LutBake.js';
import { describeConfig, getRuntime, getConfigInfo } from '@/core/addons/color/OcioRuntime.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { looksForView } from '@/lib/colorLabels.js';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

const BLENDER = [ '.cdn-upload/ocio/blender-5.1', '/Applications/Blender.app/Contents/Resources/5.1/datafiles/colormanagement' ].find( d => existsSync( join( d, 'config.ocio' ) ) );

const CONFIGS = [
	{ name: 'ACES 2.0', load: { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } },
	{ name: 'ACES 1.3', load: { builtin: 'ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4' } },
	{ name: 'ACES 1.3, OCIO 2.1', load: { builtin: 'ocio://cg-config-v1.0.0_aces-v1.3_ocio-v2.1' } },
	...( BLENDER ? [ { name: 'Blender 5.1', load: () => {

		const walk = d => readdirSync( d ).flatMap( n => ( statSync( join( d, n ) ).isDirectory() ? walk( join( d, n ) ) : [ join( d, n ) ] ) );
		return { files: walk( BLENDER ).map( p => ( { relativePath: relative( BLENDER, p ), data: readFileSync( p ) } ) ), configPath: 'config.ocio', id: 'blender' };

	} } ] : [] ),
];

const SIZE = 33;
const decode = v => Math.sign( v ) * ( Math.abs( v ) <= 0.04045 ? Math.abs( v ) / 12.92 : Math.pow( ( Math.abs( v ) + 0.055 ) / 1.055, 2.4 ) );

const mul = ( m, v ) => [ 0, 3, 6 ].map( r => m[ r ] * v[ 0 ] + m[ r + 1 ] * v[ 1 ] + m[ r + 2 ] * v[ 2 ] );

function invert( m ) {

	const [ a, b, c, d, e, f, g, h, i ] = m;
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [ A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d ].map( v => v / det );

}

// Grid nodes, so the table is read where it was baked: greys, a warm and a cool colour, dark to past the top.
const NODES = [ 8, 14, 18, 20, 22, 24, 27 ].flatMap( i => [[ i, i, i ], [ i, i - 3, i - 6 ], [ i - 6, i - 2, i ]] );

function onScreenRenderer() {

	globalThis.HTMLCanvasElement ??= class HTMLCanvasElement {};
	return { toneMapping: 0, outputColorSpace: 'srgb', backend: { parameters: {}, updateSize() {} }, domElement: new globalThis.HTMLCanvasElement() };

}

const suite = available ? describe : describe.skip;

for ( const { name, load } of CONFIGS ) {

	suite( `every combination in ${name}`, () => {

		let cm, renderer, config;

		beforeAll( async () => {

			ColorManagement.resetAll();
			cm = new ColorManagement();
			renderer = onScreenRenderer();
			cm.attachRenderer( renderer );
			await cm.loadConfig( { ...( typeof load === 'function' ? load() : load ), registerViews: false } );
			config = describeConfig();

		}, 120000 );

		afterAll( () => {

			cm?.dispose();
			ColorManagement.resetAll();

		} );

		// What the table holds for `nodes` against what OCIO says the display emits, as the canvas shows it: linear, in
		// the table's canvas colour space, below zero clipped. Null when the view shows its codes as they are. A table on
		// another space's axes (`pre`) is read at its nodes there.
		function mismatches( table, { display, view, look, source, size, minEv, maxEv, canvas, curve, linear, clip, pre }, nodes ) {

			const colorSpace = config.views[ display ].find( v => v.name === view )?.colorSpace;
			const output = ! colorSpace || colorSpace === '<USE_DISPLAY_NAME>' ? display : colorSpace;
			if ( getConfigInfo().colorSpaces.find( c => c.name === output )?.referenceSpace === 0 ) return null;

			const p = getRuntime().config.createGroupTransformProcessor( [
				...( look ? [ { type: 'look', source, destination: source, looks: look } ] : [] ),
				{ type: 'displayView', source, display, view },
				{ type: 'colorSpace', source: output, destination: displayReferenceSpace() },
			] );
			const fromAxes = pre ? invert( pre ) : [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
			const inputs = nodes.map( n => mul( fromAxes, n.map( i => unshape( i, size, minEv, maxEv ) ) ) );
			const xyz = new Float32Array( inputs.flatMap( v => [ ...v, 1 ] ) );
			p.applyRGBAF32( xyz );
			p.dispose();

			// Read as the readback reads it, so a view split at its lookup (False Color) is read through its curve.
			const sample = makeCpuSampler( { data: table.data, size, minEv, maxEv, curve, linear, clip, pre } );
			const read = [ 0, 0, 0 ];
			const toCanvas = XYZ_TO_CANVAS[ canvas ];
			return nodes.flatMap( ( [ r, g, b ], k ) => {

				sample( ...inputs[ k ], read );
				const shown = read.map( v => Math.max( 0, decode( v ) ) );
				const truth = mul( toCanvas, [ xyz[ k * 4 ], xyz[ k * 4 + 1 ], xyz[ k * 4 + 2 ] ] ).map( v => Math.max( 0, v ) );
				const scale = Math.max( 0.01, ...truth );
				const off = Math.max( ...shown.map( ( v, c ) => Math.abs( v - truth[ c ] ) / scale ) );
				return ! ( off <= 0.01 ) ? [ `${display} / ${view}${look ? ` + ${look}` : ''} at ${[ r, g, b ]}: ${shown.map( v => v.toFixed( 4 ) )} vs ${truth.map( v => v.toFixed( 4 ) )}` ] : [];

			} );

		}

		it( 'shows every display as the light it emits, as it is or converted', () => {

			expect( displayReferenceSpace() ).toMatch( /xyz/i );
			const failures = [];

			for ( const display of config.displays ) {

				for ( const { name: view } of config.views[ display ] ) {

					const entry = cm.setView( { display, view, size: SIZE } );
					const { canvas, emulated } = entry.ocio;
					expect( [ 'srgb', 'display-p3' ] ).toContain( canvas );
					expect( cm.canvasColorSpace ).toBe( canvas );
					if ( isDataView( config, display, view ) ) {

						expect( emulated ).toBe( false );
						continue;

					}

					const found = mismatches( entry.table, entry.ocio, NODES );
					if ( found === null ) expect( emulated, `${display} / ${view} shows its codes as they are` ).toBe( false );
					else failures.push( ...found );

				}

			}

			expect( failures ).toEqual( [] );

		}, 120000 );

		it( 'bakes every look the menu offers with every view, and its HDR version, as the light it emits', () => {

			const allViews = [ ...new Set( Object.values( config.views ).flat().map( v => v.name ) ) ];
			const greys = [ 7, 10, 12, 14 ].map( i => [ i, i, i ] );
			const failures = [];
			let baked = 0, hdrBaked = 0;

			for ( const display of config.displays ) {

				for ( const { name: view } of config.views[ display ] ) {

					if ( isDataView( config, display, view ) ) continue;
					const { creative, technical } = looksForView( config.looks, view, allViews, sameToneMapping );
					for ( const { value: look } of [ ...creative, ...technical ] ) {

						const entry = cm.setView( { display, view, look, size: 17 } );
						failures.push( ...( mismatches( entry.table, entry.ocio, greys ) ?? [] ) );

						cm.setHdrOutput( true );
						const hdr = cm._canvasView?.table;
						if ( hdr ) {

							failures.push( ...( mismatches( hdr.table, hdr.ocio, greys ) ?? [] ) );
							hdrBaked ++;

						}

						cm.setHdrOutput( false );
						baked ++;

					}

				}

			}

			expect( failures ).toEqual( [] );
			expect( baked ).toBeGreaterThan( 0 );
			expect( hdrBaked, `${baked} looks baked` ).toBeGreaterThan( 0 );

		}, 300000 );

		it( 'shows the same light rendering in another working space', () => {

			const space = [ 'ACEScg', 'Linear Rec.2020' ].find( n => config.colorSpaces.some( c => c.name === n ) );
			if ( ! space ) return;
			cm.setWorkingSpace( space );
			const failures = [];
			try {

				for ( const display of config.displays ) {

					const view = config.views[ display ].find( v => ! isDataView( config, display, v.name ) )?.name;
					if ( ! view ) continue;
					const entry = cm.setView( { display, view, size: SIZE } );
					expect( entry.ocio.source ).toBe( space );
					failures.push( ...( mismatches( entry.table, entry.ocio, NODES ) ?? [] ) );
					cm.setHdrOutput( true );
					const hdr = cm._canvasView?.table;
					if ( hdr ) {

						expect( hdr.ocio.source ).toBe( space );
						failures.push( ...( mismatches( hdr.table, hdr.ocio, NODES ) ?? [] ) );

					}

					cm.setHdrOutput( false );

				}

			} finally {

				cm.setWorkingSpace( null );

			}

			expect( failures ).toEqual( [] );

		}, 120000 );

		it.runIf( name === 'Blender 5.1' )( 'steps through False Color between the table\'s nodes, as OCIO does', () => {

			// Its bands are a 1D lookup after a grey value; blurred through the cube, 0.18 grey showed teal.
			const entry = cm.setView( { display: 'sRGB', view: 'False Color', size: 65 } );
			expect( entry.ocio.curve ).toMatchObject( { n: 4096, lo: 0, hi: 1 } );
			const inputs = [];
			for ( let ev = - 10; ev <= 6; ev += 1 / 16 ) inputs.push( [ 1, 1, 1 ], [ 1, 0.3, 0.1 ], [ 0.1, 0.5, 1 ] );
			const scaled = inputs.map( ( v, i ) => v.map( c => c * 0.18 * 2 ** ( - 10 + Math.floor( i / 3 ) / 16 ) ) );
			const truth = new Float32Array( scaled.flatMap( v => [ ...v, 1 ] ) );
			const p = getRuntime().config.createDisplayViewProcessor( { source: entry.ocio.source, display: 'sRGB', view: 'False Color' } );
			p.applyRGBAF32( truth );
			p.dispose();

			const out = [ 0, 0, 0 ];
			let off = 0;
			scaled.forEach( ( v, i ) => {

				entry.cpu( v[ 0 ], v[ 1 ], v[ 2 ], 1, out );
				if ( out.some( ( c, k ) => Math.abs( c - truth[ i * 4 + k ] ) > 2 / 255 ) ) off ++;

			} );
			// Only where the cube's grey value lands on the other side of a step.
			expect( off / scaled.length ).toBeLessThan( 0.03 );

			const grey = scaled.findIndex( v => Math.abs( v[ 0 ] - 0.18 ) < 1e-9 && v[ 1 ] === v[ 0 ] );
			entry.cpu( 0.18, 0.18, 0.18, 1, out );
			out.forEach( ( c, k ) => expect( c ).toBeCloseTo( truth[ grey * 4 + k ], 2 ) );
			expect( out[ 0 ] ).toBeCloseTo( out[ 1 ], 3 );

		} );

		it.runIf( name === 'Blender 5.1' )( 'shows a converted display from its light, with no kink at its gamut', () => {

			cm.setWorkingSpace( 'Linear DCI-P3 D65' );
			try {

				// A pure Rec.709 green five times white, in P3 numbers. Rec.1886's encoding clipped the red and blue that go
				// below 0 inside the cube's cell, and interpolated encoded, red showed 0.043 of light (0.9 % of the green,
				// 58 levels); from the light, encoded after the lookup, 0.003.
				const entry = cm.setView( { display: 'Rec.1886', view: 'Standard', size: 65 } );
				expect( entry.ocio.emulated ).toBe( true );
				const toP3 = getRuntime().config.createColorSpaceProcessor( 'Linear Rec.709', 'Linear DCI-P3 D65' );
				const green = toP3.applyRGBAF32( new Float32Array( [ 0, 5, 0, 1 ] ), { copy: true } );
				toP3.dispose();
				const out = [ 0, 0, 0 ];
				entry.cpu( green[ 0 ], green[ 1 ], green[ 2 ], 1, out );
				const light = out.map( decode );
				expect( light[ 1 ] ).toBeCloseTo( 5, 1 );
				expect( Math.abs( light[ 0 ] ) ).toBeLessThan( 0.002 * light[ 1 ] );
				expect( Math.abs( light[ 2 ] ) ).toBeLessThan( 0.002 * light[ 1 ] );

			} finally {

				cm.setWorkingSpace( null );

			}

		} );

		it( 'converts into Display P3 only a display wider than sRGB', () => {

			for ( const display of config.displays ) {

				const view = config.views[ display ].find( v => ! isDataView( config, display, v.name ) )?.name;
				if ( ! view ) continue;
				const { ocio } = cm.setView( { display, view, size: SIZE } );
				const narrow = /^(srgb|rec\.?\s*1886|gamma\s*2\.2)/i.test( display );
				if ( ocio.emulated ) expect( ocio.canvas, display ).toBe( narrow ? 'srgb' : 'display-p3' );
				else expect( ocio.canvas, display ).toBe( /p3/i.test( display ) ? 'display-p3' : 'srgb' );

			}

		}, 60000 );

		it( 'keeps the tone mapping when the screen changes, and comes back to the same view', () => {

			const family = v => v.replace( /\([^)]*\)/g, ' ' ).split( /\s+-\s+/ )[ 0 ].trim().replace( /\s*\d+(\.\d+)*$/, '' ).toLowerCase();
			const hdrTagged = v => /\bHDR\b/.test( v );
			let checked = 0;

			for ( const from of config.displays ) {

				for ( const { name: view } of config.views[ from ] ) {

					if ( isDataView( config, from, view ) ) continue;
					for ( const to of config.displays ) {

						const there = matchingView( config, from, view, to );
						const offered = config.views[ to ].map( v => v.name ).filter( v => ! isDataView( config, to, v ) && family( v ) === family( view ) );
						const where = `${from} / ${view} → ${to}`;
						if ( ! offered.length ) {

							expect( there, where ).toBeNull();
							continue;

						}

						expect( family( there ), where ).toBe( family( view ) );
						if ( isHdrDisplay( config, to ) && offered.some( hdrTagged ) ) expect( hdrTagged( there ), where ).toBe( true );
						if ( ! isHdrDisplay( config, to ) ) expect( hdrTagged( there ), where ).toBe( false );

						const back = matchingView( config, to, there, from );
						expect( family( back ), `${where} → ${from}` ).toBe( family( view ) );
						if ( config.views[ from ].filter( v => family( v.name ) === family( view ) ).length === 1 ) expect( back, `${where} → ${from}` ).toBe( view );
						checked ++;

					}

				}

			}

			expect( checked ).toBeGreaterThan( 10 );

		}, 60000 );

		it( 'shows the HDR switch on every view: an HDR version, the view\'s own range, or why not', () => {

			for ( const display of config.displays ) {

				for ( const { name: view } of config.views[ display ] ) {

					cm.setView( { display, view, size: SIZE } );
					cm.setHdrOutput( true );
					const { hdr } = cm.status();
					const data = isDataView( config, display, view );
					if ( isHdrDisplay( config, display ) ) {

						expect( hdr, `${display} / ${view}` ).toMatchObject( { showing: true, reason: null } );
						expect( cm.canvasTransform ).toBeNull();

					} else if ( ! data && hdrViewFor( config, display, view ) ) {

						expect( hdr, `${display} / ${view}` ).toMatchObject( { showing: true, reason: null } );
						expect( cm.canvasTransform ).toBeTypeOf( 'function' );

					} else {

						expect( hdr, `${display} / ${view}` ).toMatchObject( { showing: false, reason: 'no-hdr-version' } );

					}

					expect( renderer.backend.parameters.outputType ).toBe( hdr.showing ? HalfFloatType : undefined );
					cm.setHdrOutput( false );
					expect( renderer.backend.parameters.outputType ).toBeUndefined();

				}

			}

		}, 120000 );

	} );

}
