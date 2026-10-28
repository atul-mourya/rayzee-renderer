import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectionalLight, PointLight, Scene, SpotLight } from 'three';
import { IESManager } from '@/core/viewer/lights/IESManager.js';
import { GoboManager } from '@/core/viewer/lights/GoboManager.js';
import { IssueLog } from '@/core/EngineIssues.js';

const spot = { uuid: 's', isSpotLight: true, userData: {} };
const pathTracer = { scene: { getObjectByProperty: ( _, uuid ) => ( uuid === spot.uuid ? spot : null ) } };

describe( 'a light asked for a profile or gobo that is not loaded', () => {

	it( 'records it for an IES profile', () => {

		const issues = new IssueLog();
		const result = new IESManager( pathTracer, { issues } ).setSpotLightProfile( 's', 'missing.ies' );

		expect( result.applied ).toBe( false );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'asset.unreachable', detail: { name: 'missing.ies', asset: 'ies' } } );

	} );

	it( 'records it for a gobo', () => {

		const issues = new IssueLog();
		expect( new GoboManager( pathTracer, { issues } ).setLightGobo( 's', 'missing' ) ).toBe( false );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'asset.unreachable', detail: { name: 'missing', asset: 'gobo' } } );

	} );

	it( 'drops the log on dispose', () => {

		const manager = new IESManager( pathTracer, { issues: new IssueLog() } );
		manager.dispose();
		expect( manager._issues ).toBeNull();

	} );

} );

function lightScene() {

	const scene = new Scene();
	const lights = { spot: new SpotLight(), sun: new DirectionalLight(), point: new PointLight() };
	for ( const light of Object.values( lights ) ) scene.add( light );
	const tracer = {
		scene,
		updateLights: vi.fn(),
		shaderBuilder: { updateIESProfiles: vi.fn(), updateGoboMaps: vi.fn() },
	};
	return { lights, tracer };

}

const downlight = [
	'IESNA:LM-63-2002', 'TILT=NONE',
	'1 1000 1 6 1 1 2 0 0 0', '1 1 100',
	'0 10 20 30 40 90', '0',
	'100 100 80 5 0 0',
].join( '\n' );
const flat = [ 'IESNA:LM-63-2002', 'TILT=NONE', '1 -1 1 2 1 1 2 0 0 0', '1 1 100', '0 180', '0', '50 50' ].join( '\n' );

