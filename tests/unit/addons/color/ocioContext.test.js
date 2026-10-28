/**
 * Context variables, end to end: a config whose grade is picked by `$SHOT`, with two different
 * grades on disk. The only way to show `setContext` does anything is to see the image move.
 * Then a config whose view reads a grade beside it, shown on a display the canvas converts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ColorManagement } from '@/core/addons/color/ColorManagement.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { VIEW_TRANSFORMS } from '@/core/color/ViewTransforms.js';
import { IssueLog } from '@/core/EngineIssues.js';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

const CONFIG = `ocio_profile_version: 2

environment:
  SHOT: "010"

search_path: grades

roles:
  default: linear
  scene_linear: linear
  data: raw
  color_picking: linear

file_rules:
  - !<Rule> {name: Default, colorspace: linear}

displays:
  sRGB:
    - !<View> {name: Graded, colorspace: graded}
    - !<View> {name: Raw, colorspace: raw}

colorspaces:
  - !<ColorSpace>
    name: linear
    encoding: scene-linear
    isdata: false

  - !<ColorSpace>
    name: raw
    isdata: true

  - !<ColorSpace>
    name: graded
    isdata: false
    from_scene_reference: !<FileTransform> {src: "$SHOT.cdl", interpolation: linear}
`;

const cdl = slope => new TextEncoder().encode( `<?xml version="1.0" encoding="UTF-8"?>
<ColorDecisionList xmlns="urn:ASC:CDL:v1.01">
 <ColorDecision><ColorCorrection id="cc">
  <SOPNode><Slope>${slope} ${slope} ${slope}</Slope><Offset>0 0 0</Offset><Power>1 1 1</Power></SOPNode>
 </ColorCorrection></ColorDecision>
</ColorDecisionList>` );

suite( 'context variables', () => {

	let cm, config;

	beforeAll( async () => {

		cm = new ColorManagement();
		config = await cm.loadConfig( {
			text: CONFIG,
			files: [
				{ relativePath: 'grades/010.cdl', data: cdl( 1.0 ) },
				{ relativePath: 'grades/020.cdl', data: cdl( 2.0 ) },
			],
			id: 'context-test',
			registerViews: false,
		} );

	} );

	afterAll( () => ColorManagement.resetAll() );

	it( 'finds the variable and its declared default in the config text', () => {

		expect( config.contextVariables ).toEqual( [ { name: 'SHOT', default: '010', declared: true } ] );

	} );

	it( 'bakes a different table for a different shot, into the same id', () => {

		const { id } = cm.setView( { display: 'sRGB', view: 'Graded', size: 33 } );

		// A rebake replaces the registry entry (same id, same texture, new table), so the curve has
		// to be read back from the registry each time rather than held.
		const at = v => {

			const out = [ 0, 0, 0 ];
			VIEW_TRANSFORMS.get( id ).cpu( v, v, v, 1, out );
			return out[ 0 ];

		};

		cm.setContext( { SHOT: '010' } );
		const shot10 = at( 0.25 );

		cm.setContext( { SHOT: '020' } );
		const shot20 = at( 0.25 );

		expect( VIEW_TRANSFORMS.get( id ).ocio.context ).toEqual( { SHOT: '020' } );
		// Slope 2 against slope 1 on the same input.
		expect( shot20 / shot10 ).toBeGreaterThan( 1.8 );
		expect( shot20 / shot10 ).toBeLessThan( 2.2 );

	} );

	it( 'rebakes only the view on screen, and the others when they are next chosen', () => {

		cm.setContext( null );
		const raw = cm.setView( { display: 'sRGB', view: 'Graded', look: null, size: 17 } );
		const other = cm.setView( { display: 'sRGB', view: 'Graded', size: 33 } );
		expect( other.id ).not.toBe( raw.id );

		cm.setContext( { SHOT: '020' } );

		// The one on screen moved; the one not being looked at was left alone.
		expect( VIEW_TRANSFORMS.get( other.id ).ocio.context ).toEqual( { SHOT: '020' } );
		expect( VIEW_TRANSFORMS.get( raw.id ).ocio.context ?? null ).toBeNull();

		// Choosing it brings it up to date before anything renders from it.
		cm.setActiveView( raw.id );
		expect( VIEW_TRANSFORMS.get( raw.id ).ocio.context ).toEqual( { SHOT: '020' } );

		cm.setContext( null );

	} );

} );

// XYZ is the display reference, so a gamma 2.4 display is one the canvas shows converted, through a derived config.
const TO_XYZ = '[0.4124564, 0.3575761, 0.1804375, 0, 0.2126729, 0.7151522, 0.0721750, 0, 0.0193339, 0.1191920, 0.9503041, 0, 0, 0, 0, 1]';
const FROM_XYZ = '[3.2404542, -1.5371385, -0.4985314, 0, -0.9692660, 1.8760108, 0.0415560, 0, 0.0556434, -0.2040259, 1.0572252, 0, 0, 0, 0, 1]';
const GRADED_VIEW = `ocio_profile_version: 2

search_path: luts

roles:
  default: linear
  scene_linear: linear
  data: raw
  color_picking: linear
  cie_xyz_d65_interchange: xyz

file_rules:
  - !<Rule> {name: Default, colorspace: linear}

view_transforms:
  - !<ViewTransform>
    name: Graded
    from_scene_reference: !<GroupTransform>
      children:
        - !<FileTransform> {src: grade.cdl, interpolation: linear}
        - !<MatrixTransform> {matrix: ${TO_XYZ}}

displays:
  Gamma 2.4:
    - !<View> {name: Graded, view_transform: Graded, display_colorspace: g24}

display_colorspaces:
  - !<ColorSpace>
    name: CIE-XYZ-D65
    encoding: display-linear
    isdata: false
  - !<ColorSpace>
    name: g24
    from_display_reference: !<GroupTransform>
      children:
        - !<MatrixTransform> {matrix: ${FROM_XYZ}}
        - !<ExponentTransform> {value: 2.4, direction: inverse}

colorspaces:
  - !<ColorSpace>
    name: linear
    encoding: scene-linear
    isdata: false
  - !<ColorSpace>
    name: xyz
    isdata: false
    to_scene_reference: !<MatrixTransform> {matrix: ${FROM_XYZ}}
  - !<ColorSpace>
    name: raw
    isdata: true
`;

suite( 'a config\'s files', () => {

	afterAll( () => ColorManagement.resetAll() );

	it( 'finds the files beside a config however its name is cased', async () => {

		const shown = [];
		for ( const name of [ 'config.ocio', 'CONFIG.OCIO' ] ) {

			const issues = new IssueLog();
			const cm = new ColorManagement( { issues } );
			await cm.loadConfig( {
				files: [ { relativePath: name, data: new TextEncoder().encode( GRADED_VIEW ) }, { relativePath: 'luts/grade.cdl', data: cdl( 2.0 ) } ],
				configPath: name,
				id: `graded-${name}`,
			} );

			const { id, ocio } = cm.setView( { display: 'Gamma 2.4', view: 'Graded', size: 17 } );
			expect( ocio.emulated ).toBe( true );
			expect( issues.list.filter( i => i.code.startsWith( 'viewTransform' ) ) ).toEqual( [] );
			const out = [ 0, 0, 0 ];
			VIEW_TRANSFORMS.get( id ).cpu( 0.25, 0.25, 0.25, 1, out );
			shown.push( out );
			ColorManagement.resetAll();

		}

		expect( shown[ 1 ] ).toEqual( shown[ 0 ] );

	} );

} );
