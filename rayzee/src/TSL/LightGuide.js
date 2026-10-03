/**
 * Where light from infinity gets into the scene, learned from camera paths. A camera path escaping at p in
 * direction ω is where a light path along −ω would have done some good — through a window, past a door — so each
 * escape counts one at p's place on the scene's bounding disc facing ω, per coarse direction. Lights at infinity
 * (the sky, the sun, directional lamps) start their light paths from those counts, a share still drawn uniformly
 * over the disc; every weight reads the same table, so the estimate stays unbiased whatever was learned.
 *
 * The counts sit in the counter buffer past COUNTER.GUIDE (Shade has no binding to spare); a kernel folds them
 * into running sums every so often, which PathTracer copies into the guide texture: GUIDE_BINS rows of
 * GUIDE_CELLS running sums ending at 1, then the row's count of escapes (0 = nothing learned: uniform).
 */

import {
	Fn, float, int, uint, vec2, vec3, ivec2, If, Loop, Return, instanceIndex, abs, floor, max, mix, select, normalize, cross,
	dot, sqrt, cos, sin, atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';

import { COUNTER, GUIDE_COUNTER_WORDS } from '../Processor/QueueManager.js';

export const GUIDE_BIN_SIDE = 4;
export const GUIDE_BINS = GUIDE_BIN_SIDE * GUIDE_BIN_SIDE;
export const GUIDE_CELL_SIDE = 64;
export const GUIDE_CELLS = GUIDE_CELL_SIDE * GUIDE_CELL_SIDE;
export const GUIDE_TEXTURE_WIDTH = GUIDE_CELLS + 1;
if ( GUIDE_BINS * GUIDE_CELLS !== GUIDE_COUNTER_WORDS ) throw new Error( 'LightGuide: the counter buffer is sized for another guide' );
/** Floats per row of the build buffer: the texture's row, padded to the 256 bytes a buffer→texture copy needs. */
export const GUIDE_ROW_STRIDE = Math.ceil( GUIDE_TEXTURE_WIDTH * 4 / 256 ) * 64;
/** Share of light paths still drawn uniformly over the disc, so no start is ever ruled out. */
export const GUIDE_UNIFORM_SHARE = 0.2;

// The disc facing `toLight`: its plane's axes, as the light path's start is built on them.
const discFrame = ( toLight ) => {

	const u = normalize( cross( select( abs( toLight.x ).greaterThan( 0.9 ), vec3( 0, 1, 0 ), vec3( 1, 0, 0 ) ), toLight ) ).toVar();
	return { u, v: cross( toLight, u ).toVar() };

};

// Coarse direction: an octahedral GUIDE_BIN_SIDE² grid.
const guideBin = ( dir ) => {

	const d = dir.div( max( abs( dir.x ).add( abs( dir.y ) ).add( abs( dir.z ) ), 1e-20 ) ).toVar();
	const p = vec2( d.x, d.z ).toVar();
	If( d.y.lessThan( 0.0 ), () => {

		p.assign( vec2(
			float( 1.0 ).sub( abs( d.z ) ).mul( select( d.x.greaterThanEqual( 0.0 ), 1.0, - 1.0 ) ),
			float( 1.0 ).sub( abs( d.x ) ).mul( select( d.z.greaterThanEqual( 0.0 ), 1.0, - 1.0 ) ),
		) );

	} );
	const q = floor( p.mul( 0.5 ).add( 0.5 ).mul( GUIDE_BIN_SIDE ) ).clamp( 0.0, GUIDE_BIN_SIDE - 1 );
	return int( q.y ).mul( GUIDE_BIN_SIDE ).add( int( q.x ) );

};

// p's place on the disc facing `toLight`, in units of its radius: where the light path through p along −toLight starts.
const discCoords = ( bdpt, toLight, p ) => {

	const { u, v } = discFrame( toLight );
	const rel = p.sub( bdpt.sceneCenter );
	return vec2( dot( rel, u ), dot( rel, v ) ).div( bdpt.sceneRadius );

};

// The guide's cell at disc coordinates `st`, or −1 outside the square it covers.
const guideCell = ( st ) => {

	const g = st.mul( 0.5 ).add( 0.5 ).mul( GUIDE_CELL_SIDE ).toVar();
	const inside = g.x.greaterThanEqual( 0.0 ).and( g.y.greaterThanEqual( 0.0 ) ).and( g.x.lessThan( GUIDE_CELL_SIDE ) ).and( g.y.lessThan( GUIDE_CELL_SIDE ) );
	return select( inside, int( g.y ).mul( GUIDE_CELL_SIDE ).add( int( g.x ) ), int( - 1 ) );

};

const learned = ( bdpt, guide, bin ) => bdpt.guide.greaterThan( uint( 0 ) ).and( guide.load( ivec2( int( GUIDE_CELLS ), bin ) ).x.greaterThan( 0.0 ) );

/**
 * Area density, over the disc facing `toLight`, of the light path whose start projects to `p` along −toLight —
 * what `sceneDiscPdf` was before the guide.
 */
export const guidedDiscPdf = ( bdpt, guide, toLight, p ) => {

	const st = discCoords( bdpt, toLight, p ).toVar();
	const radius2 = bdpt.sceneRadius.mul( bdpt.sceneRadius ).toVar();
	const uniformPdf = select( dot( st, st ).lessThanEqual( 1.0 ), float( 1.0 ).div( max( radius2.mul( Math.PI ), 1e-30 ) ), float( 0.0 ) ).toVar();
	const bin = guideBin( toLight ).toVar();
	const cell = guideCell( st ).toVar();
	const at = ( c ) => guide.load( ivec2( max( c, int( 0 ) ), bin ) ).x;
	const share = select( cell.greaterThanEqual( int( 0 ) ), at( cell ).sub( select( cell.greaterThan( int( 0 ) ), at( cell.sub( int( 1 ) ) ), float( 0.0 ) ) ), float( 0.0 ) );
	// A cell is ( 2R / GUIDE_CELL_SIDE )².
	const cellPdf = share.mul( GUIDE_CELLS / 4 ).div( max( radius2, 1e-30 ) );
	return select( learned( bdpt, guide, bin ), mix( cellPdf, uniformPdf, GUIDE_UNIFORM_SHARE ), uniformPdf );

};

/**
 * A light path's start on the disc facing `toLight`: from a learned cell with chance 1 − GUIDE_UNIFORM_SHARE
 * (`choice` < that, rescaled into the cell pick), else uniformly over the disc. `xi` places it within either.
 */
export const sampleGuidedDisc = ( bdpt, guide, toLight, choice, xi ) => {

	const { u, v } = discFrame( toLight );
	const st = vec2( 0.0 ).toVar();
	const bin = guideBin( toLight ).toVar();
	If( learned( bdpt, guide, bin ).and( choice.lessThan( 1 - GUIDE_UNIFORM_SHARE ) ), () => {

		const target = choice.div( 1 - GUIDE_UNIFORM_SHARE ).toVar();
		const lo = int( 0 ).toVar();
		const hi = int( GUIDE_CELLS - 1 ).toVar();
		Loop( lo.lessThan( hi ), () => {

			const mid = lo.add( hi ).div( 2 ).toVar();
			If( guide.load( ivec2( mid, bin ) ).x.lessThanEqual( target ), () => {

				lo.assign( mid.add( 1 ) );

			} ).Else( () => {

				hi.assign( mid );

			} );

		} );
		const cell = vec2( float( lo.mod( int( GUIDE_CELL_SIDE ) ) ), float( lo.div( int( GUIDE_CELL_SIDE ) ) ) );
		st.assign( cell.add( xi ).div( GUIDE_CELL_SIDE ).mul( 2.0 ).sub( 1.0 ) );

	} ).Else( () => {

		const r = sqrt( xi.x );
		const phi = xi.y.mul( 2 * Math.PI );
		st.assign( vec2( r.mul( cos( phi ) ), r.mul( sin( phi ) ) ) );

	} );
	return bdpt.sceneCenter.add( toLight.mul( bdpt.sceneRadius ) ).add( u.mul( st.x ).add( v.mul( st.y ) ).mul( bdpt.sceneRadius ) );

};

/** A camera path escaping at `p` toward `toLight`: one count for light paths that would have reached p. */
export const recordEscape = ( counters, bdpt, toLight, p ) => {

	const cell = guideCell( discCoords( bdpt, toLight, p ) ).toVar();
	If( bdpt.guideLearning.greaterThan( uint( 0 ) ).and( cell.greaterThanEqual( int( 0 ) ) ), () => {

		atomicAdd( counters.element( uint( COUNTER.GUIDE ).add( uint( guideBin( toLight ).mul( int( GUIDE_CELLS ) ).add( cell ) ) ) ), uint( 1 ) );

	} );

};

/** Folds the counts into the build buffer's rows (GUIDE_ROW_STRIDE floats each), one thread a direction bin. */
export function buildGuideKernel( { counters, out } ) {

	return Fn( () => {

		const bin = instanceIndex;
		If( bin.greaterThanEqual( uint( GUIDE_BINS ) ), () => {

			Return();

		} );

		const base = uint( COUNTER.GUIDE ).add( bin.mul( uint( GUIDE_CELLS ) ) ).toVar();
		const total = float( 0.0 ).toVar();
		Loop( { start: int( 0 ), end: int( GUIDE_CELLS ), type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( float( atomicLoad( counters.element( base.add( uint( i ) ) ) ) ) );

		} );

		const row = bin.mul( uint( GUIDE_ROW_STRIDE ) ).toVar();
		const running = float( 0.0 ).toVar();
		Loop( { start: int( 0 ), end: int( GUIDE_CELLS ), type: 'int', condition: '<' }, ( { i } ) => {

			running.addAssign( float( atomicLoad( counters.element( base.add( uint( i ) ) ) ) ) );
			out.element( row.add( uint( i ) ) ).assign( select( total.greaterThan( 0.0 ),
				select( i.equal( int( GUIDE_CELLS - 1 ) ), float( 1.0 ), running.div( total ) ), float( 0.0 ) ) );

		} );
		out.element( row.add( uint( GUIDE_CELLS ) ) ).assign( total );

	} )().compute( GUIDE_BINS, [ GUIDE_BINS ] );

}

/** Forgets every count: what camera paths saw before a reset says nothing about the scene after it. */
export function buildGuideClearKernel( { counters } ) {

	return Fn( () => {

		If( instanceIndex.lessThan( uint( GUIDE_COUNTER_WORDS ) ), () => {

			atomicStore( counters.element( uint( COUNTER.GUIDE ).add( instanceIndex ) ), uint( 0 ) );

		} );

	} )().compute( GUIDE_COUNTER_WORDS, [ 256 ] );

}