describe( 'IESManager', () => {

	const files = { 'https://cdn.test/down.ies': downlight, 'https://cdn.test/flat.ies': flat, 'https://cdn.test/bad.ies': 'not a profile' };

	beforeEach( () => {

		vi.stubGlobal( 'fetch', vi.fn( async ( url ) => ( url in files ? new Response( files[ url ] ) : new Response( '', { status: 404 } ) ) ) );

	} );

	afterEach( () => vi.unstubAllGlobals() );

	it( 'stacks every profile into one RGBA texture layer, the shape in R, G and B', async () => {

		const { tracer } = lightScene();
		const manager = new IESManager( tracer );
		const entries = await manager.loadLibrary( [
			{ name: 'down', url: 'https://cdn.test/down.ies' },
			{ name: 'flat', url: 'https://cdn.test/flat.ies' },
		], { gridWidth: 8, gridHeight: 4 } );

		expect( entries ).toEqual( [ { name: 'down', index: 0 }, { name: 'flat', index: 1 } ] );
		const { data, width, height, depth } = manager.texture.image;
		expect( [ width, height, depth ] ).toEqual( [ 8, 4, 2 ] );
		const texel = ( layer, row ) => [ ...data.subarray( ( layer * 32 + row * 8 ) * 4, ( layer * 32 + row * 8 ) * 4 + 4 ) ];
		// Row 0 is 22.5° down: a quarter of the way from 80 to 5 candela.
		expect( texel( 0, 0 ) ).toEqual( [ 156, 156, 156, 255 ] );
		expect( texel( 0, 2 ) ).toEqual( [ 0, 0, 0, 255 ] );
		expect( texel( 1, 3 ) ).toEqual( [ 255, 255, 255, 255 ] );
		expect( tracer.iesProfiles ).toBe( manager.texture );
		expect( tracer.shaderBuilder.updateIESProfiles ).toHaveBeenCalledWith( manager.texture );
		expect( manager.getEntries()[ 0 ] ).toMatchObject( { name: 'down', maxCandela: 100, photometricType: 1, lumens: 1000 } );

	} );

	it( 'warns about a profile it cannot fetch or read and packs the rest', async () => {

		const issues = new IssueLog();
		const { tracer } = lightScene();
		const manager = new IESManager( tracer, { issues } );
		const entries = await manager.loadLibrary( [
			{ name: 'gone', url: 'https://cdn.test/gone.ies' },
			{ name: 'bad', url: 'https://cdn.test/bad.ies' },
			{ name: 'flat', url: 'https://cdn.test/flat.ies' },
		], { gridWidth: 2, gridHeight: 2 } );

		expect( entries ).toEqual( [ { name: 'flat', index: 0 } ] );
		expect( manager.texture.image.depth ).toBe( 1 );
		expect( issues.list.map( i => [ i.code, i.severity, i.detail.url ] ) ).toEqual( [
			[ 'asset.unreachable', 'warning', 'https://cdn.test/gone.ies' ],
			[ 'asset.unreachable', 'warning', 'https://cdn.test/bad.ies' ],
		] );
		expect( issues.list[ 0 ].detail.cause ).toContain( 'HTTP 404' );

	} );

	it( 'keeps the library it has when nothing loads, and frees the old texture on a reload', async () => {

		const { tracer } = lightScene();
		const manager = new IESManager( tracer, { issues: new IssueLog() } );
		expect( await manager.loadLibrary( [] ) ).toEqual( [] );
		expect( await manager.loadLibrary( null ) ).toEqual( [] );

		await manager.loadLibrary( [ { name: 'flat', url: 'https://cdn.test/flat.ies' } ], { gridWidth: 2, gridHeight: 2 } );
		const first = manager.texture;
		expect( await manager.loadLibrary( [ { name: 'gone', url: 'https://cdn.test/gone.ies' } ] ) ).toEqual( [] );
		expect( manager.texture ).toBe( first );

		const disposed = vi.fn();
		first.addEventListener( 'dispose', disposed );
		await manager.loadLibrary( [ { name: 'down', url: 'https://cdn.test/down.ies' } ], { gridWidth: 2, gridHeight: 2 } );
		expect( disposed ).toHaveBeenCalledOnce();
		expect( manager.getEntries().map( e => e.name ) ).toEqual( [ 'down' ] );

	} );

	it( 'fits a spot light\'s cone, penumbra and falloff to the profile it is given', async () => {

		const { lights, tracer } = lightScene();
		const onReset = vi.fn();
		const manager = new IESManager( tracer, { onReset } );
		await manager.loadLibrary( [ { name: 'down', url: 'https://cdn.test/down.ies' } ], { gridWidth: 2, gridHeight: 2 } );
		lights.spot.decay = 1;

		const result = manager.setSpotLightProfile( lights.spot.uuid, 'down', 3 );

		expect( result ).toEqual( { applied: true, suggestedAngle: expect.closeTo( Math.PI / 6, 12 ), suggestedPenumbra: expect.closeTo( 1 / 3, 12 ), suggestedDecay: 2, fixtureLumens: 1000 } );
		expect( lights.spot.angle ).toBeCloseTo( Math.PI / 6, 12 );
		expect( lights.spot.penumbra ).toBeCloseTo( 1 / 3, 12 );
		expect( lights.spot.decay ).toBe( 2 );
		expect( manager.getSpotLightProfile( lights.spot.uuid ) ).toEqual( { name: 'down', index: 0, intensity: 1, fixtureLumens: 1000 } );
		expect( tracer.updateLights ).toHaveBeenCalledOnce();
		expect( onReset ).toHaveBeenCalledOnce();

	} );

	it( 'leaves the cone alone when asked, clears a profile, and ignores anything but a spot light', async () => {

		const { lights, tracer } = lightScene();
		const manager = new IESManager( tracer );
		await manager.loadLibrary( [ { name: 'flat', url: 'https://cdn.test/flat.ies' } ], { gridWidth: 2, gridHeight: 2 } );
		Object.assign( lights.spot, { angle: 0.3, penumbra: 0.2, decay: 1 } );

		const kept = manager.setSpotLightProfile( lights.spot.uuid, 'flat', - 1, { applyAutoCone: false } );
		expect( kept ).toEqual( { applied: true, suggestedAngle: null, suggestedPenumbra: null, suggestedDecay: null, fixtureLumens: - 1 } );
		expect( [ lights.spot.angle, lights.spot.penumbra, lights.spot.decay ] ).toEqual( [ 0.3, 0.2, 1 ] );
		expect( lights.spot.userData.ies.intensity ).toBe( 0 );

		expect( manager.setSpotLightProfile( lights.spot.uuid, null ).applied ).toBe( true );
		expect( manager.getSpotLightProfile( lights.spot.uuid ) ).toBeNull();

		expect( manager.setSpotLightProfile( lights.point.uuid, 'flat' ).applied ).toBe( false );
		expect( lights.point.userData.ies ).toBeUndefined();
		expect( manager.getSpotLightProfile( lights.point.uuid ) ).toBeNull();

	} );

	it( 'frees its texture and lets go of the path tracer on dispose', async () => {

		const { tracer } = lightScene();
		const manager = new IESManager( tracer, { onReset: vi.fn() } );
		await manager.loadLibrary( [ { name: 'flat', url: 'https://cdn.test/flat.ies' } ], { gridWidth: 2, gridHeight: 2 } );
		const disposed = vi.fn();
		manager.texture.addEventListener( 'dispose', disposed );

		manager.dispose();

		expect( disposed ).toHaveBeenCalledOnce();
		expect( [ manager.texture, manager.pathTracer, manager._onReset ] ).toEqual( [ null, null, null ] );
		expect( manager.getEntries() ).toEqual( [] );
		expect( manager.getSpotLightProfile( 'any' ) ).toBeNull();

	} );

} );

