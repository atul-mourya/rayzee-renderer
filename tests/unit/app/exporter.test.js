import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

const { database, encodeHDR, encodeStill } = vi.hoisted( () => ( {
	database: { getRenderHDR: vi.fn() },
	encodeHDR: vi.fn( async () => new Blob( [ 'radiance' ] ) ),
	encodeStill: vi.fn( async () => new Blob( [ 'still' ] ) ),
} ) );
vi.mock( '@/lib/database', () => database );
vi.mock( 'rayzee/encoders', async importOriginal => ( { ...await importOriginal(), encodeHDR, encodeStill } ) );

import { encodeEXR } from '@/core/output/ImageEncoders.js';
import { setApp } from '@/lib/appProxy';
import {
	videoBitrate, holdsLight, takesGainMap, isLossy, isFrameSequence, readVideoSettings, fileStem, downloadBlob,
	exportPicture, exportSavedRender, canPickFolder, frameName, openFrameSink, DEFAULT_VIDEO, VIDEO_SETTINGS_KEY,
} from '@/lib/exporter';

let downloads, blobs;

const blobOf = url => blobs.get( url );

function stubDocument() {

	downloads = [];
	blobs = new Map();
	vi.stubGlobal( 'document', {
		createElement: () => {

			const link = { click: vi.fn( () => downloads.push( { name: link.download, url: link.href } ) ) };
			return link;

		},
	} );
	let next = 0;
	vi.spyOn( URL, 'createObjectURL' ).mockImplementation( blob => {

		const url = `blob:test/${ next ++ }`;
		blobs.set( url, blob );
		return url;

	} );
	vi.spyOn( URL, 'revokeObjectURL' ).mockImplementation( () => {} );

}

describe( 'export choices', () => {

	it( 'prices a video in bits a pixel a frame by quality, high when unknown', () => {

		expect( videoBitrate( 1920, 1080, 30 ) ).toBe( 12441600 );
		expect( videoBitrate( 1920, 1080, 30, 'standard' ) ).toBe( 6220800 );
		expect( videoBitrate( 1920, 1080, 60, 'best' ) ).toBe( 49766400 );
		expect( videoBitrate( 1920, 1080, 30, 'ultra' ) ).toBe( 12441600 );

	} );

	it( 'sorts formats by what they can carry', () => {

		const formats = [ 'png', 'jpeg', 'webp', 'heic', 'avif', 'exr', 'hdr' ];
		expect( formats.filter( holdsLight ) ).toEqual( [ 'exr', 'hdr' ] );
		expect( formats.filter( takesGainMap ) ).toEqual( [ 'jpeg', 'heic', 'avif' ] );
		expect( formats.filter( isLossy ) ).toEqual( [ 'jpeg', 'webp', 'heic', 'avif' ] );
		expect( [ 'mp4', 'webm', 'png', 'exr' ].filter( isFrameSequence ) ).toEqual( [ 'png', 'exr' ] );

	} );

	it( 'names frames in order, padded to at least four digits', () => {

		expect( frameName( 0, 10, 'png' ) ).toBe( 'frame-0001.png' );
		expect( frameName( 4, 12345, 'exr' ) ).toBe( 'frame-00005.exr' );
		expect( frameName( 99999, 100000, 'png' ) ).toBe( 'frame-100000.png' );

	} );

	it( 'stamps a file name with the local date and time', () => {

		expect( fileStem( 'animation', new Date( 2026, 0, 2, 3, 4, 5 ) ) ).toBe( 'animation-20260102-030405' );
		expect( fileStem( undefined, new Date( 2026, 11, 31, 23, 59, 58 ) ) ).toBe( 'render-20261231-235958' );

	} );

	it( 'offers a folder only where the browser has the picker', () => {

		vi.stubGlobal( 'window', {} );
		expect( canPickFolder() ).toBe( false );
		vi.stubGlobal( 'window', { showDirectoryPicker: () => {} } );
		expect( canPickFolder() ).toBe( true );
		vi.unstubAllGlobals();

	} );

} );

