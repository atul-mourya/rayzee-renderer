/**
 * A renderer's own scene resources for its shaders: material texture buckets, the albedo maps alpha-cutout
 * shadow rays read, gobo and IES textures, and the alpha-shadow switch. They ride in the build context of each
 * kernel that reads them: a TSL function's body runs when its kernel compiles, often at the first dispatch, so
 * module-level state was read from whichever renderer — or pipeline stage — had set it last.
 *
 * @typedef {Object} SceneResources
 * @property {Array<Node>} srgbBuckets - sRGB material bucket texture nodes (albedo, emissive, sheen, specular colour)
 * @property {Array<Node>} linearBuckets - linear material bucket texture nodes
 * @property {?Array<Node>} shadowAlbedoMaps - sRGB buckets alpha-cutout shadow rays sample, or null
 * @property {?Node} goboMaps - spot / directional gobo texture array, or null
 * @property {?Node} iesProfiles - IES profile texture array, or null
 * @property {?Node} alphaShadows - int uniform, 1 = shadow rays test texture alpha; null = never
 */

import { context } from 'three/tsl';

const KEY = 'rayzeeScene';

/** Builds `node` (a kernel's root call) with these resources in its context. */
export const withSceneResources = ( node, resources ) => context( node, { [ KEY ]: resources } );

/**
 * The resources of the kernel being built; call from a TSL function body with its builder.
 * @returns {SceneResources}
 */
export function sceneResources( builder ) {

	const resources = builder.context[ KEY ];
	if ( ! resources ) throw new Error( 'this kernel samples scene resources: build its root with withSceneResources()' );
	return resources;

}
