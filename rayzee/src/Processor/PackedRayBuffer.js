/**
 * Packed buffer manager for wavefront path tracing — one storage buffer per data category.
 * RAY/HIT are SoA-within-a-buffer (field `slot` of element `id` lives at `id + slot*_cap`).
 */

import {
	storage, uintBitsToFloat, floatBitsToUint, vec2, vec3, vec4, uvec4, uint, int, float, clamp,
	packSnorm2x16, packUnorm2x16, unpackSnorm2x16, unpackUnorm2x16,
} from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'gpu' );

export const RAY_STRIDE = 7;
export const HIT_STRIDE = 2;
// Per-pixel G-buffer (first-hit MRT staging): 1 uvec4/pixel — half-packed normal/depth/albedo
// (pack2x16, no f32 bitcast); read by FinalWrite:
//   .x=packSnorm2x16(normal.xy)  .y=packSnorm2x16(normal.z, depth)  .z=packUnorm2x16(albedo.rg)  .w=packUnorm2x16(albedo.b, 0)
// Separate buffer from RAY (per-pixel, not per-ray×S) — written by Generate/Shade bounce-0.
// (A second lane reserved for an A-SVGF Tier-1 surface ID was removed — write-only, never read.)
export const GBUFFER_STRIDE = 1;

export const RAY = {
	ORIGIN_META: 0, // vec4(origin.xyz, uintBitsToFloat(perRayBounces | sssSteps<<8 | lobeCounts<<16)); pixelIndex == rayID
	DIR_FLAGS: 1, // vec4(direction.xyz, uintBitsToFloat(bounceFlags))
	THROUGHPUT_PDF: 2, // vec4(throughput.xyz, pdf)
	RADIANCE_ALPHA: 3, // vec4(radiance.xyz, alpha)
	MEDIUM_STACK: 4, // vec4(uintBitsToFloat(stackDepth|transTraversals<<8|wavelength<<16), ior1, ior2, ior3)
	MEDIUM_SIGMA_A: 5, // vec4(sigmaA.xyz, featTP.w) — Beer-Lambert absorption (KHR_materials_volume + SSS) + DDFA feature-throughput tint
	SSS_SIGMA_S: 6, // vec4(sigmaS.xyz, g) — SSS scattering coeff + Henyey-Greenstein anisotropy (sigmaS==0 ⇒ glass)
};

export const HIT = {
	DIST_TRI_BARY: 0, // vec4(distance, uintBitsToFloat(triIndex), bary.u, bary.v)
	NORMAL_MAT: 1, // vec4(geoNormal.xyz, uintBitsToFloat(matIndex | meshIndex<<16))
};

// SoA region stride, baked into the shader graph at build time; single instance, rebuilt on resize.
let _cap = 0;

const soa = ( id, slot ) => ( slot === 0 ? id : id.add( slot * _cap ) );

// Free a compute storage attribute's GPU buffer. Nulling the JS reference alone leaks it —
// these attributes hang off no geometry, so nothing triggers the renderer's attribute cleanup.
// Deleting from the renderer's attribute map calls backend.destroyAttribute(). Guarded no-op
// when the attribute was never uploaded or no renderer was provided (e.g. unit tests).
export function freeStorageAttribute( renderer, attr ) {

	if ( attr ) renderer?._attributes?.delete?.( attr );

}

export class PackedRayBuffer {

	// `capacity` is the exact paths-in-flight budget B (Blender-style path pool). It is DECOUPLED from
	// image resolution and fixed for the device — the image is streamed through the pool in row bands
	// (see docs/internal/specs/wavefront-chunked-pool.md), so the SoA stride _cap never changes with
	// resolution and the wavefront kernels are built once (no resize-triggered WGSL regen).
	constructor( capacity = 0, renderer = null ) {

		this.capacity = 0;
		this._renderer = renderer;
		this._attrs = {};

		// Each: { rw: StorageBufferNode, ro: StorageBufferNode } over one shared GPU buffer.
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;

		if ( capacity > 0 ) this.allocate( capacity );

	}

