/**
 * The engine's tone curve in WGSL, and a pass that turns a packed rgba16float buffer into RGBA
 * bytes on the card.
 *
 * A mirror of `ToneMapCPU.js` — same curves, same order (exposure, saturation, curve, sRGB
 * transfer), same rounding. It exists because reading half-floats back and converting them in
 * JavaScript costs more than the neural upscale itself at production sizes. `bench:tonemap`
 * compares the two implementations on a real device and fails on any drift.
 *
 * ⚠️ Rounding is deliberately bug-compatible. `toneMapToRGBA8` writes `srgb * 255 + 0.5` into a
 * `Uint8ClampedArray`, which rounds again — so the CPU has always been half a level bright. WGSL's
 * `round()` is round-half-to-even like the clamped array, so `round( srgb * 255 + 0.5 )` reproduces
 * it exactly, including black staying at 0. Dropping the extra half would shift every image against
 * the OIDN and Real-ESRGAN readbacks, which still go through the CPU function.
 */

import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
} from 'three';

/**
 * WGSL functions: `rayzee_tone_map( linearRGB, mode, exposure, saturation )` and
 * `rayzee_linear_to_srgb( rgb )`, plus `rayzee_to_u8( channel )`.
 *
 * `mode` is the Three.js ToneMapping constant, interpolated in from the import above so the two
 * sides cannot disagree about which number means which curve.
 */
