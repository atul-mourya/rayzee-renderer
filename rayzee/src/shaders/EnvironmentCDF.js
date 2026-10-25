import { Fn, float, int, uint, vec2, vec4, If, Loop, Return, instanceIndex, max, sin, dot, select } from 'three/tsl';

import { REC709_LUMINANCE_COEFFICIENTS } from './Common.js';

/** Floats per row of the packed table: width + 1 RGBA texels, padded to the 256 bytes a buffer→texture copy needs. */
export const cdfRowStride = width => Math.ceil( ( width + 1 ) * 16 / 256 ) * 64;

// First index in [0, n) whose value is above target, n − 1 when none is — as the CPU builder's cutpoints.
function firstAbove( n, valueAt, target ) {

	const lo = int( 0 ).toVar();
	const hi = int( n - 1 ).toVar();
	Loop( { start: int( 0 ), end: int( Math.ceil( Math.log2( n ) ) + 1 ), type: 'int', condition: '<', name: 'step' }, () => {

		If( lo.lessThan( hi ), () => {

			const mid = lo.add( hi ).div( 2 ).toVar();
			If( valueAt( mid ).lessThanEqual( target ), () => {

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
 * The GPU twin of `buildExactEnvironmentTable`, in packExactTable's (width + 1) × height RGBA layout (one cell a
 * texel, compensated by the same mean, without its neighbour weighting: the sky has no sharp texel).
 * `stats[ 1 ]` ends as ( totalSum, compensationDelta, compensated, 0 ).
 * @returns {Array} kernels, dispatched in order
 */
export function buildEnvironmentCDFKernels( { pixels, rows, prefix, stats, cdf, width, height } ) {

	const stride = cdfRowStride( width );
	// Channel c of texel ( x, y ).
	const at = ( x, y, c ) => uint( y ).mul( uint( stride ) ).add( uint( x ).mul( uint( 4 ) ) ).add( uint( c ) );
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

	const totals = Fn( () => {

		firstThreadOnly();
		const compensatedTotal = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			compensatedTotal.addAssign( rows.element( i ).y );

		} );
		const s = stats.element( 0 ).toVar();
		stats.element( 1 ).assign( select( compensatedTotal.greaterThan( 0 ), vec4( compensatedTotal, s.y, 1, 0 ), vec4( s.x, 0, 0, 0 ) ) );

	} )().compute( 1, [ 1 ] );

	// buildExactEnvironmentTable's floor: a share of the mean weight in every cell.
	const exactFloor = () => stats.element( 0 ).x.mul( 1e-4 / ( width * height ) );

	const exactRows = Fn( () => {

		const y = instanceIndex;
		If( y.greaterThanEqual( uint( height ) ), () => {

			Return();

		} );

		const floor = exactFloor().toVar();
		const compensated = stats.element( 1 ).z.greaterThan( 0 ).toVar();
		const r = rows.element( y ).toVar();
		const rowSum = select( compensated, r.y, r.x ).add( floor.mul( width ) ).toVar();
		const below = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( width ), type: 'int', condition: '<' }, ( { i } ) => {

			const p = prefix.element( y.mul( width ).add( uint( i ) ) ).toVar();
			const c = select( compensated, p.y, p.x ).add( floor.mul( float( i ).add( 1 ) ) ).div( max( rowSum, 1e-30 ) );
			const sum = select( rowSum.greaterThan( 0 ), select( i.equal( int( width - 1 ) ), float( 1 ), c ), float( 0 ) ).toVar();
			cdf.element( at( i, y, 0 ) ).assign( sum );
			cdf.element( at( i, y, 1 ) ).assign( below );
			below.assign( sum );

		} );

	} )().compute( height, [ 64 ] );

	const exactMarginal = Fn( () => {

		firstThreadOnly();
		const floor = exactFloor().mul( width ).toVar();
		const compensated = stats.element( 1 ).z.greaterThan( 0 ).toVar();
		const rowSum = ( i ) => {

			const r = rows.element( i ); return select( compensated, r.y, r.x ).add( floor );

		};

		const total = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( rowSum( i ) );

		} );
		const cumulative = float( 0 ).toVar();
		const below = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( height ), type: 'int', condition: '<' }, ( { i } ) => {

			cumulative.addAssign( rowSum( i ) );
			const c = select( i.equal( int( height - 1 ) ), float( 1 ), cumulative.div( max( total, 1e-30 ) ) );
			const sum = select( total.greaterThan( 0 ), c, float( 0 ) ).toVar();
			cdf.element( at( width, i, 0 ) ).assign( sum );
			cdf.element( at( width, i, 1 ) ).assign( below );
			below.assign( sum );

		} );

	} )().compute( 1, [ 1 ] );

	// GUIDES_PER_ENTRY (2) guides an entry, in its texel's z and w: the rows' in columns [0, width), the marginal's in
	// column width.
	const rowGuides = 2 * width * height;
	const guides = Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( rowGuides + 2 * height ) ), () => {

			Return();

		} );

		If( idx.lessThan( uint( rowGuides ) ), () => {

			const g = idx.mod( 2 * width ).toVar();
			const y = idx.div( 2 * width ).toVar();
			const x = firstAbove( width, j => cdf.element( at( j, y, 0 ) ), float( g ).div( 2 * width ) );
			cdf.element( at( g.shiftRight( uint( 1 ) ), y, uint( 2 ).add( g.bitAnd( uint( 1 ) ) ) ) ).assign( float( x ) );

		} ).Else( () => {

			const g = idx.sub( uint( rowGuides ) ).toVar();
			const y = firstAbove( height, j => cdf.element( at( width, j, 0 ) ), float( g ).div( 2 * height ) );
			cdf.element( at( width, g.shiftRight( uint( 1 ) ), uint( 2 ).add( g.bitAnd( uint( 1 ) ) ) ) ).assign( float( y ) );

		} );

	} )().compute( rowGuides + 2 * height, [ 64 ] );

	return [ rowTotals, mean, prefixSums, totals, exactRows, exactMarginal, guides ];

}
