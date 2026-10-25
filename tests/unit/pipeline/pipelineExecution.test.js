import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderPipeline } from '@/core/pipeline/RenderPipeline.js';
import { RenderStage, StageExecutionMode } from '@/core/pipeline/RenderStage.js';

/**
 * Concrete test stage that publishes a texture to context
 */
class ProducerStage extends RenderStage {

	constructor( name, textureKey, textureValue ) {

		super( name );
		this.textureKey = textureKey;
		this.textureValue = textureValue;

	}

	render( context ) {

		context.setTexture( this.textureKey, this.textureValue );

	}

}

/**
 * Consumer stage that reads a texture from context
 */
class ConsumerStage extends RenderStage {

	constructor( name, readKey ) {

		super( name );
		this.readKey = readKey;
		this.receivedTexture = null;

	}

	render( context ) {

		this.receivedTexture = context.getTexture( this.readKey );

	}

}

/**
 * Stage that emits an event
 */
class EmitterStage extends RenderStage {

	constructor( name, eventType, eventData ) {

		super( name );
		this.eventType = eventType;
		this.eventData = eventData;

	}

	render() {

		this.emit( this.eventType, this.eventData );

	}

}

/**
 * Stage that listens for an event
 */
class ListenerStage extends RenderStage {

	constructor( name, eventType ) {

		super( name, { executionMode: StageExecutionMode.ALWAYS } );
		this.eventType = eventType;
		this.receivedEvents = [];

	}

	setupEventListeners() {

		this.on( this.eventType, ( data ) => {

			this.receivedEvents.push( data );

		} );

	}

	render() { /* no-op */ }

}

describe( 'Pipeline Integration: Stage Execution', () => {

	let pipeline;

	beforeEach( () => {

		pipeline = new RenderPipeline( {}, 1920, 1080 );

	} );

	it( 'stages execute in insertion order', () => {

		const order = [];

		class OrderStage extends RenderStage {

			render() {

				order.push( this.name );

			}

		}

		pipeline.addStage( new OrderStage( 'First' ) );
		pipeline.addStage( new OrderStage( 'Second' ) );
		pipeline.addStage( new OrderStage( 'Third' ) );
		pipeline.render();

		expect( order ).toEqual( [ 'First', 'Second', 'Third' ] );

	} );

	it( 'disabled stage is skipped but others still run', () => {

		const order = [];

		class OrderStage extends RenderStage {

			render() {

				order.push( this.name );

			}

		}

		const a = new OrderStage( 'A' );
		const b = new OrderStage( 'B' );
		const c = new OrderStage( 'C' );

		pipeline.addStage( a );
		pipeline.addStage( b );
		pipeline.addStage( c );

		b.disable();
		pipeline.render();

		expect( order ).toEqual( [ 'A', 'C' ] );

	} );

} );

describe( 'Pipeline Integration: Texture Sharing via Context', () => {

	let pipeline;

	beforeEach( () => {

		pipeline = new RenderPipeline( {}, 1920, 1080 );

	} );

	it( 'consumer reads texture published by producer', () => {

		const texData = { id: 'color-output' };
		const producer = new ProducerStage( 'Producer', 'pathtracer:color', texData );
		const consumer = new ConsumerStage( 'Consumer', 'pathtracer:color' );

		pipeline.addStage( producer );
		pipeline.addStage( consumer );
		pipeline.render();

		expect( consumer.receivedTexture ).toBe( texData );

	} );

	it( 'consumer gets undefined if producer is disabled', () => {

		const producer = new ProducerStage( 'Producer', 'pathtracer:color', { id: 'tex' } );
		const consumer = new ConsumerStage( 'Consumer', 'pathtracer:color' );

		producer.enabled = false;

		pipeline.addStage( producer );
		pipeline.addStage( consumer );
		pipeline.render();

		expect( consumer.receivedTexture ).toBeUndefined();

	} );

	it( 'multiple producers can write different texture keys', () => {

		const producerA = new ProducerStage( 'A', 'color', 'colorData' );
		const producerB = new ProducerStage( 'B', 'normal', 'normalData' );
		const consumerColor = new ConsumerStage( 'C1', 'color' );
		const consumerNormal = new ConsumerStage( 'C2', 'normal' );

		pipeline.addStage( producerA );
		pipeline.addStage( producerB );
		pipeline.addStage( consumerColor );
		pipeline.addStage( consumerNormal );
		pipeline.render();

		expect( consumerColor.receivedTexture ).toBe( 'colorData' );
		expect( consumerNormal.receivedTexture ).toBe( 'normalData' );

	} );

} );

