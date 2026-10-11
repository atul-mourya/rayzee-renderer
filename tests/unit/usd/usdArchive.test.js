import { describe, it, expect, vi } from 'vitest';

vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { localFolder } from '@/core/Processor/archiveFormats.js';
import { elementFilter } from '@/core/Processor/ArchiveReader.js';
import { ArchiveImporter } from '@/core/Processor/ArchiveImporter.js';
import { IssueLog } from '@/core/EngineIssues.js';
import { listUSDRootLayers } from '@/core/Processor/USD/index.js';
import { configurePlatform } from '@/core/Platform.js';
import { ARCHIVE_PATH } from '@/core/Storage/SceneGraphCodec.js';

const usda = body => `#usda 1.0\n${body}\n`;
const MODEL = /\.(gltf|glb|obj|usd|usda|usdc)$/i;

function importer() {

	const loaded = [];
	const loader = {
		storage: null,
		_issues: new IssueLog(),
		getFileFormat: path => ( MODEL.test( path ) ? { type: 'model' } : null ),
		releaseTargetModel() {},
		applyEnvironmentToScene() {},
		onModelLoad: async model => loaded.push( model ),
		dispatchEvent() {},
		_keyed: ( kind, id ) => ( id ? `${kind}::${id}` : null ),
		_reportImageFailure() {},
		_throwDeferred() {},
	};
	return { importer: new ArchiveImporter( loader ), loader, loaded };

}

const tri = name => `def Mesh "${name}"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </shared/stone>
}`;

// Moana's layout in miniature: a root layer, parts under elements/, a material library beside them.
const ISLAND = {
	'island/usd/island.usda': usda( `(
    defaultPrim = "island"
)
def Xform "island"
{
    def Xform "rocks" ( prepend references = @./elements/rocks/element.usda@ )
    {
    }
    def Xform "trees" ( prepend references = @./elements/trees/element.usda@ )
    {
    }
    def Scope "shared" ( prepend references = @./materials/library.usda@ )
    {
    }
}` ),
	'island/usd/islandAlt.usda': usda( `(
    subLayers = [ @./island.usda@ ]
)` ),
	'island/usd/elements/rocks/element.usda': usda( `(
    defaultPrim = "rocks"
)
def Xform "rocks"
{
    ${tri( 'rock' )}
}` ),
	'island/usd/elements/trees/element.usda': usda( `(
    defaultPrim = "trees"
)
def Xform "trees"
{
    ${tri( 'trunk' )}
    ${tri( 'branch' )}
}` ),
	'island/usd/materials/library.usda': usda( `(
    defaultPrim = "lib"
)
def Scope "lib"
{
    def Material "stone"
    {
    }
}` ),
	'island/textures/rocks/rock.ptx': 'x',
	'island/README.txt': 'x',
};

const folderOf = files => localFolder( { files: Object.entries( files ).map( ( [ path, body ] ) => ( { path, file: new File( [ body ], path.split( '/' ).pop() ) } ) ) } );

describe( 'a USD scene in a folder', () => {

	it( 'loads from the shallowest, shortest-named layer', () => {

		expect( listUSDRootLayers( Object.keys( ISLAND ) ) ).toEqual( [ 'island/usd/island.usda', 'island/usd/islandAlt.usda' ] );

	} );

	it( 'asks which parts to load when it is large, naming the prims that bring in a directory of their own', async () => {

		const { importer: archives } = importer();
		const error = await archives.loadFolder( folderOf( ISLAND ), { promptBytes: 1 } ).catch( e => e );
		expect( error.code ).toBe( 'ARCHIVE_NEEDS_ELEMENT' );
		expect( error.elements.map( e => [ e.name, e.prefix, e.files ] ) ).toEqual( [
			[ 'rocks', 'island/usd/elements/rocks', 1 ],
			[ 'trees', 'island/usd/elements/trees', 1 ],
		] );

	} );

	it( 'loads the parts chosen, with what they share, and skips the rest quietly', async () => {

		const { importer: archives, loaded } = importer();
		const model = await archives.loadFolder( folderOf( ISLAND ), { promptBytes: 1, element: [ 'island/usd/elements/trees' ] } );
		expect( loaded ).toEqual( [ model ] );
		const names = [];
		model.traverse( o => o.isMesh && names.push( o.name ) );
		expect( names.length ).toBeGreaterThan( 0 );
		expect( archives.lastUSDStats.meshCount ).toBe( 2 );

	} );

	it( 'loads the whole scene when it is small', async () => {

		const { importer: archives } = importer();
		await archives.loadFolder( folderOf( ISLAND ) );
		expect( archives.lastUSDStats.meshCount ).toBe( 3 );

	} );

} );

describe( 'the parts filter', () => {

	it( 'leaves out only the parts not chosen, keeping a material library in a directory of its own', () => {

		const keep = elementFilter( [ 'island/usd/elements/trees' ] );
		expect( Object.keys( ISLAND ).filter( p => keep( p ) ) ).toEqual( [
			'island/usd/island.usda', 'island/usd/islandAlt.usda', 'island/usd/elements/trees/element.usda',
			'island/usd/materials/library.usda', 'island/textures/rocks/rock.ptx', 'island/README.txt',
		] );

	} );

} );

describe( 'an image from a scene archive', () => {

	it( 'is decoded by the host\'s decoder where there is one, top row first like the browser\'s', async () => {

		const { importer: archive } = importer();
		configurePlatform( { decodeImage: async () => ( { data: new Uint8Array( 2 * 1 * 4 ).fill( 200 ), width: 2, height: 1 } ) } );
		try {

			const texture = await archive._archiveImage( new Uint8Array( 8 ), 'textures/wood.png' );
			expect( [ texture.image.width, texture.image.height, texture.flipY, texture.colorSpace ] ).toEqual( [ 2, 1, true, 'srgb' ] );
			expect( texture.userData[ ARCHIVE_PATH ] ).toBe( 'textures/wood.png' );

		} finally {

			configurePlatform( { decodeImage: null } );

		}

	} );

	it( 'that nothing can decode leaves its surfaces untextured and is reported, the load going on', async () => {

		const { importer: archive, loader } = importer();
		const failures = [];
		loader._reportImageFailure = ( where, error ) => failures.push( [ where, error.message ] );
		expect( await archive._archiveImage( new Uint8Array( 8 ), 'textures/wood.png' ) ).toBeNull();
		expect( failures ).toEqual( [[ 'textures/wood.png', expect.stringContaining( 'no image decoder' ) ]] );

	} );

} );
