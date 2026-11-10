import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkKey, generateImage, GeminiError } from '@/services/geminiApi';

const MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1';

const reply = ( body, status = 200 ) => new Response( JSON.stringify( body ), { status, headers: { 'content-type': 'application/json' } } );
const image = { mimeType: 'image/jpeg', data: 'BBBB' };

async function failureOf( promise ) {

	try {

		await promise;

	} catch ( error ) {

		return error;

	}

	throw new Error( 'expected a failure' );

}

let fetchMock;

beforeEach( () => {

	fetchMock = vi.fn();
	vi.stubGlobal( 'fetch', fetchMock );

} );

afterEach( () => vi.unstubAllGlobals() );

describe( 'generateImage', () => {

	it( 'asks for the shape and size, sends references after the picture, and reads the image past thought parts', async () => {

		fetchMock.mockResolvedValue( reply( { candidates: [ { finishReason: 'STOP', content: { parts: [
			{ text: 'draft', thought: true },
			{ inlineData: { mimeType: 'image/png', data: btoa( 'DRAFT' ) }, thought: true },
			{ text: 'Done.' },
			{ inlineData: { mimeType: 'image/jpeg', data: btoa( 'FINAL' ) } },
		] } } ] } ) );

		const result = await generateImage( { key: 'K', image, references: [ { mimeType: 'image/png', data: 'RRRR' } ], prompt: 'a red chair', aspectRatio: '4:3', imageSize: '2K' } );

		const [ url, init ] = fetchMock.mock.calls[ 0 ];
		expect( url ).toBe( `${MODEL_URL}:generateContent` );
		expect( init.headers ).toEqual( { 'Content-Type': 'application/json', 'x-goog-api-key': 'K' } );
		expect( JSON.parse( init.body ) ).toEqual( {
			contents: [ { role: 'user', parts: [ { inlineData: image }, { inlineData: { mimeType: 'image/png', data: 'RRRR' } }, { text: 'a red chair' } ] } ],
			generationConfig: { responseModalities: [ 'IMAGE', 'TEXT' ], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } },
		} );
		expect( result.text ).toBe( 'Done.' );
		expect( result.blob.type ).toBe( 'image/jpeg' );
		expect( await result.blob.text() ).toBe( 'FINAL' );

	} );

	it( 'decodes every byte value, with or without Uint8Array.fromBase64', async () => {

		const bytes = Uint8Array.from( { length: 256 }, ( _, i ) => i );
		const data = btoa( String.fromCharCode( ...bytes ) );
		const native = Object.getOwnPropertyDescriptor( Uint8Array, 'fromBase64' );

		try {

			for ( const fromBase64 of [ undefined, vi.fn( ( text ) => Uint8Array.from( atob( text ), c => c.charCodeAt( 0 ) ) ) ] ) {

				Object.defineProperty( Uint8Array, 'fromBase64', { value: fromBase64, configurable: true, writable: true } );
				fetchMock.mockResolvedValue( reply( { candidates: [ { finishReason: 'STOP', content: { parts: [ { inlineData: { mimeType: 'image/png', data } } ] } } ] } ) );
				const { blob } = await generateImage( { key: 'K', image, prompt: 'x' } );
				expect( new Uint8Array( await blob.arrayBuffer() ) ).toEqual( bytes );
				if ( fromBase64 ) expect( fromBase64 ).toHaveBeenCalledWith( data );

			}

		} finally {

			if ( native ) Object.defineProperty( Uint8Array, 'fromBase64', native );
			else delete Uint8Array.fromBase64;

		}

	} );

	it( 'names each failure so the panel can say it plainly', async () => {

		const run = () => failureOf( generateImage( { key: 'K', image, prompt: 'x' } ) );

		fetchMock.mockResolvedValueOnce( reply( { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [ { reason: 'API_KEY_INVALID' } ] } }, 400 ) );
		expect( await run() ).toMatchObject( { kind: 'key' } );

		fetchMock.mockResolvedValueOnce( reply( { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED', details: [ { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' } ] } }, 429 ) );
		expect( await run() ).toMatchObject( { kind: 'quota', retryAfter: 37 } );

		fetchMock.mockResolvedValueOnce( reply( { error: { code: 429, message: 'Quota exceeded. Please retry in 12.5s.', status: 'RESOURCE_EXHAUSTED' } }, 429 ) );
		expect( await run() ).toMatchObject( { kind: 'quota', retryAfter: 12.5 } );

		fetchMock.mockResolvedValueOnce( reply( { promptFeedback: { blockReason: 'SAFETY' } } ) );
		expect( await run() ).toMatchObject( { kind: 'declined' } );

		fetchMock.mockResolvedValueOnce( reply( { candidates: [ { finishReason: 'IMAGE_SAFETY', content: { parts: [] } } ] } ) );
		expect( await run() ).toMatchObject( { kind: 'declined' } );

		fetchMock.mockResolvedValueOnce( reply( { candidates: [ { finishReason: 'STOP', content: { parts: [ { text: 'I cannot draw that.' } ] } } ] } ) );
		expect( await run() ).toMatchObject( { kind: 'no-image', text: 'I cannot draw that.' } );

		fetchMock.mockResolvedValueOnce( reply( { error: { code: 500, message: 'Internal error' } }, 500 ) );
		expect( await run() ).toMatchObject( { kind: 'other', message: 'Internal error' } );

		fetchMock.mockRejectedValueOnce( new TypeError( 'Failed to fetch' ) );
		expect( await run() ).toMatchObject( { kind: 'network' } );

		fetchMock.mockRejectedValueOnce( new DOMException( 'The user aborted a request.', 'AbortError' ) );
		const aborted = await run();
		expect( aborted ).toBeInstanceOf( GeminiError );
		expect( aborted.kind ).toBe( 'aborted' );

	} );

} );

describe( 'checkKey', () => {

	it( 'asks for the model with the key and says when Google refuses it', async () => {

		fetchMock.mockResolvedValueOnce( reply( { name: 'models/gemini-nano-banana-2.1' } ) );
		expect( await checkKey( 'GOOD' ) ).toBe( true );
		expect( fetchMock.mock.calls[ 0 ][ 0 ] ).toBe( MODEL_URL );
		expect( fetchMock.mock.calls[ 0 ][ 1 ].headers ).toEqual( { 'x-goog-api-key': 'GOOD' } );

		fetchMock.mockResolvedValueOnce( reply( { error: { code: 400, message: 'API key not valid.', details: [ { reason: 'API_KEY_INVALID' } ] } }, 400 ) );
		expect( await failureOf( checkKey( 'BAD' ) ) ).toMatchObject( { kind: 'key' } );

	} );

} );
