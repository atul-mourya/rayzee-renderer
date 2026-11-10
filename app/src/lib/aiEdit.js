// aiEdit.js — one AI version of a saved render: the picture to send, the words around the prompt, and a marked
// area blended back into the picture.
import { ASPECT_RATIOS, generateImage } from '@/services/geminiApi';

export const SCOPES = [
	{ value: 'only', label: 'Only what I ask', hint: 'Shapes, objects and camera stay as rendered.' },
	{ value: 'style', label: 'Style too', hint: 'Light, colour and look may change; objects and camera stay.' },
	{ value: 'anything', label: 'Anything', hint: 'Gemini may change whatever the prompt needs.' },
];

const SCOPE_WORDS = {
	only: 'Change only what is asked. Keep every other object, shape, material and colour, the composition and the camera exactly as they are.',
	style: 'The light, colours and look may change, but keep the objects, their shapes, the composition and the camera.',
	anything: '',
};

export const IDEAS = [
	{ label: 'Make it look real', text: 'Make it look like a real photograph.' },
	{ label: 'Add things around it', text: 'Add ' },
	{ label: 'New background', text: 'Replace the background with ' },
	{ label: 'Change the light', text: 'Change the light to ' },
	{ label: 'Change a material', text: 'Make the ' },
	{ label: 'Restyle', text: 'Restyle the picture as ' },
	{ label: 'Remove something', text: 'Remove the ' },
];

export const SIZES = [
	{ value: '1K', label: '1K, fastest' },
	{ value: '2K', label: '2K' },
	{ value: '4K', label: '4K' },
];

export const MAX_REFERENCES = 4;

const SIZE_PIXELS = { '1K': 1024, '2K': 2048, '4K': 4096 };
const UPLOAD_EDGE = 2048;
const REFERENCE_EDGE = 1024;

const ratioOf = label => {

	const [ w, h ] = label.split( ':' ).map( Number );
	return w / h;

};

/** The shape Gemini can return that is closest to `width / height`. */
export function nearestRatio( value ) {

	let best = ASPECT_RATIOS[ 0 ];
	for ( const label of ASPECT_RATIOS ) {

		if ( Math.abs( Math.log( ratioOf( label ) / value ) ) < Math.abs( Math.log( ratioOf( best ) / value ) ) ) best = label;

	}

	return best;

}

/**
 * A marked area (fractions of the picture) grown to a shape Gemini returns, kept inside the picture.
 * @returns {{x: number, y: number, w: number, h: number, ratio: string}} pixels
 */
export function fitArea( area, width, height ) {

	let w = area.w * width;
	let h = area.h * height;
	const cx = ( area.x + area.w / 2 ) * width;
	const cy = ( area.y + area.h / 2 ) * height;
	const ratio = nearestRatio( w / h );
	const r = ratioOf( ratio );
	if ( w / h < r ) w = h * r;
	else h = w / r;

	const fit = Math.min( 1, width / w, height / h );
	w = Math.max( 1, Math.round( w * fit ) );
	h = Math.max( 1, Math.round( h * fit ) );
	const x = Math.round( Math.min( Math.max( cx - w / 2, 0 ), width - w ) );
	const y = Math.round( Math.min( Math.max( cy - h / 2, 0 ), height - h ) );
	return { x, y, w, h, ratio };

}

/** The smallest size that holds `edge` pixels, no larger than the one chosen. */
export function sizeFor( edge, chosen ) {

	return Object.keys( SIZE_PIXELS ).find( s => SIZE_PIXELS[ s ] >= edge && SIZE_PIXELS[ s ] <= SIZE_PIXELS[ chosen ] ) ?? chosen;

}

export function buildPrompt( { prompt, scope, part = false, references = 0 } ) {

	return [
		prompt.trim(),
		SCOPE_WORDS[ scope ] ?? '',
		part ? 'This picture is cut out of a larger one and goes back in its place, so keep its edges as they are.' : '',
		references === 1 ? 'The second image is a reference for this change.' : '',
		references > 1 ? `The last ${references} images are references for this change.` : '',
	].filter( Boolean ).join( '\n' );

}

