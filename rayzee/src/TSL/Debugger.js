import {
	Fn,
	wgslFn,
	float,
	vec2,
	vec3,
	vec4,
	int,
	uint,
	max,
	min,
	dot,
	length,
	normalize,
	log,
	clamp,
	mix,
	If,
	select,
	sampler,
} from 'three/tsl';

import { Ray, HitInfo, RayTracingMaterial, MaterialSamples } from './Struct.js';
import { traverseBVHDebug as traverseBVH } from './BVHTraversal.js';
import { sampleEnvironment } from './Environment.js';
import { REC709_LUMINANCE_COEFFICIENTS, getMaterial } from './Common.js';
import { sampleAllMaterialTextures } from './TextureSampling.js';
import { pcgHash, wang_hash, RandomValue } from './Random.js';
import { cosineWeightedSample } from './MaterialSampling.js';

// =============================================================================
// Debug Visualization Helpers
// =============================================================================

// Visualize depth with color gradient (near=white, far=black)
const visualizeDepth = /*@__PURE__*/ wgslFn( `
	fn visualizeDepth( depth: f32 ) -> vec3f {
		return vec3f( 1.0f - depth );
	}
` );

// Visualize normals in world space (RGB mapped from [-1,1] to [0,1])
const visualizeNormal = /*@__PURE__*/ wgslFn( `
	fn visualizeNormal( normal: vec3f ) -> vec3f {
		return normal * 0.5f + 0.5f;
	}
` );

// Compute NDC depth from world position (inlined to avoid circular dep with PathTracer.js)
const computeNDCDepthLocal = /*@__PURE__*/ wgslFn( `
	fn computeNDCDepthLocal( worldPos: vec3f, cameraProjectionMatrix: mat4x4f, cameraViewMatrix: mat4x4f ) -> f32 {
		let clipPos = cameraProjectionMatrix * cameraViewMatrix * vec4f( worldPos, 1.0f );
		let ndcDepth = clipPos.z / clipPos.w * 0.5f + 0.5f;
		return clamp( ndcDepth, 0.0f, 1.0f );
	}
` );

// =============================================================================
// Main Debug Mode Function
// =============================================================================

