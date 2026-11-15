// A saved render's edits on the Results page: one stack, applied in a fixed order — geometry, adjust, look, detail,
// effects, overlay — by `EditPipeline` (ImageProcessor.js) to the 8-bit picture and the HDR one alike. Pure data and
// arithmetic, so the panels, the store, the database and the tests share it.

const EDITS_VERSION = 1;

export const DEFAULT_EDITS = Object.freeze( {
	version: EDITS_VERSION,
	// crop: fractions of the turned and flipped picture, before straightening shrinks it; aspect: width / height in pixels.
	geometry: Object.freeze( { crop: null, aspect: null, angle: 0, flipX: false, flipY: false, quarterTurns: 0 } ),
	adjust: Object.freeze( { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 } ),
	look: Object.freeze( { id: null, amount: 1 } ),
	detail: Object.freeze( { sharpen: 0, clarity: 0 } ),
	effects: Object.freeze( {
		vignette: Object.freeze( { amount: 0, size: 0.5, softness: 0.5 } ),
		grain: Object.freeze( { amount: 0, size: 0.5 } ),
	} ),
	overlay: null,
} );

export const DEFAULT_OVERLAY = Object.freeze( { text: '', corner: 'bottom-right', size: 0.3, opacity: 0.8 } );

/** Every section filled in, as a fresh object: missing keys take their defaults. */
export function normaliseEdits( edits ) {

	const e = edits ?? {};
	const g = { ...DEFAULT_EDITS.geometry, ...e.geometry };
	const adjust = { ...DEFAULT_EDITS.adjust, ...e.adjust };
	if ( ! ( adjust.gamma > 0 ) ) adjust.gamma = 2.2;
	return {
		version: EDITS_VERSION,
		geometry: { ...g, crop: g.crop ? { ...g.crop } : null, quarterTurns: ( ( Math.round( g.quarterTurns ) % 4 ) + 4 ) % 4 },
		adjust,
		look: { ...DEFAULT_EDITS.look, ...e.look },
		detail: { ...DEFAULT_EDITS.detail, ...e.detail },
		effects: {
			vignette: { ...DEFAULT_EDITS.effects.vignette, ...e.effects?.vignette },
			grain: { ...DEFAULT_EDITS.effects.grain, ...e.effects?.grain },
		},
		overlay: e.overlay ? { ...DEFAULT_OVERLAY, ...e.overlay } : null,
	};

}

/** A render record's edits; a record from before the stack has only the Adjust values, as `colorCorrection`. */
export const readEdits = record => normaliseEdits( record?.edits ?? { adjust: record?.colorCorrection } );

export const sameEdits = ( a, b ) => JSON.stringify( normaliseEdits( a ) ) === JSON.stringify( normaliseEdits( b ) );

/** Whether anything would change the picture. */
export function hasEdits( edits ) {

	const e = normaliseEdits( edits );
	const g = e.geometry;
	return !! g.crop || g.angle !== 0 || g.flipX || g.flipY || g.quarterTurns !== 0
		|| Object.keys( DEFAULT_EDITS.adjust ).some( k => e.adjust[ k ] !== DEFAULT_EDITS.adjust[ k ] )
		|| ( !! e.look.id && e.look.amount > 0 ) || e.detail.sharpen !== 0 || e.detail.clarity !== 0
		|| e.effects.vignette.amount !== 0 || e.effects.grain.amount !== 0 || !! e.overlay?.text.trim();

}

/** `source`'s edits on another render: everything but the geometry, which belongs to the picture it was made for. */
export const pasteEdits = ( target, source ) => ( { ...normaliseEdits( source ), geometry: normaliseEdits( target ).geometry } );

// ---- Geometry: quarter turns, then flips, then straightening, then the crop ----

const FULL = Object.freeze( { x: 0, y: 0, w: 1, h: 1 } );
const EPSILON = 1e-6;
const clamp = ( v, lo, hi ) => Math.min( hi, Math.max( lo, v ) );

/** The picture's size once turned. */
export const orientedSize = ( geometry, width, height ) => ( geometry.quarterTurns % 2 ? { width: height, height: width } : { width, height } );

