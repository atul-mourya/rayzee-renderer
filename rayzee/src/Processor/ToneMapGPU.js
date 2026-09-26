/**
 * The engine's view transform in WGSL, and a pass that turns a packed rgba16float buffer into
 * display bytes on the card.
 *
 * A mirror of `ToneMapCPU.js` — same curves, same order (exposure, saturation, curve, transfer),
 * same rounding. It exists because reading half-floats back and converting them in JavaScript
 * costs more than the neural upscale itself at production sizes. `bench:upscale` compares the two
 * implementations on a real device and fails on any drift.
 *
 * Both sides are generated from `../Color/ViewTransforms.js`, so a view baked from an OCIO config
 * reaches this pass without anything here being edited — the shader is rebuilt when the registry
 * moves, and each table-backed transform gets its own 3D texture binding.
 *
 * ⚠️ Rounding is deliberately bug-compatible. `toneMapToRGBA8` writes `srgb * 255 + 0.5` into a
 * `Uint8ClampedArray`, which rounds again, so the CPU has always been half a level bright. WGSL's
 * `round()` is round-half-to-even like the clamped array, so `round( srgb * 255 + 0.5 )`
 * reproduces it exactly, including black staying at 0.
 */

import { buildToneMapWGSL, getRegistryVersion } from '../Color/ViewTransforms.js';

/** The caller owns bindings 0-2; tables start after them. */
const TABLE_GROUP = 0;
const FIRST_TABLE_BINDING = 3;

function currentShader() {

	const { wgsl, bindings } = buildToneMapWGSL( { group: TABLE_GROUP, firstBinding: FIRST_TABLE_BINDING } );
	return { wgsl, bindings, version: getRegistryVersion() };

}

/**
 * `rayzee_tone_map( linearRGB, mode, exposure, saturation )`, `rayzee_encode( mapped, mode )` and
 * `rayzee_to_u8( c )` for the registry as it stands right now.
 *
 * A snapshot, not a live value: `PackedToneMapper` regenerates its own copy when the registry
 * changes. Exported for tests and for a host embedding the curve in its own pass.
 */
export const TONE_MAP_WGSL = currentShader().wgsl;

const packedWGSL = transformWGSL => /* wgsl */ `
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

${transformWGSL}

@compute @workgroup_size(8, 8)
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {
	if ( gid.x >= params.width || gid.y >= params.height ) { return; }

	var srcY = gid.y;
	if ( params.flipY == 1u ) { srcY = params.height - 1u - gid.y; }

	let a = ( srcY * params.width + gid.x ) * 2u;
	let rg = unpack2x16float( src[ a ] );
	let ba = unpack2x16float( src[ a + 1u ] );

	let mapped = rayzee_tone_map( vec3<f32>( rg.x, rg.y, ba.x ), params.mode, params.exposure, params.saturation );
	let b8 = rayzee_to_u8( rayzee_encode( mapped, params.mode ) );
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
		this._shaderVersion = - 1;
		this._bindings = [];
		this._tables = new Map();
		this.disposed = false;

	}

	/**
	 * Rebuild the pipeline when the registry has moved.
	 *
	 * A config loaded after this pass was first compiled adds curves the compiled shader has never
	 * heard of. Without this the readback silently falls through to the clamp and a saved image
	 * comes back untone-mapped.
	 */
	_ensurePipeline() {

		const { wgsl, bindings, version } = currentShader();
		if ( this._pipeline && this._shaderVersion === version ) return;

		this._bindings = bindings;
		this._shaderVersion = version;
		this._pipeline = this.device.createComputePipeline( {
			label: this.label,
			layout: 'auto',
			compute: {
				module: this.device.createShaderModule( { label: this.label, code: packedWGSL( wgsl ) } ),
				entryPoint: 'main',
			},
		} );

	}

	/** One 3D texture per table-backed transform, uploaded once and kept until it is replaced. */
	_ensureTables() {

		const live = new Set();

		for ( const { index, transform } of this._bindings ) {

			const { data, size } = transform.table;
			live.add( index );

			const held = this._tables.get( index );
			if ( held && held.data === data ) continue;

			held?.texture.destroy();

			const texture = this.device.createTexture( {
				label: `${this.label}-${transform.wgslConst}`,
				size: [ size, size, size ],
				dimension: '3d',
				format: 'rgba16float',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			} );

			this.device.queue.writeTexture(
				{ texture },
				data,
				{ bytesPerRow: size * 8, rowsPerImage: size },
				[ size, size, size ]
			);

			this._tables.set( index, { texture, data, view: texture.createView() } );

		}

		for ( const [ index, held ] of this._tables ) {

			if ( ! live.has( index ) ) {

				held.texture.destroy();
				this._tables.delete( index );

			}

		}

	}

	ensureSize( width, height ) {

		this._ensurePipeline();
		this._ensureTables();

		if ( this.width === width && this.height === height && this._storage ) return;

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
		if ( ! this._storage ) throw new Error( 'PackedToneMapper: call ensureSize() first' );

		// A config can be loaded between two readbacks, so the registry is re-checked here rather
		// than only on resize.
		this._ensurePipeline();
		this._ensureTables();

		const { width, height } = this;

		this._paramU32[ 0 ] = width;
		this._paramU32[ 1 ] = height;
		this._paramU32[ 2 ] = toneMapping >>> 0;
		this._paramU32[ 3 ] = flipY ? 1 : 0;
		this._paramF32[ 4 ] = exposure;
		this._paramF32[ 5 ] = saturation;
		this.device.queue.writeBuffer( this._params, 0, this._paramData );

		const tableEntries = [ ...this._tables.entries() ]
			.map( ( [ binding, held ] ) => ( { binding, resource: held.view } ) );

		const group = this.device.createBindGroup( {
			layout: this._pipeline.getBindGroupLayout( 0 ),
			entries: [
				...tableEntries,
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
		for ( const held of this._tables.values() ) held.texture.destroy();
		this._tables.clear();
		this._pipeline = null;

	}

}
