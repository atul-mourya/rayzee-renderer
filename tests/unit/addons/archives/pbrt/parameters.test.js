import { describe, it, expect, vi } from 'vitest';

// three's FileLoader makes one per streamed chunk; Node has none (nodePlatform() defines one for hosts).
vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { localFolder } from '@/core/loaders/ArchiveFormats.js';
import { IssueLog, ISSUE_CODES, ISSUE_SEVERITY } from '@/core/EngineIssues.js';

const SCENE = `
Option "bool disablepixeljitter" true
LookAt 0 0 5  0 0 0  0 1 0
Camera "perspective" "float fov" 45 "float frameaspectratio" 1.5
Film "rgb" "integer xresolution" 64 "integer yresolution" 64 "float iso" 400 "string filename" "out.exr"
Sampler "zsobol" "integer pixelsamples" 16
WorldBegin
LightSource "distant" "blackbody L" 5500 "point3 from" [ 0 0 0 ] "point3 to" [ 0 0 1 ]
Texture "mask" "float" "imagemap" "string filename" "mask.png" "string wrap" "clamp"
Texture "bump" "float" "imagemap" "string filename" "bump.png" "string wrap" "clamp"
MakeNamedMaterial "red" "string type" "diffuse" "rgb reflectance" [ 0.8 0.1 0.1 ]
MakeNamedMaterial "glass" "string type" "dielectric" "spectrum eta" "glass-BK7"
MakeNamedMaterial "blend" "string type" "mix" "string materials" [ "red" "glass" ] "texture amount" "mask"
MakeNamedMaterial "paint" "string type" "coateddiffuse" "rgb reflectance" [ 0.5 0.2 0.1 ] "float roughness" 0.1
	"texture displacement" "bump" "float thickness" 0.02
MakeNamedMaterial "gem" "string type" "dielectric" "spectrum eta" [ 200 3.5 900 3.3 ]
MakeNamedMaterial "spare" "string type" "diffuse" "float sigma" 4
NamedMaterial "paint"
Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ] "point2 uv" [ 0 0 1 0 0 1 ] "float edgelength" 0.5
Shape "trianglemesh" "point3 P" [ 0 0 1 1 0 1 0 1 1 ] "integer indices" [ 0 1 2 ] "float edgelength" 0.5
AttributeBegin
	NamedMaterial "blend"
	AreaLightSource "diffuse" "rgb L" [ 1 1 1 ] "string filename" "glow.exr"
	Shape "sphere" "float radius" 1 "float zmin" -0.5 "float alpha" 0.5
AttributeEnd
NamedMaterial "gem"
Shape "sphere" "float radius" 0.5
`;

// Read against the text above: every parameter a translated directive sets and nothing reads, and every one read but
// not honoured exactly. "spare" and "bump" are never translated, so they report nothing.
const REPORT = {
	unused: {
		'AreaLightSource diffuse: filename': 1,
		'Camera perspective: frameaspectratio': 1,
		'Film rgb: iso': 1,
		'Material coateddiffuse: displacement': 1,
		'Material coateddiffuse: thickness': 1,
		'Option: disablepixeljitter': 1,
		'Shape trianglemesh: edgelength': 2,
		'Texture imagemap: wrap': 1,
	},
	approximated: {
		'LightSource distant: L': 1,
		'Material dielectric: eta': 2,
		'Material mix: amount': 1,
	},
};

const enc = new TextEncoder();

