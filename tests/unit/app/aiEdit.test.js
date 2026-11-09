import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPrompt, featherEdges, fitArea, nearestRatio, runEdit, sizeFor } from '@/lib/aiEdit';

const ratio = ( r ) => r.w / r.h;

describe( 'picture shapes', () => {

	it( 'picks the closest shape Gemini returns', () => {

		expect( nearestRatio( 2048 / 1536 ) ).toBe( '4:3' );
		expect( nearestRatio( 2048 / 1152 ) ).toBe( '16:9' );
		expect( nearestRatio( 410 / 512 ) ).toBe( '4:5' );
		expect( nearestRatio( 1 ) ).toBe( '1:1' );
		expect( nearestRatio( 2.3 ) ).toBe( '21:9' );
		expect( nearestRatio( 0.1 ) ).toBe( '1:8' );

	} );

	it( 'grows a marked area to that shape around its centre and keeps it inside the picture', () => {

		const middle = fitArea( { x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, 1000, 1000 );
		expect( middle.ratio ).toBe( '16:9' );
		expect( ratio( middle ) ).toBeCloseTo( 16 / 9, 1 );
		expect( middle.x + middle.w / 2 ).toBeCloseTo( 500, - 1 );
		expect( middle.y + middle.h / 2 ).toBeCloseTo( 450, - 1 );

		const corner = fitArea( { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 2000, 1000 );
		expect( corner.x + corner.w ).toBe( 2000 );
		expect( corner.y + corner.h ).toBe( 1000 );

		const tall = fitArea( { x: 0, y: 0, w: 0.1, h: 1 }, 400, 1000 );
		expect( tall.h ).toBeLessThanOrEqual( 1000 );
		expect( tall.y ).toBeGreaterThanOrEqual( 0 );

	} );

	it( 'asks for the smallest size that holds the area, never above the one chosen', () => {

		expect( sizeFor( 600, '2K' ) ).toBe( '1K' );
		expect( sizeFor( 1500, '2K' ) ).toBe( '2K' );
		expect( sizeFor( 3000, '2K' ) ).toBe( '2K' );
		expect( sizeFor( 3000, '4K' ) ).toBe( '4K' );
		expect( sizeFor( 1500, '1K' ) ).toBe( '1K' );

	} );

	it( 'fades the area only where it meets the rest of the picture', () => {

		expect( featherEdges( { x: 0, y: 10, w: 500, h: 400 }, 1000, 410 ) ).toEqual( { width: 16, left: false, top: true, right: true, bottom: false } );
		expect( featherEdges( { x: 5, y: 5, w: 50, h: 50 }, 100, 100 ).width ).toBe( 4 );
		expect( featherEdges( { x: 5, y: 5, w: 4000, h: 4000 }, 9000, 9000 ).width ).toBe( 48 );

	} );

} );

describe( 'the words sent with the prompt', () => {

	it( 'adds how much may change, the marked area and the references', () => {

		expect( buildPrompt( { prompt: '  Add a cat ', scope: 'anything' } ) ).toBe( 'Add a cat' );
		const only = buildPrompt( { prompt: 'Add a cat', scope: 'only' } );
		expect( only ).toMatch( /^Add a cat\nChange only what is asked/ );
		expect( buildPrompt( { prompt: 'x', scope: 'style', part: true, references: 1 } ).split( '\n' ) ).toHaveLength( 4 );
		expect( buildPrompt( { prompt: 'x', scope: 'anything', references: 2 } ) ).toMatch( /last 2 images are references/ );

	} );

} );

describe( 'runEdit', () => {

	const drawn = [];

	class FakeCanvas {

		constructor( width, height ) {

			this.width = width;
			this.height = height;

		}

		getContext() {

			return {
				drawImage: ( ...args ) => drawn.push( { canvas: this, args } ),
				createLinearGradient: () => ( { addColorStop: () => {} } ),
				fillRect: () => {},
			};

		}

		async convertToBlob( { type } ) {

			return new Blob( [ `${this.width}x${this.height}` ], { type } );

		}

	}

	const bitmap = ( width, height ) => ( { width, height, close: vi.fn() } );
	const answer = ( text ) => new Response( JSON.stringify( { candidates: [ { content: { parts: [ { inlineData: { mimeType: 'image/jpeg', data: btoa( text ) } } ] } } ] } ) );
	let fetchMock;

	beforeEach( () => {

		drawn.length = 0;
		fetchMock = vi.fn();
		vi.stubGlobal( 'fetch', fetchMock );
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );
		vi.stubGlobal( 'createImageBitmap', async ( blob ) => {

			const [ w, h ] = ( await blob.text() ).split( 'x' ).map( Number );
			return bitmap( w, h );

		} );

	} );

	afterEach( () => vi.unstubAllGlobals() );

	it( 'sends the whole picture at most 2048 wide in its shape and keeps Gemini\'s picture', async () => {

		fetchMock.mockResolvedValue( answer( '2048x1536' ) );
		const result = await runEdit( { base: bitmap( 4096, 3072 ), prompt: 'Make it real', scope: 'only', size: '2K', key: 'K' } );

		const body = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( body.generationConfig.imageConfig ).toEqual( { aspectRatio: '4:3', imageSize: '2K' } );
		expect( atob( body.contents[ 0 ].parts[ 0 ].inlineData.data ) ).toBe( '2048x1536' );
		expect( body.contents[ 0 ].parts[ 1 ].text ).toMatch( /^Make it real\nChange only/ );
		expect( result ).toMatchObject( { width: 2048, height: 1536 } );
		expect( await result.blob.text() ).toBe( '2048x1536' );

	} );

	it( 'sends only the marked area and blends the answer back into a picture of the base\'s size', async () => {

		fetchMock.mockResolvedValue( answer( '1024x1024' ) );
		const base = bitmap( 2000, 1000 );
		const result = await runEdit( {
			base, prompt: 'Add a cup', scope: 'only', size: '2K', key: 'K',
			area: { x: 0.5, y: 0.5, w: 0.2, h: 0.4 }, references: [ new Blob( [ '3000x3000' ] ) ],
		} );

		const body = JSON.parse( fetchMock.mock.calls[ 0 ][ 1 ].body );
		expect( body.generationConfig.imageConfig ).toEqual( { aspectRatio: '1:1', imageSize: '1K' } );
		expect( body.contents[ 0 ].parts ).toHaveLength( 3 );
		expect( atob( body.contents[ 0 ].parts[ 1 ].inlineData.data ) ).toBe( '1024x1024' );
		expect( body.contents[ 0 ].parts[ 2 ].text ).toMatch( /cut out of a larger one/ );

		expect( await result.blob.text() ).toBe( '2000x1000' );
		expect( result.blob.type ).toBe( 'image/png' );
		const placed = drawn.filter( ( d ) => d.canvas.width === 2000 ).map( ( d ) => d.args.slice( 1 ) );
		expect( atob( body.contents[ 0 ].parts[ 0 ].inlineData.data ) ).toBe( '400x400' );
		expect( placed ).toEqual( [[ 0, 0 ], [ 1000, 500 ]] );

	} );

} );
