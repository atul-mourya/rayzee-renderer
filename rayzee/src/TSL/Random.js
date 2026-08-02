// Three.js Transpiler r182

import { uniform, texture, float, If, wgslFn, uint, TWO_PI, cos, sin, vec2, sqrt, fract, mod, ivec2, select, int, vec4, mix } from 'three/tsl';
import { DataTexture, FloatType } from 'three';

// -----------------------------------------------------------------------------
// Uniform declarations and constants
// -----------------------------------------------------------------------------

export const samplingTechniqueUniform = uniform( 0, 'int' );
const samplingTechnique = samplingTechniqueUniform;

// 0: PCG, 1: Halton, 2: Owen-scrambled Sobol (default; anything higher falls back to it)

// 1x1 placeholder — real texture assigned later via .value = ...
const _placeholderData = new Float32Array( [ 0.5, 0.5, 0.5, 1.0 ] );

const _placeholderScalar = new DataTexture( _placeholderData, 1, 1 );
_placeholderScalar.type = FloatType;
_placeholderScalar.needsUpdate = true;

const _placeholderVec2 = new DataTexture( new Float32Array( [ 0.5, 0.5, 0.0, 1.0 ] ), 1, 1 );
_placeholderVec2.type = FloatType;
_placeholderVec2.needsUpdate = true;

// STBN (Spatiotemporal Blue Noise) atlas textures — Heitz 2019
// Each atlas: 1024×1024, 8×8 grid of 128×128 tiles, 64 temporal slices
// Scalar atlas: single-channel (R) — optimal for 1D decisions (RR, lobe selection)
// Vec2 atlas: two-channel (R,G) — decorrelated 2D pairs (direction sampling Xi)
export const stbnScalarTextureNode = texture( _placeholderScalar );
stbnScalarTextureNode.setUpdateMatrix( false );

export const stbnVec2TextureNode = texture( _placeholderVec2 );
stbnVec2TextureNode.setUpdateMatrix( false );

// R2 quasi-random sequence constants (Roberts 2018) — optimal 2D additive offsets
const R2_A1 = float( 0.7548776662466927 );
const R2_A2 = float( 0.5698402909980532 );

// -----------------------------------------------------------------------------
// Basic random number generation
// -----------------------------------------------------------------------------
// PCG (Permuted Congruential Generator) hash function

export const pcgHash = /*@__PURE__*/ wgslFn( `
	fn pcgHash( state: u32 ) -> u32 {

		var s = state;
		s = s * 747796405u + 2891336453u;
		s = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
		s = ( s >> 22u ) ^ s;
		return s;

	}
` );

// Wang hash for additional mixing

export const wang_hash = /*@__PURE__*/ wgslFn( `
	fn wang_hash( seed: u32 ) -> u32 {

		var s = seed;
		s = ( s ^ 61u ) ^ ( s >> 16u );
		s = s * 9u;
		s = s ^ ( s >> 4u );
		s = s * 0x27d4eb2du;
		s = s ^ ( s >> 15u );
		return s;

	}
` );

// OPTIMIZED: Fast random value for hot paths - uses simpler hash for performance
// Performance gain: ~40% faster than full PCG for non-critical samples

// Plain JS functions (not Fn()) — they inline at the call site where `state` is a
// mutable .toVar() variable. This replicates GLSL `inout uint state` semantics:
// the caller's rngState advances on every call.

export const RandomValueFast = ( state ) => {

	// Simple multiply-with-carry generator - much faster than PCG
	state.assign( state.mul( 1664525 ).add( 1013904223 ) );
	return float( state.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 );

};

// Generate random float between 0 and 1 with full PCG quality

export const RandomValue = ( state ) => {

	state.assign( pcgHash( { state } ) );
	return float( state.shiftRight( 8 ) ).mul( 1.0 / 16777216.0 );

};

// -----------------------------------------------------------------------------
// Directional sampling functions
// -----------------------------------------------------------------------------
// OPTIMIZED: Fast random point in unit circle using simpler RNG for hot paths

