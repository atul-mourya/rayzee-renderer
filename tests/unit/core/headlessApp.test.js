import { describe, it, expect } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';

describe( 'a headless PathTracerApp', () => {

	it( 'makes its own canvas when given none, and never listens for window resizes', () => {

		const app = new PathTracerApp( null );
		expect( app._headless ).toBe( true );
		expect( app.canvas.isHeadlessCanvas ).toBe( true );
		expect( app._autoResize ).toBe( false );

	} );

	it( 'runs no render loop: waking is inert and animate() says what to call instead', () => {

		const app = new PathTracerApp( null );
		app.isInitialized = true;
		app.wake();
		expect( app.animationManagerId ).toBeFalsy();
		expect( () => app.animate() ).toThrow( /renderFrames\(\) or renderUntilComplete\(\)/ );

	} );

	it( 'is opt-in with a canvas of the host\'s own', () => {

		const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {} };
		expect( new PathTracerApp( canvas )._headless ).toBe( false );
		expect( new PathTracerApp( canvas, { headless: true } )._headless ).toBe( true );

	} );

} );
