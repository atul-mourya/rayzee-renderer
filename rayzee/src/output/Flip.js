/**
 * @license FLIP and HDR-FLIP (Andersson et al. 2020, 2021), ported from NVIDIA's FLIP.h: https://github.com/NVlabs/flip
 * Copyright (c) 2020-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 */

// FLIP's default viewer: 0.7 m from a 0.7 m wide screen 3840 pixels across.
export const FLIP_DEFAULT_PPD = 0.7 * ( 3840 / 0.7 ) * Math.PI / 180;

const QC = 0.7, PC = 0.4, PT = 0.95, GW = 0.082;
const D65 = [ 0.950428545, 1, 1.088900371 ];
const INV_D65 = [ 1.052156925, 1, 0.918357670 ];
const ACES = [ 0.6 * 0.6 * 2.51, 0.6 * 0.03, 0, 0.6 * 0.6 * 2.43, 0.6 * 0.59, 0.14 ];
const DELTA = 6 / 29;

/**
 * FLIP's per-pixel error, 0–1, of `test` against `reference`, both linear Rec.709 RGB, three floats a pixel. A picture
 * (`hdr` false) is taken in 0–1; light (`hdr`) as HDR-FLIP does: ACES-mapped at each stop of the reference's range,
 * keeping each pixel's largest error.
 * @param {Float32Array} reference
 * @param {Float32Array} test
 * @param {number} width
 * @param {number} height
 * @param {{hdr?: boolean, ppd?: number}} [options] - `ppd`: the viewer's pixels per degree
 * @returns {Float32Array}
 */
export function flipErrorMap( reference, test, width, height, { hdr = false, ppd = FLIP_DEFAULT_PPD } = {} ) {

	const n = width * height;
	const work = workspace( width, height, ppd );
	const error = new Float32Array( n );
	if ( ! hdr ) return ldrFlip( reference.map( unit ), test.map( unit ), work, error );

	const { start, stop } = exposureRange( reference, n );
	const count = Math.max( 2, Math.ceil( stop - start ) );
	const step = ( stop - start ) / ( count - 1 );
	const r = new Float32Array( n * 3 ), t = new Float32Array( n * 3 ), layer = new Float32Array( n );
	for ( let i = 0; i < count; i ++ ) {

		const scale = 2 ** ( start + i * step );
		toneMap( reference, r, scale );
		toneMap( test, t, scale );
		ldrFlip( r, t, work, layer );
		for ( let p = 0; p < n; p ++ ) if ( layer[ p ] > error[ p ] ) error[ p ] = layer[ p ];

	}

	return error;

}

function ldrFlip( reference, test, work, out ) {

	toYCxCz( reference, work.ref );
	toYCxCz( test, work.test );
	colorDifference( work, out );
	featureDifference( work, out );
	return out;

}

function workspace( width, height, ppd ) {

	const n = width * height;
	const planes = ( count ) => Array.from( { length: count }, () => new Float32Array( n ) );
	const radius = Math.max( spatialRadius( ppd ), featureRadius( ppd ) );
	return {
		width, height,
		ref: planes( 3 ), test: planes( 3 ),
		filtered: [ planes( 4 ), planes( 4 ) ],
		temp: planes( 4 ),
		row: new Float32Array( Math.max( width, height ) + 2 * radius ),
		...spatialFilters( ppd ),
		...featureFilters( ppd ),
	};

}

const spatialRadius = ( ppd ) => Math.ceil( 3 * Math.sqrt( 0.04 / ( 2 * Math.PI ** 2 ) ) * ppd );
const featureRadius = ( ppd ) => Math.ceil( 3 * 0.5 * GW * ppd );

