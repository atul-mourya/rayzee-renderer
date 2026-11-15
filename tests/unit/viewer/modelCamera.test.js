import { describe, it, expect } from 'vitest';
import { PathTracerApp } from '@/core/viewer/PathTracerApp.js';

describe( 'PathTracerApp — the camera a replaced model opens through', () => {

	function replaceWith( cameras, previousIndex ) {

		const switches = [];
		const cameraManager = {
			cameras,
			currentCameraIndex: previousIndex,
			// The view is levelled before the load's update: a rolled camera of the last model's leaves no tilt.
			_setUp( up ) {

				switches.push( { up: up.toArray() } );

			},
			switchCamera( index ) {

				switches.push( { index, from: this.currentCameraIndex } );
				this.currentCameraIndex = index;

			},
		};
		const receiver = Object.assign( Object.create( PathTracerApp.prototype ), { cameraManager, _syncControlsAfterLoad() {} } );
		receiver._modelReplaced();
		return { switches, current: cameraManager.currentCameraIndex };

	}

	it( 'switches to the model\'s first camera, leaving the default where it was', () => {

		expect( replaceWith( [ 'default', 'model A', 'model B' ], 0 ) ).toEqual( { switches: [ { up: [ 0, 1, 0 ] }, { index: 1, from: 0 } ], current: 1 } );

	} );

	it( 'switches from the default even when the previous model had another camera selected', () => {

		expect( replaceWith( [ 'default', 'model A' ], 3 ) ).toEqual( { switches: [ { up: [ 0, 1, 0 ] }, { index: 1, from: 0 } ], current: 1 } );

	} );

	it( 'stays on the default camera for a model without cameras', () => {

		expect( replaceWith( [ 'default' ], 2 ) ).toEqual( { switches: [ { up: [ 0, 1, 0 ] } ], current: 0 } );

	} );

} );