export const RandomPointInCircle = ( rngState ) => {

	// Use fast RNG for circle sampling - adequate quality for DOF/sampling
	// .toVar() captures angle immediately so cos/sin don't read state after the 2nd advance
	const angle = RandomValueFast( rngState ).mul( TWO_PI ).toVar();
	const pointOnCircle = vec2( cos( angle ), sin( angle ) );

	return pointOnCircle.mul( sqrt( RandomValueFast( rngState ) ) );

};

// -----------------------------------------------------------------------------
// Sampler dimension allocation
// -----------------------------------------------------------------------------
// DIMENSION BUDGET — bounce b owns [b*DIMS_PER_BOUNCE, b*DIMS_PER_BOUNCE + 15]. The index keys
// the Owen scramble seed, so two draws sharing one index at the same bounce get the SAME variate:
// perfectly correlated decisions, not independent ones. The 1D and 2D allocations are separate
// namespaces (different seed derivations), so a collision only matters within one.
//
// Every stochastic decision on the shading path draws from here rather than the per-pixel PCG
// stream. A low-discrepancy sequence only stratifies the dimensions it actually covers; a draw
// left on PCG contributes white-noise error that the rest of the path cannot compensate for.
//
//   2D  +0  BSDF direction xi            (ShadeKernel)
//       +1  environment NEE              (LightsSampling)
//       +2  discrete light position      (LightsSampling)
//       +3  emissive-triangle NEE        (EmissiveSampling / LightBVHSampling — the two are
//           mutually exclusive at runtime, so they share the index)
//       +4  microfacet transmission dir  (MaterialTransmission)
//       +5  subsurface reflect/refract   (Subsurface)
//       +6  subsurface HG scatter dir    (ShadeKernel)
//       +7  ground-catcher cosine BSDF   (ShadeKernel)
//       +8  indirect-strategy direction  (LightsIndirect)
//   1D  +0  (free — was the {lights,BRDF} stochastic strategy pick)
//       +1  emissive-triangle pick       (EmissiveSampling / LightBVHSampling)
//       +2  BSDF lobe selection          (ShadeKernel)
//       +3  Russian roulette             (PathTracerCore)
//       +4  transmission reflect/refract (MaterialTransmission)
//       +5  dispersion wavelength        (MaterialTransmission)
//       +6  alpha cutout test            (MaterialTransmission)
//       +7  stochastic transmission test (MaterialTransmission)
//       +8  subsurface entry lottery     (MaterialTransmission)
//       +9  subsurface collision dist    (Subsurface)
//      +10  subsurface channel pick      (Subsurface)
//      +11  subsurface reflect/refract   (Subsurface)
//      +12  subsurface walk RR           (ShadeKernel)
//      +13  clearcoat lobe               (Clearcoat)
//      +14  area/spot light phi          (LightsSampling)
//      +15  light uv second component    (LightsSampling)
//
// Stride is 32 rather than the ~16 in use so a new call site does not force a renumbering.
// The index only keys a scramble seed, so spare slots cost nothing.
//
// Draws whose COUNT varies per pixel cannot sit in a per-bounce block without overflowing into
// the next bounce's dimensions, so they live above AUX_BASE:
//   AUX_BASE +  0..63   env-backdrop blur taps      (ShadeKernel)
//   AUX_BASE + 64..    light reservoir, one dimension per scene light (LightsSampling)
export const SAMPLER_DIMS_PER_BOUNCE = 32;
export const SAMPLER_DIM_AUX_BASE = 4096;

// -----------------------------------------------------------------------------
// STBN atlas sampling — spatiotemporal blue noise
// -----------------------------------------------------------------------------
// Atlas layout: 8×8 grid of 128×128 tiles = 1024×1024 texture.
// Temporal axis: frame % 64 selects tile (true STBN temporal decorrelation).
// Spatial decorrelation: R2 quasi-random offset keyed on dimension + sample index.

