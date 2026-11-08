import { describe, it, expect, afterEach, vi } from 'vitest';
import { Texture, TextureLoader } from 'three';
import { resolveObjectURL } from 'node:buffer';
import { gzipSync, zipSync } from 'three/addons/libs/fflate.module.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { createFakeOPFS } from '../../../__mocks__/opfs.js';
import { makeTar, text } from './tarFixture.js';

const FILES = {
	'scenes/main.pbrt': 'WorldBegin\n',
	'scenes/island/isA.pbrt': 'Shape "sphere"\n'.repeat( 4 ),
	'scenes/island/geo.ply': 'ply'.repeat( 100 ),
	'scenes/beach/b.pbrt': 'Shape "disk"\n',
	'scenes/textures/sand.png': 'png',
	'readme.txt': 'read me',
};
const bytesOf = Object.fromEntries( Object.entries( FILES ).map( ( [ path, body ] ) => [ path, text( body ) ] ) );
const total = Object.values( bytesOf ).reduce( ( n, b ) => n + b.length, 0 );
const tar = () => makeTar( Object.entries( bytesOf ).map( ( [ path, body ] ) => ( { path, body } ) ) );

describe( 'inspectArchive', () => {

	const importer = new ArchiveImporter( {} );

	it( 'lists a zip, a tar and a tar.gz alike: the scene root, its parts, entries and bytes', async () => {

		for ( const [ kind, bytes ] of [[ 'zip', zipSync( bytesOf ) ], [ 'tar', tar() ], [ 'gzip', gzipSync( tar() ) ]] ) {

			const report = await importer.inspectArchive( new File( [ bytes ], `scene.${kind}` ) );
			expect( report.kind ).toBe( kind );
			expect( report.root ).toBe( 'scenes' );
			expect( report.entryCount ).toBe( 6 );
			expect( report.totalBytes ).toBe( total );
			// Folders holding a .pbrt of their own, smallest first; textures/ holds none.
			expect( report.elements.map( e => [ e.prefix, e.files, e.bytes ] ) ).toEqual( [
				[ 'scenes/beach', 1, bytesOf[ 'scenes/beach/b.pbrt' ].length ],
				[ 'scenes/island', 2, bytesOf[ 'scenes/island/isA.pbrt' ].length + bytesOf[ 'scenes/island/geo.ply' ].length ],
			] );

		}

	} );

	describe( 'with storage', () => {

		let storage = null, uninstall = null;
		afterEach( () => {

			storage?.dispose();
			uninstall?.();
			storage = uninstall = null;

		} );

		it( 'lists a tar.gz from its unpacked copy, the same', async () => {

			const fake = createFakeOPFS();
			uninstall = fake.install();
			( { storage } = await openStorage( { namespace: 'rayzee', root: await fake.root.getDirectoryHandle( 'rayzee', { create: true } ), transport: 'inline' } ) );
			const report = await new ArchiveImporter( { storage } ).inspectArchive( new File( [ gzipSync( tar() ) ], 'scene.tar.gz', { lastModified: 3 } ) );
			expect( [ report.kind, report.root, report.entryCount, report.totalBytes, report.elements.length ] ).toEqual( [ 'gzip', 'scenes', 6, total, 2 ] );

		} );

	} );

	it( 'reports no root for an archive without a scene file', async () => {

		const report = await importer.inspectArchive( new File( [ zipSync( { 'a/model.glb': text( 'glTF' ) } ) ], 'm.zip' ) );
		expect( report ).toEqual( { kind: 'zip', root: null, elements: [], entryCount: 1, totalBytes: 4 } );

	} );

} );

