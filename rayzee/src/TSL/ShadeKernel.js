/**
 * ShadeKernel.js — wavefront material eval + bounce generation. 256×1 workgroup, 1D dispatch.
 * 10 storage-buffer bindings: bvh, tri, mat, light, ray, rng, hit, gBuffer, counters, activeIndices
 * (at the device per-stage limit of 10; envCDF is a texture, not a storage buffer).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	bool as tslBool,
	If, Loop, normalize, max, exp, log, clamp, dot, length, select, smoothstep, mix,
	instanceIndex,
	sampler,
	atomicAdd, atomicLoad, atomicStore, uintBitsToFloat,
	Return,
} from 'three/tsl';

import { sampleEnvironment, sampleEquirectProbability, sampleEquirect, groundProjectedEnvDir } from './Environment.js';
import { getMaterial, powerHeuristic, balanceHeuristic, classifyMaterial, REC709_LUMINANCE_COEFFICIENTS, PI_INV, EPSILON, diffuseGroundMaterial } from './Common.js';
import { cosineWeightedSample } from './MaterialSampling.js';
import { sampleAllMaterialTextures, processAnisotropyMap, applyExtensionMaps, getTransformedUV } from './TextureSampling.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateDirectLightingUnified, calculateMaterialPDF } from './LightsSampling.js';
import { traceShadowRay, calculateRayOffset } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { handleMaterialTransparency, MaterialInteractionResult } from './MaterialTransmission.js';
import { sampleChromaticCollision, sampleHenyeyGreenstein, subsurfaceCoefficients, CollisionSample, MediumCoeffs } from './Subsurface.js';
import { calculateIndirectLighting } from './LightsIndirect.js';
import { IndirectLightingResult, sampleCone } from './LightsCore.js';
import { regularizePathContribution, generateSampledDirection, computeNDCDepth, handleRussianRoulette } from './PathTracerCore.js';
import { getImportanceSamplingInfo, evaluateDFG } from './MaterialProperties.js';
import { dielectricF0 } from './Fresnel.js';
import { sampleClearcoat, ClearcoatResult } from './Clearcoat.js';
import { refineDisplacedIntersection, DisplacementResult } from './Displacement.js';
import { calculateEmissiveTriangleContribution, calculateEmissiveLightPdf, EmissiveSample } from './EmissiveSampling.js';
import { sampleLightBVHTriangle, calculateLightBVHPdf } from './LightBVHSampling.js';
import {
	Ray,
	HitInfo,
	RayTracingMaterial,
	MaterialSamples,
	ExtMapResult,
	DirectionSample,
	ImportanceSamplingInfo,
	MaterialClassification,
	BRDFWeights,
	MaterialCache,
	DirectLightingDual,
	DFGResult,
} from './Struct.js';
import { RandomValue, getRandomSample } from './Random.js';
import { RAY_FLAG, COUNTER } from '../Processor/QueueManager.js';
import {
	readRayOrigin, readRayDirection, readRayBounceFlags, readRayThroughput, readRayPdf,
	readMediumStack, writeMediumStack, readMediumSigmaA, writeMediumSigmaA,
	readPathBounces, readSssSteps, readSSSMedium, writeSSSMedium,
	readTransparentCount,
	readHitDistance, readHitBarycentrics, readHitNormal,
	readHitMaterialIndex, readHitTriangleIndex,
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf, writeRayRadiance,
	writeGBuffer, readGBuffer, gbDecodeNormalDepth,
	readRayRadiance,
	readFeatureThroughput, writeFeatureThroughput,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;
const MISS_DIST = 1e19;

// Shadow-catcher thresholds (named so the two distinct 1e-4 uses don't read as one value)
const CATCHER_T_MIN = 1e-4; // min ray-t for the analytic plane hit (skip behind/at the camera)
const CATCHER_LUMA_FLOOR = 1e-4; // denominator floor for the shadow ratio
const CATCHER_COVERAGE_MIN = 1e-3; // below this incident luma there is no shadow to catch

export function buildShadeKernel( params ) {

	const {
		bvhBuffer, triangleBuffer, materialBuffer,
		envCDFTexture,
		lightBuffer,
		rayBufferRW, rngBufferRW, hitBufferRO, gBufferRW,
		counters,
		activeIndicesRO,
		envTexture, environmentIntensity, envMatrix,
		enableEnvironmentLight, useEnvMapIS,
		groundProjectionEnabled, groundProjectionRadius, groundProjectionHeight, groundProjectionLevel,
		enableGroundCatcher, groundCatcherHeight,
		envTotalSum, envCompensationDelta, envResolution,
		directionalLightsBuffer, numDirectionalLights,
		areaLightsBuffer, numAreaLights,
		pointLightsBuffer, numPointLights,
		spotLightsBuffer, numSpotLights,
		maxBounceCount, maxSubsurfaceSteps,
		maxTransparentBounces, // guard on alpha-skip depth; counter in ORIGIN_META.w
		currentBounce, // loop iteration = path length (advances on free bounces); drives RR/firefly/giScale
		transparentBackground, backgroundIntensity, backgroundColor, backgroundBlurriness, backgroundBlurSamples, showBackground,
		globalIlluminationIntensity,
		cameraProjectionMatrix, cameraViewMatrix,
		fireflyThreshold, frame, resolution,
		chunkRowBase, // chunked path pool: global pixel = chunkRowBase·W + localSlot (rayID). See spec.
		emissiveTriangleCount, emissiveVec4Offset, emissiveTotalPower,
		emissiveBoost, totalTriangleCount, enableEmissiveTriangleSampling,
		lightBVHNodeCount, reverseMapVec4Offset,
		maxRayCount,
		// Aux G-buffer (normal/depth/albedo + surface ID) feeds only the denoiser/OIDN MRT. Gated by a
		// live uniform (1 = denoiser on) so the wavefront skips these writes when nothing consumes them.
		auxGBufferEnabled,
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );

	const useEmissiveNEE = lightBuffer !== undefined;

	// Stochastic cone-jitter blur of an env backdrop lookup. Plain JS inliner (NOT a Fn — an rng Fn-param
	// would freeze; see TSL pitfalls) so it mutates the caller's rngState .toVar() directly. Shared by the
	// miss branch and the shadow catcher so their blur stays in lockstep (no horizon seam). normalize() the
	// center direction — ground projection can return a non-unit vector, which would skew sampleCone's basis.
	// Clamp the tap count to ≥1 so a 0 forced via the engine API can't produce a 0/0 NaN backdrop.
	const sampleEnvBlurred = ( centerDir, halfAngle, samples, rng ) => {

		const axis = normalize( centerDir ).toVar();
		const n = max( samples, int( 1 ) ).toVar();
		const acc = vec3( 0.0 ).toVar();
		Loop( { start: int( 0 ), end: n, type: 'int', condition: '<' }, () => {

			// per-component .toVar(): vec2(RandomValue, RandomValue) would collapse to u==v (TSL pitfall)
			const u1 = RandomValue( rng ).toVar();
			const u2 = RandomValue( rng ).toVar();
			const jDir = sampleCone( axis, halfAngle, vec2( u1, u2 ) ).toVar();
			acc.addAssign( sampleEnvironment( {
				tex: envTexture,
				samp: sampler( envTexture ),
				direction: jDir,
				environmentMatrix: envMatrix,
				environmentIntensity,
				enableEnvironmentLight: float( 1.0 ),
			} ).xyz );

		} );
		return acc.div( float( n ) );

	};

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// Folds the former resetActiveCounter 1-thread kernel: thread 0 zeroes the survivor counter
		// before compact re-counts it. Kept ABOVE the ENTERING_COUNT guard so it fires even at bound 0.
		// Safe: shade never touches ACTIVE_RAY_COUNT, and the shade→compact dispatch boundary publishes it.
		if ( counters ) {

			If( threadIdx.equal( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );

			} );

		}

		// bound on ENTERING_COUNT so an over-sized margin dispatch is safe
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : maxRayCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

		} );

		const rayID = activeIndicesRO.element( threadIdx );

		const flags = readRayBounceFlags( rayBufferRW, rayID ).toVar();

		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			Return();

		} );

		// Backdrop-view = the ray still travels the original camera direction (only alpha/transparent passthrough
		// since the camera, REDIRECTED still clear). Captured at ARRIVAL (before the opaque/redirect bitOr below)
		// so it stays valid for both the miss branch and the emissive-hit scale. This — not bounceIndex==0 — is
		// the correct "is the env/emitter here a direct view" test, so env/emitters through alpha-cutout holes
		// are treated like the open backdrop, not a GI bounce.
		const isBackdropView = flags.bitAnd( uint( RAY_FLAG.REDIRECTED ) ).equal( uint( 0 ) ).toVar();

		const origin = readRayOrigin( rayBufferRW, rayID ).toVar();
		const direction = readRayDirection( rayBufferRW, rayID ).toVar();
		const throughput = readRayThroughput( rayBufferRW, rayID ).toVar();
		const currentRadiance = readRayRadiance( rayBufferRW, rayID ).toVar();
		// One ray per pixel: rayID is the pixel index.
		const pixelIndex = rayID;
		const rngState = rngBufferRW.element( rayID ).toVar();

		// DDFA see-through aux tint carried across smooth glass/mirror; committed into the OIDN/ASVGF
		// albedo guide at the first diffuse-enough surface (or env). Mutated locally, persisted on every
		// deferring continue (a missed persist = stale tint). 1 = untinted (direct hit → today's albedo).
		const featCarry = readFeatureThroughput( rayBufferRW, rayID ).toVar();

		const hitDist = readHitDistance( hitBufferRO, rayID ).toVar();
		const hitNormal = readHitNormal( hitBufferRO, rayID ).toVar();
		// hitInfo.uv is the interpolated texture UV (not barycentrics)
		const hitUV = readHitBarycentrics( hitBufferRO, rayID ).toVar();
		const hitMatIdx = readHitMaterialIndex( hitBufferRO, rayID ).toVar();
		const hitTriIdx = readHitTriangleIndex( hitBufferRO, rayID ).toVar();

		// per-ray camera-bounce depth — advances ONLY on opaque scatter (free bounces don't); drives termination (maxBounces). Megakernel: effectiveBounces.
		const cameraDepth = readPathBounces( rayBufferRW, rayID ).toVar();
		// path length = loop iteration (advances every bounce incl. transmissive/SSS); drives RR/firefly/giScale/MIS. Megakernel: loop counter i.
		const bounceIndex = int( currentBounce ).toVar();
		const sssSteps = readSssSteps( rayBufferRW, rayID ).toVar();
		const transparentCount = readTransparentCount( rayBufferRW, rayID ).toVar();

		// ── Analytic ground-plane shadow catcher (primary ray only, no geometry) ──
		// A horizontal plane at y = groundCatcherHeight. For a bounce-0 ray that crosses it
		// closer than any BVH hit (hitDist is MISS_DIST on sky rays, so the plane wins over the
		// bare environment), shade it as a diffuse Lambertian holdout: output a monochrome shadow
		// ratio in alpha (rgb = 0) so it composites as bg·ratio over a transparent background.
		// Shadows are caught by the EXISTING NEE shadow ray into real geometry — the plane itself
		// never enters the BVH. Secondary bounces ignore it entirely.
		If( enableGroundCatcher.and( bounceIndex.equal( 0 ) ), () => {

			const dirY = direction.y.toVar();
			If( dirY.abs().greaterThan( float( EPSILON ) ), () => {

				const tPlane = groundCatcherHeight.sub( origin.y ).div( dirY ).toVar();
				If( tPlane.greaterThan( float( CATCHER_T_MIN ) ).and( tPlane.lessThan( hitDist ) ), () => {

					const planePoint = origin.add( direction.mul( tPlane ) ).toVar();
					const planeN = vec3( 0.0, 1.0, 0.0 );
					const planeV = direction.negate().toVar();
					const planeMat = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();

					// Cosine-weighted hemisphere BRDF sample about the plane normal (0,1,0); the helper
					// puts cosθ along N, so bDir.y == cosθ. Per-component .toVar() on the two randoms
					// (vec2(RandomValue,RandomValue) would collapse to u==v — TSL pitfall).
					const u1 = RandomValue( rngState ).toVar();
					const u2 = RandomValue( rngState ).toVar();
					const bDir = cosineWeightedSample( planeN, vec2( u1, u2 ) ).toVar();
					const bPdf = bDir.y.mul( PI_INV ).toVar(); // cosθ / π
					const bVal = vec3( PI_INV ); // albedo(1) / π

					// Reuse the full NEE estimator; the diffuse BRDF is constant and cancels in the
					// ratio, so this yields an irradiance-weighted shadow density across all lights + env.
					const dual = DirectLightingDual.wrap( calculateDirectLightingUnified(
						planePoint, planeN, planeMat, planeV,
						bDir, bPdf, bVal,
						bounceIndex, rngState,
						directionalLightsBuffer, numDirectionalLights,
						areaLightsBuffer, numAreaLights,
						pointLightsBuffer, numPointLights,
						spotLightsBuffer, numSpotLights,
						bvhBuffer, triangleBuffer, materialBuffer,
						envTexture, environmentIntensity, envMatrix,
						envCDFTexture,
						envTotalSum, envCompensationDelta, envResolution,
						enableEnvironmentLight,
						tslBool( true ), // wantUnoccluded
					) ).toVar();

					const lumShad = max( dot( dual.shadowed, REC709_LUMINANCE_COEFFICIENTS ), float( 0.0 ) );
					const lumLit = max( dot( dual.unoccluded, REC709_LUMINANCE_COEFFICIENTS ), float( 0.0 ) ).toVar();
					const ratio = clamp( lumShad.div( max( lumLit, float( CATCHER_LUMA_FLOOR ) ) ), 0.0, 1.0 ).toVar();
					// Coverage gate: where no light reaches the plane there is no shadow to catch —
					// force ratio=1 (no darkening) so unlit ground reads as plain background, not spurious black.
					If( lumLit.lessThan( float( CATCHER_COVERAGE_MIN ) ), () => {

						ratio.assign( 1.0 );

					} );

					// Adaptive output (matches Arnold's scene_background / Cycles shadow catcher): the catcher
					// respects the current background mode instead of forcing transparency.
					//  • Transparent background → emit a matte (rgb=0, alpha=1−ratio); the shadow rides alpha
					//    and composites as backplate·ratio over an external plate.
					//  • Visible background     → composite the shadow into RGB: show the environment this
					//    camera ray would otherwise see, darkened by the shadow ratio (alpha=1). The HDRI stays
					//    visible; at the horizon ratio→1 so the catcher meets the sky with no seam.
					// Sample the background via the SAME shared helper the miss branch uses, so the
					// catcher seamlessly continues the visible environment (with ground projection on it
					// must bend identically, else a bright horizon seam / mismatched ground appears).
					const catcherEnvDir = groundProjectedEnvDir(
						origin, direction, groundProjectionEnabled, groundProjectionRadius, groundProjectionHeight, groundProjectionLevel,
					).toVar();
					// force-enable the sampler (pass 1.0): the visible backdrop is decoupled from env-lighting,
					// so the catcher continues the HDRI even when the environment isn't used as a light.
					// Only sample the env where it's actually shown as the catcher backdrop (showBackground); in
					// color/transparent mode the catcher composites over backgroundColor / alpha, so the (up to
					// N-tap) env work would be discarded. Blur matches the miss branch via the shared helper.
					const envBehind = vec3( 0.0 ).toVar();
					If( showBackground, () => {

						If( backgroundBlurriness.greaterThan( 0.0 ), () => {

							envBehind.assign( sampleEnvBlurred( catcherEnvDir, backgroundBlurriness.mul( 1.3 ), backgroundBlurSamples, rngState ) );

						} ).Else( () => {

							envBehind.assign( sampleEnvironment( {
								tex: envTexture,
								samp: sampler( envTexture ),
								direction: catcherEnvDir,
								environmentMatrix: envMatrix,
								environmentIntensity,
								enableEnvironmentLight: float( 1.0 ),
							} ).xyz );

						} );

					} );
					// Background mode: env image (showBackground) or the solid backgroundColor (color mode).
					const bgColor = select( showBackground, envBehind.mul( backgroundIntensity ), backgroundColor );
					const outRgb = select( transparentBackground, vec3( 0.0 ), bgColor.mul( ratio ) );
					const outAlpha = select( transparentBackground, float( 1.0 ).sub( ratio ), float( 1.0 ) );

					// The catcher is a real ground surface for the denoiser — write the plane's normal/depth
					// + a neutral albedo (black albedo would break OIDN demodulation) and mark the pixel a
					// valid surface, so OIDN/ASVGF don't smear the caught shadow as a background miss.
					If( auxOn, () => {

						const planeDepth = computeNDCDepth( { worldPos: planePoint, cameraProjectionMatrix, cameraViewMatrix } );
						writeGBuffer( gBufferRW, pixelIndex, planeN, planeDepth, vec3( 1.0 ) );

					} );

					writeRayRadiance( rayBufferRW, rayID, vec4( outRgb, outAlpha ) );
					// DDFA: the plane's aux (written above) is a committed surface — lock it (cosmetic; ray dies here).
					writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitOr( uint( RAY_FLAG.AUX_LOCKED ) ).bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
					rngBufferRW.element( rayID ).assign( rngState );
					Return();

				} );

			} );

		} );

		If( hitDist.greaterThan( MISS_DIST ), () => {

			// Background and environment-lighting are decoupled (independent axes):
			//  • Visible backdrop: a PRIMARY ray draws the env image only when showBackground — regardless
			//    of enableEnvironmentLight (so you can show the HDRI without it lighting the scene).
			//  • Env as a light: SECONDARY bounces add the env (implicit MIS hit) only when enableEnvironmentLight.
			// Backdrop-view = the ray still travels the original camera direction (only alpha/transparent
			// passthrough since the camera). This — NOT bounceIndex==0 — is the correct test for "the env here
			// is the direct backdrop", so env seen through alpha-cutout foliage holes is treated identically to
			// the open sky (blur, intensity, show/hide, color-mode, ground projection all match).
			// isBackdropView was captured at arrival (above) so it survives the REDIRECTED bitOr on opaque hits.
			const wantBackdrop = isBackdropView.and( showBackground ); // draw env image as backdrop
			const wantEnvLight = isBackdropView.not().and( enableEnvironmentLight ); // env as light on redirected bounces

			// DDFA: env colour a redirected ray escaping to the environment sees (e.g. smooth glass over
			// sky). Committed (tinted by featCarry) into the aux G-buffer before the miss Return below.
			const escapedAuxAlbedo = vec3( 0.0 ).toVar();

			If( wantBackdrop.or( wantEnvLight ), () => {

				// Ground projection bends the backdrop-view env lookup onto a projected sphere+disk so the lower
				// env hemisphere reads as a ground plane. Backdrop-view only (incl. through alpha-cutout holes,
				// since they keep the camera direction); redirected bounces see the raw envmap as a light. The
				// shared helper (also used by the shadow catcher) keeps the two in lockstep.
				const envDir = direction.toVar();
				If( isBackdropView, () => {

					envDir.assign( groundProjectedEnvDir(
						origin, direction, groundProjectionEnabled, groundProjectionRadius, groundProjectionHeight, groundProjectionLevel,
					) );

				} );

				// Backdrop-view rays blur the env (cone jitter, shared helper); redirected env-light bounces take
				// the sharp Else. force-enable the sampler (pass 1.0): the wantBackdrop/wantEnvLight gate above
				// already decided visibility, so the backdrop shows the HDRI even when env-lighting is off.
				// Direction-space jitter keeps the blur free of equirect pole/seam artifacts; accumulation
				// converges the noise. Opt-in — blurriness 0 takes the sharp Else (zero cost).
				const envColor = vec3( 0.0 ).toVar();
				If( isBackdropView.and( backgroundBlurriness.greaterThan( 0.0 ) ), () => {

					envColor.assign( sampleEnvBlurred( envDir, backgroundBlurriness.mul( 1.3 ), backgroundBlurSamples, rngState ) );

				} ).Else( () => {

					envColor.assign( sampleEnvironment( {
						tex: envTexture,
						samp: sampler( envTexture ),
						direction: envDir,
						environmentMatrix: envMatrix,
						environmentIntensity,
						enableEnvironmentLight: float( 1.0 ),
					} ).xyz );

				} );

				// DDFA: remember the (clamped) env colour this escaped ray sees, for the redirected-escape
				// aux commit below (tinted by the accumulated see-through throughput).
				escapedAuxAlbedo.assign( clamp( envColor, vec3( 0.0 ), vec3( 1.0 ) ) );

				// MIS weight for implicit env hit — prevents double-counting with NEE
				const envMisWeight = float( 1.0 ).toVar();
				If( isBackdropView.not().and( useEnvMapIS ), () => {

					const prevBouncePdf = readRayPdf( rayBufferRW, rayID );
					If( prevBouncePdf.greaterThan( 0.0 ), () => {

						const envEval = sampleEquirect(
							envTexture, direction, envMatrix, envTotalSum, envCompensationDelta, envResolution,
						);
						const envPdf = envEval.w;
						If( envPdf.greaterThan( 0.0 ), () => {

							envMisWeight.assign( balanceHeuristic( { pdf1: prevBouncePdf, pdf2: envPdf } ) ); // megakernel parity (PathTracerCore.js:774): env NEE also uses balance

						} );

					} );

				} );

				const envGiScale = select( isBackdropView.not(), globalIlluminationIntensity, float( 1.0 ) );
				const envScale = select( isBackdropView, backgroundIntensity, envMisWeight.mul( envGiScale ) );

				// Firefly-suppress the env contribution (megakernel parity: PathTracerCore.js:780). Without
				// this, indirect bounces escaping to a bright environment are unsuppressed spikes that OIDN
				// smears into white blobs. The miss branch Return()s before the hit-branch clamp (~line 712),
				// so it must be applied here.
				// Firefly path length: a backdrop view (incl. through alpha-cutout holes) is a DIRECT view of the
				// sky → use 0 (loosest clamp, same as the open-sky bounce-0 backdrop) so a bright HDRI sun doesn't
				// read dimmer behind foliage cutouts than beside them. Only redirected GI bounces get the tighter
				// path-length threshold.
				const fireflyPathLen = select( isBackdropView, float( 0.0 ), float( bounceIndex ) );
				currentRadiance.assign( vec4(
					currentRadiance.xyz.add(
						regularizePathContribution(
							throughput.mul( envColor ).mul( envScale ),
							fireflyPathLen, fireflyThreshold, int( frame ),
						),
					),
					currentRadiance.w
				) );

			} );

			// Solid-color backdrop ('color' mode): a primary ray that doesn't show the env image and isn't
			// transparent fills with backgroundColor (default black). Tinted by throughput so it reads
			// correctly behind colored glass, matching the env-backdrop path.
			If( isBackdropView.and( showBackground.not() ).and( transparentBackground.not() ), () => {

				currentRadiance.assign( vec4(
					currentRadiance.xyz.add( throughput.mul( backgroundColor ) ),
					currentRadiance.w
				) );

			} );

			// Transparent-bg alpha: see-through only if the ray escaped WITHOUT ever hitting opaque
			// geometry (megakernel parity: PathTracerCore.js:784). A secondary bounce off an opaque
			// surface that escapes to env keeps alpha 1 (HAS_HIT_OPAQUE set), so glass-in-front-of-an-
			// object stays opaque while glass-in-front-of-sky exports see-through.
			If( transparentBackground.and( flags.bitAnd( uint( RAY_FLAG.HAS_HIT_OPAQUE ) ).equal( uint( 0 ) ) ), () => {

				currentRadiance.w.assign( 0.0 );

			} );

			// DDFA: a redirected ray (specular chain — glass/mirror) that escaped to the environment without
			// ever committing a surface guide commits the env colour it sees, tinted by the accumulated
			// see-through throughput (red glass over sky → sky×red). Normal = the escaped direction (varies
			// per pixel → OIDN sees structure tracking the refracted view); depth kept at the primary hit.
			// AUX_LOCKED-clear alone means "never committed" — the old black-probe is redundant. A direct
			// backdrop (REDIRECTED clear) keeps Generate's black/far default (regression-safe sky guide).
			If( auxOn
				.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) )
				.and( flags.bitAnd( uint( RAY_FLAG.REDIRECTED ) ).notEqual( uint( 0 ) ) ), () => {

				const gPrev = readGBuffer( gBufferRW, pixelIndex );
				writeGBuffer( gBufferRW, pixelIndex, normalize( direction ), gbDecodeNormalDepth( gPrev ).w, clamp( escapedAuxAlbedo.mul( featCarry ), vec3( 0.0 ), vec3( 1.0 ) ) );

			} );

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			Return();

		} );

		const hitPoint = origin.add( direction.mul( hitDist ) ).toVar();
		const N = normalize( hitNormal ).toVar();

		// medium stack read once here; reused by the transparency block below
		const medStack = readMediumStack( rayBufferRW, rayID );
		const mediumStackDepth = int( medStack.stackDepth ).toVar();
		const mediumStack_ior_1 = medStack.ior1.toVar();
		const mediumStack_ior_2 = medStack.ior2.toVar();
		const mediumStack_ior_3 = medStack.ior3.toVar();
		const transTraversals = int( medStack.transTraversals ).toVar();
		// per-ray locked dispersion wavelength (nm; 0 = achromatic), in medium-stack bits 16-31
		const pathWavelength = float( medStack.wavelength ).toVar();

		// in-medium transport: glass (sigmaS==0) absorbs, subsurface (sigmaS>0) random-walk scatters
		If( mediumStackDepth.greaterThan( 0 ), () => {

			const mSigmaA = readMediumSigmaA( rayBufferRW, rayID ).toVar();
			const sssMed = readSSSMedium( rayBufferRW, rayID );
			const mSigmaS = sssMed.sigmaS.toVar();
			const mG = sssMed.g.toVar();

			If( max( max( mSigmaS.x, mSigmaS.y ), mSigmaS.z ).lessThanEqual( 0.0 ), () => {

				// glass: Beer-Lambert absorption
				const beer = exp( mSigmaA.mul( hitDist ).negate() ).toVar();
				throughput.mulAssign( beer );
				// DDFA: colored-glass volume tints the deferred aux guide by the same absorption.
				If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

					featCarry.mulAssign( beer );

				} );

			} ).Else( () => {

				// subsurface: chromatic collision-distance sampling
				const mSigmaT = mSigmaA.add( mSigmaS );
				const coll = CollisionSample.wrap( sampleChromaticCollision(
					mSigmaT, mSigmaS, throughput, hitDist, rngState,
				) ).toVar();
				throughput.mulAssign( coll.weight );

				If( coll.didScatter, () => {

					// scatter via Henyey-Greenstein, continue as a free bounce off the sssSteps budget
					const xi2 = vec2( RandomValue( rngState ), RandomValue( rngState ) );
					const scatterPoint = origin.add( direction.mul( coll.t ) );
					const newDir = sampleHenyeyGreenstein( direction, mG, xi2 ).toVar();
					sssSteps.addAssign( 1 );

					// terminate walk: step cap or Russian roulette
					const rrP = clamp( max( max( throughput.x, throughput.y ), throughput.z ), 0.02, 1.0 ).toVar();
					const terminate = sssSteps.greaterThanEqual( maxSubsurfaceSteps )
						.or( RandomValue( rngState ).greaterThan( rrP ) ).toVar();

					If( terminate, () => {

						writeRayRadiance( rayBufferRW, rayID, currentRadiance );
						writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
						rngBufferRW.element( rayID ).assign( rngState );
						Return();

					} );

					throughput.divAssign( rrP );

					// free-bounce continuation: ray stays in the same medium, so medium stack + coeffs persist
					// SSS scatter changes direction → no longer the direct backdrop view.
					flags.assign( flags.bitOr( uint( RAY_FLAG.REDIRECTED ) ) );
					writeRayOriginMeta( rayBufferRW, rayID, scatterPoint, cameraDepth, sssSteps, transparentCount );
					writeRayDirFlags( rayBufferRW, rayID, newDir, flags );
					// Free bounce: preserve prevBouncePdf (megakernel leaves it untouched across SSS scatter,
					// PathTracerCore.js:1272 sets it only after an opaque scatter). Writing 1.0 here spuriously
					// fires the next hit's env/emissive MIS, down-weighting SSS-then-env/emitter views.
					writeRayThroughputPdf( rayBufferRW, rayID, throughput, readRayPdf( rayBufferRW, rayID ) );
					writeRayRadiance( rayBufferRW, rayID, currentRadiance );
					rngBufferRW.element( rayID ).assign( rngState );
					Return();

				} );

				// no scatter: reached boundary, fall through to surface handling

			} );

		} );

		const material = RayTracingMaterial.wrap(
			getMaterial( int( hitMatIdx ), materialBuffer )
		).toVar();

		// displacement: analytical ray-height marching refines hitPoint/UV/normal; no-op without a map
		const samplingUV = hitUV.toVar();
		const displacedNormal = N.toVar();
		If(
			material.displacementMapIndex.greaterThanEqual( int( 0 ) )
				.and( material.displacementScale.greaterThan( 0.0 ) ),
			() => {

				const dispRay = Ray( { origin, direction } );
				const dispHit = HitInfo( {
					didHit: true, dst: hitDist, hitPoint, normal: N, uv: hitUV,
					materialIndex: int( hitMatIdx ), meshIndex: int( 0 ),
					triangleIndex: int( hitTriIdx ),
					boxTests: int( 0 ), triTests: int( 0 ),
				} );
				const dispResult = DisplacementResult.wrap( refineDisplacedIntersection(
					dispRay, dispHit, triangleBuffer, material, bounceIndex,
				) ).toVar();
				samplingUV.assign( dispResult.uv );
				displacedNormal.assign( dispResult.normal );
				hitPoint.assign( dispResult.hitPoint );

			}
		);

		const matSamples = MaterialSamples.wrap( sampleAllMaterialTextures(
			material, samplingUV, N,
		) ).toVar();

		// DDFA: snapshot the UNCLAMPED roughness (before the min-0.05 clamp below) for the specular↔diffuse
		// classification, so a perfect mirror reads 0 (fully specular → defers).
		const rawRough = matSamples.roughness.toVar();

		// BRDF functions read material.color/metalness/roughness, so apply samples here
		material.color.assign( matSamples.albedo );
		material.metalness.assign( matSamples.metalness.clamp( 0.0, 1.0 ) );
		material.roughness.assign( matSamples.roughness.clamp( 0.05, 1.0 ) );
		material.sheenRoughness.assign( material.sheenRoughness.clamp( 0.05, 1.0 ) ); // megakernel parity (PathTracerCore.js:1060): sample/PDF mismatch at sheenRoughness~0

		// Anisotropy + extension maps carry no per-slot transform of their own, so reuse the material's
		// albedo UV-transform (KHR_texture_transform). Extension/aniso textures nearly always share the
		// base UV set + transform, so this aligns tiled/offset maps (e.g. SheenCloth's 30× sheen weave)
		// instead of sampling at raw 1× UV. Identity albedo transform → same as raw UV (safe no-op).
		const extUV = getTransformedUV( { uv: samplingUV, transform: material.albedoTransform } ).toVar();

		// Fold the anisotropy texture (if any) into the scalar anisotropy/rotation used by the BRDF
		If( material.anisotropyMapIndex.greaterThanEqual( int( 0 ) ), () => {

			const aniso = processAnisotropyMap( material, extUV ).toVar();
			material.anisotropy.assign( aniso.x );
			material.anisotropyRotation.assign( aniso.y );

		} );

		// Fold the glTF extension textures (transmission/clearcoat/sheen/iridescence/specular) into
		// their scalar factors. `material` is the shared mutable struct that flows into BOTH the
		// BRDF-sample path and the NEE evaluator, so modulating here covers every consumer at once.
		const extMaps = ExtMapResult.wrap( applyExtensionMaps( material, extUV ) ).toVar();
		material.transmission.assign( extMaps.transmission );
		material.clearcoat.assign( extMaps.clearcoat );
		material.clearcoatRoughness.assign( extMaps.clearcoatRoughness );
		material.sheenColor.assign( extMaps.sheenColor );
		material.sheenRoughness.assign( extMaps.sheenRoughness );
		material.iridescence.assign( extMaps.iridescence );
		material.iridescenceThicknessRange.assign( vec2( material.iridescenceThicknessRange.x, extMaps.iridescenceThickness ) );
		material.specularIntensity.assign( extMaps.specularIntensity );
		material.specularColor.assign( extMaps.specularColor );

		const albedo = matSamples.albedo.toVar();
		If(
			material.displacementMapIndex.greaterThanEqual( int( 0 ) )
				.and( material.displacementScale.greaterThan( 0.0 ) ),
			() => {

				N.assign( normalize( displacedNormal.add( matSamples.normal.sub( normalize( hitNormal ) ) ) ) );

			}
		).Else( () => {

			N.assign( matSamples.normal );

		} );

		// ─── DDFA classification (Cycles smoothstep-by-roughness, not a hard binary) ───
		// nonspec fraction over a 2-pseudo-closure model: a Lambert closure (weight 1-metal, fully diffuse)
		// + a glossy/glass closure (weight metal·(1-trans)+trans, classified by roughness). Commit the aux at
		// the first surface with a meaningful diffuse response (nonspec≥0.25); smooth glass/mirror defers.
		// featPrefix = the tint accumulated BEFORE this surface (read-only for this bounce's commits).
		const metal = material.metalness.toVar();
		const trans = material.transmission.toVar();
		const roughFrac = smoothstep( float( 0.0 ), float( 0.15 ), rawRough ).toVar();
		const auxCommit = clamp(
			float( 1.0 ).sub( metal ).mul( float( 1.0 ).sub( trans ) )
				.add( roughFrac.mul( metal.mul( float( 1.0 ).sub( trans ) ).add( trans ) ) ),
			0.0, 1.0,
		).greaterThanEqual( float( 0.25 ) ).toVar();
		const featPrefix = featCarry.toVar();

		// DDFA terminal fallback: a ray dying while still deferring (e.g. a mirror maze) commits its last
		// surface instead of leaving a black guide OIDN would demod-amplify.
		// Plain JS inliner, not an Fn — it closes over albedo/featPrefix/flags .toVar()s.
		const commitDeferredAux = ( normal ) => {

			If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

				const primaryDepth = gbDecodeNormalDepth( readGBuffer( gBufferRW, pixelIndex ) ).w;
				writeGBuffer( gBufferRW, pixelIndex, normal, primaryDepth, clamp( albedo.mul( featPrefix ), vec3( 0.0 ), vec3( 1.0 ) ) );

			} );

		};

		// Deactivate the ray, keeping the radiance already gathered at this vertex.
		const terminatePath = () => {

			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeRayDirFlags( rayBufferRW, rayID, direction, flags.bitAnd( uint( ~ RAY_FLAG.ACTIVE ) ) );
			rngBufferRW.element( rayID ).assign( rngState );

		};

		// first-hit MRT data (bounce 0 only): write the primary DEPTH now with the default normal/albedo.
		// The real normal/albedo are committed by the DDFA decision blocks below (which re-pack this depth);
		// they may defer through smooth glass/mirror and commit at the first diffuse-enough surface or the env.
		If( bounceIndex.equal( 0 ).and( auxOn ), () => {

			const linearDepth = computeNDCDepth( {
				worldPos: hitPoint,
				cameraProjectionMatrix,
				cameraViewMatrix,
			} );
			writeGBuffer( gBufferRW, pixelIndex, vec3( 0.0, 0.0, 1.0 ), linearDepth, vec3( 0.0 ) );

		} );

		// transparency / refraction (medium stack + wavelength read at the hit, above)
		const currentMediumIOR = float( 1.0 ).toVar();
		const previousMediumIOR = float( 1.0 ).toVar();
		If( mediumStackDepth.equal( 1 ), () => {

			currentMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( 2 ), () => {

			currentMediumIOR.assign( mediumStack_ior_2 );
			previousMediumIOR.assign( mediumStack_ior_1 );

		} ).ElseIf( mediumStackDepth.equal( 3 ), () => {

			currentMediumIOR.assign( mediumStack_ior_3 );
			previousMediumIOR.assign( mediumStack_ior_2 );

		} );

		const currentRay = Ray( { origin, direction } );
		const interaction = MaterialInteractionResult.wrap( handleMaterialTransparency(
			currentRay, N, material, rngState,
			int( transTraversals ),
			currentMediumIOR, previousMediumIOR,
			pathWavelength,
		) ).toVar();

		// persist any wavelength locked on a fresh dispersive transmission; identity write otherwise
		pathWavelength.assign( interaction.pathWavelength );

		// ─── DDFA aux decision at a transmissive / alpha / SSS interaction. Runs for BOTH the continuing and
		// the BLEND fall-through paths, so it sits before If(continueRay). If/ElseIf chaining so BLEND wins
		// over the transmission branch (fixes the BLEND-glass per-frame flicker + the BLEND+transmission case). ───
		If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

			const primaryDepth = gbDecodeNormalDepth( readGBuffer( gBufferRW, pixelIndex ) ).w;
			// N here is the mapped normal — faceforward it (a ray exiting glass sees a back-facing N).
			const Nff = select( dot( N, direction.negate() ).lessThan( 0.0 ), N.negate(), N ).toVar();
			const auxAlbedo = clamp( albedo.mul( featPrefix ), vec3( 0.0 ), vec3( 1.0 ) ).toVar();

			If( material.alphaMode.equal( int( 2 ) ), () => {

				// BLEND: deterministic own-surface commit on BOTH stochastic skip + shade frames (no flicker).
				writeGBuffer( gBufferRW, pixelIndex, Nff, primaryDepth, auxAlbedo );
				flags.assign( flags.bitOr( uint( RAY_FLAG.AUX_LOCKED ) ) );

			} ).ElseIf( interaction.isAlphaSkip, () => {

				// MASK cutout passthrough: keep deferring, tint unchanged (backdrop through the hole commits later).

			} ).ElseIf( interaction.isSubsurface, () => {

				// SSS boundary: force-commit the skin surface as diffuse.
				writeGBuffer( gBufferRW, pixelIndex, Nff, primaryDepth, auxAlbedo );
				flags.assign( flags.bitOr( uint( RAY_FLAG.AUX_LOCKED ) ) );

			} ).ElseIf( interaction.isTransmissive, () => {

				If( auxCommit.or( material.dispersion.greaterThan( 0.0 ) ), () => {

					// frosted / rough / dispersive glass: commit its own surface (deterministic per frame).
					writeGBuffer( gBufferRW, pixelIndex, Nff, primaryDepth, auxAlbedo );
					flags.assign( flags.bitOr( uint( RAY_FLAG.AUX_LOCKED ) ) );

				} ).Else( () => {

					// smooth glass: DEFER — tint by the glass colour (matches the transmission throughput,
					// which multiplies material.color at both reflect and refract; achromatic eta²/Fr excluded).
					featCarry.mulAssign( clamp( albedo, vec3( 0.0 ), vec3( 1.0 ) ) );

				} );

			} );
			// else (opaque non-skip): the opaque decision block below handles it (needs the viewer-facing N).

		} );

		If( interaction.continueRay, () => {

			// update medium stack for transmission (not reflection/TIR)
			If( interaction.isTransmissive.and( interaction.didReflect.not() ), () => {

				If( interaction.entering, () => {

					If( mediumStackDepth.lessThan( 3 ), () => {

						mediumStackDepth.addAssign( 1 );
						If( mediumStackDepth.equal( 1 ), () => {

							mediumStack_ior_1.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 2 ), () => {

							mediumStack_ior_2.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 3 ), () => {

							mediumStack_ior_3.assign( material.ior );

						} );

						// precompute Beer-Lambert sigmaA once at enter
						writeMediumSigmaA( rayBufferRW, rayID, select(
							material.attenuationDistance.greaterThan( 0.0 ),
							log( max( material.attenuationColor, vec3( 0.001 ) ) ).negate().div( material.attenuationDistance ),
							vec3( 0.0 ),
						) );
						// sigmaS==0 marks glass → in-medium block takes the Beer-Lambert path, not SSS walk
						writeSSSMedium( rayBufferRW, rayID, vec3( 0.0 ), float( 0.0 ) );

					} );

				} ).Else( () => {

					If( mediumStackDepth.greaterThan( 0 ), () => {

						mediumStackDepth.subAssign( 1 );

					} );

				} );

			} );

			// subsurface boundary: push the scattering medium on enter, pop on exit; free bounce
			If( interaction.isSubsurface.and( interaction.didReflect.not() ), () => {

				If( interaction.entering, () => {

					If( mediumStackDepth.lessThan( 3 ), () => {

						mediumStackDepth.addAssign( 1 );
						If( mediumStackDepth.equal( 1 ), () => {

							mediumStack_ior_1.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 2 ), () => {

							mediumStack_ior_2.assign( material.ior );

						} );
						If( mediumStackDepth.equal( 3 ), () => {

							mediumStack_ior_3.assign( material.ior );

						} );

						const ssCoeffs = MediumCoeffs.wrap( subsurfaceCoefficients(
							material.subsurfaceColor, material.subsurfaceRadius, material.subsurfaceRadiusScale,
						) ).toVar();
						// Store extinction−scattering (un-clamped) so the SSS read reconstructs the true sigmaT=1/r
						// (mSigmaA+mSigmaS); the clamped ssCoeffs.sigmaA loses it when subsurfaceColor>1. Equals sigmaA for color≤1.
						writeMediumSigmaA( rayBufferRW, rayID, ssCoeffs.sigmaT.sub( ssCoeffs.sigmaS ) );
						writeSSSMedium( rayBufferRW, rayID, ssCoeffs.sigmaS, clamp( material.subsurfaceAnisotropy, - 0.99, 0.99 ) );

					} );

				} ).Else( () => {

					If( mediumStackDepth.greaterThan( 0 ), () => {

						mediumStackDepth.subAssign( 1 );

					} );

				} );

			} );

			If( interaction.isTransmissive.and( transTraversals.greaterThan( 0 ) ), () => {

				transTraversals.subAssign( 1 );

			} );

			throughput.mulAssign( interaction.throughput );

			// reflection stays on same side, transmission pushes through
			const reflectOffsetDir = select( interaction.entering, N, N.negate() );
			const offsetDir = select( interaction.didReflect, reflectOffsetDir, direction );
			const newOrigin = hitPoint.add( offsetDir.mul( 0.001 ) );

			// SSS = free bounce (depth unchanged); transmission advances camera-bounce depth.
			// Transmissive / alpha-skip / SSS-boundary are all FREE bounces — they do NOT advance camera depth (megakernel parity, gap #4). cameraDepth advances only on opaque scatter (below).
			// Backdrop-view survives a pure alpha/transparent passthrough (direction unchanged) but is cleared by
			// any redirection (refraction/reflection/SSS boundary), so env through a leaf hole stays the blurred
			// backdrop while env through glass becomes sharp redirected light.
			If( interaction.isAlphaSkip.not(), () => {

				flags.assign( flags.bitOr( uint( RAY_FLAG.REDIRECTED ) ) );

			} ).Else( () => {

				// Alpha passthrough: charge the guard. N is faceforwarded for the aux commit (a ray
				// exiting a back-facing skip would otherwise write an inverted normal).
				transparentCount.addAssign( 1 );
				If( transparentCount.greaterThan( maxTransparentBounces ), () => {

					commitDeferredAux( select( dot( N, direction.negate() ).lessThan( 0.0 ), N.negate(), N ) );
					terminatePath();
					Return();

				} );

			} );
			writeRayOriginMeta( rayBufferRW, rayID, newOrigin, cameraDepth, sssSteps, transparentCount );
			writeRayDirFlags( rayBufferRW, rayID, interaction.direction, flags );
			// Free bounce: preserve prevBouncePdf (megakernel keeps the last opaque-scatter pdf across
			// transmission/alpha-skip/SSS-boundary). Writing 1.0 corrupts the next bounce's env/emissive MIS,
			// down-weighting environment/emitters seen through glass.
			writeRayThroughputPdf( rayBufferRW, rayID, throughput, readRayPdf( rayBufferRW, rayID ) );
			writeRayRadiance( rayBufferRW, rayID, currentRadiance );
			writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
			// DDFA: persist the (possibly tinted) see-through throughput for the next bounce. MUST run after
			// the writeMediumSigmaA above — both RMW slot 5 (sigmaA.xyz / featTP.w). Gated AUX_LOCKED-clear.
			If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

				writeFeatureThroughput( rayBufferRW, rayID, featCarry );

			} );
			rngBufferRW.element( rayID ).assign( rngState );
			Return();

		} );

		// Past the transparency block ⇒ the ray hit non-transmissive geometry (megakernel parity:
		// PathTracerCore.js:1042). Flag the chain so a later env-escape keeps alpha 1 (the gate in the
		// miss branch). Alpha itself already defaults to 1 from Generate in transparent-bg mode, so there
		// is nothing to set here — a ray dying inside geometry (SSS walk) stays solid without reaching this.
		// Hit opaque geometry: set HAS_HIT_OPAQUE and mark REDIRECTED (this is a real surface scatter,
		// so any later env-escape is redirected light, not the direct backdrop). Single positive bitOr.
		flags.assign( flags.bitOr( uint( RAY_FLAG.HAS_HIT_OPAQUE | RAY_FLAG.REDIRECTED ) ) );

		const emissive = matSamples.emissive.toVar();
		If( length( emissive ).greaterThan( 0.0 ), () => {

			// Key on backdrop-view (not bounceIndex>0) so an emitter seen DIRECTLY through an alpha-cutout hole
			// renders at full intensity (1.0) like a direct view, consistent with env-through-hole — instead of
			// being GI-scaled as if it were an indirect bounce. (MIS below already self-guards via prevBouncePdf.)
			const emissiveGiScale = select( isBackdropView.not(), globalIlluminationIntensity, float( 1.0 ) );

			// MIS weight vs emissive-triangle NEE (megakernel parity: PathTracerCore.js:1117). On a secondary
			// hit (bounceIndex>0) the prior bounce's NEE also sampled this emitter — power-heuristic balances the
			// two estimators. Without it emissive geometry / area lights double-count (~2x bright + noisier).
			// Primary hits keep weight 1.0 (the wavefront's bounce-0 stored pdf is the Generate init, not a NEE pdf).
			const emissiveMISWeight = float( 1.0 ).toVar();
			if ( useEmissiveNEE ) {

				If( enableEmissiveTriangleSampling.equal( int( 1 ) )
					.and( emissiveTriangleCount.greaterThan( int( 0 ) ) )
					.and( bounceIndex.greaterThan( 0 ) ), () => {

					const prevBouncePdf = readRayPdf( rayBufferRW, rayID );
					If( prevBouncePdf.greaterThan( 0.0 ), () => {

						// MIS partner pdf MUST match the actual NEE sampler: re-walk the Light BVH descent
						// when it is active, else use the flat-CDF pdf. Mismatching them breaks MIS
						// partition-of-unity → a real bias (see calculateLightBVHPdf).
						const lightPdf = float( 0.0 ).toVar();
						If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

							lightPdf.assign( calculateLightBVHPdf(
								int( hitTriIdx ), hitDist, direction, origin,
								lightBuffer, emissiveVec4Offset, reverseMapVec4Offset, triangleBuffer,
							) );

						} ).Else( () => {

							lightPdf.assign( calculateEmissiveLightPdf(
								int( hitTriIdx ), hitDist, direction, origin,
								triangleBuffer, materialBuffer, emissiveTotalPower,
							) );

						} );
						emissiveMISWeight.assign( powerHeuristic( { pdf1: prevBouncePdf, pdf2: lightPdf } ) );

					} );

				} );

			}

			currentRadiance.assign( vec4(
				currentRadiance.xyz.add(
					regularizePathContribution(
						emissive.mul( throughput ).mul( emissiveGiScale ).mul( emissiveMISWeight ),
						float( bounceIndex ), fireflyThreshold, int( frame ),
					),
				),
				currentRadiance.w
			) );

		} );

		// BRDF sample (needed by both direct + indirect)
		const V = direction.negate().toVar();

		// Two-sided shading: opaque path only (transmissive/SSS already continued), so this never disturbs
		// dielectric enter/exit. Flip N toward the viewer when back-facing — rescues double-sided / inward-
		// normal imported meshes (GLB/PBRT) that otherwise shade black (NoL collapses). Megakernel: PathTracerCore.js:1054.
		If( dot( N, V ).lessThan( 0.0 ), () => {

			N.assign( N.negate() );

		} );

		// ─── DDFA opaque aux decision: commit at the first diffuse-enough surface, defer through smooth
		// mirror/metal so the guide describes what the mirror reflects, not the mirror itself. N is already
		// viewer-facing (two-sided flip above); depth read back + re-packed (idempotent snorm — no drift). ───
		If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

			const primaryDepth = gbDecodeNormalDepth( readGBuffer( gBufferRW, pixelIndex ) ).w;
			If( auxCommit, () => {

				// diffuse / glossy / rough-metal: commit the surface guide, tinted by the see-through prefix.
				writeGBuffer( gBufferRW, pixelIndex, N, primaryDepth, clamp( albedo.mul( featPrefix ), vec3( 0.0 ), vec3( 1.0 ) ) );
				flags.assign( flags.bitOr( uint( RAY_FLAG.AUX_LOCKED ) ) );

			} ).Else( () => {

				// smooth mirror / metal: DEFER — tint by the specular directional albedo (metal colour),
				// matching the opaque throughput (≈ F at the near-delta mirror lobe). Achromatic energy excluded.
				const NoV = max( dot( N, V ), float( 1e-3 ) );
				const F0 = clamp(
					mix( dielectricF0( material.ior ).mul( material.specularColor ), albedo, material.metalness ).mul( material.specularIntensity ),
					vec3( 0.0 ), vec3( 1.0 ),
				);
				featCarry.mulAssign( DFGResult.wrap( evaluateDFG( F0, NoV, max( rawRough, float( 0.02 ) ) ) ).E_total );

			} );

		} );

		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive, material.subsurface,
		) ).toVar();

		// STBN keyed on (GLOBAL pixel, bounceIndex, frame). pixelIndex is the LOCAL path slot; the global pixel
		// = chunkRowBase·W + localSlot, so the blue-noise pattern stays spatially aligned across row-band chunks
		// (and matches Generate's per-pixel RNG seed). chunkRowBase is 0 in the single-chunk case.
		const _resX = int( resolution.x ).toVar();
		const _globalPixel = int( pixelIndex ).add( chunkRowBase.mul( _resX ) );
		const _pixelCoord = vec2(
			float( _globalPixel.mod( _resX ) ).add( 0.5 ),
			float( _globalPixel.div( _resX ) ).add( 0.5 ),
		);
		const xi = getRandomSample( _pixelCoord, int( 0 ), bounceIndex, rngState, int( - 1 ), resolution, frame ).toVar();
		const emptyWeights = BRDFWeights( {
			specular: float( 0.0 ), diffuse: float( 0.0 ), sheen: float( 0.0 ),
			clearcoat: float( 0.0 ), transmission: float( 0.0 ), iridescence: float( 0.0 ),
		} );
		// unused (materialCacheCached=false), but must match the 11-field struct shape to construct
		const emptyCache = MaterialCache( {
			F0: vec3( 0.04 ), NoV: float( 1.0 ),
			diffuseColor: vec3( 0.0 ), isPurelyDiffuse: false,
			alpha: float( 0.0 ), k: float( 0.0 ), alpha2: float( 0.0 ),
			invRoughness: float( 0.5 ), metalFactor: float( 0.5 ),
			iorFactor: float( 0.67 ), maxSheenColor: float( 0.0 ),
		} );

		const brdfDir = vec3( 0.0 ).toVar();
		const brdfValue = vec3( 0.0 ).toVar();
		const brdfPdf = float( 0.0 ).toVar();

		If( material.clearcoat.greaterThan( 0.0 ), () => {

			const ccRay = Ray( { origin, direction } );
			const ccHit = HitInfo( {
				didHit: true, dst: hitDist, hitPoint, normal: N, uv: hitUV,
				materialIndex: int( hitMatIdx ), meshIndex: int( 0 ),
				triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
			} );
			const ccResult = ClearcoatResult.wrap( sampleClearcoat(
				ccRay, ccHit, material, xi, rngState,
			) );
			brdfDir.assign( ccResult.L );
			brdfValue.assign( ccResult.brdf );
			brdfPdf.assign( ccResult.pdf );

		} ).Else( () => {

			const bs = DirectionSample.wrap( generateSampledDirection(
				V, N, material, xi, rngState,
				mc,
				false, emptyWeights,
				false, emptyCache,
			) );
			brdfDir.assign( bs.direction );
			brdfValue.assign( bs.value );
			brdfPdf.assign( bs.pdf );

		} );

		const directLight = DirectLightingDual.wrap( calculateDirectLightingUnified(
			hitPoint, N, material, V,
			brdfDir, brdfPdf, brdfValue,
			bounceIndex, rngState,
			directionalLightsBuffer, numDirectionalLights,
			areaLightsBuffer, numAreaLights,
			pointLightsBuffer, numPointLights,
			spotLightsBuffer, numSpotLights,
			bvhBuffer, triangleBuffer, materialBuffer,
			envTexture, environmentIntensity, envMatrix,
			envCDFTexture,
			envTotalSum, envCompensationDelta, envResolution,
			enableEnvironmentLight,
			tslBool( false ), // wantUnoccluded: false on real surfaces — dead-codes the unoccluded sum
		) ).shadowed.toVar();

		const giScale = select( bounceIndex.greaterThan( 0 ), globalIlluminationIntensity, float( 1.0 ) );
		// Per-term firefly suppression (megakernel parity: PathTracerCore.js:1164) — wrap the direct-light add
		// like every other contribution (env/emissive-hit/emissive-NEE). This replaces the cumulative catch-all
		// that re-suppressed already-wrapped terms + prior-bounce radiance — suppress(a+b) ≠ suppress(a)+suppress(b) (gap #13).
		currentRadiance.assign( vec4(
			currentRadiance.xyz.add(
				regularizePathContribution(
					throughput.mul( directLight ).mul( giScale ),
					float( bounceIndex ), fireflyThreshold, int( frame ),
				),
			),
			currentRadiance.w
		) );

		// emissive triangle NEE: light-BVH fast path when available, flat-CDF fallback otherwise
		if ( useEmissiveNEE ) {

			If(
				enableEmissiveTriangleSampling.equal( int( 1 ) )
					.and( emissiveTriangleCount.greaterThan( int( 0 ) ) ),
				() => {

					// closes over scene buffers for the inner shadow-trace callback
					const traceShadowRayWrapped = Fn( ( [ origin, dir, maxDist ] ) => {

						return traceShadowRay(
							origin, dir, maxDist,
							traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
						);

					} );

					If( lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

						const emissiveSample = EmissiveSample.wrap( sampleLightBVHTriangle(
							hitPoint, N,
							rngState,
							lightBuffer,
							lightBuffer,
							emissiveVec4Offset,
							triangleBuffer,
						) );

						// skip rough diffuse surfaces on secondary bounces
						const skip = bounceIndex.greaterThan( int( 1 ) )
							.and( material.roughness.greaterThan( 0.9 ) )
							.and( material.metalness.lessThan( 0.1 ) );

						If( skip.not().and( emissiveSample.valid ).and( emissiveSample.pdf.greaterThan( 0.0 ) ), () => {

							const NoL = max( float( 0.0 ), dot( N, emissiveSample.direction ) );

							If( NoL.greaterThan( 0.0 ), () => {

								const rayOffset = calculateRayOffset( hitPoint, N, material );
								const rayOrigin = hitPoint.add( rayOffset );
								const shadowDist = emissiveSample.distance.sub( 0.001 );
								const visibility = traceShadowRayWrapped(
									rayOrigin, emissiveSample.direction, shadowDist,
								);

								If( visibility.greaterThan( 0.0 ), () => {

									const brdfVal = evaluateMaterialResponse( V, emissiveSample.direction, N, material );
									const bPdf = calculateMaterialPDF( V, emissiveSample.direction, N, material );
									const misW = select(
										bPdf.greaterThan( 0.0 ),
										powerHeuristic( { pdf1: emissiveSample.pdf, pdf2: bPdf } ),
										float( 1.0 ),
									);

									const emissiveLight = emissiveSample.emission
										.mul( brdfVal ).mul( NoL )
										.div( emissiveSample.pdf )
										.mul( visibility ).mul( emissiveBoost ).mul( misW );

									currentRadiance.assign( vec4(
										currentRadiance.xyz.add(
											regularizePathContribution(
												emissiveLight.mul( throughput ).mul( giScale ),
												float( bounceIndex ), fireflyThreshold, int( frame ),
											),
										),
										currentRadiance.w,
									) );

								} );

							} );

						} );

					} ).Else( () => {

						const emissiveLight = calculateEmissiveTriangleContribution(
							hitPoint, N, V, material,
							bounceIndex, rngState,
							emissiveBoost,
							lightBuffer, emissiveVec4Offset, emissiveTriangleCount, emissiveTotalPower,
							triangleBuffer,
							traceShadowRayWrapped,
							calculateRayOffset,
						);

						currentRadiance.assign( vec4(
							currentRadiance.xyz.add(
								regularizePathContribution(
									emissiveLight.mul( throughput ).mul( giScale ),
									float( bounceIndex ), fireflyThreshold, int( frame ),
								),
							),
							currentRadiance.w,
						) );

					} );

				},
			);

		}

		// (gap #13) No cumulative catch-all here: every radiance contribution above is now firefly-suppressed
		// per-term (env / emissive-hit / direct-light / emissive-NEE), matching the megakernel which never
		// re-suppresses the running radiance.

		const samplingInfo = ImportanceSamplingInfo.wrap( getImportanceSamplingInfo(
			material, bounceIndex, mc,
		) ).toVar();

		const indirectResult = IndirectLightingResult.wrap( calculateIndirectLighting(
			V, N, material,
			brdfDir, brdfPdf, brdfValue,
			rngState, samplingInfo,
		) ).toVar();

		const bounceDir = indirectResult.direction.toVar();
		// combinedPdf is stored as next bounce's prevBouncePdf for NEE↔implicit-env MIS
		const bouncePdf = max( indirectResult.combinedPdf, 0.001 ).toVar();
		throughput.mulAssign( indirectResult.throughput );

		// Adaptive Russian roulette (gap #7) — material-importance + throughput + env-direction aware, replacing
		// the flat clamp(maxThroughput,0.05,0.95). depth = bounceIndex (path length, per gap #4); rayDirection =
		// the continuation dir (bounceDir) for env-facing importance. Returns survival prob (compensated) or 0 to
		// terminate. Subsumes the old compensated low-throughput kill (#12). Unbiased; just terminates smarter.
		const rrSurvival = handleRussianRoulette(
			bounceIndex, throughput, mc, bounceDir, rngState,
			enableEnvironmentLight, useEnvMapIS,
		).toVar();
		If( rrSurvival.lessThanEqual( 0.0 ), () => {

			commitDeferredAux( N );
			terminatePath();
			Return();

		} );
		throughput.divAssign( rrSurvival );

		// Terminate on CAMERA depth (opaque scatter count), not path length — glass/SSS free bounces no longer burn the maxBounces budget (gap #4).
		If( cameraDepth.greaterThanEqual( maxBounceCount ), () => {

			commitDeferredAux( N );
			terminatePath();
			Return();

		} );

		const newOrigin = hitPoint.add( N.mul( 0.001 ) );

		// Opaque scatter: the only bounce that advances camera depth.
		writeRayOriginMeta( rayBufferRW, rayID, newOrigin, cameraDepth.add( 1 ), sssSteps, transparentCount );
		writeRayDirFlags( rayBufferRW, rayID, bounceDir, flags );
		writeRayThroughputPdf( rayBufferRW, rayID, throughput, bouncePdf );
		writeRayRadiance( rayBufferRW, rayID, currentRadiance );
		writeMediumStack( rayBufferRW, rayID, uint( mediumStackDepth ), uint( transTraversals ), mediumStack_ior_1, mediumStack_ior_2, mediumStack_ior_3, uint( pathWavelength.add( 0.5 ) ) );
		// DDFA: persist the (possibly mirror-tinted) see-through throughput for the next bounce.
		If( auxOn.and( flags.bitAnd( uint( RAY_FLAG.AUX_LOCKED ) ).equal( uint( 0 ) ) ), () => {

			writeFeatureThroughput( rayBufferRW, rayID, featCarry );

		} );
		rngBufferRW.element( rayID ).assign( rngState );

	} );

	return computeFn;

}

export { WG_SIZE as SHADE_WG_SIZE };