const computeSTBNAtlasCoord = ( pixelCoords, sampleIndex, dimensionIndex, frame ) => {

	// Temporal slice — true STBN temporal axis
	const slice = uint( frame ).bitAnd( uint( 63 ) ); // frame % 64

	// R2 quasi-random spatial offset for per-dimension/per-sample decorrelation
	const n = float( dimensionIndex ).add( float( sampleIndex ).mul( 7.0 ) );
	const offsetX = int( fract( n.mul( R2_A1 ).add( 0.5 ) ).mul( 128.0 ) );
	const offsetY = int( fract( n.mul( R2_A2 ).add( 0.5 ) ).mul( 128.0 ) );

	// Pixel within 128×128 tile (toroidal wrap via bitmask)
	const px = int( pixelCoords.x ).add( offsetX ).bitAnd( int( 127 ) );
	const py = int( pixelCoords.y ).add( offsetY ).bitAnd( int( 127 ) );

	// Atlas tile position from slice index
	const tileCol = int( slice ).bitAnd( int( 7 ) ); // slice % 8
	const tileRow = int( slice ).shiftRight( int( 3 ) ); // slice / 8

	return ivec2( tileCol.mul( int( 128 ) ).add( px ), tileRow.mul( int( 128 ) ).add( py ) );

};

// Sample decorrelated 2D STBN pair in [0,1]²
export const sampleSTBN2D = ( pixelCoords, sampleIndex, dimensionPairIndex, frame ) => {

	const coord = computeSTBNAtlasCoord( pixelCoords, sampleIndex, dimensionPairIndex, frame );
	const raw = stbnVec2TextureNode.load( coord ).xy;

	// The atlas has only 64 temporal slices, so frame N and N+64 read the same slice: the
	// sample repeats and accumulation stops improving past 64 frames. Decorrelate across
	// 64-frame cycles with a Cranley-Patterson rotation (toroidal shift) by an R2 offset
	// keyed on the cycle index (frame >> 6). The offset is uniform per cycle, preserving
	// spatial and within-window temporal blue noise; cycle 0's offset is 0, so frames
	// 0-63 stay bit-identical. A toroidal shift of uniform samples stays uniform (unbiased).
	const cycle = float( uint( frame ).shiftRight( uint( 6 ) ) );
	const rotation = fract( vec2( R2_A1, R2_A2 ).mul( cycle ) );
	return fract( raw.add( rotation ) );

};

// -----------------------------------------------------------------------------
// Low-discrepancy sequence generators
// -----------------------------------------------------------------------------
// Halton sequence generator with per-digit additive scrambling

export const haltonScrambled = /*@__PURE__*/ wgslFn( `
	fn haltonScrambled( index: i32, base: i32, scramble: u32 ) -> f32 {

		var result = 0.0f;
		var f = 1.0f;
		var i = index + 1;
		var s = scramble;
		var iter = 0;

		while ( i > 0 && iter < 32 ) {

			iter += 1;
			f /= f32( base );

			// Additive permutation per digit: (digit + s_k) mod base
			// Guaranteed bijection within [0, base) for any s_k
			var digit = i % base;
			digit = ( digit + i32( s % u32( base ) ) ) % base;
			result += f * f32( digit );
			i /= base;

			// Evolve scramble per digit position for position-dependent permutations
			s = s * 747796405u + 2891336453u;

		}

		return result;

	}
` );

// Owen scrambling — Burley 2020 "Practical Hash-based Owen Scrambling".
//
// The reverseBits sandwich is required, not decoration: Owen scrambling permutes a digit from the
// digits ABOVE it, so the permutation must run on the bit-reversed value. A plain hash randomises
// the point but destroys the stratification Sobol' exists to provide.
export const owen_scramble = /*@__PURE__*/ wgslFn( `
	fn owen_scramble( x: u32, seed: u32 ) -> u32 {

		var v = reverseBits( x );
		v += seed;
		v ^= v * 0x6c50b47cu;
		v ^= v * 0xb82f1e52u;
		v ^= v * 0xc7afe638u;
		v ^= v * 0x8d22f6e6u;
		return reverseBits( v );

	}
` );

// Sobol' direction vectors for the first two dimensions, advanced together so a 2D point costs
// one pass. dim 0 is van der Corput (a bit reversal); dim 1 is the primitive polynomial x+1,
// whose matrix rows are Pascal's triangle mod 2 — by Lucas' theorem row k selects the submasks of
// k, making the transform a 5-step subset-XOR butterfly rather than a loop over set bits.
// Together they form a (0,2)-sequence.
export const sobol2D = /*@__PURE__*/ wgslFn( `
	fn sobol2D( index: u32 ) -> vec2u {

		let r0 = reverseBits( index );

		var x = r0;
		x ^= ( x << 1u ) & 0xaaaaaaaau;
		x ^= ( x << 2u ) & 0xccccccccu;
		x ^= ( x << 4u ) & 0xf0f0f0f0u;
		x ^= ( x << 8u ) & 0xff00ff00u;
		x ^= ( x << 16u ) & 0xffff0000u;

		return vec2u( r0, x );

	}
` );

