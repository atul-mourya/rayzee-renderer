import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataTexture, FloatType, RGBAFormat } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { acquireSharedStorage } from '@/core/addons/storage/OpenStorage.js';
import { heldLockNames } from '@/core/addons/storage/Locks.js';
import { getAssetConfig } from '@/core/AssetConfig.js';
import { setEnvironmentSource, loadCDF, saveCDF } from '@/core/storage/CDFCache.js';

const environment = ( source, width = 4, height = 2 ) => {

	const texture = new DataTexture( new Float32Array( width * height * 4 ), width, height, RGBAFormat, FloatType );
	texture.name = 'sky.hdr';
	setEnvironmentSource( texture, source );
	return texture;

};

const table = () => ( {
	exactConditional: Float32Array.of( 0.25, 0.5, 0.75, 1 ),
	exactMarginal: Float32Array.of( 0.4, 1 ),
	exactRowGuide: Float32Array.of( 0, 1, 2, 3 ),
	exactMarginalGuide: Float32Array.of( 0, 1 ),
	totalSum: 3.5, width: 4, height: 2, exactWidth: 4, exactHeight: 2, radianceIntegral: 3.5,
} );

describe( 'CDFCache', () => {

	let fake, uninstall, shared, area;

	beforeEach( async () => {

		fake = createFakeOPFS();
		uninstall = fake.install();
		shared = await acquireSharedStorage( getAssetConfig().cacheNamespace );
		area = shared.storage.area( 'cdf' );

	} );

	afterEach( () => {

		shared.release();
		uninstall();

	} );

	it( 'records a source only when there is one', () => {

		const texture = new DataTexture();
		setEnvironmentSource( texture, null );
		expect( texture.userData.__rayzeeSource ).toBeUndefined();
		setEnvironmentSource( null, 'a.hdr' );
		setEnvironmentSource( texture, 'https://cdn/a.hdr' );
		expect( texture.userData.__rayzeeSource ).toBe( 'https://cdn/a.hdr' );

	} );

	it( 'stores a table and reads the same one back, holding no lock after', async () => {

		const saved = table();
		expect( await saveCDF( environment( 'https://cdn/a.hdr' ), saved ) ).toBe( true );

		const loaded = await loadCDF( environment( 'https://cdn/a.hdr' ) );
		for ( const name of [ 'exactConditional', 'exactMarginal', 'exactRowGuide', 'exactMarginalGuide' ] ) {

			expect( loaded[ name ] ).toBeInstanceOf( Float32Array );
			expect( [ ...loaded[ name ] ] ).toEqual( [ ...saved[ name ] ] );

		}

		expect( loaded ).toMatchObject( { totalSum: 3.5, width: 4, height: 2, exactWidth: 4, exactHeight: 2, radianceIntegral: 3.5 } );
		expect( ( await area.list() )[ 0 ].label ).toBe( 'sky.hdr' );
		expect( ( await heldLockNames() ).size ).toBe( 0 );

	} );

	it( 'keys a table by source, size and colour space', async () => {

		await saveCDF( environment( 'https://cdn/a.hdr' ), table() );

		const converted = environment( 'https://cdn/a.hdr' );
		converted.userData.__rayzeeColorSpace = 'ACEScg';
		expect( await loadCDF( converted ) ).toBeNull();
		expect( await loadCDF( environment( 'https://cdn/a.hdr', 8, 4 ) ) ).toBeNull();
		expect( await loadCDF( environment( 'https://cdn/b.hdr' ) ) ).toBeNull();
		expect( await loadCDF( environment( 'https://cdn/a.hdr' ) ) ).not.toBeNull();

	} );

	it( 'labels an unnamed environment, and keys one with no image as 0×0', async () => {

		const generated = { name: '', userData: { __rayzeeSource: 'generated:sky' } };
		expect( await saveCDF( generated, table() ) ).toBe( true );
		expect( ( await area.list() )[ 0 ].label ).toBe( 'environment' );
		expect( await loadCDF( { userData: { __rayzeeSource: 'generated:sky' } } ) ).not.toBeNull();
		expect( await loadCDF( { image: { width: 1, height: 1 }, userData: { __rayzeeSource: 'generated:sky' } } ) ).toBeNull();

	} );

	it( 'neither stores nor finds a table without a source', async () => {

		const unnamed = environment( null );
		expect( await saveCDF( unnamed, table() ) ).toBe( false );
		expect( await loadCDF( unnamed ) ).toBeNull();
		expect( await loadCDF( null ) ).toBeNull();
		expect( await area.list() ).toHaveLength( 0 );

	} );

	it( 'refuses a table with a part missing', async () => {

		const partial = { ...table(), exactRowGuide: null };
		expect( await saveCDF( environment( 'https://cdn/a.hdr' ), partial ) ).toBe( false );
		expect( await area.list() ).toHaveLength( 0 );

	} );

	it( 'leaves nothing behind when a write fails', async () => {

		fake.state.faults.failWriteOf = 'exactRowGuide.f32';
		expect( await saveCDF( environment( 'https://cdn/a.hdr' ), table() ) ).toBe( false );
		expect( ( await heldLockNames() ).size ).toBe( 0 );
		fake.state.faults.failWriteOf = null;
		expect( await loadCDF( environment( 'https://cdn/a.hdr' ) ) ).toBeNull();
		expect( await area.list() ).toHaveLength( 0 );

	} );

	it( 'misses on an entry without all four files, and lets it go', async () => {

		await saveCDF( environment( 'https://cdn/a.hdr' ), table() );
		const [ { key } ] = await area.list();
		const writer = await area.create( key );
		await writer.write( 'exactConditional.f32', table().exactConditional );
		await writer.commit( {} );

		expect( await loadCDF( environment( 'https://cdn/a.hdr' ) ) ).toBeNull();
		expect( ( await heldLockNames() ).size ).toBe( 0 );

	} );

	it( 'stores nothing where there is no room', async () => {

		fake.state.quota = 16;
		expect( await saveCDF( environment( 'https://cdn/a.hdr' ), table() ) ).toBe( false );

	} );

} );

describe( 'CDFCache without storage', () => {

	it( 'misses and stores nothing', async () => {

		expect( await loadCDF( environment( 'https://cdn/a.hdr' ) ) ).toBeNull();
		expect( await saveCDF( environment( 'https://cdn/a.hdr' ), table() ) ).toBe( false );

	} );

} );
