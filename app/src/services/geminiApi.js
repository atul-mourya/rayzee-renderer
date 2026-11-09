const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-nano-banana-2.1';

// The shapes the model returns (`generationConfig.imageConfig.aspectRatio`).
export const ASPECT_RATIOS = [ '1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', '4:1', '1:4', '8:1', '1:8' ];

const DECLINED = new Set( [ 'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_RECITATION' ] );

/** kind: 'key' | 'quota' | 'declined' | 'network' | 'no-image' | 'aborted' | 'other'. */
export class GeminiError extends Error {

	constructor( kind, message, { retryAfter = null, text = '' } = {} ) {

		super( message );
		this.name = 'GeminiError';
		this.kind = kind;
		this.retryAfter = retryAfter;
		this.text = text;

	}

}

async function call( url, init ) {

	try {

		return await fetch( url, init );

	} catch ( error ) {

		if ( error?.name === 'AbortError' ) throw new GeminiError( 'aborted', 'Cancelled' );
		throw new GeminiError( 'network', 'Could not reach Google' );

	}

}

function retrySeconds( error ) {

	const info = error?.details?.find( d => d[ '@type' ]?.endsWith( 'RetryInfo' ) );
	const delay = parseFloat( info?.retryDelay ?? '' );
	if ( Number.isFinite( delay ) ) return delay;
	const match = error?.message?.match( /retry in ([\d.]+)\s*s/i );
	return match ? parseFloat( match[ 1 ] ) : null;

}

async function failure( reply ) {

	const error = ( await reply.json().catch( () => null ) )?.error ?? {};
	const message = error.message || `Google answered ${reply.status}`;
	const reason = error.details?.find( d => d.reason )?.reason;

	if ( reason === 'API_KEY_INVALID' || reply.status === 401 || reply.status === 403 ) return new GeminiError( 'key', message );
	if ( reply.status === 429 || error.status === 'RESOURCE_EXHAUSTED' ) return new GeminiError( 'quota', message, { retryAfter: retrySeconds( error ) } );
	return new GeminiError( 'other', message );

}

/** Whether Google accepts the key, by asking for the model's details (no image is made). */
export async function checkKey( key, { signal } = {} ) {

	const reply = await call( `${MODELS_URL}/${GEMINI_MODEL}`, { headers: { 'x-goog-api-key': key }, signal } );
	if ( ! reply.ok ) throw await failure( reply );
	return true;

}

/**
 * One image edit.
 * @param {{key: string, image: {mimeType: string, data: string}, references?: Array<{mimeType: string, data: string}>,
 *   prompt: string, aspectRatio?: string, imageSize?: string, signal?: AbortSignal}} request base64 images
 * @returns {Promise<{blob: Blob, text: string}>}
 */
export async function generateImage( { key, image, references = [], prompt, aspectRatio, imageSize, signal } ) {

	const parts = [ image, ...references ].map( inlineData => ( { inlineData } ) );
	parts.push( { text: prompt } );

	const imageConfig = {};
	if ( aspectRatio ) imageConfig.aspectRatio = aspectRatio;
	if ( imageSize ) imageConfig.imageSize = imageSize;

	const reply = await call( `${MODELS_URL}/${GEMINI_MODEL}:generateContent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
		body: JSON.stringify( { contents: [ { role: 'user', parts } ], generationConfig: { responseModalities: [ 'IMAGE', 'TEXT' ], imageConfig } } ),
		signal,
	} );
	if ( ! reply.ok ) throw await failure( reply );

	let response;
	try {

		response = await reply.json();

	} catch ( error ) {

		if ( error?.name === 'AbortError' ) throw new GeminiError( 'aborted', 'Cancelled' );
		throw new GeminiError( 'network', 'The answer from Google was cut off' );

	}

	const blocked = response.promptFeedback?.blockReason;
	if ( blocked ) throw new GeminiError( 'declined', blocked );

	const candidate = response.candidates?.[ 0 ];
	let data = null;
	let text = '';
	// Thought parts carry drafts; the last image outside them is the answer.
	for ( const part of candidate?.content?.parts ?? [] ) {

		if ( part.thought ) continue;
		if ( part.inlineData?.data ) data = part.inlineData;
		else if ( part.text ) text += part.text;

	}

	if ( ! data ) {

		if ( DECLINED.has( candidate?.finishReason ) ) throw new GeminiError( 'declined', candidate.finishReason, { text } );
		throw new GeminiError( 'no-image', 'No picture came back', { text } );

	}

	const bytes = Uint8Array.from( atob( data.data ), c => c.charCodeAt( 0 ) );
	return { blob: new Blob( [ bytes ], { type: data.mimeType || 'image/png' } ), text: text.trim() };

}
