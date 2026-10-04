/**
 * Where each kind of light gets through, learned from the one-shadow-ray pick's own rays (LightsSampling lightPick):
 * tries and visible counts per cell of space and facing. Shade reads the learned half, which no kernel writes during
 * a frame, so a render repeats; it adds to the fresh half, folded into the learned one after each frame.
 */

import { Fn, float, int, uint, If, Return, instanceIndex, abs, ceil, exp2, floor, length, log2, max, select, sqrt, atomicAdd, atomicLoad, atomicStore } from 'three/tsl';

import { VISIBILITY_BASE, VISIBILITY_CELLS, VISIBILITY_KINDS, VISIBILITY_COUNTER_WORDS } from '../Processor/QueueManager.js';
import { pcgHash } from './Random.js';

export const VISIBILITY_KIND = { LAMPS: 0, ENVIRONMENT: 1, SUN: 2, EMITTERS: 3 };

const LEARNED = VISIBILITY_BASE;
const FRESH = VISIBILITY_BASE + VISIBILITY_COUNTER_WORDS;
const SLOTS = VISIBILITY_CELLS * VISIBILITY_KINDS;
// A cell is this share of its distance from the camera, rounded up to a power of two.
const CELL_SHARE = 1 / 32;
// Below it a kind is still picked now and then, so a light that comes into view is found again.
const MIN_SHARE = 1 / 64;
const HALVE_AT = 1 << 16;

const hashIn = ( h, v ) => pcgHash( { state: h.bitXor( v ) } );

/** The cell of a point and the side its surface faces. */
export const visibilityCell = ( p, n, cameraPosition ) => {

	const level = ceil( log2( max( length( p.sub( cameraPosition ) ).mul( CELL_SHARE ), 1e-6 ) ) ).toVar();
	const c = floor( p.div( exp2( level ) ) ).toVar();
	const a = abs( n );
	const facing = select( a.x.greaterThan( max( a.y, a.z ) ), select( n.x.greaterThan( 0.0 ), uint( 0 ), uint( 1 ) ),
		select( a.y.greaterThan( a.z ), select( n.y.greaterThan( 0.0 ), uint( 2 ), uint( 3 ) ), select( n.z.greaterThan( 0.0 ), uint( 4 ), uint( 5 ) ) ) );

	let h = pcgHash( { state: uint( int( level ).add( 1024 ) ) } );
	h = hashIn( h, uint( int( c.x ) ) );
	h = hashIn( h, uint( int( c.y ) ) );
	h = hashIn( h, uint( int( c.z ) ) );
	h = hashIn( h, facing );
	return h.bitAnd( uint( VISIBILITY_CELLS - 1 ) ).toVar();

};

const slot = ( cell, kind ) => cell.mul( uint( VISIBILITY_KINDS ) ).add( uint( kind ) ).mul( uint( 2 ) );

/** √ of the share of rays that got through: the pick's best weight against a light that is on or off. */
export const visibilityShare = ( counters, cell, kind ) => {

	const at = uint( LEARNED ).add( slot( cell, kind ) ).toVar();
	const tries = float( atomicLoad( counters.element( at ) ) );
	const seen = float( atomicLoad( counters.element( at.add( uint( 1 ) ) ) ) );
	return sqrt( max( seen.add( 0.5 ).div( tries.add( 1.0 ) ), MIN_SHARE ) );

};

export const recordVisibility = ( counters, cell, kind, visible ) => {

	const at = uint( FRESH ).add( slot( cell, kind ) ).toVar();
	atomicAdd( counters.element( at ), uint( 1 ) );
	If( visible, () => {

		atomicAdd( counters.element( at.add( uint( 1 ) ) ), uint( 1 ) );

	} );

};

/** Adds the frame's counts to the learned ones, halving both past HALVE_AT so the table keeps up with a change. */
export function buildVisibilityFoldKernel( { counters } ) {

	return Fn( () => {

		If( instanceIndex.greaterThanEqual( uint( SLOTS ) ), () => {

			Return();

		} );

		const learned = uint( LEARNED ).add( instanceIndex.mul( uint( 2 ) ) ).toVar();
		const fresh = uint( FRESH ).add( instanceIndex.mul( uint( 2 ) ) ).toVar();
		const tries = atomicLoad( counters.element( learned ) ).add( atomicLoad( counters.element( fresh ) ) ).toVar();
		const seen = atomicLoad( counters.element( learned.add( uint( 1 ) ) ) ).add( atomicLoad( counters.element( fresh.add( uint( 1 ) ) ) ) ).toVar();
		If( tries.greaterThan( uint( HALVE_AT ) ), () => {

			tries.assign( tries.shiftRight( uint( 1 ) ) );
			seen.assign( seen.shiftRight( uint( 1 ) ) );

		} );
		atomicStore( counters.element( learned ), tries );
		atomicStore( counters.element( learned.add( uint( 1 ) ) ), seen );
		atomicStore( counters.element( fresh ), uint( 0 ) );
		atomicStore( counters.element( fresh.add( uint( 1 ) ) ), uint( 0 ) );

	} )().compute( SLOTS, [ 256 ] );

}

/** Forgets everything learned: a reset may have moved what blocks what. */
export function buildVisibilityClearKernel( { counters } ) {

	const words = 2 * VISIBILITY_COUNTER_WORDS;
	return Fn( () => {

		If( instanceIndex.lessThan( uint( words ) ), () => {

			atomicStore( counters.element( uint( LEARNED ).add( instanceIndex ) ), uint( 0 ) );

		} );

	} )().compute( words, [ 256 ] );

}
