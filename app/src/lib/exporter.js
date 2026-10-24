/**
 * The export manager behind the Export window: what each format offers, the choices it remembers, and where a file
 * goes. A picture comes from the engine's exportImage(); a saved render from the Results library; a video's frames
 * go into a folder the user picks, or into one zip where the browser has no folder access.
 */

import { getApp } from '@/lib/appProxy';
import { openSink, zipInto } from '@/lib/zipSink';
import { getRenderHDR } from '@/utils/database';

export const PICTURE_FORMATS = [
	{ value: 'png', label: 'PNG', hint: 'no quality loss, for sharing and editing' },
	{ value: 'jpeg', label: 'JPEG', hint: 'for the web and email; HDR on HDR screens' },
	{ value: 'webp', label: 'WebP', hint: 'small, keeps transparency' },
	{ value: 'heic', label: 'HEIC', hint: 'Apple\'s photo format, small; HDR on HDR screens' },
	{ value: 'avif', label: 'AVIF', hint: 'smallest; HDR on HDR screens' },
	{ value: 'exr', label: 'EXR', hint: 'all the light, for Photoshop, Nuke or Blender' },
	{ value: 'hdr', label: 'HDR', hint: 'all the light, in the older Radiance format' },
];

export const VIDEO_FORMATS = [
	{ value: 'mp4', label: 'MP4', hint: 'plays everywhere' },
	{ value: 'webm', label: 'WebM', hint: 'smaller, plays in browsers' },
	{ value: 'png', label: 'PNG frames', hint: 'a picture a frame, for video editors' },
	{ value: 'exr', label: 'EXR frames', hint: 'all the light, a file a frame' },
];

export const LAYERS = [
	{ value: 'albedo', label: 'Surface colour', tip: 'Each surface\'s own colour, without light or shadow. Compositing programs use it to relight or recolour.' },
	{ value: 'normal', label: 'Surface direction', tip: 'Which way each surface faces. Used to add light in a compositing program.' },
	{ value: 'depth', label: 'Distance', tip: 'How far each point is from the camera, for depth of field or fog added later.' },
];

export const VIDEO_CONTAINERS = Object.freeze( {
	mp4: { mimeType: 'video/mp4', extension: 'mp4' },
	webm: { mimeType: 'video/webm', extension: 'webm' },
} );

/** Bits a pixel a frame for each video quality. */
export const VIDEO_QUALITY = Object.freeze( { standard: 0.1, high: 0.2, best: 0.4 } );

export const videoBitrate = ( width, height, fps, quality = 'high' ) => Math.round( width * height * fps * ( VIDEO_QUALITY[ quality ] ?? VIDEO_QUALITY.high ) );

export const DEFAULT_PICTURE = Object.freeze( { format: 'png', bitDepth: 8, quality: 0.92, hdr: true, precision: 'half', asShown: true, passes: [], upscaled: true } );
export const DEFAULT_VIDEO = Object.freeze( { format: 'mp4', quality: 'high', fps: 30, bitDepth: 8, precision: 'half', asShown: true, passes: [] } );
export const PICTURE_SETTINGS_KEY = 'rayzee-export-picture';
export const VIDEO_SETTINGS_KEY = 'rayzee-export-video';

export const holdsLight = format => format === 'exr' || format === 'hdr';
/** Formats that can carry an HDR version beside the picture (a gain map). */
export const takesGainMap = format => format === 'jpeg' || format === 'heic' || format === 'avif';
export const isLossy = format => format === 'jpeg' || format === 'webp' || format === 'heic' || format === 'avif';
export const isFrameSequence = format => format === 'png' || format === 'exr';

export function readVideoSettings() {

	try {

		return { ...DEFAULT_VIDEO, ...JSON.parse( localStorage.getItem( VIDEO_SETTINGS_KEY ) ?? '{}' ) };

	} catch {

		return { ...DEFAULT_VIDEO };

	}

}

export function fileStem( prefix = 'render', date = new Date() ) {

	const pad = n => String( n ).padStart( 2, '0' );
	return `${prefix}-${date.getFullYear()}${pad( date.getMonth() + 1 )}${pad( date.getDate() )}-${pad( date.getHours() )}${pad( date.getMinutes() )}${pad( date.getSeconds() )}`;

}

export function downloadBlob( blob, name ) {

	const url = URL.createObjectURL( blob );
	const link = document.createElement( 'a' );
	link.href = url;
	link.download = name;
	link.click();
	setTimeout( () => URL.revokeObjectURL( url ), 60_000 );

}