// Straightening turns the picture by `angle` degrees clockwise about the frame's centre: a frame pixel shows the
// picture's pixel here.
function turn( angle, width, height ) {

	const r = angle * Math.PI / 180, cos = Math.cos( r ), sin = Math.sin( r );
	const cx = width / 2, cy = height / 2;
	return { toPicture: ( x, y ) => [ cx + ( x - cx ) * cos + ( y - cy ) * sin, cy - ( x - cx ) * sin + ( y - cy ) * cos ] };

}

/** Whether `rect` (fractions of the frame) lies inside the frame and inside the straightened picture. */
function cropFits( rect, angle, width, height ) {

	const { toPicture } = turn( angle, width, height );
	const corners = [[ rect.x, rect.y ], [ rect.x + rect.w, rect.y ], [ rect.x, rect.y + rect.h ], [ rect.x + rect.w, rect.y + rect.h ]];
	return corners.every( ( [ fx, fy ] ) => {

		if ( fx < - EPSILON || fy < - EPSILON || fx > 1 + EPSILON || fy > 1 + EPSILON ) return false;
		const [ px, py ] = toPicture( fx * width, fy * height );
		return px > - EPSILON * width && py > - EPSILON * height && px < width * ( 1 + EPSILON ) && py < height * ( 1 + EPSILON );

	} );

}

/** `rect` shrunk about its centre, shape kept, until it fits the frame and the straightened picture. */
function fitCrop( rect, angle, width, height ) {

	const { toPicture } = turn( angle, width, height );
	let cx = ( rect.x + rect.w / 2 ) * width, cy = ( rect.y + rect.h / 2 ) * height;
	const centreFits = ( x, y ) => {

		const [ px, py ] = toPicture( x, y );
		return x >= 0 && y >= 0 && x <= width && y <= height && px >= 0 && py >= 0 && px <= width && py <= height;

	};

	if ( ! centreFits( cx, cy ) ) {

		// Towards the frame's centre, which is inside both.
		let lo = 0, hi = 1;
		for ( let i = 0; i < 30; i ++ ) {

			const t = ( lo + hi ) / 2;
			if ( centreFits( width / 2 + ( cx - width / 2 ) * t, height / 2 + ( cy - height / 2 ) * t ) ) lo = t;
			else hi = t;

		}

		cx = width / 2 + ( cx - width / 2 ) * lo;
		cy = height / 2 + ( cy - height / 2 ) * lo;

	}

	const hw = rect.w * width / 2, hh = rect.h * height / 2;
	const [ px, py ] = toPicture( cx, cy );
	const [ ox, oy ] = toPicture( width / 2, height / 2 );
	let s = Math.min( 1, cx / hw, ( width - cx ) / hw, cy / hh, ( height - cy ) / hh );
	for ( const [ sx, sy ] of [[ 1, 1 ], [ 1, - 1 ], [ - 1, 1 ], [ - 1, - 1 ]] ) {

		// A corner's offset from the centre, in the picture's axes.
		const [ ex, ey ] = toPicture( width / 2 + sx * hw, height / 2 + sy * hh );
		const dx = ex - ox, dy = ey - oy;
		if ( dx > EPSILON ) s = Math.min( s, ( width - px ) / dx );
		else if ( dx < - EPSILON ) s = Math.min( s, px / - dx );
		if ( dy > EPSILON ) s = Math.min( s, ( height - py ) / dy );
		else if ( dy < - EPSILON ) s = Math.min( s, py / - dy );

	}

	s = Math.max( 0, s );
	return { x: ( cx - s * hw ) / width, y: ( cy - s * hh ) / height, w: 2 * s * hw / width, h: 2 * s * hh / height };

}

/** As far from `from` towards `to` as still fits: a dragged crop stops at the picture's edge. */
export function constrainCrop( from, to, angle, width, height ) {

	if ( cropFits( to, angle, width, height ) ) return to;
	const start = cropFits( from, angle, width, height ) ? from : fitCrop( from, angle, width, height );
	const at = t => ( { x: start.x + ( to.x - start.x ) * t, y: start.y + ( to.y - start.y ) * t, w: start.w + ( to.w - start.w ) * t, h: start.h + ( to.h - start.h ) * t } );
	let lo = 0, hi = 1;
	for ( let i = 0; i < 24; i ++ ) {

		const t = ( lo + hi ) / 2;
		if ( cropFits( at( t ), angle, width, height ) ) lo = t;
		else hi = t;

	}

	return at( lo );

}

