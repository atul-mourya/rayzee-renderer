import { describe, it, expect } from 'vitest';
import { PathTracer } from '@/core/pathtracer/PathTracer.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';
import { Matrix3, Vector3 } from 'three';
import { uniform } from 'three/tsl';
import { setWorkingMatrix } from '@/core/color/WorkingMatrix.js';

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

	it( 'compiles path regularization in only while it is on, under the path integrator, and says so once otherwise', () => {

		const pt = bare();
		pt.registerIntegrator( [ 'bidirectional', 'vcm' ], p => new FakeIntegrator( p ) );
		pt._pathRegularization = false;
		pt._outputsChanged = false;

		pt.setPathRegularization( false );
		expect( pt._outputsChanged ).toBe( false );
		pt.setPathRegularization( true );
		expect( [ pt._outputsChanged, pt._regularizeNeeded() ] ).toEqual( [ true, true ] );

		pt.setIntegrator( 'vcm' );
		expect( [ pt._regularizeNeeded(), pt._regularizeNeeded() ] ).toEqual( [ false, false ] );
		expect( pt.issues.list.map( i => [ i.code, i.detail.setting, i.detail.integrator ] ) )
			.toEqual( [[ ISSUE_CODES.SETTING_IGNORED, 'pathRegularization', 'vcm' ]] );

		pt.setPathRegularization( false );
		expect( pt._regularizeNeeded() ).toBe( false );

	} );

	it( 'compiles the sample clamp in only while it has a limit, under the path integrator, and says so once otherwise', () => {

		const pt = bare();
		pt.registerIntegrator( [ 'bidirectional', 'vcm' ], p => new FakeIntegrator( p ) );
		pt.sampleClamp = { value: 0 };
		expect( pt._sampleClampNeeded() ).toBe( false );
		pt.sampleClamp.value = 10;
		expect( pt._sampleClampNeeded() ).toBe( true );

		pt.setIntegrator( 'bidirectional' );
		expect( [ pt._sampleClampNeeded(), pt._sampleClampNeeded() ] ).toEqual( [ false, false ] );
		expect( pt.issues.list.map( i => [ i.code, i.detail.setting, i.detail.integrator ] ) )
			.toEqual( [[ ISSUE_CODES.SETTING_IGNORED, 'sampleClamp', 'bidirectional' ]] );
		pt.setIntegrator( 'path' );
		expect( pt._sampleClampNeeded() ).toBe( true );

	} );

	it( 'measures the clamp in CIE XYZ from whatever the working space is', () => {

		const pt = bare();
		pt._sampleClampXYZ = uniform( new Matrix3() );
		const xyzOfWhite = () => new Vector3( 1, 1, 1 ).applyMatrix3( pt._sampleClampXYZ.value ).toArray();
		try {

			setWorkingMatrix( null );
			pt._syncSampleClampXYZ();
			xyzOfWhite().forEach( ( v, i ) => expect( v ).toBeCloseTo( [ 0.95047, 1, 1.08883 ][ i ], 4 ) );

			// Rec.709 → ACEScg: its white is still D65's XYZ once taken back.
			const toAP1 = [ 0.6130974, 0.3395231, 0.0473795, 0.0701937, 0.9163539, 0.0134524, 0.0206156, 0.1095698, 0.8698146 ];
			setWorkingMatrix( toAP1, 'ACEScg' );
			pt._syncSampleClampXYZ();
			const red = new Vector3( 1, 0, 0 ).applyMatrix3( new Matrix3().set( ...toAP1 ) );
			const xyz = red.applyMatrix3( pt._sampleClampXYZ.value ).toArray();
			xyz.forEach( ( v, i ) => expect( v ).toBeCloseTo( [ 0.4124564, 0.2126729, 0.0193339 ][ i ], 5 ) );

		} finally {

			setWorkingMatrix( null );

		}

	} );

} );
