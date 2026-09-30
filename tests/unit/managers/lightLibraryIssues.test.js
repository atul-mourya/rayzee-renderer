import { describe, it, expect } from 'vitest';
import { IESManager } from '@/core/managers/IESManager.js';
import { GoboManager } from '@/core/managers/GoboManager.js';
import { IssueLog } from '@/core/EngineIssues.js';

const spot = { uuid: 's', isSpotLight: true, userData: {} };
const pathTracer = { scene: { getObjectByProperty: ( _, uuid ) => ( uuid === spot.uuid ? spot : null ) } };

describe( 'a light asked for a profile or gobo that is not loaded', () => {

	it( 'records it for an IES profile', () => {

		const issues = new IssueLog();
		const result = new IESManager( pathTracer, { issues } ).setSpotLightProfile( 's', 'missing.ies' );

		expect( result.applied ).toBe( false );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'asset.unreachable', detail: { name: 'missing.ies', asset: 'ies' } } );

	} );

	it( 'records it for a gobo', () => {

		const issues = new IssueLog();
		expect( new GoboManager( pathTracer, { issues } ).setLightGobo( 's', 'missing' ) ).toBe( false );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'asset.unreachable', detail: { name: 'missing', asset: 'gobo' } } );

	} );

	it( 'drops the log on dispose', () => {

		const manager = new IESManager( pathTracer, { issues: new IssueLog() } );
		manager.dispose();
		expect( manager._issues ).toBeNull();

	} );

} );
