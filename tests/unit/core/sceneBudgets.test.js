/**
 * Unless the memory spill is off, a scene archive's triangle and placement budgets rise to the spill ones; a host's own
 * numbers always win. Each build spills under 'auto' only past the in-memory line. Called off the prototype, as
 * sceneObjectLookup does.
 */
import { describe, expect, it, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { SPILL_TRIANGLE_BUDGET, SPILL_PLACEMENT_BUDGET } from '@/core/Processor/PBRT/index.js';
import { SPILL_ENVIRONMENT_WIDTH, SAFE_SCENE_BYTES, estimateSceneBytes } from '@/core/Processor/HostMemory.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';

const budgets = ( app, options ) => PathTracerApp.prototype._sceneBudgets.call( app, options );

describe( 'PathTracerApp scene budgets', () => {

	it( 'raises both budgets when the build can spill', () => {

		for ( const mode of [ true, 'auto' ] ) expect( budgets( { _memorySpill: mode, storage: {} }, { element: [ 'a' ] } ) ).toEqual( {
			maxTriangles: SPILL_TRIANGLE_BUDGET, maxPlacements: SPILL_PLACEMENT_BUDGET, element: [ 'a' ],
		} );

	} );

	it( 'keeps what the host asked for', () => {

		expect( budgets( { _memorySpill: true, storage: {} }, { maxTriangles: 10 } ).maxTriangles ).toBe( 10 );

	} );

	it( 'leaves the options alone without the spill or without storage', () => {

		const options = { element: 'a' };
		expect( budgets( { _memorySpill: false, storage: {} }, options ) ).toBe( options );
		expect( budgets( { _memorySpill: true, storage: null }, options ) ).toBe( options );

	} );

} );

describe( 'PathTracerApp spill plan', () => {

	const plan = ( { mode = 'auto', storage = {}, animations = [], big = false, environment = null } = {} ) => {

		const app = {
			_memorySpill: mode, storage, meshScene: { environment }, assetLoader: { animations, maxEnvironmentWidth: 0 },
			_sdf: { needsSpill: () => big }, _chunkUploader: () => 'uploader',
		};
		const spill = PathTracerApp.prototype._planSpill.call( app );
		return { app, spill };

	};

	it( 'spills under auto only a scene past the in-memory line, and narrows only its environment', () => {

		expect( plan().spill ).toBe( false );
		expect( plan().app.assetLoader.maxEnvironmentWidth ).toBe( 0 );
		const { app, spill } = plan( { big: true } );
		expect( spill ).toBe( true );
		expect( app.assetLoader.maxEnvironmentWidth ).toBe( SPILL_ENVIRONMENT_WIDTH );

	} );

	it( 'narrows a sky the importer already installed, only for a spilling scene', () => {

		const sky = () => ( {
			image: { data: new Float32Array( 16384 * 2 * 4 ).fill( 1 ), width: 16384, height: 2 },
			needsUpdate: false, dispose: vi.fn(),
		} );
		const kept = sky();
		plan( { environment: kept } );
		expect( kept.image.width ).toBe( 16384 );
		expect( kept.dispose ).not.toHaveBeenCalled();
		const narrowed = sky();
		plan( { big: true, environment: narrowed } );
		expect( narrowed.image.width ).toBe( SPILL_ENVIRONMENT_WIDTH );
		expect( narrowed.image.data.length ).toBe( SPILL_ENVIRONMENT_WIDTH * 4 );
		expect( narrowed.dispose ).toHaveBeenCalledOnce();
		expect( narrowed.needsUpdate ).toBe( true );

	} );

	it( 'spills every static scene when on, none when off, without storage or with a clip', () => {

		expect( plan( { mode: true } ).spill ).toBe( true );
		expect( plan( { mode: false, big: true } ).spill ).toBe( false );
		expect( plan( { storage: null, big: true } ).spill ).toBe( false );
		expect( plan( { mode: true, animations: [ {} ] } ).spill ).toBe( false );

	} );

	it( 'hands a plan made before the load to its build once, then plans again', () => {

		const { app } = plan( { big: true } );
		const progressive = () => PathTracerApp.prototype._progressiveSpill.call( app );
		app._planSpill = PathTracerApp.prototype._planSpill;
		app._sdf.needsSpill = () => false;
		expect( progressive() ).toEqual( { storage: app.storage, uploader: 'uploader' } );
		expect( progressive() ).toBe( null );

	} );

	it( 'takes only auto, true or false', () => {

		const app = {};
		for ( const [ given, mode ] of [[ true, true ], [ false, false ], [ 'auto', 'auto' ], [ undefined, 'auto' ], [ 'yes', 'auto' ]] ) {

			PathTracerApp.prototype.setMemorySpill.call( app, given );
			expect( app._memorySpill ).toBe( mode );

		}

	} );

} );

describe( 'SceneProcessor.needsSpill', () => {

	it( 'compares the in-memory estimate with the safe line', () => {

		const survey = { triangles: 1e6, placements: 1e3, geometryBytes: 0, instanceBytes: 0 };
		const processor = Object.create( SceneProcessor.prototype );
		processor.geometryExtractor = { surveyScene: () => survey };
		expect( processor.needsSpill( {} ) ).toBe( false );
		const perTriangle = estimateSceneBytes( { ...survey, triangles: 2e6 } ).total - estimateSceneBytes( survey ).total;
		survey.triangles = Math.ceil( SAFE_SCENE_BYTES / ( perTriangle / 1e6 ) );
		expect( estimateSceneBytes( survey ).total ).toBeGreaterThan( SAFE_SCENE_BYTES );
		expect( processor.needsSpill( {} ) ).toBe( true );

	} );

} );
