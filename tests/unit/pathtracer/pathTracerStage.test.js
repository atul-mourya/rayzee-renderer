import { describe, it, expect, vi, afterEach } from 'vitest';
import { BufferAttribute } from 'three';
import { PathTracerStage, measureUploadPacing, textureLayerSink } from '@/core/pathtracer/PathTracerStage.js';
import { UniformManager, LIGHT_FLOATS, LIGHT_LIST_STEP, lightListCapacity } from '@/core/pathtracer/UniformManager.js';

// The stage needs a WebGPU renderer to construct, but the completion-threshold methods only
// touch three plain fields — call them against a bare receiver.
function makeReceiver( { renderMode = 0, maxSamples = 30, renderLimitMode = 'frames', renderTimeLimit = 0 } = {} ) {

	return {
		renderMode: { value: renderMode },
		maxSamples: { value: maxSamples },
		renderLimitMode,
		renderTimeLimit,
		completionThreshold: 0,
		updateCompletionThreshold: PathTracerStage.prototype.updateCompletionThreshold,
		setRenderLimitMode: PathTracerStage.prototype.setRenderLimitMode,
	};

}

describe( 'PathTracerStage completion threshold', () => {

	it( 'tracks maxSamples in frames mode', () => {

		const stage = makeReceiver( { maxSamples: 64 } );
		stage.updateCompletionThreshold();
		expect( stage.completionThreshold ).toBe( 64 );

	} );

	// Regression: time mode used to set the threshold to Infinity, which erased the sample
	// ceiling instead of adding a deadline to it. A generous budget then uncapped the render
	// and a disarmed one made it unbounded.
	it( 'keeps the sample ceiling in time mode', () => {

		const stage = makeReceiver( { maxSamples: 30 } );
		stage.setRenderLimitMode( 'time' );
		expect( stage.completionThreshold ).toBe( 30 );

	} );

	it( 'is independent of the limit mode', () => {

		const thresholds = [ 'frames', 'time' ].map( mode => {

			const stage = makeReceiver( { maxSamples: 128 } );
			stage.setRenderLimitMode( mode );
			return stage.completionThreshold;

		} );

		expect( thresholds[ 0 ] ).toBe( thresholds[ 1 ] );
		expect( thresholds[ 0 ] ).toBeLessThan( Infinity );

	} );

	// The app's Time chip: render until the deadline, however many samples that takes.
	it( 'lifts the ceiling in timeOnly mode while a deadline is armed', () => {

		const stage = makeReceiver( { maxSamples: 30 } );
		stage.setRenderLimitMode( 'timeOnly', 20 );
		expect( stage.completionThreshold ).toBe( Infinity );

	} );

	// Nothing else could stop it.
	it( 'keeps the ceiling in timeOnly mode with the deadline disarmed', () => {

		const stage = makeReceiver( { maxSamples: 30 } );
		stage.setRenderLimitMode( 'timeOnly', 0 );
		expect( stage.completionThreshold ).toBe( 30 );
		stage.setRenderLimitMode( 'timeOnly', 5 );
		expect( stage.completionThreshold ).toBe( Infinity );
		stage.setRenderLimitMode( 'timeOnly', 0 );
		expect( stage.completionThreshold ).toBe( 30 );

	} );

	it( 'keeps the time limit across a mode change and a new maxSamples', () => {

		const stage = makeReceiver( { maxSamples: 30, renderTimeLimit: 10 } );
		stage.setRenderLimitMode( 'timeOnly' );
		expect( stage.completionThreshold ).toBe( Infinity );
		stage.maxSamples.value = 500;
		stage.updateCompletionThreshold();
		expect( stage.completionThreshold ).toBe( Infinity );

	} );

	it( 'setRenderLimitMode records the mode and refreshes the threshold', () => {

		const stage = makeReceiver( { maxSamples: 10 } );
		stage.setRenderLimitMode( 'time' );
		expect( stage.renderLimitMode ).toBe( 'time' );
		stage.maxSamples.value = 200;
		stage.setRenderLimitMode( 'frames' );
		expect( stage.completionThreshold ).toBe( 200 );

	} );

} );