export const TraceDebugMode = Fn( ( [
	rayOrigin, rayDir,
	// BVH resources
	bvhBuffer,
	triangleBuffer,
	materialBuffer,
	// Environment resources
	envTexture, envMatrix, environmentIntensity, enableEnvironmentLight,
	// Debug parameters
	visMode, debugVisScale,
	// Screen info
	pixelCoord, resolution,
	// Material textures are read from the module-level bucket nodes (setMaterialBucketTextures).
	// Camera matrices (for depth debug mode)
	cameraProjectionMatrix, cameraViewMatrix,
	// Frame counter (for stochastic debug modes)
	frame,
] ) => {

	const result = vec4( 1.0, 0.0, 1.0, 1.0 ).toVar(); // Default: magenta

	// Trace primary ray
	const ray = Ray( { origin: rayOrigin, direction: rayDir } );
	const hitInfo = HitInfo.wrap( traverseBVH(
		ray,
		bvhBuffer,
		triangleBuffer,
	).toVar() );

	// Case 7: Triangle Tests
	If( visMode.equal( int( 7 ) ), () => {

		const vis = float( hitInfo.triTests ).div( debugVisScale );
		result.assign( select(
			vis.lessThan( 1.0 ),
			vec4( vec3( vis ), 1.0 ),
			vec4( 1.0, 0.0, 0.0, 1.0 ),
		) );

	} );

	// Case 8: Box Tests
	If( visMode.equal( int( 8 ) ), () => {

		const vis = float( hitInfo.boxTests ).div( debugVisScale );
		result.assign( select(
			vis.lessThan( 1.0 ),
			vec4( vec3( vis ), 1.0 ),
			vec4( 1.0, 0.0, 0.0, 1.0 ),
		) );

	} );

	// Case 10: Env Luminance
	If( visMode.equal( int( 10 ) ), () => {

		If( enableEnvironmentLight, () => {

			const envSample = sampleEnvironment( {
				tex: envTexture, samp: sampler( envTexture ), direction: rayDir, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
			} ).toVar();

			const envLuminance = dot( envSample.xyz, REC709_LUMINANCE_COEFFICIENTS ).toVar();
			const rawLuminance = envLuminance;

			// Adaptive scaling
			const adaptiveScale = max( debugVisScale.mul( 0.1 ), 0.001 );
			const scaledLuminance = envLuminance.div( adaptiveScale );

			// Logarithmic scaling for better dynamic range
			const logLuminance = log( envLuminance.add( 1e-6 ) );
			const logScaled = logLuminance.add( 10.0 ).div( 10.0 );

			// Choose scaling based on debugVisScale
			const finalValue = select( debugVisScale.greaterThan( 1.0 ), scaledLuminance, logScaled ).toVar();

			// Heat map visualization
			const color = vec3( 0.0 ).toVar();

			If( finalValue.lessThan( 0.2 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 0.5 ), finalValue.mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.4 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 0.5 ), vec3( 0.0, 0.0, 1.0 ), finalValue.sub( 0.2 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.6 ), () => {

				color.assign( mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), finalValue.sub( 0.4 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 0.8 ), () => {

				color.assign( mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 1.0, 0.0 ), finalValue.sub( 0.6 ).mul( 5.0 ) ) );

			} ).ElseIf( finalValue.lessThan( 1.0 ), () => {

				color.assign( mix( vec3( 1.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), finalValue.sub( 0.8 ).mul( 5.0 ) ) );

			} ).Else( () => {

				color.assign( mix( vec3( 1.0, 0.0, 0.0 ), vec3( 1.0, 1.0, 1.0 ), min( finalValue.sub( 1.0 ), 1.0 ) ) );

			} );

			// Debug: Show raw values in specific screen regions
			const screenPos = pixelCoord.div( resolution );

			If( screenPos.x.lessThan( 0.1 ).and( screenPos.y.lessThan( 0.1 ) ), () => {

				const debugValue = rawLuminance.mul( 1.0 );
				color.assign( vec3( debugValue ) );

			} ).ElseIf( screenPos.x.greaterThan( 0.9 ).and( screenPos.y.lessThan( 0.1 ) ), () => {

				color.assign( envSample.xyz.mul( 1.0 ) );

			} );

			result.assign( vec4( color, 1.0 ) );

		} ).Else( () => {

			result.assign( vec4( 1.0, 0.0, 1.0, 1.0 ) );

		} );

	} );

	// Case 4: Emissive
	If( visMode.equal( int( 4 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			result.assign( vec4( 0.0, 0.0, 0.0, 1.0 ) );

		} ).Else( () => {

			// Get material from texture
			const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialBuffer ) ).toVar();

			// Sample all textures to get emissive
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitInfo.uv, hitInfo.normal, vec4( 0.0 ),
			) ).toVar();

			const emissiveColor = matSamples.emissive.toVar();
			const emissiveIntensity = length( emissiveColor ).toVar();

			If( emissiveIntensity.greaterThan( 0.0 ), () => {

				// Show emissive contribution with intensity mapping
				const scaledEmissive = emissiveColor.div( max( emissiveIntensity.mul( 0.1 ), 0.001 ) ).toVar();

				// Add distance-based tint (closer = warmer)
				const dist = length( rayOrigin.sub( hitInfo.hitPoint ) );
				const distanceFactor = clamp( float( 1.0 ).sub( dist.div( 10.0 ) ), 0.0, 1.0 );
				const visualColor = mix( scaledEmissive, scaledEmissive.mul( vec3( 1.0, 0.8, 0.6 ) ), distanceFactor.mul( 0.3 ) );

				result.assign( vec4( visualColor, 1.0 ) );

			} ).Else( () => {

				// No emissive - dark blue
				result.assign( vec4( 0.0, 0.0, 0.1, 1.0 ) );

			} );

		} );

	} );

	// Case 1: Normals
	If( visMode.equal( int( 1 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			// Sky/background = up vector
			result.assign( vec4( 0.5, 0.5, 1.0, 1.0 ) );

		} ).Else( () => {

			// Get material from texture
			const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialBuffer ) ).toVar();

			// Get material-mapped normal (same as what's used in main shader)
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitInfo.uv, hitInfo.normal, vec4( 0.0 ),
			) ).toVar();

			const worldNormal = normalize( matSamples.normal );

			// Encode as [0,1] range (same as gNormalDepth output)
			result.assign( vec4( visualizeNormal( { normal: worldNormal } ), 1.0 ) );

		} );

	} );

	// Case 2: Depth
	If( visMode.equal( int( 2 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			// Far plane = white
			result.assign( vec4( vec3( 1.0 ), 1.0 ) );

		} ).Else( () => {

			// Compute NDC depth (same as main shader)
			const linearDepth = computeNDCDepthLocal( { worldPos: hitInfo.hitPoint, cameraProjectionMatrix, cameraViewMatrix } );

			// Visualize: near=white, far=black
			result.assign( vec4( visualizeDepth( { depth: linearDepth } ), 1.0 ) );

		} );

	} );

	// Case 3: Albedo
	If( visMode.equal( int( 3 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			// Background = black
			result.assign( vec4( 0.0, 0.0, 0.0, 1.0 ) );

		} ).Else( () => {

			// Get albedo from material textures (same as main shader)
			const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialBuffer ) ).toVar();

			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitInfo.uv, hitInfo.normal, vec4( 0.0 ),
			) ).toVar();

			const objectColor = matSamples.albedo.rgb;

			result.assign( vec4( objectColor, 1.0 ) );

		} );

	} );

	// Case 5: Indirect (GI)
	// Shows only light that has bounced at least once — no direct lighting.
	// Converges progressively via the accumulation pipeline.
	If( visMode.equal( int( 5 ) ), () => {

		If( hitInfo.didHit.not(), () => {

			// Primary ray missed — no indirect contribution
			result.assign( vec4( 0.0, 0.0, 0.0, 1.0 ) );

		} ).Else( () => {

			// Get primary surface material
			const material = RayTracingMaterial.wrap( getMaterial( hitInfo.materialIndex, materialBuffer ) ).toVar();
			const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
				material, hitInfo.uv, hitInfo.normal, vec4( 0.0 ),
			) ).toVar();

			const albedoA = matSamples.albedo.rgb;
			const normalA = normalize( matSamples.normal ).toVar();

			// Generate per-pixel per-frame random seed for stochastic bounce direction
			const pixelSeed = uint( pixelCoord.x ).mul( uint( 1973 ) )
				.add( uint( pixelCoord.y ).mul( uint( 9277 ) ) )
				.add( frame.mul( uint( 26699 ) ) );
			const rngState = pcgHash( { state: wang_hash( { seed: pixelSeed } ) } ).toVar();

			// Cosine-weighted hemisphere sample around the surface normal
			const xi_r1 = RandomValue( rngState ).toVar();
			const xi_r2 = RandomValue( rngState ).toVar();
			const xi = vec2( xi_r1, xi_r2 );
			const bounceDir = cosineWeightedSample( { N: normalA, xi } ).toVar();

			// Trace secondary ray from the hit point (offset along normal to avoid self-intersection)
			const bounceOrigin = hitInfo.hitPoint.add( normalA.mul( 0.001 ) );
			const bounceRay = Ray( { origin: bounceOrigin, direction: bounceDir } );

			const bounceHit = HitInfo.wrap( traverseBVH(
				bounceRay,
				bvhBuffer,
				triangleBuffer,
			).toVar() );

			const incoming = vec3( 0.0 ).toVar();

			If( bounceHit.didHit.not(), () => {

				// Bounce ray escaped — incoming radiance from environment
				If( enableEnvironmentLight, () => {

					incoming.assign( sampleEnvironment( {
						tex: envTexture, samp: sampler( envTexture ), direction: bounceDir, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
					} ).xyz );

				} );

			} ).Else( () => {

				// Bounce hit surface B — evaluate its contribution
				const materialB = RayTracingMaterial.wrap( getMaterial( bounceHit.materialIndex, materialBuffer ) ).toVar();
				const matSamplesB = MaterialSamples.wrap( sampleAllMaterialTextures(
					materialB, bounceHit.uv, bounceHit.normal, vec4( 0.0 ),
				) ).toVar();

				// Emissive contribution from surface B
				incoming.assign( matSamplesB.emissive );

				// Approximate direct environment illumination at surface B
				// (hemisphere-averaged environment via the surface normal)
				If( enableEnvironmentLight, () => {

					const normalB = normalize( matSamplesB.normal ).toVar();
					const envAtB = sampleEnvironment( {
						tex: envTexture, samp: sampler( envTexture ), direction: normalB, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
					} ).xyz;

					// Diffuse response: albedoB * environment
					incoming.addAssign( matSamplesB.albedo.rgb.mul( envAtB ) );

				} );

			} );

			// Indirect illumination = albedoA * incoming
			// (cosine term and 1/PI cancel out with cosine-weighted PDF)
			const indirect = albedoA.mul( incoming );

			result.assign( vec4( indirect, 1.0 ) );

		} );

	} );

	// Case 6: Env Reflection
	// Shows the environment color evaluated at the reflection direction for the first hit.
	// For misses, shows environment at ray direction.
	// This tests whether sampleEnvironment produces correct colors for arbitrary directions.
	If( visMode.equal( int( 6 ) ), () => {

		If( hitInfo.didHit, () => {

			const N = hitInfo.normal.toVar();
			// Reflect: R = D - 2*dot(D,N)*N
			const reflDir = normalize( rayDir.sub( N.mul( dot( rayDir, N ).mul( 2.0 ) ) ) ).toVar();

			const envColor = sampleEnvironment( {
				tex: envTexture, samp: sampler( envTexture ), direction: reflDir, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
			} ).xyz;

			const displayColor = envColor.div( envColor.add( 1.0 ) );
			result.assign( vec4( displayColor, 1.0 ) );

		} ).Else( () => {

			const envColor = sampleEnvironment( {
				tex: envTexture, samp: sampler( envTexture ), direction: rayDir, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight,
			} ).xyz;

			const displayColor = envColor.div( envColor.add( 1.0 ) );
			result.assign( vec4( displayColor, 1.0 ) );

		} );

	} );

	return result;

} );
