import { describe, it, expect } from 'vitest';
import { tessellateCurve, tessellateCurves, curveTriangleCount } from '@/core/addons/archives/pbrt/PBRTCurves.js';

/** A straight run along +x, as four evenly spaced control points. */
const STRAIGHT = [ 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0 ];

const bounds = positions => {

	const lo = [ Infinity, Infinity, Infinity ], hi = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < positions.length; i += 3 ) {

		for ( let c = 0; c < 3; c ++ ) {

			lo[ c ] = Math.min( lo[ c ], positions[ i + c ] );
			hi[ c ] = Math.max( hi[ c ], positions[ i + c ] );

		}

	}

	return { lo, hi };

};

describe( 'curve tessellation', () => {

	it( 'tessellates a curve set the same with pauses every 1024 curves, and as they are joined', async () => {

		const counts = new Array( 3000 ).fill( 4 );
		const P = new Float64Array( counts.length * 12 );
		for ( let c = 0; c < counts.length; c ++ ) P.set( STRAIGHT.map( ( v, i ) => v + ( i % 3 === 1 ? c * 0.1 : 0 ) ), c * 12 );
		const spec = { P, counts, widths: [ 0.05 ] };

		const plain = await tessellateCurves( spec );
		let pauses = 0;
		const paused = await tessellateCurves( spec, () => {

			pauses ++;
			return Promise.resolve();

		} );

		expect( pauses ).toBe( 4 );
		expect( paused.positions ).toEqual( plain.positions );
		expect( paused.indices ).toEqual( plain.indices );

	} );

	it( 'builds a ribbon of the requested width around a straight bezier', () => {

		const { positions, indices } = tessellateCurve( {
			P: STRAIGHT, basis: 'bezier', width0: 2, width1: 2, steps: 4, sides: 1
		} );

		const { lo, hi } = bounds( positions );
		expect( hi[ 0 ] - lo[ 0 ] ).toBeCloseTo( 3, 4 ); // full length of the curve
		// Width 2 means radius 1 either side of the centreline, on one axis only.
		const spread = [ hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ].sort( ( a, b ) => b - a );
		expect( spread[ 0 ] ).toBeCloseTo( 2, 4 );
		expect( spread[ 1 ] ).toBeCloseTo( 0, 4 );

		expect( indices.length % 3 ).toBe( 0 );
		expect( indices.length / 3 ).toBe( curveTriangleCount( STRAIGHT.length, 'bezier', 4, 1 ) );

	} );

	it( 'tapers from width0 to width1', () => {

		const { positions } = tessellateCurve( {
			P: STRAIGHT, basis: 'bezier', width0: 4, width1: 0, steps: 8, sides: 1
		} );

		// First ring spans the full width; the last collapses to the centreline.
		const first = Math.hypot(
			positions[ 0 ] - positions[ 3 ], positions[ 1 ] - positions[ 4 ], positions[ 2 ] - positions[ 5 ]
		);
		const n = positions.length;
		const last = Math.hypot(
			positions[ n - 6 ] - positions[ n - 3 ], positions[ n - 5 ] - positions[ n - 2 ], positions[ n - 4 ] - positions[ n - 1 ]
		);
		expect( first ).toBeCloseTo( 4, 4 );
		expect( last ).toBeCloseTo( 0, 4 );

	} );

	it( 'crosses two ribbons for a cylinder, filling both axes', () => {

		const single = tessellateCurve( { P: STRAIGHT, width0: 2, width1: 2, steps: 4, sides: 1 } );
		const crossed = tessellateCurve( { P: STRAIGHT, width0: 2, width1: 2, steps: 4, sides: 2 } );

		const s = bounds( single.positions ), c = bounds( crossed.positions );
		const sSpread = [ s.hi[ 1 ] - s.lo[ 1 ], s.hi[ 2 ] - s.lo[ 2 ] ].sort( ( a, b ) => b - a );
		const cSpread = [ c.hi[ 1 ] - c.lo[ 1 ], c.hi[ 2 ] - c.lo[ 2 ] ].sort( ( a, b ) => b - a );

		expect( sSpread[ 1 ] ).toBeCloseTo( 0, 4 ); // a single ribbon is flat
		expect( cSpread[ 1 ] ).toBeCloseTo( 2, 4 ); // the crossed pair is not
		expect( crossed.indices.length ).toBe( single.indices.length * 2 );

	} );

	it( 'closes a tube when asked for three or more sides', () => {

		const { positions, indices } = tessellateCurve( {
			P: STRAIGHT, width0: 2, width1: 2, steps: 2, sides: 6
		} );

		// A hexagon inscribed in radius 1 spans 2 vertex-to-vertex and 2*cos(30) flat-to-flat,
		// so check the section is closed and near-circular rather than exactly square.
		const { lo, hi } = bounds( positions );
		const spans = [ hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ];
		expect( Math.max( ...spans ) ).toBeCloseTo( 2, 3 );
		expect( Math.min( ...spans ) ).toBeGreaterThanOrEqual( 2 * Math.cos( Math.PI / 6 ) - 1e-3 );
		expect( indices.length / 3 ).toBe( curveTriangleCount( STRAIGHT.length, 'bezier', 2, 6 ) );

	} );

	it( 'reads a 7-point cubic b-spline as four spans, the way Moana writes them', () => {

		// isMountainB's ground cover: degree 3, bspline basis, 7 control points.
		const P = [];
		for ( let i = 0; i < 7; i ++ ) P.push( i, 0, 0 );

		const { indices } = tessellateCurve( { P, basis: 'bspline', width0: 1, width1: 1, steps: 2, sides: 1 } );
		// 4 spans x 2 steps = 8 segments, 2 triangles each.
		expect( indices.length / 3 ).toBe( 16 );
		expect( curveTriangleCount( P.length, 'bspline', 2, 1 ) ).toBe( 16 );

	} );

	it( 'keeps a b-spline inside the hull of its control points', () => {

		const P = [ 0, 0, 0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 20, 0, 0, 20, 10, 0, 30, 10, 0 ];
		const { positions } = tessellateCurve( { P, basis: 'bspline', width0: 0.001, width1: 0.001, steps: 6, sides: 1 } );
		const { lo, hi } = bounds( positions );

		expect( lo[ 0 ] ).toBeGreaterThanOrEqual( - 0.01 );
		expect( hi[ 0 ] ).toBeLessThanOrEqual( 30.01 );
		expect( lo[ 1 ] ).toBeGreaterThanOrEqual( - 0.01 );
		expect( hi[ 1 ] ).toBeLessThanOrEqual( 10.01 );

	} );

	it( 'produces no NaN on a curve that doubles back on itself', () => {

		// A reversing tangent is where a naive frame degenerates.
		const P = [ 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0 ];
		const { positions } = tessellateCurve( { P, basis: 'bspline', width0: 1, width1: 1, steps: 8, sides: 2 } );
		expect( positions.every( Number.isFinite ) ).toBe( true );

	} );

	it( 'refuses fewer than four control points', () => {

		expect( tessellateCurve( { P: [ 0, 0, 0, 1, 0, 0 ] } ) ).toBe( null );

	} );

	describe( 'adaptive', () => {

		// A leaf that runs straight and then hooks over at the end.
		const HOOK = [ 0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0, 50, 0, 0, 55, 5, 0, 55, 10, 0 ];

		const rows = ( built, sides ) => built.positions.length / 3 / ( sides >= 3 ? sides : sides * 2 );

		it( 'is the uniform strip, bit for bit, at tolerance 0', () => {

			const spec = { P: HOOK, basis: 'bspline', width0: 1, width1: 0.4, steps: 2, sides: 2 };
			const uniform = tessellateCurve( spec );
			const zero = tessellateCurve( { ...spec, tolerance: 0 } );
			expect( Array.from( zero.positions ) ).toEqual( Array.from( uniform.positions ) );
			expect( Array.from( zero.indices ) ).toEqual( Array.from( uniform.indices ) );

		} );

		it( 'takes a straight curve in one segment', () => {

			const P = [];
			for ( let i = 0; i < 12; i ++ ) P.push( i, 0, 0 );
			const { indices } = tessellateCurve( { P, basis: 'bspline', width0: 1, width1: 1, steps: 2, sides: 1, tolerance: 0.1 } );
			expect( indices.length / 3 ).toBe( 2 );

		} );

		it( 'keeps the bent end and drops the straight run', () => {

			const spec = { P: HOOK, basis: 'bspline', width0: 1, width1: 1, steps: 2, sides: 1 };
			const uniform = tessellateCurve( spec );
			const adaptive = tessellateCurve( { ...spec, tolerance: 0.1 } );
			expect( rows( adaptive, 1 ) ).toBeLessThan( rows( uniform, 1 ) );
			expect( rows( adaptive, 1 ) ).toBeGreaterThan( 2 );

		} );

		it( 'keeps a subset of the uniform rings, facing the same way', () => {

			const spec = { P: HOOK, basis: 'bspline', width0: 1, width1: 0.4, steps: 2, sides: 2 };
			const uniform = tessellateCurve( spec );
			const adaptive = tessellateCurve( { ...spec, tolerance: 0.1 } );

			const ring = ( built, i ) => Array.from( built.positions.subarray( i * 12, i * 12 + 12 ) );
			const all = [];
			for ( let i = 0; i < rows( uniform, 2 ); i ++ ) all.push( ring( uniform, i ).join( ',' ) );
			for ( let i = 0; i < rows( adaptive, 2 ); i ++ ) expect( all ).toContain( ring( adaptive, i ).join( ',' ) );

		} );

		it( 'never strays further than the tolerance or the uniform strip does', () => {

			const width = 1, tolerance = 0.1;
			const spec = { P: HOOK, basis: 'bspline', width0: width, width1: width, steps: 2, sides: 1 };
			const truth = tessellateCurve( { ...spec, steps: 64 } );
			const uniform = tessellateCurve( spec );
			const adaptive = tessellateCurve( { ...spec, tolerance } );

			const centres = built => {

				const out = [];
				for ( let i = 0; i < built.positions.length; i += 6 ) out.push( [ 0, 1, 2 ].map( c => ( built.positions[ i + c ] + built.positions[ i + 3 + c ] ) / 2 ) );
				return out;

			};

			const strayOf = line => {

				let worst = 0;
				for ( const p of centres( truth ) ) {

					let best = Infinity;
					for ( let k = 0; k < line.length - 1; k ++ ) {

						const a = line[ k ], b = line[ k + 1 ];
						const d = [ 0, 1, 2 ].map( c => b[ c ] - a[ c ] );
						const len2 = d[ 0 ] ** 2 + d[ 1 ] ** 2 + d[ 2 ] ** 2;
						const t = Math.min( 1, Math.max( 0, ( ( p[ 0 ] - a[ 0 ] ) * d[ 0 ] + ( p[ 1 ] - a[ 1 ] ) * d[ 1 ] + ( p[ 2 ] - a[ 2 ] ) * d[ 2 ] ) / len2 ) );
						best = Math.min( best, Math.hypot( p[ 0 ] - a[ 0 ] - t * d[ 0 ], p[ 1 ] - a[ 1 ] - t * d[ 1 ], p[ 2 ] - a[ 2 ] - t * d[ 2 ] ) );

					}

					worst = Math.max( worst, best );

				}

				return worst;

			};

			const allowed = Math.max( strayOf( centres( uniform ) ), tolerance * width / 2 );
			expect( strayOf( centres( adaptive ) ) ).toBeLessThanOrEqual( allowed * 1.05 );

		} );

	} );

} );