describe( 'GoboManager', () => {

	// A decoded image draws as one flat grey; the URL names the grey.
	class FakeImage {

		set src( url ) {

			this.url = url;
			queueMicrotask( () => ( url.includes( 'missing' ) ? this.onerror() : this.onload() ) );

		}

	}

	let ctx;

	beforeEach( () => {

		ctx = {
			clearRect: vi.fn(),
			drawImage: vi.fn( ( img ) => {

				ctx.grey = Number( img.url.match( /(\d+)\.png$/ )[ 1 ] );

			} ),
			getImageData: vi.fn( ( x, y, w, h ) => ( { data: new Uint8ClampedArray( w * h * 4 ).fill( ctx.grey ) } ) ),
		};
		vi.stubGlobal( 'Image', FakeImage );
		vi.stubGlobal( 'document', { createElement: () => ( { getContext: () => ctx } ) } );

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'draws every image at the layer size into one texture layer each, and hands it to the shader', async () => {

		const { tracer } = lightScene();
		const manager = new GoboManager( tracer );
		const entries = await manager.loadLibrary( [ { name: 'window', url: '/g/40.png' }, { name: 'leaves', url: '/g/200.png' } ], { size: 4 } );

		expect( entries ).toEqual( [ { name: 'window', index: 0 }, { name: 'leaves', index: 1 } ] );
		expect( ctx.drawImage ).toHaveBeenCalledWith( expect.objectContaining( { url: '/g/40.png' } ), 0, 0, 4, 4 );
		const { data, width, height, depth } = manager.texture.image;
		expect( [ width, height, depth ] ).toEqual( [ 4, 4, 2 ] );
		expect( data.subarray( 0, 64 ).every( v => v === 40 ) ).toBe( true );
		expect( data.subarray( 64 ).every( v => v === 200 ) ).toBe( true );
		expect( tracer.goboMaps ).toBe( manager.texture );
		expect( tracer.shaderBuilder.updateGoboMaps ).toHaveBeenCalledWith( manager.texture );
		expect( manager.getEntries() ).toEqual( entries );

	} );

	it( 'yields between layers once a draw has taken a frame', async () => {

		let now = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => ( now += 20 ) );
		const timeout = vi.spyOn( globalThis, 'setTimeout' );

		await new GoboManager( lightScene().tracer ).loadLibrary( [ { name: 'a', url: '/g/1.png' }, { name: 'b', url: '/g/2.png' } ], { size: 2 } );

		expect( timeout.mock.calls.filter( ( [ , ms ] ) => ms === 0 ) ).toHaveLength( 2 );

	} );

	it( 'fails the load on an image that will not decode, and frees the old library on a new one', async () => {

		const { tracer } = lightScene();
		const manager = new GoboManager( tracer );
		expect( await manager.loadLibrary( [] ) ).toEqual( [] );
		await expect( manager.loadLibrary( [ { name: 'x', url: '/g/missing.png' } ] ) ).rejects.toThrow( 'Failed to load gobo image: /g/missing.png' );
		expect( manager.texture ).toBeNull();

		await manager.loadLibrary( [ { name: 'a', url: '/g/1.png' } ], { size: 2 } );
		const disposed = vi.fn();
		manager.texture.addEventListener( 'dispose', disposed );
		await manager.loadLibrary( [ { name: 'b', url: '/g/2.png' } ], { size: 2 } );
		expect( disposed ).toHaveBeenCalledOnce();
		expect( manager.getEntries() ).toEqual( [ { name: 'b', index: 0 } ] );

	} );

	async function loaded() {

		const scene = lightScene();
		const onReset = vi.fn();
		const manager = new GoboManager( scene.tracer, { onReset } );
		await manager.loadLibrary( [ { name: 'window', url: '/g/1.png' }, { name: 'leaves', url: '/g/2.png' } ], { size: 2 } );
		return { ...scene, manager, onReset };

	}

	it( 'puts a gobo on a spot or directional light, its strength and scale kept in range', async () => {

		const { lights, tracer, manager, onReset } = await loaded();

		expect( manager.setLightGobo( lights.spot.uuid, 'leaves', { intensity: 2, inverted: 1 } ) ).toBe( true );
		expect( manager.getLightGobo( lights.spot.uuid ) ).toEqual( { name: 'leaves', index: 1, intensity: 1, inverted: true, scale: 5 } );
		expect( manager.setLightGobo( lights.sun.uuid, 'window', { intensity: - 1, scale: 0 } ) ).toBe( true );
		expect( lights.sun.userData.gobo ).toEqual( { name: 'window', index: 0, intensity: 0, inverted: false, scale: 1e-4 } );
		expect( tracer.updateLights ).toHaveBeenCalledTimes( 2 );
		expect( onReset ).toHaveBeenCalledTimes( 2 );

		expect( manager.setLightGobo( lights.point.uuid, 'window' ) ).toBe( false );
		expect( manager.setLightGobo( 'nobody', 'window' ) ).toBe( false );
		expect( lights.point.userData.gobo ).toBeUndefined();

		expect( manager.setLightGobo( lights.spot.uuid, null ) ).toBe( true );
		expect( manager.getLightGobo( lights.spot.uuid ) ).toBeNull();

	} );

	it( 'inverts or rescales an assigned gobo without touching the rest of it', async () => {

		const { lights, tracer, manager } = await loaded();
		expect( manager.setLightGoboInverted( lights.sun.uuid, true ) ).toBe( false );
		expect( manager.setLightGoboScale( lights.sun.uuid, 2 ) ).toBe( false );
		expect( tracer.updateLights ).not.toHaveBeenCalled();

		manager.setLightGobo( lights.sun.uuid, 'leaves', { intensity: 0.5, scale: 3 } );
		expect( manager.setLightGoboInverted( lights.sun.uuid, 'yes' ) ).toBe( true );
		expect( manager.setLightGoboScale( lights.sun.uuid, - 4 ) ).toBe( true );
		expect( lights.sun.userData.gobo ).toEqual( { name: 'leaves', index: 1, intensity: 0.5, inverted: true, scale: 1e-4 } );
		expect( manager.setLightGoboScale( lights.sun.uuid, 7 ) ).toBe( true );
		expect( lights.sun.userData.gobo.scale ).toBe( 7 );
		expect( tracer.updateLights ).toHaveBeenCalledTimes( 4 );

	} );

	it( 'keeps the spot-light names working', async () => {

		const { lights, manager } = await loaded();
		expect( manager.setSpotLightGobo( lights.spot.uuid, 'window', 0.25, true ) ).toBe( true );
		expect( manager.getSpotLightGobo( lights.spot.uuid ) ).toMatchObject( { name: 'window', intensity: 0.25, inverted: true } );
		expect( manager.setSpotLightGoboInverted( lights.spot.uuid, false ) ).toBe( true );
		expect( manager.getSpotLightGobo( lights.spot.uuid ).inverted ).toBe( false );

	} );

	it( 'frees its texture and lets go of the path tracer on dispose', async () => {

		const { lights, manager } = await loaded();
		const disposed = vi.fn();
		manager.texture.addEventListener( 'dispose', disposed );

		manager.dispose();

		expect( disposed ).toHaveBeenCalledOnce();
		expect( [ manager.texture, manager.pathTracer, manager._onReset, manager._issues ] ).toEqual( [ null, null, null, null ] );
		expect( manager.getEntries() ).toEqual( [] );
		expect( manager.getLightGobo( lights.spot.uuid ) ).toBeNull();

	} );

} );
