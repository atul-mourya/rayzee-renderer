import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The sequence's frames decode in OpenVDBWorker, which Vitest cannot bundle: a stand-in runs the worker's own module
// in-process, one `self` per worker, its replies a task later as a worker's are.
const workers = [];
let handler = null;
class StandInWorker {

	constructor() {

		this.terminated = false;
		this.messages = [];
		this.onmessage = null;
		this.onerror = null;
		workers.push( this );

	}

	postMessage( message, transfer ) {

		this.messages.push( { message, transfer } );
		setTimeout( () => {

			if ( this.fail ) return this.onerror?.( { message: this.fail, preventDefault() {} } );
			self.postMessage = ( data ) => setTimeout( () => this.onmessage?.( { data } ) );
			handler( { data: message } );

		} );

	}

	terminate() {

		this.terminated = true;

	}

}

vi.mock( '@/core/loaders/OpenVDBWorker.js?worker&inline', () => ( { default: StandInWorker } ) );

const fixture = ( name ) => readFileSync( new URL( `fixtures/vdb/${name}`, import.meta.url ) );
const names = [ 1, 2, 3, 4 ].map( ( n ) => `seq_000${n}` );
const sumOf = ( grid ) => grid.data.reduce( ( a, b ) => a + b, 0 );

describe( 'an OpenVDB run decoded in its worker', () => {

	let volumeSequenceFromOpenVDB;
	beforeAll( async () => {

		vi.stubGlobal( 'Worker', StandInWorker );
		vi.stubGlobal( 'self', {} );
		await import( '@/core/loaders/OpenVDBWorker.js' );
		handler = self.onmessage;
		( { volumeSequenceFromOpenVDB } = await import( '@/core/loaders/OpenVDBSequence.js' ) );

	} );
	afterAll( () => vi.unstubAllGlobals() );
	afterEach( () => vi.useRealTimers() );

	const open = async () => ( await volumeSequenceFromOpenVDB( names.map( ( n ) => async () => fixture( `${n}.vdb` ) ), { name: 'ball', fps: 12 } ) ).children[ 0 ];

	it( 'reads each frame there as on the page, its bytes handed over, not copied', async () => {

		const volume = await open();
		for ( let k = 1; k < 4; k ++ ) {

			const { frame } = await volume.sequence.seek( k / 12 );
			volume.setFrame( frame );
			expect( sumOf( volume.grid ) ).toBeCloseTo( JSON.parse( fixture( `${names[ k ]}-openvdb.json` ) )[ 0 ].sum, 3 );
			expect( volume.grid.transform.isMatrix4 ).toBe( true );

		}

		const sent = workers.flatMap( ( w ) => w.messages );
		expect( sent.length ).toBeGreaterThanOrEqual( 3 );
		for ( const { message, transfer } of sent ) expect( transfer ).toEqual( [ message.bytes ] );

	} );

	it( 'rejects a frame the worker cannot read with its message, and reads the next', async () => {

		const volume = await open();
		const sequence = volume.sequence;
		const real = handler;
		handler = () => self.postMessage( { error: 'not an OpenVDB file' } );
		await expect( sequence.seek( 2 / 12 ) ).rejects.toThrow( 'not an OpenVDB file' );
		handler = real;
		const { frame } = await sequence.seek( 3 / 12 );
		volume.setFrame( frame );
		expect( sumOf( volume.grid ) ).toBeCloseTo( JSON.parse( fixture( `${names[ 3 ]}-openvdb.json` ) )[ 0 ].sum, 3 );

	} );

	it( 'drops a worker that fails, and lets an idle one go after two seconds', async () => {

		const volume = await open();
		const sequence = volume.sequence;
		const worker = workers[ workers.length - 1 ];
		worker.fail = 'out of memory';
		await expect( sequence.seek( 1 / 12 ) ).rejects.toThrow( 'OpenVDB worker failed: out of memory' );
		expect( worker.terminated ).toBe( true );

		await sequence.seek( 2 / 12 );
		const next = workers[ workers.length - 1 ];
		expect( next ).not.toBe( worker );
		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync( 1900 );
		expect( next.terminated ).toBe( false );
		await vi.advanceTimersByTimeAsync( 200 );
		expect( next.terminated ).toBe( true );

	} );

} );