describe( 'USD curves', () => {

	// A one-sided strip's rows: each row's centre, half-width and the direction it spans.
	function rows( built ) {

		const p = built.positions, out = [];
		for ( let i = 0; i < p.length; i += 6 ) {

			const span = [ p[ i + 3 ] - p[ i ], p[ i + 4 ] - p[ i + 1 ], p[ i + 5 ] - p[ i + 2 ] ];
			out.push( {
				centre: [ p[ i ] + span[ 0 ] / 2, p[ i + 1 ] + span[ 1 ] / 2, p[ i + 2 ] + span[ 2 ] / 2 ],
				half: Math.hypot( ...span ) / 2,
				span,
			} );

		}

		return out;

	}

	const near = ( a, b ) => a.forEach( ( v, k ) => expect( v ).toBeCloseTo( b[ k ], 5 ) );
	const curve = ( P, extra = {} ) => tessellateCurves( { P: Float32Array.from( P ), counts: [ P.length / 3 ], widths: [ 0.1 ], steps: 3, ...extra } );

	const BEND = [ 0, 0, 0, 1, 0, 0, 1, 1, 0 ];
	const SQUARE = [ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0 ];

	it( 'draws a linear curve through its points, evenly along each segment', async () => {

		const r = rows( await curve( BEND, { type: 'linear' } ) );
		expect( r ).toHaveLength( 7 );
		[[ 0, 0, 0 ], [ 1 / 3, 0, 0 ], [ 2 / 3, 0, 0 ], [ 1, 0, 0 ], [ 1, 1 / 3, 0 ], [ 1, 2 / 3, 0 ], [ 1, 1, 0 ]]
			.forEach( ( p, i ) => near( r[ i ].centre, p ) );

	} );

	it( 'closes a periodic linear curve', async () => {

		const r = rows( await curve( BEND, { type: 'linear', wrap: 'periodic' } ) );
		near( r.at( - 1 ).centre, r[ 0 ].centre );
		near( r[ 6 ].centre, [ 1, 1, 0 ] );

	} );

	it( 'runs a Catmull-Rom curve from its second point to its next to last, through its first and last when pinned', async () => {

		const plain = rows( await curve( SQUARE, { basis: 'catmullRom' } ) );
		near( plain[ 0 ].centre, [ 1, 0, 0 ] );
		near( plain.at( - 1 ).centre, [ 1, 1, 0 ] );

		const pinned = rows( await curve( SQUARE, { basis: 'catmullRom', wrap: 'pinned' } ) );
		[[ 0, 0, 0 ], [ 1, 0, 0 ], [ 1, 1, 0 ], [ 0, 1, 0 ]].forEach( ( p, i ) => near( pinned[ i * 3 ].centre, p ) );

		const periodic = rows( await curve( SQUARE, { basis: 'catmullRom', wrap: 'periodic' } ) );
		near( periodic.at( - 1 ).centre, periodic[ 0 ].centre );

	} );

	it( 'keeps a Catmull-Rom curve through evenly spaced points on a line even', async () => {

		const r = rows( await curve( STRAIGHT, { basis: 'catmullRom' } ) );
		[ 1, 4 / 3, 5 / 3, 2 ].forEach( ( x, i ) => near( r[ i ].centre, [ x, 0, 0 ] ) );

	} );

	it( 'starts and ends a pinned b-spline on its first and last points, which a plain one does not touch', async () => {

		const pinned = rows( await curve( SQUARE, { basis: 'bspline', wrap: 'pinned' } ) );
		near( pinned[ 0 ].centre, [ 0, 0, 0 ] );
		near( pinned.at( - 1 ).centre, [ 0, 1, 0 ] );

		const plain = rows( await curve( SQUARE, { basis: 'bspline' } ) );
		// ( P0 + 4 P1 + P2 ) / 6
		near( plain[ 0 ].centre, [ 5 / 6, 1 / 6, 0 ] );

	} );

	it( 'closes a periodic b-spline and a periodic bezier', async () => {

		const spline = rows( await curve( SQUARE, { basis: 'bspline', wrap: 'periodic' } ) );
		near( spline.at( - 1 ).centre, spline[ 0 ].centre );

		const HEXAGON = [ 1, 0, 0, 0.5, 0.9, 0, - 0.5, 0.9, 0, - 1, 0, 0, - 0.5, - 0.9, 0, 0.5, - 0.9, 0 ];
		const bezier = rows( await curve( HEXAGON, { basis: 'bezier', wrap: 'periodic' } ) );
		near( bezier[ 0 ].centre, [ 1, 0, 0 ] );
		near( bezier.at( - 1 ).centre, [ 1, 0, 0 ] );

	} );

	it( 'reads widths per vertex, per curve, per span boundary or once', async () => {

		const LINE = [ 0, 0, 0, 1, 0, 0 ];
		const vertex = rows( await curve( LINE, { type: 'linear', widths: [ 1, 3 ], widthMode: 'vertex' } ) );
		[ 0.5, 5 / 6, 7 / 6, 1.5 ].forEach( ( h, i ) => expect( vertex[ i ].half ).toBeCloseTo( h, 5 ) );

		const two = { P: Float32Array.from( [ ...LINE, ...LINE ] ), counts: [ 2, 2 ], type: 'linear', steps: 1 };
		// The second curve's widths start at its own first vertex.
		const vertices = rows( await tessellateCurves( { ...two, widths: [ 1, 3, 5, 7 ], widthMode: 'vertex' } ) );
		expect( vertices.map( ( r ) => r.half ) ).toEqual( [ 0.5, 1.5, 2.5, 3.5 ] );

		const uniform = rows( await tessellateCurves( { ...two, widths: [ 1, 4 ], widthMode: 'uniform' } ) );
		expect( uniform.map( ( r ) => r.half ) ).toEqual( [ 0.5, 0.5, 2, 2 ] );

		// Two values a curve here (one span), the second curve's after the first's.
		const varying = rows( await tessellateCurves( { ...two, widths: [ 1, 2, 3, 4 ], widthMode: 'varying' } ) );
		varying.forEach( ( r, i ) => expect( r.half ).toBeCloseTo( [ 0.5, 1, 1.5, 2 ][ i ], 5 ) );

		const constant = rows( await tessellateCurves( { ...two, widths: [ 2, 9 ], widthMode: 'constant' } ) );
		expect( constant.every( ( r ) => r.half === 1 ) ).toBe( true );

	} );

	it( 'turns each ribbon to face its curve\'s normal', async () => {

		const LINE = [ 0, 0, 0, 1, 0, 0 ];
		const two = { P: Float32Array.from( [ ...LINE, ...LINE ] ), counts: [ 2, 2 ], type: 'linear', steps: 1, widths: [ 1 ] };
		const facing = ( r, axis ) => Math.abs( r.span[ axis ] ) / Math.hypot( ...r.span );

		const uniform = rows( await tessellateCurves( { ...two, N: [ 0, 0, 1, 0, 1, 0 ], normalMode: 'uniform' } ) );
		// Facing +z, a ribbon along x spans y; facing +y, it spans z.
		expect( facing( uniform[ 0 ], 1 ) ).toBeCloseTo( 1, 5 );
		expect( facing( uniform[ 2 ], 2 ) ).toBeCloseTo( 1, 5 );

		// A curve's first vertex normal: the second curve starts at vertex 2.
		const vertex = rows( await tessellateCurves( { ...two, N: [ 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0 ], normalMode: 'vertex' } ) );
		expect( facing( vertex[ 0 ], 1 ) ).toBeCloseTo( 1, 5 );
		expect( facing( vertex[ 2 ], 2 ) ).toBeCloseTo( 1, 5 );

		const constant = rows( await tessellateCurves( { ...two, N: [ 0, 1, 0, 0, 0, 1 ], normalMode: 'constant' } ) );
		expect( facing( constant[ 0 ], 2 ) ).toBeCloseTo( 1, 5 );
		expect( facing( constant[ 2 ], 2 ) ).toBeCloseTo( 1, 5 );

	} );

	it( 'skips and counts the curves it cannot build', async () => {

		const P = Float32Array.from( [ ...STRAIGHT, 0, 0, 0, 1, 0, 0, 2, 0, 0 ] );
		const built = await tessellateCurves( { P, counts: [ 4, 3 ], basis: 'bezier', widths: [ 0.1 ] } );
		expect( built.skipped ).toBe( 1 );

		expect( await tessellateCurves( { P: Float32Array.from( STRAIGHT ), counts: [ 4 ], basis: 'hermite', widths: [ 0.1 ] } ) ).toBeNull();

	} );

} );
