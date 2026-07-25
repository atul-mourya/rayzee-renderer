/**
 * ShaderBuilder.js — shared scene texture-node factory for the path tracer.
 *
 * Creates the texture/storage nodes the wavefront kernels read (environment, material map
 * arrays, previous-frame MRT, adaptive-sampling, gobo/IES) and configures the module-level
 * shadow/alpha/gobo/IES shader state. Nodes are created once and updated in-place via
 * .value mutation to preserve compiled shader-graph references.
 */

import { texture } from 'three/tsl';
import { LinearFilter, DataArrayTexture } from 'three';
import { setAlphaShadowsUniform } from '../TSL/LightsDirect.js';
import { setGoboMapsTexture, setIESProfilesTexture } from '../TSL/LightsCore.js';
import { createLogger } from '../utils/Logger.js';

const log = createLogger( 'shader' );

export class ShaderBuilder {

	constructor() {

		// Previous-frame texture nodes (sample from MRT RenderTarget)
		this.prevColorTexNode = null;
		this.prevAlbedoTexNode = null;
		this.prevNormalDepthTexNode = null;

		// Scene texture nodes cache (for in-place updates on model change)
		this._sceneTextureNodes = null;

	}

	updateSceneTextures( stage ) {

		const nodes = this._sceneTextureNodes;

		const env = stage.environment;

		if ( env.environmentTexture && nodes.envTex ) {

			nodes.envTex.value = env.environmentTexture;

		}

		// Material bucket arrays are owned by PathTracer's independent wavefront nodes
		// (_refreshWfTextureNodes); nothing to swap here.
		if ( stage.goboMaps && nodes.goboMapsTex ) nodes.goboMapsTex.value = stage.goboMaps;
		if ( stage.iesProfiles && nodes.iesProfilesTex ) nodes.iesProfilesTex.value = stage.iesProfiles;

		log.debug( 'scene textures updated in-place' );

	}

	/**
	 * Swap the spot light gobo texture in-place. The TSL graph closes over the
	 * texture node, so we only need to update the underlying .value.
	 * @param {DataArrayTexture | null} tex
	 */
	updateGoboMaps( tex ) {

		const nodes = this._sceneTextureNodes;
		if ( ! nodes || ! nodes.goboMapsTex ) return;
		if ( tex ) nodes.goboMapsTex.value = tex;

	}

	/**
	 * Swap the spot light IES profile texture in-place.
	 * @param {DataArrayTexture | null} tex
	 */
	updateIESProfiles( tex ) {

		const nodes = this._sceneTextureNodes;
		if ( ! nodes || ! nodes.iesProfilesTex ) return;
		if ( tex ) nodes.iesProfilesTex.value = tex;

	}

	getSceneTextureNodes() {

		return this._sceneTextureNodes;

	}

	// Creates the shared scene texture nodes (env, material maps, prev-frame, adaptive, gobo, IES)
	// + configures the module-level shadow/alpha/gobo/IES shader state read by the wavefront kernels.
	// Call from setupMaterial before the kernels are built.
	createSceneTextureNodes( stage, storageTextures ) {

		const triStorage = stage.triangleStorageNode;
		const bvhStorage = stage.bvhStorageNode;
		const matStorage = stage.materialData.materialStorageNode;
		// Packed light buffer — [lightBVH | emissive triangles]. One node fed to both
		// TSL params; emissive reads offset by stage.emissiveVec4Offset.
		const lightBufferStorage = stage.lightStorageNode;

		// Set alpha-shadow uniform (module-level in LightsDirect.js, read at runtime)
		setAlphaShadowsUniform( stage.uniforms.get( 'enableAlphaShadows' ) );

		const envTex = texture( stage.environment.environmentTexture );

		// Previous-frame texture nodes — initialized from readTarget textures
		const readTextures = storageTextures.getReadTextures();
		this.prevColorTexNode = texture( readTextures.color );
		this.prevAlbedoTexNode = texture( readTextures.albedo );
		this.prevNormalDepthTexNode = texture( readTextures.normalDepth );

		const createArrayPlaceholder = () => {

			const dummyTex = new DataArrayTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1, 1 );
			dummyTex.minFilter = LinearFilter;
			dummyTex.magFilter = LinearFilter;
			dummyTex.generateMipmaps = false;
			dummyTex.needsUpdate = true;
			return texture( dummyTex );

		};

		// Material map arrays (consolidated size buckets) are owned by PathTracer's
		// independent wavefront nodes + setMaterialBucketTextures/setShadowAlbedoMaps —
		// see PathTracer._buildWavefrontKernels. Nothing material-map related is bound here.

		// Spot light gobo array — placeholder until GoboManager populates it.
		const goboMapsTex = stage.goboMaps ? texture( stage.goboMaps ) : createArrayPlaceholder();
		setGoboMapsTexture( goboMapsTex );

		// Spot light IES profiles array — placeholder until IESManager populates it.
		const iesProfilesTex = stage.iesProfiles ? texture( stage.iesProfiles ) : createArrayPlaceholder();
		setIESProfilesTexture( iesProfilesTex );

		const result = {
			triStorage, bvhStorage, matStorage, lightBufferStorage,
			envTex,
			goboMapsTex, iesProfilesTex,
		};

		this._sceneTextureNodes = result;
		return result;

	}

	dispose() {

		this.prevColorTexNode = null;
		this.prevAlbedoTexNode = null;
		this.prevNormalDepthTexNode = null;
		this._sceneTextureNodes = null;

	}

}
