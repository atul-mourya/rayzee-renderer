/**
 * What colour space something arriving in the scene is already in.
 *
 * This is the half of colour management that is easy to skip and expensive to skip. A view
 * transform makes the render look right; getting the input wrong makes it *be* wrong — a texture
 * read as sRGB when it was authored in ACEScct is not a grading problem, it is a different image.
 *
 * Three answers, tried in order:
 *   1. an explicit override the host set for that file or texture
 *   2. the config's own file rules, which is the thing studios actually configure
 *   3. what three.js already believes, mapped onto the config's roles
 *
 * With no config loaded every answer is null and the engine behaves exactly as it always has.
 */

import { SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace } from 'three';
import { getRuntime, getConfigInfo } from './OcioRuntime.js';
import { hasColorSpace, isDataSpace } from './ColorSpaces.js';

/** Exact paths and regexes the host pinned, newest first. */
const overrides = [];

/** Bumped whenever an answer could change, so anything cached by input space knows it is stale. */
let inputVersion = 0;

export function getInputVersion() {

	return inputVersion;

}

/** Call when the config changes: its file rules are part of every answer. */
export function bumpInputVersion() {

	inputVersion ++;

}

/**
 * Pin a colour space for a file, overriding the config's rules.
 * @param {string|RegExp} match - an exact path, a substring, or a pattern
 */
export function setInputOverride( match, colorSpace ) {

	overrides.unshift( { match, colorSpace } );
	inputVersion ++;

}

export function clearInputOverrides() {

	if ( overrides.length === 0 ) return;
	overrides.length = 0;
	inputVersion ++;

}

export function listInputOverrides() {

	return overrides.map( o => ( { match: String( o.match ), colorSpace: o.colorSpace } ) );

}

function matchOverride( filePath ) {

	if ( ! filePath ) return null;

	for ( const o of overrides ) {

		if ( o.match instanceof RegExp ? o.match.test( filePath ) : filePath.includes( o.match ) ) {

			return o.colorSpace;

		}

	}

	return null;

}

/** The config's file rules, as a host can show them. Empty without a config. */
export function listFileRules() {

	return getConfigInfo()?.fileRules.map( r => ( {
		index: r.index, name: r.name, colorSpace: r.colorSpace,
		pattern: r.pattern, extension: r.extension, regex: r.regex,
	} ) ) ?? [];

}

/**
 * A config space matching what three.js thinks the texture is.
 *
 * Roles first, because a config names its own spaces however it likes but the roles are fixed
 * vocabulary. Only if the roles are absent does this fall back to matching names.
 */
function fromThreeColorSpace( threeColorSpace ) {

	const info = getConfigInfo();
	if ( ! info ) return null;

	const role = name => info.roles.find( r => r.name === name )?.colorSpace ?? null;

	if ( threeColorSpace === NoColorSpace ) return role( 'data' );

	if ( threeColorSpace === SRGBColorSpace ) {

		return role( 'texture_paint' ) ?? role( 'color_picking' )
			?? info.colorSpaces.find( c => /^srgb\b/i.test( c.name ) && ! /display/i.test( c.name ) )?.name
			?? null;

	}

	if ( threeColorSpace === LinearSRGBColorSpace ) {

		return info.colorSpaces.find( c => /^lin(ear)?[\s_-]*(rec\.?\s*)?709/i.test( c.name ) )?.name
			?? info.colorSpaces.find( c => /^linear.*srgb/i.test( c.name ) )?.name
			?? role( 'scene_linear' );

	}

	return null;

}

/**
 * Work out what a file is in.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {string} [options.threeColorSpace] - what three.js tagged it, used as the last resort
 * @returns {{ colorSpace: string, via: 'override'|'rule'|'three', rule: ?Object }|null}
 */
export function resolveInputSpace( filePath, { threeColorSpace = null } = {} ) {

	if ( ! getConfigInfo() ) return null;

	const pinned = matchOverride( filePath );
	if ( pinned ) return { colorSpace: pinned, via: 'override', rule: null };

	const rt = getRuntime();
	if ( rt && filePath ) {

		const match = rt.matchFileRule( filePath );

		// The default rule matches everything, so it is not evidence about this file. Prefer what
		// three.js knows over a rule that only fired because nothing else did.
		if ( match && ! match.isDefaultRule && hasColorSpace( match.colorSpace ) ) {

			return {
				colorSpace: match.colorSpace,
				via: 'rule',
				rule: { index: match.ruleIndex, name: match.ruleName },
			};

		}

	}

	const fromThree = fromThreeColorSpace( threeColorSpace );
	if ( fromThree ) return { colorSpace: fromThree, via: 'three', rule: null };

	const rt2 = getRuntime();
	if ( rt2 && filePath ) {

		const match = rt2.matchFileRule( filePath );
		if ( match && hasColorSpace( match.colorSpace ) ) {

			return {
				colorSpace: match.colorSpace,
				via: 'rule',
				rule: { index: match.ruleIndex, name: match.ruleName, isDefault: match.isDefaultRule },
			};

		}

	}

	return null;

}

/**
 * Whether this texture should be colour-managed at all.
 *
 * A normal map, a roughness map or a mask carries numbers, not colour; running it through a
 * primaries matrix corrupts it. three.js already flags these as `NoColorSpace`, and a config can
 * say the same through its `data` role or an `isData` space.
 */
export function isDataTexture( texture ) {

	if ( ! texture ) return false;
	if ( texture.colorSpace === NoColorSpace ) return true;

	const tagged = texture.userData?.ocioColorSpace;
	if ( tagged && isDataSpace( tagged ) ) return true;

	return false;

}

/** The path a texture came from, as well as it can be told. */
function texturePath( texture, filePath ) {

	return filePath ?? texture.userData?.sourcePath ?? ( texture.name || null ) ?? texture.image?.src ?? null;

}

/**
 * What colour space a texture is in, and how that was decided.
 *
 * `via` is what lets a caller treat the answers differently: `'tag'`, `'override'` and `'rule'`
 * are someone saying what the file is, while `'three'` only repeats what three.js already
 * assumed — the engine's own pipeline has handled that case all along, and running a full OCIO
 * transform over it is slower for the same result.
 *
 * @returns {?{ colorSpace: string, via: 'tag'|'override'|'rule'|'three', rule: ?Object }}
 */
export function resolveTextureSpace( texture, filePath = null ) {

	if ( ! getConfigInfo() || ! texture ) return null;

	const tagged = texture.userData?.ocioColorSpace;
	if ( tagged ) return hasColorSpace( tagged ) ? { colorSpace: tagged, via: 'tag', rule: null } : null;

	if ( isDataTexture( texture ) ) return null;

	return resolveInputSpace( texturePath( texture, filePath ), { threeColorSpace: texture.colorSpace } );

}

/**
 * The colour space a texture is in, honouring an explicit `userData.ocioColorSpace` tag before
 * anything is guessed.
 *
 * @returns {?string}
 */
export function textureInputSpace( texture, filePath = null ) {

	return resolveTextureSpace( texture, filePath )?.colorSpace ?? null;

}
