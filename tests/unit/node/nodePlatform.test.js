import { describe, it, expect, afterEach } from 'vitest';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { XMLDOMParser } from '@/core/node/XMLDOMParser.js';

// Stands in for the `webgpu` package's queue: records what reaches Dawn.
function installQueue() {

	const calls = [];
	class GPUQueue {

		writeBuffer( buffer, bufferOffset, data, dataOffset, size ) {

			calls.push( { kind: 'buffer', buffer, bufferOffset, data, dataOffset, size } );

		}

		writeTexture( destination, data, layout, size ) {

			calls.push( { kind: 'texture', destination, data, layout, size } );

		}

	}

	globalThis.GPUQueue = GPUQueue;
	return { queue: new GPUQueue(), calls };

}

const bytesOf = ( view ) => new Uint8Array( view.buffer, view.byteOffset, view.byteLength );

afterEach( () => {

	delete globalThis.GPUQueue;

} );

describe( 'nodePlatform', () => {

	it( 'asks for the webgpu globals before anything else', () => {

		expect( () => nodePlatform() ).toThrow( /install the webgpu globals first/ );

	} );

	it( 'hands over the worker class, the decoder, a file reader and a DOMParser', () => {

		installQueue();
		const decodeImage = async () => ( {} );
		const platform = nodePlatform( { decodeImage } );
		expect( platform.Worker ).toBe( NodeWorker );
		expect( platform.decodeImage ).toBe( decodeImage );
		expect( typeof platform.readFile ).toBe( 'function' );
		expect( platform.DOMParser ).toBe( XMLDOMParser );
		expect( nodePlatform().decodeImage ).toBeNull();
		expect( new ProgressEvent( 'progress', { lengthComputable: true, loaded: 3, total: 9 } ) ).toMatchObject( { type: 'progress', loaded: 3, total: 9 } );

	} );

	it( 'passes ordinary uploads through untouched', () => {

		const { queue, calls } = installQueue();
		nodePlatform();
		const data = new Float32Array( 8 );
		queue.writeBuffer( 'b', 16, data, 2, 4 );
		queue.writeTexture( 't', data, { bytesPerRow: 32 }, [ 2, 1 ] );
		expect( calls[ 0 ] ).toMatchObject( { bufferOffset: 16, data, dataOffset: 2, size: 4 } );
		expect( calls[ 1 ].data ).toBe( data );

	} );

	it( 'copies a shared upload out, reading its offset and size in elements, its bytes for a bare buffer', () => {

		const { queue, calls } = installQueue();
		nodePlatform();
		const shared = new SharedArrayBuffer( 64 );
		new Uint8Array( shared ).forEach( ( _, i, a ) => void ( a[ i ] = i ) );
		const floats = new Float32Array( shared, 8, 12 ); // bytes 8..55

		queue.writeBuffer( 'b', 100, floats, 2, 3 ); // elements 2..4 → bytes 16..27
		queue.writeBuffer( 'b', 200, floats, 9 ); // elements 9..11 → bytes 44..55
		queue.writeBuffer( 'b', 300, shared, 60 ); // a bare buffer: bytes 60..63

		const got = calls.map( c => ( { at: c.bufferOffset, shared: c.data.buffer instanceof SharedArrayBuffer, bytes: [ ...bytesOf( c.data ) ] } ) );
		expect( got ).toEqual( [
			{ at: 100, shared: false, bytes: [ ...Array( 12 ).keys() ].map( i => 16 + i ) },
			{ at: 200, shared: false, bytes: [ ...Array( 12 ).keys() ].map( i => 44 + i ) },
			{ at: 300, shared: false, bytes: [ 60, 61, 62, 63 ] },
		] );

	} );

	it( 'sends a large shared upload 64 MB at a time, each piece where it belongs', () => {

		const { queue, calls } = installQueue();
		nodePlatform();
		const MB = 2 ** 20;
		const shared = new SharedArrayBuffer( 64 * MB + 1024 );
		const view = new Uint8Array( shared );
		view[ 0 ] = 7;
		view[ 64 * MB - 1 ] = 8;
		view[ 64 * MB ] = 9;
		view[ 64 * MB + 1023 ] = 10;

		queue.writeBuffer( 'b', 4096, view );
		expect( calls.map( c => [ c.bufferOffset, c.data.byteLength ] ) ).toEqual( [[ 4096, 64 * MB ], [ 4096 + 64 * MB, 1024 ]] );
		expect( [ calls[ 0 ].data[ 0 ], calls[ 0 ].data[ 64 * MB - 1 ], calls[ 1 ].data[ 0 ], calls[ 1 ].data[ 1023 ] ] ).toEqual( [ 7, 8, 9, 10 ] );

	} );

	it( 'copies a shared texture upload whole, so the layout\'s offsets still hold', () => {

		const { queue, calls } = installQueue();
		nodePlatform();
		const shared = new SharedArrayBuffer( 32 );
		new Uint8Array( shared ).forEach( ( _, i, a ) => void ( a[ i ] = i ) );
		const layout = { offset: 4, bytesPerRow: 8 };
		queue.writeTexture( 't', new Uint8Array( shared, 8, 16 ), layout, [ 2, 1 ] );

		expect( calls[ 0 ].data.buffer instanceof SharedArrayBuffer ).toBe( false );
		expect( [ ...calls[ 0 ].data ] ).toEqual( [ ...Array( 16 ).keys() ].map( i => 8 + i ) );
		expect( calls[ 0 ].layout ).toBe( layout );

	} );

	it( 'wraps the queue once however often it is called', () => {

		const { queue, calls } = installQueue();
		nodePlatform();
		const wrapped = [ GPUQueue.prototype.writeBuffer, GPUQueue.prototype.writeTexture ];
		nodePlatform();
		expect( [ GPUQueue.prototype.writeBuffer, GPUQueue.prototype.writeTexture ] ).toEqual( wrapped );
		queue.writeBuffer( 'b', 0, new Uint8Array( new SharedArrayBuffer( 8 ) ) );
		expect( calls ).toHaveLength( 1 );

	} );

} );
