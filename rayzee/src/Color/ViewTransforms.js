/**
 * The live list of view transforms, and the shader generated from it.
 *
 * A view transform has to exist in four places at once: the TSL graph that paints the canvas, the
 * WGSL compute pass that packs a frame for readback, the JavaScript that OIDN and the upscaler go
 * through, and the menu a host builds. Keeping four hand-written lists in step is how a saved
 * image ends up different from the viewport, so there is one list and the other three are derived
 * from it.
 *
 * Adding an OCIO view at runtime therefore reaches every consumer, including ones compiled before
 * the config was loaded — `getRegistryVersion()` moves and the shader is rebuilt.
 *
 * ## The two kinds of output
 *
 * A built-in curve returns **linear** colour; the renderer's output pass and the readback both
 * apply the sRGB transfer afterwards. An OCIO view returns colour already encoded for its display
 * — sRGB, Rec.1886, or PQ — and applying a transfer on top of that would encode it twice.
 * `outputEncoded` is what tells each consumer which it is holding.
 */

import { NoToneMapping } from 'three';
import { BUILTIN_VIEWS } from './BuiltinViews.js';

/** First id an OCIO-derived view gets. Clear of three.js's own constants and room to grow. */
export const OCIO_VIEW_BASE = 200;

/**
 * How many table-backed transforms may be registered at once.
 *
 * The readback binds every table in one shader and WebGPU only guarantees 16 sampled textures per
 * stage. Without a cap the failure is a shader that will not compile, at the moment someone bakes
 * one view too many — long after the mistake.
 */
export const MAX_TABLE_TRANSFORMS = 12;

const transforms = [ ...BUILTIN_VIEWS ];
const byId = new Map( transforms.map( t => [ t.id, t ] ) );

let version = 1;
const listeners = new Set();

function announce() {

	version ++;
	for ( const fn of listeners ) fn();

}

/** Every registered transform, keyed by id. Read-only in spirit — mutate through the functions. */
export const VIEW_TRANSFORMS = byId;

/** Bumped whenever the list changes, so a compiled shader knows it is stale. */
export function getRegistryVersion() {

	return version;

}

/** @returns {function(): void} unsubscribe */
export function onRegistryChange( listener ) {

	listeners.add( listener );
	return () => listeners.delete( listener );

}

export function getViewTransform( id ) {

	return byId.get( id ) ?? null;

}

/** What a host menu should show, in registration order. */
export function listViewTransforms() {

	return transforms.map( t => ( {
		id: t.id,
		name: t.name,
		source: t.source,
		display: t.ocio?.display ?? null,
		view: t.ocio?.view ?? null,
		look: t.ocio?.look ?? null,
	} ) );

}

/** How many registered transforms need a texture binding. */
export function countTableTransforms() {

	return transforms.filter( t => t.table ).length;

}

/** The lowest unused OCIO id. */
export function nextOcioId() {

	let id = OCIO_VIEW_BASE;
	while ( byId.has( id ) ) id ++;
	return id;

}

/**
 * Register a transform, replacing any with the same id.
 *
 * @param {Object} t - needs at least `id`, `name`, `wgslConst`, `cpu`
 */
export function addViewTransform( t ) {

	if ( typeof t?.id !== 'number' ) throw new Error( 'view transform needs a numeric id' );
	if ( typeof t.cpu !== 'function' ) throw new Error( `view transform ${t.id} needs a cpu function` );
	if ( ! t.name ) throw new Error( `view transform ${t.id} needs a name` );
	if ( ! /^TM_[A-Z0-9_]+$/.test( t.wgslConst ?? '' ) ) {

		throw new Error( `view transform ${t.id} needs a wgslConst like TM_SOMETHING` );

	}

	const existing = byId.get( t.id );
	if ( ! existing && t.table && countTableTransforms() >= MAX_TABLE_TRANSFORMS ) {

		throw new Error(
			`cannot register "${t.name}": ${MAX_TABLE_TRANSFORMS} table-backed view transforms already ` +
			'registered, and WebGPU only guarantees 16 sampled textures per stage. Remove one first.'
		);

	}

	const entry = { source: 'custom', outputEncoded: false, appliesExposure: true, ...t };

	if ( existing ) {

		transforms[ transforms.indexOf( existing ) ] = entry;

	} else {

		transforms.push( entry );

	}

	byId.set( entry.id, entry );
	announce();
	return entry;

}

/** @returns {boolean} whether anything was removed */
export function removeViewTransform( id ) {

	const existing = byId.get( id );
	if ( ! existing ) return false;

	transforms.splice( transforms.indexOf( existing ), 1 );
	byId.delete( id );
	announce();
	return true;

}

/** Drop every transform that came from a config, leaving the built-ins. */
export function removeOcioViewTransforms() {

	const doomed = transforms.filter( t => t.source === 'ocio' ).map( t => t.id );
	if ( doomed.length === 0 ) return 0;

	for ( const id of doomed ) {

		const t = byId.get( id );
		transforms.splice( transforms.indexOf( t ), 1 );
		byId.delete( id );

	}

	announce();
	return doomed.length;

}

/**
 * Hand every transform that has a TSL node to the renderer, so `renderer.toneMapping = id`
 * works on the live canvas. Built-ins are already there — three.js registers its own.
 */
