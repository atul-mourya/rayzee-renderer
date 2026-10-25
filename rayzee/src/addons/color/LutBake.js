/**
 * Turning an arbitrary OCIO transform into one table that the live canvas, the two readback paths
 * and the host menu can all run identically.
 *
 * OCIO itself can generate WGSL, and for some transforms that WGSL is exact where a table only
 * approximates. It is still not what this engine wants, for one reason: the view transform has to
 * run in four places — a TSL shader graph, a hand-written WGSL compute pass, plain JavaScript, and
 * a host's menu — and only a table is the same thing in all four. A saved image that differs from
 * the viewport is a worse failure than a third of a code value.
 *
 * So OCIO is the source of truth and the validator, not the runtime: `bakeLut` samples a real OCIO
 * processor on a grid, and `measureBakeError` puts a number on what the table costs.
 *
 * Shape: a log2 shaper over `minEv`..`maxEv` feeds a `size`³ cube, interpolated tetrahedrally —
 * the same arrangement OCIO emits for its own GPU path, and the same interpolation it defaults to.
 *
 * ⚠️ Grid index 0 is baked from exactly 0, not from 2^minEv. Without that, true black leaves the
 * table one code value above zero and every render has a raised black floor.
 *
 * A view that steps through a 1D lookup after a grey value (Blender's False Color) adds a `curve`: the cube holds
 * that value, and `n` entries over `lo`..`hi`, linearly interpolated as OCIO reads the lookup, give the colour. The
 * cube blurred the steps: 0.18 grey showed teal. The entries follow the cube in the same texture, extra z slices
 * (entry i is texel size³ + i), so the readback still binds one texture a view.
 *
 * A `linear` table holds light in the canvas's primaries, and the lookup encodes it after interpolating. A converted
 * display's view (and a view's HDR version) is baked both ways and keeps the closer (`bakeView` in OcioViews.js):
 * encoded follows a tone curve better, light a colour whose light crosses 0 inside a cell. A `clip` (`toDisplay`,
 * `fromDisplay`) then clips that light at 0 in the display's own primaries, as its encoding does.
 *
 * A `pre` matrix takes the colour into the space the cube's axes are in before the shaper, which clamps that space's
 * negatives at 0: a view that works channel by channel in Rec.709 needs its zeros on the grid's floor.
 */

/** Smallest shaper step, so log2 of the darkest sample is finite. */
const EPS = 1e-10;

/**
 * Grid index → the scene-linear value it stands for.
 * @param {number} i - 0..size-1
 */
export function unshape( i, size, minEv, maxEv ) {

	if ( i <= 0 ) return 0;
	const t = i / ( size - 1 );
	return Math.pow( 2, minEv + t * ( maxEv - minEv ) );

}

/** Scene-linear value → position along the grid, in [0, size-1]. */
export function shape( v, size, minEv, maxEv ) {

	const ev = Math.log2( Math.max( v, EPS ) );
	const t = ( ev - minEv ) / ( maxEv - minEv );
	return Math.min( Math.max( t, 0 ), 1 ) * ( size - 1 );

}

/**
 * Sample `apply` over the cube.
 *
 * @param {Object} spec
 * @param {number} spec.size - grid edge; 65 is the working default, 33 the coarse end
 * @param {function(Float32Array): void} spec.apply - transforms an RGBA-F32 buffer in place
 * @returns {Float32Array} size³ × 4, red fastest
 */
export function bakeLut( { size, minEv, maxEv, apply } ) {

	const n = size * size * size;
	const buf = new Float32Array( n * 4 );

	const axis = new Float64Array( size );
	for ( let i = 0; i < size; i ++ ) axis[ i ] = unshape( i, size, minEv, maxEv );

	let o = 0;
	for ( let b = 0; b < size; b ++ ) {

		for ( let g = 0; g < size; g ++ ) {

			for ( let r = 0; r < size; r ++ ) {

				buf[ o ++ ] = axis[ r ];
				buf[ o ++ ] = axis[ g ];
				buf[ o ++ ] = axis[ b ];
				buf[ o ++ ] = 1;

			}

		}

	}

	apply( buf );
	return buf;

}