describe( 'PathTracerStage BVH uploads', () => {

	const makeStage = () => ( {
		bvhStorageAttr: new BufferAttribute( new Float32Array( 16 * 8 ), 4 ),
		_dirtyBVHLeaves: new Set(),
		_flushBVHEdits: PathTracerStage.prototype._flushBVHEdits,
		_updateStorageBuffer: PathTracerStage.prototype._updateStorageBuffer,
		updateBVHData: PathTracerStage.prototype.updateBVHData,
		updateBufferRanges: PathTracerStage.prototype.updateBufferRanges,
	} );

	it( 'a ranged update copies and uploads only those ranges from records held elsewhere', () => {

		const stage = makeStage();
		const records = new Float32Array( 16 * 8 ).fill( 7 );

		stage.updateBVHData( { chunks: [ records ] }, [ { offset: 0, count: 16 }, { offset: 48, count: 32 } ] );

		const own = stage.bvhStorageAttr.array;
		expect( own.slice( 0, 16 ).every( v => v === 7 ) ).toBe( true );
		expect( own.slice( 16, 48 ).every( v => v === 0 ) ).toBe( true );
		expect( own.slice( 48, 80 ).every( v => v === 7 ) ).toBe( true );
		expect( stage.bvhStorageAttr.updateRanges ).toEqual( [ { start: 0, count: 16 }, { start: 48, count: 32 } ] );

	} );

	it( 'uploads only the TLAS leaves a visibility edit touched', () => {

		const stage = makeStage();
		stage._dirtyBVHLeaves.add( 2 ).add( 3 );
		stage._flushBVHEdits();

		expect( stage.bvhStorageAttr.updateRanges ).toEqual( [ { start: 32, count: 32 } ] );

	} );

	// Regression: the range a visibility edit left pending cut the next full upload down to it,
	// so a refit straight after a load reached the GPU as two TLAS leaves and nothing else.
	it( 'a full upload after a visibility edit still uploads everything', () => {

		const stage = makeStage();
		stage._dirtyBVHLeaves.add( 1 );
		stage._flushBVHEdits();
		const version = stage.bvhStorageAttr.version;

		stage.updateBVHData( new Float32Array( 16 * 8 ).fill( 1 ) );

		expect( stage.bvhStorageAttr.updateRanges ).toEqual( [] );
		expect( stage.bvhStorageAttr.version ).toBeGreaterThan( version );

	} );

} );

describe( 'PathTracerStage light lists', () => {

	const TYPES = [ 'directional', 'area', 'point', 'spot' ];
	const COUNT = { directional: 'numDirectionalLights', area: 'numAreaLights', point: 'numPointLights', spot: 'numSpotLights' };

	function makeStage() {

		const nodes = new UniformManager( 4, 4 ).getLightBufferNodes();
		const stage = Object.create( PathTracerStage.prototype );
		stage._lightBufferRealloc = false;
		for ( const type of TYPES ) {

			stage[ `${type}LightsBufferNode` ] = nodes[ type ];
			stage[ `${type}LightsData` ] = null;
			stage[ COUNT[ type ] ] = { value: 0 };

		}

		return stage;

	}

	const lights = ( type, n ) => Float32Array.from( { length: n * LIGHT_FLOATS[ type ] }, ( _, i ) => i + 1 );

	// The shader bakes each list's length: a list sized per scene made a new program per light count.
	it( 'writes lights into the list it was built with, whatever the count', () => {

		const stage = makeStage();
		const lists = TYPES.map( ( type ) => stage[ `${type}LightsBufferNode` ].array );

		for ( const n of [ 2, 5, 0, 16 ] ) {

			for ( const type of TYPES ) stage[ `${type}LightsData` ] = lights( type, n );
			stage._updateLightBufferNodes();

			TYPES.forEach( ( type, i ) => {

				const { array } = stage[ `${type}LightsBufferNode` ];
				const used = n * LIGHT_FLOATS[ type ];
				expect( array ).toBe( lists[ i ] );
				expect( array.length ).toBe( LIGHT_FLOATS[ type ] * LIGHT_LIST_STEP );
				expect( Array.from( array.subarray( 0, used ) ) ).toEqual( Array.from( lights( type, n ) ) );
				expect( array.subarray( used ).every( ( v ) => v === 0 ) ).toBe( true );
				expect( stage[ COUNT[ type ] ].value ).toBe( n );

			} );

		}

		expect( stage._lightBufferRealloc ).toBe( false );

	} );

	// three.js uploads only what fits the length a shader was built with: a 17th light was dropped.
	it( 'grows past its capacity by whole steps, and asks for the kernels to be rebuilt', () => {

		const stage = makeStage();
		stage.areaLightsData = lights( 'area', 17 );
		stage._updateLightBufferNodes();

		const { array } = stage.areaLightsBufferNode;
		expect( array.length ).toBe( 2 * LIGHT_LIST_STEP * LIGHT_FLOATS.area );
		expect( Array.from( array.subarray( 0, 17 * 16 ) ) ).toEqual( Array.from( lights( 'area', 17 ) ) );
		expect( stage.numAreaLights.value ).toBe( 17 );
		expect( stage._lightBufferRealloc ).toBe( true );

		stage._lightBufferRealloc = false;
		stage.areaLightsData = lights( 'area', 3 );
		stage._updateLightBufferNodes();
		expect( stage.areaLightsBufferNode.array ).toBe( array );
		expect( stage._lightBufferRealloc ).toBe( false );

	} );

	// Spot lights take 20 vec4s each and a binding holds 4096, so 204 fit: rounding up to a step must
	// not turn a count that fits into one that does not.
	it( 'never rounds a count that fits a binding into one that does not', () => {

		expect( lightListCapacity( 'area', 3 ) ).toBe( 16 );
		expect( lightListCapacity( 'area', 17 ) ).toBe( 32 );
		expect( lightListCapacity( 'spot', 200 ) ).toBe( 204 );
		expect( lightListCapacity( 'spot', 250 ) ).toBe( 250 );

	} );

} );

