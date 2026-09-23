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
import { displayCanvasFit } from './Displays.js';
import { getRuntime, getConfigInfo } from './OcioRuntime.js';
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
function createViewProcessor( { source, display, view, look, context } ) {

	const config = configHandle();
	const options = context ? { context } : undefined;

	if ( ! look ) {

		return config.createDisplayViewProcessor( { source, display, view, ...( context ? { context } : {} ) } );

	}

	return config.createGroupTransformProcessor( [
		{ type: 'look', source, destination: source, looks: look },
		{ type: 'displayView', source, display, view },
	], options );

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

	if ( displayCanvasFit( display ) === null ) {

		issueLog?.warn(
			ISSUE_CODES.VIEW_TRANSFORM_DISPLAY_MISMATCH,
			`"${display}" is not an sRGB-class SDR display, which is all the canvas is configured for — ` +
			'its view will be shown clipped or in the wrong gamut on screen, though a saved buffer is right',
			{ display, view }
		);

	}

	const processor = createViewProcessor( { source: from, display, view, look, context } );
	const apply = buffer => processor.applyRGBAF32( buffer );

	// The JavaScript sampler reads the same half-precision values the GPU does, not the float
	// bake they came from — otherwise the readback and the viewport differ by the half rounding,
	// and "one table in four places" would only be nearly true. The error is measured on that
	// same table, so it reports what actually renders.
	let half, sampler, error;
	try {

		half = packHalf( bakeLut( { size, minEv, maxEv, apply } ) );
		sampler = makeCpuSampler( { data: half, size, minEv, maxEv } );
		error = measureBakeError( { sampler, apply } );

	} finally {

		processor.dispose();

	}

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

		texture = new Data3DTexture( half, size, size, size );
		texture.format = RGBAFormat;
		texture.type = HalfFloatType;
		texture.minFilter = NearestFilter;
		texture.magFilter = NearestFilter;
		texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
		texture.needsUpdate = true;

		tsl = buildTslNode( { texture, size, minEv, maxEv } );

	}

	liveViews.set( entryId, { texture, tsl, size, minEv, maxEv } );

	return {
		id: entryId,
		name: name ?? ( look ? `${view} + ${look} (${display})` : `${view} (${display})` ),
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

		ocio: {
			display, view, look, context,
			source: from,
			configId: info.id,
			size, minEv, maxEv,
		},
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

/** Free the GPU texture behind every OCIO entry currently registered. */
export function disposeOcioViewTextures() {

	for ( const t of VIEW_TRANSFORMS.values() ) {

		if ( t.source === 'ocio' ) t.table?.texture?.dispose?.();

	}

	for ( const held of liveViews.values() ) held.texture.dispose();
	liveViews.clear();

}