/** Float32 RGBA → Float16 RGBA, for upload as an rgba16float 3D texture. */
export function packHalf( f32 ) {

	const out = new Uint16Array( f32.length );
	const scratchF = new Float32Array( 1 );
	const scratchU = new Uint32Array( scratchF.buffer );

	for ( let i = 0; i < f32.length; i ++ ) {

		scratchF[ 0 ] = f32[ i ];
		const x = scratchU[ 0 ];
		const sign = ( x >>> 16 ) & 0x8000;
		let exp = ( x >>> 23 ) & 0xff;
		let mant = x & 0x7fffff;

		if ( exp === 0xff ) {

			out[ i ] = sign | 0x7c00 | ( mant ? 0x200 : 0 );

		} else if ( exp > 0x70 + 0x1e ) {

			out[ i ] = sign | 0x7bff;

		} else if ( exp < 0x71 ) {

			// Subnormal half, or zero. `>>>` wraps modulo 32 in JavaScript, so a shift that would
			// discard the whole mantissa has to be caught rather than performed.
			const shift = 13 + ( 0x71 - exp );
			mant |= 0x800000;
			out[ i ] = shift >= 32 ? sign : ( sign | ( mant >>> shift ) );

		} else {

			// Round to nearest, ties to even. Truncating biased every value toward zero by up to
			// one unit — a quarter of a code value near white.
			let h = sign | ( ( exp - 0x70 ) << 10 ) | ( mant >>> 13 );
			const rest = mant & 0x1fff;
			if ( rest > 0x1000 || ( rest === 0x1000 && ( h & 1 ) ) ) h ++;
			out[ i ] = ( h & 0x7fff ) >= 0x7c00 ? sign | 0x7bff : h;

		}

	}

	return out;

}

/** Float16 → Float32, the inverse of `packHalf`. */
export function unpackHalf( u16, out = new Float32Array( u16.length ) ) {

	for ( let i = 0; i < u16.length; i ++ ) {

		const h = u16[ i ];
		const sign = ( h & 0x8000 ) ? - 1 : 1;
		const exp = ( h & 0x7c00 ) >> 10;
		const mant = h & 0x03ff;

		if ( exp === 0 ) out[ i ] = sign * Math.pow( 2, - 14 ) * ( mant / 1024 );
		else if ( exp === 0x1f ) out[ i ] = mant ? NaN : sign * Infinity;
		else out[ i ] = sign * Math.pow( 2, exp - 15 ) * ( 1 + mant / 1024 );

	}

	return out;

}

let HALF_TO_FLOAT = null;

/** Every float16 bit pattern decoded once: 256 KB, shared by every sampler. */
function halfToFloatTable() {

	if ( ! HALF_TO_FLOAT ) {

		const all = new Uint16Array( 65536 );
		for ( let i = 0; i < 65536; i ++ ) all[ i ] = i;
		HALF_TO_FLOAT = unpackHalf( all );

	}

	return HALF_TO_FLOAT;

}

/**
 * The six tetrahedra of a cube, as corner offsets and weights.
 *
 * Written once and shared: the CPU sampler calls it, the WGSL generator prints the same six cases,
 * and a test compares the two. Three hand-maintained copies is how the readback drifts from the
 * viewport.
 *
 * @returns {{ w: number[], c: number[][] }} three weights and three corner offsets, added to c000
 */
export function tetrahedron( fx, fy, fz ) {

	if ( fx > fy ) {

		if ( fy > fz ) return { w: [ fx, fy, fz ], c: [[ 1, 0, 0 ], [ 1, 1, 0 ], [ 1, 1, 1 ]] };
		if ( fx > fz ) return { w: [ fx, fz, fy ], c: [[ 1, 0, 0 ], [ 1, 0, 1 ], [ 1, 1, 1 ]] };
		return { w: [ fz, fx, fy ], c: [[ 0, 0, 1 ], [ 1, 0, 1 ], [ 1, 1, 1 ]] };

	}

	if ( fz > fy ) return { w: [ fz, fy, fx ], c: [[ 0, 0, 1 ], [ 0, 1, 1 ], [ 1, 1, 1 ]] };
	if ( fz > fx ) return { w: [ fy, fz, fx ], c: [[ 0, 1, 0 ], [ 0, 1, 1 ], [ 1, 1, 1 ]] };
	return { w: [ fy, fx, fz ], c: [[ 0, 1, 0 ], [ 1, 1, 0 ], [ 1, 1, 1 ]] };

}

