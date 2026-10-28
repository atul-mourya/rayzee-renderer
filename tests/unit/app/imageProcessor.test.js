import { describe, it, expect, vi, beforeEach } from 'vitest';

const renderers = vi.hoisted( () => [] );

vi.mock( 'three', async importOriginal => ( {
	...await importOriginal(),
	WebGLRenderer: class {

		constructor( parameters ) {

			this.parameters = parameters;
			this.setSize = vi.fn();
			this.dispose = vi.fn();
			renderers.push( this );

		}

		getPixelRatio() {

			return 1;

		}

		getSize( target ) {

			return target.set( 8, 4 );

		}

	},
} ) );

import { LinearFilter } from 'three';
import { ImageProcessorComposer } from '@/lib/ImageProcessor';

describe( 'ImageProcessorComposer', () => {

	let input, output, processor;

	beforeEach( () => {

		renderers.length = 0;
		input = { width: 8, height: 4 };
		output = {};
		processor = new ImageProcessorComposer( input, output );

	} );

	const uniforms = () => ( { ...processor.brightnessContrastPass.uniforms, ...processor.colorAdjustmentPass.uniforms } );
	const values = names => Object.fromEntries( names.map( n => [ n, uniforms()[ n ].value ] ) );

	it( 'needs a picture to work on', () => {

		expect( () => new ImageProcessorComposer( null ) ).toThrow( 'Input canvas is required' );

	} );

	it( 'draws into the output canvas at the picture\'s size, keeping what it drew', () => {

		expect( output ).toMatchObject( { width: 8, height: 4 } );
		expect( renderers[ 0 ].parameters ).toEqual( { canvas: output, preserveDrawingBuffer: true } );
		expect( renderers[ 0 ].setSize ).toHaveBeenCalledWith( 8, 4, false );
		expect( processor.quad.material.map.image ).toBe( input );
		expect( processor.composer.passes ).toEqual( [ processor.renderPass, processor.brightnessContrastPass, processor.colorAdjustmentPass ] );

	} );

	it( 'starts with every edit off', () => {

		expect( values( [ 'brightness', 'contrast', 'hue', 'saturation', 'exposure', 'gamma' ] ) ).toEqual( { brightness: 0, contrast: 0, hue: 0, saturation: 0, exposure: 0, gamma: 2.2 } );

	} );

	it( 'takes the panel\'s percentages as fractions, hue in degrees and gamma as it is', () => {

		processor.setParameters( { brightness: 50, contrast: - 20, hue: 30, saturation: 40, exposure: 150, gamma: 2.4 } );

		expect( values( [ 'brightness', 'contrast', 'hue', 'saturation', 'exposure', 'gamma' ] ) ).toEqual( { brightness: 0.5, contrast: - 0.2, hue: 30, saturation: 0.4, exposure: 1.5, gamma: 2.4 } );

	} );

	it( 'leaves an edit the call does not mention as it was', () => {

		processor.setParameters( { brightness: 10, hue: 90 } );
		processor.setParameters( { contrast: 30 } );
		processor.setParameters();

		expect( values( [ 'brightness', 'contrast', 'hue', 'gamma' ] ) ).toEqual( { brightness: 0.1, contrast: 0.3, hue: 90, gamma: 2.2 } );

	} );

	it( 'uploads the picture again on every render and returns the output canvas', () => {

		const render = vi.spyOn( processor.composer, 'render' ).mockImplementation( () => {} );
		const version = processor.quad.material.map.version;

		expect( processor.render() ).toBe( output );
		expect( processor.render() ).toBe( output );

		expect( render ).toHaveBeenCalledTimes( 2 );
		expect( processor.quad.material.map.version ).toBe( version + 2 );

	} );

	it( 'takes a new texture of the picture at a new size, freeing the old one', () => {

		const old = processor.quad.material.map;
		const disposed = vi.fn();
		old.addEventListener( 'dispose', disposed );
		const setSize = vi.spyOn( processor.composer, 'setSize' );
		const materialVersion = processor.quad.material.version;

		processor.resize( 16, 6 );

		expect( disposed ).toHaveBeenCalledTimes( 1 );
		const map = processor.quad.material.map;
		expect( map ).not.toBe( old );
		expect( map.image ).toBe( input );
		expect( [ map.minFilter, map.magFilter ] ).toEqual( [ LinearFilter, LinearFilter ] );
		expect( processor.quad.material.version ).toBe( materialVersion + 1 );
		expect( renderers[ 0 ].setSize ).toHaveBeenLastCalledWith( 16, 6, false );
		expect( setSize ).toHaveBeenCalledWith( 16, 6 );
		expect( [ processor.width, processor.height ] ).toEqual( [ 16, 6 ] );

	} );

	it( 'frees the renderer and every pass on dispose', () => {

		const passes = processor.composer.passes.map( pass => vi.spyOn( pass, 'dispose' ) );

		processor.dispose();

		expect( renderers[ 0 ].dispose ).toHaveBeenCalledTimes( 1 );
		passes.forEach( dispose => expect( dispose ).toHaveBeenCalledTimes( 1 ) );
		expect( processor.composer ).toBeNull();

	} );

} );
