import { describe, it, expect, beforeEach } from 'vitest';

// Mock three/tsl: `uniform` returns a plain wrapper that records the value so
// UniformManager's Map/Set bookkeeping can be tested without a GPU context.
vi.mock( 'three/tsl', () => ( {
	uniform( value ) {

		return { value, name: '' };

	},
	uniformArray( array ) {

		return { array, value: array, name: '' };

	},
} ) );

// Random.js exports a module-scoped uniform — mock to a plain wrapper too
vi.mock( '@/core/TSL/Random.js', () => ( {
	samplingTechniqueUniform: { value: 0, name: '' },
} ) );

vi.mock( 'three', () => ( {
	Vector2: class {

		constructor( x = 0, y = 0 ) {

			this.x = x; this.y = y;

		} copy( v ) {

			this.x = v.x; this.y = v.y; return this;

		} multiplyScalar( s ) {

			this.x *= s; this.y *= s; return this;

		}

	},
	Vector3: class {

		constructor( x = 0, y = 0, z = 0 ) {

			this.x = x; this.y = y; this.z = z;

		} copy( v ) {

			this.x = v.x; this.y = v.y; this.z = v.z; return this;

		}

	},
	Matrix4: class {

		constructor() {

			this.elements = new Array( 16 ).fill( 0 );

		} copy( m ) {

			this.elements = m.elements.slice(); return this;

		}

	},
	Color: class {

		constructor( r = 0, g = 0, b = 0 ) {

			this.r = r; this.g = g; this.b = b;

		} copy( c ) {

			this.r = c.r; this.g = c.g; this.b = c.b; return this;

		}

	},
	MathUtils: { DEG2RAD: Math.PI / 180 },
} ) );

import { UniformManager } from '@/core/managers/UniformManager.js';

// ── Tests ────────────────────────────────────────────────────

describe( 'UniformManager', () => {

	let manager;

	beforeEach( () => {

		manager = new UniformManager( 1920, 1080 );

	} );

	// ── constructor / basic API ─────────────────────────────

	describe( 'constructor', () => {

		it( 'should initialise the core uniforms map', () => {

			expect( manager.has( 'frame' ) ).toBe( true );
			expect( manager.has( 'maxBounces' ) ).toBe( true );
			expect( manager.has( 'cameraWorldMatrix' ) ).toBe( true );
			expect( manager.has( 'resolution' ) ).toBe( true );

		} );

		it( 'should create the four light buffer nodes', () => {

			const buffers = manager.getLightBufferNodes();

			expect( buffers.directional ).toBeDefined();
			expect( buffers.area ).toBeDefined();
			expect( buffers.point ).toBeDefined();
			expect( buffers.spot ).toBeDefined();

		} );

		it( 'should seed resolution from constructor args', () => {

			const res = manager.get( 'resolution' );
			expect( res.value.x ).toBe( 1920 );
			expect( res.value.y ).toBe( 1080 );

		} );

	} );

	// ── set / get ────────────────────────────────────────────

	describe( 'set', () => {

		it( 'should convert booleans to int 0/1', () => {

			manager.set( 'enableAccumulation', false );
			expect( manager.get( 'enableAccumulation' ).value ).toBe( 0 );

			manager.set( 'enableAccumulation', true );
			expect( manager.get( 'enableAccumulation' ).value ).toBe( 1 );

		} );

		// A slider component that emits [n] instead of n used to land the array straight in
		// .value. PathTracer then summed maxBounces + transmissiveBounces + maxSubsurfaceSteps,
		// which string-concatenated ([20] + 5 + 8 === '2058') and ran the bounce loop to 2058.
		it( 'should unwrap a single-element array for a scalar uniform', () => {

			manager.set( 'maxBounces', [ 20 ] );

			const value = manager.get( 'maxBounces' ).value;
			expect( value ).toBe( 20 );
			expect( typeof value ).toBe( 'number' );
			// The actual failure mode: a non-number turns the loop-bound sum into a string.
			expect( typeof ( value + 5 + 8 ) ).toBe( 'number' );

		} );

		it( 'should unwrap a single-element array for a boolean uniform', () => {

			// [0] is truthy, so without unwrapping this stores 1 — the opposite of what was asked.
			manager.set( 'showBackground', [ 0 ] );

			expect( manager.get( 'showBackground' ).value ).toBe( 0 );

		} );

		it( 'should warn only once per uniform for repeated array values', () => {

			const warnings = [];
			const original = console.warn;
			console.warn = msg => warnings.push( msg );

			try {

				manager.set( 'maxBounces', [ 4 ] );
				manager.set( 'maxBounces', [ 5 ] );
				manager.set( 'maxBounces', [ 6 ] );

			} finally {

				console.warn = original;

			}

			expect( warnings.length ).toBe( 1 );
			expect( manager.get( 'maxBounces' ).value ).toBe( 6 );

		} );

		it( 'should warn and skip for unknown uniform names', () => {

			const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

			manager.set( 'nonexistentUniform', 42 );

			expect( warn ).toHaveBeenCalled();
			warn.mockRestore();

		} );

	} );

	// ── dispose ──────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'should clear the uniforms map', () => {

			expect( manager.has( 'frame' ) ).toBe( true );

			manager.dispose();

			expect( manager.has( 'frame' ) ).toBe( false );
			expect( [ ...manager.keys() ].length ).toBe( 0 );

		} );

		it( 'should clear the booleans set (set() becomes a no-op after dispose)', () => {

			manager.dispose();

			const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			manager.set( 'enableAccumulation', true );
			expect( warn ).toHaveBeenCalled(); // uniform is gone, warns
			warn.mockRestore();

		} );

	 it( 'should drop the light buffer nodes', () => {

			manager.dispose();

			const buffers = manager.getLightBufferNodes();
			expect( buffers.directional ).toBeUndefined();
			expect( buffers.area ).toBeUndefined();
			expect( buffers.point ).toBeUndefined();
			expect( buffers.spot ).toBeUndefined();

		} );

		it( 'should be idempotent', () => {

			expect( () => {

				manager.dispose();
				manager.dispose();
				manager.dispose();

			} ).not.toThrow();

		} );

	} );

} );