/** The canvas colour spaces' curve, extended past 1 and mirrored below 0 as CSS Color 4 extends it. */
export function encodeExtended( v ) {

	const a = Math.abs( v );
	const e = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow( a, 1 / 2.4 ) - 0.055;
	return v < 0 ? - e : e;

}

/** {@link encodeExtended} undone. */
function decodeExtended( v ) {

	const a = Math.abs( v );
	const d = a <= 0.04045 ? a / 12.92 : Math.pow( ( a + 0.055 ) / 1.055, 2.4 );
	return v < 0 ? - d : d;

}

/** The z slices a curve of `n` entries takes after a `size`³ cube. */
export function curveSlices( n, size ) {

	return Math.ceil( n / ( size * size ) );

}

/**
 * Sample `apply` at `n` grey values over `lo`..`hi`, as a curve's entries.
 * @returns {Float32Array} n × 4
 */
export function bakeCurve( { n, lo, hi, apply } ) {

	const buf = new Float32Array( n * 4 );
	for ( let i = 0; i < n; i ++ ) {

		const t = lo + ( hi - lo ) * i / ( n - 1 );
		buf.set( [ t, t, t, 1 ], i * 4 );

	}

	apply( buf );
	return buf;

}

/**
 * A JavaScript sampler over a baked table.
 * @param {?{n: number, lo: number, hi: number}} [options.curve] - entries after the cube, read with its first channel
 * @param {boolean} [options.linear=false] - the table holds light, encoded after the lookup
 * @param {?{toDisplay: number[], fromDisplay: number[]}} [options.clip] - a converted display's clip at 0, after the
 *   lookup: canvas light into the display's primaries (row-major 3×3), negatives to 0, and back
 * @returns {function(number, number, number, Float32Array|number[]): void}
 */