/** The crop that applies: the stored one (or the whole frame) shrunk to fit the straightened picture. */
export function effectiveCrop( geometry, width, height ) {

	const { width: fw, height: fh } = orientedSize( geometry, width, height );
	const rect = geometry.crop ?? FULL;
	if ( geometry.angle === 0 && cropFits( rect, 0, fw, fh ) ) return { ...rect };
	return fitCrop( rect, geometry.angle, fw, fh );

}

/** The edited picture's size; while the crop is being edited, the whole turned frame. */
export function outputSize( geometry, width, height, { editing = false } = {} ) {

	const frame = orientedSize( geometry, width, height );
	const rect = editing ? FULL : effectiveCrop( geometry, width, height );
	return { width: Math.max( 1, Math.round( rect.w * frame.width ) ), height: Math.max( 1, Math.round( rect.h * frame.height ) ) };

}

/**
 * Where each output position reads the picture: `[ a, b, c, d, e, f ]`, the source at ( a u + b v + c, d u + e v + f ),
 * u and v fractions of the output with v down, the source in fractions with v down. The geometry is affine end to end.
 */
export function sourceTransform( geometry, width, height, { editing = false } = {} ) {

	const { width: fw, height: fh } = orientedSize( geometry, width, height );
	const rect = editing ? FULL : effectiveCrop( geometry, width, height );
	const { toPicture } = turn( geometry.angle, fw, fh );
	const map = ( u, v ) => {

		let [ x, y ] = toPicture( ( rect.x + u * rect.w ) * fw, ( rect.y + v * rect.h ) * fh );
		if ( geometry.flipX ) x = fw - x;
		if ( geometry.flipY ) y = fh - y;
		const fx = x / fw, fy = y / fh;
		switch ( geometry.quarterTurns ) {

			case 1: return [ fy, 1 - fx ];
			case 2: return [ 1 - fx, 1 - fy ];
			case 3: return [ 1 - fy, fx ];
			default: return [ fx, fy ];

		}

	};

	const [ c, f ] = map( 0, 0 );
	const [ ux, uy ] = map( 1, 0 );
	const [ vx, vy ] = map( 0, 1 );
	return [ ux - c, vx - c, c, uy - f, vy - f, f ];

}

/** The picture turned a quarter clockwise (`dir` 1) or anticlockwise (−1), as seen. */
export function turnQuarter( geometry, dir ) {

	const g = normaliseEdits( { geometry } ).geometry;
	const mirrored = g.flipX !== g.flipY;
	const c = g.crop;
	const crop = c && ( dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w } );
	return { ...g, crop, aspect: g.aspect ? 1 / g.aspect : null, quarterTurns: ( g.quarterTurns + ( mirrored ? - dir : dir ) + 4 ) % 4 };

}

/** The picture mirrored left to right (`'x'`) or top to bottom (`'y'`), as seen. */
export function flipGeometry( geometry, axis ) {

	const g = normaliseEdits( { geometry } ).geometry;
	const c = g.crop;
	const crop = c && ( axis === 'x' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h } );
	return { ...g, crop, angle: g.angle === 0 ? 0 : - g.angle, flipX: g.flipX !== ( axis === 'x' ), flipY: g.flipY !== ( axis === 'y' ) };

}

/** The largest crop of `aspect` (null: free) about the current crop's centre. */
export function cropForAspect( geometry, aspect, width, height ) {

	const g = normaliseEdits( { geometry } ).geometry;
	if ( ! aspect ) return { ...g, aspect: null };
	const { width: fw, height: fh } = orientedSize( g, width, height );
	const current = effectiveCrop( g, width, height );
	const frame = fw / fh;
	const w = aspect >= frame ? 1 : aspect / frame;
	const h = aspect >= frame ? frame / aspect : 1;
	const x = clamp( current.x + current.w / 2 - w / 2, 0, 1 - w );
	const y = clamp( current.y + current.h / 2 - h / 2, 0, 1 - h );
	return { ...g, aspect, crop: fitCrop( { x, y, w, h }, g.angle, fw, fh ) };

}

/** Crop shapes, width over height; 'original' is the turned picture's own. */
export const CROP_SHAPES = [
	{ id: 'free', label: 'Free' },
	{ id: 'original', label: 'Original' },
	{ id: '1:1', label: '1:1', aspect: 1 },
	{ id: '4:5', label: '4:5', aspect: 4 / 5 },
	{ id: '3:2', label: '3:2', aspect: 3 / 2 },
	{ id: '16:9', label: '16:9', aspect: 16 / 9 },
	{ id: '9:16', label: '9:16', aspect: 9 / 16 },
];