// The blue-yellow filter is a sum of two Gaussians: each is separable, so it filters twice.
function spatialFilters( ppd ) {

	const r = spatialRadius( ppd ), size = 2 * r + 1;
	const gaussian = ( x2, a, b ) => a * Math.sqrt( Math.PI / b ) * Math.exp( - ( Math.PI ** 2 ) * x2 / b );
	const root = ( x2, a, b ) => Math.sqrt( a * Math.sqrt( Math.PI / b ) ) * Math.exp( - ( Math.PI ** 2 ) * x2 / b );
	const y = new Float32Array( size ), cx = new Float32Array( size ), cz1 = new Float32Array( size ), cz2 = new Float32Array( size );
	for ( let i = 0; i < size; i ++ ) {

		const x2 = ( ( i - r ) / ppd ) ** 2;
		y[ i ] = gaussian( x2, 1, 0.0047 );
		cx[ i ] = gaussian( x2, 1, 0.0053 );
		cz1[ i ] = root( x2, 34.1, 0.04 );
		cz2[ i ] = root( x2, 13.5, 0.025 );

	}

	const sum = ( k ) => k.reduce( ( s, v ) => s + v, 0 );
	const sy = sum( y ), scx = sum( cx ), scz = Math.hypot( sum( cz1 ), sum( cz2 ) );
	return { spatial: [ fold( y, sy ), fold( cx, scx ), fold( cz1, scz ), fold( cz2, scz ) ] };

}

// A Gaussian and its first and second derivatives; each derivative's positive and negative lobes sum to ±1.
function featureFilters( ppd ) {

	const sd = 0.5 * GW * ppd, r = featureRadius( ppd ), size = 2 * r + 1;
	const g = new Float32Array( size ), dg = new Float32Array( size ), ddg = new Float32Array( size );
	let gSum = 0, dPos = 0, dNeg = 0, ddPos = 0, ddNeg = 0;
	for ( let i = 0; i < size; i ++ ) {

		const x = i - r, w = Math.exp( - ( x * x ) / ( 2 * sd * sd ) );
		g[ i ] = w;
		dg[ i ] = - x * w;
		ddg[ i ] = ( x * x / ( sd * sd ) - 1 ) * w;
		gSum += w;
		if ( dg[ i ] > 0 ) dPos += dg[ i ]; else dNeg -= dg[ i ];
		if ( ddg[ i ] > 0 ) ddPos += ddg[ i ]; else ddNeg -= ddg[ i ];

	}

	for ( let i = 0; i < size; i ++ ) {

		dg[ i ] /= dg[ i ] > 0 ? dPos : dNeg;
		ddg[ i ] /= ddg[ i ] > 0 ? ddPos : ddNeg;

	}

	return { feature: { g: fold( g, gSum ), dg: fold( dg, 1, - 1 ), ddg: fold( ddg, 1 ) } };

}

// Every kernel is mirror-symmetric (`sign` 1) or antisymmetric (-1): kept as its centre and left half.
function fold( k, divisor, sign = 1 ) {

	const r = ( k.length - 1 ) / 2, half = new Float32Array( r + 1 );
	for ( let d = 0; d <= r; d ++ ) half[ d ] = k[ r - d ] / divisor;
	return { half, sign };

}

function colorDifference( work, out ) {

	const { spatial: [ ky, kcx, kcz1, kcz2 ], temp: [ first, second ], filtered } = work;
	for ( const [ k, [ y, cx, cz ]] of [ work.ref, work.test ].entries() ) {

		const [ fy, fcx, fcz1, fcz2 ] = filtered[ k ];
		blur( y, [ ky ], [ first ], [ fy ], work );
		blur( cx, [ kcx ], [ first ], [ fcx ], work );
		blur( cz, [ kcz1, kcz2 ], [ first, second ], [ fcz1, fcz2 ], work );

	}

	const cmax = MAX_DISTANCE, pccmax = PC * cmax;
	const [ ry, rcx, rcz1, rcz2 ] = filtered[ 0 ], [ ty, tcx, tcz1, tcz2 ] = filtered[ 1 ];
	const r = [ 0, 0, 0 ], t = [ 0, 0, 0 ];
	for ( let p = 0; p < out.length; p ++ ) {

		huntLab( ry[ p ], rcx[ p ], rcz1[ p ] + rcz2[ p ], r );
		huntLab( ty[ p ], tcx[ p ], tcz1[ p ] + tcz2[ p ], t );
		const d = hyab( r, t ) ** QC;
		out[ p ] = d < pccmax ? d * PT / pccmax : PT + ( d - pccmax ) / ( cmax - pccmax ) * ( 1 - PT );

	}

}

