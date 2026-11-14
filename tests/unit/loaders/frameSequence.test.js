import { describe, it, expect, vi } from 'vitest';
import { frameRuns, FrameSequence } from '@/core/loaders/FrameSequence.js';

describe( 'frame runs', () => {

	it( 'groups numbered files by folder, name and extension, longest first, in number order', () => {

		const runs = frameRuns( [
			'fire/fire_0010.vdb', 'fire/fire_0002.vdb', 'fire/fire_0001.vdb', 'fire/smoke_0001.vdb', 'fire/smoke_0002.vdb',
			'fire/fire_0003.VDB', 'other/fire_0001.vdb', 'sky.0001.hdr', 'sky.0002.hdr', 'sky.0003.hdr', 'lonely7.exr', 'readme.txt',
		] );
		expect( runs.map( r => r.paths.length ) ).toEqual( [ 4, 3, 2 ] );
		expect( runs[ 0 ] ).toMatchObject( { name: 'fire', extension: 'vdb', numbers: [ 1, 2, 3, 10 ] } );
		expect( runs[ 0 ].paths[ 2 ] ).toBe( 'fire/fire_0003.VDB' );
		expect( runs[ 1 ] ).toMatchObject( { name: 'sky', extension: 'hdr', paths: [ 'sky.0001.hdr', 'sky.0002.hdr', 'sky.0003.hdr' ] } );
		expect( runs[ 2 ].paths ).toEqual( [ 'fire/smoke_0001.vdb', 'fire/smoke_0002.vdb' ] );

	} );

} );

describe( 'frame sequences', () => {

	const make = ( count, options = {} ) => {

		const decoded = [];
		const released = [];
		let gate = null;
		const sequence = new FrameSequence( {
			frames: Array.from( { length: count }, ( _, i ) => async () => `bytes ${i}` ),
			decode: async ( bytes, index ) => {

				if ( gate ) await gate;
				decoded.push( index );
				return { index, bytes };

			},
			release: ( frame ) => released.push( frame.index ),
			fps: 10,
			...options,
		} );
		return { sequence, decoded, released, hold: () => {

			let open;
			gate = new Promise( r => void ( open = r ) );
			return () => {

				gate = null;
				open();

			};

		} };

	};

	it( 'hands out the frame a time falls on, once, and decodes the next ones ahead', async () => {

		const { sequence, decoded } = make( 10 );
		expect( sequence.duration ).toBe( 1 );
		expect( await sequence.seek( 0.25 ) ).toEqual( { index: 2, frame: { index: 2, bytes: 'bytes 2' } } );
		expect( await sequence.seek( 0.29 ) ).toBeNull();
		await new Promise( r => setTimeout( r, 0 ) );
		expect( decoded ).toEqual( [ 2, 3, 4 ] );
		expect( ( await sequence.seek( 0.31 ) ).index ).toBe( 3 );
		await new Promise( r => setTimeout( r, 0 ) );
		expect( decoded ).toEqual( [ 2, 3, 4, 5 ] );
		expect( ( await sequence.seek( 99 ) ).index ).toBe( 9 );

	} );

	it( 'gives up a seek a newer one overtakes', async () => {

		const { sequence, hold } = make( 10 );
		const open = hold();
		const first = sequence.seek( 0.1 );
		const second = sequence.seek( 0.5 );
		open();
		expect( await first ).toBeNull();
		expect( ( await second ).index ).toBe( 5 );
		expect( sequence.current ).toBe( 5 );

	} );

	it( 'releases frames it decoded ahead and never handed out, never one it did', async () => {

		const { sequence, released } = make( 10, { ahead: 2 } );
		await sequence.seek( 0 );
		await new Promise( r => setTimeout( r, 0 ) );
		await sequence.seek( 0.5 );
		await new Promise( r => setTimeout( r, 0 ) );
		// 0 was handed out: its owner disposes it. 1 and 2 were decoded ahead and dropped.
		expect( released.sort() ).toEqual( [ 1, 2 ] );
		await sequence.seek( 0 );
		sequence.dispose();
		await new Promise( r => setTimeout( r, 0 ) );
		// 6 and 7, decoded ahead of 5, are dropped going back to 0.
		expect( released ).toEqual( expect.arrayContaining( [ 1, 2, 6, 7 ] ) );
		expect( released ).not.toContain( 0 );
		expect( released ).not.toContain( 5 );

	} );

	it( 'starts on a frame its owner already shows, and reads a failed frame again', async () => {

		const fail = vi.fn().mockRejectedValueOnce( new Error( 'busy' ) ).mockResolvedValue( 'ok' );
		const sequence = new FrameSequence( { frames: [ async () => 0, async () => 1 ], decode: fail, fps: 1, shown: 0, ahead: 0 } );
		expect( await sequence.seek( 0 ) ).toBeNull();
		await expect( sequence.seek( 1 ) ).rejects.toThrow( 'busy' );
		expect( await sequence.seek( 1 ) ).toEqual( { index: 1, frame: 'ok' } );

	} );

} );
