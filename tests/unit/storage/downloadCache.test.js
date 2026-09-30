import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { DownloadCache, DOWNLOAD_POLICY, nameFromUrl } from '@/core/Storage/DownloadCache.js';

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

} );
