import { describe, it, expect } from 'vitest';
import { isArchiveUrl, isImportableUrl } from '@/lib/archives';

describe( 'archive URLs', () => {

	it( 'recognises archives by path, ignoring query strings', () => {

		expect( isArchiveUrl( 'https://x/scene.tar.gz?sig=abc' ) ).toBe( true );
		expect( isArchiveUrl( 'https://x/scene.zip' ) ).toBe( true );
		expect( isArchiveUrl( 'https://x/scene.tgz' ) ).toBe( true );
		expect( isArchiveUrl( 'https://x/model.glb?name=a.zip' ) ).toBe( false );

	} );

	it( 'accepts glTF and archives over http(s) only', () => {

		expect( isImportableUrl( 'https://x/a.glb' ) ).toBe( true );
		expect( isImportableUrl( 'http://x/a.gltf' ) ).toBe( true );
		expect( isImportableUrl( 'https://x/a.tar' ) ).toBe( true );
		expect( isImportableUrl( 'https://x/a.obj' ) ).toBe( false );
		expect( isImportableUrl( 'ftp://x/a.glb' ) ).toBe( false );
		expect( isImportableUrl( '' ) ).toBe( false );

	} );

} );
