import { describe, it, expect, vi } from 'vitest';

vi.mock( 'oidn-webgpu', () => ( { initUNetFromBuffer: async () => ( { dispose() {} } ) } ) );
vi.stubGlobal( 'fetch', async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );

const { OIDNDenoiser } = await import( '@/core/viewer/denoise/OIDNDenoiser.js' );

const tileFor = ( width, height, cap = 1024 ) => {

	const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } } );
	dn.maxTileSize = cap;
	dn._renderWidth = width;
	dn._renderHeight = height;
	return dn._resolveTileSize();

};

describe( 'OIDNDenoiser — tile size', () => {

	it( 'runs a frame within the cap\'s area as one tile, border included', () => {

		expect( tileFor( 1024, 1024 ) ).toBe( 1056 );
		expect( tileFor( 512, 512 ) ).toBe( 544 );

	} );

	// oidn-webgpu's memory follows the tile's area: 1312×752 is smaller than the 1056² already allowed.
	it( 'keeps a wide frame whole when its area fits', () => {

		expect( tileFor( 1280, 720 ) ).toBe( 1312 );
		expect( tileFor( 1024, 256 ) ).toBe( 1056 );

	} );

	it( 'splits a frame larger in area at the cap', () => {

		expect( tileFor( 1920, 1080 ) ).toBe( 1024 );
		expect( tileFor( 1025, 1025 ) ).toBe( 1024 );
		expect( tileFor( 256, 256, 128 ) ).toBe( 128 );

	} );

	// Past 65,535 × 64 pixels the library's first layer is rejected by the GPU and nothing is denoised.
	it( 'never builds a tile past the dispatch limit, halo included', () => {

		expect( tileFor( 2560, 1440, 2048 ) ).toBe( 2592 );
		expect( tileFor( 2560, 1600, 2048 ) ).toBe( 1808 );
		expect( tileFor( 3840, 2160, 4096 ) ).toBe( 1808 );
		expect( ( 1808 + 2 * 112 ) ** 2 ).toBeLessThanOrEqual( 65535 * 64 );

	} );

} );
