/**
 * With the memory spill on, a scene archive's triangle and placement budgets rise to the spill
 * ones; a host's own numbers always win. Called off the prototype, as sceneObjectLookup does.
 */
import { describe, expect, it } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { SPILL_TRIANGLE_BUDGET, SPILL_PLACEMENT_BUDGET } from '@/core/Processor/PBRT/index.js';

const budgets = ( app, options ) => PathTracerApp.prototype._sceneBudgets.call( app, options );

describe( 'PathTracerApp scene budgets', () => {

	it( 'raises both budgets when the build can spill', () => {

		expect( budgets( { _memorySpill: true, storage: {} }, { element: [ 'a' ] } ) ).toEqual( {
			maxTriangles: SPILL_TRIANGLE_BUDGET, maxPlacements: SPILL_PLACEMENT_BUDGET, element: [ 'a' ],
		} );

	} );

	it( 'keeps what the host asked for', () => {

		expect( budgets( { _memorySpill: true, storage: {} }, { maxTriangles: 10 } ).maxTriangles ).toBe( 10 );

	} );

	it( 'leaves the options alone without the spill or without storage', () => {

		const options = { element: 'a' };
		expect( budgets( { _memorySpill: false, storage: {} }, options ) ).toBe( options );
		expect( budgets( { _memorySpill: true, storage: null }, options ) ).toBe( options );

	} );

} );
