import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbInPlace, decodersOnDemand } from '@/core/loaders/GLTFDecoders.js';

// A .glb of two meshes: one indexed, one with positions and normals interleaved in one view.
function makeGLB( { taggedIndices = false } = {} ) {

	const bin = new Uint8Array( 116 );
	new Float32Array( bin.buffer, 0, 9 ).set( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
	new Uint16Array( bin.buffer, 36, 3 ).set( [ 0, 1, 2 ] );
	new Float32Array( bin.buffer, 44, 18 ).set( [ 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 1 ] );

	const json = {
		asset: { version: '2.0' },
		buffers: [ { byteLength: bin.byteLength } ],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36 },
			{ buffer: 0, byteOffset: 36, byteLength: 6, ...( taggedIndices ? { extensions: { EXT_unknown_view: {} } } : {} ) },
			{ buffer: 0, byteOffset: 44, byteLength: 72, byteStride: 24 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] },
			{ bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
			{ bufferView: 2, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 2, 2, 0 ] },
			{ bufferView: 2, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' },
		],
		meshes: [
			{ primitives: [ { attributes: { POSITION: 0 }, indices: 1 } ] },
			{ primitives: [ { attributes: { POSITION: 2, NORMAL: 3 } } ] },
		],
		nodes: [ { name: 'indexed', mesh: 0 }, { name: 'interleaved', mesh: 1, translation: [ 5, 0, 0 ] } ],
		scenes: [ { nodes: [ 0, 1 ] } ],
		scene: 0,
	};

	const text = new TextEncoder().encode( JSON.stringify( json ) );
	const jsonLength = Math.ceil( text.length / 4 ) * 4;
	const out = new ArrayBuffer( 28 + jsonLength + bin.byteLength );
	const view = new DataView( out ), bytes = new Uint8Array( out );
	view.setUint32( 0, 0x46546C67, true );
	view.setUint32( 4, 2, true );
	view.setUint32( 8, out.byteLength, true );
	view.setUint32( 12, jsonLength, true );
	view.setUint32( 16, 0x4E4F534A, true );
	bytes.fill( 0x20, 20, 20 + jsonLength );
	bytes.set( text, 20 );
	view.setUint32( 20 + jsonLength, bin.byteLength, true );
	view.setUint32( 24 + jsonLength, 0x004E4942, true );
	bytes.set( bin, 28 + jsonLength );
	return out;

}

const meshes = ( gltf ) => {

	const out = [];
	gltf.scene.traverse( o => o.isMesh && out.push( {
		name: o.parent?.name || o.name,
		positions: Array.from( { length: o.geometry.attributes.position.count }, ( _, i ) => o.geometry.attributes.position.getX( i ) + ',' + o.geometry.attributes.position.getY( i ) ).join( ' ' ),
		normals: o.geometry.attributes.normal ? Array.from( { length: 3 }, ( _, i ) => o.geometry.attributes.normal.getZ( i ) ).join() : null,
		index: o.geometry.index ? [ ...o.geometry.index.array ].join() : null,
	} ) );
	return out;

};

// The bytes ArrayBuffer.slice copies while `run` parses.
async function copied( run ) {

	const slice = vi.spyOn( ArrayBuffer.prototype, 'slice' );
	const result = await run();
	const bytes = slice.mock.results.reduce( ( sum, r ) => sum + r.value.byteLength, 0 );
	slice.mockRestore();
	return { result, bytes };

}

