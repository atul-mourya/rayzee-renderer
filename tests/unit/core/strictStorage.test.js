import { describe, it, expect, vi } from 'vitest';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

const assetConfig = vi.hoisted( () => ( { configured: new Set(), storage: 'auto' } ) );

vi.mock( '@/core/AssetConfig.js', async ( importOriginal ) => ( {
	...await importOriginal(),
	getAssetConfig: () => ( { storage: assetConfig.storage, cacheNamespace: 'test' } ),
	isAssetConfigured: ( key ) => assetConfig.configured.has( key ),
} ) );

const acquire = vi.fn( async () => ( { storage: null, reason: 'none here', release: () => {} } ) );

function initStorage( { strict, option, configured = false, opener = acquire } ) {

	acquire.mockClear();
	assetConfig.configured = new Set( configured ? [ 'storage' ] : [] );
	const app = { _storageOption: option, _storageOpener: opener, _issues: new IssueLog( { strict } ), _disposed: false };
	return RayzeeRenderer.prototype._initStorage.call( app ).then( () => ( { opened: acquire.mock.calls.length > 0, issues: app._issues } ) );

}

describe( 'on-disk storage under strict', () => {

	it( 'is off by default, so a batch render is not answered from an earlier run\'s cache', async () => {

		expect( ( await initStorage( { strict: true } ) ).opened ).toBe( false );

	} );

	it( 'stays on by default for a viewer', async () => {

		expect( ( await initStorage( { strict: false } ) ).opened ).toBe( true );

	} );

	it( 'honours a host that asked for it, either way', async () => {

		expect( ( await initStorage( { strict: true, option: 'auto' } ) ).opened ).toBe( true );
		expect( ( await initStorage( { strict: true, configured: true } ) ).opened ).toBe( true );

	} );

} );

describe( 'on-disk storage without its add-on', () => {

	it( 'is quietly off when nobody asked for it', async () => {

		const { issues } = await initStorage( { strict: false, opener: null } );
		expect( issues.list ).toEqual( [] );

	} );

	it( 'says which add-on is missing when the host asked for it, without failing a strict host', async () => {

		const { issues } = await initStorage( { strict: true, option: 'auto', opener: null } );
		expect( issues.list.map( i => i.code ) ).toEqual( [ ISSUE_CODES.CAPABILITY_MISSING ] );

	} );

} );