/** The live render as a picture file, downloaded. @returns {Promise<Object>} exportImage's result and the file's name */
export async function exportPicture( { format, bitDepth, quality, hdr, precision, asShown, passes, upscaled } ) {

	const app = getApp();
	if ( ! app ) throw new Error( 'The renderer has not started yet.' );

	const gainMap = !! hdr && takesGainMap( format ) && !! app.exportInfo?.().hdr;
	const file = await app.exportImage( { format, bitDepth, quality, gainMap, precision, asShown, passes: format === 'exr' && ! asShown ? passes : [], upscaled } );
	const name = `${fileStem()}.${file.extension}`;
	downloadBlob( file.blob, name );
	return { ...file, name };

}

const canvasBlob = ( canvas, type, quality ) => new Promise( ( resolve, reject ) => canvas.toBlob( blob => ( blob ? resolve( blob ) : reject( new Error( 'The picture could not be encoded.' ) ) ), type, quality ) );

/**
 * A render from the Results library as a file: a picture of it (edited, as rendered, or the AI version) as PNG, JPEG
 * or WebP, or the full-range copy it kept — EXR as saved, or converted to Radiance HDR.
 * @param {{id: number, canvas?: HTMLCanvasElement, format: string, quality?: number}} options
 */
export async function exportSavedRender( { id, canvas, format, quality = 0.92 } ) {

	const { IMAGE_FORMATS, encodeHDR, encodeStill } = await import( 'rayzee/encoders' );
	const { mimeType, extension } = IMAGE_FORMATS[ format ];
	const name = `render-${id}.${extension}`;

	if ( format === 'heic' || format === 'avif' ) {

		const flat = new OffscreenCanvas( canvas.width, canvas.height );
		const ctx = flat.getContext( '2d' );
		ctx.drawImage( canvas, 0, 0 );
		const { data } = ctx.getImageData( 0, 0, canvas.width, canvas.height );
		downloadBlob( await encodeStill( { format, sdr: data, width: canvas.width, height: canvas.height, quality } ), name );
		return name;

	}

	if ( ! holdsLight( format ) ) {

		downloadBlob( await canvasBlob( canvas, mimeType, quality ), name );
		return name;

	}

	const exr = await getRenderHDR( id );
	if ( ! exr ) throw new Error( 'This render was saved without its full-range copy.' );
	if ( format === 'exr' ) {

		downloadBlob( exr, name );
		return name;

	}

	const [ { EXRLoader }, { FloatType } ] = await Promise.all( [ import( 'three/examples/jsm/loaders/EXRLoader.js' ), import( 'three' ) ] );
	const { data, width, height } = new EXRLoader().setDataType( FloatType ).parse( await exr.arrayBuffer() );
	// The loader hands rows bottom first.
	const rows = new Float32Array( data.length );
	for ( let y = 0; y < height; y ++ ) rows.set( data.subarray( ( height - 1 - y ) * width * 4, ( height - y ) * width * 4 ), y * width * 4 );
	downloadBlob( await encodeHDR( { data: rows, width, height } ), name );
	return name;

}

// ─── Frame sequences ───────────────────────────────────────────────────────────────────────────────

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

export const frameName = ( index, total, extension ) => `frame-${String( index + 1 ).padStart( Math.max( 4, String( total ).length ), '0' )}.${extension}`;

/**
 * Where a video's frames are written: the folder the user picked, or one zip downloaded at the end.
 * @returns {Promise<{write: function(number, Blob): Promise<void>, close: function(): Promise<void>, abort: function(): Promise<void>}>}
 */
export async function openFrameSink( { folder, total, extension, zipName } ) {

	if ( folder ) {

		return {
			async write( index, blob ) {

				const handle = await folder.getFileHandle( frameName( index, total, extension ), { create: true } );
				const writable = await handle.createWritable();
				try {

					await writable.write( blob );
					await writable.close();

				} catch ( error ) {

					await writable.abort().catch( () => {} );
					throw error;

				}

			},
			close: async () => {},
			abort: async () => {},
		};

	}

	const sink = await openSink( zipName, { description: 'Frames', extension: '.zip' } );
	const zip = zipInto( sink );
	return {
		write: ( index, blob ) => zip.addBlob( frameName( index, total, extension ), blob ),
		close: async () => {

			await zip.finish();
			await sink.close();

		},
		abort: () => sink.abort(),
	};

}