// The reference's edges and points go where its chroma was: the colour difference no longer needs it.
function featureDifference( work, out ) {

	const { feature: { g, dg, ddg }, temp: [ along, alongTwice, smooth, normalized ], filtered: [[ dx, ddx, dy, ddy ]] } = work;
	const { width: w, height: h } = work;
	const [ , edge, point ] = work.ref;
	for ( const image of [ work.ref, work.test ] ) {

		const y = image[ 0 ];
		for ( let p = 0; p < y.length; p ++ ) normalized[ p ] = y[ p ] / 116 + 16 / 116;
		pass( normalized, w, h, [ dg, ddg, g ], [ along, alongTwice, smooth ], work.row );
		pass( along, h, w, [ g ], [ dx ], work.row );
		pass( alongTwice, h, w, [ g ], [ ddx ], work.row );
		pass( smooth, h, w, [ dg, ddg ], [ dy, ddy ], work.row );
		if ( image === work.ref ) {

			for ( let p = 0; p < y.length; p ++ ) {

				edge[ p ] = Math.sqrt( dx[ p ] * dx[ p ] + dy[ p ] * dy[ p ] );
				point[ p ] = Math.sqrt( ddx[ p ] * ddx[ p ] + ddy[ p ] * ddy[ p ] );

			}

			continue;

		}

		for ( let p = 0; p < out.length; p ++ ) {

			const edges = Math.abs( edge[ p ] - Math.sqrt( dx[ p ] * dx[ p ] + dy[ p ] * dy[ p ] ) );
			const points = Math.abs( point[ p ] - Math.sqrt( ddx[ p ] * ddx[ p ] + ddy[ p ] * ddy[ p ] ) );
			out[ p ] = out[ p ] ** ( 1 - Math.sqrt( Math.SQRT1_2 * Math.max( edges, points ) ) );

		}

	}

}

// Each of `kernels` along the rows, then down the columns, of `src`, through `between`.
function blur( src, kernels, between, outs, work ) {

	const { width: w, height: h, row } = work;
	pass( src, w, h, kernels, between, row );
	for ( let j = 0; j < kernels.length; j ++ ) pass( between[ j ], h, w, [ kernels[ j ] ], [ outs[ j ] ], row );

}

// Each kernel along every row of `src` (w × h), written transposed (h × w): twice is a separable 2D filter. Edge
// pixels repeat.
function pass( src, w, h, kernels, outs, row ) {

	const r = kernels[ 0 ].half.length - 1;
	for ( let y = 0; y < h; y ++ ) {

		const o = y * w;
		row.fill( src[ o ], 0, r );
		row.set( src.subarray( o, o + w ), r );
		row.fill( src[ o + w - 1 ], r + w, w + 2 * r );
		for ( let j = 0; j < kernels.length; j ++ ) {

			const { half, sign } = kernels[ j ], out = outs[ j ];
			for ( let x = 0; x < w; x ++ ) {

				const c = x + r;
				let sum = half[ 0 ] * row[ c ];
				for ( let d = 1; d <= r; d ++ ) sum += half[ d ] * ( row[ c - d ] + sign * row[ c + d ] );
				out[ x * h + y ] = sum;

			}

		}

	}

}

function toYCxCz( rgb, [ y, cx, cz ] ) {

	const xyz = [ 0, 0, 0 ];
	for ( let p = 0; p < y.length; p ++ ) {

		toXYZ( rgb[ p * 3 ], rgb[ p * 3 + 1 ], rgb[ p * 3 + 2 ], xyz );
		const X = xyz[ 0 ] * INV_D65[ 0 ], Y = xyz[ 1 ], Z = xyz[ 2 ] * INV_D65[ 2 ];
		y[ p ] = 116 * Y - 16;
		cx[ p ] = 500 * ( X - Y );
		cz[ p ] = 200 * ( Y - Z );

	}

}