describe( 'PathTracerStage camera clip start', () => {

	function makeStage( camera ) {

		const uniforms = new UniformManager();
		const stage = Object.create( PathTracerStage.prototype );
		Object.assign( stage, { camera, lastCameraMatrix: camera.matrixWorld.clone(), lastProjectionMatrix: camera.projectionMatrixInverse.clone() } );
		for ( const name of [ 'cameraWorldMatrix', 'cameraViewMatrix', 'cameraProjectionMatrix', 'cameraProjectionMatrixInverse', 'cameraClipStart', 'panoUp' ] ) stage[ name ] = uniforms.get( name );
		return stage;

	}

	it( 'takes an imported camera\'s clip start, and counts a change of it as a camera change', async () => {

		const { PerspectiveCamera } = await import( 'three' );
		const camera = new PerspectiveCamera( 40, 1, 0.5, 100 );
		camera.updateMatrixWorld();
		const stage = makeStage( camera );

		// The viewer's own `near` is not a clip plane.
		expect( stage._updateCameraUniforms() ).toBe( false );
		expect( stage.cameraClipStart.value ).toBe( 0 );

		camera.userData.clipStart = 1.1;
		expect( stage._updateCameraUniforms() ).toBe( true );
		expect( stage.cameraClipStart.value ).toBe( 1.1 );
		expect( stage._updateCameraUniforms() ).toBe( false );

	} );

	it( 'hands a levelled panorama the camera\'s up, unit, and counts a change of it as a camera change', async () => {

		const { PerspectiveCamera } = await import( 'three' );
		const camera = new PerspectiveCamera( 40, 1, 0.5, 100 );
		camera.updateMatrixWorld();
		const stage = makeStage( camera );

		expect( stage._updateCameraUniforms() ).toBe( false );
		expect( stage.panoUp.value.toArray() ).toEqual( [ 0, 1, 0 ] );
		camera.up.set( 0, 0, 2 );
		expect( stage._updateCameraUniforms() ).toBe( true );
		expect( stage.panoUp.value.toArray() ).toEqual( [ 0, 0, 1 ] );
		expect( stage._updateCameraUniforms() ).toBe( false );

	} );

} );

