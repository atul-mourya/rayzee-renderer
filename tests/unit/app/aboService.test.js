import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AboService } from '@/services/AboService';

const PACK = 'https://huggingface.co/datasets/codepawl/abo-glb/resolve/abc/objects';
const INDEX = {
	categories: [ 'Chairs', 'Sofas' ],
	pack: PACK,
	items: [
		[ 'B000000001', 0, 'Rivet Mid-Century Lounge Chair, Walnut', 'A1t+GZJiPdL', 18240, 6710886, 1258291, 2048 ],
		[ 'B000000002', 0, 'Stone & Beam Dining Chair, Grey', '81svzHPcn7L', 950, 512, 300, 0 ],
		[ 'B000000003', 1, 'Rivet Modern Leather Sofa, Chestnut', '71M-BF6gLLL', 2400000, 45717944, 1487852, 4096 ],
		[ 'B000000004', 1, 'Rivet Sofa Bed, Grey', '61abcDEFghL', 30000, 9000000, 400000, 1024 ],
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
			[ 'all', 'All models', '4 models' ],
			[ '0', 'Chairs', '2 models' ],
			[ '1', 'Sofas', '2 models' ],
		] );
		expect( categories[ 1 ].preview ).toBe( AboService.imageUrl( 'A1t+GZJiPdL' ) );

	} );

	it( 'gives each file\'s real texture size and its size in the tooltip', async () => {

		serve();
		const { items } = await AboService.search( {} );
		expect( items.map( i => [ i.label, ...i.details.map( row => row.join( ': ' ) ) ] ) ).toEqual( [
			[ 'Chairs · 18k triangles', 'Compressed: 2K textures · 1.2 MB', 'Original: 2K textures · 6.4 MB' ],
			[ 'Chairs · 950 triangles', 'Compressed: 1 KB', 'Original: 1 KB' ],
			[ 'Sofas · 2.4M triangles', 'Compressed: 2K textures · 1.4 MB', 'Original: 4K textures · 43.6 MB' ],
			[ 'Sofas · 30k triangles', 'Compressed: 1K textures · 391 KB', 'Original: 1K textures · 8.6 MB' ],
		] );

	} );

	it( 'filters by category and by every word of the query, in any case, shorter names first', async () => {

		serve();
		const names = async opts => ( await AboService.search( opts ) ).items.map( i => i.id );
		expect( await names( { category: '0' } ) ).toEqual( [ 'B000000001', 'B000000002' ] );
		expect( await names( { category: '1' } ) ).toEqual( [ 'B000000003', 'B000000004' ] );
		expect( await names( { query: 'rivet' } ) ).toEqual( [ 'B000000004', 'B000000003', 'B000000001' ] );
		expect( await names( { query: 'sofas' } ) ).toEqual( [ 'B000000004', 'B000000003' ] );
		expect( await names( { query: '  RIVET   chair ' } ) ).toEqual( [ 'B000000001' ] );
		expect( await names( { query: 'rivet', category: '0' } ) ).toEqual( [ 'B000000001' ] );
		expect( await names( { query: 'ottoman' } ) ).toEqual( [] );

	} );

	it( 'pages through the matches', async () => {

		const items = Array.from( { length: 50 }, ( _, i ) => [ `B${String( i ).padStart( 9, '0' )}`, 0, `Chair ${i}`, '', 10, 1024, 512, 2048 ] );
		serve( { categories: [ 'Chairs' ], pack: PACK, items } );
		const first = await AboService.search( {} );
		const second = await AboService.search( { cursor: first.nextCursor } );
		const third = await AboService.search( { cursor: second.nextCursor } );
		expect( [ first.items.length, second.items.length, third.items.length ] ).toEqual( [ 24, 24, 2 ] );
		expect( third.items[ 1 ].name ).toBe( 'Chair 49' );
		expect( third.nextCursor ).toBeNull();

	} );

	it( 'loads the compressed copy by default and Amazon\'s file as the original', async () => {

		serve();
		const { items } = await AboService.search( {} );
		expect( await AboService.resolveDownload( items[ 0 ] ) ).toEqual( { url: `${PACK}/B000000001/B000000001.glb`, format: 'glb' } );
		expect( await AboService.resolveDownload( items[ 0 ], { variant: 'compressed' } ) ).toEqual( { url: `${PACK}/B000000001/B000000001.glb`, format: 'glb' } );
		expect( await AboService.resolveDownload( items[ 0 ], { variant: 'original' } ) ).toEqual( { url: AboService.modelUrl( 'B000000001' ), format: 'glb' } );
		expect( AboService.canDownload( items[ 0 ] ) ).toBe( true );
		expect( AboService.VARIANTS.map( r => r.value ) ).toEqual( [ 'compressed', 'original' ] );

	} );

	it( 'tries the list again after a failure', async () => {

		serve( null, false );
		await expect( AboService.getCategories() ).rejects.toThrow( 'Failed to load the Amazon model list: HTTP 404' );
		serve();
		expect( ( await AboService.getCategories() ).length ).toBe( 3 );

	} );

} );
