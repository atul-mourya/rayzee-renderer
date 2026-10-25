import { describe, it, expect, vi } from 'vitest';
import { BuildTimer } from '@/core/scene/BuildTimer.js';

describe( 'BuildTimer', () => {

	it( 'tracks start/end/getDuration for a step', () => {

		const timer = new BuildTimer( 'Test' );
		timer.start( 'step1' );
		// Simulate some work with a small spin
		const start = performance.now();
		while ( performance.now() - start < 2 ) { /* spin */ }

		timer.end( 'step1' );

		expect( timer.getDuration( 'step1' ) ).toBeGreaterThan( 0 );

	} );

	it( 'returns 0 for unknown step', () => {

		const timer = new BuildTimer();
		expect( timer.getDuration( 'nonexistent' ) ).toBe( 0 );

	} );

	it( 'returns 0 for step not yet ended', () => {

		const timer = new BuildTimer();
		timer.start( 'running' );
		expect( timer.getDuration( 'running' ) ).toBe( 0 );

	} );

	it( 'tracks execution order', () => {

		const timer = new BuildTimer();
		timer.start( 'a' ).end( 'a' );
		timer.start( 'b' ).end( 'b' );
		timer.start( 'c' ).end( 'c' );

		// order should be preserved
		expect( timer.order ).toEqual( [ 'a', 'b', 'c' ] );

	} );

	it( 'does not duplicate order entries on restart', () => {

		const timer = new BuildTimer();
		timer.start( 'a' ).end( 'a' );
		timer.start( 'a' ).end( 'a' ); // restart same step
		expect( timer.order.filter( n => n === 'a' ) ).toHaveLength( 1 );

	} );

	it( 'print() returns structured result', () => {

		// Suppress console output
		vi.spyOn( console, 'groupCollapsed' ).mockImplementation( () => {} );
		vi.spyOn( console, 'table' ).mockImplementation( () => {} );
		vi.spyOn( console, 'groupEnd' ).mockImplementation( () => {} );

		const timer = new BuildTimer( 'TestBuild' );
		timer.start( 'step1' ).end( 'step1' );
		timer.start( 'step2' ).end( 'step2' );

		const result = timer.print();

		expect( result ).toHaveProperty( 'steps' );
		expect( result ).toHaveProperty( 'total' );
		expect( result.steps ).toHaveProperty( 'step1' );
		expect( result.steps ).toHaveProperty( 'step2' );
		expect( typeof result.total ).toBe( 'number' );

	} );

	it( 'start() returns this for chaining', () => {

		const timer = new BuildTimer();
		const result = timer.start( 'x' );
		expect( result ).toBe( timer );

	} );

	it( 'end() returns this for chaining', () => {

		const timer = new BuildTimer();
		timer.start( 'x' );
		const result = timer.end( 'x' );
		expect( result ).toBe( timer );

	} );

} );