	allocate( capacity ) {

		this.dispose();

		this.capacity = capacity;
		_cap = capacity;

		// count=0 so StorageBufferNode.getHash() shares the buffer → RW and RO nodes bind the same GPU data.
		const rayCount = capacity * RAY_STRIDE;
		const rayAttr = new StorageInstancedBufferAttribute( new Float32Array( rayCount * 4 ), 4 );
		this._attrs.ray = rayAttr;
		this.rayBuffer = {
			rw: storage( rayAttr, 'vec4' ),
			ro: storage( rayAttr, 'vec4' ).toReadOnly(),
		};

		const rngAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrs.rng = rngAttr;
		this.rngBuffer = {
			rw: storage( rngAttr, 'uint' ),
			ro: storage( rngAttr, 'uint' ).toReadOnly(),
		};

		const hitCount = capacity * HIT_STRIDE;
		const hitAttr = new StorageInstancedBufferAttribute( new Float32Array( hitCount * 4 ), 4 );
		this._attrs.hit = hitAttr;
		this.hitBuffer = {
			rw: storage( hitAttr, 'vec4' ),
			ro: storage( hitAttr, 'vec4' ).toReadOnly(),
		};

		// Kept for the [gpu] startup summary in PathTracer._buildWavefrontKernels.
		this.rayBytes = rayCount * 16 + capacity * 4;
		this.hitBytes = hitCount * 16;
		this.totalBytes = this.rayBytes + this.hitBytes;

		log.debug( `ray pool capacity ${fmt.n( capacity )} · ${fmt.mb( this.totalBytes )} (rays ${fmt.mb( this.rayBytes )} · hits ${fmt.mb( this.hitBytes )})` );

	}

	// Reallocates only if a larger budget capacity is requested; returns true if it did.
	resize( capacity ) {

		if ( capacity <= this.capacity && this.capacity > 0 ) return false;
		this.allocate( capacity );
		return true;

	}

	dispose() {

		freeStorageAttribute( this._renderer, this._attrs.ray );
		freeStorageAttribute( this._renderer, this._attrs.rng );
		freeStorageAttribute( this._renderer, this._attrs.hit );
		this._attrs = {};
		this.rayBuffer = null;
		this.rngBuffer = null;
		this.hitBuffer = null;
		this.capacity = 0;

	}

}

// TSL accessor helpers — call inside Fn() scopes. `buf` is the .rw/.ro StorageBufferNode, `id` a uint node.

export const readRayOrigin = ( buf, id ) =>
	buf.element( soa( id, RAY.ORIGIN_META ) ).xyz;

export const readRayDirection = ( buf, id ) =>
	buf.element( soa( id, RAY.DIR_FLAGS ) ).xyz;

export const readRayBounceFlags = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, RAY.DIR_FLAGS ) ).w );

export const readRayThroughput = ( buf, id ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) ).xyz;

export const readRayPdf = ( buf, id ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) ).w;

export const readRayRadiance = ( buf, id ) =>
	buf.element( soa( id, RAY.RADIANCE_ALPHA ) );

// ── Per-pixel G-buffer (first-hit MRT). 2 uvec4/pixel (AoS), pack2x16 lanes. ──
// normal: raw unit vec3; depth: linear [0,1]; albedo: vec3 [0,1]. Packed values live in u32 lanes
// verbatim (no f32 bitcast) so NaN-range bit patterns (snorm ±1 → 0x7FFF) survive store/load intact.
// One uvec4 per pixel (stride 1); AoS base = pixelIndex * GBUFFER_STRIDE.
const gbLane = ( pixelIndex ) => uint( pixelIndex ).mul( GBUFFER_STRIDE );

export const writeGBuffer = ( buf, pixelIndex, normal, depth, albedo ) =>
	buf.element( gbLane( pixelIndex ) ).assign( uvec4(
		packSnorm2x16( vec2( normal.x, normal.y ) ),
		packSnorm2x16( vec2( normal.z, depth ) ),
		packUnorm2x16( vec2( albedo.x, albedo.y ) ),
		packUnorm2x16( vec2( albedo.z, 0.0 ) ),
	) );
export const readGBuffer = ( buf, pixelIndex ) => buf.element( gbLane( pixelIndex ) );

