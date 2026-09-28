/**
 * A scene's state after it loaded: everything a host or user changed, as plain data. Saved
 * sessions and project files carry it; the model itself is the host's to reload first.
 *
 * Objects, materials and cameras are matched by position in this load plus a name check, never by
 * UUID — those change on every load.
 */

import { VERSION } from '../version.js';
import { fromPortable } from './portable.js';

export const SCENE_STATE_VERSION = 1;

const isUrl = source => typeof source === 'string' && /^https?:\/\//.test( source );

function pathOf( object, root ) {

	const path = [];
	while ( object && object !== root ) {

		const parent = object.parent;
		if ( ! parent ) return null;
		path.unshift( parent.children.indexOf( object ) );
		object = parent;

	}

	return object === root ? path : null;

}

function objectAt( root, path ) {

	let object = root;
	for ( const index of path ) {

		object = object?.children[ index ];
		if ( ! object ) return null;

	}

	return object;

}

function signature( app ) {

	return {
		key: app.assetLoader?.sceneSourceKey ?? null,
		name: app.sceneModel?.name ?? null,
		meshes: app.sceneMeshes.length,
		materials: app.stages.pathTracer?.materialData.materialCount ?? 0,
	};

}

function materialsByIndex( app ) {

	const out = new Map();
	for ( const mesh of app.sceneMeshes ) {

		const index = mesh.userData?.materialIndex;
		if ( index !== undefined && ! out.has( index ) ) out.set( index, Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material );

	}

	return out;

}

function colorState( cm ) {

	if ( ! cm ) return null;
	const status = cm.status();
	const view = status.activeView;
	const configId = status.config?.id ?? view?.configId ?? null;

	return {
		config: configId ? { id: configId } : null,
		view: view ? { display: view.display, view: view.view, look: view.look ?? null } : null,
		transform: view ? null : status.activeTransform?.id ?? null,
		workingSpace: status.workingSpaceAdopted ? status.workingSpace : null,
		context: status.context ?? null,
	};

}

/**
 * @param {import('../PathTracerApp.js').PathTracerApp} app
 * @returns {Object} JSON-safe
 */
export function captureSceneState( app ) {

	const root = app.meshScene;
	const materials = materialsByIndex( app );

	const hidden = [];
	root.traverse( object => {

		if ( object !== root && object.visible === false ) hidden.push( pathOf( object, root ) );

	} );

	return {
		v: SCENE_STATE_VERSION,
		engine: VERSION,
		savedAt: Date.now(),
		scene: signature( app ),
		appended: root.children
			.filter( c => c !== app.sceneModel && c.userData?.__rayzeeSceneObject )
			.map( c => ( { name: c.userData.__rayzeeName ?? c.name, url: c.userData.__rayzeeSourceUrl ?? null, cacheKey: c.userData.__rayzeeCacheKey ?? null } ) ),
		settings: app.settings.serialize(),
		environment: app.environmentManager?.serialize() ?? null,
		color: colorState( app.color ),
		lights: app.lightManager.serialize(),
		cameras: app.cameraManager.serialize(),
		timeline: app.timeline?.serialize() ?? null,
		materials: ( app.stages.pathTracer?.materialData.serializeHostEdits() ?? [] ).map( edit => ( { ...edit, name: materials.get( edit.index )?.name ?? '' } ) ),
		hidden,
		moved: ( app.transformManager?.movedObjects ?? [] ).map( object => ( {
			path: pathOf( object, root ),
			name: object.name,
			position: object.position.toArray(),
			quaternion: object.quaternion.toArray(),
			scale: object.scale.toArray(),
		} ) ).filter( m => m.path ),
	};

}

function applyMaterialValue( material, property, value ) {

	const current = material[ property ];
	if ( current?.copy && ( value?.isColor || value?.isVector2 || value?.isVector3 ) ) current.copy( value );
	else material[ property ] = value;
	material.needsUpdate = true;

}

async function restoreEnvironment( app, env, resolve, skip ) {

	if ( ! env ) return;
	const manager = app.environmentManager;

	if ( env.hdri && env.hdri !== manager.hdriSource ) {

		const input = isUrl( env.hdri ) ? env.hdri : await resolve( { kind: 'environment', source: env.hdri } );
		try {

			if ( typeof input === 'string' ) await app.loadEnvironment( input );
			else if ( input ) await app.loadFile( input );
			else skip( 'environment', 'source unavailable', { source: env.hdri } );

		} catch ( error ) {

			skip( 'environment', error.message, { source: env.hdri } );

		}

	}

	await manager.restore( env );

}

