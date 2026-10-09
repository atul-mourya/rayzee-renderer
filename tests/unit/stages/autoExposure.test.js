/**
 * Auto exposure's CPU side: adaptation in stops, when it meters, and what a late reading may change.
 * The metering kernels run in tests/gpu/autoExposure.test.js.
 */
import { describe, it, expect } from 'vitest';
import { AutoExposure, adaptExposureEV } from '@/core/Stages/AutoExposure.js';
import { EventDispatcher } from '@/core/Pipeline/EventDispatcher.js';

const KEY = Math.log2( 0.18 );

function setup( { width = 640, height = 360 } = {} ) {

	const reads = [];
	const renderer = {
		toneMappingExposure: 1,
		metered: 0,
		compute() {

			this.metered ++;

		},
		getArrayBufferAsync() {

			return new Promise( ( resolve ) => reads.push( ( level ) => resolve( { buffer: Float32Array.of( level, 1, 1, 1 ).buffer } ) ) );

		},
	};

	const state = { 'pathtracer:samples': 1 };
	const context = {
		getTexture: () => ( { image: { width, height } } ),
		getState: ( key ) => state[ key ],
		setState() {},
	};

	const bus = new EventDispatcher();
	const stage = new AutoExposure( renderer, { enabled: false } );
	stage.initialize( context, bus );
	stage.setEnabled( true );

	// Resolves the oldest reading in flight with a metered luminance of 2^level.
	const land = async ( level ) => {

		reads.shift()( level );
		await stage._pending;

	};

	return { stage, renderer, context, state, bus, reads, land };

}

describe( 'adaptExposureEV', () => {

	it( 'moves at constant speed while far, never past the target', () => {

		expect( adaptExposureEV( 0, 6, 1, 3, 1 ) ).toBeCloseTo( 1, 9 );
		expect( adaptExposureEV( 0, - 6, 1, 3, 1 ) ).toBeCloseTo( - 3, 9 );
		expect( adaptExposureEV( 0, 6, 1e6, 3, 1 ) ).toBeLessThanOrEqual( 6 );
		expect( adaptExposureEV( 0, 6, Infinity, 3, 1 ) ).toBe( 6 );

	} );

	it( 'eases in exponentially near the target', () => {

		const step = adaptExposureEV( 0, 0.5, 0.1, 3, 1 );
		expect( step ).toBeCloseTo( 0.5 * ( 1 - Math.exp( - 0.1 / 1.5 ) ), 9 );

	} );

	it( 'does not depend on the frame rate', () => {

		const run = ( hz ) => {

			let ev = 0;
			for ( let i = 0; i < 3 * hz; i ++ ) ev = adaptExposureEV( ev, 4, 1 / hz, 3, 1 );
			return ev;

		};

		expect( Math.abs( run( 30 ) - run( 144 ) ) ).toBeLessThan( 0.02 );

	} );

	it( 'stands still without time or distance', () => {

		expect( adaptExposureEV( 1, 1, 1, 3, 1 ) ).toBe( 1 );
		expect( adaptExposureEV( 1, 3, 0, 3, 1 ) ).toBe( 1 );

	} );

} );

describe( 'AutoExposure', () => {

	it( 'lands on its first metering, then adapts in wall-clock time', async () => {

		const { stage, renderer, context, state, land } = setup();
		stage.render( context );
		await land( KEY - 2 );
		stage.update( 0 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 2, 6 );

		state[ 'pathtracer:samples' ] = 2;
		stage.render( context );
		await land( KEY - 4 ); // the scene got darker by two stops
		expect( stage.settling ).toBe( true );
		stage.update( 5000 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 2, 6 ); // the idle time before is not adaptation time
		stage.update( 5100 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 2.1, 6 ); // 1 stop/s × 0.1 s
		stage.advance( Infinity );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 4, 6 );
		expect( stage.settling ).toBe( false );

	} );

	it( 'multiplies the manual exposure in as compensation, and keeps the range', async () => {

		const { stage, renderer, context, land } = setup();
		stage.setCompensation( 0.5 );
		stage.render( context );
		await land( KEY - 2 );
		stage.advance( 0 );
		expect( renderer.toneMappingExposure ).toBeCloseTo( 2, 6 );

		stage.updateParameters( { maxExposure: 2 } );
		stage.advance( Infinity );
		expect( renderer.toneMappingExposure ).toBeCloseTo( 1, 6 );

		stage.setEnabled( false );
		expect( renderer.toneMappingExposure ).toBe( 0.5 );

	} );

	it( 'follows each metering exactly when instant', async () => {

		const { stage, renderer, context, state, land } = setup();
		stage.instant = true;
		stage.render( context );
		await land( KEY - 1 );
		stage.update( 0 );
		state[ 'pathtracer:samples' ] = 2;
		stage.render( context );
		await land( KEY + 3 );
		stage.update( 16 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( - 3, 6 );

	} );

	it( 'meters once a reading has landed, less often as samples grow', async () => {

		const { stage, renderer, context, state, land } = setup();
		stage.render( context );
		stage.render( context );
		expect( renderer.metered ).toBe( 1 );

		await land( KEY );
		stage.render( context );
		expect( renderer.metered ).toBe( 1 ); // no new samples

		const metered = [];
		for ( let samples = 2; samples <= 80; samples ++ ) {

			state[ 'pathtracer:samples' ] = samples;
			const before = renderer.metered;
			stage.render( context );
			if ( renderer.metered > before ) {

				metered.push( samples );
				await land( KEY );

			}

		}

		expect( metered.slice( 0, 3 ) ).toEqual( [ 2, 3, 4 ] );
		expect( metered.filter( s => s >= 64 ).length ).toBeLessThanOrEqual( 2 );

	} );

	it( 'keeps a reading taken before a camera move, and drops one from before a lighting change', async () => {

		const { stage, renderer, context, bus, land } = setup();
		stage.render( context );
		bus.emit( 'pipeline:reset' );
		await land( KEY - 1 );
		stage.update( 0 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 1, 6 );

		stage.render( context ); // a restart is due a metering
		bus.emit( 'pipeline:lightingChanged' );
		await land( KEY - 5 );
		expect( stage.wantsMetering ).toBe( true );
		stage.update( 16 );
		expect( Math.log2( renderer.toneMappingExposure ) ).toBeCloseTo( 1, 6 );

	} );

	it( 'meters again for a new pattern though no samples arrive', async () => {

		const { stage, renderer, context, land } = setup();
		stage.render( context );
		await land( KEY );
		expect( stage.wantsMetering ).toBe( false );
		stage.updateParameters( { metering: 'spot' } );
		expect( stage.wantsMetering ).toBe( true );
		stage.render( context );
		expect( renderer.metered ).toBe( 2 );

	} );

} );