// Padded Owen-scrambled Sobol for a STANDALONE 1D dimension.
//
// The index shuffle is what actually decorrelates dimensions. A scramble seed does not: Owen
// scrambling either preserves or flips each digit, so two dimensions built from the same
// direction vectors come out ~±1 correlated whatever seed they are given (measured cross-
// dimension mean |corr| 0.74, max 0.99). Along a multi-bounce path that turns "independent"
// per-bounce decisions into effectively one repeated variate — which showed up as a persistent
// 1% energy error on dispersion-glass, where it biased the reflect/refract choice at every
// interface the same way. Shuffling the index instead permutes WHICH sample each dimension
// takes, dropping cross-dimension |corr| to 0.05 while leaving each dimension's own
// stratification intact (a permutation of 0..2^k-1 is the same point set).
export const owen_scrambled_sobol = /*@__PURE__*/ wgslFn( `
	fn owen_scrambled_sobol( index: u32, dimension: u32, seed: u32 ) -> f32 {

		let dimSeed = seed ^ ( dimension * 0x9e3779b9u + 0x6a09e667u );
		let shuffled = owen_scramble( index, dimSeed ^ 0xa511e9b3u );
		let pair = sobol2D( shuffled );
		let raw = select( pair.x, pair.y, ( dimension & 1u ) != 0u );
		return f32( owen_scramble( raw, dimSeed ) ) / 4294967296.0f;

	}
`, [ sobol2D, owen_scramble ] );

// A 2D pair must shuffle the index ONCE and take both Sobol' components from that single
// shuffled index — that is what keeps the pair a (0,2)-net. Shuffling each component
// independently (i.e. calling the 1D routine twice) destroys it: measured 982/2304 elementary
// intervals wrong at 256 points, versus 0/2304 with the shared shuffle.
export const owen_scrambled_sobol2D = /*@__PURE__*/ wgslFn( `
	fn owen_scrambled_sobol2D( index: u32, seed: u32 ) -> vec2f {

		let shuffled = owen_scramble( index, seed ^ 0xa511e9b3u );
		let pair = sobol2D( shuffled );
		return vec2f(
			f32( owen_scramble( pair.x, seed ^ 0x68bc21ebu ) ) / 4294967296.0f,
			f32( owen_scramble( pair.y, seed ^ 0x02e5be93u ) ) / 4294967296.0f
		);

	}
`, [ sobol2D, owen_scramble ] );

// -----------------------------------------------------------------------------
// Multi-dimensional sampling interface
// -----------------------------------------------------------------------------
// Get N-dimensional sample (up to 4D)