async function restoreColor( app, color, resolve, skip ) {

	const cm = app.color;
	if ( ! color || ! cm ) return;

	const status = cm.status();
	const active = status.activeView;
	const sameView = !! color.view && !! active
		&& active.display === color.view.display && active.view === color.view.view && ( active.look ?? null ) === color.view.look;
	const loadedId = status.config?.id ?? null;
	const shownId = loadedId ?? active?.configId ?? null;
	const settled = ( color.config?.id ?? null ) === shownId && ! color.workingSpace && ! color.context
		&& ( color.view ? sameView : ! active && ( ! color.transform || color.transform === status.activeTransform?.id ) );
	if ( settled ) return;

	try {

		if ( color.config && color.config.id !== loadedId ) {

			if ( ! await resolve( { kind: 'colorConfig', config: color.config } ) ) {

				const builtins = await cm.constructor.listBuiltinConfigs().catch( () => [] );
				const known = builtins.some( b => ( b.name ?? b ) === color.config.id || `ocio://${b.name ?? b}` === color.config.id );
				if ( ! known ) {

					skip( 'color', 'config unavailable', { config: color.config.id } );
					return;

				}

				await app.loadColorConfig( { builtin: color.config.id, registerViews: false } );

			}

		} else if ( ! color.config && loadedId ) {

			await app.unloadColorConfig();

		}

		if ( color.context ) cm.setContext( color.context );
		if ( color.view ) cm.setView( color.view );
		else if ( color.transform ) cm.setActiveView( color.transform );

		if ( ( color.workingSpace ?? null ) !== ( cm.workingSpaceAdopted ? cm.workingSpace : null ) ) {

			cm.setWorkingSpace( color.workingSpace );
			await app.applyColorWorkingSpace();

		}

	} catch ( error ) {

		skip( 'color', error.message, { config: color.config?.id ?? null } );

	}

}

/**
 * Applies a captured state to the scene now loaded. Call once the model has loaded.
 *
 * @param {import('../PathTracerApp.js').PathTracerApp} app
 * @param {Object} state - from {@link captureSceneState}
 * @param {Object} [options]
 * @param {function(Object): Promise<*>} [options.resolve] - the host's answer for an input the
 *   engine cannot reach itself: `{ kind: 'environment', source }` → a File, a URL or null;
 *   `{ kind: 'colorConfig', config }` → true once the host has loaded it
 * @returns {Promise<{skipped: Array<{section: string, reason: string}>}>} what could not be put back
 */
export async function applySceneState( app, state, { resolve = async () => null } = {} ) {

	if ( state?.v !== SCENE_STATE_VERSION ) throw new Error( `scene state version ${state?.v} is not ${SCENE_STATE_VERSION}` );

	const skipped = [];
	const skip = ( section, reason, detail = {} ) => skipped.push( { section, reason, ...detail } );

	for ( const model of state.appended ?? [] ) {

		if ( ! model.url ) {

			skip( 'appended', 'added from memory, not a file', { name: model.name } );
			continue;

		}

		try {

			await app.addModel( model.url, { name: model.name, cacheKey: model.cacheKey ?? undefined } );

		} catch ( error ) {

			skip( 'appended', error.message, { name: model.name } );

		}

	}

	const now = signature( app );
	const saved = state.scene ?? {};
	const sameScene = saved.meshes === now.meshes && saved.materials === now.materials;
	if ( ! sameScene ) skip( 'scene', 'the loaded scene is not the one saved: objects and materials left as loaded', { saved, now } );

	await restoreEnvironment( app, state.environment, resolve, skip );
	await restoreColor( app, state.color, resolve, skip );

	const unknown = app.settings.restore( state.settings );
	if ( unknown.length ) skip( 'settings', 'not settings in this engine', { keys: unknown } );

	const lights = app.lightManager.restore( state.lights );
	for ( const light of lights ) {

		const { gobo, ies } = light.userData;
		if ( gobo && app.goboManager?.entries?.length ) app.goboManager.setLightGobo( light.uuid, gobo.name, gobo );
		if ( ies && app.iesManager?.entries?.length ) app.iesManager.setSpotLightProfile( light.uuid, ies.name, ies.intensity, { applyAutoCone: false } );

	}

	if ( sameScene ) {

		const materials = materialsByIndex( app );
		for ( const edit of state.materials ?? [] ) {

			const material = materials.get( edit.index );
			if ( ! material || ( material.name ?? '' ) !== edit.name ) {

				skip( 'materials', 'no such material', { index: edit.index, name: edit.name } );
				continue;

			}

			for ( const [ property, portable ] of Object.entries( edit.props ) ) {

				const value = fromPortable( portable );
				applyMaterialValue( material, property, value );
				app.setMaterialProperty( edit.index, property, value );

			}

		}

		const root = app.meshScene;
		const hidden = new Set( ( state.hidden ?? [] ).map( path => objectAt( root, path ) ).filter( Boolean ) );
		root.traverse( object => {

			if ( object !== root && ! object.isLight ) object.visible = ! hidden.has( object );

		} );
		app.updateAllMeshVisibility();

		const moved = [];
		for ( const entry of state.moved ?? [] ) {

			const object = objectAt( root, entry.path );
			if ( ! object || object.name !== entry.name ) {

				skip( 'moved', 'no such object', { name: entry.name } );
				continue;

			}

			object.position.fromArray( entry.position );
			object.quaternion.fromArray( entry.quaternion );
			object.scale.fromArray( entry.scale );
			object.updateMatrixWorld( true );
			app.transformManager?.noteMoved( object );
			moved.push( object );

		}

		if ( moved.length ) {

			const affected = [];
			app.sceneMeshes.forEach( ( mesh, index ) => {

				for ( let o = mesh; o; o = o.parent ) {

					if ( moved.includes( o ) ) {

						affected.push( index );
						break;

					}

				}

			} );
			if ( affected.length ) app.updateMeshTransforms( affected );

		}

	}

	const { mismatched } = app.cameraManager.restore( state.cameras );
	if ( mismatched.length ) skip( 'cameras', 'model cameras changed', { names: mismatched } );
	app._dispatchCamerasUpdated();
	app.timeline?.restore( state.timeline );

	app.reset();
	return { skipped };

}