describe( 'Pipeline Integration: Event Communication', () => {

	let pipeline;

	beforeEach( () => {

		pipeline = new RenderPipeline( {}, 1920, 1080 );

	} );

	it( 'listener stage receives events from emitter stage', () => {

		// Listener is added first so it sets up listeners before emitter runs
		const listener = new ListenerStage( 'Listener', 'pathtracer:frameComplete' );
		const emitter = new EmitterStage( 'Emitter', 'pathtracer:frameComplete', { samples: 42 } );

		pipeline.addStage( listener );
		pipeline.addStage( emitter );
		pipeline.render();

		expect( listener.receivedEvents ).toHaveLength( 1 );
		expect( listener.receivedEvents[ 0 ] ).toEqual(
			expect.objectContaining( { type: 'pathtracer:frameComplete', samples: 42 } )
		);

	} );

	it( 'pipeline:reset event fires when pipeline.reset() is called', () => {

		const listener = new ListenerStage( 'Listener', 'pipeline:reset' );
		pipeline.addStage( listener );
		pipeline.reset();

		expect( listener.receivedEvents ).toHaveLength( 1 );

	} );

	it( 'frame:complete fires after each render()', () => {

		const events = [];
		pipeline.eventBus.on( 'frame:complete', ( data ) => events.push( data ) );

		pipeline.render();
		pipeline.render();
		pipeline.render();

		expect( events ).toHaveLength( 3 );

	} );

} );

describe( 'Pipeline Integration: Execution Modes', () => {

	let pipeline;

	beforeEach( () => {

		pipeline = new RenderPipeline( {}, 1920, 1080 );

	} );

	it( 'PER_CYCLE stage runs every frame in progressive mode', () => {

		pipeline.context.setState( 'renderMode', 0 );

		const renderFn = vi.fn();

		class CycleStage extends RenderStage {

			constructor() {

				super( 'Cycle', { executionMode: StageExecutionMode.PER_CYCLE } );

			}
			render() {

				renderFn();

			}

		}

		pipeline.addStage( new CycleStage() );
		pipeline.render();
		pipeline.render();

		expect( renderFn ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'PER_CYCLE stage skipped during tile rendering until cycle completes', () => {

		pipeline.context.setState( 'renderMode', 1 );
		pipeline.context.setState( 'tileRenderingComplete', false );

		const renderFn = vi.fn();

		class CycleStage extends RenderStage {

			constructor() {

				super( 'Cycle', { executionMode: StageExecutionMode.PER_CYCLE } );

			}
			render() {

				renderFn();

			}

		}

		pipeline.addStage( new CycleStage() );

		// First render: tile not complete, should skip
		pipeline.render();
		expect( renderFn ).not.toHaveBeenCalled();

		// Mark tile cycle as complete
		pipeline.context.setState( 'tileRenderingComplete', true );
		pipeline.render();
		expect( renderFn ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'CONDITIONAL stage delegates to shouldExecute()', () => {

		let shouldRun = false;

		class ConditionalStage extends RenderStage {

			constructor() {

				super( 'Cond', { executionMode: StageExecutionMode.CONDITIONAL } );

			}
			shouldExecute() {

				return shouldRun;

			}
			render() {}

		}

		const stage = new ConditionalStage();
		const renderSpy = vi.spyOn( stage, 'render' );
		pipeline.addStage( stage );

		pipeline.render();
		expect( renderSpy ).not.toHaveBeenCalled();

		shouldRun = true;
		pipeline.render();
		expect( renderSpy ).toHaveBeenCalledTimes( 1 );

	} );

} );

describe( 'Pipeline Integration: Full Lifecycle', () => {

	it( 'init → render → reset → resize → dispose', () => {

		const pipeline = new RenderPipeline( {}, 1920, 1080 );

		const resetFn = vi.fn();
		const setSizeFn = vi.fn();
		const disposeFn = vi.fn();

		class LifecycleStage extends RenderStage {

			constructor() {

				super( 'Lifecycle' );

			}
			render() {}
			reset() {

				resetFn();

			}
			setSize( w, h ) {

				setSizeFn( w, h );

			}
			dispose() {

				disposeFn();

			}

		}

		pipeline.addStage( new LifecycleStage() );

		// Render
		pipeline.render();
		expect( pipeline.context.getState( 'frame' ) ).toBe( 1 );

		// Reset
		pipeline.reset();
		expect( resetFn ).toHaveBeenCalled();
		expect( pipeline.context.getState( 'frame' ) ).toBe( 0 );

		// Resize
		pipeline.setSize( 800, 600 );
		expect( setSizeFn ).toHaveBeenCalledWith( 800, 600 );

		// Dispose
		pipeline.dispose();
		expect( disposeFn ).toHaveBeenCalled();
		expect( pipeline.stages ).toHaveLength( 0 );

	} );

} );
