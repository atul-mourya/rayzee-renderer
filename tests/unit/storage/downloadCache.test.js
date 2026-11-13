import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { DownloadCache, DOWNLOAD_POLICY, nameFromUrl, fetchFile, sharedDownloads, cachedObjectURL } from '@/core/storage/DownloadCache.js';
import { sharedByNamespace } from '@/core/storage/StorageAreas.js';
import { getAssetConfig } from '@/core/AssetConfig.js';
import { configurePlatform } from '@/core/Platform.js';

function response( body, { status = 200, headers = {} } = {} ) {

	return new Response( status === 200 ? body : null, { status, headers } );

}

describe( 'DownloadCache', () => {

	let fake, uninstall, storage, fetchMock, server;

	beforeEach( async () => {

		fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );

		// As the engine's asset host answers: HEAD refused (no CORS header), Content-Range not exposed.
		server = { body: new Uint8Array( [ 1, 2, 3, 4, 5 ] ), lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', exposeRange: false, refuse: false };
		fetchMock = vi.fn( async ( url, options = {} ) => {

			const headers = { 'content-length': String( server.body.length ), 'last-modified': server.lastModified, 'content-type': 'model/gltf-binary' };
			if ( options.method === 'HEAD' ) throw new TypeError( 'Failed to fetch' );
			if ( url.includes( '404' ) ) return response( null, { status: 404 } );
			if ( isProbe( options ) ) {

				if ( server.refuse ) throw new TypeError( 'Failed to fetch' );
				await server.hold;
				const range = { 'last-modified': server.lastModified, 'content-length': '1', ...( server.exposeRange && { 'content-range': `bytes 0-0/${server.body.length}` } ) };
				return new Response( server.body.slice( 0, 1 ), { status: 206, headers: range } );

			}

			return response( server.body, { headers } );

		} );
		vi.stubGlobal( 'fetch', fetchMock );

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		storage.dispose();
		uninstall();

	} );

	const isProbe = ( options ) => new Headers( options?.headers ).has( 'range' );
	const gets = () => fetchMock.mock.calls.filter( ( [ , o ] ) => ( o?.method ?? 'GET' ) === 'GET' && ! isProbe( o ) ).length;
	const probes = () => fetchMock.mock.calls.filter( ( [ , o ] ) => isProbe( o ) ).length;

	const stamp = async ( url ) => {

		const entry = await storage.area( 'downloads' ).open( url );
		const at = entry?.extra.checkedAt;
		entry?.release();
		return at;

	};

	const settle = async ( until ) => {

		for ( let i = 0; i < 40 && ! await until(); i ++ ) await new Promise( ( r ) => setTimeout( r, 25 ) );

	};

	it( 'downloads once, then serves the stored copy', async () => {

		const cache = new DownloadCache( storage );
		const progress = [];
		const first = await cache.fetch( 'https://cdn/models/a.glb', { onProgress: ( e ) => progress.push( e.loaded ) } );
		expect( first.fromCache ).toBe( false );
		expect( first.file.name ).toBe( 'a.glb' );
		expect( [ ...new Uint8Array( await first.file.arrayBuffer() ) ] ).toEqual( [ 1, 2, 3, 4, 5 ] );
		expect( progress.at( - 1 ) ).toBe( 5 );
		first.release();

		const second = await cache.fetch( 'https://cdn/models/a.glb' );
		expect( second.fromCache ).toBe( true );
		expect( second.file.type ).toBe( 'model/gltf-binary' );
		second.release();
		expect( gets() ).toBe( 1 );

	} );

	it( 'revalidates a stale copy in the background and replaces it when it changed', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();

		server.body = new Uint8Array( [ 9, 9 ] );
		server.lastModified = 'Tue, 02 Jan 2024 00:00:00 GMT';

		const stale = await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } );
		expect( [ ...new Uint8Array( await stale.file.arrayBuffer() ) ] ).toEqual( [ 1, 2, 3, 4, 5 ] );
		stale.release();

		let bytes = null;
		for ( let i = 0; i < 40 && bytes?.length !== 2; i ++ ) {

			await new Promise( ( r ) => setTimeout( r, 25 ) );
			const fresh = await cache.fetch( 'https://cdn/a.glb', { policy: DOWNLOAD_POLICY.IMMUTABLE } );
			bytes = [ ...new Uint8Array( await fresh.file.arrayBuffer() ) ];
			fresh.release();

		}

		expect( bytes ).toEqual( [ 9, 9 ] );

	} );

	it( 'only stamps the check time when nothing changed', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();
		const entry = await storage.area( 'downloads' ).open( 'https://cdn/a.glb' );
		const checked = entry.extra.checkedAt;
		entry.release();

		await new Promise( ( r ) => setTimeout( r, 5 ) );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();

		let later = checked;
		for ( let i = 0; i < 40 && later === checked; i ++ ) {

			await new Promise( ( r ) => setTimeout( r, 25 ) );
			const again = await storage.area( 'downloads' ).open( 'https://cdn/a.glb' );
			later = again?.extra.checkedAt ?? checked;
			again?.release();

		}

		expect( later ).toBeGreaterThan( checked );
		expect( gets() ).toBe( 1 );

	} );

	it( 'checks with one byte, never HEAD, and stamps a refused check so it is not asked again on every load', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();
		const checked = await stamp( 'https://cdn/a.glb' );

		server.refuse = true;
		await new Promise( ( r ) => setTimeout( r, 5 ) );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		await settle( async () => ( await stamp( 'https://cdn/a.glb' ) ) > checked );

		expect( await stamp( 'https://cdn/a.glb' ) ).toBeGreaterThan( checked );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 60_000 } ) ).release();
		expect( probes() ).toBe( 1 );
		expect( fetchMock.mock.calls.some( ( [ , o ] ) => o?.method === 'HEAD' ) ).toBe( false );

	} );

	it( 'reads the size from Content-Range when the server exposes it', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();

		server.body = new Uint8Array( [ 7, 7, 7 ] );
		server.exposeRange = true;
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		await settle( async () => gets() === 2 );

		expect( gets() ).toBe( 2 );

	} );

	it( 'goes by Last-Modified alone when the size is not readable', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();
		const checked = await stamp( 'https://cdn/a.glb' );

		server.body = new Uint8Array( [ 7, 7, 7 ] );
		await new Promise( ( r ) => setTimeout( r, 5 ) );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		await settle( async () => ( await stamp( 'https://cdn/a.glb' ) ) > checked );

		expect( gets() ).toBe( 1 );

	} );

	it( 'never touches the cache for the network policy', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();
		( await cache.fetch( 'https://cdn/a.glb', { policy: DOWNLOAD_POLICY.NETWORK } ) ).release();
		expect( gets() ).toBe( 2 );

	} );

	it( 'falls back to memory without storage, and when storage runs out mid-download', async () => {

		const memoryOnly = await new DownloadCache( null ).fetch( 'https://cdn/b.glb' );
		expect( memoryOnly.fromCache ).toBe( false );
		expect( memoryOnly.file.size ).toBe( 5 );

		fake.state.faults.quotaAfterBytes = 2;
		const full = await new DownloadCache( storage ).fetch( 'https://cdn/c.glb' );
		expect( full.file.size ).toBe( 5 );
		expect( await storage.area( 'downloads' ).has( 'https://cdn/c.glb' ) ).toBe( false );

	} );

	it( 'reports HTTP errors and aborts', async () => {

		const cache = new DownloadCache( storage );
		await expect( cache.fetch( 'https://cdn/404.glb' ) ).rejects.toThrow( /HTTP 404/ );

		const controller = new AbortController();
		controller.abort();
		await expect( cache.fetch( 'https://cdn/a.glb', { signal: controller.signal } ) ).rejects.toMatchObject( { name: 'AbortError' } );

	} );

	it( 'keys an expiring URL by a stable key', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://signed/x.zip?sig=1', { key: 'sketchfab:abc', name: 'x.zip' } ) ).release();
		const hit = await cache.fetch( 'https://signed/x.zip?sig=2', { key: 'sketchfab:abc', name: 'x.zip' } );
		expect( hit.fromCache ).toBe( true );
		hit.release();

	} );

	it( 'names files from URLs', () => {

		expect( nameFromUrl( 'https://a/b/scene%20one.tar.gz?x=1' ) ).toBe( 'scene one.tar.gz' );
		expect( nameFromUrl( 'https://a/' ) ).toBe( 'download' );

	} );

	it( 'reads a file: URL through the host, never fetch or storage', async () => {

		const readFile = vi.fn( async () => new Uint8Array( [ 7, 8, 9 ] ) );
		configurePlatform( { readFile } );

		try {

			const got = await new DownloadCache( storage ).fetch( 'file:///opt/oidn/rt_hdr_alb_nrm_small.tza', { policy: DOWNLOAD_POLICY.IMMUTABLE } );
			expect( readFile.mock.calls[ 0 ][ 0 ].href ).toBe( 'file:///opt/oidn/rt_hdr_alb_nrm_small.tza' );
			expect( got.file.name ).toBe( 'rt_hdr_alb_nrm_small.tza' );
			expect( Array.from( new Uint8Array( await got.file.arrayBuffer() ) ) ).toEqual( [ 7, 8, 9 ] );
			expect( fetchMock ).not.toHaveBeenCalled();
			expect( await new DownloadCache( storage ).has( 'file:///opt/oidn/rt_hdr_alb_nrm_small.tza' ) ).toBe( false );

		} finally {

			configurePlatform( { readFile: null } );

		}

	} );

	it( 'downloads again when a stored entry lost its data, and lets go of the broken entry', async () => {

		const writer = await storage.area( 'downloads' ).create( 'https://cdn/a.glb' );
		await writer.commit( { contentType: 'model/gltf-binary' } );

		const cache = new DownloadCache( storage );
		// Holding the broken entry's shared lock would block the exclusive one the rewrite takes.
		const got = await Promise.race( [
			cache.fetch( 'https://cdn/a.glb' ),
			new Promise( ( r ) => setTimeout( () => r( 'blocked' ), 1000 ) ),
		] );
		expect( got ).not.toBe( 'blocked' );
		expect( got.fromCache ).toBe( false );
		got.release();

		const again = await cache.fetch( 'https://cdn/a.glb' );
		expect( again.fromCache ).toBe( true );
		expect( again.file.size ).toBe( 5 );
		again.release();
		expect( gets() ).toBe( 1 );

	} );

	it( 'checks a stale copy once while a check is in flight, and again after it ends', async () => {

		const cache = new DownloadCache( storage );
		( await cache.fetch( 'https://cdn/a.glb' ) ).release();

		let open;
		server.hold = new Promise( ( r ) => void ( open = r ) );
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		expect( probes() ).toBe( 1 );

		const checked = await stamp( 'https://cdn/a.glb' );
		server.hold = null;
		open();
		await settle( async () => ( await stamp( 'https://cdn/a.glb' ) ) > checked );

		( await cache.fetch( 'https://cdn/a.glb', { maxAgeMs: 0 } ) ).release();
		expect( probes() ).toBe( 2 );

	} );

	it( 'stops reading and cancels the body when aborted mid-download', async () => {

		const cancel = vi.fn();
		let sent = 0;
		const body = new ReadableStream( {
			pull( controller ) {

				controller.enqueue( new Uint8Array( 4 ) );
				if ( ++ sent === 10 ) controller.close();

			},
			cancel,
		} );
		fetchMock.mockImplementationOnce( async () => new Response( body, { headers: { 'content-length': '40' } } ) );

		const controller = new AbortController();
		const loading = new DownloadCache( null ).fetch( 'https://cdn/a.glb', {
			signal: controller.signal,
			onProgress: ( e ) => e.loaded >= 8 && controller.abort(),
		} );

		await expect( loading ).rejects.toMatchObject( { name: 'AbortError' } );
		expect( sent ).toBeLessThan( 10 );
		expect( cancel ).toHaveBeenCalledOnce();

	} );

	it( 'reads a response without a stream into memory, never into storage', async () => {

		fetchMock.mockImplementationOnce( async () => ( {
			ok: true,
			status: 200,
			headers: new Headers( { 'content-type': 'model/gltf-binary' } ),
			body: null,
			arrayBuffer: async () => new Uint8Array( [ 4, 2 ] ).buffer,
		} ) );

		const got = await new DownloadCache( storage ).fetch( 'https://cdn/a.glb' );
		expect( [ ...new Uint8Array( await got.file.arrayBuffer() ) ] ).toEqual( [ 4, 2 ] );
		expect( got.file.type ).toBe( 'model/gltf-binary' );
		expect( got.fromCache ).toBe( false );
		expect( await storage.area( 'downloads' ).has( 'https://cdn/a.glb' ) ).toBe( false );

	} );

	it( 'fails loudly when a saved copy cannot be read back, releasing what it opened', async () => {

		const area = storage.area( 'downloads' );
		const open = area.open.bind( area );
		const broken = { file: async () => null, release: vi.fn() };
		const spy = vi.spyOn( area, 'open' ).mockImplementation( ( key, options ) => options?.wait ? broken : open( key, options ) );

		try {

			await expect( new DownloadCache( storage ).fetch( 'https://cdn/a.glb' ) ).rejects.toThrow( /a\.glb vanished right after it was saved/ );
			expect( broken.release ).toHaveBeenCalledOnce();

			spy.mockImplementation( ( key, options ) => options?.wait ? null : open( key, options ) );
			await expect( new DownloadCache( storage ).fetch( 'https://cdn/b.glb' ) ).rejects.toThrow( /b\.glb vanished/ );

		} finally {

			spy.mockRestore();

		}

	} );

	it( 'names a URL whose escapes do not decode as a plain download', () => {

		expect( nameFromUrl( 'https://a/b%E0%A4%A.glb' ) ).toBe( 'download' );

	} );

	it( 'fetchFile downloads through the storage it is given', async () => {

		( await fetchFile( 'https://cdn/a.glb', storage ) ).release();
		expect( await storage.area( 'downloads' ).has( 'https://cdn/a.glb' ) ).toBe( true );

		const memory = await fetchFile( 'https://cdn/b.glb', null );
		expect( memory.file.size ).toBe( 5 );
		expect( gets() ).toBe( 2 );

	} );

	it( 'sharedDownloads uses the storage this page opened for the namespace', () => {

		const namespace = getAssetConfig().cacheNamespace;
		const before = sharedByNamespace.get( namespace );

		try {

			sharedByNamespace.delete( namespace );
			expect( sharedDownloads()._storage ).toBe( null );
			sharedByNamespace.set( namespace, { storage } );
			expect( sharedDownloads()._storage ).toBe( storage );

		} finally {

			if ( before ) sharedByNamespace.set( namespace, before );
			else sharedByNamespace.delete( namespace );

		}

	} );

	it( 'cachedObjectURL passes non-network URLs and storage-less pages through untouched', async () => {

		const stored = new DownloadCache( storage );
		for ( const url of [ 'blob:https://app/1', 'data:model/gltf-binary;base64,AA==', '/models/a.glb' ] ) {

			expect( await cachedObjectURL( url, { downloads: stored } ) ).toMatchObject( { url, cached: false } );

		}

		expect( await cachedObjectURL( 'https://cdn/a.glb', { downloads: new DownloadCache( null ) } ) ).toMatchObject( { url: 'https://cdn/a.glb', cached: false } );
		expect( fetchMock ).not.toHaveBeenCalled();

	} );

	it( 'cachedObjectURL hands out an object URL of the stored copy and frees both on release', async () => {

		const release = vi.fn();
		const file = new File( [ new Uint8Array( 3 ) ], 'a.glb' );
		const downloads = { _storage: storage, fetch: vi.fn( async () => ( { file, release } ) ) };
		const create = vi.spyOn( URL, 'createObjectURL' ).mockReturnValue( 'blob:test/1' );
		const revoke = vi.spyOn( URL, 'revokeObjectURL' ).mockImplementation( () => {} );

		try {

			const got = await cachedObjectURL( 'HTTPS://cdn/a.glb', { downloads, policy: DOWNLOAD_POLICY.IMMUTABLE } );
			expect( got ).toMatchObject( { url: 'blob:test/1', cached: true } );
			expect( downloads.fetch ).toHaveBeenCalledWith( 'HTTPS://cdn/a.glb', { policy: DOWNLOAD_POLICY.IMMUTABLE } );
			expect( create ).toHaveBeenCalledWith( file );
			expect( release ).not.toHaveBeenCalled();

			got.release();
			expect( revoke ).toHaveBeenCalledWith( 'blob:test/1' );
			expect( release ).toHaveBeenCalledOnce();

		} finally {

			create.mockRestore();
			revoke.mockRestore();

		}

	} );

} );
