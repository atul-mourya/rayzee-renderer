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
	Fn, vec3, ivec3, float, floor, clamp, log2, max, If, texture3DLoad,
} from 'three/tsl';

import { ISSUE_CODES } from '../EngineIssues.js';
import { displayCanvasFit, isDataView } from './Displays.js';
import { getRuntime, getConfigInfo, getConfigText, describeConfig } from './OcioRuntime.js';
import { bakeLut, makeCpuSampler, packHalf, lutWgsl, measureBakeError } from './LutBake.js';
import { addViewTransform, nextOcioId, VIEW_TRANSFORMS } from './ViewTransforms.js';

/** 25 stops, which is wider than any renderer output worth showing. */
export const DEFAULT_MIN_EV = - 12.47393;
export const DEFAULT_MAX_EV = 12.5260688117;

/** 65³ measures a mean of 0.11 code values against OCIO itself, for 2.1 MB. */
export const DEFAULT_LUT_SIZE = 65;


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

/** Display-linear CIE XYZ → the canvas colour space's extended encoding, in place. */
function encodeForCanvas( buffer, canvas ) {

	const m = XYZ_TO_CANVAS[ canvas ];
	for ( let i = 0; i < buffer.length; i += 4 ) {

		const x = buffer[ i ], y = buffer[ i + 1 ], z = buffer[ i + 2 ];
		buffer[ i ] = encodeExtended( m[ 0 ] * x + m[ 1 ] * y + m[ 2 ] * z );
		buffer[ i + 1 ] = encodeExtended( m[ 3 ] * x + m[ 4 ] * y + m[ 5 ] * z );
		buffer[ i + 2 ] = encodeExtended( m[ 6 ] * x + m[ 7 ] * y + m[ 8 ] * z );

	}

}

/**
 * One view (and look) sampled into a half-float table: as OCIO outputs it, or, with `canvas`, decoded to the display
 * connection space and encoded for that canvas colour space.
 */
function bakeView( { source, display, view, look, context, canvas = null, size, minEv, maxEv } ) {

	const output = canvas ? viewOutputSpace( getConfigInfo(), display, view ) : null;
	const processor = createViewProcessor( { source, display, view, look, context, decodeFrom: output, decodeTo: canvas && displayReferenceSpace() } );
	const apply = buffer => {

		processor.applyRGBAF32( buffer );
		if ( canvas ) encodeForCanvas( buffer, canvas );

	};

	// The JavaScript sampler reads the same half-precision values the GPU does, not the float
	// bake they came from — otherwise the readback and the viewport differ by the half rounding,
	// and "one table in four places" would only be nearly true. The error is measured on that
	// same table, so it reports what actually renders.
	try {

		const half = packHalf( bakeLut( { size, minEv, maxEv, apply } ) );
		return { half, error: measureBakeError( { sampler: makeCpuSampler( { data: half, size, minEv, maxEv } ), apply } ) };

	} finally {

		processor.dispose();

	}

}