// Decode for FinalWrite. normalDepth.xyz matches the prior path (normal*0.5+0.5), .w = raw depth.
export const gbDecodeNormalDepth = ( packed ) => {

	const nxy = unpackSnorm2x16( packed.x );
	const nzd = unpackSnorm2x16( packed.y );
	return vec4( vec3( nxy.x, nxy.y, nzd.x ).mul( 0.5 ).add( 0.5 ), nzd.y );

};

export const gbDecodeAlbedo = ( packed ) =>
	vec3( unpackUnorm2x16( packed.z ), unpackUnorm2x16( packed.w ).x );

// .w packs per-ray bounce state: perRayBounces (bits 0-7) | sssSteps (bits 8-15) | transparentCount
// (bits 16-21), each masked so an overrun can't bleed into its neighbour. pixelIndex is NOT stored —
// it equals rayID (one ray per pixel).
export const writeRayOriginMeta = ( buf, id, origin, bounces, sssSteps, transparentCount = uint( 0 ) ) =>
	buf.element( soa( id, RAY.ORIGIN_META ) )
		.assign( vec4( origin, uintBitsToFloat(
			uint( bounces ).bitAnd( uint( 0xFF ) )
				.bitOr( uint( sssSteps ).bitAnd( uint( 0xFF ) ).shiftLeft( 8 ) )
				.bitOr( uint( transparentCount ).bitAnd( uint( 0x3F ) ).shiftLeft( 16 ) )
		) ) );

export const writeRayDirFlags = ( buf, id, direction, bounceFlags ) =>
	buf.element( soa( id, RAY.DIR_FLAGS ) )
		.assign( vec4( direction, uintBitsToFloat( bounceFlags ) ) );

export const writeRayThroughputPdf = ( buf, id, throughput, pdf ) =>
	buf.element( soa( id, RAY.THROUGHPUT_PDF ) )
		.assign( vec4( throughput, pdf ) );

export const writeRayRadiance = ( buf, id, radiance ) =>
	buf.element( soa( id, RAY.RADIANCE_ALPHA ) )
		.assign( radiance );

export const readHitDistance = ( buf, id ) =>
	buf.element( soa( id, HIT.DIST_TRI_BARY ) ).x;

export const readHitTriangleIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, HIT.DIST_TRI_BARY ) ).y );

export const readHitBarycentrics = ( buf, id ) =>
	buf.element( soa( id, HIT.DIST_TRI_BARY ) ).zw;

export const readHitNormal = ( buf, id ) =>
	buf.element( soa( id, HIT.NORMAL_MAT ) ).xyz;

export const readHitMaterialIndex = ( buf, id ) =>
	uint( floatBitsToUint( buf.element( soa( id, HIT.NORMAL_MAT ) ).w ).bitAnd( 0xFFFF ) );

export const readHitMeshIndex = ( buf, id ) =>
	floatBitsToUint( buf.element( soa( id, HIT.NORMAL_MAT ) ).w ).shiftRight( 16 );

export const writeHitPacked = ( buf, id, distance, triIndex, baryU, baryV, normal, matIndex, meshIndex ) => {

	buf.element( soa( id, HIT.DIST_TRI_BARY ) )
		.assign( vec4( distance, uintBitsToFloat( triIndex ), baryU, baryV ) );
	buf.element( soa( id, HIT.NORMAL_MAT ) )
		.assign( vec4( normal, uintBitsToFloat( matIndex.bitOr( meshIndex.shiftLeft( 16 ) ) ) ) );

};

// Region 6 word packs stackDepth | transTraversals<<8 | wavelength<<16 (nm, 0=achromatic).
export const readMediumStack = ( buf, id ) => {

	const packed = buf.element( soa( id, RAY.MEDIUM_STACK ) );
	const packedInt = floatBitsToUint( packed.x );
	return {
		stackDepth: packedInt.bitAnd( 0xFF ),
		transTraversals: packedInt.shiftRight( 8 ).bitAnd( 0xFF ),
		wavelength: packedInt.shiftRight( 16 ).bitAnd( 0xFFFF ),
		ior1: packed.y,
		ior2: packed.z,
		ior3: packed.w,
	};

};

