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
 * @property {?Object<string, boolean>} materialLayers - the MATERIAL_LAYERS some material uses; null = all of them
 * @property {boolean} [lightRadius] - some point or spot light has a radius (path tracing only); false = all are points
 * @property {boolean} [glass] - some material transmits; false = shadow rays never cross glass, and carry a number, not a colour
 * @property {boolean} [transmissionMaps] - some material has a transmission map; false = shadow rays never sample one
 * @property {boolean} [clearcoatNormals] - some coated material has a normal or bump map; false = every coat follows N
 * @property {boolean} [bumpMaps] - some material has a bump map; false = no shading reads one
 * @property {boolean} [emissionMaps] - some emitting material has an emission map; false = light sampling takes each
 *   triangle's flat emission
 * @property {boolean} [relativeIOR] - some transmissive or subsurface material has a relative IOR; false = every IOR is absolute
 * @property {boolean} [regularize] - path regularization (path tracing only): past a rough bounce, smooth lobes are drawn
 *   rougher; false = every lobe as authored
 * @property {?Object} [fog] - the fog's uniforms ( density, color, anisotropy, boxMin, boxMax, falloff, floor ) while it has a density
 *   (path tracing only); every shadow ray takes its transmittance. null = no fog
 * @property {?SceneSearch} [search] - another way to find hits (a hardware search); null = the BVH walk everywhere
 */

/**
 * A search that stands in for the BVH walk (`shaders/BVHTraversal.js`). Each method is optional: a missing one leaves
 * that walk in place. Each takes TSL nodes and returns a {@link SearchHit}.
 *
 * @typedef {Object} SceneSearch
 * @property {function( { origin: Node, direction: Node, cull: Node } ): SearchHit} [closestHit] - the nearest triangle;
 *   `cull` (bool) keeps only the sides a camera ray sees (`sideAccepts`), else either side
 * @property {function( { origin: Node, direction: Node, maxDistance: Node } ): SearchHit} [shadowHit] - within
 *   `maxDistance`, any triangle that blocks whatever the settings (`shadowFlagsSettle`), else the nearest one
 *
 * @typedef {Object} SearchHit
 * @property {Node} didHit - bool
 * @property {Node} distance - float, along the unit direction; read only on a hit
 * @property {Node} triangle - int, the triangle record
 * @property {Node} instanceLeaf - int, the placement's TLAS leaf; -1 for geometry baked into world space
 * @property {Node} barycentrics - vec2, the weights of the triangle's second and third corners
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

/**
 * The hit search the kernel being built uses in place of the BVH walk, or null. Read without the throw: kernels that
 * build no scene resources (picking, depth) search too.
 * @returns {?SceneSearch}
 */
export const sceneSearch = ( builder ) => builder.context[ KEY ]?.search ?? null;

const SEED_KEY = 'rayzeeSamplerSeed';

/**
 * Builds `node` with the renderer's sampler seed in its context. Seed 0 adds nothing.
 */
export const withSamplerSeed = ( node, seed ) => ( seed ? context( node, { [ SEED_KEY ]: seed >>> 0 } ) : node );

/** The sampler seed of the kernel being built (a whole number below 2³²), 0 without one. */
export const samplerSeed = ( builder ) => builder.context[ SEED_KEY ] ?? 0;

/** The material layers a kernel compiles only while some material in its scene has them. */
export const MATERIAL_LAYERS = Object.freeze( [ 'clearcoat', 'sheen', 'iridescence', 'anisotropy', 'subsurface', 'dispersion', 'diffuseTransmission', 'diffuseRoughness' ] );

/** Every layer compiled in. */
export const ALL_MATERIAL_LAYERS = Object.freeze( Object.fromEntries( MATERIAL_LAYERS.map( ( layer ) => [ layer, true ] ) ) );

/**
 * The material layers the kernel being built compiles; call from a TSL function body with its builder. A layer no
 * material uses is left out of every function that reads it. Outside a scene kernel (a test), every layer is in.
 * @returns {Object<string, boolean>}
 */
export function materialLayers( builder ) {

	return builder.context[ KEY ]?.materialLayers ?? ALL_MATERIAL_LAYERS;

}

/**
 * Whether the kernel being built samples light radii. Off unless a point or spot light has a radius, and off for the
 * bidirectional integrator, whose light paths leave a light's centre. Outside a scene kernel (a test) it is on.
 */
export function usesLightRadius( builder ) {

	return builder.context[ KEY ]?.lightRadius ?? true;

}

/** Whether the kernel being built has shadow rays cross glass, carrying its colour. Outside a scene kernel (a test) it does. */
export function usesGlass( builder ) {

	return builder.context[ KEY ]?.glass ?? true;

}

/** Whether the kernel being built has shadow rays sample transmission maps. Outside a scene kernel (a test) it does. */
export function usesTransmissionMaps( builder ) {

	return builder.context[ KEY ]?.transmissionMaps ?? true;

}

/**
 * Whether the kernel being built gives a clear coat its own normal. Off when no coated material has a normal or bump map,
 * and for the bidirectional integrator, whose stored vertices carry one normal. Outside a scene kernel (a test) it is on.
 */
export function usesClearcoatNormals( builder ) {

	return builder.context[ KEY ]?.clearcoatNormals ?? true;

}

/**
 * Whether the kernel's light sampling reads emitters' emission maps (else each triangle emits its flat colour). Outside a
 * scene kernel (a test) it does not: the sampler then needs the scene data buffer the material block sits in.
 */
export function usesEmissionMaps( builder ) {

	return builder.context[ KEY ]?.emissionMaps ?? false;

}

/** Whether the kernel being built reads bump maps. Outside a scene kernel (a test) it does. */
export function usesBumpMaps( builder ) {

	return builder.context[ KEY ]?.bumpMaps ?? true;

}

/**
 * Whether the kernel being built regularizes paths (`pathRegularization`), so its samplers report whether the lobe they
 * drew is smooth. A choice of look, not of what the scene holds: outside a scene kernel (a test) it is off.
 */
export function usesRegularization( builder ) {

	return builder.context[ KEY ]?.regularize ?? false;

}

/** Whether the kernel being built reads materials' relativeIOR. Outside a scene kernel (a test) it does. */
export function usesRelativeIOR( builder ) {

	return builder.context[ KEY ]?.relativeIOR ?? true;

}
