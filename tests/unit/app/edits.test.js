import { describe, it, expect } from 'vitest';
import {
	DEFAULT_EDITS, adjustColor, constrainCrop, cropForAspect, effectiveCrop, flipGeometry, hasEdits,
	lookColor, lookTable, LOOKS, LOOK_SIZE, normaliseEdits, outputSize, pasteEdits, readEdits, sameEdits, shapeAspect, shapeOf,
	sourceTransform, turnQuarter,
} from '@/lib/edits';

const plain = normaliseEdits().geometry;
const at = ( m, u, v ) => [ m[ 0 ] * u + m[ 1 ] * v + m[ 2 ], m[ 3 ] * u + m[ 4 ] * v + m[ 5 ] ];
const close = ( a, b ) => a.forEach( ( v, i ) => expect( v ).toBeCloseTo( b[ i ], 9 ) );
const W = 400, H = 200;
// Whether every corner of the edited picture reads the picture itself, none of what lies outside it.
const onlyPicture = geometry => {

	const m = sourceTransform( geometry, W, H );
	return [[ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ]].every( ( [ u, v ] ) => at( m, u, v ).every( c => c > - 1e-9 && c < 1 + 1e-9 ) );

};

describe( 'the edit stack', () => {

	it( 'reads a render from before it: its Adjust values, everything else at the defaults', () => {

		const edits = readEdits( { colorCorrection: { brightness: 10, contrast: 0, saturation: 0, hue: 0, exposure: 5 } } );
		expect( edits.adjust ).toEqual( { ...DEFAULT_EDITS.adjust, brightness: 10, exposure: 5 } );
		expect( edits.geometry ).toEqual( DEFAULT_EDITS.geometry );
		expect( edits.effects ).toEqual( DEFAULT_EDITS.effects );
		// The old store's starting gamma was 0, which divides by zero.
		expect( readEdits( { colorCorrection: { gamma: 0 } } ).adjust.gamma ).toBe( 2.2 );
		expect( readEdits( {} ) ).toEqual( normaliseEdits() );

	} );

	it( 'prefers the stack a newer render carries', () => {

		const edits = readEdits( { colorCorrection: { brightness: 50 }, edits: { adjust: { brightness: 3 }, look: { id: 'warm' } } } );
		expect( edits.adjust.brightness ).toBe( 3 );
		expect( edits.look ).toEqual( { id: 'warm', amount: 1 } );

	} );

	it( 'says whether anything would change the picture', () => {

		expect( hasEdits( {} ) ).toBe( false );
		expect( hasEdits( { look: { id: 'warm', amount: 0 } } ) ).toBe( false );
		expect( hasEdits( { overlay: { text: '  ' } } ) ).toBe( false );
		for ( const edits of [ { adjust: { hue: 4 } }, { look: { id: 'mono' } }, { geometry: { flipY: true } }, { effects: { grain: { amount: 0.1 } } }, { overlay: { text: '© me' } } ] ) {

			expect( hasEdits( edits ) ).toBe( true );

		}

	} );

	it( 'pastes everything but the geometry, which stays the target\'s', () => {

		const source = normaliseEdits( { adjust: { contrast: 20 }, geometry: { flipX: true }, detail: { sharpen: 0.4 } } );
		const target = normaliseEdits( { geometry: { quarterTurns: 1 }, adjust: { contrast: - 5 } } );
		const pasted = pasteEdits( target, source );
		expect( pasted.adjust.contrast ).toBe( 20 );
		expect( pasted.detail.sharpen ).toBe( 0.4 );
		expect( pasted.geometry ).toEqual( target.geometry );
		expect( sameEdits( pasted, { ...source, geometry: target.geometry } ) ).toBe( true );

	} );

} );

