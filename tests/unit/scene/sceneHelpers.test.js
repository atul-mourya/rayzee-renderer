import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock( 'three', () => ( {
	Scene: class {

		constructor() {

			this.children = [];

		}
		add( obj ) {

			this.children.push( obj );

		}
		remove( obj ) {

			const i = this.children.indexOf( obj ); if ( i > - 1 ) this.children.splice( i, 1 );

		}

	},
	PointLightHelper: class {

		constructor() {}
		dispose() {}
		update() {}

	},
	DirectionalLightHelper: class {

		constructor() {}
		dispose() {}
		update() {}

	},
	SpotLightHelper: class {

		constructor() {}
		dispose() {}
		update() {}

	},
} ) );

vi.mock( 'three/addons/helpers/RectAreaLightHelper.js', () => ( {
	RectAreaLightHelper: class {

		constructor() {}
		dispose() {}
		update() {}

	},
} ) );

import { SceneHelpers } from '@/core/scene/SceneHelpers.js';

// ── Helpers ───────────────────────────────────────────────────

function makeLight( type ) {

	const obj = { uuid: crypto.randomUUID() };

	if ( type === 'point' ) obj.isPointLight = true;
	else if ( type === 'directional' ) obj.isDirectionalLight = true;
	else if ( type === 'spot' ) obj.isSpotLight = true;
	else if ( type === 'rectarea' ) obj.isRectAreaLight = true;

	return obj;

}

// ── Tests ─────────────────────────────────────────────────────

describe( 'SceneHelpers', () => {

	let helpers;

	beforeEach( () => {

		helpers = new SceneHelpers();

	} );

	// ── Constructor ────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'starts with empty helpers', () => {

			expect( helpers._helpers.size ).toBe( 0 );

		} );

		it( 'defaults visible to false', () => {

			expect( helpers.visible ).toBe( false );

		} );

	} );

	// ── add ────────────────────────────────────────────────────

	describe( 'add', () => {

		it( 'creates a helper for a point light and returns it', () => {

			const light = makeLight( 'point' );
			const helper = helpers.add( light );

			expect( helper ).not.toBeNull();
			expect( helpers._helpers.size ).toBe( 1 );

		} );

		it( 'returns existing helper when adding the same object twice', () => {

			const light = makeLight( 'point' );
			const first = helpers.add( light );
			const second = helpers.add( light );

			expect( second ).toBe( first );
			expect( helpers._helpers.size ).toBe( 1 );

		} );

		it( 'returns null for unsupported object types', () => {

			const mesh = { uuid: crypto.randomUUID(), isMesh: true };
			const result = helpers.add( mesh );

			expect( result ).toBeNull();
			expect( helpers._helpers.size ).toBe( 0 );

		} );

		it( 'adds helper to the scene', () => {

			const light = makeLight( 'directional' );
			helpers.add( light );

			expect( helpers.scene.children.length ).toBe( 1 );

		} );

		it( 'creates helpers for all supported light types', () => {

			const types = [ 'point', 'directional', 'spot', 'rectarea' ];

			for ( const type of types ) {

				const light = makeLight( type );
				const helper = helpers.add( light );
				expect( helper ).not.toBeNull();

			}

			expect( helpers._helpers.size ).toBe( 4 );

		} );

	} );

	// ── remove ─────────────────────────────────────────────────

	describe( 'remove', () => {

		it( 'removes the helper for a given object', () => {

			const light = makeLight( 'point' );
			helpers.add( light );

			helpers.remove( light );

			expect( helpers._helpers.size ).toBe( 0 );
			expect( helpers.scene.children.length ).toBe( 0 );

		} );

		it( 'does nothing if object has no helper', () => {

			const light = makeLight( 'point' );
			expect( () => helpers.remove( light ) ).not.toThrow();

		} );

	} );

	// ── has ────────────────────────────────────────────────────

	describe( 'has', () => {

		it( 'returns true for objects with helpers', () => {

			const light = makeLight( 'spot' );
			helpers.add( light );

			expect( helpers.has( light ) ).toBe( true );

		} );

		it( 'returns false for objects without helpers', () => {

			const light = makeLight( 'spot' );
			expect( helpers.has( light ) ).toBe( false );

		} );

	} );

	// ── sync ───────────────────────────────────────────────────

	describe( 'sync', () => {

		it( 'adds new objects and removes stale ones', () => {

			const lightA = makeLight( 'point' );
			const lightB = makeLight( 'directional' );
			const lightC = makeLight( 'spot' );

			helpers.add( lightA );
			helpers.add( lightB );

			// Sync with a new set: keep A, drop B, add C
			helpers.sync( [ lightA, lightC ] );

			expect( helpers.has( lightA ) ).toBe( true );
			expect( helpers.has( lightB ) ).toBe( false );
			expect( helpers.has( lightC ) ).toBe( true );
			expect( helpers._helpers.size ).toBe( 2 );

		} );

		it( 'handles empty objects list (clears all)', () => {

			helpers.add( makeLight( 'point' ) );
			helpers.add( makeLight( 'spot' ) );

			helpers.sync( [] );

			expect( helpers._helpers.size ).toBe( 0 );

		} );

	} );

	// ── clear ──────────────────────────────────────────────────

	describe( 'clear', () => {

		it( 'removes all helpers', () => {

			helpers.add( makeLight( 'point' ) );
			helpers.add( makeLight( 'directional' ) );
			helpers.add( makeLight( 'spot' ) );

			helpers.clear();

			expect( helpers._helpers.size ).toBe( 0 );
			expect( helpers.scene.children.length ).toBe( 0 );

		} );

	} );

	// ── update ─────────────────────────────────────────────────

	describe( 'update', () => {

		it( 'calls update on all helpers', () => {

			const light = makeLight( 'point' );
			const helper = helpers.add( light );
			const spy = vi.spyOn( helper, 'update' );

			helpers.update();

			expect( spy ).toHaveBeenCalled();

		} );

		it( 'does not throw with no helpers', () => {

			expect( () => helpers.update() ).not.toThrow();

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'calls clear, removing all helpers', () => {

			helpers.add( makeLight( 'point' ) );
			helpers.add( makeLight( 'spot' ) );

			helpers.dispose();

			expect( helpers._helpers.size ).toBe( 0 );
			expect( helpers.scene.children.length ).toBe( 0 );

		} );

	} );

} );
