import { describe, it, expect, vi } from 'vitest';
import { ACESFilmicToneMapping, DataUtils, LinearSRGBColorSpace, NoToneMapping, SRGBColorSpace, Texture } from 'three';
import { EditPipeline, hdrShowsPicture } from '@/lib/ImageProcessor';
import { lookTable, sourceTransform, normaliseEdits } from '@/lib/edits';

// What the pipeline asks of a renderer, recorded: each draw's target and how it is set to write.
function fakeRenderer( width = 1, height = 1 ) {

	const r = { toneMapping: ACESFilmicToneMapping, outputColorSpace: SRGBColorSpace, size: { width, height }, target: null, draws: [] };
	r.getSize = v => v.set( r.size.width, r.size.height );
	r.setSize = vi.fn( ( w, h ) => {

		r.size = { width: w, height: h };

	} );
	r.setRenderTarget = t => {

		r.target = t;

	};

	r.render = () => r.draws.push( { target: r.target, toneMapping: r.toneMapping, colorSpace: r.outputColorSpace } );
	return r;

}

const picture = ( width, height ) => ( { texture: new Texture(), width, height, light: false } );

describe( 'EditPipeline', () => {

	it( 'takes the panel\'s percentages as fractions, hue in degrees and gamma as it is', () => {

		const pipeline = new EditPipeline();
		pipeline.set( { adjust: { brightness: 50, contrast: - 20, saturation: 10, hue: 30, exposure: 100, gamma: 1.8 }, detail: { sharpen: 0.4, clarity: - 0.2 } } );
		const u = pipeline._u;
		expect( [ u.brightness.value, u.contrast.value, u.saturation.value, u.hue.value, u.exposure.value, u.gamma.value ] ).toEqual( [ 0.5, - 0.2, 0.1, 30, 1, 1.8 ] );
		expect( [ u.sharpen.value, u.clarity.value ] ).toEqual( [ 0.4, - 0.2 ] );

	} );

	it( 'starts with every edit off', () => {

		const u = new EditPipeline()._u;
		expect( [ u.brightness.value, u.contrast.value, u.saturation.value, u.hue.value, u.exposure.value, u.gamma.value ] ).toEqual( [ 0, 0, 0, 0, 0, 2.2 ] );
		expect( [ u.lookAmount.value, u.sharpen.value, u.clarity.value, u.vignette.value.x, u.grain.value.x ] ).toEqual( [ 0, 0, 0, 0, 0 ] );

	} );

	it( 'loads a look\'s table at half precision, and reads none at amount 0', () => {

		const pipeline = new EditPipeline();
		pipeline.set( { look: { id: 'mono', amount: 0.7 } } );
		const table = lookTable( 'mono' );
		const halves = pipeline._table.image.data;
		for ( const i of [ 0, 4000, table.length - 4 ] ) expect( DataUtils.fromHalfFloat( halves[ i ] ) ).toBeCloseTo( table[ i ], 3 );
		expect( pipeline._u.lookAmount.value ).toBe( 0.7 );
		pipeline.set( { look: { id: 'mono', amount: 0 } } );
		expect( pipeline._u.lookAmount.value ).toBe( 0 );
		pipeline.set( {} );
		expect( pipeline._u.lookAmount.value ).toBe( 0 );

	} );

	it( 'turns the vignette\'s size and softness into the edges it fades between', () => {

		const pipeline = new EditPipeline();
		pipeline.set( { effects: { vignette: { amount: - 0.5, size: 1, softness: 0 } } } );
		const v = pipeline._u.vignette.value;
		expect( [ v.x, v.y ] ).toEqual( [ - 0.5, 0.9 ] );
		expect( v.z ).toBeCloseTo( 0.95, 9 );

	} );

	it( 'draws the edited picture at its cropped size: the stage into its target, then the canvas', () => {

		const pipeline = new EditPipeline();
		const renderer = fakeRenderer();
		const edits = { geometry: { crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } } };
		pipeline.set( edits );
		expect( pipeline.draw( renderer, picture( 400, 200 ) ) ).toEqual( { width: 200, height: 100 } );
		expect( renderer.setSize ).toHaveBeenCalledWith( 200, 100, false );
		expect( renderer.draws.map( d => d.target ) ).toEqual( [ pipeline._edited, null ] );
		expect( renderer.draws.every( d => d.toneMapping === NoToneMapping && d.colorSpace === LinearSRGBColorSpace ) ).toBe( true );
		expect( [ renderer.toneMapping, renderer.outputColorSpace ] ).toEqual( [ ACESFilmicToneMapping, SRGBColorSpace ] );
		const m = sourceTransform( normaliseEdits( edits ).geometry, 400, 200 );
		expect( [ ...pipeline._u.map0.value.toArray(), ...pipeline._u.map1.value.toArray() ] ).toEqual( m );

		pipeline.draw( renderer, picture( 400, 200 ) );
		expect( renderer.setSize ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'shows the whole turned frame while the crop is edited', () => {

		const pipeline = new EditPipeline();
		pipeline.set( { geometry: { crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, quarterTurns: 1 } }, { editing: true } );
		expect( pipeline.draw( fakeRenderer(), picture( 400, 200 ) ) ).toEqual( { width: 200, height: 400 } );

	} );

	it( 'builds clarity\'s base only while clarity is on, halving to 128 pixels', () => {

		const pipeline = new EditPipeline();
		const renderer = fakeRenderer();
		pipeline.draw( renderer, picture( 1000, 500 ) );
		expect( renderer.draws ).toHaveLength( 2 );

		renderer.draws.length = 0;
		pipeline.set( { detail: { clarity: 0.5 } } );
		pipeline.draw( renderer, picture( 1000, 500 ) );
		expect( renderer.draws ).toHaveLength( 5 );
		expect( pipeline._levels.map( l => [ l.rt.width, l.rt.height ] ) ).toEqual( [[ 500, 250 ], [ 250, 125 ], [ 125, 63 ]] );
		expect( pipeline._u.baseTexel.value.toArray() ).toEqual( [ 1 / 125, 1 / 63 ] );

	} );

	it( 'draws into a target it is given and leaves the canvas alone', () => {

		const pipeline = new EditPipeline();
		const renderer = fakeRenderer();
		const into = { isRenderTarget: true };
		pipeline.draw( renderer, picture( 64, 32 ), into );
		expect( renderer.setSize ).not.toHaveBeenCalled();
		expect( renderer.draws.at( - 1 ).target ).toBe( into );

	} );

	it( 'reads the picture handed over, encoding it when it comes as light', () => {

		const pipeline = new EditPipeline();
		const shown = picture( 8, 8 );
		pipeline.draw( fakeRenderer(), { ...shown, light: true } );
		expect( pipeline._source.value ).toBe( shown.texture );
		expect( pipeline._u.light.value ).toBe( 1 );
		pipeline.draw( fakeRenderer(), shown );
		expect( pipeline._u.light.value ).toBe( 0 );

	} );

} );

describe( 'hdrShowsPicture', () => {

	it( 'lets the saved light stand in only for a picture of its size, never an upscaled one', () => {

		expect( hdrShowsPicture( { width: 960, height: 540 }, { width: 960, height: 540 } ) ).toBe( true );
		expect( hdrShowsPicture( { width: 960, height: 540 }, { width: 3840, height: 2160 } ) ).toBe( false );
		expect( hdrShowsPicture( { width: 960, height: 540 }, { width: 960, height: 541 } ) ).toBe( false );
		expect( hdrShowsPicture( false, { width: 960, height: 540 } ) ).toBe( false );
		expect( hdrShowsPicture( { width: 960, height: 540 }, null ) ).toBe( false );

	} );

} );
