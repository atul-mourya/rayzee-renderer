import { describe, it, expect } from 'vitest';
import { EnvironmentManager } from '@/core/managers/EnvironmentManager.js';
import { IssueLog, ISSUE_CODES, EngineIssueError } from '@/core/EngineIssues.js';

const uniforms = { get: () => ( { value: { set() {} } } ), set() {} };

describe( 'the physical sky as a capability', () => {

	it( 'is reported missing when procedural mode is asked of the core alone', async () => {

		const env = new EnvironmentManager( {}, uniforms );
		env.issues = new IssueLog();
		await env.generateProceduralSkyTexture();
		expect( env.issues.list.map( i => i.code ) ).toEqual( [ ISSUE_CODES.CAPABILITY_MISSING ] );
		expect( env.physicalSky ).toBeNull();

	} );

	it( 'throws under strict rather than render without a sky', () => {

		const env = new EnvironmentManager( {}, uniforms );
		env.issues = new IssueLog( { strict: true } );
		expect( () => env.generateProceduralSkyTexture() ).toThrow( EngineIssueError );

	} );

	it( 'bakes through the installed class once there is one', () => {

		const env = new EnvironmentManager( {}, uniforms );
		env.issues = new IssueLog();
		class Sky {}
		env.setProceduralSky( Sky );
		expect( env.ProceduralSky ).toBe( Sky );
		env.generateProceduralSkyTexture();
		expect( env.issues.list ).toEqual( [] );

	} );

	it( 'loads the class on first use when installed with a loader, once however many bakes ask', async () => {

		const env = new EnvironmentManager( {}, uniforms );
		env.issues = new IssueLog();
		class Sky {}
		let loads = 0;
		env.setProceduralSkyLoader( async () => {

			loads ++;
			return Sky;

		} );
		expect( env.ProceduralSky ).toBeNull();
		await Promise.all( [ env.generateProceduralSkyTexture(), env.generateProceduralSkyTexture() ] );
		expect( env.ProceduralSky ).toBe( Sky );
		expect( loads ).toBe( 1 );
		expect( env.issues.list ).toEqual( [] );

	} );

} );