async function toBase64( blob ) {

	const bytes = new Uint8Array( await blob.arrayBuffer() );
	let text = '';
	for ( let i = 0; i < bytes.length; i += 0x8000 ) text += String.fromCharCode( ...bytes.subarray( i, i + 0x8000 ) );
	return btoa( text );

}

async function encode( source, x, y, w, h, edge ) {

	const scale = Math.min( 1, edge / Math.max( w, h ) );
	const canvas = new OffscreenCanvas( Math.max( 1, Math.round( w * scale ) ), Math.max( 1, Math.round( h * scale ) ) );
	canvas.getContext( '2d' ).drawImage( source, x, y, w, h, 0, 0, canvas.width, canvas.height );
	return { mimeType: 'image/jpeg', data: await toBase64( await canvas.convertToBlob( { type: 'image/jpeg', quality: 0.92 } ) ) };

}

/** The edges of `rect` inside the picture fade over `width` pixels; edges on the picture's border stay hard. */
export function featherEdges( rect, width, height ) {

	return {
		width: Math.round( Math.min( 48, Math.max( 4, Math.min( rect.w, rect.h ) * 0.04 ) ) ),
		left: rect.x > 0,
		top: rect.y > 0,
		right: rect.x + rect.w < width,
		bottom: rect.y + rect.h < height,
	};

}

async function composite( base, rect, result ) {

	const { width, height } = base;
	const patch = new OffscreenCanvas( rect.w, rect.h );
	const p = patch.getContext( '2d' );
	p.drawImage( result, 0, 0, rect.w, rect.h );

	const edges = featherEdges( rect, width, height );
	const f = edges.width;
	p.globalCompositeOperation = 'destination-in';
	const fade = ( x0, y0, x1, y1 ) => {

		const g = p.createLinearGradient( x0, y0, x1, y1 );
		g.addColorStop( 0, 'rgba(0,0,0,0)' );
		g.addColorStop( 1, 'rgba(0,0,0,1)' );
		p.fillStyle = g;
		p.fillRect( 0, 0, rect.w, rect.h );

	};

	if ( edges.left ) fade( 0, 0, f, 0 );
	if ( edges.right ) fade( rect.w, 0, rect.w - f, 0 );
	if ( edges.top ) fade( 0, 0, 0, f );
	if ( edges.bottom ) fade( 0, rect.h, 0, rect.h - f );

	const out = new OffscreenCanvas( width, height );
	const o = out.getContext( '2d' );
	o.drawImage( base, 0, 0 );
	o.drawImage( patch, rect.x, rect.y );
	return out.convertToBlob( { type: 'image/png' } );

}

/**
 * Makes one AI version of a picture.
 * @param {{base: ImageBitmap, prompt: string, scope: string, area?: {x: number, y: number, w: number, h: number},
 *   references?: Blob[], size: string, key: string, signal?: AbortSignal}} job `area` in fractions of the picture
 * @returns {Promise<{blob: Blob, width: number, height: number, text: string}>}
 */
export async function runEdit( { base, prompt, scope, area = null, references = [], size, key, signal } ) {

	const { width, height } = base;
	const rect = area ? fitArea( area, width, height ) : { x: 0, y: 0, w: width, h: height, ratio: nearestRatio( width / height ) };

	const image = await encode( base, rect.x, rect.y, rect.w, rect.h, UPLOAD_EDGE );
	const refs = [];
	for ( const blob of references ) {

		const bitmap = await createImageBitmap( blob );
		refs.push( await encode( bitmap, 0, 0, bitmap.width, bitmap.height, REFERENCE_EDGE ) );
		bitmap.close();

	}

	const { blob, text } = await generateImage( {
		key, image, references: refs, signal,
		prompt: buildPrompt( { prompt, scope, part: !! area, references: refs.length } ),
		aspectRatio: rect.ratio,
		imageSize: area ? sizeFor( Math.max( rect.w, rect.h ), size ) : size,
	} );

	const result = await createImageBitmap( blob );
	try {

		if ( ! area ) return { blob, width: result.width, height: result.height, text };
		return { blob: await composite( base, rect, result ), width, height, text };

	} finally {

		result.close();

	}

}
