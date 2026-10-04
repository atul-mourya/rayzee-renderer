import { describe, it, expect, vi } from 'vitest';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';
import { ARCHIVE_FORMATS } from '@/core/Processor/archiveFormats.js';

// Only the archive half of the loader is exercised; nothing here touches a scene.
function loaderWith( load ) {

	const loader = Object.create( AssetLoader.prototype );
	loader.archives = null;
	loader.setArchiveImporterLoader( load, ARCHIVE_FORMATS );
	return loader;

}

describe( 'the archive importer, installed to load on first use', () => {

	it( 'knows archive formats before its code loads', () => {

		const load = vi.fn();
		const loader = loaderWith( load );
		expect( loader.getFileFormat( 'scene.tar.gz' ) ).toEqual( { type: 'archive', name: 'Gzipped TAR Archive' } );
		expect( load ).not.toHaveBeenCalled();

	} );

	it( 'loads it once, for the first archive read, and hands every read to it', async () => {

		const importer = { inspectArchive: vi.fn( async () => [ 'a.pbrt' ] ) };
		const load = vi.fn( async () => importer );
		const loader = loaderWith( load );
		const file = { name: 'scene.zip' };
		expect( await Promise.all( [ loader.inspectArchive( file ), loader.inspectArchive( file ) ] ) ).toEqual( [[ 'a.pbrt' ], [ 'a.pbrt' ]] );
		expect( load ).toHaveBeenCalledTimes( 1 );
		expect( loader.archives ).toBe( importer );

	} );

} );