export function registerWithRenderer( renderer ) {

	const library = renderer?.library;
	if ( ! library?.addToneMapping ) return 0;

	let count = 0;
	for ( const t of transforms ) {

		if ( ! t.tsl ) continue;

		// ⚠️ `addToneMapping` refuses to redefine an id — it warns and returns without replacing.
		// A rebaked view keeps its id, so without dropping the old entry first the canvas would go
		// on running the previous table while the readback used the new one. Two images, one
		// setting, no error.
		library.toneMappingNodes?.delete( t.id );
		library.addToneMapping( t.tsl, t.id );
		count ++;

	}

	return count;

}

/**
 * The WGSL for every registered transform, plus the bindings its tables need.
 *
 * @param {Object} [options]
 * @param {number} [options.group=0] - bind group the caller owns
 * @param {number} [options.firstBinding=3] - first binding index free in that group
 * @returns {{ wgsl: string, bindings: Array<{ index: number, transform: Object }> }}
 */
export function buildToneMapWGSL( { group = 0, firstBinding = 3 } = {} ) {

	const bindings = [];
	let next = firstBinding;

	const declarations = [];
	const bodies = [];

	for ( const t of transforms ) {

		if ( t.table ) {

			const texName = `${t.wgslConst.toLowerCase()}_tex`;
			declarations.push( `@group(${group}) @binding(${next}) var ${texName}: texture_3d<f32>;` );
			bindings.push( { index: next, transform: t, texName } );
			next += 1;

		}

		if ( t.wgsl ) bodies.push( t.wgsl );

	}

	const constants = transforms.map( t => `const ${t.wgslConst}: u32 = ${t.id}u;` ).join( '\n' );

	const branches = transforms
		.filter( t => t.call )
		.map( t => `\tif ( mode == ${t.wgslConst} ) { return ${t.call}; }` )
		.join( '\n' );

	// Generated rather than hardcoded: a transform that returns display-encoded colour must not
	// have the sRGB transfer applied on top of it.
	const encodedIds = transforms.filter( t => t.outputEncoded ).map( t => t.wgslConst );
	const encodedTest = encodedIds.length
		? encodedIds.map( c => `mode == ${c}` ).join( ' || ' )
		: 'false';

	const noExposureIds = transforms.filter( t => ! t.appliesExposure ).map( t => t.wgslConst );
	const noExposureTest = noExposureIds.length
		? noExposureIds.map( c => `mode == ${c}` ).join( ' || ' )
		: 'false';

	const wgsl = /* wgsl */ `
${constants}

${declarations.join( '\n' )}

${bodies.join( '\n' )}

// Three.js clamps the fragment output with max(0) before tone mapping, so the curves never see a
// negative channel. The saturation grade drives channels below zero on much of a typical frame,
// and AgX/Neutral mix negatives across channels instead of clipping them.
fn rayzee_tone_curve( color: vec3<f32>, mode: u32 ) -> vec3<f32> {
	let c = max( color, vec3<f32>( 0.0 ) );
${branches}
	return clamp( c, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}

/** True when the curve already returned display-encoded colour. */
fn rayzee_output_encoded( mode: u32 ) -> bool {
	return ${encodedTest};
}

fn rayzee_tone_map( linearRGB: vec3<f32>, mode: u32, exposure: f32, saturation: f32 ) -> vec3<f32> {
	// Three.js returns early for NoToneMapping without applying exposure, so a readback that
	// applied it would paint brighter than the viewport it replaces.
	var c = linearRGB * select( exposure, 1.0, ${noExposureTest} );
	if ( saturation != 1.0 ) {
		let luma = vec3<f32>( dot( c, vec3<f32>( 0.2126, 0.7152, 0.0722 ) ) );
		c = luma + ( c - luma ) * saturation;
	}
	return rayzee_tone_curve( c, mode );
}

fn rayzee_linear_to_srgb( c: vec3<f32> ) -> vec3<f32> {
	return select(
		1.055 * pow( max( c, vec3<f32>( 0.0 ) ), vec3<f32>( 1.0 / 2.4 ) ) - vec3<f32>( 0.055 ),
		12.92 * c,
		c <= vec3<f32>( 0.0031308 ) );
}

/** The transfer step, skipped for a curve that already encoded its own output. */
fn rayzee_encode( mapped: vec3<f32>, mode: u32 ) -> vec3<f32> {
	if ( rayzee_output_encoded( mode ) ) { return clamp( mapped, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) ); }
	return rayzee_linear_to_srgb( mapped );
}

fn rayzee_to_u8( srgb: vec3<f32> ) -> vec3<u32> {
	return vec3<u32>( clamp( round( srgb * 255.0 + vec3<f32>( 0.5 ) ), vec3<f32>( 0.0 ), vec3<f32>( 255.0 ) ) );
}
`;

	return { wgsl, bindings };

}

/** Put the registry back to the seven built-ins. Tests and config unload use this. */
export function resetViewTransforms() {

	transforms.length = 0;
	transforms.push( ...BUILTIN_VIEWS );
	byId.clear();
	for ( const t of transforms ) byId.set( t.id, t );
	announce();

}

/** The id to fall back to when a chosen one disappears. */
export const FALLBACK_VIEW = NoToneMapping;