/** The TSL half of the table: the same shaper and the same six tetrahedra, as a node graph. */
function buildTslNode( { texture, size, minEv, maxEv } ) {

	const last = size - 1;
	const span = maxEv - minEv;

	const fetch = coord => texture3DLoad(
		texture,
		clamp( coord, ivec3( 0 ), ivec3( last ) )
	).rgb;

	return Fn( ( [ color, exposure ] ) => {

		const c = max( color.mul( exposure ), vec3( 0.0 ) );

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

		return c000
			.add( v1.sub( c000 ).mul( w.x ) )
			.add( v2.sub( v1 ).mul( w.y ) )
			.add( v3.sub( v2 ).mul( w.z ) );

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
 * @param {number} [options.size=65]
 * @returns {Object} a registry entry, with `error` holding what the table cost
 */
export function buildOcioView( {
	display, view, look = null, context = null, source = null,
	size = DEFAULT_LUT_SIZE, minEv = DEFAULT_MIN_EV, maxEv = DEFAULT_MAX_EV,
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

	const { half, error } = bakeView( { source: from, display, view, look, context, canvas: emulated ? canvas : null, size, minEv, maxEv } );

	return tableEntry( {
		id, half, error,
		name: name ?? ( look ? `${view} + ${look} (${display})` : `${view} (${display})` ),
		ocio: { display, view, look, context, source: from, configId: info.id, size, minEv, maxEv, canvas, emulated },
	} );

}

/**
 * A registry entry for a view baked earlier and saved (`BakedViews.js`), without the runtime.
 * @param {Object} baked - from `decodeBakedView`
 */
export function buildBakedView( baked, id = null ) {

	const { name, data, error, configId, display, view, look, context, source, size, minEv, maxEv, fingerprint, ocioVersion, canvas, emulated } = baked;

	return tableEntry( {
		id, name, error, half: data,
		ocio: {
			display, view, look: look ?? null, context: context ?? null, source, configId, size, minEv, maxEv,
			canvas: canvas ?? displayCanvasFit( display ) ?? 'srgb', emulated: !! emulated,
			baked: { fingerprint: fingerprint ?? null, ocioVersion: ocioVersion ?? null },
		},
	} );

}

function tableTexture( half, size ) {

	const texture = new Data3DTexture( half, size, size, size );
	texture.format = RGBAFormat;
	texture.type = HalfFloatType;
	texture.minFilter = NearestFilter;
	texture.magFilter = NearestFilter;
	texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
	texture.needsUpdate = true;
	return texture;

}

function tableEntry( { id, name, half, error, ocio } ) {

	const { size, minEv, maxEv } = ocio;
	const sampler = makeCpuSampler( { data: half, size, minEv, maxEv } );
	const entryId = id ?? nextOcioId();
	const wgslConst = `TM_OCIO_${entryId}`;
	const fnName = `tm_ocio_${entryId}`;

	const held = liveViews.get( entryId );
	const reusable = held && held.size === size && held.minEv === minEv && held.maxEv === maxEv;

	let texture, tsl;
	if ( reusable ) {

		texture = held.texture;
		texture.image.data = half;
		texture.needsUpdate = true;
		tsl = held.tsl;

	} else {

		held?.texture.dispose();
		texture = tableTexture( half, size );
		tsl = buildTslNode( { texture, size, minEv, maxEv } );

	}

	liveViews.set( entryId, { texture, tsl, size, minEv, maxEv } );

	return {
		id: entryId,
		name,
		wgslConst,
		source: 'ocio',
		outputEncoded: true,
		appliesExposure: true,

		cpu: ( r, g, b, exposure, out ) => sampler( r * exposure, g * exposure, b * exposure, out ),

		wgsl: lutWgsl( { fnName, texName: `${wgslConst.toLowerCase()}_tex`, size, minEv, maxEv } ),
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

/** The canvas colour spaces' curve, extended past 1 and mirrored below 0 as CSS Color 4 extends it. */
export function encodeExtended( v ) {

	const a = Math.abs( v );
	const e = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow( a, 1 / 2.4 ) - 0.055;
	return v < 0 ? - e : e;

}

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
	size = DEFAULT_LUT_SIZE, minEv = DEFAULT_MIN_EV, maxEv = DEFAULT_MAX_EV,
} = {} ) {

	const info = getConfigInfo();
	if ( ! info ) throw new Error( 'load an OCIO config first' );
	const from = source ?? info.roles.find( r => r.name === 'scene_linear' )?.colorSpace;
	if ( ! displayReferenceSpace() ) throw new Error( 'the config names no display-referred CIE XYZ space to decode its displays in' );
	if ( ! XYZ_TO_CANVAS[ canvas ] ) throw new Error( `no encoding for a "${canvas}" canvas` );

	const { half, error } = bakeView( { source: from, display, view, look, context, canvas, size, minEv, maxEv } );

	return canvasTable( {
		name: look ? `${view} + ${look} (${display})` : `${view} (${display})`, half, error,
		ocio: { display, view, look, context, source: from, configId: info.id, size, minEv, maxEv, canvas, for: shownFor },
	} );

}

/** {@link buildCanvasView}'s result from a saved file (`BakedViews.js`), without the runtime. */
export function buildBakedCanvasView( baked ) {

	const { name, data, error, configId, display, view, look, context, source, size, minEv, maxEv, canvas, for: shownFor } = baked;
	return canvasTable( {
		name, half: data, error,
		ocio: { display, view, look: look ?? null, context: context ?? null, source, configId, size, minEv, maxEv, canvas: canvas ?? 'srgb', for: shownFor ?? null },
	} );

}

function canvasTable( { name, half, error, ocio } ) {

	const { size, minEv, maxEv } = ocio;
	const texture = tableTexture( half, size );
	return {
		name, source: 'ocio', error, ocio,
		table: { data: half, size, texture },
		tsl: buildTslNode( { texture, size, minEv, maxEv } ),
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
export function addAllOcioViews( { display = null, look = null, context = null, source = null, size = DEFAULT_LUT_SIZE } = {} ) {

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