export function makeCpuSampler( { data, size, minEv, maxEv, curve = null, linear = false, clip = null, pre = null } ) {

	const s2 = size * size;
	const last = size - 1;

	// Half-precision tables are read in place through a shared decode table, rather than expanded
	// to a float copy: the copy was 4.4 MB a view, twice the table itself, to save one lookup.
	const halves = data instanceof Uint16Array;
	const decode = halves ? halfToFloatTable() : null;
	const at = halves
		? ( ir, ig, ib, ch ) => decode[ data[ ( ir + ig * size + ib * s2 ) * 4 + ch ] ]
		: ( ir, ig, ib, ch ) => data[ ( ir + ig * size + ib * s2 ) * 4 + ch ];

	return function sampleLut( r, g, b, out ) {

		if ( pre ) {

			const x = r, y = g, z = b;
			r = pre[ 0 ] * x + pre[ 1 ] * y + pre[ 2 ] * z;
			g = pre[ 3 ] * x + pre[ 4 ] * y + pre[ 5 ] * z;
			b = pre[ 6 ] * x + pre[ 7 ] * y + pre[ 8 ] * z;

		}

		const pr = shape( r, size, minEv, maxEv );
		const pg = shape( g, size, minEv, maxEv );
		const pb = shape( b, size, minEv, maxEv );

		const ir = Math.min( Math.floor( pr ), last - 1 );
		const ig = Math.min( Math.floor( pg ), last - 1 );
		const ib = Math.min( Math.floor( pb ), last - 1 );

		const fx = Math.min( Math.max( pr - ir, 0 ), 1 );
		const fy = Math.min( Math.max( pg - ig, 0 ), 1 );
		const fz = Math.min( Math.max( pb - ib, 0 ), 1 );

		const { w, c } = tetrahedron( fx, fy, fz );

		for ( let ch = 0; ch < 3; ch ++ ) {

			const base = at( ir, ig, ib, ch );
			let v = base;
			let prev = base;
			for ( let k = 0; k < 3; k ++ ) {

				const corner = at( ir + c[ k ][ 0 ], ig + c[ k ][ 1 ], ib + c[ k ][ 2 ], ch );
				v += ( corner - prev ) * w[ k ];
				prev = corner;

			}

			out[ ch ] = v;

		}

		if ( curve ) {

			const u = Math.min( Math.max( ( out[ 0 ] - curve.lo ) / ( curve.hi - curve.lo ), 0 ), 1 ) * ( curve.n - 1 );
			const i0 = Math.min( Math.floor( u ), curve.n - 2 );
			const f = u - i0;
			const base = ( size * s2 + i0 ) * 4;
			for ( let ch = 0; ch < 3; ch ++ ) {

				const a = halves ? decode[ data[ base + ch ] ] : data[ base + ch ];
				const z = halves ? decode[ data[ base + 4 + ch ] ] : data[ base + 4 + ch ];
				out[ ch ] = a + ( z - a ) * f;

			}

		}

		if ( clip ) {

			const { toDisplay: t, fromDisplay: f } = clip;
			const [ r, g, b ] = linear ? out : [ decodeExtended( out[ 0 ] ), decodeExtended( out[ 1 ] ), decodeExtended( out[ 2 ] ) ];
			const d0 = Math.max( 0, t[ 0 ] * r + t[ 1 ] * g + t[ 2 ] * b );
			const d1 = Math.max( 0, t[ 3 ] * r + t[ 4 ] * g + t[ 5 ] * b );
			const d2 = Math.max( 0, t[ 6 ] * r + t[ 7 ] * g + t[ 8 ] * b );
			for ( let ch = 0; ch < 3; ch ++ ) out[ ch ] = encodeExtended( f[ ch * 3 ] * d0 + f[ ch * 3 + 1 ] * d1 + f[ ch * 3 + 2 ] * d2 );

		} else if ( linear ) {

			for ( let ch = 0; ch < 3; ch ++ ) out[ ch ] = encodeExtended( out[ ch ] );

		}

	};

}

/**
 * The same sampler in WGSL, reading a 3D texture by integer fetch.
 *
 * `textureLoad` rather than a sampler: filtering an rgba16float 3D texture would need the
 * `float32-filterable` device feature on some backends, and the interpolation here is tetrahedral
 * anyway, which no sampler does.
 *
 * @returns {string} a WGSL fragment declaring `fn <fnName>( c: vec3<f32> ) -> vec3<f32>`
 */
