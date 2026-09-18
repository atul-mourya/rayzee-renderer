import { describe, it, expect } from 'vitest';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';
import { SAFE_SCENE_BYTES, MAX_SCENE_BYTES } from '@/core/Processor/HostMemory.js';

const MB = 1024 * 1024;

/** The rungs that were actually measured, as the survey would report them. */
const RUNGS = {
	small: { triangles: 1e6, placements: 1e4, meshes: 100, geometryBytes: 40 * MB },
	at30M: { triangles: 30e6, placements: 2.8e6, meshes: 14000, geometryBytes: 1400 * MB },
	at40M: { triangles: 40e6, placements: 3.7e6, meshes: 18098, geometryBytes: 1832 * MB },
	at50M: { triangles: 50e6, placements: 4.6e6, meshes: 22000, geometryBytes: 2200 * MB },
};

/**
 * A SceneProcessor with only what the preflight touches, and a stubbed survey — the traversal
 * has its own tests, and a real 40M-triangle scene is 1.4 GB of test fixture.
 */
function processor( rung, { maxSceneBytes, issues } = {} ) {

	const sp = Object.create( SceneProcessor.prototype );
	sp.config = { issues, ...( maxSceneBytes === undefined ? {} : { maxSceneBytes } ) };
	sp.geometryExtractor = { surveyScene: () => ( { ...rung } ) };
	return sp;

}

describe( 'SceneProcessor memory preflight', () => {

	it( 'says nothing about a scene too small to matter', () => {

		const issues = new IssueLog();
		const report = processor( RUNGS.small, { issues } )._preflightMemory( null );

		expect( issues.list ).toHaveLength( 0 );
		expect( report.fits ).toBe( true );

	} );

	it( 'says nothing about 30M, which loads on any session', () => {

		const issues = new IssueLog();
		expect( processor( RUNGS.at30M, { issues } )._preflightMemory( null ).fits ).toBe( true );
		expect( issues.list ).toHaveLength( 0 );

	} );

	it( 'warns, but still allows, 40M — which needs a fresh session and then works', () => {

		const issues = new IssueLog();
		const report = processor( RUNGS.at40M, { issues } )._preflightMemory( null );

		expect( report.fits ).toBe( false );
		expect( issues.list ).toHaveLength( 1 );
		expect( issues.list[ 0 ].code ).toBe( ISSUE_CODES.SCENE_MEMORY_BUDGET );
		expect( issues.list[ 0 ].severity ).toBe( 'warning' );
		expect( issues.list[ 0 ].message ).toMatch( /restarting the browser/i );

	} );

	it( 'refuses 50M, which killed the renderer rather than throwing anything catchable', () => {

		const issues = new IssueLog();
		const sp = processor( RUNGS.at50M, { issues } );

		expect( () => sp._preflightMemory( null ) ).toThrow( /would crash the tab/ );
		expect( issues.errors ).toHaveLength( 1 );
		expect( issues.errors[ 0 ].code ).toBe( ISSUE_CODES.SCENE_MEMORY_BUDGET );
		// The message has to say what to do about it, not just that it failed.
		expect( issues.errors[ 0 ].message ).toMatch( /maxSceneBytes/ );

	} );

	it( 'honours a raised maxSceneBytes, so a bigger rung can still be tried', () => {

		const issues = new IssueLog();
		const sp = processor( RUNGS.at50M, { issues, maxSceneBytes: Infinity } );

		expect( () => sp._preflightMemory( null ) ).not.toThrow();
		expect( issues.errors ).toHaveLength( 0 );

	} );

	it( 'records the breakdown even when it refuses, so a host can see why', () => {

		const sp = processor( RUNGS.at50M, { maxSceneBytes: 1024 } );
		expect( () => sp._preflightMemory( null ) ).toThrow();

		expect( sp.memoryPreflight.triangles ).toBe( 50e6 );
		expect( sp.memoryPreflight.estimate.total ).toBeGreaterThan( SAFE_SCENE_BYTES );
		expect( sp.memoryPreflight.estimate.bvh ).toBeGreaterThan( 0 );

	} );

	it( 'defaults to the shipped limit when the host sets none', () => {

		const sp = processor( RUNGS.at40M );
		expect( sp._preflightMemory( null ).maxBytes ).toBe( MAX_SCENE_BYTES );

	} );

} );
