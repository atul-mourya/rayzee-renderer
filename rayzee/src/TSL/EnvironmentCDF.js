import { Fn, float, int, uint, vec2, vec4, If, Loop, Return, instanceIndex, max, sin, dot, select } from 'three/tsl';

import { REC709_LUMINANCE_COEFFICIENTS } from './Common.js';

/** Floats per row of the packed table: width + 1 texels, padded to the 256 bytes a buffer→texture copy needs. */
export const cdfRowStride = width => Math.ceil( ( width + 1 ) * 4 / 256 ) * 64;

// First index in [0, n) whose value is ≥ target, n − 1 when none is — as the CPU builder's search.
function lowerBound( n, valueAt, target ) {

	const lo = int( 0 ).toVar();
	const hi = int( n - 1 ).toVar();
	Loop( { start: int( 0 ), end: int( Math.ceil( Math.log2( n ) ) + 1 ), type: 'int', condition: '<', name: 'step' }, () => {

		If( lo.lessThan( hi ), () => {

			const mid = lo.add( hi ).div( 2 ).toVar();
			If( valueAt( mid ).lessThan( target ), () => {

				lo.assign( mid.add( 1 ) );

			} ).Else( () => {

				hi.assign( mid );

			} );

		} );

	} );
	return lo;

}

// select(), never mix(): a + t·(b − a) is not b at t = 1, and the search compares a prefix sum
// against the row total it ends on.

/**
 * The GPU twin of `EquirectHDRInfo.computeCDF`, into the packed (width + 1) × height table the
 * sampler reads, and of `buildExactEnvironmentTable` into the next `height` rows (one cell a texel, without its
 * neighbour weighting: the sky has no sharp texel).
 * `stats[ 1 ]` ends as ( totalSum, compensationDelta, compensated, 0 ).
 * @returns {Array} kernels, dispatched in order
 */