export function shapeAspect( id, geometry, width, height ) {

	if ( id === 'original' ) {

		const { width: fw, height: fh } = orientedSize( geometry, width, height );
		return fw / fh;

	}

	return CROP_SHAPES.find( s => s.id === id )?.aspect ?? null;

}

/** The shape chip a stored aspect matches: 'free' with none, null for one no chip names (a turned 3:2). */
export function shapeOf( geometry, width, height ) {

	if ( ! geometry.aspect ) return 'free';
	const near = a => Math.abs( a - geometry.aspect ) < 1e-3;
	const fixed = CROP_SHAPES.find( s => s.aspect && near( s.aspect ) );
	if ( fixed ) return fixed.id;
	return near( shapeAspect( 'original', geometry, width, height ) ) ? 'original' : null;

}

// ---- Adjust: the Results panel's six sliders, on the colour as shown (encoded, extended past 1) ----

const LUMA = [ 0.2126, 0.7152, 0.0722 ];
const signedPow = ( x, p ) => Math.sign( x ) * Math.abs( x ) ** p;

function turnHue( rgb, degrees ) {

	const scale = Math.max( 1, ...rgb );
	const [ r, g, b ] = rgb.map( v => v / scale );
	const hi = Math.max( r, g, b ), lo = Math.min( r, g, b ), d = hi - lo, l = ( hi + lo ) / 2;
	if ( d <= 0 ) return rgb;
	const s = l < 0.5 ? d / ( hi + lo ) : d / ( 2 - hi - lo );
	let h = ( hi === r ? ( g - b ) / d + ( g < b ? 6 : 0 ) : hi === g ? ( b - r ) / d + 2 : ( r - g ) / d + 4 ) / 6;
	h = ( ( h + degrees / 360 ) % 1 + 1 ) % 1;
	const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s, p = 2 * l - q;
	const channel = t => {

		t = ( ( t % 1 ) + 1 ) % 1;
		return t < 1 / 6 ? p + ( q - p ) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + ( q - p ) * ( 2 / 3 - t ) * 6 : p;

	};

	return [ channel( h + 1 / 3 ), channel( h ), channel( h - 1 / 3 ) ].map( v => v * scale );

}

/** The Adjust stage on one colour: the CPU twin of `EditPipeline`'s, for thumbnails and tests. */
export function adjustColor( rgb, adjust ) {

	const a = { ...DEFAULT_EDITS.adjust, ...adjust };
	const k = a.contrast / 100;
	const contrasted = rgb.map( x => {

		const c = x + a.brightness / 100 - 0.5;
		return ( k > 0 ? c / ( 1 - k ) : c * ( k + 1 ) ) + 0.5;

	} );
	const linear = contrasted.map( x => signedPow( x, 2.2 ) );
	const luma = linear[ 0 ] * LUMA[ 0 ] + linear[ 1 ] * LUMA[ 1 ] + linear[ 2 ] * LUMA[ 2 ];
	let saturated = linear.map( x => luma + ( x - luma ) * ( a.saturation / 100 + 1 ) );
	if ( Math.abs( a.hue ) > 0.01 ) saturated = turnHue( saturated, a.hue );
	return saturated.map( x => signedPow( x * 2 ** ( a.exposure / 100 ), 1 / a.gamma ) );

}

// ---- Looks: recipes on the shown colour, baked into 33³ tables both pictures read the same way ----

export const LOOK_SIZE = 33;

const smooth = v => v * v * ( 3 - 2 * v );
const curve = ( v, k ) => v + k * ( smooth( clamp( v, 0, 1 ) ) - v );
const toLinear = v => Math.max( 0, v ) ** 2.2;
const toShown = v => Math.max( 0, v ) ** ( 1 / 2.2 );
const lumaOf = ( [ r, g, b ] ) => r * LUMA[ 0 ] + g * LUMA[ 1 ] + b * LUMA[ 2 ];
const saturate = ( c, s ) => {

	const l = lumaOf( c );
	return c.map( v => l + ( v - l ) * s );

};

const balance = ( c, gains ) => c.map( ( v, i ) => toShown( toLinear( v ) * gains[ i ] ) );