describe( 'readVideoSettings', () => {

	afterEach( () => vi.unstubAllGlobals() );

	const storage = value => vi.stubGlobal( 'localStorage', { getItem: vi.fn( key => ( key === VIDEO_SETTINGS_KEY ? value : null ) ) } );

	it( 'lays the remembered choices over the defaults', () => {

		storage( JSON.stringify( { format: 'webm', fps: 60 } ) );
		expect( readVideoSettings() ).toEqual( { ...DEFAULT_VIDEO, format: 'webm', fps: 60 } );

	} );

	it( 'falls back to the defaults when nothing, or nothing readable, is stored', () => {

		storage( null );
		expect( readVideoSettings() ).toEqual( DEFAULT_VIDEO );
		storage( '{not json' );
		expect( readVideoSettings() ).toEqual( DEFAULT_VIDEO );
		vi.stubGlobal( 'localStorage', { getItem: () => {

			throw new Error( 'denied' );

		} } );
		const settings = readVideoSettings();
		expect( settings ).toEqual( DEFAULT_VIDEO );
		expect( settings ).not.toBe( DEFAULT_VIDEO );

	} );

} );

describe( 'downloadBlob', () => {

	afterEach( () => {

		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'clicks a link to the blob and frees its URL a minute later', () => {

		vi.useFakeTimers();
		stubDocument();
		const blob = new Blob( [ 'x' ] );

		downloadBlob( blob, 'a.png' );

		expect( downloads ).toEqual( [ { name: 'a.png', url: 'blob:test/0' } ] );
		expect( blobOf( 'blob:test/0' ) ).toBe( blob );
		vi.advanceTimersByTime( 59_999 );
		expect( URL.revokeObjectURL ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 1 );
		expect( URL.revokeObjectURL ).toHaveBeenCalledWith( 'blob:test/0' );

	} );

} );

describe( 'exportPicture', () => {

	let app;

	beforeEach( () => {

		vi.useFakeTimers( { now: new Date( 2026, 9, 28, 9, 5, 2 ) } );
		stubDocument();
		app = {
			isInitialized: true,
			exportInfo: vi.fn( () => ( { hdr: true } ) ),
			exportImage: vi.fn( async () => ( { blob: new Blob( [ 'p' ] ), extension: 'jpg', gainMap: true } ) ),
		};
		setApp( app );

	} );

	afterEach( () => {

		setApp( null );
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	const options = { format: 'jpeg', bitDepth: 8, quality: 0.8, hdr: true, precision: 'half', asShown: true, passes: [ 'depth' ], upscaled: false };

	it( 'refuses before the renderer has started', async () => {

		setApp( null );
		await expect( exportPicture( options ) ).rejects.toThrow( 'The renderer has not started yet.' );

	} );

	it( 'downloads the engine\'s file under a dated name', async () => {

		const result = await exportPicture( options );

		expect( app.exportImage ).toHaveBeenCalledWith( { format: 'jpeg', bitDepth: 8, quality: 0.8, gainMap: true, precision: 'half', asShown: true, passes: [], upscaled: false } );
		expect( result ).toMatchObject( { name: 'render-20261028-090502.jpg', extension: 'jpg', gainMap: true } );
		expect( downloads.map( d => d.name ) ).toEqual( [ 'render-20261028-090502.jpg' ] );

	} );

	it( 'asks for a gain map only for a format that takes one, when wanted and the picture has HDR', async () => {

		const gainMapFor = async ( patch, info = { hdr: true } ) => {

			app.exportInfo = info ? () => info : undefined;
			await exportPicture( { ...options, ...patch } );
			return app.exportImage.mock.lastCall[ 0 ].gainMap;

		};

		expect( await gainMapFor( {} ) ).toBe( true );
		expect( await gainMapFor( { format: 'avif' } ) ).toBe( true );
		expect( await gainMapFor( { hdr: false } ) ).toBe( false );
		expect( await gainMapFor( { format: 'png' } ) ).toBe( false );
		expect( await gainMapFor( {}, { hdr: false } ) ).toBe( false );
		expect( await gainMapFor( {}, null ) ).toBe( false );

	} );

	it( 'passes the extra layers only to a scene-referred EXR', async () => {

		const passesFor = async patch => {

			await exportPicture( { ...options, ...patch } );
			return app.exportImage.mock.lastCall[ 0 ].passes;

		};

		expect( await passesFor( { format: 'exr', asShown: false } ) ).toEqual( [ 'depth' ] );
		expect( await passesFor( { format: 'exr', asShown: true } ) ).toEqual( [] );
		expect( await passesFor( { format: 'png', asShown: false } ) ).toEqual( [] );

	} );

} );

describe( 'exportSavedRender', () => {

	let canvas;

	beforeEach( () => {

		stubDocument();
		canvas = { width: 4, height: 2, toBlob: vi.fn( ( callback, type ) => callback( new Blob( [ 'pixels' ], { type } ) ) ) };
		database.getRenderHDR.mockReset();
		encodeHDR.mockClear();
		encodeStill.mockClear();

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'encodes the picture through the canvas for PNG, JPEG and WebP', async () => {

		expect( await exportSavedRender( { id: 3, canvas, format: 'jpeg', quality: 0.7 } ) ).toBe( 'render-3.jpg' );
		expect( canvas.toBlob ).toHaveBeenLastCalledWith( expect.any( Function ), 'image/jpeg', 0.7 );

		expect( await exportSavedRender( { id: 3, canvas, format: 'png' } ) ).toBe( 'render-3.png' );
		expect( canvas.toBlob ).toHaveBeenLastCalledWith( expect.any( Function ), 'image/png', 0.92 );

		expect( await exportSavedRender( { id: 3, canvas, format: 'webp' } ) ).toBe( 'render-3.webp' );
		expect( downloads.map( d => d.name ) ).toEqual( [ 'render-3.jpg', 'render-3.png', 'render-3.webp' ] );
		expect( blobOf( downloads[ 2 ].url ).type ).toBe( 'image/webp' );
		expect( database.getRenderHDR ).not.toHaveBeenCalled();

	} );

	it( 'rejects when the canvas cannot encode the picture', async () => {

		canvas.toBlob = callback => callback( null );
		await expect( exportSavedRender( { id: 3, canvas, format: 'webp' } ) ).rejects.toThrow( 'The picture could not be encoded.' );
		expect( downloads ).toEqual( [] );

	} );

	it( 'flattens the picture into pixels for HEIC and AVIF', async () => {

		const data = new Uint8ClampedArray( 4 * 2 * 4 ).fill( 7 );
		const context = { drawImage: vi.fn(), getImageData: vi.fn( () => ( { data } ) ) };
		vi.stubGlobal( 'OffscreenCanvas', class {

			constructor( width, height ) {

				Object.assign( this, { width, height } );

			}

			getContext( kind ) {

				return kind === '2d' ? context : null;

			}

		} );

		expect( await exportSavedRender( { id: 9, canvas, format: 'avif', quality: 0.5 } ) ).toBe( 'render-9.avif' );
		expect( context.drawImage ).toHaveBeenCalledWith( canvas, 0, 0 );
		expect( context.getImageData ).toHaveBeenCalledWith( 0, 0, 4, 2 );
		expect( encodeStill ).toHaveBeenCalledWith( { format: 'avif', sdr: data, width: 4, height: 2, quality: 0.5 } );

		expect( await exportSavedRender( { id: 9, canvas, format: 'heic' } ) ).toBe( 'render-9.heic' );
		expect( encodeStill ).toHaveBeenLastCalledWith( expect.objectContaining( { format: 'heic', quality: 0.92 } ) );
		expect( canvas.toBlob ).not.toHaveBeenCalled();
		expect( downloads.map( d => d.name ) ).toEqual( [ 'render-9.avif', 'render-9.heic' ] );

	} );

	it( 'hands over the kept EXR as it was saved', async () => {

		const exr = new Blob( [ 'exr' ] );
		database.getRenderHDR.mockResolvedValue( exr );

		expect( await exportSavedRender( { id: 5, canvas, format: 'exr' } ) ).toBe( 'render-5.exr' );
		expect( database.getRenderHDR ).toHaveBeenCalledWith( 5 );
		expect( blobOf( downloads[ 0 ].url ) ).toBe( exr );
		expect( encodeHDR ).not.toHaveBeenCalled();

	} );

	it( 'refuses a full-range format for a render saved without its EXR', async () => {

		database.getRenderHDR.mockResolvedValue( null );
		await expect( exportSavedRender( { id: 5, format: 'exr' } ) ).rejects.toThrow( 'This render was saved without its full-range copy.' );
		await expect( exportSavedRender( { id: 5, format: 'hdr' } ) ).rejects.toThrow( 'saved without its full-range copy' );
		expect( downloads ).toEqual( [] );

	} );

	it( 'converts the kept EXR to Radiance HDR, top row first', async () => {

		const width = 2, height = 3;
		const rgba = new Float32Array( width * height * 4 ).map( ( _, i ) => i + 0.5 );
		const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data: rgba, stride: 4, offset, type: 'float' } ) );
		database.getRenderHDR.mockResolvedValue( await encodeEXR( { width, height, channels, compression: 'none' } ) );

		expect( await exportSavedRender( { id: 6, format: 'hdr' } ) ).toBe( 'render-6.hdr' );

		const [ { data, width: w, height: h } ] = encodeHDR.mock.calls[ 0 ];
		expect( [ w, h ] ).toEqual( [ width, height ] );
		expect( Array.from( data ) ).toEqual( Array.from( rgba ) );
		expect( blobOf( downloads[ 0 ].url ) ).toBe( await encodeHDR.mock.results[ 0 ].value );

	} );

} );

describe( 'openFrameSink', () => {

	afterEach( () => {

		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	function folderOf( files, { failWrite = null } = {} ) {

		return {
			getFileHandle: vi.fn( async ( name, options ) => ( {
				options,
				createWritable: async () => {

					const parts = [];
					const writable = {
						write: vi.fn( async blob => {

							if ( failWrite ) throw failWrite;
							parts.push( blob );

						} ),
						close: vi.fn( async () => {

							files[ name ] = parts;

						} ),
						abort: vi.fn( async () => {

							throw new Error( 'abort failed too' );

						} ),
					};
					files.writables.push( writable );
					return writable;

				},
			} ) ),
		};

	}

	it( 'writes each frame to its own file in the picked folder', async () => {

		const files = { writables: [] };
		const folder = folderOf( files );
		const sink = await openFrameSink( { folder, total: 120, extension: 'png', zipName: 'unused.zip' } );
		const frame = new Blob( [ 'f' ] );

		await sink.write( 0, frame );
		await sink.write( 119, frame );
		await sink.close();

		expect( folder.getFileHandle ).toHaveBeenCalledWith( 'frame-0001.png', { create: true } );
		expect( files[ 'frame-0001.png' ] ).toEqual( [ frame ] );
		expect( files[ 'frame-0120.png' ] ).toEqual( [ frame ] );
		await expect( sink.abort() ).resolves.toBeUndefined();

	} );

	it( 'abandons a frame whose write fails and reports the write\'s error', async () => {

		const files = { writables: [] };
		const failure = new Error( 'disk full' );
		const sink = await openFrameSink( { folder: folderOf( files, { failWrite: failure } ), total: 3, extension: 'exr' } );

		await expect( sink.write( 1, new Blob( [ 'f' ] ) ) ).rejects.toBe( failure );
		expect( files.writables[ 0 ].abort ).toHaveBeenCalled();
		expect( files.writables[ 0 ].close ).not.toHaveBeenCalled();

	} );

	it( 'zips the frames into one download without folder access', async () => {

		vi.useFakeTimers();
		vi.stubGlobal( 'window', {} );
		stubDocument();
		const sink = await openFrameSink( { folder: null, total: 2, extension: 'png', zipName: 'clip-frames.zip' } );

		await sink.write( 0, new Blob( [ 'one' ] ) );
		await sink.write( 1, new Blob( [ 'two' ] ) );
		expect( downloads ).toEqual( [] );
		await sink.close();

		expect( downloads.map( d => d.name ) ).toEqual( [ 'clip-frames.zip' ] );
		const zip = unzipSync( new Uint8Array( await blobOf( downloads[ 0 ].url ).arrayBuffer() ) );
		expect( Object.keys( zip ) ).toEqual( [ 'frame-0001.png', 'frame-0002.png' ] );
		expect( new TextDecoder().decode( zip[ 'frame-0002.png' ] ) ).toBe( 'two' );

	} );

	it( 'downloads nothing when a zipped export is aborted', async () => {

		vi.stubGlobal( 'window', {} );
		stubDocument();
		const sink = await openFrameSink( { folder: null, total: 2, extension: 'png', zipName: 'clip-frames.zip' } );

		await sink.write( 0, new Blob( [ 'one' ] ) );
		await sink.abort();

		expect( downloads ).toEqual( [] );

	} );

} );
