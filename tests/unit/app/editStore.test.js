import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock( '@/lib/database', () => ( { updateRender: vi.fn( async () => true ) } ) );

const render = { id: 7, colorCorrection: { brightness: 10, contrast: 0, saturation: 0, hue: 0, exposure: 0 } };
const other = { id: 8, edits: { geometry: { quarterTurns: 1 }, adjust: { saturation: - 20 } } };

let useEditStore, canUndo, canRedo, updateRender, now;

beforeEach( async () => {

	vi.resetModules();
	vi.useFakeTimers();
	now = 1000;
	vi.spyOn( performance, 'now' ).mockImplementation( () => now );
	( { useEditStore, canUndo, canRedo } = await import( '@/store/edits.js' ) );
	( { updateRender } = await import( '@/lib/database' ) );
	updateRender.mockClear();
	useEditStore.getState().open( render );

} );

afterEach( () => {

	vi.useRealTimers();
	vi.restoreAllMocks();

} );

const state = () => useEditStore.getState();

describe( 'the Results edits store', () => {

	it( 'opens a render from before the stack with its Adjust values', () => {

		expect( state().renderId ).toBe( 7 );
		expect( state().edits.adjust.brightness ).toBe( 10 );
		expect( canUndo( state() ) ).toBe( false );

	} );

	it( 'makes one slider drag one undo step, and two drags two', () => {

		for ( const v of [ 11, 12, 13 ] ) {

			state().change( 'adjust', { brightness: v } );
			now += 16;

		}

		now += 1000;
		state().change( 'adjust', { brightness: 20 } );
		expect( state().history[ 7 ].past.map( e => e.adjust.brightness ) ).toEqual( [ 10, 13 ] );

		state().undo();
		expect( state().edits.adjust.brightness ).toBe( 13 );
		state().undo();
		expect( state().edits.adjust.brightness ).toBe( 10 );
		expect( canUndo( state() ) ).toBe( false );
		state().redo();
		expect( state().edits.adjust.brightness ).toBe( 13 );
		expect( canRedo( state() ) ).toBe( true );
		state().change( 'adjust', { contrast: 5 } );
		expect( canRedo( state() ) ).toBe( false );

	} );

	it( 'saves 300 ms after the last change, with the Adjust values an older build reads', async () => {

		state().change( 'adjust', { hue: 30 } );
		vi.advanceTimersByTime( 200 );
		state().change( 'adjust', { hue: 40 } );
		vi.advanceTimersByTime( 200 );
		expect( updateRender ).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync( 150 );
		expect( updateRender ).toHaveBeenCalledTimes( 1 );
		const [ id, patch ] = updateRender.mock.calls[ 0 ];
		expect( id ).toBe( 7 );
		expect( patch.edits.adjust.hue ).toBe( 40 );
		expect( patch.colorCorrection ).toEqual( patch.edits.adjust );
		expect( patch.isEdited ).toBe( true );

	} );

	it( 'keeps each render\'s edits and history through the session', () => {

		state().change( 'detail', { sharpen: 0.5 } );
		state().open( other );
		expect( state().edits.adjust.saturation ).toBe( - 20 );
		expect( canUndo( state() ) ).toBe( false );
		state().open( render );
		expect( state().edits.detail.sharpen ).toBe( 0.5 );
		expect( canUndo( state() ) ).toBe( true );

	} );

	it( 'makes a crop one undo step when kept, and nothing when cancelled', () => {

		const start = state().edits.geometry;
		state().startCrop();
		state().setGeometry( { ...start, angle: 3 }, 'angle' );
		now += 2000;
		state().setGeometry( { ...state().edits.geometry, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }, 'crop' );
		state().finishCrop();
		expect( state().cropping ).toBeNull();
		expect( state().history[ 7 ].past ).toHaveLength( 1 );
		expect( state().edits.geometry.angle ).toBe( 3 );

		state().startCrop();
		state().setGeometry( { ...state().edits.geometry, angle: - 8 }, 'angle' );
		state().cancelCrop();
		expect( state().edits.geometry.angle ).toBe( 3 );
		expect( state().history[ 7 ].past ).toHaveLength( 1 );
		state().undo();
		expect( state().edits.geometry ).toEqual( start );

	} );

	it( 'pastes onto another render without its own geometry changing', async () => {

		state().change( 'look', { id: 'film' }, null );
		state().copy( render );
		state().paste( other );
		await vi.advanceTimersByTimeAsync( 400 );
		const saved = updateRender.mock.calls.find( ( [ id ] ) => id === 8 )[ 1 ].edits;
		expect( saved.look.id ).toBe( 'film' );
		expect( saved.adjust.brightness ).toBe( 10 );
		expect( saved.geometry.quarterTurns ).toBe( 1 );
		state().open( other );
		expect( state().edits.look.id ).toBe( 'film' );
		state().undo();
		expect( state().edits.look.id ).toBeNull();

	} );

	it( 'resets a tab\'s sections only', () => {

		state().change( 'detail', { clarity: 0.3 } );
		state().setEffect( 'vignette', { amount: - 0.4 } );
		state().reset( [ 'detail', 'effects' ] );
		expect( state().edits.detail.clarity ).toBe( 0 );
		expect( state().edits.effects.vignette.amount ).toBe( 0 );
		expect( state().edits.adjust.brightness ).toBe( 10 );

	} );

} );
