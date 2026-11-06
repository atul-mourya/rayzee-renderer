import { describe, it, expect, vi } from 'vitest';

vi.mock( 'oidn-webgpu', () => ( { initUNetFromBuffer: async () => ( { dispose() {} } ) } ) );
vi.stubGlobal( 'fetch', async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );
vi.stubGlobal( 'GPUBufferUsage', { COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 } );
vi.stubGlobal( 'GPUTextureUsage', { COPY_SRC: 1, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 } );

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

	// The moving-camera drop denoises smaller frames; oidn-webgpu keeps a plan for each of two sizes.
	it( 'keeps the network sized for the render while the frame is smaller', () => {

		const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } } );
		dn.setSize( 1024, 1024 );
		const rebuild = vi.spyOn( dn, '_setupUNetDenoiser' );

		dn.setFrameSize( 512, 512 );
		expect( dn._resolveTileSize() ).toBe( 1056 );
		expect( rebuild ).not.toHaveBeenCalled();

		dn.setFrameSize( 2048, 2048 );
		expect( rebuild ).toHaveBeenCalledOnce();
		expect( [ dn._renderWidth, dn._frameWidth ] ).toEqual( [ 2048, 2048 ] );

	} );

	// Past 65,535 × 64 pixels the library's first layer is rejected by the GPU and nothing is denoised.
	it( 'never builds a tile past the dispatch limit, halo included', () => {

		expect( tileFor( 2560, 1440, 2048 ) ).toBe( 2592 );
		expect( tileFor( 2560, 1600, 2048 ) ).toBe( 1808 );
		expect( tileFor( 3840, 2160, 4096 ) ).toBe( 1808 );
		expect( ( 1808 + 2 * 112 ) ** 2 ).toBeLessThanOrEqual( 65535 * 64 );

	} );

} );

describe( 'OIDNDenoiser — moving-camera frames', () => {

	const fakeDevice = () => ( {
		createBuffer: vi.fn( ( { size } ) => ( { size, destroy: vi.fn() } ) ),
		createTexture: vi.fn( ( { size } ) => ( { size, destroy: vi.fn() } ) ),
	} );

	const denoiserAt = ( width, height ) => {

		const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } } );
		dn.setSize( width, height );
		dn.gpuDevice = fakeDevice();
		return dn;

	};

	it( 'cancels a run sized for the other frame, and waits for it before the next', () => {

		const dn = denoiserAt( 1024, 1024 );
		dn._enabled = true;
		dn.unet = {};
		dn.state.isDenoising = true;
		const abort = vi.spyOn( dn, 'abort' );

		dn.setFrameSize( 512, 512 );

		expect( abort ).toHaveBeenCalledOnce();
		expect( dn._drainAborted ).toBe( true );
		expect( [ dn._frameWidth, dn._frameHeight ] ).toEqual( [ 512, 512 ] );

	} );

	it( 'reuses the input buffers, which are sized for the render', () => {

		const dn = denoiserAt( 1024, 1024 );
		dn._ensureGPUInputBuffers( 1024, 1024 );
		const buffer = dn._gpuInputBuffers.color;

		dn._ensureGPUInputBuffers( 512, 512 );

		expect( dn._gpuInputBuffers.color ).toBe( buffer );
		expect( buffer.size ).toBe( 1056 * 1056 * 16 );
		expect( dn._gpuInputBufferSize ).toEqual( { width: 512, height: 512 } );

	} );

	// The picture it replaces is on screen until the run publishes; each move goes small and back.
	it( 'keeps the other size\'s picture alive and takes it back', () => {

		const dn = denoiserAt( 1024, 1024 );
		const device = dn.gpuDevice;
		dn._ensureOutputTexture( device, 1024, 1024 );
		const full = dn._outGPUTexture;

		dn._ensureOutputTexture( device, 512, 512 );
		const small = dn._outGPUTexture;
		expect( full.destroy ).not.toHaveBeenCalled();

		dn._ensureOutputTexture( device, 1024, 1024 );
		expect( dn._outGPUTexture ).toBe( full );
		expect( small.destroy ).not.toHaveBeenCalled();
		expect( device.createTexture ).toHaveBeenCalledTimes( 2 );

		dn._ensureOutputTexture( device, 256, 256 );
		expect( small.destroy ).toHaveBeenCalledOnce();
		expect( full.destroy ).not.toHaveBeenCalled();

	} );

} );
