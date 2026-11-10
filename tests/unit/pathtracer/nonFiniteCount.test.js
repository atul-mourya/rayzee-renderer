/**
 * The non-finite sample count: FinalWrite adds to a GPU total that frame 0 zeroes, and the stage reads differences of
 * it, announcing the first of a render once. A readback issued before a frame 0 belongs to the render before.
 */
import { describe, it, expect, vi } from 'vitest';
import { PathTracer } from '@/core/pathtracer/PathTracer.js';
import { COUNTER } from '@/core/pathtracer/QueueManager.js';

const counters = total => {

	const words = new Uint32Array( COUNTER.COUNT );
	words[ COUNTER.NON_FINITE_SAMPLES ] = total;
	return words.buffer;

};

function makeStage() {

	return Object.assign( Object.create( PathTracer.prototype ), {
		_nonFiniteSeen: 0,
		_nonFiniteSinceReset: 0,
		_nonFiniteEpoch: 1,
		issues: { warn: vi.fn() },
	} );

}

const announced = stage => stage.issues.warn.mock.calls.filter( ( [ code ] ) => code === 'render.non_finite_samples' ).map( ( [ , , detail ] ) => detail.count );

describe( 'non-finite sample count', () => {

	it( 'announces the first samples of a render once, and keeps counting the rest', () => {

		const stage = makeStage();
		stage._noteNonFinite( counters( 0 ), 1 );
		expect( announced( stage ) ).toEqual( [] );

		stage._noteNonFinite( counters( 5 ), 1 );
		stage._noteNonFinite( counters( 12 ), 1 );
		stage._noteNonFinite( counters( 12 ), 1 );
		expect( announced( stage ) ).toEqual( [ 5 ] );
		expect( stage._nonFiniteSinceReset ).toBe( 12 );

	} );

	it( 'drops a readback issued before the render\'s frame 0', () => {

		const stage = makeStage();
		stage._noteNonFinite( counters( 7 ), 1 );
		// Frame 0 of the next render: the GPU total starts again.
		Object.assign( stage, { _nonFiniteEpoch: 2, _nonFiniteSeen: 0, _nonFiniteSinceReset: 0 } );
		stage._noteNonFinite( counters( 9 ), 1 );
		expect( stage._nonFiniteSinceReset ).toBe( 0 );
		stage._noteNonFinite( counters( 3 ), 2 );
		expect( announced( stage ) ).toEqual( [ 7, 3 ] );

	} );

	it( 'reads a smaller total as a new counters buffer, which starts from zero', () => {

		const stage = makeStage();
		stage._noteNonFinite( counters( 40 ), 1 );
		stage._noteNonFinite( counters( 6 ), 1 );
		expect( stage._nonFiniteSinceReset ).toBe( 46 );

	} );

	it( 'reads the count on demand, for a render shorter than the readback cadence', async () => {

		const stage = makeStage();
		stage._queueManager = { getCountersAttribute: () => 'counters' };
		stage.renderer = { getArrayBufferAsync: vi.fn( async () => counters( 4 ) ) };
		await stage.readNonFiniteNow();
		expect( stage.renderer.getArrayBufferAsync ).toHaveBeenCalledWith( 'counters', null, 0, COUNTER.COUNT * 4 );
		expect( announced( stage ) ).toEqual( [ 4 ] );

		// No counters yet: nothing to read.
		stage._queueManager = null;
		await expect( stage.readNonFiniteNow() ).resolves.toBeUndefined();

	} );

} );
