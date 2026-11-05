import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AboService } from '@/services/AboService';

const INDEX = {
	categories: [ 'Chairs', 'Sofas' ],
	items: [
		[ 'B000000001', 0, 'Rivet Mid-Century Lounge Chair, Walnut', 'A1t+GZJiPdL', 18240, 4096, 6710886 ],
		[ 'B000000002', 0, 'Stone & Beam Dining Chair, Grey', '81svzHPcn7L', 950, 0, 512 ],
		[ 'B000000003', 1, 'Rivet Modern Leather Sofa, Chestnut', '71M-BF6gLLL', 2400000, 2048, 45717944 ],
	],
};

function serve( json = INDEX, ok = true ) {

	const fetch = vi.fn( async () => ( { ok, status: ok ? 200 : 404, statusText: ok ? 'OK' : 'Not Found', json: async () => json } ) );
	vi.stubGlobal( 'fetch', fetch );
	return fetch;

}

describe( 'AboService', () => {

	beforeEach( () => {

		AboService._index = null;

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		AboService._index = null;

	} );

	it( 'points at the bucket by the id\'s last character', () => {

		expect( AboService.modelUrl( 'B075X4QMX3' ) ).toBe( 'https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/original/3/B075X4QMX3.glb' );

	} );

	it( 'encodes a photo id\'s plus sign', () => {

		expect( AboService.imageUrl( 'A1t+GZJiPdL' ) ).toBe( 'https://m.media-amazon.com/images/I/A1t%2BGZJiPdL._AC_US256_.jpg' );
		expect( AboService.imageUrl( '' ) ).toBeNull();

	} );

	it( 'fetches the list once', async () => {

		const fetch = serve();
		await AboService.getCategories();
		await AboService.search( {} );
		expect( fetch ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'lists every category after All, with counts and the first photo', async () => {

		serve();
		const categories = await AboService.getCategories();
		expect( categories.map( c => [ c.slug, c.name, c.label ] ) ).toEqual( [
			[ 'all', 'All models', '3 models' ],
			[ '0', 'Chairs', '2 models' ],
			[ '1', 'Sofas', '1 models' ],
		] );
		expect( categories[ 1 ].preview ).toBe( AboService.imageUrl( 'A1t+GZJiPdL' ) );

	} );

	it( 'describes each model in its label', async () => {

		serve();
		const { items } = await AboService.search( {} );
		expect( items.map( i => i.label ) ).toEqual( [
			'Chairs · 18k triangles · 4K textures · 6.4 MB',
			'Chairs · 950 triangles · 1 KB',
			'Sofas · 2.4M triangles · 2K textures · 43.6 MB',
		] );

	} );

	it( 'filters by category and by every word of the query, in any case', async () => {

		serve();
		const names = async opts => ( await AboService.search( opts ) ).items.map( i => i.id );
		expect( await names( { category: '0' } ) ).toEqual( [ 'B000000001', 'B000000002' ] );
		expect( await names( { category: '1' } ) ).toEqual( [ 'B000000003' ] );
		expect( await names( { query: 'rivet' } ) ).toEqual( [ 'B000000001', 'B000000003' ] );
		expect( await names( { query: '  RIVET   chair ' } ) ).toEqual( [ 'B000000001' ] );
		expect( await names( { query: 'rivet', category: '0' } ) ).toEqual( [ 'B000000001' ] );
		expect( await names( { query: 'ottoman' } ) ).toEqual( [] );

	} );

	it( 'pages through the matches', async () => {

		const items = Array.from( { length: 50 }, ( _, i ) => [ `B${String( i ).padStart( 9, '0' )}`, 0, `Chair ${i}`, '', 10, 0, 1024 ] );
		serve( { categories: [ 'Chairs' ], items } );
		const first = await AboService.search( {} );
		const second = await AboService.search( { cursor: first.nextCursor } );
		const third = await AboService.search( { cursor: second.nextCursor } );
		expect( [ first.items.length, second.items.length, third.items.length ] ).toEqual( [ 24, 24, 2 ] );
		expect( third.items[ 1 ].name ).toBe( 'Chair 49' );
		expect( third.nextCursor ).toBeNull();

	} );

	it( 'resolves a model to its file, and tries the list again after a failure', async () => {

		serve( null, false );
		await expect( AboService.getCategories() ).rejects.toThrow( 'Failed to load the Amazon model list: HTTP 404' );
		serve();
		const { items } = await AboService.search( {} );
		expect( await AboService.resolveDownload( items[ 0 ] ) ).toEqual( { url: AboService.modelUrl( 'B000000001' ), format: 'glb' } );
		expect( AboService.canDownload( items[ 0 ] ) ).toBe( true );

	} );

} );
