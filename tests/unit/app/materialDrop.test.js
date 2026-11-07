import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionManager } from '@/core/viewer/camera/InteractionManager.js';

let app;
vi.mock( '@/lib/appProxy', () => ( { getApp: () => app } ) );

const { startMaterialDrag, endMaterialDrag, isMaterialDrag, meshAt, highlightMesh, dropMaterial } = await import( '@/lib/materialDrop' );

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
			interactionManager: { pickSurface: vi.fn( () => ( { object: { name: 'cup' } } ) ), highlight: vi.fn() },
			refreshFrame: vi.fn(),
		};
		endMaterialDrag();
		app.interactionManager.highlight.mockClear();
		app.refreshFrame.mockClear();

	} );

	it( 'picks the mesh under a client point through the view\'s picking, in its device coordinates', () => {

		expect( meshAt( 300, 150 ) ).toEqual( { name: 'cup' } );
		expect( app.interactionManager.pickSurface ).toHaveBeenLastCalledWith( 0, 0 );
		meshAt( 100, 50 );
		expect( app.interactionManager.pickSurface ).toHaveBeenLastCalledWith( - 1, 1 );

	} );

	it( 'applies the dragged item to the mesh it lands on, once, and outlines the selection again', async () => {

		const apply = vi.fn( async () => {} );
		const event = dragEvent();
		startMaterialDrag( event, { name: 'Gold' }, apply );
		expect( isMaterialDrag( event ) ).toBe( true );
		expect( event.dataTransfer.effectAllowed ).toBe( 'copy' );

		const mesh = { name: 'cup' };
		highlightMesh( mesh );
		expect( await dropMaterial( mesh ) ).toBe( true );
		expect( apply ).toHaveBeenCalledWith( { name: 'Gold' }, mesh );
		expect( app.interactionManager.highlight ).toHaveBeenLastCalledWith( null );
		expect( isMaterialDrag( event ) ).toBe( false );
		expect( await dropMaterial( mesh ) ).toBe( false );
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
