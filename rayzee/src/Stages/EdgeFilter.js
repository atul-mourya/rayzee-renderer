import { Fn, vec3, vec4, float, int, uint, ivec2, uvec2, uniform,
	If, dot, max, mix, pow, sqrt, select,
	textureLoad, textureStore, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { FloatType, RGBAFormat, LinearFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { luminance } from '../TSL/Common.js';
import { ALBEDO_EPS, MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';

// NormalDepth writes depth ≈ 65504 for miss (env/background) rays. This sits below
// the sentinel and above any real ray distance, so it's a clean hit/miss flag.
const MISS_THRESHOLD = 6e4;

// NaN/±Inf guard on demodulated lighting: dividing color by a near-zero albedo can
// blow up, and one poisoned tap would smear through the à-trous passes. Per-channel:
// NaN (x≠x) → 0, ±Inf clamped to a bounded HDR range. Ceiling matches ASVGF/Variance
// (1e7); the FloatType ping-pong textures hold it without HalfFloat's 65k clip.
const sanitize1 = ( x ) => select( x.equal( x ), x, float( 0.0 ) ).clamp( 0.0, 1e7 );
const sanitizeRGB = ( c ) => vec3( sanitize1( c.x ), sanitize1( c.y ), sanitize1( c.z ) );

// 5×5 à-trous kernel weights (B3-spline / Gaussian approx, Σ = 1.0).
const ATROUS_KERNEL = [
	1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
	4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
	6.0 / 256.0, 24.0 / 256.0, 36.0 / 256.0, 24.0 / 256.0, 6.0 / 256.0,
	4.0 / 256.0, 16.0 / 256.0, 24.0 / 256.0, 16.0 / 256.0, 4.0 / 256.0,
	1.0 / 256.0, 4.0 / 256.0, 6.0 / 256.0, 4.0 / 256.0, 1.0 / 256.0,
];

/**
 * WebGPU Edge-Aware Filtering Stage (Compute Shader).
 *
 * A spatial-only SVGF à-trous denoiser (Dammertz 2010 + Schied 2017 edge-stops)
 * that runs directly on the progressively-accumulated frame — no temporal
 * reprojection, motion vectors, or history buffers, so it is free of the
 * ghosting/lag artefacts of the ASVGF chain. Intended for static-camera
 * progressive rendering where a light, artefact-free spatial filter is wanted.
 *
 * Pipeline per frame:
 *   1. Demodulate: lighting = color / albedo (miss rays use a neutral albedo so
 *      bright HDR sky neither overflows the divide nor gets zeroed on remodulate).
 *   2. À-trous: `iterations` ping-pong passes with step size 2^i over a dense
 *      5×5 Gaussian kernel, growing the effective footprint to tens of pixels.
 *      Edge-stops: variance-guided luminance σ (from variance:output), a
 *      shading-normal cone, and a scale-invariant relative depth gate.
 *   3. Remodulate + strength blend on the final pass.
 *
 * Reads:     pathtracer:color, pathtracer:normalDepth, pathtracer:shadingNormal,
 *            pathtracer:albedo, variance:output
 * Publishes: edgeFiltering:output
 * Mode:      PER_CYCLE
 */
export class EdgeFilter extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'EdgeAwareFiltering', {
			...options,
			executionMode: StageExecutionMode.PER_CYCLE
		} );

		this.renderer = renderer;

		// filterStrength: final blend, 0 = raw color, 1 = fully filtered.
		// phiLuminance: variance-scaled luminance edge-stop (bigger = more blending).
		// phiNormal:    normal cone exponent (bigger = tighter, preserves more edges).
		// phiDepth:     RELATIVE depth tolerance (fraction of ray distance, scale-invariant).
		this.filterStrength = uniform( options.filterStrength ?? 1.0 );
		this.phiLuminance = uniform( options.phiLuminance ?? 4.0 );
		this.phiNormal = uniform( options.phiNormal ?? 64.0 );
		this.phiDepth = uniform( options.phiDepth ?? 0.1 );
		this.iterations = options.atrousIterations ?? options.edgeAtrousIterations ?? 5;

		this.stepSizeU = uniform( 1, 'int' );
		this.isLastIterationU = uniform( 0, 'int' );
		// 1 on pass 0 → seed variance from variance:output; later passes read the carried value.
		this.isFirstIterationU = uniform( 1, 'int' );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture nodes (RenderTarget-backed — safe to bind pre-compile).
		this._colorTexNode = new TextureNode();
		this._ndTexNode = new TextureNode();
		this._snTexNode = new TextureNode();
		this._albedoTexNode = new TextureNode();
		this._varTexNode = new TextureNode();

		// À-trous read node: defaults to EmptyTexture at compile time so the WGSL
		// codegen emits the `level` parameter required for later StorageTexture reads.
		this._readTexNode = new TextureNode();

		const w = options.width || 1;
		const h = options.height || 1;

		// Pre-allocate StorageTextures at max — defensive against three.js #33061
		// (TSL compute pipeline keeps a stale GPUTextureView after setSize()).
		// LinearFilter required for textureLoad codegen on StorageTextures.
		this._demodTex = this._makeStorageTex(); // demodulated lighting (pre-pass output)
		this._storageTexA = this._makeStorageTex(); // à-trous ping
		this._storageTexB = this._makeStorageTex(); // à-trous pong

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Active-size RT published downstream (UV-sampled); the over-allocated
		// StorageTexture must not be published — UV sampling reads the wrong region.
		// FloatType to match the storage textures so copyTextureToTexture is format-compatible.
		this.outputTarget = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._compiled = false;

		this._dispatchX = Math.ceil( w / 16 );
		this._dispatchY = Math.ceil( h / 16 );

		this._buildCompute();

	}

	_makeStorageTex() {

		// FloatType: demodulated lighting on dark materials (color / 0.01) exceeds
		// HalfFloat's 65k cap on HDR — same reason ASVGF's ping-pong is FloatType.
		const tex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		tex.type = FloatType;
		tex.format = RGBAFormat;
		tex.minFilter = LinearFilter;
		tex.magFilter = LinearFilter;
		return tex;

	}

	_buildCompute() {

		this._computeDemod = this._buildDemod();
		// One à-trous node per ping-pong write direction.
		this._computeAtrousA = this._buildAtrous( this._storageTexA );
		this._computeAtrousB = this._buildAtrous( this._storageTexB );

	}

	// Demodulate pass: lighting = color / albedo, written to _demodTex.
	_buildDemod() {

		const colorTex = this._colorTexNode;
		const ndTex = this._ndTexNode;
		const albedoTex = this._albedoTexNode;
		const demodTex = this._demodTex;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );
				const color = textureLoad( colorTex, coord ).xyz;
				const depth = textureLoad( ndTex, coord ).w;
				const isHit = depth.lessThan( float( MISS_THRESHOLD ) );

				// Miss rays (env/background) have black aux albedo — dividing by it would
				// overflow HalfFloat on bright HDR sky and remodulate back to zero. Use a
				// neutral albedo of 1 for misses so the demod/remod round-trip is identity.
				const albedo = textureLoad( albedoTex, coord ).xyz;
				const demodAlbedo = select( isHit, max( albedo, vec3( ALBEDO_EPS ) ), vec3( 1.0 ) );

				const lighting = sanitizeRGB( color.div( demodAlbedo ) );

				textureStore( demodTex, uvec2( uint( gx ), uint( gy ) ), vec4( lighting, 1.0 ) ).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	// À-trous pass over demodulated lighting, writing to `writeStorageTex`.
	_buildAtrous( writeStorageTex ) {

		const readTex = this._readTexNode;
		const colorTex = this._colorTexNode;
		const ndTex = this._ndTexNode;
		const snTex = this._snTexNode;
		const albedoTex = this._albedoTexNode;
		const varTex = this._varTexNode;
		const filterStrength = this.filterStrength;
		const phiLuminance = this.phiLuminance;
		const phiNormal = this.phiNormal;
		const phiDepth = this.phiDepth;
		const stepSize = this.stepSizeU;
		const isLastIterationU = this.isLastIterationU;
		const isFirstIterationU = this.isFirstIterationU;
		const resW = this.resW;
		const resH = this.resH;

		const WG_SIZE = 16;

		const computeFn = Fn( () => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				const coord = ivec2( gx, gy );

				const centerSample = textureLoad( readTex, coord );
				const centerLighting = centerSample.xyz;
				const centerLum = luminance( centerLighting );
				const centerND = textureLoad( ndTex, coord );
				const centerDepth = centerND.w;
				// Shading (bump-perturbed) normal so normal/bump detail isn't collapsed.
				const centerNormal = textureLoad( snTex, coord ).xyz.mul( 2.0 ).sub( 1.0 );
				const centerIsHitBool = centerDepth.lessThan( float( MISS_THRESHOLD ) );
				const centerIsHit = select( centerIsHitBool, float( 1.0 ), float( 0.0 ) );

				const centerAlbedo = textureLoad( albedoTex, coord ).xyz;
				const demodAlbedo = select( centerIsHitBool, max( centerAlbedo, vec3( ALBEDO_EPS ) ), vec3( 1.0 ) );
				const centerAlbedoLum = max( luminance( demodAlbedo ), float( ALBEDO_EPS ) );

				// Variance-guided luminance σ (SVGF). .z = temporal, .w = spatial variance;
				// max() falls back to the spatial estimate as temporal collapses on a
				// converging accumulation buffer. Dividing by albedoLum rescales the
				// modulated-space variance into demodulated space (std ∝ 1/albedo).
				//
				// Filtered alongside colour and carried between passes as √variance in the
				// ping-pong's spare alpha, so sigma_l tightens as the signal smooths. Stored as
				// the root because converged variance (~1e-6) is a half-float subnormal.
				const isFirst = isFirstIterationU.equal( int( 1 ) );
				const seedVariance = ( at ) => {

					const v = textureLoad( varTex, at );
					return max( v.z, v.w );

				};

				const centerVariance = isFirst.select(
					seedVariance( coord ),
					centerSample.w.mul( centerSample.w )
				).toVar();

				const sigmaL = phiLuminance.mul( sqrt( max( centerVariance, float( 0.0 ) ) ) )
					.div( centerAlbedoLum ).add( float( 0.0001 ) );

				const colorSum = vec3( 0.0 ).toVar();
				const weightSum = float( 0.0 ).toVar();
				// Squared weights, normalised by weightSum² — the variance of a weighted mean.
				const varianceSum = float( 0.0 ).toVar();

				for ( let iy = 0; iy < 5; iy ++ ) {

					for ( let ix = 0; ix < 5; ix ++ ) {

						const dx = ix - 2;
						const dy = iy - 2;
						const kw = ATROUS_KERNEL[ iy * 5 + ix ];

						const sx = gx.add( stepSize.mul( dx ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
						const sy = gy.add( stepSize.mul( dy ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );
						const sCoord = ivec2( sx, sy );

						const sSample = textureLoad( readTex, sCoord );
						const sLighting = sSample.xyz;
						const sLum = luminance( sLighting );
						const sND = textureLoad( ndTex, sCoord );
						const sDepth = sND.w;
						const sNormal = textureLoad( snTex, sCoord ).xyz.mul( 2.0 ).sub( 1.0 );
						const sampleIsHit = select( sDepth.lessThan( float( MISS_THRESHOLD ) ), float( 1.0 ), float( 0.0 ) );

						const lumW = centerLum.sub( sLum ).abs().div( sigmaL ).negate().exp();
						// Clamp dot to [0,1] before pow — miss-ray normals decode to non-unit
						// (-1,-1,-1) with dot 3, which would saturate pow to +inf → inf*0 = NaN.
						const normW = pow( dot( centerNormal, sNormal ).clamp( 0.0, 1.0 ), phiNormal );
						// Relative depth tolerance → scale-invariant across scene sizes.
						const depW = centerDepth.sub( sDepth ).abs()
							.div( max( centerDepth.mul( phiDepth ), float( 0.001 ) ) ).negate().exp();

						const bothHit = centerIsHit.mul( sampleIsHit );
						const bothMiss = centerIsHit.oneMinus().mul( sampleIsHit.oneMinus() );
						const sameKind = bothHit.add( bothMiss );

						// Geometric weights are only meaningful for hit-vs-hit pairs.
						const geomW = mix( float( 1.0 ), normW.mul( depW ), bothHit );
						const w = float( kw ).mul( lumW ).mul( geomW ).mul( sameKind );

						const sVariance = isFirst.select(
							seedVariance( sCoord ),
							sSample.w.mul( sSample.w )
						);

						colorSum.addAssign( sLighting.mul( w ) );
						weightSum.addAssign( w );
						varianceSum.addAssign( w.mul( w ).mul( max( sVariance, float( 0.0 ) ) ) );

					}

				}

				const filtered = colorSum.div( max( weightSum, float( 0.0001 ) ) );
				const filteredVariance = varianceSum
					.div( max( weightSum.mul( weightSum ), float( 1e-8 ) ) );

				// Final pass: remodulate by albedo and blend against the raw color by
				// filterStrength. Inner passes stay in demodulated space.
				const isLast = isLastIterationU.equal( int( 1 ) );
				const rawColor = textureLoad( colorTex, coord ).xyz;
				const remodded = filtered.mul( demodAlbedo );
				const finalModulated = mix( rawColor, remodded, filterStrength );
				const output = isLast.select( finalModulated, filtered );

				// The last pass restores the path tracer's coverage — Compositor reads .w as
				// image alpha when transparentBackground is on.
				const carriedAlpha = isLast.select(
					textureLoad( colorTex, coord ).w,
					sqrt( max( filteredVariance, float( 0.0 ) ) )
				);

				textureStore( writeStorageTex, uvec2( uint( gx ), uint( gy ) ), vec4( output, carriedAlpha ) ).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( 'pathtracer:color' );
		const ndTex = context.getTexture( 'pathtracer:normalDepth' );
		// Fall back to geometric normalDepth if the mapped normal isn't published.
		const snTex = context.getTexture( 'pathtracer:shadingNormal' ) || ndTex;
		const albedoTex = context.getTexture( 'pathtracer:albedo' );
		const varTex = context.getTexture( 'variance:output' );

		// The SVGF filter needs color + geometry + albedo + variance. Without the full
		// set there's no edge/variance guidance — pass the input through rather than
		// producing an unguided blur.
		if ( ! colorTex || ! ndTex || ! albedoTex || ! varTex ) {

			if ( colorTex ) context.setTexture( 'edgeFiltering:output', colorTex );
			return;

		}

		if ( context.getState( 'interactionMode' ) ) {

			context.setTexture( 'edgeFiltering:output', colorTex );
			return;

		}

		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this.outputTarget.width ||
				img.height !== this.outputTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		this._colorTexNode.value = colorTex;
		this._ndTexNode.value = ndTex;
		this._snTexNode.value = snTex;
		this._albedoTexNode.value = albedoTex;
		this._varTexNode.value = varTex;

		// First-frame compile while _readTexNode still holds EmptyTexture — codegen
		// then emits textureLoad with the level parameter the runtime requires for
		// non-zero StorageTexture reads. The throwaway dispatches also initialise the
		// ping-pong textures. _readTexNode must NOT be assigned before this.
		if ( ! this._compiled ) {

			this.renderer.compute( this._computeDemod );
			this.renderer.compute( this._computeAtrousA );
			this.renderer.compute( this._computeAtrousB );
			this._compiled = true;

		}

		// 1. Demodulate → _demodTex.
		this.renderer.compute( this._computeDemod );

		// 2. À-trous iterations: step 2^i, ping-pong write direction. First pass reads
		//    _demodTex; the last pass remodulates + strength-blends.
		let readTex = this._demodTex;
		let writeNode = this._computeAtrousA;
		let nextWriteNode = this._computeAtrousB;

		for ( let i = 0; i < this.iterations; i ++ ) {

			this.stepSizeU.value = 1 << i;
			this.isLastIterationU.value = ( i === this.iterations - 1 ) ? 1 : 0;
			this.isFirstIterationU.value = i === 0 ? 1 : 0;
			this._readTexNode.value = readTex;

			this.renderer.compute( writeNode );

			readTex = ( writeNode === this._computeAtrousA )
				? this._storageTexA
				: this._storageTexB;

			const tmp = writeNode;
			writeNode = nextWriteNode;
			nextWriteNode = tmp;

		}

		// Copy the final result out of the over-allocated StorageTexture into the
		// active-size RenderTarget; downstream stages UV-sample the latter.
		this._srcRegion.max.set( this.outputTarget.width, this.outputTarget.height );
		this.renderer.copyTextureToTexture( readTex, this.outputTarget.texture, this._srcRegion );

		context.setTexture( 'edgeFiltering:output', this.outputTarget.texture );

	}

	setFilteringEnabled( enabled ) {

		this.enabled = enabled;

	}

	updateUniforms( params ) {

		if ( ! params ) return;
		if ( params.filterStrength !== undefined ) this.filterStrength.value = params.filterStrength;
		if ( params.phiLuminance !== undefined ) this.phiLuminance.value = params.phiLuminance;
		if ( params.phiNormal !== undefined ) this.phiNormal.value = params.phiNormal;
		if ( params.phiDepth !== undefined ) this.phiDepth.value = params.phiDepth;
		if ( params.atrousIterations !== undefined ) this.iterations = params.atrousIterations;

	}

	// Free the 2048² StorageTextures when disabled; three.js re-creates them on the next dispatch
	// after re-enable (no temporal state to re-anchor). See ASVGF.releaseGPUMemory.
	releaseGPUMemory() {

		this._demodTex?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		// Render-res RT texture (dispose .texture, not the RT — RT.dispose() doesn't free it here).
		this.context?.removeTexture( 'edgeFiltering:output' );
		this.outputTarget?.texture?.dispose();

	}

	reset() {

		// No per-frame or temporal state — variance guidance is owned by the Variance stage.

	}

	setSize( width, height ) {

		// StorageTextures stay at their max allocation (see constructor).
		this.outputTarget.setSize( width, height );
		this.outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		this._dispatchX = Math.ceil( width / 16 );
		this._dispatchY = Math.ceil( height / 16 );
		const size = [ this._dispatchX, this._dispatchY, 1 ];
		this._computeDemod.dispatchSize = size;
		this._computeAtrousA.dispatchSize = size;
		this._computeAtrousB.dispatchSize = size;

	}

	// Reserved-storage change (e.g. 4K toggle): recreate the MAX-preallocated StorageTextures at the new live
	// reserved size + rebuild the compute nodes in place. Same stage object, so refs/wiring stay valid.
	reallocateReservedStorage() {

		this._computeDemod?.dispose();
		this._computeAtrousA?.dispose();
		this._computeAtrousB?.dispose();
		this._demodTex?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		this._demodTex = this._makeStorageTex();
		this._storageTexA = this._makeStorageTex();
		this._storageTexB = this._makeStorageTex();
		this._buildCompute();
		this._compiled = false;

	}

	dispose() {

		this._computeDemod?.dispose();
		this._computeAtrousA?.dispose();
		this._computeAtrousB?.dispose();
		this._demodTex?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		this.outputTarget?.dispose();
		this._colorTexNode?.dispose();
		this._ndTexNode?.dispose();
		this._snTexNode?.dispose();
		this._albedoTexNode?.dispose();
		this._varTexNode?.dispose();
		this._readTexNode?.dispose();

	}

}
