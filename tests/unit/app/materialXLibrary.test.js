import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs, sizeOf, buildCatalog, catalogFrom } from '../../../app/scripts/mirror-materialx-library.mjs';

// The app's constants read the window as they load.
vi.hoisted( () => {

	globalThis.window ??= globalThis;
	globalThis.devicePixelRatio ??= 1;
	globalThis.dispatchEvent ??= () => true;

} );

let app;
vi.mock( '@/lib/appProxy', () => ( { getApp: () => app } ) );

const { libraryItems, packageFor, sizeMenu, MaterialXMaterials, MATERIALX_LIBRARY_URL, applyLibraryMaterial } = await import( '@/services/MaterialXLibrary' );
const { SEVERAL_MATERIALS } = await import( '@/lib/materialDrop' );

// AMD's API lists, as the mirror reads them: ids everywhere, names in their own lists.
const api = {
	categories: [ { id: 'c1', title: 'Metal' }, { id: 'c2', title: 'Wood' } ],
	// An id shared with a category: each list is its own.
	tags: [ { id: 't1', title: 'shiny' }, { id: 't2', title: '1.38' }, { id: 'c1', title: 'polished' } ],
	packages: [
		{ id: 'p1', label: '1k 8b' }, { id: 'p2', label: '2k 8b' }, { id: 'p3', label: '1k 16b' }, { id: 'p4', label: '4k 8b' },
		{ id: 'p5', label: '1k 8b' },
	],
	materials: [
		{ id: 'm1', title: ' Gold ', status: 'Published', category: 'c1', tags: [ 't1', 't2', 'c1' ], packages: [ 'p1', 'p2', 'p3', 'p4' ], renders: [ 'r1', 'r2' ], renders_order: [ 'r2', 'r1' ] },
		{ id: 'm2', title: 'Ash', status: 'Published', category: 'c2', tags: [], packages: [ 'p5' ], renders: [ 'r3' ], renders_order: [] },
		{ id: 'm3', title: 'Draft', status: 'Draft', category: 'c2', tags: [], packages: [ 'p5' ], renders: [] },
		{ id: 'm4', title: 'Only deep', status: 'Published', category: 'c9', tags: [], packages: [ 'p3' ], renders: [] },
	],
};

describe( 'mirroring AMD\'s MaterialX library', () => {

	it( 'keeps published materials with every 8-bit package they have, named, by name', () => {

		const catalog = buildCatalog( api );
		expect( catalog.map( m => m.name ) ).toEqual( [ 'Ash', 'Gold' ] );
		const gold = catalog[ 1 ];
		expect( gold ).toMatchObject( { category: 'Metal', tags: [ 'shiny', 'polished' ], render: 'r2', preview: 'previews/m1.jpg' } );
		expect( Object.keys( gold.packages ) ).toEqual( [ '1k', '2k', '4k' ] );
		expect( gold.packages[ '2k' ] ).toEqual( { id: 'p2', path: 'packages/m1/2k.zip' } );
		// No render order: the first render.
		expect( catalog[ 0 ].render ).toBe( 'r3' );

	} );

	it( 'lists what is on disk: every size a material has there, earlier runs\' too, and drops one with none', () => {

		const items = buildCatalog( api );
		// 1k from an earlier run, 2k from this one, Gold's 4k failed; Ash's zip and preview are missing.
		const disk = { 'packages/m1/1k.zip': 10, 'packages/m1/2k.zip': 40, 'previews/m1.jpg': 5 };
		const catalog = catalogFrom( items, path => disk[ path ] ?? null );
		expect( catalog.sizes ).toEqual( [ '1k', '2k' ] );
		expect( catalog.materials.map( m => m.name ) ).toEqual( [ 'Gold' ] );
		expect( catalog.materials[ 0 ] ).toMatchObject( { preview: 'previews/m1.jpg', packages: { '1k': { path: 'packages/m1/1k.zip', bytes: 10 }, '2k': { path: 'packages/m1/2k.zip', bytes: 40 } } } );
		expect( catalog.materials[ 0 ].render ).toBeUndefined();
		expect( catalogFrom( items, path => ( path.endsWith( '.zip' ) ? 1 : null ) ).materials.map( m => m.preview ) ).toEqual( [ null, null ] );

	} );

	it( 'reads sizes and arguments', () => {

		expect( [ '1k 8b', '4k 16b', '8k 8b', '' ].map( sizeOf ) ).toEqual( [ '1k', null, '8k', null ] );
		expect( parseArgs( [ '--out', 'x', '--sizes', '1k, 2k', '--limit', '5' ] ) ).toEqual( { out: 'x', sizes: [ '1k', '2k' ], limit: 5 } );
		expect( () => parseArgs( [] ) ).toThrow( /--out/ );
		expect( () => parseArgs( [ '--out', 'x', '--size', '1k' ] ) ).toThrow( /unknown/ );
		// A typo must not write an empty catalogue over a good one.
		expect( () => parseArgs( [ '--out', 'x', '--limit', '2O' ] ) ).toThrow( /--limit/ );
		expect( () => parseArgs( [ '--out', 'x', '--limit', '0' ] ) ).toThrow( /--limit/ );

	} );

} );

