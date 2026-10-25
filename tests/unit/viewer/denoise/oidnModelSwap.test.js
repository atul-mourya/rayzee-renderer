import { describe, it, expect, vi } from 'vitest';

const nets = [];
vi.mock( 'oidn-webgpu', () => ( {
	initUNetFromBuffer: async () => {

		const net = { disposed: false, dispose: vi.fn( function () {

			this.disposed = true;

		} ) };
		nets.push( net );
		return net;

	},
} ) );

vi.stubGlobal( 'fetch', async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );

const { OIDNDenoiser } = await import( '@/core/viewer/denoise/OIDNDenoiser.js' );

const settle = async ( dn ) => {

	while ( dn.state.isLoading || ! dn.unet ) await new Promise( resolve => setTimeout( resolve, 0 ) );

};

describe( 'OIDNDenoiser — swapping models under a running denoise', () => {

	it( 'lets the tile already started finish with the old network before disposing it', async () => {

		const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } } );
		await settle( dn );
		const old = dn.unet;

		// A tile mid-flight: its next write lands once the current microtasks drain.
		dn.state.isDenoising = true;
		dn.state.abortController = new AbortController();
		const writes = [];
		queueMicrotask( () => writes.push( old.disposed ? 'into a disposed network' : 'ok' ) );

		await dn.updateQuality( 'balance' );
		await settle( dn );

		expect( writes ).toEqual( [ 'ok' ] );
		expect( old.dispose ).toHaveBeenCalledTimes( 1 );
		expect( dn.state.abortController.signal.aborted ).toBe( true );
		expect( dn.unet ).not.toBe( old );

	} );

} );
