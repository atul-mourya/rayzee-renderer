import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { slicedParsePlugin } from '@/core/loaders/AssetLoader.js';

const NODES = 60;
const gltf = JSON.stringify( {
	asset: { version: '2.0' },
	cameras: [ { type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } } ],
	nodes: [
		{ name: 'root', children: Array.from( { length: NODES }, ( _, i ) => i + 1 ) },
		...Array.from( { length: NODES }, ( _, i ) => ( { name: `n${i}`, camera: 0, translation: [ i, 0, 0 ] } ) ),
	],
	scenes: [ { nodes: [ 0 ] } ],
	scene: 0,
} );

const names = ( result ) => {

	const out = [];
	result.scene.traverse( o => out.push( `${o.name}@${o.position.x}` ) );
	return out;

};

// Resolves to whether a timer ran before the parse finished: a parse that never gives the page a turn finishes first.
async function parse( loader ) {

	let ticked = false;
	setTimeout( () => ( ticked = true ), 0 );
	const result = await loader.parseAsync( gltf, '' );
	return { result, ticked };

}

describe( 'glTF parse in slices', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => {

		vi.restoreAllMocks();
		vi.unstubAllGlobals();

	} );

	it( 'builds the same scene, giving the page turns once past its budget', async () => {

		const plain = await parse( new GLTFLoader() );
		expect( plain.ticked ).toBe( false );

		let now = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => ( now += 50 ) );
		const sliced = await parse( new GLTFLoader().register( slicedParsePlugin ) );
		vi.restoreAllMocks();

		expect( sliced.ticked ).toBe( true );
		expect( names( sliced.result ) ).toEqual( names( plain.result ) );
		expect( names( plain.result ) ).toHaveLength( NODES + 2 );

	} );

	it( 'takes no turn inside its budget', async () => {

		vi.spyOn( performance, 'now' ).mockReturnValue( 0 );
		const quick = await parse( new GLTFLoader().register( slicedParsePlugin ) );
		vi.restoreAllMocks();
		expect( quick.ticked ).toBe( false );

	} );

} );
