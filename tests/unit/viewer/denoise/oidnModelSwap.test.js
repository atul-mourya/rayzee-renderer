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

const fetch = vi.fn( async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );
vi.stubGlobal( 'fetch', fetch );

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

describe( 'OIDNDenoiser — loading only while on', () => {

	it( 'downloads nothing while off, then once the tier and size chosen meanwhile', async () => {

		fetch.mockClear();
		const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } }, { enableOIDN: false } );
		dn.setSize( 640, 480 );
		await dn.updateQuality( 'high' );
		await new Promise( resolve => setTimeout( resolve, 0 ) );
		expect( fetch ).not.toHaveBeenCalled();
		expect( dn.unet ).toBeNull();

		dn.enabled = true;
		await dn.whenLoaded();
		expect( fetch ).toHaveBeenCalledOnce();
		expect( fetch.mock.calls[ 0 ][ 0 ] ).toMatch( /rt_hdr_calb_cnrm_large\.tza$/ );
		expect( dn.currentTZAUrl ).toMatch( /rt_hdr_calb_cnrm_large\.tza$/ );
		expect( dn.unet ).not.toBeNull();

	} );

	it( 'loads a tier chosen while off once switched back on', async () => {

		const dn = new OIDNDenoiser( { domElement: { width: 8, height: 8 } } );
		await settle( dn );
		const old = dn.unet;

		dn.enabled = false;
		await dn.updateQuality( 'balance' );
		expect( dn.unet ).toBe( old );

		dn.enabled = true;
		await dn.whenLoaded();
		expect( dn.currentTZAUrl ).toMatch( /rt_hdr_calb_cnrm\.tza$/ );
		expect( dn.unet ).not.toBe( old );

	} );

} );
