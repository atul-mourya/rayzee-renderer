import { describe, it, expect } from 'vitest';
import { generateViewportStyles } from '@/lib/viewport.js';

describe( 'generateViewportStyles', () => {

	it( 'returns wrapper, container, and canvas styles', () => {

		const styles = generateViewportStyles( 800, 600, 100 );
		expect( styles ).toHaveProperty( 'wrapperStyle' );
		expect( styles ).toHaveProperty( 'containerStyle' );
		expect( styles ).toHaveProperty( 'canvasStyle' );

	} );

	it( 'wrapper has correct dimensions and scale', () => {

		const styles = generateViewportStyles( 1024, 768, 50 );
		expect( styles.wrapperStyle.width ).toBe( '1024px' );
		expect( styles.wrapperStyle.height ).toBe( '768px' );
		expect( styles.wrapperStyle.transform ).toBe( 'scale(0.5)' );

	} );

	it( 'container has correct dimensions', () => {

		const styles = generateViewportStyles( 512, 512, 100 );
		expect( styles.containerStyle.width ).toBe( '512px' );
		expect( styles.containerStyle.height ).toBe( '512px' );
		expect( styles.containerStyle.position ).toBe( 'relative' );

	} );

	it( 'canvas has absolute positioning', () => {

		const styles = generateViewportStyles( 800, 600, 100 );
		expect( styles.canvasStyle.position ).toBe( 'absolute' );
		expect( styles.canvasStyle.top ).toBe( 0 );
		expect( styles.canvasStyle.left ).toBe( 0 );
		expect( styles.canvasStyle.width ).toBe( '800px' );
		expect( styles.canvasStyle.height ).toBe( '600px' );

	} );

	it( 'scale 200 results in scale(2)', () => {

		const styles = generateViewportStyles( 100, 100, 200 );
		expect( styles.wrapperStyle.transform ).toBe( 'scale(2)' );

	} );

} );
