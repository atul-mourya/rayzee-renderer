import { describe, it, expect } from 'vitest';
import { BufferAttribute } from 'three';
import { PathTracerStage } from '@/core/Stages/PathTracerStage.js';
import { UniformManager, LIGHT_FLOATS, LIGHT_LIST_STEP, lightListCapacity } from '@/core/managers/UniformManager.js';

// The stage needs a WebGPU renderer to construct, but the completion-threshold methods only
// touch three plain fields — call them against a bare receiver.
function makeReceiver( { renderMode = 0, maxSamples = 30, renderLimitMode = 'frames' } = {} ) {

	return {
		renderMode: { value: renderMode },
		maxSamples: { value: maxSamples },
		renderLimitMode,
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
