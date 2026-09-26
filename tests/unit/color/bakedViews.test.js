/**
 * Baked view files: a view saved from a loaded config, shown later without the runtime or the
 * config, and kept — not baked again — when that same config loads.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Buffer } from 'node:buffer';
import { ColorManagement } from '@/core/Color/ColorManagement.js';
import { getViewTransform } from '@/core/Color/ViewTransforms.js';
import { encodeBakedView, decodeBakedView, configFingerprint } from '@/core/Color/BakedViews.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { IssueLog } from '@/core/EngineIssues.js';

const BUILTIN = 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5';
const OTHER = 'ocio://studio-config-v4.0.0_aces-v2.0_ocio-v2.5';

let available = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	available = false;

}

const suite = available ? describe : describe.skip;
if ( available ) configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );

describe( 'configFingerprint', () => {

	const files = [
		{ relativePath: 'config.ocio', data: new TextEncoder().encode( 'ocio_profile_version: 2' ) },
		{ relativePath: 'luts/a.cube', data: new Uint8Array( [ 1, 2, 3 ] ) },
	];

	it( 'is the same for the same files in any order, and changes with one byte', async () => {

		const a = await configFingerprint( { files } );
		expect( a ).toMatch( /^sha256:[0-9a-f]{64}$/ );
		expect( await configFingerprint( { files: [ ...files ].reverse() } ) ).toBe( a );

		const edited = [ files[ 0 ], { relativePath: 'luts/a.cube', data: new Uint8Array( [ 1, 2, 4 ] ) } ];
		expect( await configFingerprint( { files: edited } ) ).not.toBe( a );

	} );

	it( 'names a built-in config by name', async () => {

		expect( await configFingerprint( { builtin: BUILTIN } ) ).toBe( `builtin:${BUILTIN}` );

	} );

} );

suite( 'baked views', () => {

	let bytes, original, view;

	beforeAll( async () => {

		ColorManagement.resetAll();
		const cm = new ColorManagement();
		const config = await cm.loadConfig( { builtin: BUILTIN, registerViews: false } );
		view = { display: config.defaultDisplay, view: config.defaultViews[ config.defaultDisplay ] };
		original = cm.setView( view );
		bytes = await cm.saveBakedView( original.id );
		cm.dispose();

	}, 120000 );

	afterAll( () => {

		ColorManagement.resetAll();

	} );

	it( 'round-trips the table exactly, in a fraction of its size', async () => {

		const decoded = await decodeBakedView( bytes );
		// toEqual on the 1.1M-element table took 7 s on CI.
		const raw = a => Buffer.from( a.buffer, a.byteOffset, a.byteLength );
		expect( raw( decoded.data ).equals( raw( original.table.data ) ) ).toBe( true );
		expect( decoded ).toMatchObject( { configId: BUILTIN, fingerprint: `builtin:${BUILTIN}`, ...view, size: original.ocio.size } );
		expect( bytes.length ).toBeLessThan( original.table.data.byteLength / 5 );

	} );

	it( 'refuses what is not a baked view', async () => {

		const gz = await encodeBakedView( original );
		gz[ 20 ] ^= 0xff;
		await expect( decodeBakedView( gz ) ).rejects.toThrow();
		await expect( decodeBakedView( new Uint8Array( 16 ) ) ).rejects.toThrow();

	} );

	describe( 'without the config', () => {

		let cm, issues, entry;

		beforeAll( async () => {

			ColorManagement.resetAll();
			issues = new IssueLog();
			cm = new ColorManagement( { issues } );
			entry = await cm.loadBakedView( bytes, { expect: { configId: BUILTIN, ...view } } );
			cm.setActiveView( entry.id );

		} );

		it( 'shows the view with no runtime and no config', () => {

			expect( cm.hasConfig ).toBe( false );
			expect( cm.status().config ).toBeNull();
			expect( cm.activeView ).toMatchObject( { configId: BUILTIN, ...view } );
			expect( entry.outputEncoded ).toBe( true );
			expect( issues.list ).toEqual( [] );

		} );

		it( 'reads back what the original did', () => {

			const a = [ 0, 0, 0 ];
			const b = [ 0, 0, 0 ];
			for ( const c of [[ 0.18, 0.18, 0.18 ], [ 4, 0.5, 0.02 ], [ 0, 0, 0 ], [ 30, 30, 30 ]] ) {

				original.cpu( ...c, 1, a );
				entry.cpu( ...c, 1, b );
				expect( b ).toEqual( a );

			}

		} );

		it( 'refuses a file for another view', async () => {

			await expect( cm.loadBakedView( bytes, { expect: { view: 'Un-tone-mapped' } } ) ).rejects.toThrow( /expected/ );

		} );

		it( 'is kept, not baked again, when its own config loads', async () => {

			await cm.loadConfig( { builtin: BUILTIN, registerViews: false } );
			expect( getViewTransform( entry.id ) ).toBe( entry );
			expect( cm.setView( view ) ).toBe( entry );
			expect( issues.list ).toEqual( [] );

		} );

		it( 'goes when another config loads', async () => {

			await cm.loadConfig( { builtin: OTHER, registerViews: false } );
			expect( getViewTransform( entry.id )?.ocio?.baked ).toBeFalsy();

		} );

	} );

	it( 'is baked again when the files differ from the ones it came from', async () => {

		ColorManagement.resetAll();
		const { ocioVersion } = await decodeBakedView( bytes );
		const loaded = await new ColorManagement().loadBakedView( bytes );
		const forged = await encodeBakedView( loaded, { configId: BUILTIN, fingerprint: 'sha256:other', ocioVersion } );

		ColorManagement.resetAll();
		const fresh = new ColorManagement();
		const entry = await fresh.loadBakedView( forged );
		fresh.setActiveView( entry.id );
		await fresh.loadConfig( { builtin: BUILTIN, registerViews: false } );
		expect( getViewTransform( entry.id ) ).not.toBe( entry );
		expect( fresh.setView( view ).ocio.baked ).toBeUndefined();

	} );

} );