describe( 'PathTracerStage accumulation weight', () => {

	function accumulate( frame, { enabled = true, interacting = false } = {} ) {

		const stage = {
			accumulationEnabled: enabled,
			cameraOptimizer: { isInInteractionMode: () => interacting },
			accumulationAlpha: { value: - 1 },
			hasPreviousAccumulated: { value: - 1 },
		};
		PathTracerStage.prototype._updateAccumulationUniforms.call( stage, frame );
		return [ stage.accumulationAlpha.value, stage.hasPreviousAccumulated.value ];

	}

	it( 'weights frame n by 1 / ( n + 1 ), a running mean', () => {

		expect( accumulate( 0 ) ).toEqual( [ 1, 0 ] );
		expect( accumulate( 1 ) ).toEqual( [ 0.5, 1 ] );
		expect( accumulate( 3 ) ).toEqual( [ 0.25, 1 ] );
		expect( accumulate( 99 ) ).toEqual( [ 0.01, 1 ] );

	} );

	it( 'keeps no history while the camera moves or accumulation is off', () => {

		expect( accumulate( 5, { interacting: true } ) ).toEqual( [ 1, 0 ] );
		expect( accumulate( 5, { enabled: false } ) ).toEqual( [ 1, 0 ] );

	} );

} );

// A device whose queue answers each onSubmittedWorkDone only when the test says, and counts the texture writes.
function fakeDevice() {

	const answers = [];
	const writes = [];
	const device = { queue: {
		onSubmittedWorkDone: () => new Promise( ( resolve ) => answers.push( resolve ) ),
		writeTexture: ( destination ) => writes.push( destination.origin.z ),
	} };
	const answer = async ( n = answers.length ) => {

		answers.splice( 0, n ).forEach( ( resolve ) => resolve() );
		await new Promise( ( resolve ) => setTimeout( resolve ) );

	};

	return { device, answers, writes, answer };

}

// The queue answers its probes after `ms` each.
async function probed( fake, ms ) {

	let now = 0;
	vi.spyOn( performance, 'now' ).mockImplementation( () => now );
	measureUploadPacing( fake.device );
	for ( let i = 0; i < 3; i ++ ) {

		now += ms;
		await fake.answer();

	}

}

// Five layers of 64 MB each (never touched, so never committed), uploaded through the texture layer sink.
function upload( device ) {

	const renderer = { backend: { device, get: () => ( { texture: {} } ) } };
	const texture = { image: { width: 4096, height: 4096 } };
	const data = new Uint8Array( 5 * 64 * 2 ** 20 );
	return textureLayerSink( renderer ).write( texture, 0, data, 5 );

}

const flush = () => new Promise( ( resolve ) => setTimeout( resolve ) );

describe( 'PathTracerStage upload pacing', () => {

	afterEach( () => vi.restoreAllMocks() );

	it( 'waits for every upload where the queue answers at once', async () => {

		const fake = fakeDevice();
		await probed( fake, 0.1 );
		const done = upload( fake.device );
		await flush();
		expect( fake.writes ).toEqual( [ 0 ] );
		await fake.answer();
		expect( fake.writes ).toEqual( [ 0, 1 ] );
		for ( let i = 0; i < 4; i ++ ) await fake.answer();
		await done;

	} );

	it( 'keeps three more uploads in flight where the queue answers on a timer, then waits for the oldest', async () => {

		const fake = fakeDevice();
		await probed( fake, 100 );
		const done = upload( fake.device );
		await flush();
		expect( fake.writes ).toEqual( [ 0, 1, 2, 3 ] );
		await fake.answer( 1 );
		expect( fake.writes ).toEqual( [ 0, 1, 2, 3, 4 ] );
		await fake.answer();
		await done;

	} );

	it( 'counts the fastest probe: a page busy at one answer is not a slow queue', async () => {

		const fake = fakeDevice();
		let now = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => now );
		measureUploadPacing( fake.device );
		for ( const ms of [ 400, 0.1, 150 ] ) {

			now += ms;
			await fake.answer();

		}

		upload( fake.device );
		await flush();
		expect( fake.writes ).toEqual( [ 0 ] );

	} );

	it( 'paces drainUploads per device, and waits for each upload until the queue has been timed', async () => {

		const slow = fakeDevice(), fresh = fakeDevice();
		await probed( slow, 100 );
		const drain = ( device ) => PathTracerStage.prototype.drainUploads.call( { renderer: { backend: { device } } } );

		let settled = false;
		drain( slow.device ).then( () => ( settled = true ) );
		await flush();
		expect( settled ).toBe( true );

		measureUploadPacing( fresh.device );
		settled = false;
		drain( fresh.device ).then( () => ( settled = true ) );
		await flush();
		expect( settled ).toBe( false );

	} );

} );
