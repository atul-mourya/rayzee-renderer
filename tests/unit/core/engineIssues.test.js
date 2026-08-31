import { describe, it, expect, vi } from 'vitest';
import { IssueLog, EngineIssueError, ISSUE_CODES, ISSUE_SEVERITY } from '@/core/EngineIssues.js';
import { RenderSettings } from '@/core/RenderSettings.js';

describe( 'IssueLog', () => {

	it( 'records without throwing by default', () => {

		const log = new IssueLog();
		log.record( ISSUE_CODES.TEXTURE_BUILD_FAILED, 'albedo failed', { map: 'albedo' } );

		expect( log.length ).toBe( 1 );
		expect( log.list[ 0 ].code ).toBe( 'texture.build_failed' );
		expect( log.list[ 0 ].detail.map ).toBe( 'albedo' );
		expect( log.list[ 0 ].severity ).toBe( ISSUE_SEVERITY.ERROR );

	} );

	it( 'throws a typed error when strict', () => {

		const log = new IssueLog( { strict: true } );

		try {

			log.record( ISSUE_CODES.ASSET_UNREACHABLE, 'texture 404', { url: '/t.png' } );
			expect.unreachable( 'should have thrown' );

		} catch ( error ) {

			expect( error ).toBeInstanceOf( EngineIssueError );
			expect( error.code ).toBe( 'asset.unreachable' );
			expect( error.detail.url ).toBe( '/t.png' );

		}

	} );

	// The throw must not cost the record: a strict host still wants the full list afterwards.
	it( 'records the issue before it throws', () => {

		const log = new IssueLog( { strict: true } );
		expect( () => log.record( ISSUE_CODES.ASSET_UNREACHABLE, 'gone' ) ).toThrow();
		expect( log.length ).toBe( 1 );

	} );

	// A software adapter renders a correct image, just slowly — failing the run would be wrong.
	it( 'never throws on warnings, even when strict', () => {

		const log = new IssueLog( { strict: true } );
		expect( () => log.warn( ISSUE_CODES.ADAPTER_SOFTWARE, 'swiftshader' ) ).not.toThrow();
		expect( log.errors ).toHaveLength( 0 );
		expect( log.length ).toBe( 1 );

	} );

	it( 'notifies the listener before throwing', () => {

		const onIssue = vi.fn();
		const log = new IssueLog( { strict: true, onIssue } );

		expect( () => log.record( ISSUE_CODES.SETTING_UNKNOWN_KEY, 'nope' ) ).toThrow();
		expect( onIssue ).toHaveBeenCalledTimes( 1 );
		expect( onIssue.mock.calls[ 0 ][ 0 ].code ).toBe( 'setting.unknown_key' );

	} );

	it( 'hands out copies, so a caller cannot corrupt the log', () => {

		const log = new IssueLog();
		log.record( ISSUE_CODES.SETTING_UNKNOWN_KEY, 'nope' );

		log.list.length = 0;
		expect( log.length ).toBe( 1 );
		expect( () => {

			log.list[ 0 ].code = 'hacked';

		} ).toThrow();

	} );

	it( 'separates errors from warnings and clears', () => {

		const log = new IssueLog();
		log.record( ISSUE_CODES.TEXTURE_BUILD_FAILED, 'a' );
		log.warn( ISSUE_CODES.ADAPTER_SOFTWARE, 'b' );

		expect( log.length ).toBe( 2 );
		expect( log.errors ).toHaveLength( 1 );
		expect( log.has( ISSUE_CODES.ADAPTER_SOFTWARE ) ).toBe( true );

		log.clear();
		expect( log.length ).toBe( 0 );

	} );

	// Hosts pin a version and branch on these strings; a rename is a silent breaking change.
	it( 'freezes the code registry', () => {

		expect( Object.isFrozen( ISSUE_CODES ) ).toBe( true );

	} );

} );

describe( 'RenderSettings unknown keys', () => {

	it( 'reports a key that has no route', () => {

		const issues = new IssueLog();
		const settings = new RenderSettings( { maxBounces: 4 }, { issues } );

		settings.set( 'maxBonces', 8 );

		expect( issues.has( ISSUE_CODES.SETTING_UNKNOWN_KEY ) ).toBe( true );
		expect( issues.list[ 0 ].detail.key ).toBe( 'maxBonces' );

	} );

	it( 'reports unknown keys from setMany too', () => {

		const issues = new IssueLog();
		const settings = new RenderSettings( { maxBounces: 4 }, { issues } );

		settings.setMany( { maxBonces: 8, expsure: 2 } );

		expect( issues.errors ).toHaveLength( 2 );

	} );

	// The value is still stored, so the caller believes it took effect — that is the whole bug.
	it( 'stores the value it could not apply', () => {

		const settings = new RenderSettings( { maxBounces: 4 }, { issues: new IssueLog() } );
		settings.set( 'maxBonces', 8 );

		expect( settings.get( 'maxBonces' ) ).toBe( 8 );

	} );

	it( 'throws on a typo when the log is strict', () => {

		const settings = new RenderSettings( { maxBounces: 4 }, { issues: new IssueLog( { strict: true } ) } );

		expect( () => settings.set( 'maxBonces', 8 ) ).toThrow( EngineIssueError );

	} );

	it( 'stays silent for a routed key', () => {

		const issues = new IssueLog();
		const settings = new RenderSettings( { maxBounces: 4 }, { issues } );

		settings.set( 'maxBounces', 8 );

		expect( issues.length ).toBe( 0 );

	} );

	it( 'works with no log attached', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		expect( () => settings.set( 'maxBonces', 8 ) ).not.toThrow();

	} );

} );

describe( 'degradation sites', () => {

	it( 'AssetLoader turns an unreachable sub-resource into an issue', async () => {

		const { AssetLoader } = await import( '@/core/Processor/AssetLoader.js' );
		const issues = new IssueLog();
		const loader = new AssetLoader( null, null, null, { issues } );

		// What three's LoadingManager calls when a glTF's external texture 404s.
		loader._loadingManager.onError( 'https://cdn.example/brick_diffuse.png' );

		expect( issues.has( ISSUE_CODES.ASSET_UNREACHABLE ) ).toBe( true );
		expect( issues.list[ 0 ].detail.url ).toContain( 'brick_diffuse.png' );

	} );

	// A cancelled load 404s everything still in flight; those are not real failures.
	it( 'AssetLoader stays quiet for a cancelled load', async () => {

		const { AssetLoader } = await import( '@/core/Processor/AssetLoader.js' );
		const issues = new IssueLog();
		const loader = new AssetLoader( null, null, null, { issues } );

		loader._loadCancelled = true;
		loader._loadingManager.onError( 'https://cdn.example/aborted.png' );

		expect( issues.length ).toBe( 0 );

	} );

	it( 'TextureCreator names the map that failed', async () => {

		const { TextureCreator } = await import( '@/core/Processor/TextureCreator.js' );
		const issues = new IssueLog();
		const receiver = { _issues: issues, _reportTextureFailure: TextureCreator.prototype._reportTextureFailure };

		receiver._reportTextureFailure( 'normal', new Error( 'decode failed' ) );

		expect( issues.list[ 0 ].code ).toBe( ISSUE_CODES.TEXTURE_BUILD_FAILED );
		expect( issues.list[ 0 ].detail ).toEqual( { map: 'normal', cause: 'decode failed' } );

	} );

} );
