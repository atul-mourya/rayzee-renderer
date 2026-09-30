import { describe, it, expect, vi, afterEach } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { IssueLog } from '@/core/EngineIssues.js';
import { setReservedRenderSize } from '@/core/EngineDefaults.js';

const GB = 1024 * 1024 * 1024;

function makeApp( hostMemoryGB ) {

	return {
		_hostMemoryGB: hostMemoryGB,
		_issues: new IssueLog(),
		renderer: { backend: { device: { limits: { maxStorageBufferBindingSize: 2 * GB } } } },
		dispatchEvent: vi.fn(),
		setReservedRenderResolution: PathTracerApp.prototype.setReservedRenderResolution,
	};

}

describe( 'the render reserve outside Chrome', () => {

	afterEach( () => {

		setReservedRenderSize( 2048 );
		vi.unstubAllGlobals();

	} );

	it( 'caps at 2048 on an assumed 4 GB, and says it assumed', () => {

		vi.stubGlobal( 'navigator', {} );
		const app = makeApp();

		expect( app.setReservedRenderResolution( 4096 ) ).toBe( 2048 );
		const [ issue ] = app._issues.list;
		expect( issue.code ).toBe( 'render.reserve_capped' );
		expect( issue.detail ).toMatchObject( { requested: 4096, applied: 2048, deviceMemoryGB: 4, assumed: true } );
		expect( issue.message ).toMatch( /hostMemoryGB/ );

	} );

	it( 'grants 4096 when the host states its memory', () => {

		vi.stubGlobal( 'navigator', {} );
		const app = makeApp( 16 );

		expect( app.setReservedRenderResolution( 4096 ) ).toBe( 4096 );
		expect( app._issues.list ).toHaveLength( 0 );

	} );

	it( 'records nothing for a request that fits', () => {

		vi.stubGlobal( 'navigator', {} );
		const app = makeApp();

		expect( app.setReservedRenderResolution( 1024 ) ).toBe( 2048 );
		expect( app._issues.list ).toHaveLength( 0 );

	} );

} );