export function lutWgsl( { fnName, texName, size, minEv, maxEv, curve = null, linear = false, clip = null, pre = null } ) {

	const f = v => ( Number.isInteger( v ) ? `${v}.0` : String( v ) );
	const finished = linear || clip;
	const cube = curve || finished ? `${fnName}_cube` : fnName;
	const curved = finished ? `${fnName}_curve` : fnName;
	const row = ( m, r ) => `vec3<f32>( ${f( m[ r * 3 ] )}, ${f( m[ r * 3 + 1 ] )}, ${f( m[ r * 3 + 2 ] )} )`;
	const times = ( m, v ) => `vec3<f32>( dot( ${row( m, 0 )}, ${v} ), dot( ${row( m, 1 )}, ${v} ), dot( ${row( m, 2 )}, ${v} ) )`;
	const curveWgsl = curve ? /* wgsl */ `
fn ${fnName}_entry( i: i32 ) -> vec3<f32> {
	return textureLoad( ${texName}, vec3<i32>( i % ${size}, ( i / ${size} ) % ${size}, ${size} + i / ${size * size} ), 0 ).rgb;
}

fn ${curved}( c: vec3<f32> ) -> vec3<f32> {
	let u = clamp( ( ${cube}( c ).x - ${f( curve.lo )} ) / ${f( curve.hi - curve.lo )}, 0.0, 1.0 ) * ${f( curve.n - 1 )};
	let i0 = min( i32( floor( u ) ), ${curve.n - 2} );
	return mix( ${fnName}_entry( i0 ), ${fnName}_entry( i0 + 1 ), u - f32( i0 ) );
}
` : '';
	const clipWgsl = clip ? /* wgsl */ `
	let a0 = abs( v );
	let light = ${linear ? 'v' : 'sign( v ) * select( pow( ( a0 + 0.055 ) / 1.055, vec3<f32>( 2.4 ) ), a0 / 12.92, a0 <= vec3<f32>( 0.04045 ) )'};
	let d = max( ${times( clip.toDisplay, 'light' )}, vec3<f32>( 0.0 ) );
	let o = ${times( clip.fromDisplay, 'd' )};` : `
	let o = v;`;
	const encodeWgsl = finished ? /* wgsl */ `
fn ${fnName}( c: vec3<f32> ) -> vec3<f32> {
	let v = ${curve ? curved : cube}( c );${clipWgsl}
	let a = abs( o );
	return sign( o ) * select( 1.055 * pow( a, vec3<f32>( 1.0 / 2.4 ) ) - 0.055, 12.92 * a, a <= vec3<f32>( 0.0031308 ) );
}
` : '';

	return /* wgsl */ `
fn ${fnName}_shape( v: vec3<f32> ) -> vec3<f32> {
	let ev = log2( max( ${pre ? times( pre, 'v' ) : 'v'}, vec3<f32>( 1e-10 ) ) );
	let t = ( ev - vec3<f32>( ${f( minEv )} ) ) / ${f( maxEv - minEv )};
	return clamp( t, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) ) * ${f( size - 1 )};
}

fn ${fnName}_fetch( i: vec3<i32> ) -> vec3<f32> {
	return textureLoad( ${texName}, clamp( i, vec3<i32>( 0 ), vec3<i32>( ${size - 1} ) ), 0 ).rgb;
}

fn ${cube}( c: vec3<f32> ) -> vec3<f32> {
	let p = ${fnName}_shape( c );
	let i0 = clamp( vec3<i32>( floor( p ) ), vec3<i32>( 0 ), vec3<i32>( ${size - 2} ) );
	let f = clamp( p - vec3<f32>( i0 ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );

	let c000 = ${fnName}_fetch( i0 );
	var w: vec3<f32>;
	var o1: vec3<i32>;
	var o2: vec3<i32>;
	var o3: vec3<i32>;

	if ( f.x > f.y ) {
		if ( f.y > f.z ) {
			w = vec3<f32>( f.x, f.y, f.z );
			o1 = vec3<i32>( 1, 0, 0 ); o2 = vec3<i32>( 1, 1, 0 ); o3 = vec3<i32>( 1, 1, 1 );
		} else if ( f.x > f.z ) {
			w = vec3<f32>( f.x, f.z, f.y );
			o1 = vec3<i32>( 1, 0, 0 ); o2 = vec3<i32>( 1, 0, 1 ); o3 = vec3<i32>( 1, 1, 1 );
		} else {
			w = vec3<f32>( f.z, f.x, f.y );
			o1 = vec3<i32>( 0, 0, 1 ); o2 = vec3<i32>( 1, 0, 1 ); o3 = vec3<i32>( 1, 1, 1 );
		}
	} else {
		if ( f.z > f.y ) {
			w = vec3<f32>( f.z, f.y, f.x );
			o1 = vec3<i32>( 0, 0, 1 ); o2 = vec3<i32>( 0, 1, 1 ); o3 = vec3<i32>( 1, 1, 1 );
		} else if ( f.z > f.x ) {
			w = vec3<f32>( f.y, f.z, f.x );
			o1 = vec3<i32>( 0, 1, 0 ); o2 = vec3<i32>( 0, 1, 1 ); o3 = vec3<i32>( 1, 1, 1 );
		} else {
			w = vec3<f32>( f.y, f.x, f.z );
			o1 = vec3<i32>( 0, 1, 0 ); o2 = vec3<i32>( 1, 1, 0 ); o3 = vec3<i32>( 1, 1, 1 );
		}
	}

	let v1 = ${fnName}_fetch( i0 + o1 );
	let v2 = ${fnName}_fetch( i0 + o2 );
	let v3 = ${fnName}_fetch( i0 + o3 );

	return c000 + ( v1 - c000 ) * w.x + ( v2 - v1 ) * w.y + ( v3 - v2 ) * w.z;
}
${curveWgsl}${encodeWgsl}`;

}

