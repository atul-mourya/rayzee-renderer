/**
 * Context variables, end to end: a config whose grade is picked by `$SHOT`, with two different
 * grades on disk. The only way to show `setContext` does anything is to see the image move.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ColorManagement } from '@/core/Color/ColorManagement.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { VIEW_TRANSFORMS } from '@/core/Color/ViewTransforms.js';

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

	}, 120000 );

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

	}, 120000 );

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

	}, 120000 );

} );