export const getRandomSampleND = ( pixelCoord, sampleIndex, bounceIndex, rngState, dimensions, preferredTechnique, resolution, frame ) => {

	const technique = select( preferredTechnique.notEqual( int( - 1 ) ), preferredTechnique, samplingTechnique );
	const result = vec4( 0.0 ).toVar();

	// PCG (technique 0)
	If( technique.equal( int( 0 ) ), () => {

		// Check useFast once and branch — select() would evaluate both RandomValueFast and
		// RandomValue unconditionally, advancing state twice for each dimension.
		const useFast = dimensions.greaterThan( int( 2 ) );

		If( useFast, () => {

			result.x.assign( RandomValueFast( rngState ) );

			If( dimensions.greaterThan( int( 1 ) ), () => {

				result.y.assign( RandomValueFast( rngState ) );

			} );

			If( dimensions.greaterThan( int( 2 ) ), () => {

				result.z.assign( RandomValueFast( rngState ) );

			} );

			If( dimensions.greaterThan( int( 3 ) ), () => {

				result.w.assign( RandomValueFast( rngState ) );

			} );

		} ).Else( () => {

			result.x.assign( RandomValue( rngState ) );

			If( dimensions.greaterThan( int( 1 ) ), () => {

				result.y.assign( RandomValue( rngState ) );

			} );

			If( dimensions.greaterThan( int( 2 ) ), () => {

				result.z.assign( RandomValue( rngState ) );

			} );

			If( dimensions.greaterThan( int( 3 ) ), () => {

				result.w.assign( RandomValue( rngState ) );

			} );

		} );

	} ).ElseIf( technique.equal( int( 1 ) ), () => {

		// Halton — the accumulation frame is the sequence INDEX, not part of the scramble. Folding
		// frame into the scramble (as this did) re-randomises point 0 every frame and never walks the
		// sequence, which is a hash, not low-discrepancy sampling. The scramble is what separates pixels.
		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const scramble = pcgHash( { state: pixelHash.bitXor( uint( bounceIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();

		result.x.assign( haltonScrambled( { index: int( frame ), base: int( 2 ), scramble } ) );

		If( dimensions.greaterThan( int( 1 ) ), () => {

			result.y.assign( haltonScrambled( { index: int( frame ), base: int( 3 ), scramble } ) );

		} );

		If( dimensions.greaterThan( int( 2 ) ), () => {

			result.z.assign( haltonScrambled( { index: int( frame ), base: int( 5 ), scramble } ) );

		} );

		If( dimensions.greaterThan( int( 3 ) ), () => {

			result.w.assign( haltonScrambled( { index: int( frame ), base: int( 7 ), scramble } ) );

		} );

	} ).Else( () => {

		// Sobol — frame is the sequence INDEX; the per-pixel Owen seed must stay frame-independent
		// or the sequence never advances. See the Halton note above.
		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const seed = pcgHash( { state: pixelHash.bitXor( uint( bounceIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();

		// Drawn as PAIRS, not four padded 1D dimensions — only a shared index shuffle keeps
		// (x,y) and (z,w) proper 2D nets. See owen_scrambled_sobol2D.
		const xy = owen_scrambled_sobol2D( { index: uint( frame ), seed } ).toVar();
		result.x.assign( xy.x );

		If( dimensions.greaterThan( int( 1 ) ), () => {

			result.y.assign( xy.y );

		} );

		If( dimensions.greaterThan( int( 2 ) ), () => {

			const zw = owen_scrambled_sobol2D( { index: uint( frame ), seed: seed.bitXor( uint( 0x734f6b19 ) ) } ).toVar();
			result.z.assign( zw.x );

			If( dimensions.greaterThan( int( 3 ) ), () => {

				result.w.assign( zw.y );

			} );

		} );

	} );

	return result;

};

// -----------------------------------------------------------------------------
// Main sampling interface functions
// -----------------------------------------------------------------------------
// Get random sample based on preferred technique (2D)

export const getRandomSample = ( pixelCoord, sampleIndex, bounceIndex, rngState, preferredTechnique, resolution, frame ) => {

	const sample4D = getRandomSampleND( pixelCoord, sampleIndex, bounceIndex, rngState, int( 2 ), preferredTechnique, resolution, frame );

	return sample4D.xy;

};

// 2D pair on an explicitly chosen dimension. getRandomSample derives its dimension from
// bounceIndex, which is fine for the one BSDF sample per bounce but cannot express the several
// independent 2D draws NEE needs at the same bounce.

export const getRandomSample2D = ( pixelCoord, sampleIndex, dimensionIndex, rngState, resolution, frame ) => {

	const result = vec2( 0.0 ).toVar();

	If( samplingTechnique.equal( int( 0 ) ), () => {

		// per-component .toVar(): vec2( RandomValue, RandomValue ) collapses to u==v
		const u1 = RandomValue( rngState ).toVar();
		const u2 = RandomValue( rngState ).toVar();
		result.assign( vec2( u1, u2 ) );

	} ).ElseIf( samplingTechnique.equal( int( 1 ) ), () => {

		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const scramble = pcgHash( { state: pixelHash.bitXor( uint( dimensionIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();
		result.assign( vec2(
			haltonScrambled( { index: int( frame ), base: int( 2 ), scramble } ),
			haltonScrambled( { index: int( frame ), base: int( 3 ), scramble } ),
		) );

	} ).Else( () => {

		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const seed = pcgHash( { state: pixelHash.bitXor( uint( dimensionIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();
		result.assign( owen_scrambled_sobol2D( { index: uint( frame ), seed } ) );

	} );

	return result;

};

// Single scalar variate on its own dimension — for discrete choices that must stay independent
// of the 2D pair driving direction sampling. `dimensionIndex` keys the scramble seed, so callers
// must keep it distinct from the other 1D dimensions in use at the same bounce.

export const getRandomSample1D = ( pixelCoord, sampleIndex, dimensionIndex, rngState, resolution, frame ) => {

	const result = float( 0.0 ).toVar();

	If( samplingTechnique.equal( int( 0 ) ), () => {

		result.assign( RandomValue( rngState ) );

	} ).ElseIf( samplingTechnique.equal( int( 1 ) ), () => {

		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const scramble = pcgHash( { state: pixelHash.bitXor( uint( dimensionIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();
		result.assign( haltonScrambled( { index: int( frame ), base: int( 2 ), scramble } ) );

	} ).Else( () => {

		const pixelHash = uint( pixelCoord.x ).add( uint( pixelCoord.y ).mul( uint( resolution.x ) ) );
		const seed = pcgHash( { state: pixelHash.bitXor( uint( dimensionIndex ).mul( uint( 0x517cc1b7 ) ) ).bitXor( uint( sampleIndex ).mul( uint( 0x2545f491 ) ) ) } ).toVar();
		result.assign( owen_scrambled_sobol( { index: uint( frame ), dimension: uint( 0 ), seed } ) );

	} );

	return result;

};

// Stratified sample. Both call sites pass totalRays = 1, so only the first branch is live;
// the strata path below is kept for the multi-ray-per-pixel mode that was removed.

export const getStratifiedSample = ( pixelCoord, rayIndex, totalRays, rngState, resolution, frame ) => {

	// result variable avoids early-return ReturnNode escaping into outer Fn scope
	const result = vec2( 0.0 ).toVar();

	If( totalRays.lessThanEqual( int( 1 ) ), () => {

		result.assign( getRandomSample( pixelCoord, rayIndex, int( 0 ), rngState, int( - 1 ), resolution, frame ) );

	} ).Else( () => {

		// Calculate strata dimensions

		const strataX = int( sqrt( float( totalRays ) ) );
		const strataY = totalRays.add( strataX ).sub( 1 ).div( strataX );
		const strataIdx = mod( rayIndex, strataX.mul( strataY ) );
		const sx = mod( strataIdx, strataX );
		const sy = strataIdx.div( strataX );

		// Base stratified position

		const strataPos = vec2( float( sx ), float( sy ) ).div( vec2( float( strataX ), float( strataY ) ) );

		const j1 = RandomValueFast( rngState ).toVar();
		const j2 = RandomValueFast( rngState ).toVar();
		const jitter = vec2( j1, j2 ).toVar();

		If( totalRays.greaterThan( int( 4 ) ), () => {

			const stbnInfluence = sampleSTBN2D( pixelCoord, rayIndex, int( 0 ), frame ).mul( 0.1 );
			jitter.assign( mix( jitter, stbnInfluence, 0.2 ) );

		} );

		jitter.divAssign( vec2( float( strataX ), float( strataY ) ) );

		result.assign( strataPos.add( jitter ) );

	} );

	return result;

};

// Get decorrelated seed with better mixing

export const getDecorrelatedSeed = /*@__PURE__*/ wgslFn( `
	fn getDecorrelatedSeed( pixelCoord: vec2f, rayIndex: i32, frame: u32 ) -> u32 {

		// Use multiple primes for better decorrelation
		let pixelSeed = u32( pixelCoord.x ) * 2654435761u + u32( pixelCoord.y ) * 3266489917u;
		let raySeed = u32( rayIndex ) * 668265263u;
		let frameSeed = frame * 374761393u;

		// Multiple rounds of hashing for better quality
		var seed = wang_hash( pixelSeed );
		seed = pcgHash( seed ^ raySeed );
		seed = wang_hash( seed + frameSeed );
		return seed;

	}
`, [ wang_hash, pcgHash ] );