describe( 'the MaterialX tab', () => {

	const catalog = {
		sizes: [ '1k', '2k' ],
		materials: [
			{ id: 'm1', name: 'Gold', category: 'Metal', tags: [ 'shiny' ], preview: 'previews/m1.jpg', page: 'https://matlib.gpuopen.com/x',
				packages: { '1k': { path: 'packages/m1/1k.zip', bytes: 10 }, '2k': { path: 'packages/m1/2k.zip', bytes: 40 } } },
			{ id: 'm2', name: 'Ash', category: 'Wood', preview: null, packages: { '4k': { path: 'packages/m2/4k.zip', bytes: 9 } } },
		],
	};

	afterEach( () => vi.unstubAllGlobals() );

	it( 'lists the copy\'s materials with their files on the asset host', () => {

		const [ gold, ash ] = libraryItems( catalog, 'https://host/lib' );
		expect( gold ).toMatchObject( { id: 'm1', name: 'Gold', categories: [ 'Metal' ], tags: [ 'shiny' ], preview: 'https://host/lib/previews/m1.jpg', redirection: 'https://matlib.gpuopen.com/x' } );
		expect( gold.packages[ '2k' ] ).toEqual( { url: 'https://host/lib/packages/m1/2k.zip', bytes: 40 } );
		expect( ash ).toMatchObject( { preview: null, tags: [] } );
		expect( libraryItems( catalog )[ 0 ].preview ).toBe( `${MATERIALX_LIBRARY_URL}/previews/m1.jpg` );

	} );

	it( 'takes the size asked, else the largest below it, else the smallest there is', () => {

		const [ gold, ash ] = libraryItems( catalog, 'h' );
		expect( packageFor( gold, '2k' ).size ).toBe( '2k' );
		expect( packageFor( gold, '4k' ).size ).toBe( '2k' );
		expect( packageFor( ash, '1k' ) ).toMatchObject( { size: '4k', url: 'h/packages/m2/4k.zip' } );
		expect( packageFor( { packages: {} }, '1k' ) ).toBeNull();
		// Listed as AMD orders them, not by size.
		const unordered = { packages: { '4k': { url: 'c' }, '1k': { url: 'a' }, '2k': { url: 'b' } } };
		expect( packageFor( unordered, '2k' ).url ).toBe( 'b' );
		expect( packageFor( unordered, '8k' ).url ).toBe( 'c' );
		expect( packageFor( { packages: { '4k': { url: 'c' }, '2k': { url: 'b' } } }, '1k' ).url ).toBe( 'b' );

	} );

	it( 'searches the catalogue by category and name, and offers sizes once the copy has more than one', async () => {

		vi.stubGlobal( 'fetch', vi.fn( async () => ( { ok: true, json: async () => catalog } ) ) );
		expect( MaterialXMaterials.VARIANTS ).toBeUndefined();
		const categories = await MaterialXMaterials.getCategories();
		expect( categories.map( c => c.name ) ).toEqual( [ 'Metal', 'Wood' ] );
		const { items } = await MaterialXMaterials.search( { query: 'gold' } );
		expect( items.map( i => i.name ) ).toEqual( [ 'Gold' ] );
		expect( fetch ).toHaveBeenCalledWith( `${MATERIALX_LIBRARY_URL}/catalog.json` );
		expect( MaterialXMaterials.VARIANTS ).toEqual( [ { value: '1k', label: '1K' }, { value: '2k', label: '2K' } ] );
		expect( sizeMenu( [ '1k' ] ) ).toBeUndefined();

	} );

	describe( 'applying one', () => {

		let mesh;
		beforeEach( () => {

			mesh = { name: 'cup', material: { name: 'china' } };
			app = {
				meshScene: { traverse: visit => [ mesh ].forEach( visit ) },
				readMaterials: vi.fn( async () => [ { name: 'Gold', material: { name: 'Gold' } } ] ),
				rebuildMaterials: vi.fn( async () => {} ),
			};
			vi.spyOn( window, 'dispatchEvent' ).mockImplementation( () => true );

		} );

		it( 'downloads its zip at the size asked and reads it as a dropped file', async () => {

			vi.stubGlobal( 'fetch', vi.fn( async () => ( { ok: true, blob: async () => new Blob( [ 'PK' ] ) } ) ) );
			const [ gold ] = libraryItems( catalog, 'h' );
			const applied = await applyLibraryMaterial( gold, '2k', mesh );
			expect( fetch ).toHaveBeenCalledWith( 'h/packages/m1/2k.zip' );
			const file = app.readMaterials.mock.calls[ 0 ][ 0 ];
			expect( file ).toBeInstanceOf( File );
			expect( file.name ).toBe( 'Gold.zip' );
			expect( applied.map( m => m.name ) ).toEqual( [ 'Gold' ] );
			expect( mesh.material.name ).toBe( 'Gold' );
			expect( app.rebuildMaterials ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'says why: a failed download, no files, a file with no MaterialX in it', async () => {

			const [ gold ] = libraryItems( catalog, 'h' );
			vi.stubGlobal( 'fetch', vi.fn( async () => ( { ok: false, status: 404 } ) ) );
			await expect( applyLibraryMaterial( gold, '1k', mesh ) ).rejects.toThrow( 'Gold: 404' );
			await expect( applyLibraryMaterial( { name: 'Empty', packages: {} }, '1k', mesh ) ).rejects.toThrow( 'Empty has no files' );

			vi.stubGlobal( 'fetch', vi.fn( async () => ( { ok: true, blob: async () => new Blob( [ 'PK' ] ) } ) ) );
			app.readMaterials.mockResolvedValueOnce( null );
			await expect( applyLibraryMaterial( gold, '1k', mesh ) ).rejects.toThrow( 'Gold holds no MaterialX material' );
			expect( mesh.material.name ).toBe( 'china' );

		} );

		it( 'refuses a part with several materials before downloading', async () => {

			vi.stubGlobal( 'fetch', vi.fn() );
			mesh.material = [ { name: 'a' }, { name: 'b' } ];
			const [ gold ] = libraryItems( catalog, 'h' );
			await expect( applyLibraryMaterial( gold, '1k', mesh ) ).rejects.toThrow( SEVERAL_MATERIALS );
			expect( fetch ).not.toHaveBeenCalled();

		} );

	} );

} );
