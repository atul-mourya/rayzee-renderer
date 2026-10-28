/**
 * A display, a view and optionally a look, turned into something the engine can render with.
 *
 * This is the output half of colour management. The config says what "sRGB - Display / ACES 2.0 -
 * SDR 100 nits" means; this bakes that meaning into a table (see `LutBake.js`) and registers it so
 * `renderer.toneMapping = entry.id` just works — on the canvas, in a saved PNG, and through OIDN.
 *
 * ⚠️ An OCIO view returns colour **already encoded for its display**. The renderer must therefore
 * not encode it again: `ColorManagement` sets `renderer.outputColorSpace` to linear while one is
 * active, and the readback skips its sRGB step via `outputEncoded`. Get that wrong and every
 * image is encoded twice — washed out, with crushed blacks.
 */

import { Data3DTexture, RGBAFormat, HalfFloatType, NearestFilter, ClampToEdgeWrapping } from 'three';
import {
	Fn, vec3, ivec3, float, int, floor, clamp, log2, max, min, mix, step, sign, dot, If, texture3DLoad,
} from 'three/tsl';

import { ISSUE_CODES } from '../../EngineIssues.js';
import { displayCanvasFit, isDataView, isHdrDisplay, findNativeLinearSpace } from './Displays.js';
import { getRuntime, getConfigInfo, getConfigText, describeConfig } from './OcioRuntime.js';
import { extractMatrix } from './ColorSpaces.js';
import { bakeLut, bakeCurve, curveSlices, encodeExtended, makeCpuSampler, packHalf, lutWgsl, measureBakeError, edgeColours } from './LutBake.js';

export { encodeExtended };
import { addViewTransform, nextOcioId, VIEW_TRANSFORMS } from '../../color/ViewTransforms.js';

/** 25 stops, which is wider than any renderer output worth showing. */
export const DEFAULT_MIN_EV = - 12.47393;
export const DEFAULT_MAX_EV = 12.5260688117;

/** 65³ measures a mean of 0.11 code values against OCIO itself, for 2.1 MB. */
export const DEFAULT_LUT_SIZE = 65;
/** Where 65³ measures poorly (`tableScore`), the bake tries 97³ (7.3 MB) and keeps the closer. */
const FINE_LUT_SIZE = 97;

/** Above 1: a saturated colour 5 levels off, or a mean of 0.4. */
const tableScore = error => Math.max( error.edge / 5, error.mean / 0.4 );


let issueLog = null;

/**
 * The texture and TSL node already built for each registered id.
 *
 * Rebaking a view — a different look, a new `$SHOT`, a changed working space — must not hand the
 * renderer a *different* node for the same id. three.js caches the compiled graph, and its node
 * library refuses to redefine an id at all, so a new node either does nothing or forces a shader
 * rebuild. Swapping the pixels inside the texture the graph already points at avoids both, and is
 * the same pattern `UniformManager` uses: build the node once, mutate its value.
 */
const liveViews = new Map();

/** Wire the engine's degradation log in, so a mismatch is recorded rather than only warned. */
export function setOcioIssueLog( log ) {

	issueLog = log;

}

function configHandle() {

	const rt = getRuntime();
	if ( ! rt ) throw new Error( 'load an OCIO config first' );
	if ( ! rt.config ) throw new Error( 'OCIO runtime exposes no Config handle' );
	return rt.config;

}

/**
 * The processor for one view, including a look when asked for.
 *
 * A look is applied as a separate step before the display transform, not through the view's own
 * `looks` field — that field is whatever the config author attached, and a host choosing a look
 * from the menu means "also this one".
 */
function createViewProcessor( { source, display, view, look, context, decodeFrom = null, decodeTo = null } ) {

	const config = configHandle();
	const options = context ? { context } : undefined;

	if ( ! look && ! decodeTo ) {

		return config.createDisplayViewProcessor( { source, display, view, ...( context ? { context } : {} ) } );

	}

	return config.createGroupTransformProcessor( [
		...( look ? [ { type: 'look', source, destination: source, looks: look } ] : [] ),
		{ type: 'displayView', source, display, view },
		...( decodeTo ? [ { type: 'colorSpace', source: decodeFrom, destination: decodeTo } ] : [] ),
	], options );

}

/** The colour space a view's output is in: its display's own, unless the view names another. */
function viewOutputSpace( info, display, view ) {

	const space = info.viewsByDisplay[ display ]?.find( v => v.name === view )?.colorSpace;
	return ! space || space === '<USE_DISPLAY_NAME>' ? display : space;

}

const fits = new WeakMap();

const decodeSRGB = v => Math.sign( v ) * ( Math.abs( v ) <= 0.04045 ? Math.abs( v ) / 12.92 : Math.pow( ( Math.abs( v ) + 0.055 ) / 1.055, 2.4 ) );
const mul3 = ( m, v ) => [ 0, 3, 6 ].map( r => m[ r ] * v[ 0 ] + m[ r + 1 ] * v[ 1 ] + m[ r + 2 ] * v[ 2 ] );

function invert3( m ) {

	const [ a, b, c, d, e, f, g, h, i ] = m;
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [ A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d ].map( v => v / det );

}

/**
 * Measured through the config: `fit`, the canvas colour space a space's encoding *is* ('srgb', 'display-p3', else
 * null); `wide`, primaries past sRGB's; `convertible`, false for data, scene-referred spaces and configs without a
 * display connection space.
 * @returns {{ fit: ?string, wide: boolean, convertible: boolean }}
 */