export const writeMediumStack = ( buf, id, stackDepth, transTraversals, ior1, ior2, ior3, wavelength = uint( 0 ) ) =>
	buf.element( soa( id, RAY.MEDIUM_STACK ) )
		.assign( vec4( uintBitsToFloat(
			stackDepth.bitOr( transTraversals.shiftLeft( 8 ) ).bitOr( wavelength.shiftLeft( 16 ) )
		), ior1, ior2, ior3 ) );

// Region 7: Beer-Lambert sigmaA (.xyz) of the active medium + DDFA feature-throughput (.w).
// .xyz absorption is gated on stackDepth>0; .w carries the OIDN/ASVGF see-through aux tint (see below).
// Both writers RMW-preserve the other half so sigmaA (live in glass) and featTP never clobber each other.
export const readMediumSigmaA = ( buf, id ) => buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).xyz;

export const writeMediumSigmaA = ( buf, id, sigmaA ) => {

	const keepW = buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).w.toVar();
	buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).assign( vec4( sigmaA, keepW ) );

};

// DDFA (Deferred Denoising-Feature Aux) feature-throughput: a clean per-ray tint carried through smooth
// glass/mirror, committed into the OIDN/ASVGF albedo guide at the first diffuse-enough surface. Rides the
// otherwise-dead MEDIUM_SIGMA_A.w, packed 10/10/10 into 30 bits (top 2 bits zero ⇒ the float bit-pattern is
// always finite — never NaN/Inf). LDR [0,1] per channel; final albedo re-quantizes to unorm16 anyway.
const pack30 = ( tp ) => {

	const c = clamp( tp, vec3( 0.0 ), vec3( 1.0 ) ).mul( 1023.0 ).add( 0.5 );
	return uint( c.x ).bitOr( uint( c.y ).shiftLeft( 10 ) ).bitOr( uint( c.z ).shiftLeft( 20 ) );

};

const unpack30 = ( u ) => vec3(
	float( u.bitAnd( uint( 1023 ) ) ),
	float( u.shiftRight( 10 ).bitAnd( uint( 1023 ) ) ),
	float( u.shiftRight( 20 ).bitAnd( uint( 1023 ) ) ),
).div( 1023.0 );

export const readFeatureThroughput = ( buf, id ) =>
	unpack30( floatBitsToUint( buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).w ) );

export const writeFeatureThroughput = ( buf, id, tp ) => {

	const keepXYZ = buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).xyz.toVar();
	buf.element( soa( id, RAY.MEDIUM_SIGMA_A ) ).assign( vec4( keepXYZ, uintBitsToFloat( pack30( tp ) ) ) );

};

// Per-ray bounce state packed into ORIGIN_META.w (written by writeRayOriginMeta alongside the origin):
//   perRayBounces = bits 0-7 (camera-bounce depth; the loop index can't track it once free bounces decouple it)
//   sssSteps      = bits 8-15 (SSS random-walk step counter)
//   transparentCount = bits 16-21 (alpha-passthrough counter, max 63; see maxTransparentBounces)
export const readPathBounces = ( buf, id ) =>
	int( floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_META ) ).w ).bitAnd( 0xFF ) );
export const readSssSteps = ( buf, id ) =>
	int( floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_META ) ).w ).shiftRight( 8 ).bitAnd( 0xFF ) );

export const readTransparentCount = ( buf, id ) =>
	int( floatBitsToUint( buf.element( soa( id, RAY.ORIGIN_META ) ).w ).shiftRight( 16 ).bitAnd( uint( 0x3F ) ) );

// Region 9: SSS sigmaS + Henyey-Greenstein g. sigmaS==0 marks glass (Beer-Lambert path, not random walk).
export const readSSSMedium = ( buf, id ) => {

	const v = buf.element( soa( id, RAY.SSS_SIGMA_S ) );
	return { sigmaS: v.xyz, g: v.w };

};

export const writeSSSMedium = ( buf, id, sigmaS, g ) =>
	buf.element( soa( id, RAY.SSS_SIGMA_S ) ).assign( vec4( sigmaS, g ) );