export function buildEnvironmentCDFKernels( { pixels, rows, prefix, stats, cdf, width, height } ) {

	const stride = cdfRowStride( width );
	const sinTheta = y => sin( float( y ).add( 0.5 ).mul( Math.PI / height ) );
	const weight = ( y, x, sinT ) => dot( pixels.element( y.mul( width ).add( x ) ).xyz, REC709_LUMINANCE_COEFFICIENTS ).mul( sinT );
	const firstThreadOnly = () => If( instanceIndex.greaterThan( uint( 0 ) ), () => {

		Return();

	} );

	const rowTotals = Fn( () => {

		const y = instanceIndex;
		If( y.greaterThanEqual( uint( height ) ), () => {

			Return();

		} );

		const sinT = sinTheta( y ).toVar();
		const total = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( width ), type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( weight( y, uint( i ), sinT ) );

		} );
		rows.element( y ).assign( vec4( total, 0, 0, 0 ) );

	} )().compute( height, [ 64 ] );

	const mean = Fn( () => {

		firstThreadOnly();
		const total = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( rows.element( i ).x );

		} );
		stats.element( 0 ).assign( vec4( total, total.div( width * height ), 0, 0 ) );

	} )().compute( 1, [ 1 ] );

	const prefixSums = Fn( () => {

		const y = instanceIndex;
		If( y.greaterThanEqual( uint( height ) ), () => {

			Return();

		} );

		const sinT = sinTheta( y ).toVar();
		const delta = stats.element( 0 ).y.toVar();
		const raw = float( 0 ).toVar();
		const compensated = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( width ), type: 'int', condition: '<' }, ( { i } ) => {

			const w = weight( y, uint( i ), sinT ).toVar();
			raw.addAssign( w );
			compensated.addAssign( max( w.sub( delta ), 0 ) );
			prefix.element( y.mul( width ).add( uint( i ) ) ).assign( vec2( raw, compensated ) );

		} );
		rows.element( y ).assign( vec4( raw, compensated, 0, 0 ) );

	} )().compute( height, [ 64 ] );

	const marginal = Fn( () => {

		firstThreadOnly();
		const compensatedTotal = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			compensatedTotal.addAssign( rows.element( i ).y );

		} );
		const useCompensated = compensatedTotal.greaterThan( 0 ).toVar();

		const cumulative = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			const r = rows.element( i ).toVar();
			cumulative.addAssign( select( useCompensated, r.y, r.x ) );
			rows.element( i ).assign( vec4( r.x, r.y, cumulative, 0 ) );

		} );

		const s = stats.element( 0 ).toVar();
		stats.element( 1 ).assign( select( useCompensated, vec4( compensatedTotal, s.y, 1, 0 ), vec4( s.x, 0, 0, 0 ) ) );

		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<', name: 'row' }, ( { row } ) => {

			const k = select(
				cumulative.greaterThan( 0 ),
				float( lowerBound( height, j => rows.element( j ).z, float( row ).add( 1 ).div( height ).mul( cumulative ) ) ),
				float( height - 1 ),
			);
			cdf.element( uint( row ).mul( stride ).add( width ) ).assign( k.add( 0.5 ).div( height ) );

		} );

	} )().compute( 1, [ 1 ] );

	const conditional = Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( width * height ) ), () => {

			Return();

		} );

		const x = idx.mod( width );
		const y = idx.div( width );
		const useCompensated = stats.element( 1 ).z.greaterThan( 0 ).toVar();
		const r = rows.element( y ).toVar();
		const rowTotal = select( useCompensated, r.y, r.x ).toVar();
		const base = y.mul( width ).toVar();
		const k = lowerBound( width, j => {

			const p = prefix.element( base.add( uint( j ) ) );
			return select( useCompensated, p.y, p.x );

		}, float( x ).add( 1 ).div( width ).mul( rowTotal ) );
		const column = select( rowTotal.greaterThan( 0 ), float( k ), float( width - 1 ) );
		cdf.element( y.mul( stride ).add( x ) ).assign( column.add( 0.5 ).div( width ) );

	} )().compute( width * height, [ 64 ] );

	// buildExactEnvironmentTable's floor: a share of the mean weight in every cell.
	const exactFloor = () => stats.element( 0 ).x.mul( 1e-4 / ( width * height ) );

	const exactRows = Fn( () => {

		const y = instanceIndex;
		If( y.greaterThanEqual( uint( height ) ), () => {

			Return();

		} );

		const floor = exactFloor().toVar();
		const rowSum = rows.element( y ).x.add( floor.mul( width ) ).toVar();
		const out = y.add( uint( height ) ).mul( stride ).toVar();
		Loop( { start: int( 0 ), end: int( width ), type: 'int', condition: '<' }, ( { i } ) => {

			const c = prefix.element( y.mul( width ).add( uint( i ) ) ).x.add( floor.mul( float( i ).add( 1 ) ) ).div( max( rowSum, 1e-30 ) );
			cdf.element( out.add( uint( i ) ) ).assign( select( rowSum.greaterThan( 0 ), select( i.equal( int( width - 1 ) ), float( 1 ), c ), float( 0 ) ) );

		} );

	} )().compute( height, [ 64 ] );

	const exactMarginal = Fn( () => {

		firstThreadOnly();
		const floor = exactFloor().mul( width ).toVar();
		const total = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( rows.element( i ).x.add( floor ) );

		} );
		const cumulative = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			cumulative.addAssign( rows.element( i ).x.add( floor ) );
			const c = select( i.equal( int( height - 1 ) ), float( 1 ), cumulative.div( max( total, 1e-30 ) ) );
			cdf.element( uint( i ).add( uint( height ) ).mul( stride ).add( uint( width ) ) ).assign( select( total.greaterThan( 0 ), c, float( 0 ) ) );

		} );

	} )().compute( 1, [ 1 ] );

	return [ rowTotals, mean, prefixSums, marginal, conditional, exactRows, exactMarginal ];

}
