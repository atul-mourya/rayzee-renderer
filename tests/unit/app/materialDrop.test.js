import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionManager } from '@/core/viewer/camera/InteractionManager.js';

// The app's constants read the window as they load.
vi.hoisted( () => {

	globalThis.window ??= globalThis;
	globalThis.devicePixelRatio ??= 1;
	globalThis.dispatchEvent ??= () => true;

} );

let app;
vi.mock( '@/lib/appProxy', () => ( { getApp: () => app } ) );

const { startMaterialDrag, endMaterialDrag, isMaterialDrag, meshAt, highlightMesh, dropMaterialAt, isMaterialFile, dropMaterialFileAt, SEVERAL_MATERIALS } = await import( '@/lib/materialDrop' );

const dragEvent = () => {

	const types = [];
	return { dataTransfer: { types, effectAllowed: null, setData( type ) {

		types.push( type );

	} } };

};

describe( 'dropping a catalogue material on the view', () => {

	beforeEach( () => {

		app = {
			canvas: { getBoundingClientRect: () => ( { left: 100, top: 50, width: 400, height: 200 } ) },
			interactionManager: { pickSurfaceAsync: vi.fn( async () => ( { object: { name: 'cup' } } ) ), highlight: vi.fn() },
			refreshFrame: vi.fn(),
		};
		endMaterialDrag();
		app.interactionManager.highlight.mockClear();
		app.refreshFrame.mockClear();

	} );

	it( 'picks the mesh under a client point through the view\'s picking, in its device coordinates', async () => {

		expect( await meshAt( 300, 150 ) ).toEqual( { name: 'cup' } );
		expect( app.interactionManager.pickSurfaceAsync ).toHaveBeenLastCalledWith( 0, 0 );
		await meshAt( 100, 50 );
		expect( app.interactionManager.pickSurfaceAsync ).toHaveBeenLastCalledWith( - 1, 1 );
		app.interactionManager.pickSurfaceAsync.mockResolvedValueOnce( null );
		expect( await meshAt( 300, 150 ) ).toBe( null );

	} );

	it( 'applies the dragged item to the mesh it lands on, once, and outlines the selection again', async () => {

		const apply = vi.fn( async () => {} );
		const event = dragEvent();
		startMaterialDrag( event, { name: 'Gold' }, apply );
		expect( isMaterialDrag( event ) ).toBe( true );
		expect( event.dataTransfer.effectAllowed ).toBe( 'copy' );

		highlightMesh( { name: 'cup' } );
		// The item's dragend lands before the pick does: the drop still applies.
		const dropping = dropMaterialAt( 300, 150 );
		endMaterialDrag();
		expect( await dropping ).toBe( true );
		expect( apply ).toHaveBeenCalledWith( { name: 'Gold' }, { name: 'cup' } );
		expect( app.interactionManager.highlight ).toHaveBeenLastCalledWith( null );
		expect( isMaterialDrag( event ) ).toBe( false );
		expect( await dropMaterialAt( 300, 150 ) ).toBe( false );
		expect( apply ).toHaveBeenCalledTimes( 1 );

		startMaterialDrag( dragEvent(), { name: 'Gold' }, apply );
		app.interactionManager.pickSurfaceAsync.mockResolvedValueOnce( null );
		expect( await dropMaterialAt( 300, 150 ) ).toBe( false );
		expect( apply ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'redraws only when the outlined mesh changes', () => {

		const mesh = { name: 'cup' };
		highlightMesh( mesh );
		highlightMesh( mesh );
		expect( app.refreshFrame ).toHaveBeenCalledTimes( 1 );
		highlightMesh( null );
		expect( app.refreshFrame ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'outlines a drop target without selecting it, and the selection again after', () => {

		const outline = { setSelectedObjects: vi.fn() };
		const selected = { name: 'saucer' };
		const manager = Object.assign( Object.create( InteractionManager.prototype ), {
			_overlayManager: { getHelper: () => outline }, selectedObject: selected,
		} );

		manager.highlight( { name: 'cup' } );
		expect( outline.setSelectedObjects ).toHaveBeenLastCalledWith( [ { name: 'cup' } ] );
		expect( manager.selectedObject ).toBe( selected );
		manager.highlight( null );
		expect( outline.setSelectedObjects ).toHaveBeenLastCalledWith( [ selected ] );

	} );

} );

describe( 'dropping a MaterialX file on an object', () => {

	const named = name => ( { name } );
	let cup, saucer, oldMaterial, events;
	beforeEach( () => {

		oldMaterial = { name: 'china' };
		cup = { name: 'cup', material: oldMaterial };
		saucer = { name: 'saucer', material: oldMaterial };
		const meshScene = { traverse: visit => [ cup, saucer, { name: 'table', material: named( 'wood' ) } ].forEach( visit ) };
		app = {
			canvas: { getBoundingClientRect: () => ( { left: 0, top: 0, width: 100, height: 100 } ) },
			interactionManager: { pickSurfaceAsync: vi.fn( async () => ( { object: cup } ) ) },
			meshScene,
			readMaterials: vi.fn( async () => [ { name: 'Brick', material: named( 'Brick' ) }, { name: 'Gold', material: named( 'Gold' ) } ] ),
			rebuildMaterials: vi.fn( async () => {} ),
		};
		events = [];
		vi.spyOn( window, 'dispatchEvent' ).mockImplementation( e => events.push( e ) );

	} );

	it( 'takes .mtlx documents and zips, nothing else', () => {

		expect( [ 'a.mtlx', 'B.MTLX', 'kit.zip', 'model.glb', 'scene.usda', null ].map( name => isMaterialFile( name && { name } ) ) ).toEqual( [ true, true, true, false, false, false ] );

	} );

	it( 'refuses a part with several materials rather than open the file in its place', async () => {

		cup.material = [ oldMaterial, named( 'glaze' ) ];
		await expect( dropMaterialFileAt( { name: 'kit.zip' }, 50, 50 ) ).rejects.toThrow( SEVERAL_MATERIALS );
		expect( app.rebuildMaterials ).not.toHaveBeenCalled();
		// A zip of a model over that part still opens as a file.
		app.readMaterials.mockResolvedValueOnce( null );
		expect( await dropMaterialFileAt( { name: 'chair.zip' }, 50, 50 ) ).toBeNull();

	} );

	it( 'puts the first material on the object and every part sharing its material, then rebuilds', async () => {

		const file = { name: 'kit.zip' };
		const materials = await dropMaterialFileAt( file, 50, 50 );
		expect( materials.map( m => m.name ) ).toEqual( [ 'Brick', 'Gold' ] );
		expect( app.readMaterials ).toHaveBeenCalledWith( file );
		expect( cup.material.name ).toBe( 'Brick' );
		expect( saucer.material ).toBe( cup.material );
		expect( app.rebuildMaterials ).toHaveBeenCalledTimes( 1 );
		expect( events[ 0 ].detail ).toMatchObject( { object: cup, source: 'materialx' } );

	} );

	it( 'leaves the file to open as any file where no object is under it or it holds no material', async () => {

		app.interactionManager.pickSurfaceAsync.mockResolvedValueOnce( null );
		expect( await dropMaterialFileAt( { name: 'a.mtlx' }, 50, 50 ) ).toBe( null );
		expect( app.readMaterials ).not.toHaveBeenCalled();
		app.readMaterials.mockResolvedValueOnce( null );
		expect( await dropMaterialFileAt( { name: 'model.zip' }, 50, 50 ) ).toBe( null );
		expect( cup.material ).toBe( oldMaterial );
		expect( app.rebuildMaterials ).not.toHaveBeenCalled();

	} );

} );