export function canvasFitOf( space ) {

	const info = getConfigInfo();
	if ( ! info ) return { fit: displayCanvasFit( space ), wide: false, convertible: false };

	let byConfig = fits.get( info );
	if ( ! byConfig ) fits.set( info, byConfig = new Map() );
	if ( byConfig.has( space ) ) return byConfig.get( space );

	const listed = info.colorSpaces.find( c => c.name === space || c.aliases?.includes( space ) );
	const reference = displayReferenceSpace();
	let result = { fit: displayCanvasFit( space ), wide: false, convertible: false };

	if ( reference && ! listed?.isData && listed?.referenceSpace !== 0 ) {

		const codes = [[ 1, 0, 0 ], [ 0, 1, 0 ], [ 0, 0, 1 ], [ 0.5, 0.5, 0.5 ], [ 0.2, 0.7, 0.1 ], [ 0.9, 0.05, 0.4 ], [ 0.02, 0.02, 0.02 ], [ 1, 1, 1 ]];
		const buffer = new Float32Array( codes.flatMap( c => [ ...c, 1 ] ) );
		const processor = configHandle().createColorSpaceProcessor( space, reference );
		try {

			processor.applyRGBAF32( buffer );

		} finally {

			processor.dispose();

		}

		const xyz = i => [ buffer[ i * 4 ], buffer[ i * 4 + 1 ], buffer[ i * 4 + 2 ] ];
		const matches = canvas => {

			const toXYZ = invert3( XYZ_TO_CANVAS[ canvas ] );
			return codes.every( ( code, i ) => mul3( toXYZ, code.map( decodeSRGB ) )
				.every( ( want, k ) => Math.abs( xyz( i )[ k ] - want ) <= 2e-3 * Math.max( 1, Math.abs( want ) ) ) );

		};

		const wide = [ 0, 1, 2 ].some( i => {

			const rgb = mul3( XYZ_TO_CANVAS.srgb, xyz( i ) );
			return Math.min( ...rgb ) < - 1e-3 * Math.max( ...rgb.map( Math.abs ) );

		} );

		result = { fit: [ 'srgb', 'display-p3' ].find( matches ) ?? null, wide, convertible: true };

	}

	byConfig.set( space, result );
	return result;

}

const clips = new WeakMap();

const times3 = ( a, b ) => [ 0, 1, 2 ].flatMap( r => [ 0, 1, 2 ].map( c => a[ r * 3 ] * b[ c ] + a[ r * 3 + 1 ] * b[ 3 + c ] + a[ r * 3 + 2 ] * b[ 6 + c ] ) );

/**
 * A converted display's clip at 0 in its own primaries, as canvas-light matrices (`toDisplay`, `fromDisplay`), for the
 * lookup to apply after interpolating; null where the display's encoding does not clip there. Rec.1886's and Rec.2020's
 * `ExponentTransform` do: baked in, the clip was a kink inside the cube's cells; left out, a colour outside the
 * display's gamut was clipped in the canvas's instead (Standard on Rec.2020 in ACEScg, 61 levels).
 */
function displayClip( space, canvas ) {

	const info = getConfigInfo();
	let byConfig = clips.get( info );
	if ( ! byConfig ) clips.set( info, byConfig = new Map() );
	const key = `${space}|${canvas}`;
	if ( byConfig.has( key ) ) return byConfig.get( key );

	let result = null;
	const reference = displayReferenceSpace();
	try {

		const config = configHandle();
		const decode = config.createColorSpaceProcessor( space, reference );
		const encode = config.createColorSpaceProcessor( reference, space );
		try {

			// The display's primaries, as columns: its full red, green and blue codes decoded.
			const p = decode.applyRGBAF32( new Float32Array( [ 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1 ] ), { copy: true } );
			const primaries = [ p[ 0 ], p[ 4 ], p[ 8 ], p[ 1 ], p[ 5 ], p[ 9 ], p[ 2 ], p[ 6 ], p[ 10 ] ];
			// A colour with the display's red below 0, through its encoding and back: red at 0 means it clips.
			const probe = mul3( primaries, [ - 0.05, 0.3, 0.3 ] );
			const back = decode.applyRGBAF32( encode.applyRGBAF32( new Float32Array( [ ...probe, 1 ] ), { copy: true } ), { copy: true } );
			if ( Math.abs( mul3( invert3( primaries ), [ back[ 0 ], back[ 1 ], back[ 2 ] ] )[ 0 ] ) < 1e-3 ) {

				const fromDisplay = times3( XYZ_TO_CANVAS[ canvas ], primaries );
				result = { toDisplay: invert3( fromDisplay ), fromDisplay };

			}

		} finally {

			decode.dispose();
			encode.dispose();

		}

	} catch {

		result = null;

	}

	byConfig.set( key, result );
	return result;

}

/** Display-linear CIE XYZ → the canvas colour space's light, in place; the lookup encodes it (a `linear` table). */
function lightForCanvas( buffer, canvas ) {

	const m = XYZ_TO_CANVAS[ canvas ];
	for ( let i = 0; i < buffer.length; i += 4 ) {

		const x = buffer[ i ], y = buffer[ i + 1 ], z = buffer[ i + 2 ];
		buffer[ i ] = m[ 0 ] * x + m[ 1 ] * y + m[ 2 ] * z;
		buffer[ i + 1 ] = m[ 3 ] * x + m[ 4 ] * y + m[ 5 ] * z;
		buffer[ i + 2 ] = m[ 6 ] * x + m[ 7 ] * y + m[ 8 ] * z;

	}

}

// ── The derived config ──────────────────────────────────────────────────────────────────────────────────────────────
// The loaded config's own text plus, for every view transform defined from the scene reference, a scene-referred
// colour space holding it (the view's light before its display's encoding), and, for one that steps through a .spi1d
// after a grey value (Blender's False Color), that transform split there: the part before as a colour space, the
// lookup and the rest as a named transform. Built the first time a bake needs it, once a config.

let derived = null;

const indentOf = line => line.search( /\S/ );