describe( 'pbrt parameters the loader does not honour', () => {

	it( 'reports each one once, with how many directives set it', async () => {

		const load = ( options ) => loadPBRTScene( {
			vfs: { 'scene.pbrt': enc.encode( SCENE ) },
			plyParser: () => null,
			imageFromBytes: async () => null,
			...options,
		} );

		const { parameters, warnings } = await load();
		expect( parameters ).toEqual( REPORT );
		// `Option "bool …" true` is one parameter; its value was read as a directive.
		expect( warnings.join( '\n' ) ).not.toMatch( /directive ignored: true/ );
		// Freeing a merged shape's arrays reads them, and is no use of them.
		expect( ( await load( { mergeShapesAbove: 1 } ) ).parameters ).toEqual( REPORT );

	} );

	it( 'counts a template shape once, though its moving placements build it again', async () => {

		const tri = ( z ) => `Shape "trianglemesh" "point3 P" [ 0 0 ${z} 1 0 ${z} 0 1 ${z} ] "integer indices" [ 0 1 2 ] "float edgelength" 0.5\n`;
		const scene = `Camera "perspective"\nWorldBegin\nObjectBegin "t"\n${tri( 0 )}${tri( 1 )}ObjectEnd\nObjectInstance "t"\n` +
			'ActiveTransform EndTime\nTranslate 0 1 0\nActiveTransform All\nObjectInstance "t"\n';
		const { group, parameters } = await loadPBRTScene( { vfs: { 'scene.pbrt': enc.encode( scene ) }, plyParser: () => null, imageFromBytes: async () => null } );

		expect( group.children.map( child => child.name ) ).toEqual( [ 'instance_0', 'placement_0', 'PBRT Camera' ] );
		expect( parameters.unused ).toEqual( { 'Shape trianglemesh: edgelength': 2 } );

	} );

	function importer( storage ) {

		const loader = {
			storage,
			loaderCache: {},
			_issues: new IssueLog( { strict: true } ),
			_throwDeferred() {},
			releaseTargetModel() {},
			onModelLoad: async () => {},
			dispatchEvent() {},
			_keyed: ( kind, id ) => ( id ? `${kind}::${id}` : null ),
		};
		return { importer: new ArchiveImporter( loader ), issues: loader._issues };

	}

	// What a cached open reads back: the scene stored at the first parse.
	function memoryArea() {

		let manifest = null, written;
		const stored = new Promise( resolve => written = resolve );
		const data = new Uint8Array( 1 << 20 );
		const area = {
			open: async () => ( manifest && { json: async () => manifest, file: async () => new Blob( [ data ] ), release() {} } ),
			create: async () => ( {
				write: async ( name, bytes, { at } ) => data.set( bytes, at ),
				writeJSON: async ( name, json ) => written( manifest = json ),
				commit: async () => {},
				abort: async () => {},
			} ),
			remove: async () => {},
		};
		return { storage: { area: () => area }, stored };

	}

	it( 'records one warning a strict host does not throw on, and again on a cached open', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const info = vi.spyOn( console, 'info' ).mockImplementation( () => {} );
		const folder = () => localFolder( { name: 'Scene', files: [ { path: 'Scene/scene.pbrt', file: new File( [ SCENE ], 'scene.pbrt' ) } ] } );
		const { storage, stored } = memoryArea();

		const first = importer( storage );
		await first.importer.loadFolder( folder() );
		first.importer.flushPendingGraph( Infinity );
		await stored;
		const second = importer( storage );
		await second.importer.loadFolder( folder() );
		expect( info.mock.calls.flat().join( '\n' ) ).toContain( 'opened from storage' );

		for ( const { issues } of [ first, second ] ) {

			const recorded = issues.list.filter( issue => issue.code === ISSUE_CODES.ASSET_PARAMETERS_IGNORED );
			expect( recorded ).toHaveLength( 1 );
			expect( recorded[ 0 ].severity ).toBe( ISSUE_SEVERITY.WARNING );
			expect( recorded[ 0 ].detail ).toEqual( { entry: 'Scene/scene.pbrt', ...REPORT } );

		}

		const listed = warn.mock.calls.map( args => args.join( ' ' ) ).filter( line => line.includes( 'parameter(s) ignored' ) );
		expect( listed ).toHaveLength( 2 );
		expect( listed[ 0 ] ).toContain( 'ignored       Shape trianglemesh: edgelength ×2' );
		vi.restoreAllMocks();

	} );

} );
