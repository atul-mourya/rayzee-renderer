import { describe, it, expect } from 'vitest';
import { PathTracer } from '@/core/Stages/PathTracer.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

// A path tracer with no kernels built: choosing an integrator only swaps the instance.
function bare() {

	const pt = Object.create( PathTracer.prototype );
	pt._integratorFactories = new Map();
	pt._integratorInstances = new Map();
	pt._integrator = null;
	pt.issues = new IssueLog();
	return pt;

}

class FakeIntegrator {

	constructor( pt ) {

		this.pt = pt;
		this.disposed = 0;

	}

	select( name ) {

		this.name = name;

	}

	dispose() {

		this.disposed ++;

	}

}

describe( 'the path tracer\'s integrators', () => {

	it( 'stays the path tracer and reports the add-on missing when none is registered', () => {

		const pt = bare();
		pt.setIntegrator( 'bidirectional' );
		expect( pt.integrator ).toBe( 'path' );
		expect( pt.issues.list.map( i => i.code ) ).toEqual( [ ISSUE_CODES.CAPABILITY_MISSING ] );

	} );

	it( 'makes one instance for every name it answers, and frees it when another is chosen', () => {

		const pt = bare();
		pt.registerIntegrator( [ 'bidirectional', 'vcm' ], p => new FakeIntegrator( p ) );

		pt.setIntegrator( 'vcm' );
		const vcm = pt.activeIntegrator;
		expect( pt.integrator ).toBe( 'vcm' );
		expect( vcm.pt ).toBe( pt );

		pt.setIntegrator( 'bidirectional' );
		expect( pt.activeIntegrator ).toBe( vcm );
		expect( pt.integrator ).toBe( 'bidirectional' );
		expect( vcm.disposed ).toBe( 0 );

		pt.setIntegrator( 'path' );
		expect( pt.activeIntegrator ).toBeNull();
		expect( vcm.disposed ).toBe( 1 );
		expect( pt.issues.list ).toEqual( [] );

	} );

} );
