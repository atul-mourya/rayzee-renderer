import { describe, it, expect } from 'vitest';
import { describeUsage, formatBytes } from '@/lib/storage';

describe( 'app storage summary', () => {

	it( 'lists user data before caches and names every area', () => {

		const summary = describeUsage( {
			quota: 1e12,
			usage: 3072,
			persisted: false,
			budget: 3e11,
			cacheBytes: 2048,
			areas: {
				scenes: { kind: 'cache', bytes: 2048, entries: 1 },
				downloads: { kind: 'cache', bytes: 0, entries: 0 },
				renders: { kind: 'user', bytes: 1024, entries: 2 },
				custom: { kind: 'user', bytes: 0, entries: 0 },
			},
		} );

		expect( summary.rows.map( ( r ) => r.name ) ).toEqual( [ 'renders', 'downloads', 'scenes', 'custom' ] );
		expect( summary.rows[ 0 ].label ).toBe( 'Saved renders' );
		expect( summary.rows[ 3 ].label ).toBe( 'custom' );
		expect( summary.userBytes ).toBe( 1024 );
		expect( summary.siteBytes ).toBe( 3072 );

	} );

	it( 'formats sizes', () => {

		expect( formatBytes( 512 ) ).toBe( '512 B' );
		expect( formatBytes( 1536 ) ).toBe( '1.5 KB' );
		expect( formatBytes( 7.3 * 1024 ** 3 ) ).toBe( '7.3 GB' );
		expect( formatBytes( 250 * 1024 ** 2 ) ).toBe( '250 MB' );
		expect( formatBytes( Infinity ) ).toBe( '—' );

	} );

} );
