/**
 * The renderer core's colour management: linear Rec.709, three.js's built-in view transforms, nothing converted — what
 * the OCIO `ColorManagement` (rayzee/addons/color) does with no config loaded. `renderer.setColorManagement(
 * ColorManagement )` replaces it.
 */

import { SRGBColorSpace } from 'three';
import { DEFAULT_WORKING_SPACE, getActiveColorManagement, setActiveColorManagement } from './ActiveColor.js';
import { registerWithRenderer, onRegistryChange, getViewTransform, listViewTransforms, getRegistryVersion } from './ViewTransforms.js';
import { setWorkingMatrix } from './WorkingMatrix.js';
import { ISSUE_CODES } from '../EngineIssues.js';

export class BasicColor {

	constructor( { issues = null } = {} ) {

		this._issues = issues;
		this._renderer = null;
		this._offRegistry = onRegistryChange( () => {

			if ( this._renderer ) registerWithRenderer( this._renderer );

		} );

	}

	get hasConfig() {

		return false;

	}

	get workingSpace() {

		return DEFAULT_WORKING_SPACE;

	}

	get workingSpaceAdopted() {

		return false;

	}

	/** Part of a converted texture's cache key: nothing is converted here. */
	get inputKey() {

		return '-';

	}

	attachRenderer( renderer ) {

		this._renderer = renderer;
		const n = registerWithRenderer( renderer );
		renderer.outputColorSpace = SRGBColorSpace;
		return n;

	}

	_publishWorkingMatrix() {

		setWorkingMatrix( null, DEFAULT_WORKING_SPACE );

	}

	/** Colour configs, views and working spaces need the OCIO pipeline. */
	loadConfig() {

		const message = 'colour configs need the OCIO pipeline: renderer.setColorManagement( ColorManagement ), from rayzee/addons/color';
		this._issues?.record( ISSUE_CODES.CAPABILITY_MISSING, message, { capability: 'color' } );
		return Promise.reject( new Error( message ) );

	}

	unloadConfig() {}

	setWorkingSpace() {}

	/** No export space without a config: the working space as it is. */
	exportPixels( rgba ) {

		return { rgba, colorSpace: DEFAULT_WORKING_SPACE };

	}

	status() {

		const active = this._renderer ? getViewTransform( this._renderer.toneMapping ) : null;
		return {
			config: null,
			workingSpace: DEFAULT_WORKING_SPACE,
			workingSpaceAdopted: false,
			activeTransform: active ? { id: active.id, name: active.name, source: active.source } : null,
			activeView: null,
			context: null,
			exportSpace: null,
			views: listViewTransforms(),
			registryVersion: getRegistryVersion(),
			bakeError: active?.error ?? null,
		};

	}

	dispose() {

		this._offRegistry?.();
		this._renderer = null;
		this._issues = null;
		if ( getActiveColorManagement() === this ) {

			setWorkingMatrix( null );
			setActiveColorManagement( null );

		}

	}

}