const RECIPES = {
	warm: c => saturate( balance( c, [ 1.08, 1, 0.86 ] ), 1.05 ),
	cool: c => saturate( balance( c, [ 0.9, 0.99, 1.12 ] ), 0.97 ),
	matte: c => saturate( c.map( v => 0.07 + curve( v, - 0.15 ) * 0.86 ), 0.85 ),
	mono: c => {

		const l = toShown( toLinear( c[ 0 ] ) * 0.3 + toLinear( c[ 1 ] ) * 0.59 + toLinear( c[ 2 ] ) * 0.11 );
		const v = curve( l, 0.2 );
		return [ v, v, v ];

	},
	punch: c => saturate( c.map( v => curve( v, 0.35 ) ), 1.15 ),
	film: c => {

		const faded = c.map( v => 0.035 + curve( v, 0.22 ) * 0.93 );
		const t = clamp( lumaOf( faded ), 0, 1 );
		const shadow = ( 1 - t ) ** 2, light = t * t;
		const toned = faded.map( ( v, i ) => v + [ - 0.025, 0.008, 0.035 ][ i ] * shadow + [ 0.045, 0.015, - 0.035 ][ i ] * light );
		return saturate( toned, 0.88 );

	},
	vivid: c => saturate( c.map( v => curve( v, 0.12 ) ), 1.35 ),
};

/** The looks offered, in order. */
export const LOOKS = [
	{ id: 'warm', label: 'Warm', tip: 'Golden light: warmer whites and skin.' },
	{ id: 'cool', label: 'Cool', tip: 'Crisp, slightly blue light.' },
	{ id: 'vivid', label: 'Vivid', tip: 'Richer colours, a touch more contrast.' },
	{ id: 'punch', label: 'Punchy', tip: 'High contrast: deeper shadows and brighter lights.' },
	{ id: 'matte', label: 'Matte', tip: 'Soft, faded blacks and quieter colours.' },
	{ id: 'film', label: 'Film', tip: 'Faded blacks, warm lights and cool shadows, like colour film.' },
	{ id: 'mono', label: 'B&W', tip: 'Black and white, with a little extra contrast.' },
];

const baked = new Map();

/** A look's table: RGBA floats, red fastest, then green, then blue. Kept once made. */
export function lookTable( id, size = LOOK_SIZE ) {

	const key = `${id}:${size}`;
	if ( baked.has( key ) ) return baked.get( key );
	const recipe = RECIPES[ id ];
	if ( ! recipe ) throw new Error( `No look called ${id}` );
	const data = new Float32Array( size * size * size * 4 );
	for ( let b = 0, i = 0; b < size; b ++ ) for ( let g = 0; g < size; g ++ ) for ( let r = 0; r < size; r ++, i += 4 ) {

		const out = recipe( [ r / ( size - 1 ), g / ( size - 1 ), b / ( size - 1 ) ] );
		data[ i ] = clamp( out[ 0 ], 0, 1 );
		data[ i + 1 ] = clamp( out[ 1 ], 0, 1 );
		data[ i + 2 ] = clamp( out[ 2 ], 0, 1 );
		data[ i + 3 ] = 1;

	}

	baked.set( key, data );
	return data;

}

/** A look on one colour, as the shader reads its table (trilinear; past white scaled down to it and back). */
export function lookColor( rgb, table, amount = 1, size = LOOK_SIZE ) {

	const scale = Math.max( 1, ...rgb );
	const p = rgb.map( v => clamp( v / scale, 0, 1 ) * ( size - 1 ) );
	const i0 = p.map( v => Math.min( size - 2, Math.floor( v ) ) );
	const t = p.map( ( v, k ) => v - i0[ k ] );
	const out = [ 0, 0, 0 ];
	for ( let corner = 0; corner < 8; corner ++ ) {

		const o = [ corner & 1, ( corner >> 1 ) & 1, ( corner >> 2 ) & 1 ];
		const w = o.reduce( ( m, bit, k ) => m * ( bit ? t[ k ] : 1 - t[ k ] ), 1 );
		const at = ( ( ( i0[ 2 ] + o[ 2 ] ) * size + i0[ 1 ] + o[ 1 ] ) * size + i0[ 0 ] + o[ 0 ] ) * 4;
		for ( let k = 0; k < 3; k ++ ) out[ k ] += table[ at + k ] * w;

	}

	return rgb.map( ( v, k ) => v + ( out[ k ] * scale - v ) * amount );

}
