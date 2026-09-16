import { describe, it, expect } from 'vitest';
import { AssetLoader, ARCHIVE_ELEMENT_PROMPT_BYTES } from '@/core/Processor/AssetLoader.js';

/** A listing shaped like a pbrt scene archive: a root scene file plus `n` element folders. */
function islandListing( n, bytesEach ) {

	const listing = [
		{ path: 'island.pbrt', size: 1000 },
		{ path: 'materials.pbrt', size: 1000 },
	];

	for ( let i = 0; i < n; i ++ ) {

		listing.push( { path: `isThing${i}/isThing${i}.pbrt`, size: 1000 } );
		listing.push( { path: `isThing${i}/geo.ply`, size: bytesEach } );

	}

	return listing;

}

const total = listing => listing.reduce( ( n, e ) => n + e.size, 0 );

describe( 'choosing parts of a large scene archive', () => {

	const loader = Object.create( AssetLoader.prototype );
	const ask = ( listing, promptBytes ) =>
		loader._requireElementChoice( 'island.tar', listing, total( listing ), promptBytes );

	it( 'asks which parts to load when the archive is large and has several', () => {

		const listing = islandListing( 15, 5e8 );

		let thrown = null;
		try {

			ask( listing );

		} catch ( error ) {

			thrown = error;

		}

		expect( thrown?.code ).toBe( 'ARCHIVE_NEEDS_ELEMENT' );
		expect( thrown.elements ).toHaveLength( 15 );
		expect( thrown.elements[ 0 ].prefix ).toBe( 'isThing0' );
		expect( thrown.totalBytes ).toBeGreaterThan( ARCHIVE_ELEMENT_PROMPT_BYTES );

	} );

	it( 'loads a small archive without asking, however many parts it has', () => {

		expect( () => ask( islandListing( 15, 1e6 ) ) ).not.toThrow();

	} );

	it( 'does not ask when there is nothing to choose between', () => {

		// One giant element: picking it is the same as loading everything.
		expect( () => ask( islandListing( 1, 9e9 ) ) ).not.toThrow();

	} );

	it( 'honours a caller-supplied threshold', () => {

		const listing = islandListing( 4, 1e6 );

		expect( () => ask( listing, 1e9 ) ).not.toThrow();
		expect( () => ask( listing, 1000 ) ).toThrow( /Choose which to load/ );

	} );

} );
