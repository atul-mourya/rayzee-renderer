import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDispatcher } from '@/core/pipeline/EventDispatcher.js';

describe( 'EventDispatcher', () => {

	let dispatcher;

	beforeEach( () => {

		dispatcher = new EventDispatcher();

	} );

	// ── on / emit ──────────────────────────────────────────────

	describe( 'on / emit', () => {

		it( 'listener receives emitted data', () => {

			const listener = vi.fn();
			dispatcher.on( 'test', listener );
			dispatcher.emit( 'test', { value: 42 } );
			expect( listener ).toHaveBeenCalledTimes( 1 );
			expect( listener ).toHaveBeenCalledWith(
				expect.objectContaining( { type: 'test', value: 42 } )
			);

		} );

		it( 'multiple listeners on same event', () => {

			const a = vi.fn();
			const b = vi.fn();
			dispatcher.on( 'test', a );
			dispatcher.on( 'test', b );
			dispatcher.emit( 'test' );
			expect( a ).toHaveBeenCalledTimes( 1 );
			expect( b ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'emit with event object that has type uses it directly', () => {

			const listener = vi.fn();
			dispatcher.on( 'custom', listener );
			dispatcher.emit( 'custom', { type: 'custom', extra: 'data' } );
			expect( listener ).toHaveBeenCalledWith(
				expect.objectContaining( { type: 'custom', extra: 'data' } )
			);

		} );

		it( 'emit without data creates event with type', () => {

			const listener = vi.fn();
			dispatcher.on( 'ping', listener );
			dispatcher.emit( 'ping' );
			expect( listener ).toHaveBeenCalledWith(
				expect.objectContaining( { type: 'ping' } )
			);

		} );

	} );

	// ── once ───────────────────────────────────────────────────

	describe( 'once', () => {

		it( 'fires only once', () => {

			const listener = vi.fn();
			dispatcher.once( 'oneshot', listener );
			dispatcher.emit( 'oneshot' );
			dispatcher.emit( 'oneshot' );
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'can be removed before firing via off()', () => {

			const listener = vi.fn();
			dispatcher.once( 'oneshot', listener );
			dispatcher.off( 'oneshot', listener );
			dispatcher.emit( 'oneshot' );
			expect( listener ).not.toHaveBeenCalled();

		} );

	} );

	// ── off ────────────────────────────────────────────────────

	describe( 'off', () => {

		it( 'removes a listener', () => {

			const listener = vi.fn();
			dispatcher.on( 'test', listener );
			dispatcher.off( 'test', listener );
			dispatcher.emit( 'test' );
			expect( listener ).not.toHaveBeenCalled();

		} );

		it( 'does not throw when removing nonexistent listener', () => {

			expect( () => dispatcher.off( 'test', () => {} ) ).not.toThrow();

		} );

	} );

	// ── removeAllListeners ─────────────────────────────────────

	describe( 'removeAllListeners', () => {

		it( 'removes listeners for specific type', () => {

			const a = vi.fn();
			const b = vi.fn();
			dispatcher.on( 'eventA', a );
			dispatcher.on( 'eventB', b );
			dispatcher.removeAllListeners( 'eventA' );
			dispatcher.emit( 'eventA' );
			dispatcher.emit( 'eventB' );
			expect( a ).not.toHaveBeenCalled();
			expect( b ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'removes all listeners when no type given', () => {

			const a = vi.fn();
			const b = vi.fn();
			dispatcher.on( 'eventA', a );
			dispatcher.on( 'eventB', b );
			dispatcher.removeAllListeners();
			dispatcher.emit( 'eventA' );
			dispatcher.emit( 'eventB' );
			expect( a ).not.toHaveBeenCalled();
			expect( b ).not.toHaveBeenCalled();

		} );

	} );

	// ── listenerCount ──────────────────────────────────────────

	describe( 'listenerCount', () => {

		it( 'returns 0 for unregistered type', () => {

			expect( dispatcher.listenerCount( 'missing' ) ).toBe( 0 );

		} );

		it( 'counts registered listeners', () => {

			dispatcher.on( 'test', () => {} );
			dispatcher.on( 'test', () => {} );
			expect( dispatcher.listenerCount( 'test' ) ).toBe( 2 );

		} );

		it( 'decrements after off()', () => {

			const listener = () => {};

			dispatcher.on( 'test', listener );
			dispatcher.off( 'test', listener );
			expect( dispatcher.listenerCount( 'test' ) ).toBe( 0 );

		} );

	} );

	// ── eventNames ─────────────────────────────────────────────

	describe( 'eventNames', () => {

		it( 'returns empty array initially', () => {

			expect( dispatcher.eventNames() ).toEqual( [] );

		} );

		it( 'returns registered event types', () => {

			dispatcher.on( 'alpha', () => {} );
			dispatcher.on( 'beta', () => {} );
			const names = dispatcher.eventNames();
			expect( names ).toContain( 'alpha' );
			expect( names ).toContain( 'beta' );

		} );

	} );

	// ── clear ──────────────────────────────────────────────────

	describe( 'clear', () => {

		it( 'removes all listeners and events', () => {

			dispatcher.on( 'a', () => {} );
			dispatcher.on( 'b', () => {} );
			dispatcher.clear();
			expect( dispatcher.eventNames() ).toEqual( [] );
			expect( dispatcher.listenerCount( 'a' ) ).toBe( 0 );

		} );

	} );

} );
