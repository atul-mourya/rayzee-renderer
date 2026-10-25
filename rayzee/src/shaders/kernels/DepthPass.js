import { Fn, vec2, float, int, uniform, storage, If, Loop, Break, select, dot, length, normalize, vec3, workgroupId, localId } from 'three/tsl';
import { StorageBufferAttribute } from 'three/webgpu';
import { Matrix4 } from 'three';
import { Ray, HitInfo, RayTracingMaterial, UVCache } from '../Struct.js';
import { traverseBVH } from '../BVHTraversal.js';
import { cameraRayOf, cameraRayUniforms, cameraClipDistance } from '../CameraRay.js';
import { getMaterial, offsetRayOrigin } from '../Common.js';
import { freeStorageAttribute } from '../../pathtracer/PackedRayBuffer.js';
import { KernelManager } from '../../pathtracer/KernelManager.js';
import { computeUVCache, processAlbedo, buildBucketTextureNodes } from '../TextureSampling.js';
import { withSceneResources } from '../SceneResources.js';
import { CAMERA_PROJECTION_IDS } from '../../EngineDefaults.js';

/** Where nothing was hit, as Cycles writes its depth pass. */
const DEPTH_BACKGROUND = 1e10;

const WG = 8;
const MAX_SKIPS = 16;

/**
 * A saved EXR's depth: one camera ray through each pixel's centre, unjittered, past what the camera does not see —
 * culled back faces, alpha cut-outs (a blended surface below half opacity) — measured along the view axis in scene
 * units, or from the camera in a panorama. Built and freed per export: nothing is kept between saves.
 */
export class DepthPass {

	constructor( renderer ) {

		this.renderer = renderer;
		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.cameraRay = cameraRayUniforms();
		this.width = uniform( 1 );
		this.height = uniform( 1 );

	}

	/**
	 * @param {import('../../pathtracer/PathTracer.js').PathTracer} stage - its scene, camera and render size
	 * @returns {Promise<?Float32Array>} `width * height`, top row first; null before a scene is built
	 */
	async read( stage ) {

		const nodes = stage.sceneStorageNodes?.();
		const materials = stage.materialData?.materialStorageAttr;
		if ( ! nodes || ! materials ) return null;

		const { width, height } = stage;
		this.width.value = width;
		this.height.value = height;
		this.cameraWorldMatrix.value.copy( stage.uniforms.get( 'cameraWorldMatrix' ).value );
		this.cameraProjectionMatrixInverse.value.copy( stage.uniforms.get( 'cameraProjectionMatrixInverse' ).value );
		this.cameraRay.sync( stage.uniforms );

		const attribute = new StorageBufferAttribute( new Float32Array( width * height ), 1 );
		const owned = stage.materialData.srgbBuckets ?? [];
		const resources = {
			srgbBuckets: buildBucketTextureNodes( owned ), linearBuckets: buildBucketTextureNodes( null ),
			shadowAlbedoMaps: null, goboMaps: null, iesProfiles: null, alphaShadows: null,
		};
		const kernel = withSceneResources( this._kernel( nodes, storage( materials, 'vec4', materials.count ).toReadOnly(), storage( attribute, 'float', width * height ) ), resources )
			.compute( [ Math.ceil( width / WG ), Math.ceil( height / WG ), 1 ], [ WG, WG, 1 ] );

		try {

			if ( KernelManager.canCompileInBackground ) await this.renderer.compileComputeAsync( kernel );
			this.renderer.compute( kernel );
			return new Float32Array( await this.renderer.getArrayBufferAsync( attribute ) );

		} finally {

			kernel.dispose();
			freeStorageAttribute( this.renderer, attribute );
			for ( const node of [ ...resources.srgbBuckets, ...resources.linearBuckets ] ) {

				if ( ! owned.includes( node.value ) ) node.value.dispose();

			}

		}

	}

	_kernel( { bvh, triangles }, materials, out ) {

		const { width, height, cameraRay } = this;
		const panorama = cameraRay.cameraProjection.equal( int( CAMERA_PROJECTION_IDS.equirectangular ) );

		// mat4 uniforms as Fn parameters, so TSL indexes them.
		return Fn( ( [ camWorld, camProjInv ] ) => {

			const gx = int( workgroupId.x ).mul( WG ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG ).add( int( localId.y ) );

			If( gx.lessThan( int( width ) ).and( gy.lessThan( int( height ) ) ), () => {

				const uv = vec2( float( gx ).add( 0.5 ).div( width ), float( gy ).add( 0.5 ).div( height ) );
				const primary = cameraRayOf( uv, camWorld, camProjInv, cameraRay );
				const direction = primary.direction.toVar();
				const clipAlong = cameraClipDistance( direction, cameraRay.clipStart, camWorld, cameraRay.cameraProjection );
				const origin = primary.origin.add( direction.mul( clipAlong ) ).toVar();
				const eye = vec3( camWorld[ 3 ] ).toVar();
				const forward = normalize( vec3( camWorld[ 2 ] ) ).negate().toVar();
				const depth = float( DEPTH_BACKGROUND ).toVar();

				Loop( MAX_SKIPS, () => {

					const hit = HitInfo.wrap( traverseBVH( Ray( { origin, direction } ), bvh, triangles ) ).toVar();
					If( hit.didHit.not(), () => {

						Break();

					} );

					const material = RayTracingMaterial.wrap( getMaterial( hit.materialIndex, materials ) ).toVar();
					const seeThrough = float( 0 ).toVar();
					If( material.alphaMode.notEqual( int( 0 ) ), () => {

						const uvCache = UVCache.wrap( computeUVCache( hit.uv, material ) ).toVar();
						const alpha = processAlbedo( material, uvCache ).a.mul( material.opacity );
						const cutoff = select( material.alphaMode.equal( int( 1 ) ).and( material.alphaTest.greaterThan( 0.0 ) ), material.alphaTest, float( 0.5 ) );
						seeThrough.assign( select( alpha.lessThan( cutoff ), float( 1 ), float( 0 ) ) );

					} );

					If( seeThrough.equal( 0 ), () => {

						const toHit = hit.hitPoint.sub( eye );
						depth.assign( select( panorama, length( toHit ), dot( toHit, forward ) ) );
						Break();

					} );

					origin.assign( offsetRayOrigin( hit.hitPoint, direction ) );

				} );

				out.element( gy.mul( int( width ) ).add( gx ) ).assign( depth );

			} );

		} )( this.cameraWorldMatrix, this.cameraProjectionMatrixInverse );

	}

}