/** Where the runtime mounted the config's files, so the derived config finds its LUTs; '' for a built-in one. */
function mountedRoot( rt, text ) {

	const FS = rt.ocio?.module?.FS;
	const base = '/ocio-runtime/configs';
	try {

		for ( const dir of FS?.readdir( base ) ?? [] ) {

			if ( dir[ 0 ] === '.' ) continue;
			const path = `${base}/${dir}`;
			if ( FS.readdir( path ).some( n => /\.ocio$/i.test( n ) && new TextDecoder().decode( FS.readFile( `${path}/${n}` ) ) === text ) ) return path;

		}

	} catch {

		// Nothing mounted: a built-in config has no files.

	}

	return '';

}

/** Each view transform's `from_scene_reference:` line with its value's lines, by name. */
function viewTransformSources( lines ) {

	const found = new Map();
	for ( let i = 0; i < lines.length; i ++ ) {

		if ( ! /^\s*-\s*!<ViewTransform>\s*$/.test( lines[ i ] ) ) continue;
		const item = indentOf( lines[ i ] );
		let end = i + 1;
		while ( end < lines.length && ! ( lines[ end ].trim() && indentOf( lines[ end ] ) <= item ) ) end ++;
		const body = lines.slice( i + 1, end );
		const name = body.map( l => l.match( /^\s*name:\s*(.+?)\s*$/ )?.[ 1 ] ).find( Boolean )?.replace( /^(["'])(.*)\1$/, '$2' );
		const at = body.findIndex( l => /^\s*from_scene_reference:/.test( l ) );
		if ( ! name || at < 0 ) continue;
		const key = indentOf( body[ at ] );
		let stop = at + 1;
		while ( stop < body.length && ! ( body[ stop ].trim() && indentOf( body[ stop ] ) <= key ) ) stop ++;
		found.set( name, body.slice( at, stop ).filter( l => l.trim() ) );

	}

	return found;

}

/** A group whose children are one flow line each, split before its last forward .spi1d; null when there is none. */
function lookupSplit( value ) {

	if ( ! /:\s*!<GroupTransform>\s*$/.test( value[ 0 ] ) ) return null;
	const children = value.slice( 1 ).filter( l => ! /^\s*children:\s*$/.test( l ) );
	if ( ! children.every( l => /^\s*-\s*!<\w+>\s*\{.*\}\s*$/.test( l ) ) ) return null;
	const steps = children.map( l => l.replace( /^\s*-\s*/, '' ).trim() );
	const at = steps.findLastIndex( s => /^!<FileTransform>/.test( s ) && /\.spi1d\b/i.test( s ) && ! /direction:\s*inverse/.test( s ) );
	if ( at <= 0 ) return null;
	return { pre: steps.slice( 0, at ), post: steps.slice( at ), src: steps[ at ].match( /\bsrc:\s*["']?([^,}"']+?)["']?\s*[,}]/ )?.[ 1 ] };

}

/** A .spi1d's domain and length, read where the config's search path finds it. */
function spi1dShape( FS, root, text, src ) {

	const dirs = ( text.match( /^search_path:\s*(.+?)\s*$/m )?.[ 1 ].replace( /^["']|["']$/g, '' ).split( ':' ) ?? [ '' ] ).concat( '' );
	for ( const dir of dirs ) {

		try {

			const head = new TextDecoder().decode( FS.readFile( [ root, dir, src ].filter( Boolean ).join( '/' ) ).subarray( 0, 512 ) );
			const range = head.match( /^From\s+(\S+)\s+(\S+)/m );
			const n = Number( head.match( /^Length\s+(\d+)/m )?.[ 1 ] );
			if ( n > 1 ) return { lo: range ? Number( range[ 1 ] ) : 0, hi: range ? Number( range[ 2 ] ) : 1, n };

		} catch {

			// Not in this directory.

		}

	}

	return null;

}

/** What the derived config holds for each view transform, read from the text alone (cheap), once a config. */
function derivedPlan() {

	const text = getConfigText();
	if ( derived?.text === text ) return derived;
	releaseDerivedConfig();
	if ( ! text ) return null;
	const lines = text.split( '\n' );
	derived = { text, lines, config: null, built: false, views: new Map() };
	let k = 0;
	for ( const [ name, value ] of viewTransformSources( lines ) ) {

		derived.views.set( name, { space: `__rayzee_view_${k}`, value, split: lookupSplit( value ), index: k } );
		k ++;

	}

	return derived;

}

/** The plan as an OCIO config: built on first need, its splits checked (a .spi1d found, a grey value before it). */
function buildDerived( plan ) {

	if ( plan.built ) return plan.config;
	plan.built = true;
	const rt = getRuntime();
	const { lines } = plan;
	const listAt = lines.findIndex( l => /^colorspaces:\s*$/.test( l ) );
	if ( ! rt?.ocio || listAt < 0 || ! plan.views.size ) return null;

	try {

		const pad = ' '.repeat( Math.max( 0, indentOf( lines.slice( listAt + 1 ).find( l => /^\s*-/.test( l ) ) ?? '  -' ) ) );
		const root = mountedRoot( rt, plan.text ), FS = rt.ocio.module?.FS;
		const spaces = [], named = [];
		for ( const entry of plan.views.values() ) {

			const { value, index } = entry;
			const shift = pad.length + 2 - indentOf( value[ 0 ] );
			const move = l => ( shift >= 0 ? ' '.repeat( shift ) + l : l.slice( - shift ) );
			spaces.push( `${pad}- !<ColorSpace>`, `${pad}  name: ${entry.space}`, `${pad}  isdata: false`, ...value.map( move ) );
			const shape = entry.split?.src && FS ? spi1dShape( FS, root, plan.text, entry.split.src ) : null;
			if ( ! shape ) {

				entry.split = null;
				continue;

			}

			const { pre, post } = entry.split;
			entry.split = { pre: `__rayzee_pre_${index}`, post: `__rayzee_post_${index}`, ...shape };
			spaces.push( `${pad}- !<ColorSpace>`, `${pad}  name: ${entry.split.pre}`, `${pad}  isdata: false`,
				`${pad}  from_scene_reference: !<GroupTransform>`, `${pad}    children:`, ...pre.map( s => `${pad}      - ${s}` ) );
			named.push( '  - !<NamedTransform>', `    name: ${entry.split.post}`, '    transform: !<GroupTransform>',
				'      children:', ...post.map( s => `        - ${s}` ) );

		}

		const out = lines.slice();
		out.splice( listAt + 1, 0, ...spaces );
		const namedAt = out.findIndex( l => /^named_transforms:\s*$/.test( l ) );
		if ( named.length ) out.splice( namedAt < 0 ? out.length : namedAt + 1, 0, ...( namedAt < 0 ? [ 'named_transforms:' ] : [] ), ...named );
		plan.config = rt.ocio.createConfigFromString( out.join( '\n' ), { workingDir: root } );
		plan.config.validate();

		// A split holds only where the part before the lookup is grey, so one value indexes it.
		const probe = new Float32Array( [ 1, 0.2, 0.05, 1, 0.02, 0.6, 0.1, 1, 0.3, 0.1, 2, 1, 0.18, 0.18, 0.18, 1 ] );
		for ( const entry of plan.views.values() ) {

			if ( ! entry.split ) continue;
			const p = plan.config.createGroupTransformProcessor( [ { type: 'colorSpace', source: describeConfig().sceneLinear, destination: entry.split.pre } ] );
			const grey = p.applyRGBAF32( probe, { copy: true } );
			p.dispose();
			for ( let i = 0; i < grey.length; i += 4 ) if ( Math.abs( grey[ i ] - grey[ i + 1 ] ) + Math.abs( grey[ i + 1 ] - grey[ i + 2 ] ) > 1e-5 ) entry.split = null;

		}

	} catch ( error ) {

		plan.config?.dispose();
		plan.config = null;
		issueLog?.warn( ISSUE_CODES.VIEW_TRANSFORM_BAKE_FAILED, `views bake from OCIO's display output instead: ${error.message}` );

	}

	return plan.config;

}

/** Free the derived config; the next bake that needs one builds it again. */
export function releaseDerivedConfig() {

	derived?.config?.dispose();
	derived = null;

}

/**
 * The derived config's entry for a view's transform when the bake can use it: its light for a converted display, or
 * its split. Null for a view of a colour space or with looks of its own.
 */
function derivedView( display, view, canvas ) {

	const v = getConfigInfo()?.viewsByDisplay[ display ]?.find( x => x.name === view );
	if ( ! v?.transform || v.looks ) return null;
	const plan = derivedPlan();
	const entry = plan?.views.get( v.transform );
	if ( ! entry || ( ! canvas && ! entry.split ) ) return null;
	const config = buildDerived( plan );
	if ( ! config || ( ! canvas && ! entry.split ) ) return null;
	return { config, space: entry.space, split: entry.split };

}

/**
 * The bake's saturated colours as a render holds them: Rec.709's, in the space rendered in. A wider space's own primaries
 * sit on edges no table follows (ACES 2.0 from ACEScg: 24 levels at 65, 25 at 97), which hid what 97 does for Rec.709's
 * (6.6 → 4.2).
 */
function edgeColoursIn( source, options ) {

	const colours = edgeColours();
	const native = findNativeLinearSpace( getConfigInfo() );
	if ( ! native || native === source ) return colours;
	const p = getRuntime().config.createGroupTransformProcessor( [ { type: 'colorSpace', source: native, destination: source } ], options );
	const px = new Float32Array( colours.flatMap( c => [ ...c, 1 ] ) );
	p.applyRGBAF32( px );
	p.dispose();
	return colours.map( ( _, i ) => [ px[ i * 4 ], px[ i * 4 + 1 ], px[ i * 4 + 2 ] ] );

}

/**
 * One view (and look) sampled into a half-float table: as OCIO outputs it, or, with `canvas`, as the light the display
 * emits in that canvas colour space, encoded in the bake or after the lookup (`linear`), whichever is closer. With a
 * `curve` (a split view) the cube holds the grey value before the view's lookup, and the entries after it the colour.
 * Its axes are the source space's, or linear Rec.709's behind a `pre` matrix; its size 65, or 97 — as measured, unless
 * `size` is given.
 */
function bakeView( { source, display, view, look, context, canvas = null, size = null, minEv, maxEv } ) {

	const output = viewOutputSpace( getConfigInfo(), display, view );
	const options = context ? { context } : undefined;
	const own = derivedView( display, view, canvas );
	// A converted display's table holds the light in the canvas's primaries, encoded either in the bake or after it.
	const toCanvas = buffer => canvas && lightForCanvas( buffer, canvas );
	const encodeAll = ( buffer, from = 0 ) => {

		for ( let i = from; i < buffer.length; i ++ ) if ( i % 4 !== 3 ) buffer[ i ] = encodeExtended( buffer[ i ] );

	};

	// The cube from `input`, the space its axes are in.
	const cubeFrom = input => {

		const looked = look ? [ { type: 'look', source: input, destination: input, looks: look } ] : [];
		if ( own?.split ) return own.config.createGroupTransformProcessor( [ ...looked, { type: 'colorSpace', source: input, destination: own.split.pre } ], options );
		// A converted display from its light, not its codes decoded: its encoding clips at 0 (Rec.1886's and Rec.2020's
		// ExponentTransform), which put a kink inside the cube wherever a colour left the display's gamut, and a pure
		// primary in a wider working space missed by up to 95 levels. The canvas clips the same light itself.
		if ( canvas && own ) return own.config.createGroupTransformProcessor( [ ...looked, { type: 'colorSpace', source: input, destination: own.space } ], options );
		return createViewProcessor( { source: input, display, view, look, context, decodeFrom: canvas ? output : null, decodeTo: canvas && displayReferenceSpace() } );

	};

	const cubes = new Map();
	const cubeOf = input => cubes.get( input ) ?? cubes.set( input, cubeFrom( input ) ).get( input );

	let entries = null, curve = null;
	if ( own?.split ) {

		const { post, lo, hi, n } = own.split;
		entries = own.config.createGroupTransformProcessor( [
			{ type: 'named', name: post },
			...( canvas ? [] : [ { type: 'colorSpace', source: displayReferenceSpace(), destination: output } ] ),
		], options );
		curve = { n, lo, hi };

	}

	// From the view's light, the display's clip comes after the lookup; measured against OCIO's whole chain, clip and all.
	const clip = canvas && own ? displayClip( output, canvas ) : null;
	const faithful = canvas && own ? createViewProcessor( { source, display, view, look, context, decodeFrom: output, decodeTo: displayReferenceSpace() } ) : null;
	const truth = buffer => {

		if ( faithful ) {

			faithful.applyRGBAF32( buffer );

		} else {

			cubeOf( source ).applyRGBAF32( buffer );
			if ( entries ) entries.applyRGBAF32( buffer );

		}

		toCanvas( buffer );
		if ( canvas ) encodeAll( buffer );

	};

	const edges = edgeColoursIn( source, options );
	// Only an HDR display's table is ever shown past 0..1; an SDR display's shows its HDR version on an HDR screen.
	const clamped = ! isHdrDisplay( describeConfig(), display );
	const native = findNativeLinearSpace( getConfigInfo() );
	const toNative = native && native !== source ? extractMatrix( source, native, { context } ) : null;

	// The JavaScript sampler reads the same half-precision values the GPU does, not the float
	// bake they came from — otherwise the readback and the viewport differ by the half rounding,
	// and "one table in four places" would only be nearly true. The error is measured on that
	// same table, so it reports what actually renders.
	const bakeAt = ( size, input ) => {

		const cube = cubeOf( input );
		const pre = input === source ? null : toNative;
		let values = bakeLut( { size, minEv, maxEv, apply: buffer => {

			cube.applyRGBAF32( buffer );
			if ( ! curve ) toCanvas( buffer );

		} } );

		if ( curve ) {

			const full = new Float32Array( ( size ** 3 + curveSlices( curve.n, size ) * size * size ) * 4 );
			full.set( values );
			full.set( bakeCurve( { ...curve, apply: buffer => {

				entries.applyRGBAF32( buffer );
				toCanvas( buffer );

			} } ), size ** 3 * 4 );
			values = full;

		}

		const table = ( data, linear ) => {

			const half = packHalf( data );
			const sampler = makeCpuSampler( { data: half, size, minEv, maxEv, curve, linear, clip, pre } );
			return { half, size, input, pre, curve, linear, clip, error: measureBakeError( { sampler, apply: truth, edges, clamped } ) };

		};

		if ( ! canvas ) return table( values, false );

		// Encoded values follow a tone curve better (mean 0.2 against 0.4 levels over 223 tables), but where a colour's
		// light crosses 0 inside a cell (a pure primary in a working space wider than the display) only light
		// interpolates straight through: Standard on Rec.2020 in Rec.2020, worst 97 levels encoded, 10 as light. Both come
		// from the same OCIO output, so light is kept where it at least halves the worst case.
		const light = table( values, true );
		const encoded = values.slice();
		encodeAll( encoded, curve ? size ** 3 * 4 : 0 );
		const coded = table( encoded, false );
		return light.error.max * 2 < coded.error.max ? light : coded;

	};

	// Kept where it measures closer and no worse on ordinary colours: a saturated colour mended at the mean's cost is no gain.
	const closer = ( a, b ) => ( tableScore( b.error ) < 0.8 * tableScore( a.error ) && b.error.mean <= a.error.mean * 1.1 + 0.02 ? b : a );

	try {

		// Where the table measures poorly, the same view on linear Rec.709's axes, then at 97, each kept if closer.
		// Rendering in a wider space, a view that works channel by channel in Rec.709 (Filmic, Khronos PBR Neutral, a plain
		// encoding) bends hardest where a Rec.709 channel crosses 0, which the source's axes put inside a cell: pure Rec.709
		// colours were up to 130 levels off in Filmic, 0.6 on Rec.709's axes; a view that keeps wider colours (ACES, AgX)
		// measures worse there and stays. Over 263 tables (Blender's and ACES 2.0's configs, every display, in each working
		// space they offer) 24 take Rec.709's axes and 68 grow: a saturated colour over 10 levels off on 47 → 6, the worst
		// mean 0.48 → 0.40. Every table at 97 would not do it: some read worse there. The bake costs 53 → 71 ms at the
		// median, 118 → 530 ms for the slowest tenth.
		let best = null;
		for ( const input of [ source, ...( toNative ? [ native ] : [] ) ] ) {

			const t = bakeAt( size ?? DEFAULT_LUT_SIZE, input );
			best = best ? closer( best, t ) : t;
			if ( tableScore( best.error ) <= 1 ) return best;

		}

		return size ? best : closer( best, bakeAt( FINE_LUT_SIZE, best.input ) );

	} finally {

		cubes.forEach( p => p.dispose() );
		entries?.dispose();
		faithful?.dispose();

	}

}

/** The TSL half of the table: the same shaper and the same six tetrahedra, as a node graph. */
function buildTslNode( { texture, size, minEv, maxEv, curve = null, linear = false, clip = null, pre = null } ) {

	// A linear table's light, encoded after the lookup with the canvas's extended curve. mix by step, not select: a TSL
	// select takes one condition, so a vector one followed its first channel (green on magenta came out 0.055).
	const encode = v => {

		const a = v.abs();
		return mix( a.pow( vec3( 1 / 2.4 ) ).mul( 1.055 ).sub( 0.055 ), a.mul( 12.92 ), step( a, vec3( 0.0031308 ) ) ).mul( sign( v ) );

	};

	const decode = v => {

		const a = v.abs();
		return mix( a.add( 0.055 ).div( 1.055 ).pow( vec3( 2.4 ) ), a.div( 12.92 ), step( a, vec3( 0.04045 ) ) ).mul( sign( v ) );

	};

	const times = ( m, v ) => vec3( dot( vec3( m[ 0 ], m[ 1 ], m[ 2 ] ), v ), dot( vec3( m[ 3 ], m[ 4 ], m[ 5 ] ), v ), dot( vec3( m[ 6 ], m[ 7 ], m[ 8 ] ), v ) );

	// After the lookup: a converted display's clip in its own primaries, then the encoding a linear table leaves out.
	const finish = v => {

		if ( clip ) return encode( times( clip.fromDisplay, max( times( clip.toDisplay, linear ? v : decode( v ) ), vec3( 0.0 ) ) ) );
		return linear ? encode( v ) : v;

	};

	const last = size - 1;
	const span = maxEv - minEv;

	const fetch = coord => texture3DLoad(
		texture,
		clamp( coord, ivec3( 0 ), ivec3( last ) )
	).rgb;

	return Fn( ( [ color, exposure ] ) => {

		const exposed = color.mul( exposure );
		const c = max( pre ? times( pre, exposed ) : exposed, vec3( 0.0 ) );

		const p = clamp(
			log2( max( c, vec3( 1e-10 ) ) ).sub( float( minEv ) ).div( float( span ) ),
			vec3( 0.0 ), vec3( 1.0 )
		).mul( float( last ) ).toVar();

		const i0 = clamp( ivec3( floor( p ) ), ivec3( 0 ), ivec3( size - 2 ) ).toVar();
		const f = clamp( p.sub( vec3( i0 ) ), vec3( 0.0 ), vec3( 1.0 ) ).toVar();

		// Declared before the branches: a sibling branch reading a var declared inside another
		// reads an unassigned value, which is silent and wrong rather than a compile error.
		const w = vec3( 0.0 ).toVar();
		const o1 = ivec3( 0 ).toVar();
		const o2 = ivec3( 0 ).toVar();
		const o3 = ivec3( 1 ).toVar();

		If( f.x.greaterThan( f.y ), () => {

			If( f.y.greaterThan( f.z ), () => {

				w.assign( vec3( f.x, f.y, f.z ) );
				o1.assign( ivec3( 1, 0, 0 ) ); o2.assign( ivec3( 1, 1, 0 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} ).ElseIf( f.x.greaterThan( f.z ), () => {

				w.assign( vec3( f.x, f.z, f.y ) );
				o1.assign( ivec3( 1, 0, 0 ) ); o2.assign( ivec3( 1, 0, 1 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} ).Else( () => {

				w.assign( vec3( f.z, f.x, f.y ) );
				o1.assign( ivec3( 0, 0, 1 ) ); o2.assign( ivec3( 1, 0, 1 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} );

		} ).Else( () => {

			If( f.z.greaterThan( f.y ), () => {

				w.assign( vec3( f.z, f.y, f.x ) );
				o1.assign( ivec3( 0, 0, 1 ) ); o2.assign( ivec3( 0, 1, 1 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} ).ElseIf( f.z.greaterThan( f.x ), () => {

				w.assign( vec3( f.y, f.z, f.x ) );
				o1.assign( ivec3( 0, 1, 0 ) ); o2.assign( ivec3( 0, 1, 1 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} ).Else( () => {

				w.assign( vec3( f.y, f.x, f.z ) );
				o1.assign( ivec3( 0, 1, 0 ) ); o2.assign( ivec3( 1, 1, 0 ) ); o3.assign( ivec3( 1, 1, 1 ) );

			} );

		} );

		const c000 = fetch( i0 ).toVar();
		const v1 = fetch( i0.add( o1 ) ).toVar();
		const v2 = fetch( i0.add( o2 ) ).toVar();
		const v3 = fetch( i0.add( o3 ) ).toVar();

		const out = c000
			.add( v1.sub( c000 ).mul( w.x ) )
			.add( v2.sub( v1 ).mul( w.y ) )
			.add( v3.sub( v2 ).mul( w.z ) );
		if ( ! curve ) return finish( out );

		// The curve: entry i is texel size³ + i, in the slices after the cube.
		const u = clamp( out.x.sub( curve.lo ).div( curve.hi - curve.lo ), 0.0, 1.0 ).mul( curve.n - 1 ).toVar();
		const k = min( int( floor( u ) ), int( curve.n - 2 ) ).toVar();
		const entry = i => texture3DLoad( texture, ivec3( i.mod( size ), i.div( size ).mod( size ), i.div( size * size ).add( size ) ) ).rgb;
		const shown = mix( entry( k ), entry( k.add( 1 ) ), u.sub( float( k ) ) );
		return finish( shown );

	} );

}

/**
 * Bake one view into a registry entry, without registering it.
 *
 * @param {Object} options
 * @param {string} options.display
 * @param {string} options.view
 * @param {string} [options.look] - a look name from the config
 * @param {Object} [options.context] - context variables, e.g. `{ SHOT: '010' }`
 * @param {string} [options.source] - the space being rendered in; defaults to the scene_linear role
 * @param {number} [options.size] - the table's edge; left out, 65, or 97 where 65 measures poorly
 * @returns {Object} a registry entry, with `error` holding what the table cost
 */
export function buildOcioView( {
	display, view, look = null, context = null, source = null,
	size = null, minEv = DEFAULT_MIN_EV, maxEv = DEFAULT_MAX_EV,
	id = null, name = null,
} = {} ) {

	const info = getConfigInfo();
	if ( ! info ) throw new Error( 'load an OCIO config first' );

	const sceneLinear = info.roles.find( r => r.name === 'scene_linear' )?.colorSpace;
	const from = source ?? sceneLinear;
	if ( ! from ) throw new Error( 'config has no scene_linear role — pass an explicit source space' );

	if ( ! info.displays.includes( display ) ) {

		throw new Error( `config has no display "${display}" — has ${info.displays.join( ', ' )}` );

	}

	const views = ( info.viewsByDisplay[ display ] ?? [] ).map( v => v.name );
	if ( ! views.includes( view ) ) {

		throw new Error( `display "${display}" has no view "${view}" — has ${views.join( ', ' )}` );

	}

	if ( look && ! info.looks.some( l => l.name === look ) ) {

		throw new Error( `config has no look "${look}" — has ${info.looks.map( l => l.name ).join( ', ' )}` );

	}

	// A display the canvas cannot hold as it is — Rec.1886's 2.4 gamma, Rec.2020, cinema P3, PQ, HLG — is baked already
	// converted for the canvas, so the screen, readbacks and saved pictures show what that display would.
	const { fit, wide, convertible } = canvasFitOf( viewOutputSpace( info, display, view ) );
	const emulated = ! fit && convertible;
	const canvas = fit ?? ( emulated && wide ? 'display-p3' : 'srgb' );
	if ( ! fit && ! displayReferenceSpace() && ! isDataView( describeConfig(), display, view ) ) {

		issueLog?.warn(
			ISSUE_CODES.VIEW_TRANSFORM_DISPLAY_MISMATCH,
			`"${display}" is no canvas colour space and the config cannot convert it, so the screen shows its codes as sRGB`,
			{ display, view }
		);

	}

	const baked = bakeView( { source: from, display, view, look, context, canvas: emulated ? canvas : null, size, minEv, maxEv } );
	const { half, error, curve, linear, clip, pre } = baked;

	return tableEntry( {
		id, half, error,
		name: name ?? ( look ? `${view} + ${look} (${display})` : `${view} (${display})` ),
		ocio: { display, view, look, context, source: from, configId: info.id, size: baked.size, requestedSize: size, minEv, maxEv, canvas, emulated, curve, linear, clip, pre },
	} );

}

/**
 * A registry entry for a view baked earlier and saved (`BakedViews.js`), without the runtime.
 * @param {Object} baked - from `decodeBakedView`
 */
export function buildBakedView( baked, id = null ) {

	const { name, data, error, configId, display, view, look, context, source, size, minEv, maxEv, fingerprint, ocioVersion, canvas, emulated, curve, linear, clip, pre } = baked;

	return tableEntry( {
		id, name, error, half: data,
		ocio: {
			display, view, look: look ?? null, context: context ?? null, source, configId, size, minEv, maxEv,
			canvas: canvas ?? displayCanvasFit( display ) ?? 'srgb', emulated: !! emulated, curve: curve ?? null, linear: !! linear, clip: clip ?? null, pre: pre ?? null,
			baked: { fingerprint: fingerprint ?? null, ocioVersion: ocioVersion ?? null },
		},
	} );

}

function tableTexture( half, size, curve = null ) {

	const texture = new Data3DTexture( half, size, size, size + ( curve ? curveSlices( curve.n, size ) : 0 ) );
	texture.format = RGBAFormat;
	texture.type = HalfFloatType;
	texture.minFilter = NearestFilter;
	texture.magFilter = NearestFilter;
	texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
	texture.needsUpdate = true;
	return texture;

}

function tableEntry( { id, name, half, error, ocio } ) {

	const { size, minEv, maxEv, curve = null, linear = false, clip = null, pre = null } = ocio;
	const sampler = makeCpuSampler( { data: half, size, minEv, maxEv, curve, linear, clip, pre } );
	const entryId = id ?? nextOcioId();
	const wgslConst = `TM_OCIO_${entryId}`;
	const fnName = `tm_ocio_${entryId}`;

	const held = liveViews.get( entryId );
	const reusable = held && held.size === size && held.minEv === minEv && held.maxEv === maxEv && JSON.stringify( [ held.curve, held.linear, held.clip, held.pre ] ) === JSON.stringify( [ curve, linear, clip, pre ] );

	let texture, tsl;
	if ( reusable ) {

		texture = held.texture;
		texture.image.data = half;
		texture.needsUpdate = true;
		tsl = held.tsl;

	} else {

		held?.texture.dispose();
		texture = tableTexture( half, size, curve );
		tsl = buildTslNode( { texture, size, minEv, maxEv, curve, linear, clip, pre } );

	}

	liveViews.set( entryId, { texture, tsl, size, minEv, maxEv, curve, linear, clip, pre } );

	return {
		id: entryId,
		name,
		wgslConst,
		source: 'ocio',
		outputEncoded: true,
		appliesExposure: true,

		cpu: ( r, g, b, exposure, out ) => sampler( r * exposure, g * exposure, b * exposure, out ),

		wgsl: lutWgsl( { fnName, texName: `${wgslConst.toLowerCase()}_tex`, size, minEv, maxEv, curve, linear, clip, pre } ),
		call: `${fnName}( c )`,
		tsl,

		table: { data: half, size, texture },
		error,
		ocio,
	};

}

/** CIE XYZ (D65) → linear RGB of each canvas colour space, as CSS Color 4 defines them. */
export const XYZ_TO_CANVAS = Object.freeze( {
	'srgb': [
		3.2409699419045226, - 1.537383177570094, - 0.4986107602930034,
		- 0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
		0.05563007969699366, - 0.20397695888897652, 1.0569715142428786,
	],
	'display-p3': [
		446124 / 178915, - 333277 / 357830, - 72051 / 178915,
		- 14852 / 17905, 63121 / 35810, 423 / 17905,
		11844 / 330415, - 50337 / 660830, 316169 / 330415,
	],
} );

/**
 * The config's display connection space: CIE XYZ (D65), where every display is linear and 1.0 is 100 nits. Configs
 * usually list it inactive, so the runtime's list leaves it out and the YAML is read instead.
 * @returns {?string}
 */
export function displayReferenceSpace() {

	const listed = getConfigInfo()?.colorSpaces.find( c => c.encoding === 'display-linear' )?.name;
	const section = getConfigText()?.split( /^display_colorspaces:[^\n]*$/m )[ 1 ]?.split( /^\S/m )[ 0 ] ?? '';
	const entries = section.split( /-\s*!<ColorSpace>/ ).slice( 1 );
	const entry = entries.find( e => /^\s*encoding:\s*display-linear\s*$/m.test( e ) ) ?? entries.find( e => ! /_display_reference:/.test( e ) );
	const name = listed ?? entry?.match( /^\s*name:\s*(.+?)\s*$/m )?.[ 1 ].replace( /^["']|["']$/g, '' ) ?? null;
	return name && /xyz/i.test( name ) ? name : null;

}

/**
 * A view as the canvas shows it: OCIO's display output decoded to the display connection space (1.0 = 100 nits) and
 * encoded for the canvas, extended past 1. Not a registry entry, so no readback uses it.
 *
 * @param {Object} options - the `display` and `view` to show; `look`, `context`, `source` and `for` (`{ display, view }`)
 *   of the view it stands in for
 * @param {'srgb'|'display-p3'} [options.canvas='srgb']
 * @returns {Object} `{ name, tsl, table, error, ocio, dispose() }`
 */
export function buildCanvasView( {
	display, view, look = null, context = null, source = null, canvas = 'srgb', for: shownFor = null,
	size = null, minEv = DEFAULT_MIN_EV, maxEv = DEFAULT_MAX_EV,
} = {} ) {

	const info = getConfigInfo();
	if ( ! info ) throw new Error( 'load an OCIO config first' );
	const from = source ?? info.roles.find( r => r.name === 'scene_linear' )?.colorSpace;
	if ( ! displayReferenceSpace() ) throw new Error( 'the config names no display-referred CIE XYZ space to decode its displays in' );
	if ( ! XYZ_TO_CANVAS[ canvas ] ) throw new Error( `no encoding for a "${canvas}" canvas` );

	const baked = bakeView( { source: from, display, view, look, context, canvas, size, minEv, maxEv } );
	const { half, error, curve, linear, clip, pre } = baked;

	return canvasTable( {
		name: look ? `${view} + ${look} (${display})` : `${view} (${display})`, half, error,
		ocio: { display, view, look, context, source: from, configId: info.id, size: baked.size, requestedSize: size, minEv, maxEv, canvas, for: shownFor, curve, linear, clip, pre },
	} );

}

/** {@link buildCanvasView}'s result from a saved file (`BakedViews.js`), without the runtime. */
export function buildBakedCanvasView( baked ) {

	const { name, data, error, configId, display, view, look, context, source, size, minEv, maxEv, canvas, for: shownFor, linear, clip, pre } = baked;
	return canvasTable( {
		name, half: data, error,
		ocio: { display, view, look: look ?? null, context: context ?? null, source, configId, size, minEv, maxEv, canvas: canvas ?? 'srgb', for: shownFor ?? null, linear: !! linear, clip: clip ?? null, pre: pre ?? null },
	} );

}

function canvasTable( { name, half, error, ocio } ) {

	const { size, minEv, maxEv, curve = null, linear = false, clip = null, pre = null } = ocio;
	const texture = tableTexture( half, size, curve );
	return {
		name, source: 'ocio', error, ocio,
		table: { data: half, size, texture },
		tsl: buildTslNode( { texture, size, minEv, maxEv, curve, linear, clip, pre } ),
		dispose: () => texture.dispose(),
	};

}

/** Bake a view and put it in the registry. */
export function addOcioView( options ) {

	return addViewTransform( buildOcioView( options ) );

}

/**
 * Bake every view of one display — what a host wants after loading a config, so the menu is
 * populated without the user naming anything.
 *
 * Views that are pure data (`Raw`) are skipped: colour-managing a data view is meaningless, and
 * the config marks them.
 *
 * @returns {{ added: Object[], skipped: Array<{ view: string, reason: string }> }}
 */
export function addAllOcioViews( { display = null, look = null, context = null, source = null, size = null } = {} ) {

	const info = getConfigInfo();
	if ( ! info ) throw new Error( 'load an OCIO config first' );

	const target = display ?? info.defaultDisplay;
	const views = info.viewsByDisplay[ target ] ?? [];

	const added = [];
	const skipped = [];

	for ( const v of views ) {

		if ( v.colorSpace && v.colorSpace !== '<USE_DISPLAY_NAME>' ) {

			const cs = info.colorSpaces.find( c => c.name === v.colorSpace );
			if ( cs?.isData ) {

				skipped.push( { view: v.name, reason: 'data view' } );
				continue;

			}

		}

		try {

			added.push( addOcioView( { display: target, view: v.name, look, context, source, size } ) );

		} catch ( err ) {

			skipped.push( { view: v.name, reason: err.message } );
			issueLog?.warn( ISSUE_CODES.VIEW_TRANSFORM_BAKE_FAILED, `could not bake "${v.name}" (${target}): ${err.message}`, { display: target, view: v.name } );

		}

	}

	return { added, skipped };

}

/**
 * Forget one view's texture and node, and free the texture.
 *
 * Ids are reused — `nextOcioId()` hands out the lowest free one — so a view removed without this
 * would leave its disposed texture waiting to be "reused" by whatever is baked into that id next.
 */
export function forgetOcioView( id ) {

	const held = liveViews.get( id );
	if ( ! held ) return;
	held.texture.dispose();
	liveViews.delete( id );

}

/** Free the GPU texture behind every OCIO entry currently registered, except the ids in `keep`. */
export function disposeOcioViewTextures( keep = null ) {

	for ( const t of VIEW_TRANSFORMS.values() ) {

		if ( t.source === 'ocio' && ! keep?.has( t.id ) ) t.table?.texture?.dispose?.();

	}

	for ( const [ id, held ] of liveViews ) {

		if ( keep?.has( id ) ) continue;
		held.texture.dispose();
		liveViews.delete( id );

	}

}
