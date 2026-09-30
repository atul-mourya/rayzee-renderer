import { describe, it, expect, afterEach } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { EngineEvents } from '@/core/EngineEvents.js';
import { setStatusCallback } from '@/core/Processor/utils.js';

// A load that failed before the scene build left the host's loading status on its last step.
describe( 'PathTracerApp — the loading status after a failed load', () => {

	afterEach( () => setStatusCallback( null ) );

	async function failWith( error ) {

		const events = [];
		setStatusCallback( ( event ) => events.push( event ) );
		const receiver = { _loadingInProgress: false, _discardFailedLoad() {} };
		await expect( PathTracerApp.prototype._loadWithSceneRebuild.call( receiver, async () => {

			throw error;

		}, {} ) ).rejects.toBe( error );
		expect( receiver._loadingInProgress ).toBe( false );
		return events;

	}

	it( 'reports a failure in the parse as failed, with its message', async () => {

		const events = await failWith( new TypeError( 'Cannot perform Construct on a detached ArrayBuffer' ) );
		expect( events ).toEqual( [ {
			type: EngineEvents.LOADING_UPDATE,
			status: 'Error: Cannot perform Construct on a detached ArrayBuffer',
			failed: true,
			progress: 100,
		} ] );

	} );

	it( 'ends the status for an archive that asks which parts to load', async () => {

		const events = await failWith( Object.assign( new Error( 'choose' ), { code: 'ARCHIVE_NEEDS_ELEMENT' } ) );
		expect( events ).toEqual( [ { type: EngineEvents.LOADING_RESET } ] );

	} );

	it( 'leaves the status of the load already in progress alone', async () => {

		const events = await failWith( Object.assign( new Error( 'busy' ), { code: 'LOAD_IN_PROGRESS' } ) );
		expect( events ).toEqual( [] );

	} );

} );