describe( 'the geometry', () => {

	it( 'reads the picture as it is when nothing is set', () => {

		expect( sourceTransform( plain, W, H ) ).toEqual( [ 1, 0, 0, 0, 1, 0 ] );
		expect( outputSize( plain, W, H ) ).toEqual( { width: W, height: H } );

	} );

	it( 'turns a quarter as seen: the left edge goes to the top', () => {

		const right = turnQuarter( plain, 1 );
		expect( outputSize( right, W, H ) ).toEqual( { width: H, height: W } );
		const m = sourceTransform( right, W, H );
		close( at( m, 0, 0 ), [ 0, 1 ] );
		close( at( m, 1, 0 ), [ 0, 0 ] );
		close( at( m, 1, 1 ), [ 1, 0 ] );

	} );

	it( 'comes back after four turns, a turn each way, or two flips', () => {

		const cropped = { ...plain, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 }, aspect: 2 };
		let g = cropped;
		for ( let i = 0; i < 4; i ++ ) g = turnQuarter( g, 1 );
		close( Object.values( g.crop ), Object.values( cropped.crop ) );
		expect( g.quarterTurns ).toBe( 0 );
		expect( g.aspect ).toBeCloseTo( 2, 9 );
		const back = turnQuarter( turnQuarter( cropped, 1 ), - 1 );
		close( Object.values( back.crop ), Object.values( cropped.crop ) );
		const twice = flipGeometry( flipGeometry( cropped, 'x' ), 'x' );
		expect( twice.flipX ).toBe( false );
		close( Object.values( twice.crop ), Object.values( cropped.crop ) );

	} );

	it( 'turns what is seen, a flipped picture included', () => {

		// Flipped left to right, then turned right: the top-left shows what was the flipped picture's bottom-left.
		const g = turnQuarter( flipGeometry( plain, 'x' ), 1 );
		const m = sourceTransform( g, W, H );
		close( at( m, 0, 0 ), [ 1, 1 ] );
		close( at( m, 1, 0 ), [ 1, 0 ] );

	} );

	it( 'keeps the crop on the same part of the picture when it turns or flips', () => {

		const g = { ...plain, crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } };
		const middle = geometry => at( sourceTransform( geometry, W, H ), 0.5, 0.5 );
		close( middle( turnQuarter( g, 1 ) ), middle( g ) );
		close( middle( turnQuarter( g, - 1 ) ), middle( g ) );
		close( middle( flipGeometry( g, 'x' ) ), middle( g ) );
		close( middle( flipGeometry( g, 'y' ) ), middle( g ) );

	} );

	it( 'shrinks the crop while straightening, keeping its shape, so no corner is empty', () => {

		const tilted = { ...plain, angle: 10 };
		const crop = effectiveCrop( tilted, W, H );
		expect( crop.w * W / ( crop.h * H ) ).toBeCloseTo( W / H, 6 );
		expect( crop.w ).toBeLessThan( 1 );
		expect( onlyPicture( tilted ) ).toBe( true );

		// Straight again, the crop is whole again.
		expect( effectiveCrop( { ...tilted, angle: 0 }, W, H ) ).toEqual( { x: 0, y: 0, w: 1, h: 1 } );

	} );

	it( 'fits a crop whose middle lies outside the straightened picture', () => {

		const g = { ...plain, angle: 30, crop: { x: 0.9, y: 0, w: 0.1, h: 0.1 } };
		expect( onlyPicture( g ) ).toBe( true );
		expect( effectiveCrop( g, W, H ).w ).toBeGreaterThan( 0 );

	} );

	it( 'stops a dragged crop at the picture\'s edge', () => {

		const from = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
		const moved = constrainCrop( from, { ...from, x: 0.8 }, 0, W, H );
		expect( moved.x ).toBeCloseTo( 0.6, 4 );
		const tilted = constrainCrop( from, { x: 0, y: 0, w: 1, h: 1 }, 15, W, H );
		expect( onlyPicture( { ...plain, angle: 15, crop: tilted } ) ).toBe( true );
		expect( tilted.w ).toBeGreaterThan( from.w );

	} );

	it( 'crops to a shape, in pixels, about the current crop', () => {

		const square = cropForAspect( plain, 1, W, H );
		expect( square.crop ).toEqual( { x: 0.25, y: 0, w: 0.5, h: 1 } );
		expect( outputSize( square, W, H ) ).toEqual( { width: 200, height: 200 } );
		expect( shapeOf( square, W, H ) ).toBe( '1:1' );
		const original = cropForAspect( turnQuarter( plain, 1 ), shapeAspect( 'original', turnQuarter( plain, 1 ), W, H ), W, H );
		expect( shapeOf( original, W, H ) ).toBe( 'original' );
		expect( cropForAspect( square, null, W, H ) ).toMatchObject( { aspect: null, crop: square.crop } );

	} );

	it( 'shows the whole turned frame while the crop is edited', () => {

		const g = { ...plain, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, quarterTurns: 1 };
		expect( outputSize( g, W, H, { editing: true } ) ).toEqual( { width: H, height: W } );
		expect( outputSize( g, W, H ) ).toEqual( { width: 100, height: 200 } );

	} );

} );

describe( 'the CPU twins of the colour stages', () => {

	it( 'changes nothing at the Adjust defaults', () => {

		for ( const c of [[ 0.2, 0.5, 0.9 ], [ 2.5, 1, 0.1 ], [ - 0.05, 0.4, 0.4 ]] ) close( adjustColor( c, {} ), c );

	} );

	it( 'bakes every look into a table of the right size, black and white grey', () => {

		for ( const { id } of LOOKS ) expect( lookTable( id ).length ).toBe( LOOK_SIZE ** 3 * 4 );
		const [ r, g, b ] = lookColor( [ 0.8, 0.3, 0.1 ], lookTable( 'mono' ) );
		expect( r ).toBeCloseTo( g, 6 );
		expect( g ).toBeCloseTo( b, 6 );
		expect( lookTable( 'warm' ) ).toBe( lookTable( 'warm' ) );

	} );

	it( 'mixes a look in by its amount, and carries a colour past white', () => {

		const table = lookTable( 'warm' );
		close( lookColor( [ 0.4, 0.5, 0.6 ], table, 0 ), [ 0.4, 0.5, 0.6 ] );
		const half = lookColor( [ 0.4, 0.5, 0.6 ], table, 0.5 ), full = lookColor( [ 0.4, 0.5, 0.6 ], table, 1 );
		close( half, [ ( 0.4 + full[ 0 ] ) / 2, ( 0.5 + full[ 1 ] ) / 2, ( 0.6 + full[ 2 ] ) / 2 ] );
		const bright = lookColor( [ 2, 2, 2 ], table );
		expect( Math.max( ...bright ) ).toBeGreaterThan( 1.5 );
		expect( bright[ 0 ] ).toBeGreaterThan( bright[ 2 ] );

	} );

} );
