import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { geminiImageGenerator } from '@/services/geminiApi';

const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent';

const reply = ( body, status = 200 ) => new Response( JSON.stringify( body ), { status, headers: { 'content-type': 'application/json' } } );

let fetchMock;

beforeEach( async () => {

	fetchMock = vi.fn();
	vi.stubGlobal( 'fetch', fetchMock );
	await geminiImageGenerator.initialize( 'TEST_KEY' );

} );

afterEach( () => vi.unstubAllGlobals() );

describe( 'geminiImageGenerator', () => {

	it( 'sends the request the Gemini SDK sent, and reads the image past thought parts', async () => {

		fetchMock.mockResolvedValue( reply( { candidates: [ { content: { parts: [
			{ text: 'draft', thought: true },
			{ inlineData: { mimeType: 'image/png', data: 'DRAFT' }, thought: true },
			{ text: 'Done.' },
			{ inlineData: { mimeType: 'image/png', data: 'AAAA' } },
		] } } ] } ) );

		const result = await geminiImageGenerator.generateImage( 'a red chair', 'data:image/jpeg;base64,BBBB' );

		const [ url, init ] = fetchMock.mock.calls[ 0 ];
		expect( url ).toBe( URL );
		expect( init.method ).toBe( 'POST' );
		expect( init.headers ).toEqual( { 'Content-Type': 'application/json', 'x-goog-api-key': 'TEST_KEY' } );
		expect( JSON.parse( init.body ) ).toEqual( {
			contents: [ { role: 'user', parts: [
				{ inlineData: { data: 'BBBB', mimeType: 'image/jpeg' } },
				{ text: 'Based on this image, a red chair. Generate a modified version of this image.' },
			] } ],
			generationConfig: { responseModalities: [ 'IMAGE', 'TEXT' ] },
		} );
		expect( result ).toEqual( { success: true, text: 'Done.', imageUrl: 'data:image/png;base64,AAAA' } );

	} );

	it( 'reports a quota error with its retry delay', async () => {

		fetchMock.mockResolvedValue( reply( { error: { code: 429, message: 'Quota exceeded. Please retry in 37.2s.', status: 'RESOURCE_EXHAUSTED' } }, 429 ) );

		const result = await geminiImageGenerator.generateImage( 'a lamp' );

		expect( result ).toMatchObject( { success: false, quotaError: true, retryAfter: 37.2 } );

	} );

	it( 'passes other errors and an image-less reply through as failures', async () => {

		vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		fetchMock.mockResolvedValueOnce( reply( { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }, 400 ) );
		fetchMock.mockResolvedValueOnce( reply( { candidates: [ { content: { parts: [ { text: 'I cannot draw that.' } ] } } ] } ) );

		const bad = await geminiImageGenerator.generateImage( 'a lamp' );
		expect( bad.success ).toBe( false );
		expect( bad.error ).toContain( 'API key not valid.' );

		const empty = await geminiImageGenerator.generateImage( 'a lamp' );
		expect( empty ).toEqual( { success: false, error: 'No image data received from Gemini' } );

	} );

} );