export const TONE_MAP_WGSL = /* wgsl */ `
const TM_NONE: u32 = ${NoToneMapping}u;
const TM_LINEAR: u32 = ${LinearToneMapping}u;
const TM_REINHARD: u32 = ${ReinhardToneMapping}u;
const TM_CINEON: u32 = ${CineonToneMapping}u;
const TM_ACES: u32 = ${ACESFilmicToneMapping}u;
const TM_AGX: u32 = ${AgXToneMapping}u;
const TM_NEUTRAL: u32 = ${NeutralToneMapping}u;

fn tm_reinhard( c: vec3<f32> ) -> vec3<f32> {
	return clamp( c / ( c + vec3<f32>( 1.0 ) ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}

fn tm_cineon( c0: vec3<f32> ) -> vec3<f32> {
	let c = max( c0 - vec3<f32>( 0.004 ), vec3<f32>( 0.0 ) );
	let v = ( c * ( 6.2 * c + vec3<f32>( 0.5 ) ) ) / ( c * ( 6.2 * c + vec3<f32>( 1.7 ) ) + vec3<f32>( 0.06 ) );
	return pow( max( v, vec3<f32>( 0.0 ) ), vec3<f32>( 2.2 ) );
}

fn tm_aces( c0: vec3<f32> ) -> vec3<f32> {
	let c = c0 / 0.6;
	let m_in = mat3x3<f32>(
		vec3<f32>( 0.59719, 0.07600, 0.02840 ),
		vec3<f32>( 0.35458, 0.90834, 0.13383 ),
		vec3<f32>( 0.04823, 0.01566, 0.83777 ) );
	let v = m_in * c;
	let a = v * ( v + vec3<f32>( 0.0245786 ) ) - vec3<f32>( 0.000090537 );
	let b = v * ( 0.983729 * v + vec3<f32>( 0.4329510 ) ) + vec3<f32>( 0.238081 );
	let m_out = mat3x3<f32>(
		vec3<f32>( 1.60475, -0.10208, -0.00327 ),
		vec3<f32>( -0.53108, 1.10813, -0.07276 ),
		vec3<f32>( -0.07367, -0.00605, 1.07602 ) );
	return clamp( m_out * ( a / b ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}

fn tm_agx( c0: vec3<f32> ) -> vec3<f32> {
	let m_in = mat3x3<f32>(
		vec3<f32>( 0.6274, 0.0691, 0.0164 ),
		vec3<f32>( 0.3293, 0.9195, 0.0880 ),
		vec3<f32>( 0.0433, 0.0113, 0.8956 ) );
	let m_agx = mat3x3<f32>(
		vec3<f32>( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3<f32>( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3<f32>( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );

	var v = m_agx * ( m_in * c0 );

	let minEv = -12.47393;
	let maxEv = 4.026069;
	v = clamp( ( log2( max( v, vec3<f32>( 1e-10 ) ) ) - vec3<f32>( minEv ) ) / ( maxEv - minEv ),
		vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );

	let x2 = v * v;
	let x4 = x2 * x2;
	v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v
		- vec3<f32>( 0.00232 );

	let m_out = mat3x3<f32>(
		vec3<f32>( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
		vec3<f32>( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
		vec3<f32>( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );
	let o = pow( max( m_out * v, vec3<f32>( 0.0 ) ), vec3<f32>( 2.2 ) );

	let m_srgb = mat3x3<f32>(
		vec3<f32>( 1.6605, -0.1246, -0.0182 ),
		vec3<f32>( -0.5876, 1.1329, -0.1006 ),
		vec3<f32>( -0.0728, -0.0083, 1.1187 ) );
	return clamp( m_srgb * o, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}

fn tm_neutral( c0: vec3<f32> ) -> vec3<f32> {
	let startCompression = 0.8 - 0.04;
	let desaturation = 0.15;

	let x = min( c0.r, min( c0.g, c0.b ) );
	var offset = 0.04;
	if ( x < 0.08 ) { offset = x - 6.25 * x * x; }
	var c = c0 - vec3<f32>( offset );

	let peak = max( c.r, max( c.g, c.b ) );
	if ( peak < startCompression ) { return c; }

	let d = 1.0 - startCompression;
	let newPeak = 1.0 - d * d / ( peak + d - startCompression );
	c = c * ( newPeak / peak );
	let gFactor = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
	return mix( c, vec3<f32>( newPeak ), gFactor );
}

// Three.js clamps the fragment output with max(0) before tone mapping, so the curves never see a
// negative channel. The saturation grade drives channels below zero on much of a typical frame, and
// AgX/Neutral mix negatives across channels instead of clipping them.
fn rayzee_tone_curve( color: vec3<f32>, mode: u32 ) -> vec3<f32> {
	let c = max( color, vec3<f32>( 0.0 ) );
	if ( mode == TM_REINHARD ) { return tm_reinhard( c ); }
	if ( mode == TM_CINEON ) { return tm_cineon( c ); }
	if ( mode == TM_ACES ) { return tm_aces( c ); }
	if ( mode == TM_AGX ) { return tm_agx( c ); }
	if ( mode == TM_NEUTRAL ) { return tm_neutral( c ); }
	return clamp( c, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
}

fn rayzee_tone_map( linearRGB: vec3<f32>, mode: u32, exposure: f32, saturation: f32 ) -> vec3<f32> {
	// Three.js returns early for NoToneMapping without applying exposure, so a readback that applied
	// it would paint brighter than the viewport it replaces.
	var c = linearRGB * select( exposure, 1.0, mode == TM_NONE );
	if ( saturation != 1.0 ) {
		let luma = vec3<f32>( dot( c, vec3<f32>( 0.2126, 0.7152, 0.0722 ) ) );
		c = luma + ( c - luma ) * saturation;
	}
	return rayzee_tone_curve( c, mode );
}

fn rayzee_linear_to_srgb( c: vec3<f32> ) -> vec3<f32> {
	return select(
		1.055 * pow( max( c, vec3<f32>( 0.0 ) ), vec3<f32>( 1.0 / 2.4 ) ) - vec3<f32>( 0.055 ),
		12.92 * c,
		c <= vec3<f32>( 0.0031308 ) );
}

fn rayzee_to_u8( srgb: vec3<f32> ) -> vec3<u32> {
	return vec3<u32>( clamp( round( srgb * 255.0 + vec3<f32>( 0.5 ) ), vec3<f32>( 0.0 ), vec3<f32>( 255.0 ) ) );
}
`;

const PACKED_WGSL = /* wgsl */ `
struct Params {
	width: u32,
	height: u32,
	mode: u32,
	flipY: u32,
	exposure: f32,
	saturation: f32,
};

@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

${TONE_MAP_WGSL}

@compute @workgroup_size(8, 8)
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {
	if ( gid.x >= params.width || gid.y >= params.height ) { return; }

	var srcY = gid.y;
	if ( params.flipY == 1u ) { srcY = params.height - 1u - gid.y; }

	let a = ( srcY * params.width + gid.x ) * 2u;
	let rg = unpack2x16float( src[ a ] );
	let ba = unpack2x16float( src[ a + 1u ] );

	let mapped = rayzee_tone_map( vec3<f32>( rg.x, rg.y, ba.x ), params.mode, params.exposure, params.saturation );
	let b8 = rayzee_to_u8( rayzee_linear_to_srgb( mapped ) );
	dst[ gid.y * params.width + gid.x ] = b8.x | ( b8.y << 8u ) | ( b8.z << 16u ) | ( 255u << 24u );
}
`;

