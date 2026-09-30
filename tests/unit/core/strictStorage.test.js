import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { IssueLog } from '@/core/EngineIssues.js';

const assetConfig = vi.hoisted( () => ( { configured: new Set(), storage: 'auto' } ) );

vi.mock( '@/core/AssetConfig.js', async ( importOriginal ) => ( {
	...await importOriginal(),
	getAssetConfig: () => ( { storage: assetConfig.storage, cacheNamespace: 'test' } ),
	isAssetConfigured: ( key ) => assetConfig.configured.has( key ),
} ) );

const acquire = vi.hoisted( () => vi.fn( async () => ( { storage: null, reason: 'none here', release: () => {} } ) ) );
vi.mock( '@/core/Storage/openStorage.js', async ( importOriginal ) => ( { ...await importOriginal(), acquireSharedStorage: acquire } ) );

function initStorage( { strict, option, configured = false } ) {

	acquire.mockClear();
	assetConfig.configured = new Set( configured ? [ 'storage' ] : [] );
	const app = { _storageOption: option, _issues: new IssueLog( { strict } ), _disposed: false };
	return PathTracerApp.prototype._initStorage.call( app ).then( () => acquire.mock.calls.length > 0 );

}

describe( 'on-disk storage under strict', () => {

	it( 'is off by default, so a batch render is not answered from an earlier run\'s cache', async () => {

		expect( await initStorage( { strict: true } ) ).toBe( false );

	} );

	it( 'stays on by default for a viewer', async () => {

		expect( await initStorage( { strict: false } ) ).toBe( true );

	} );

	it( 'honours a host that asked for it, either way', async () => {

		expect( await initStorage( { strict: true, option: 'auto' } ) ).toBe( true );
		expect( await initStorage( { strict: true, configured: true } ) ).toBe( true );

	} );

} );
