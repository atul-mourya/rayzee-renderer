import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock( '@/lib/aiEdit', async ( original ) => ( { ...await original(), runEdit: vi.fn() } ) );
vi.mock( '@/lib/database', () => ( { addAIVersion: vi.fn(), deleteAIVersion: vi.fn(), getAIVersionFile: vi.fn() } ) );
vi.mock( '@/services/geminiApi', async ( original ) => ( { ...await original(), checkKey: vi.fn() } ) );
vi.mock( '@/store/ui.js', () => ( { useStore: { getState: () => ( { resultsViewportRef: null } ) } } ) );

const render = { id: 5, image: 'blob:render', aiVersions: [ { n: 1, prompt: 'old' } ], aiNext: 3 };

let useAIStore, runEdit, addAIVersion, checkKey, GeminiError, saved, storage;

beforeEach( async () => {

	vi.resetModules();
	storage = new Map();
	vi.stubGlobal( 'localStorage', { getItem: k => storage.get( k ) ?? null, setItem: ( k, v ) => storage.set( k, v ), removeItem: k => storage.delete( k ) } );
	saved = vi.fn();
	vi.stubGlobal( 'window', Object.assign( new EventTarget(), {} ) );
	window.addEventListener( 'render-saved', saved );
	vi.stubGlobal( 'fetch', vi.fn( async () => new Response( new Blob( [ 'render' ] ) ) ) );
	vi.stubGlobal( 'createImageBitmap', vi.fn( async () => ( { width: 4, height: 3, close: vi.fn() } ) ) );

	( { useAIStore } = await import( '@/store/ai.js' ) );
	( { runEdit } = await import( '@/lib/aiEdit' ) );
	( { addAIVersion } = await import( '@/lib/database' ) );
	( { checkKey, GeminiError } = await import( '@/services/geminiApi' ) );

} );

afterEach( () => vi.unstubAllGlobals() );

describe( 'AI edits', () => {

	it( 'asks for a key first, and checks it before keeping it and making the edit that waited', async () => {

		const store = useAIStore.getState();
		store.setPrompt( 'Add a cat' );
		await store.generate( render );
		expect( useAIStore.getState().connect ).toEqual( { pending: render } );
		expect( runEdit ).not.toHaveBeenCalled();

		checkKey.mockRejectedValueOnce( new GeminiError( 'key', 'bad' ) );
		await useAIStore.getState().saveKey( 'wrong' );
		expect( useAIStore.getState().connect ).toMatchObject( { pending: render, error: 'key' } );
		expect( storage.has( 'gemini_api_key' ) ).toBe( false );

		checkKey.mockResolvedValueOnce( true );
		runEdit.mockResolvedValueOnce( { blob: new Blob( [ 'x' ] ), width: 4, height: 3, text: '' } );
		addAIVersion.mockResolvedValueOnce( 3 );
		await useAIStore.getState().saveKey( ' good ' );
		expect( storage.get( 'gemini_api_key' ) ).toBe( 'good' );
		expect( useAIStore.getState().connect ).toBeNull();
		await vi.waitFor( () => expect( useAIStore.getState().shown[ 5 ] ).toBe( 3 ) );
		expect( runEdit.mock.calls[ 0 ][ 0 ] ).toMatchObject( { prompt: 'Add a cat', key: 'good', scope: 'only', size: '2K', area: null } );

	} );

	it( 'saves the result on the render it started from, numbered next, and shows it', async () => {

		useAIStore.setState( { key: 'K' } );
		const store = useAIStore.getState();
		store.setPrompt( 'Make it real' );
		let finish;
		runEdit.mockImplementationOnce( () => new Promise( r => {

			finish = r;

		} ) );
		addAIVersion.mockResolvedValueOnce( 3 );

		const running = store.generate( render );
		await vi.waitFor( () => expect( runEdit ).toHaveBeenCalled() );
		expect( useAIStore.getState().jobs[ 5 ] ).toMatchObject( { n: 3, prompt: 'Make it real', part: false } );
		await store.generate( render );
		expect( runEdit ).toHaveBeenCalledTimes( 1 );

		finish( { blob: new Blob( [ 'out' ] ), width: 4, height: 3, text: 'Here it is' } );
		await running;
		expect( addAIVersion.mock.calls[ 0 ][ 0 ] ).toBe( 5 );
		expect( addAIVersion.mock.calls[ 0 ][ 1 ] ).toMatchObject( { prompt: 'Make it real', scope: 'only', part: false, from: 'render', width: 4, height: 3, note: 'Here it is' } );
		expect( useAIStore.getState().jobs[ 5 ] ).toBeUndefined();
		expect( useAIStore.getState().shown[ 5 ] ).toBe( 3 );
		expect( saved ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'waits for a marked area, and turns a failure into a notice; a cancel leaves none', async () => {

		useAIStore.setState( { key: 'K' } );
		const store = useAIStore.getState();
		store.setPrompt( 'Add a cup' );
		store.setWhere( 'part' );
		await store.generate( render );
		expect( runEdit ).not.toHaveBeenCalled();

		store.setArea( 5, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } );
		runEdit.mockRejectedValueOnce( new GeminiError( 'quota', 'Quota exceeded', { retryAfter: 30 } ) );
		await store.generate( render );
		expect( runEdit.mock.calls[ 0 ][ 0 ].area ).toEqual( { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } );
		const notice = useAIStore.getState().notices[ 5 ];
		expect( notice.kind ).toBe( 'quota' );
		expect( notice.retryAt ).toBeGreaterThan( Date.now() + 25000 );

		runEdit.mockImplementationOnce( ( { signal } ) => new Promise( ( _, reject ) => signal.addEventListener( 'abort', () => reject( new GeminiError( 'aborted', 'Cancelled' ) ) ) ) );
		const running = store.generate( render );
		await vi.waitFor( () => expect( runEdit ).toHaveBeenCalledTimes( 2 ) );
		expect( useAIStore.getState().notices[ 5 ] ).toBeUndefined();
		store.cancel( 5 );
		await running;
		expect( useAIStore.getState().notices[ 5 ] ).toBeUndefined();
		expect( useAIStore.getState().jobs[ 5 ] ).toBeUndefined();
		expect( addAIVersion ).not.toHaveBeenCalled();

	} );

	it( 'edits the picture shown, and shows the render again when that version is deleted', async () => {

		useAIStore.setState( { key: 'K' } );
		const { getAIVersionFile, deleteAIVersion } = await import( '@/lib/database' );
		const store = useAIStore.getState();
		store.setPrompt( 'Warmer' );
		store.show( 5, 1 );
		getAIVersionFile.mockResolvedValueOnce( new Blob( [ 'v1' ] ) );
		runEdit.mockResolvedValueOnce( { blob: new Blob( [ 'x' ] ), width: 4, height: 3, text: '' } );
		addAIVersion.mockResolvedValueOnce( 3 );
		await store.generate( render );
		expect( getAIVersionFile ).toHaveBeenCalledWith( 5, 1 );
		expect( addAIVersion.mock.calls[ 0 ][ 1 ].from ).toBe( 1 );
		expect( useAIStore.getState().shown[ 5 ] ).toBe( 3 );

		store.show( 5, 1 );
		await store.deleteVersion( render, 1 );
		expect( deleteAIVersion ).toHaveBeenCalledWith( 5, 1 );
		expect( useAIStore.getState().shown[ 5 ] ).toBe( 'render' );

	} );

} );
