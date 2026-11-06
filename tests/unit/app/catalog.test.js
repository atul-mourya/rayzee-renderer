import { describe, it, expect, vi } from 'vitest';
import { PAGE_SIZE, itemKey, pageAfter, listSource, rankSearch, searchEntries } from '@/lib/catalog';

const items = n => Array.from( { length: n }, ( _, i ) => ( { id: `i${i}`, name: `Item ${i}` } ) );

async function every( search ) {

	const seen = [];
	let cursor = null;
	do {

		const page = await search( cursor );
		seen.push( ...page.items );
		cursor = page.nextCursor;

	} while ( cursor );

	return seen;

}

describe( 'pageAfter', () => {

	it( 'walks the list a page at a time and ends with no cursor', async () => {

		const list = items( PAGE_SIZE * 2 + 5 );
		const first = pageAfter( list, null );
		expect( first.items ).toEqual( list.slice( 0, PAGE_SIZE ) );
		expect( await every( cursor => pageAfter( list, cursor ) ) ).toEqual( list );
		expect( pageAfter( items( PAGE_SIZE ), null ).nextCursor ).toBeNull();
		expect( pageAfter( [], null ) ).toEqual( { items: [], nextCursor: null } );

	} );

	it( 'puts pinned keys first, once, across every page', async () => {

		const list = items( 60 );
		const pinned = [ 'i59', 'i30' ];
		const seen = await every( cursor => pageAfter( list, cursor, pinned ) );
		expect( seen.slice( 0, 2 ).map( itemKey ) ).toEqual( [ 'i30', 'i59' ] );
		expect( new Set( seen.map( itemKey ) ).size ).toBe( 60 );

	} );

	it( 'keys an item by its id, else its name', () => {

		expect( itemKey( { id: 'a', name: 'b' } ) ).toBe( 'a' );
		expect( itemKey( { name: 'b' } ) ).toBe( 'b' );

	} );

} );

describe( 'rankSearch', () => {

	const index = names => searchEntries( names.map( ( [ name, tags = [] ] ) => ( { name, tags } ) ), item => [[ item.name, 4 ], [ item.tags, 2 ]] );
	const find = ( names, query ) => rankSearch( index( names ), query ).map( item => item.name );

	it( 'needs every word, in any order and case, and keeps the list without a query', () => {

		const names = [[ 'Red Brick Wall' ], [ 'Brick Floor' ], [ 'Red Plaster' ]];
		expect( find( names, 'WALL red' ) ).toEqual( [ 'Red Brick Wall' ] );
		expect( find( names, '  ' ) ).toEqual( [ 'Red Brick Wall', 'Brick Floor', 'Red Plaster' ] );

	} );

	it( 'reads a plural as its word, a word\'s start, and accents as plain letters', () => {

		const names = [[ 'Red Brick' ], [ 'Rocky Terrain' ], [ 'Café Table' ], [ 'Glass Pane' ], [ 'Cloudy Skies' ]];
		expect( find( names, 'bricks' ) ).toEqual( [ 'Red Brick' ] );
		expect( find( names, 'roc' ) ).toEqual( [ 'Rocky Terrain' ] );
		expect( find( names, 'cafe' ) ).toEqual( [ 'Café Table' ] );
		expect( find( names, 'glasses' ) ).toEqual( [ 'Glass Pane' ] );
		expect( find( names, 'sky' ) ).toEqual( [ 'Cloudy Skies' ] );

	} );

	it( 'reads common word forms as one word, and no more', () => {

		const names = [[ 'Snow Field' ], [ 'Sunny Day' ], [ 'Wooden Deck' ], [ 'Tiled Floor' ], [ 'Rugged Bench' ], [ 'Shag Rug' ]];
		expect( find( names, 'snowy' ) ).toEqual( [ 'Snow Field' ] );
		expect( find( names, 'sun' ) ).toEqual( [ 'Sunny Day' ] );
		expect( find( names, 'wood' ) ).toEqual( [ 'Wooden Deck' ] );
		expect( find( names, 'tile' ) ).toEqual( [ 'Tiled Floor' ] );
		expect( find( names, 'rugs' ) ).toEqual( [ 'Shag Rug' ] );

	} );

	it( 'ranks a name above a tag, a whole word above part of one, and the phrase in the name first', () => {

		const names = [[ 'Plywood Sheet' ], [ 'Old Planks', [ 'wood' ]], [ 'Wood Floor' ], [ 'Floor Wood Tiles' ]];
		expect( find( names, 'wood' ) ).toEqual( [ 'Wood Floor', 'Floor Wood Tiles', 'Old Planks', 'Plywood Sheet' ] );
		expect( find( names, 'wood floor' ) ).toEqual( [ 'Wood Floor', 'Floor Wood Tiles' ] );

	} );

	it( 'takes a near miss only when nothing matches outright', () => {

		const names = [[ 'Concrete Floor' ], [ 'Concert Hall' ]];
		expect( find( names, 'conrete' ) ).toEqual( [ 'Concrete Floor' ] );
		expect( find( names, 'concert' ) ).toEqual( [ 'Concert Hall' ] );
		expect( find( names, 'xyzzy' ) ).toEqual( [] );

	} );

} );

describe( 'listSource', () => {

	const catalog = [
		{ id: 'w1', name: 'Oak Planks', preview: 'oak.png', categories: [ 'wood', 'floor' ], tags: [ 'brown' ] },
		{ id: 'b1', name: 'Red Brick', preview: 'brick.png', categories: [ 'brick', 'wall' ], tags: [ 'red' ] },
		{ id: 'w2', name: 'Pine Boards', preview: 'pine.png', categories: [ 'wood' ], tags: [ 'pale' ] },
	];

	it( 'loads the list once and lists categories largest first', async () => {

		const load = vi.fn( async () => catalog );
		const source = listSource( { NAME: 'Test', CATALOG: 'test', noun: 'materials', load } );
		const categories = await source.getCategories();
		await source.search( { category: 'wood' } );
		expect( load ).toHaveBeenCalledTimes( 1 );
		expect( source.NAME ).toBe( 'Test' );
		expect( categories[ 0 ] ).toEqual( { id: 'wood', slug: 'wood', name: 'Wood', label: '2 materials', preview: 'oak.png', tags: [] } );
		expect( categories.map( c => c.slug ) ).toEqual( [ 'wood', 'floor', 'brick', 'wall' ] );

	} );

	it( 'searches a category, or every item, by names, tags and categories', async () => {

		const source = listSource( { noun: 'materials', load: () => catalog } );
		const ids = async opts => ( await source.search( opts ) ).items.map( itemKey );
		expect( await ids( { category: 'wood' } ) ).toEqual( [ 'w1', 'w2' ] );
		expect( await ids( { category: 'wood', query: 'pale' } ) ).toEqual( [ 'w2' ] );
		expect( await ids( { query: 'red wall' } ) ).toEqual( [ 'b1' ] );
		expect( await ids( { query: 'boards' } ) ).toEqual( [ 'w2' ] );
		expect( await ids( { query: 'red wood' } ) ).toEqual( [] );

	} );

	it( 'loads again after a failure', async () => {

		const load = vi.fn().mockRejectedValueOnce( new Error( 'offline' ) ).mockResolvedValue( catalog );
		const source = listSource( { noun: 'materials', load } );
		await expect( source.getCategories() ).rejects.toThrow( 'offline' );
		expect( ( await source.getCategories() ).length ).toBe( 4 );

	} );

} );