// The OBJ + MTL pair's texture lookup (loadOBJMTLPairFromZip): which entry a texture reference lands on.
describe( 'resolveTextureInZip', () => {

	const importer = new ArchiveImporter( {} );
	// Decoys first: the loose fallback takes the first entry by that name, so a folder rule that is skipped lands on one.
	const ZIP = Object.fromEntries( [
		'decoy/oak.png', 'decoy/brass.png', 'decoy/cloth.png', 'decoy/rug.png', 'decoy/glass.png', 'maps/fuzz.jpg2',
		'models/chair.obj', 'models/chair.mtl', 'mtl/lib.mtl', 'models/oak.png', 'mtl/brass.png', 'textures/cloth.png',
		'texture/rug.png', 'materials/glass.png', 'deep/a/b/leaf.png', 'maps/darkwalnut_diffuse.jpg', 'maps/x.png',
	].map( path => [ path, text( path ) ] ) );

	const lands = ( url, { mtl = 'models/chair.mtl', zip = ZIP } = {} ) => {

		const created = [];
		const out = importer.resolveTextureInZip( url, 'models', mtl.split( '/' ).slice( 0, - 1 ).join( '/' ), { path: mtl }, zip, created );
		if ( out === url ) return { url: out, created };
		expect( created ).toEqual( [ out ] );
		const blob = resolveObjectURL( out );
		return blob.arrayBuffer().then( b => new TextDecoder().decode( b ) );

	};

	it( 'tries the path as written, then beside the OBJ, the MTL and the usual texture folders', async () => {

		expect( await lands( 'models/oak.png' ) ).toBe( 'models/oak.png' );
		expect( await lands( 'oak.png', { mtl: 'mtl/lib.mtl' } ) ).toBe( 'models/oak.png' );
		expect( await lands( './brass.png', { mtl: 'mtl/lib.mtl' } ) ).toBe( 'mtl/brass.png' );
		expect( await lands( '/cloth.png' ) ).toBe( 'textures/cloth.png' );
		expect( await lands( 'rug.png?v=2#top' ) ).toBe( 'texture/rug.png' );
		expect( await lands( 'glass.png' ) ).toBe( 'materials/glass.png' );

	} );

	it( 'drops a leading MTL file name some exporters write into the path', async () => {

		expect( await lands( 'chair.mtl/oak.png' ) ).toBe( 'models/oak.png' );
		expect( await lands( 'chair.mtl.oak.png' ) ).toBe( 'models/oak.png' );

	} );

	it( 'falls back to the whole file name anywhere, never to part of one', async () => {

		expect( await lands( 'C:/work/leaf.png' ) ).toBe( 'deep/a/b/leaf.png' );
		expect( await lands( 'C:\\work\\leaf.png' ) ).toBe( 'deep/a/b/leaf.png' );
		expect( await lands( 'elsewhere/x.png' ) ).toBe( 'maps/x.png' );
		for ( const missing of [ 'k.png', 'max.png', 'walnut_diffuse.jpg', 'darkwalnut_diffuse', 'z.jpg', 'nowhere/missing-texture.png' ] ) {

			expect( lands( missing ) ).toEqual( { url: missing, created: [] } );

		}

	} );

} );

// Both ways an OBJ in an archive gets its MTL: paired by name, or named by its `mtllib` line.
describe( 'OBJ + MTL textures in an archive', () => {

	const ZIP = {
		'decoy/oak.png': text( 'decoy' ),
		'models/chair.obj': text( 'mtllib chair.mtl\nusemtl wood\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n' ),
		'models/chair.mtl': text( 'newmtl wood\nmap_Kd oak.png\nmap_Bump textures/oak_n.png\nmap_Ks ..\\shared\\spec.png\nmap_d k.png\nnorm max.png\n' ),
		'models/oak.png': text( 'oak' ),
		'models/textures/oak_n.png': text( 'oak_n' ),
		'shared/spec.png': text( 'spec' ),
		'maps/x.png': text( 'x' ),
	};

	// Every texture three asks for, as the archive answers it: an entry's text, or the reference itself when none.
	const requested = () => {

		const asked = [];
		vi.spyOn( TextureLoader.prototype, 'load' ).mockImplementation( function ( url, onLoad ) {

			const resolved = this.manager.resolveURL( url );
			asked.push( resolved.startsWith( 'blob:' ) ? resolveObjectURL( resolved ).text() : resolved );
			const texture = new Texture();
			queueMicrotask( () => onLoad( texture ) );
			return texture;

		} );
		return async () => ( await Promise.all( asked ) ).sort();

	};

	afterEach( () => vi.restoreAllMocks() );

	const EXPECTED = [ 'k.png', 'max.png', 'oak', 'oak_n', 'spec' ];

	it( 'finds each beside its MTL, and none for a missing one', async () => {

		const asked = requested();
		const loaded = [];
		const importer = new ArchiveImporter( { _issues: null, releaseTargetModel() {}, onModelLoad: async m => loaded.push( m ), dispatchEvent() {} } );
		await importer.processObjMtlPairsInZip( ZIP, 'chair.zip' );

		expect( loaded ).toHaveLength( 1 );
		expect( await asked() ).toEqual( EXPECTED );

	} );

	it( 'finds each beside the MTL an OBJ names', async () => {

		const asked = requested();
		await new ArchiveImporter( { _issues: null } )._parseObjFromZip( ZIP[ 'models/chair.obj' ], 'models/chair.obj', ZIP );
		expect( await asked() ).toEqual( EXPECTED );

	} );

} );

describe( 'prepareFixedMtlContent', () => {

	it( 'removes the MTL file name before a texture and parts a statement from a path run into it', async () => {

		const importer = new ArchiveImporter( {} );
		const mtl = 'newmtl wood\nmap_Kd chair.mtl  oak.png\nmap_Bump textures/oak_n.png\nmap_Ks/maps\\spec.png\n';
		const fixed = await importer.prepareFixedMtlContent( { path: 'models/chair.mtl', content: text( mtl ) } );
		expect( fixed ).toBe( 'newmtl wood\nmap_Kd  oak.png\nmap_Bump textures/oak_n.png\nmap_Ks /maps\\spec.png\n' );

	} );

} );
