import { describe, it, expect } from 'vitest';
import { BasicColor } from '@/core/Color/BasicColor.js';
import { getActiveColorManagement, setActiveColorManagement, DEFAULT_WORKING_SPACE } from '@/core/Color/ActiveColor.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';

describe( 'the renderer core\'s colour management', () => {

	it( 'renders in linear Rec.709 and converts nothing', () => {

		const color = new BasicColor();
		expect( color.hasConfig ).toBe( false );
		expect( color.workingSpace ).toBe( DEFAULT_WORKING_SPACE );
		expect( color.workingSpaceAdopted ).toBe( false );
		expect( color.inputKey ).toBe( '-' );
		const rgba = new Float32Array( 4 );
		expect( color.exportPixels( rgba ) ).toEqual( { rgba, colorSpace: DEFAULT_WORKING_SPACE } );
		expect( color.status() ).toMatchObject( { config: null, workingSpace: DEFAULT_WORKING_SPACE, activeView: null } );
		color.dispose();

	} );

	it( 'reports the OCIO add-on missing when a config is asked for', async () => {

		const issues = new IssueLog();
		const color = new BasicColor( { issues } );
		await expect( color.loadConfig( { builtin: 'any' } ) ).rejects.toThrow( /rayzee\/addons\/color/ );
		expect( issues.list.map( i => i.code ) ).toEqual( [ ISSUE_CODES.CAPABILITY_MISSING ] );
		color.dispose();

	} );

	it( 'stops being the active one when disposed', () => {

		const color = new BasicColor();
		setActiveColorManagement( color );
		expect( getActiveColorManagement() ).toBe( color );
		color.dispose();
		expect( getActiveColorManagement() ).toBeNull();

	} );

} );