/** Uniform blocks round up to 16 bytes; the struct above is 24. */
const PARAMS_BYTES = 32;

/**
 * Tone-maps a tightly packed rgba16float buffer (two `u32` per pixel) into RGBA bytes.
 *
 * Bound to one device and one image size; `ensureSize()` reallocates when the size changes.
 */
export class PackedToneMapper {

	constructor( device, label = 'rayzee:tonemap' ) {

		this.device = device;
		this.label = label;
		this.width = 0;
		this.height = 0;
		this._pipeline = null;
		this._storage = null;
		this._map = null;
		this._params = null;
		this._paramData = new ArrayBuffer( PARAMS_BYTES );
		this._paramU32 = new Uint32Array( this._paramData );
		this._paramF32 = new Float32Array( this._paramData );
		this.disposed = false;

	}

	ensureSize( width, height ) {

		if ( this.width === width && this.height === height && this._pipeline ) return;

		this._releaseBuffers();

		const bytes = width * height * 4;
		this._storage = this.device.createBuffer( {
			label: `${this.label}-out`,
			size: bytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		} );
		this._map = this.device.createBuffer( {
			label: `${this.label}-map`,
			size: bytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		} );
		this._params = this.device.createBuffer( {
			label: `${this.label}-params`,
			size: PARAMS_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		} );

		this._pipeline ??= this.device.createComputePipeline( {
			label: this.label,
			layout: 'auto',
			compute: { module: this.device.createShaderModule( { label: this.label, code: PACKED_WGSL } ), entryPoint: 'main' },
		} );

		this.width = width;
		this.height = height;

	}

	/**
	 * @param {GPUBuffer} src packed rgba16float, `width * height * 8` bytes, STORAGE-capable
	 * @param {object} tone
	 * @param {number} tone.exposure raw `renderer.toneMappingExposure`
	 * @param {number} tone.toneMapping Three.js ToneMapping constant
	 * @param {number} [tone.saturation=1]
	 * @param {boolean} [tone.flipY=false]
	 * @returns {Promise<Uint8ClampedArray>} RGBA bytes, `width * height * 4`
	 */
	async toRGBA8( src, { exposure = 1, toneMapping = 0, saturation = 1, flipY = false } = {} ) {

		if ( this.disposed ) throw new Error( 'PackedToneMapper: disposed' );
		if ( ! this._pipeline ) throw new Error( 'PackedToneMapper: call ensureSize() first' );

		const { width, height } = this;

		this._paramU32[ 0 ] = width;
		this._paramU32[ 1 ] = height;
		this._paramU32[ 2 ] = toneMapping >>> 0;
		this._paramU32[ 3 ] = flipY ? 1 : 0;
		this._paramF32[ 4 ] = exposure;
		this._paramF32[ 5 ] = saturation;
		this.device.queue.writeBuffer( this._params, 0, this._paramData );

		const group = this.device.createBindGroup( {
			layout: this._pipeline.getBindGroupLayout( 0 ),
			entries: [
				{ binding: 0, resource: { buffer: src, size: width * height * 8 } },
				{ binding: 1, resource: { buffer: this._storage } },
				{ binding: 2, resource: { buffer: this._params } },
			],
		} );

		const encoder = this.device.createCommandEncoder( { label: this.label } );
		const pass = encoder.beginComputePass();
		pass.setPipeline( this._pipeline );
		pass.setBindGroup( 0, group );
		pass.dispatchWorkgroups( Math.ceil( width / 8 ), Math.ceil( height / 8 ) );
		pass.end();
		encoder.copyBufferToBuffer( this._storage, 0, this._map, 0, width * height * 4 );
		this.device.queue.submit( [ encoder.finish() ] );

		await this._map.mapAsync( GPUMapMode.READ );
		const bytes = new Uint8ClampedArray( this._map.getMappedRange().slice( 0 ) );
		this._map.unmap();
		return bytes;

	}

	_releaseBuffers() {

		this._storage?.destroy();
		this._map?.destroy();
		this._params?.destroy();
		this._storage = null;
		this._map = null;
		this._params = null;

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this._releaseBuffers();
		this._pipeline = null;

	}

}