// Filtered YCxCz → linear RGB clamped to 0–1 → CIELAB, chroma scaled by lightness (Hunt).
function huntLab( y, cx, cz, out ) {

	const Y = ( y + 16 ) / 116;
	const X = ( Y + cx / 500 ) * D65[ 0 ], Z = ( Y - cz / 200 ) * D65[ 2 ];
	const r = unit( 3.241003275 * X - 1.537398934 * Y - 0.498615861 * Z );
	const g = unit( - 0.969224334 * X + 1.875930071 * Y + 0.041554224 * Z );
	const b = unit( 0.055639423 * X - 0.204011202 * Y + 1.057148933 * Z );
	return lab( r, g, b, out );

}

function lab( r, g, b, out ) {

	toXYZ( r, g, b, out );
	const fx = labCurve( out[ 0 ] * INV_D65[ 0 ] ), fy = labCurve( out[ 1 ] ), fz = labCurve( out[ 2 ] * INV_D65[ 2 ] );
	const L = 116 * fy - 16;
	out[ 0 ] = L;
	out[ 1 ] = 500 * ( fx - fy ) * 0.01 * L;
	out[ 2 ] = 200 * ( fy - fz ) * 0.01 * L;
	return out;

}

function toXYZ( r, g, b, out ) {

	out[ 0 ] = ( 10135552 * r + 8788810 * g + 4435075 * b ) / 24577794;
	out[ 1 ] = ( 2613072 * r + 8788810 * g + 887015 * b ) / 12288897;
	out[ 2 ] = ( 1425312 * r + 8788810 * g + 70074185 * b ) / 73733382;
	return out;

}

const labCurve = ( t ) => t > DELTA ** 3 ? Math.cbrt( t ) : t / ( 3 * DELTA * DELTA ) + 4 / 29;
const unit = ( v ) => v < 0 ? 0 : v > 1 ? 1 : v;
const hyab = ( a, b ) => Math.abs( a[ 0 ] - b[ 0 ] ) + Math.sqrt( ( a[ 1 ] - b[ 1 ] ) ** 2 + ( a[ 2 ] - b[ 2 ] ) ** 2 );

const MAX_DISTANCE = hyab( lab( 0, 1, 0, [ 0, 0, 0 ] ), lab( 0, 0, 1, [ 0, 0, 0 ] ) ) ** QC;

// From where the reference's brightest pixel maps to 0.85 to where its median does.
function exposureRange( reference, n ) {

	const [ k0, k1, k2, k3, k4, k5 ] = ACES, t = 0.85;
	const a = k0 - t * k3, b = k1 - t * k4, c = k2 - t * k5;
	const d = - 0.5 * b / a;
	const xMax = d + Math.sqrt( d * d - c / a );
	const luminance = new Float32Array( n );
	let max = 0;
	for ( let p = 0; p < n; p ++ ) {

		luminance[ p ] = 0.2126 * reference[ p * 3 ] + 0.7152 * reference[ p * 3 + 1 ] + 0.0722 * reference[ p * 3 + 2 ];
		if ( luminance[ p ] > max ) max = luminance[ p ];

	}

	const median = luminance.sort()[ n >> 1 ];
	const floor = 2 ** - 23;
	return { start: Math.log2( xMax / Math.max( max, floor ) ), stop: Math.log2( xMax / Math.max( median, floor ) ) };

}

function toneMap( rgb, out, scale ) {

	const [ k0, k1, k2, k3, k4, k5 ] = ACES;
	for ( let i = 0; i < rgb.length; i ++ ) {

		const x = rgb[ i ] * scale;
		out[ i ] = unit( ( x * x * k0 + x * k1 + k2 ) / ( x * x * k3 + x * k4 + k5 ) );

	}

}
