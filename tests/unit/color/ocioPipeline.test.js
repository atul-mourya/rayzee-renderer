/**
 * The colour-managed pipeline against OpenColorIO itself.
 *
 * Uses the runtime's built-in ACES config, which lives inside the WebAssembly and needs no files
 * on disk, so this runs anywhere rather than only on a machine with a studio config installed. The
 * whole suite skips when the optional peer is absent — an engine that never touches OCIO must
 * still be testable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ColorManagement } from '@/core/Color/ColorManagement.js';
import {
	VIEW_TRANSFORMS, listViewTransforms, buildToneMapWGSL, getRegistryVersion, countTableTransforms, MAX_TABLE_TRANSFORMS,
} from '@/core/Color/ViewTransforms.js';
import { addOcioView } from '@/core/Color/OcioViews.js';
import { TONE_MAP_FNS, toneMapToRGBA8, isOutputEncoded } from '@/core/Processor/ToneMapCPU.js';
import { getWorkingMatrix, convertLinearTriple } from '@/core/Color/WorkingMatrix.js';
import { configureAssets } from '@/core/AssetConfig.js';

const BUILTIN = 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;

// The engine never names the package; the host does. The test honours the same contract.
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

suite( 'colour-managed pipeline', () => {

	let cm, config;

	beforeAll( async () => {

		cm = new ColorManagement();
		config = await cm.loadConfig( { builtin: BUILTIN, registerViews: false } );

	}, 120000 );

	afterAll( () => {

		ColorManagement.resetAll();

	} );

	describe( 'what the config offers', () => {

		it( 'reads the roles rather than guessing at names', () => {

			expect( config.sceneLinear ).toBe( 'ACEScg' );
			expect( config.colorPicking ).toBeTypeOf( 'string' );
			expect( config.data ).toBeTypeOf( 'string' );
			expect( config.roles.scene_linear ).toBe( 'ACEScg' );

		} );

		it( 'reports the config own default display and view, not a hardcoded one', () => {

			expect( config.displays ).toContain( config.defaultDisplay );
			expect( config.defaultViews[ config.defaultDisplay ] ).toBeTypeOf( 'string' );
			expect( config.views[ config.defaultDisplay ].length ).toBeGreaterThan( 0 );

		} );

		it( 'lists looks, named transforms and file rules', () => {

			expect( config.looks.length ).toBeGreaterThan( 0 );
			expect( config.looks[ 0 ] ).toHaveProperty( 'processSpace' );
			expect( config.namedTransforms.length ).toBeGreaterThan( 0 );
			expect( config.fileRules.length ).toBeGreaterThan( 0 );

		} );

	} );

	describe( 'baking a view', () => {

		let entry, display, view;

		beforeAll( () => {

			display = config.defaultDisplay;
			view = config.defaultViews[ display ];
			entry = cm.setView( { display, view } );

		}, 120000 );

		it( 'reaches every consumer, not just the one that baked it', () => {

			expect( VIEW_TRANSFORMS.get( entry.id ) ).toBe( entry );
			// The CPU map is rebuilt in place, so a Map captured before the config loaded has it.
			expect( TONE_MAP_FNS.has( entry.id ) ).toBe( true );
			expect( listViewTransforms().some( t => t.id === entry.id ) ).toBe( true );
			expect( buildToneMapWGSL().wgsl ).toContain( `const ${entry.wgslConst}: u32 = ${entry.id}u;` );
			expect( getRegistryVersion() ).toBeGreaterThan( 1 );

		} );

		it( 'declares itself display-encoded so nothing encodes it twice', () => {

			expect( entry.outputEncoded ).toBe( true );
			expect( isOutputEncoded( entry.id ) ).toBe( true );

		} );

		it( 'allocates it a texture binding in the readback shader', () => {

			const { bindings } = buildToneMapWGSL();
			const mine = bindings.find( b => b.transform.id === entry.id );
			expect( mine ).toBeTruthy();
			expect( mine.index ).toBeGreaterThanOrEqual( 3 );
			expect( buildToneMapWGSL().wgsl ).toContain( `@binding(${mine.index}) var ${mine.texName}: texture_3d<f32>` );

		} );

		it( 'reproduces what OCIO itself returns', () => {

			// Measured against the real processor during the bake, over colours shaped like a
			// render rather than spread evenly through a cube most scenes never visit.
			expect( entry.error.mean ).toBeLessThan( 0.5 );
			expect( entry.error.p95 ).toBeLessThan( 1.5 );

		} );

		it( 'keeps true black at zero', () => {

			const out = [ 0, 0, 0 ];
			entry.cpu( 0, 0, 0, 1, out );
			expect( out[ 0 ] * 255 ).toBeLessThan( 0.5 );

		} );

		it( 'skips the sRGB transfer for it in the readback', () => {

			const px = new Float32Array( [ 0.18, 0.18, 0.18, 1 ] );
			const bytes = toneMapToRGBA8( px, { exposure: 1, toneMapping: entry.id, saturation: 1 } );

			const out = [ 0, 0, 0 ];
			entry.cpu( 0.18, 0.18, 0.18, 1, out );

			// The readback writes `v * 255 + 0.5` into a Uint8ClampedArray, which rounds again —
			// deliberately half a level bright, and `ToneMapGPU` matches it.
			expect( bytes[ 0 ] ).toBe( new Uint8ClampedArray( [ out[ 0 ] * 255 + 0.5 ] )[ 0 ] );

			// And the failure this guards against: encoding an already-encoded value lifts a
			// mid-grey by tens of levels, which is the single most visible way to get this wrong.
			const doubled = 1.055 * Math.pow( out[ 0 ], 1 / 2.4 ) - 0.055;
			expect( Math.abs( doubled * 255 - bytes[ 0 ] ) ).toBeGreaterThan( 20 );

		} );

	} );

	describe( 'looks', () => {

		it( 'bakes a view with a look and gets a different table', () => {

			const display = config.defaultDisplay;
			const view = config.defaultViews[ display ];
			const look = config.looks[ 0 ].name;

			const plain = cm.setView( { display, view } );
			const graded = cm.setView( { display, view, look } );

			expect( graded.id ).not.toBe( plain.id );
			expect( graded.ocio.look ).toBe( look );
			expect( graded.name ).toContain( look );

			// The gamut compressor only moves colours outside the target gamut, so a neutral is
			// identical by design; a saturated one is not.
			const a = [ 0, 0, 0 ], b = [ 0, 0, 0 ];
			plain.cpu( 4.0, 0.02, 0.02, 1, a );
			graded.cpu( 4.0, 0.02, 0.02, 1, b );
			expect( a ).not.toEqual( b );

		}, 120000 );

	} );

	describe( 'rebaking in place', () => {

		it( 'keeps the same texture object so the compiled shader graph stays valid', () => {

			const display = config.defaultDisplay;
			const view = config.defaultViews[ display ];
			const look = config.looks[ 0 ].name;

			const first = cm.setView( { display, view } );
			const texture = first.table.texture;
			const tsl = first.tsl;
			const data = first.table.data;

			// Same id, different table: what a look, a context change or a new working space does.
			cm.setContext( { SHOT: '030' } );
			const again = VIEW_TRANSFORMS.get( first.id );

			expect( again.table.texture ).toBe( texture );
			expect( again.tsl ).toBe( tsl );
			expect( again.table.data ).not.toBe( data );
			expect( texture.image.data ).toBe( again.table.data );

			cm.setContext( null );
			void look;

		}, 120000 );

		it( 'builds a new texture when the table changes shape', () => {

			const display = config.defaultDisplay;
			const view = config.defaultViews[ display ];

			const coarse = cm.setView( { display, view, size: 17 } );
			const id = coarse.id;
			const texture = coarse.table.texture;

			const fine = addOcioView( {
				id, display, view, source: cm.workingSpace, size: 33,
			} );

			expect( fine.table.texture ).not.toBe( texture );
			expect( fine.table.size ).toBe( 33 );

		}, 120000 );

	} );

	describe( 'the table ceiling, from the host side', () => {

		it( 'lets a user browse more combinations than there are bindings, dropping the oldest', () => {

			// Every display/view pair is its own table; a menu-browsing user makes dozens.
			const combos = config.displays.flatMap( d => config.views[ d ]
				.filter( v => v.colorSpace === '' || v.colorSpace === '<USE_DISPLAY_NAME>' )
				.map( v => ( { display: d, view: v.name } ) ) );
			expect( combos.length ).toBeGreaterThan( MAX_TABLE_TRANSFORMS );

			let last;
			for ( const c of combos ) {

				expect( () => ( last = cm.setView( { ...c, size: 9 } ) ) ).not.toThrow();

			}

			expect( countTableTransforms() ).toBeLessThanOrEqual( MAX_TABLE_TRANSFORMS );
			expect( VIEW_TRANSFORMS.get( last.id ) ).toBe( last );
			expect( cm.activeView.id ).toBe( last.id );

		}, 240000 );

	} );

	describe( 'context variables', () => {

		it( 'rebakes every view in place, keeping the ids the renderer is holding', () => {

			const display = config.defaultDisplay;
			const entry = cm.setView( { display, view: config.defaultViews[ display ] } );
			const id = entry.id;
			const before = getRegistryVersion();

			cm.setContext( { SHOT: '010', SEQ: 'abc' } );

			expect( cm.context ).toEqual( { SHOT: '010', SEQ: 'abc' } );
			expect( getRegistryVersion() ).toBeGreaterThan( before );

			// Same id, new table: the renderer holds the id, so changing $SHOT must not invalidate
			// whatever the host already selected.
			const after = VIEW_TRANSFORMS.get( id );
			expect( after ).toBeTruthy();
			expect( after.ocio.context ).toEqual( { SHOT: '010', SEQ: 'abc' } );

			cm.setContext( null );
			expect( cm.context ).toBeNull();
			expect( VIEW_TRANSFORMS.get( id ) ).toBeTruthy();

		}, 120000 );

		it( 'ignores a repeat of the same variables rather than rebaking for nothing', () => {

			cm.setContext( { SHOT: '020' } );
			const settled = getRegistryVersion();
			cm.setContext( { SHOT: '020' } );
			expect( getRegistryVersion() ).toBe( settled );
			cm.setContext( null );

		}, 120000 );

		it( 'names the variables the config mentions, so a host can offer them', () => {

			expect( Array.isArray( config.contextVariables ) ).toBe( true );

		} );

	} );

	describe( 'the working space', () => {

		afterAll( () => cm.setWorkingSpace( null ) );

		it( 'is the engine default until adopted, and changes nothing', () => {

			cm.setWorkingSpace( null );
			expect( cm.workingSpaceAdopted ).toBe( false );
			expect( getWorkingMatrix() ).toBeNull();

			const rgb = [ 0.5, 0.25, 0.75 ];
			expect( convertLinearTriple( rgb ) ).toBe( false );
			expect( rgb ).toEqual( [ 0.5, 0.25, 0.75 ] );

		} );

		it( 'publishes a primaries matrix once adopted', () => {

			cm.setWorkingSpace( 'ACEScg' );
			expect( cm.workingSpaceAdopted ).toBe( true );

			const m = getWorkingMatrix();
			expect( m ).toHaveLength( 9 );

			// A colour-space matrix preserves the white point: neutral in, neutral out.
			for ( const row of [ 0, 3, 6 ] ) {

				expect( m[ row ] + m[ row + 1 ] + m[ row + 2 ] ).toBeCloseTo( 1, 4 );

			}

		}, 120000 );

		it( 'converts a linear triple into it', () => {

			cm.setWorkingSpace( 'ACEScg' );
			const rgb = [ 0.8, 0.2, 0.1 ];
			expect( convertLinearTriple( rgb ) ).toBe( true );
			expect( rgb ).not.toEqual( [ 0.8, 0.2, 0.1 ] );

			// Round-tripping through the config gets the original back.
			const back = cm.convert( rgb, 'ACEScg', cm.nativeLinearSpace );
			expect( back[ 0 ] ).toBeCloseTo( 0.8, 4 );
			expect( back[ 1 ] ).toBeCloseTo( 0.2, 4 );
			expect( back[ 2 ] ).toBeCloseTo( 0.1, 4 );

		}, 120000 );

		it( 'converts an 8-bit texture and keeps its encoding', () => {

			cm.setWorkingSpace( 'ACEScg' );
			const bytes = new Uint8Array( [ 204, 51, 26, 255, 128, 128, 128, 255 ] );
			const before = Array.from( bytes );

			expect( cm.convertTextureBytes( bytes ) ).toBe( true );
			expect( Array.from( bytes ) ).not.toEqual( before );

			// Neutral grey has no primaries to change, so it must survive untouched.
			expect( bytes[ 4 ] ).toBeGreaterThanOrEqual( 127 );
			expect( bytes[ 4 ] ).toBeLessThanOrEqual( 129 );
			expect( bytes[ 7 ] ).toBe( 255 );

		}, 120000 );

	} );

	describe( 'the input side', () => {

		it( 'answers what a file is through the config own rules', () => {

			const match = cm.resolveInput( '/plates/shot010.exr' );
			expect( match ).not.toBeNull();
			expect( match.colorSpace ).toBeTypeOf( 'string' );
			expect( match.via ).toBe( 'rule' );

		} );

		it( 'lets a host override a rule', () => {

			cm.overrideInput( 'painted_', 'ACEScct' );
			expect( cm.resolveInput( '/tex/painted_wood.exr' ) ).toMatchObject( {
				colorSpace: 'ACEScct', via: 'override',
			} );

		} );

		it( 'says how it decided what a texture is, so the loader can trust only explicit answers', async () => {

			const { SRGBColorSpace, NoColorSpace } = await import( 'three' );
			const tex = ( name, colorSpace, userData = {} ) => ( { name, colorSpace, userData, image: {} } );

			// A file rule is someone saying what the file is.
			expect( cm.resolveTexture( tex( 'plates/shot010.exr', SRGBColorSpace ) ) ).toMatchObject( { via: 'rule' } );

			// The catch-all default rule is not — it loses to what three.js already believed.
			expect( cm.resolveTexture( tex( 'wood_albedo.png', SRGBColorSpace ) ) ).toMatchObject( { via: 'three' } );

			// A tag beats everything, and data never gets an answer at all.
			expect( cm.resolveTexture( tex( 'x.png', SRGBColorSpace, { ocioColorSpace: 'ACEScct' } ) ) )
				.toMatchObject( { colorSpace: 'ACEScct', via: 'tag' } );
			expect( cm.resolveTexture( tex( 'normal.png', NoColorSpace ) ) ).toBeNull();

		} );

		it( 'changes the input key when an override does, so cached textures are rebuilt', () => {

			const before = cm.inputKey;
			cm.overrideInput( 'another_', 'ACEScct' );
			expect( cm.inputKey ).not.toBe( before );

		} );

		it( 'exposes the rules a host would show', () => {

			expect( cm.fileRules().length ).toBeGreaterThan( 0 );
			expect( cm.fileRules()[ 0 ] ).toHaveProperty( 'colorSpace' );

		} );

	} );

	describe( 'the export side', () => {

		it( 'converts a rendered buffer into a delivery space', () => {

			cm.setWorkingSpace( 'ACEScg' );
			const px = new Float32Array( [ 0.18, 0.18, 0.18, 1 ] );
			const { rgba, colorSpace } = cm.exportPixels( px, 'ACES2065-1' );

			expect( colorSpace ).toBe( 'ACES2065-1' );
			expect( rgba[ 0 ] ).not.toBe( 0.18 );
			expect( rgba[ 3 ] ).toBe( 1 );

			cm.setWorkingSpace( null );

		}, 120000 );

		it( 'refuses a space the config does not have', () => {

			expect( () => cm.setExportSpace( 'Not A Space' ) ).toThrow( /no colour space/ );

		} );

	} );

	describe( 'unloading', () => {

		it( 'takes its view transforms with it and leaves the built-ins', () => {

			const before = listViewTransforms().length;
			expect( before ).toBeGreaterThan( 7 );

			cm.unloadConfig();

			const after = listViewTransforms();
			expect( after ).toHaveLength( 7 );
			expect( after.every( t => t.source === 'builtin' ) ).toBe( true );
			expect( getWorkingMatrix() ).toBeNull();
			expect( cm.hasConfig ).toBe( false );

		} );

	} );

} );
