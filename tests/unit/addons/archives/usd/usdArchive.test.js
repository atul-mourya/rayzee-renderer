import { describe, it, expect, vi } from 'vitest';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';

vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { localFolder } from '@/core/loaders/ArchiveFormats.js';
import { elementFilter } from '@/core/addons/archives/ArchiveReader.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { IssueLog } from '@/core/EngineIssues.js';
import { listUSDRootLayers } from '@/core/addons/archives/usd/index.js';
import { configurePlatform } from '@/core/Platform.js';
import { ARCHIVE_PATH } from '@/core/addons/archives/SceneGraphCodec.js';

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

describe( 'a USD scene in a zip', () => {

	it( 'inflates each file when the load reaches it, never one the scene does not name', async () => {

		const unused = 'island/usd/unused/big.bin';
		const files = Object.fromEntries( Object.entries( ISLAND ).map( ( [ path, body ] ) => [ path, strToU8( body ) ] ) );
		// Noise, so it stays large deflated: its local header sits outside the head and the directory reads.
		let seed = 1;
		files[ unused ] = new Uint8Array( 256 << 10 ).map( () => ( seed = ( seed * 16807 ) % 2147483647 ) & 255 );
		const bytes = zipSync( files );
		const name = strToU8( unused );
		let at = - 1;
		for ( let i = 0; i <= bytes.length - name.length && at < 0; i ++ ) if ( name.every( ( c, k ) => bytes[ i + k ] === c ) ) at = i;
		expect( at ).toBeGreaterThan( 512 );
		expect( at ).toBeLessThan( bytes.length - 65 * 1024 );

		const zip = new File( [ bytes ], 'island.zip' );
		const reads = [];
		const slice = zip.slice.bind( zip );
		zip.slice = ( start, end, type ) => {

			reads.push( [ start ?? 0, end ?? zip.size ] );
			return slice( start, end, type );

		};

		const { importer: archives } = importer();
		await archives.loadArchiveFromFile( zip, 'island.zip' );
		expect( archives.lastUSDStats.meshCount ).toBe( 3 );
		// Its local header (30 bytes, then the first copy of its name) is read only to reach its data.
		expect( reads.some( ( [ start, end ] ) => start < at && end > at - 30 ) ).toBe( false );

	} );

} );

describe( 'an image of a zipped USD scene', () => {

	const TEXTURED = {
		'scene.usda': usda( `def Material "mat"
{
    token outputs:surface.connect = </mat/s.outputs:surface>
    def Shader "s"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </mat/t.outputs:rgb>
    }
    def Shader "t"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @./wood.png@
    }
}
def Mesh "m"
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </mat>
}` ),
		'wood.png': 'not really a png',
	};

	// Its re-read: from the archive for a file picked from disk, none (a copy kept) for a download.
	const rereadOf = async options => {

		const zip = new File( [ zipSync( Object.fromEntries( Object.entries( TEXTURED ).map( ( [ p, b ] ) => [ p, strToU8( b ) ] ) ) ) ], 'scene.zip' );
		const { importer: archives } = importer();
		const seen = [];
		archives._archiveImage = async ( entry, path, reread ) => {

			seen.push( { path, reread, bytes: entry.length } );
			return null;

		};

		await archives.loadArchiveFromFile( zip, 'scene.zip', options );
		return seen;

	};

	it( 'is read again from the archive it came from', async () => {

		const [ local ] = await rereadOf( {} );
		expect( local.path ).toBe( 'wood.png' );
		expect( local.bytes ).toBe( TEXTURED[ 'wood.png' ].length );
		expect( new TextDecoder().decode( await local.reread() ) ).toBe( TEXTURED[ 'wood.png' ] );

	} );

	it( 'keeps its own copy when the archive may not outlive the load', async () => {

		const [ downloaded ] = await rereadOf( { transient: true } );
		expect( downloaded.reread ).toBe( null );

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
