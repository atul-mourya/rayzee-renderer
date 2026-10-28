import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveObjectURL } from 'node:buffer';
import { openZip } from '@/core/addons/archives/ZipReader.js';
import { openSink, zipInto } from '@/lib/zipSink';

const type = { description: 'Zip archive', extension: '.zip' };
const bytes = ( ...values ) => new Uint8Array( values );

function deferred() {

	let resolve, reject;
	const promise = new Promise( ( ok, fail ) => {

		resolve = ok;
		reject = fail;

	} );
	return { promise, resolve, reject };

}

describe( 'zip sinks', () => {

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.useRealTimers();

	} );

	it( 'streams into the file the user picks, one write after another', async () => {

		const order = [];
		const slow = deferred();
		const writable = {
			write: vi.fn( async ( chunk ) => {

				if ( chunk[ 0 ] === 1 ) await slow.promise;
				order.push( chunk[ 0 ] );

			} ),
			close: vi.fn( async () => order.push( 'close' ) ),
			abort: vi.fn(),
		};
		const handle = { createWritable: async () => writable };
		const showSaveFilePicker = vi.fn( async () => handle );
		vi.stubGlobal( 'window', { showSaveFilePicker } );

		const sink = await openSink( 'scene.zip', type );
		expect( showSaveFilePicker ).toHaveBeenCalledWith( { suggestedName: 'scene.zip', types: [ { description: 'Zip archive', accept: { 'application/zip': [ '.zip' ] } } ] } );
		expect( sink.streamed ).toBe( true );
		expect( sink.handle ).toBe( handle );

		sink.push( bytes( 1 ) );
		sink.push( bytes( 2 ) );
		const closed = sink.close();
		await Promise.resolve();
		expect( order ).toEqual( [] );
		slow.resolve();
		await closed;
		expect( order ).toEqual( [ 1, 2, 'close' ] );

	} );

	it( 'aborts the picked file once the writes settle, failed ones included', async () => {

		const writable = { write: vi.fn( async () => {

			throw new Error( 'disk full' );

		} ), close: vi.fn(), abort: vi.fn( async () => {} ) };
		vi.stubGlobal( 'window', { showSaveFilePicker: async () => ( { createWritable: async () => writable } ) } );

		const sink = await openSink( 'scene.zip', type );
		sink.push( bytes( 1 ) );
		await expect( sink.drain() ).rejects.toThrow( 'disk full' );
		await sink.abort();
		expect( writable.abort ).toHaveBeenCalledTimes( 1 );
		await expect( sink.close() ).rejects.toThrow( 'disk full' );
		expect( writable.close ).not.toHaveBeenCalled();

	} );

	it( 'assembles a download in memory where no file can be picked', async () => {

		vi.useFakeTimers( { toFake: [ 'setTimeout' ] } );
		const link = { click: vi.fn() };
		vi.stubGlobal( 'window', {} );
		vi.stubGlobal( 'document', { createElement: vi.fn( () => link ) } );
		const revoke = vi.spyOn( URL, 'revokeObjectURL' );

		const sink = await openSink( 'scene.zip', type );
		expect( sink.streamed ).toBe( false );
		expect( sink.handle ).toBeNull();
		sink.push( bytes( 1, 2 ) );
		sink.push( bytes( 3 ) );
		await sink.drain();
		await sink.close();

		expect( document.createElement ).toHaveBeenCalledWith( 'a' );
		expect( link.download ).toBe( 'scene.zip' );
		expect( link.click ).toHaveBeenCalledTimes( 1 );
		const blob = resolveObjectURL( link.href );
		expect( blob.type ).toBe( 'application/zip' );
		expect( [ ...new Uint8Array( await blob.arrayBuffer() ) ] ).toEqual( [ 1, 2, 3 ] );

		vi.advanceTimersByTime( 9_999 );
		expect( revoke ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 1 );
		expect( revoke ).toHaveBeenCalledWith( link.href );

		sink.push( bytes( 4 ) );
		await sink.abort();
		await sink.close();
		expect( resolveObjectURL( link.href ).size ).toBe( 0 );

	} );

	it( 'writes entries a zip reader reads back, streaming a blob piece by piece', async () => {

		const chunks = [];
		const drain = vi.fn( async () => {} );
		const zip = zipInto( { push: ( c ) => chunks.push( c ), drain } );
		const big = new Uint8Array( 300_000 ).map( ( _, i ) => i * 31 );
		const progress = [];

		zip.addBytes( 'a.txt', new TextEncoder().encode( 'hello' ) );
		const pieces = [ big.subarray( 0, 100_000 ), big.subarray( 100_000, 200_000 ), big.subarray( 200_000 ) ];
		await zip.addBlob( 'dir/big.bin', new Blob( pieces ), { onProgress: ( f ) => progress.push( f ) } );
		await zip.addBlob( 'empty.bin', new Blob( [] ) );
		await zip.finish();

		expect( zip.failure ).toBeNull();
		expect( progress.map( ( f ) => f.toFixed( 3 ) ) ).toEqual( [ '0.333', '0.667', '1.000' ] );
		expect( drain ).toHaveBeenCalledTimes( 4 );

		const read = await openZip( new File( chunks, 'out.zip' ) );
		expect( new TextDecoder().decode( await read.read( 'a.txt' ) ) ).toBe( 'hello' );
		expect( await read.read( 'dir/big.bin' ) ).toEqual( big );
		expect( ( await read.read( 'empty.bin' ) ).length ).toBe( 0 );

	} );

	it( 'reports what the zip writer refuses', async () => {

		const zip = zipInto( { push: () => {}, drain: async () => {} } );
		zip.addBytes( 'x'.repeat( 70_000 ), bytes( 1 ) );
		expect( zip.failure ).toBeInstanceOf( Error );
		await expect( zip.addBlob( 'b.bin', new Blob( [ bytes( 1 ) ] ) ) ).rejects.toBe( zip.failure );
		await expect( zip.finish() ).rejects.toBe( zip.failure );

	} );

} );
