import { getApp } from '@/lib/appProxy';
import { MaterialService } from '@/services/MaterialService';

/**
 * A catalogue material dragged onto the view: it lands on the object under the cursor, which is outlined meanwhile, and
 * nothing is selected. A drag carries only strings, so the item and how to apply it wait here until the drop.
 */

const MATERIAL_DRAG_TYPE = 'application/x-rayzee-material';
let dragged = null;

/** Starts dragging `item`; `apply( item, mesh )` puts it on the mesh it is dropped on. */
export function startMaterialDrag( event, item, apply ) {

	dragged = { item, apply };
	event.dataTransfer.setData( MATERIAL_DRAG_TYPE, item.name ?? '' );
	event.dataTransfer.effectAllowed = 'copy';

}

/** Ends the drag, dropped or not: the outline goes back to the selection. */
export function endMaterialDrag() {

	dragged = null;
	highlightMesh( null );

}

export const isMaterialDrag = ( event ) => !! dragged && !! event.dataTransfer?.types?.includes( MATERIAL_DRAG_TYPE );

/** The mesh under a client point, or null: the nearest surface the view's picking takes, floor and helpers aside. */
export async function meshAt( clientX, clientY ) {

	const app = getApp();
	const rect = app?.canvas?.getBoundingClientRect();
	if ( ! rect?.width || ! rect.height ) return null;
	const x = ( clientX - rect.left ) / rect.width * 2 - 1;
	const y = - ( clientY - rect.top ) / rect.height * 2 + 1;
	return ( await app.interactionManager?.pickSurfaceAsync( x, y ) )?.object ?? null;

}

let highlighted = null;

/** Outlines the drop target (null: the selection again), redrawing only when it changes. */
export function highlightMesh( mesh ) {

	if ( mesh === highlighted ) return;
	highlighted = mesh;
	const app = getApp();
	app?.interactionManager?.highlight( mesh );
	app?.refreshFrame();

}

/**
 * Applies the dragged material to the mesh under a client point; false when nothing is being dragged or hit. The drag is
 * taken at once: the item's dragend can end it before the pick lands.
 */
export async function dropMaterialAt( clientX, clientY ) {

	const drag = dragged;
	endMaterialDrag();
	if ( ! drag ) return false;
	const mesh = await meshAt( clientX, clientY );
	if ( ! mesh ) return false;
	await drag.apply( drag.item, mesh );
	return true;

}

/** A file that may hold MaterialX materials: a document, or a zip of documents and their textures. */
export const isMaterialFile = ( file ) => /\.(mtlx|zip)$/i.test( file?.name ?? '' );

/**
 * A MaterialX file dropped from the desktop onto an object: its first material goes on the object, and on every part
 * sharing the object's material. Resolves to the materials the file holds, or null when no object is under the point or
 * the file holds no MaterialX material (a zip of a model): then it opens as any file does.
 */
export async function dropMaterialFileAt( file, clientX, clientY ) {

	return applyMaterialFile( file, await meshAt( clientX, clientY ) );

}

export const SEVERAL_MATERIALS = 'This part uses several materials; a MaterialX material replaces one.';

/**
 * The first MaterialX material of `file` (a document, or a zip of documents and textures) on `mesh` and every part
 * sharing its material. Resolves to the file's materials, or null when the file holds none (or there is no mesh);
 * throws SEVERAL_MATERIALS for a part with several, so the file is not opened in its place.
 */
export async function applyMaterialFile( file, mesh ) {

	const app = getApp();
	if ( ! mesh?.material || ! app?.readMaterials ) return null;
	const materials = await app.readMaterials( file );
	if ( ! materials?.length ) return null;
	if ( Array.isArray( mesh.material ) ) throw new Error( SEVERAL_MATERIALS );
	const { material } = materials[ 0 ];
	MaterialService.replaceMaterial( app.meshScene, mesh.material, material );
	mesh.material = material;
	await app.rebuildMaterials();
	window.dispatchEvent( new CustomEvent( 'MaterialUpdate', { detail: { object: mesh, material, source: 'materialx' } } ) );
	return materials;

}
