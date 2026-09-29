import { toPortable, fromPortable } from 'rayzee';
import { useStore, useAssetsStore, usePathTracerStore, useCameraStore } from '@/store';

// What each panel store keeps across a reload. The engine's own state travels separately
// (app.exportSceneState); this is only what the panels show. Lists derived from the engine —
// lights, cameras, timeline keys — are re-read from it instead.
const PANELS = {
	pathTracer: { store: usePathTracerStore, omit: [ 'currentAutoExposure', 'currentAvgLuminance', 'showInspector', 'retouchVisible', 'neuralRendering', 'appMode', 'canvasWidth', 'canvasHeight' ] },
	camera: { store: useCameraStore, omit: [ 'cameraNames', 'selectedCameraIndex', 'afPlacingPoint', 'selectMode', 'modelDimensions' ] },
	assets: { store: useAssetsStore, only: [ 'model', 'environment', 'selectedEnvironmentIndex' ] },
	main: { store: useStore, only: [ 'transformMode', 'transformSpace' ] },
};

function wanted( key, { omit, only } ) {

	if ( key.startsWith( '_' ) ) return false;
	if ( only ) return only.includes( key );
	return ! omit.includes( key );

}

/** The panels' plain values, JSON-safe. */
export function snapshotPanels() {

	const out = {};
	for ( const [ name, panel ] of Object.entries( PANELS ) ) {

		const values = {};
		for ( const [ key, value ] of Object.entries( panel.store.getState() ) ) {

			if ( typeof value === 'function' || ! wanted( key, panel ) ) continue;
			const portable = toPortable( value );
			if ( portable !== undefined ) values[ key ] = portable;

		}

		out[ name ] = values;

	}

	return out;

}

/**
 * Puts {@link snapshotPanels}'s values back. Only keys the store still has, of the same kind,
 * are taken, so a session saved by an older app cannot put a stale shape into a newer panel.
 */
export function restorePanels( snapshot ) {

	for ( const [ name, panel ] of Object.entries( PANELS ) ) {

		const saved = snapshot?.[ name ];
		if ( ! saved ) continue;

		const state = panel.store.getState();
		const next = {};
		for ( const [ key, portable ] of Object.entries( saved ) ) {

			if ( ! ( key in state ) || typeof state[ key ] === 'function' || ! wanted( key, panel ) ) continue;
			const value = fromPortable( portable );
			const current = state[ key ];
			const sameKind = current === null || value === null || typeof current === typeof value;
			if ( sameKind ) next[ key ] = value;

		}

		panel.store.setState( next );

	}

}