describe( 'a .glb parsed in place', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterEach( () => vi.restoreAllMocks() );
	afterAll( () => vi.unstubAllGlobals() );

	it( 'builds what three builds, copying each view once and the binary chunk never', async () => {

		const plain = await copied( () => new GLTFLoader().parseAsync( makeGLB(), '' ) );
		const inPlace = await copied( () => glbInPlace( new GLTFLoader() ).parseAsync( makeGLB(), '' ) );

		expect( meshes( inPlace.result ) ).toEqual( meshes( plain.result ) );
		expect( meshes( plain.result ).map( m => m.index ) ).toEqual( [ '0,1,2', null ] );
		expect( inPlace.bytes ).toBe( 36 + 6 + 72 );
		expect( plain.bytes ).toBeGreaterThanOrEqual( 116 + inPlace.bytes );

	} );

	it( 'hands a view it does not read itself to three, which gets the chunk copied once', async () => {

		const plain = await new GLTFLoader().parseAsync( makeGLB( { taggedIndices: true } ), '' );
		const inPlace = await copied( () => glbInPlace( new GLTFLoader() ).parseAsync( makeGLB( { taggedIndices: true } ), '' ) );

		expect( meshes( inPlace.result ) ).toEqual( meshes( plain ) );
		expect( inPlace.bytes ).toBe( 116 + 36 + 6 + 72 );

	} );

	it( 'leaves a .gltf and a damaged .glb to three, failing as three fails', async () => {

		const text = JSON.stringify( { asset: { version: '2.0' }, scenes: [ { nodes: [] } ], scene: 0 } );
		const gltf = await glbInPlace( new GLTFLoader() ).parseAsync( text, '' );
		expect( gltf.scene.children ).toHaveLength( 0 );

		const damaged = makeGLB().slice( 0, 60 );
		const failure = ( loader ) => loader.parseAsync( damaged.slice( 0 ), '' ).then( () => 'loaded', ( error ) => error.message );
		expect( await failure( glbInPlace( new GLTFLoader() ) ) ).toBe( await failure( new GLTFLoader() ) );

	} );

	it( 'leaves a glTF 1.0 .glb, and one whose JSON is not an object, to three, failing as three fails', async () => {

		const failure = ( loader, data ) => loader.parseAsync( data, '' ).then( () => 'loaded', ( error ) => error.message );
		const version1 = makeGLB();
		new DataView( version1 ).setUint32( 4, 1, true );
		expect( await failure( glbInPlace( new GLTFLoader() ), version1.slice( 0 ) ) ).toBe( await failure( new GLTFLoader(), version1.slice( 0 ) ) );

		// A JSON chunk of `42 `: valid JSON, no glTF.
		const scalar = makeGLB();
		const view = new DataView( scalar );
		new Uint8Array( scalar, 20, view.getUint32( 12, true ) ).fill( 0x20 ).set( [ 0x34, 0x32 ] );
		const inPlace = await failure( glbInPlace( new GLTFLoader() ), scalar.slice( 0 ) );
		expect( inPlace ).not.toBe( 'loaded' );
		expect( inPlace ).toBe( await failure( new GLTFLoader(), scalar.slice( 0 ) ) );

	} );

} );

describe( 'decodersOnDemand', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	const failure = ( data ) => decodersOnDemand( new GLTFLoader(), null ).parseAsync( data, '' ).then( () => 'loaded', ( error ) => error );

	it( 'says a web page or a file that is no glTF plainly, the parser\'s error kept as the cause', async () => {

		const page = await failure( '<!doctype html><html><body>Not found</body></html>' );
		expect( page.message ).toMatch( /gave a web page, not a 3D model/ );
		expect( page.cause ).toBeInstanceOf( SyntaxError );
		const junk = await failure( new TextEncoder().encode( 'solid cube\nfacet normal 0 0 1' ).buffer );
		expect( junk.message ).toMatch( /not a glTF model/ );

	} );

	it( 'reads a parsed glTF\'s extensions from the object itself, importing a decoder only for one it names', async () => {

		const loader = decodersOnDemand( new GLTFLoader(), null );
		const asset = ( used ) => ( { asset: { version: '2.0' }, extensionsUsed: used, scenes: [ { nodes: [] } ], scene: 0 } );
		await loader.parseAsync( asset( [] ), '' );
		expect( loader.meshoptDecoder ).toBeFalsy();
		await loader.parseAsync( asset( [ 'EXT_meshopt_compression' ] ), '' );
		expect( loader.meshoptDecoder?.supported ).toBeDefined();

	} );

} );