const EDGE_COLOURS = [[ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ], [ 1, 1, 0 ], [ 0, 1, 1 ], [ 1, 0, 1 ], [ 1, 0.5, 0.5 ], [ 0.5, 1, 0.5 ], [ 0.5, 0.5, 1 ], [ 1, 0.5, 0 ], [ 0, 0.5, 1 ]];

/** Saturated colours where a gamut bends: primaries, secondaries and half mixes, 2^-3..2^4. */
export function edgeColours() {

	const out = [];
	for ( let ev = - 3; ev <= 4; ev += 0.5 ) for ( const c of EDGE_COLOURS ) out.push( c.map( x => x * 2 ** ev ) );
	return out;

}

/**
 * What the table costs against the transform it was baked from.
 *
 * Samples colours the way a render actually produces them — a spread of luminances at a spread of
 * saturations — rather than uniformly over the cube, where most of the volume is colours no scene
 * contains, `clamped` to 0..1 for a table nothing shows outside it (an SDR display's). `edge` is the
 * worst over `edges` (`edgeColours()` in the table's source space), always clamped, as an SDR screen and an 8-bit
 * picture show them: where a gamut bends, which a random spread rarely lands on.
 *
 * @returns {{ mean: number, p95: number, max: number, edge: number, samples: number }} in 8-bit code values
 */
export function measureBakeError( { sampler, apply, count = 4000, seed = 31337, edges = edgeColours(), clamped = false } ) {

	let rng = seed >>> 0;
	const rnd = () => ( rng = ( rng * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;

	const cases = [];
	for ( let i = 0; i < count; i ++ ) {

		const luminance = 0.18 * Math.pow( 2, - 7 + rnd() * 13 );
		const sat = Math.pow( rnd(), 1.2 );
		const hue = rnd() * 6;
		const base = [ 0, 1, 2 ].map( k => 1 - sat * Math.min( 1, Math.abs( ( ( hue + k * 2 ) % 6 ) - 3 ) ) );
		const peak = Math.max( ...base ) || 1;
		cases.push( base.map( v => Math.max( v, 0 ) / peak * luminance ) );

	}

	cases.push( ...edges );

	const truth = new Float32Array( cases.length * 4 );
	cases.forEach( ( c, i ) => {

		truth[ i * 4 ] = c[ 0 ];
		truth[ i * 4 + 1 ] = c[ 1 ];
		truth[ i * 4 + 2 ] = c[ 2 ];
		truth[ i * 4 + 3 ] = 1;

	} );
	apply( truth );

	const out = [ 0, 0, 0 ];
	const shown = v => Math.min( Math.max( v, 0 ), 1 );
	const deltas = [];
	let edge = 0;
	for ( let i = 0; i < cases.length; i ++ ) {

		sampler( cases[ i ][ 0 ], cases[ i ][ 1 ], cases[ i ][ 2 ], out );
		for ( let c = 0; c < 3; c ++ ) {

			const want = truth[ i * 4 + c ];
			if ( i >= count ) edge = Math.max( edge, Math.abs( shown( out[ c ] ) - shown( want ) ) * 255 );
			else deltas.push( ( clamped ? Math.abs( shown( out[ c ] ) - shown( want ) ) : Math.abs( out[ c ] - want ) ) * 255 );

		}

	}

	deltas.sort( ( a, b ) => a - b );
	return {
		mean: deltas.reduce( ( s, v ) => s + v, 0 ) / deltas.length,
		p95: deltas[ Math.floor( deltas.length * 0.95 ) ],
		max: deltas[ deltas.length - 1 ],
		edge,
		samples: deltas.length,
	};

}
