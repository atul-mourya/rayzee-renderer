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

// Where the linear colour comes from: a packed rgba16float buffer, or a float texture read by pixel.
const SOURCES = {
	packed: /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<u32>;

fn rayzee_source( x: u32, y: u32 ) -> vec4<f32> {
	let a = ( y * params.width + x ) * 2u;
	return vec4<f32>( unpack2x16float( src[ a ] ), unpack2x16float( src[ a + 1u ] ) );
}`,
	texture: /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

fn rayzee_source( x: u32, y: u32 ) -> vec4<f32> {
	return textureLoad( src, vec2<u32>( x, y ), 0 );
}`,
};

// RGBA bytes for a picture, or four float planes (r, g, b, a) for a network that wants the curve
// unquantized. The planes take a 2.2 power, not the sRGB curve: what the AI upscaler has always fed
// its network, so its output does not move.
const OUTPUTS = {
	rgba8: /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;

fn rayzee_store( i: u32, linear: vec4<f32>, mapped: vec3<f32> ) {
	let b8 = rayzee_to_u8( rayzee_encode( mapped, params.mode ) );
	var a8 = 255u;
	if ( params.alpha == 1u ) { a8 = rayzee_to_u8( vec3<f32>( linear.a ) ).x; }
	dst[ i ] = b8.x | ( b8.y << 8u ) | ( b8.z << 16u ) | ( a8 << 24u );
}`,
	planar: /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;

fn rayzee_store( i: u32, linear: vec4<f32>, mapped: vec3<f32> ) {
	var c = clamp( mapped, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
	if ( ! rayzee_output_encoded( params.mode ) ) {
		let m = max( mapped, vec3<f32>( 0.0 ) );
		c = select( pow( m, vec3<f32>( 1.0 / 2.2 ) ), vec3<f32>( 0.0 ), m <= vec3<f32>( 0.0 ) );
	}
	let n = params.width * params.height;
	dst[ i ] = c.r;
	dst[ n + i ] = c.g;
	dst[ 2u * n + i ] = c.b;
	dst[ 3u * n + i ] = linear.a;
}`,
};

const BYTES_PER_PIXEL = { rgba8: 4, planar: 16 };

const toneMapPassWGSL = ( transformWGSL, input, output, gainWGSL ) => /* wgsl */ `
struct Params {
	width: u32,
	height: u32,
	mode: u32,
	flipY: u32,
	exposure: f32,
	saturation: f32,
	alpha: u32,
};

@group(0) @binding(2) var<uniform> params: Params;
${SOURCES[ input ]}

${transformWGSL}
${OUTPUTS[ output ]}
${gainWGSL ?? ''}

@compute @workgroup_size(8, 8)
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {
	if ( gid.x >= params.width || gid.y >= params.height ) { return; }

	var srcY = gid.y;
	if ( params.flipY == 1u ) { srcY = params.height - 1u - gid.y; }

	let linear = rayzee_source( gid.x, srcY );
	let uv = vec2<f32>( ( f32( gid.x ) + 0.5 ) / f32( params.width ), ( f32( gid.y ) + 0.5 ) / f32( params.height ) );
	let rgb = linear.rgb${gainWGSL ? ' * rayzee_gain( uv, linear.rgb, params.exposure )' : ''};
	rayzee_store( gid.y * params.width + gid.x, linear, rayzee_tone_map( rgb, params.mode, params.exposure, params.saturation ) );
}
`;

/** Uniform blocks round up to 16 bytes; the struct above is 28. */
const PARAMS_BYTES = 32;

/**
 * Tone-maps a tightly packed rgba16float buffer (two `u32` per pixel), or with `input: 'texture'` a
 * float texture read by pixel, into RGBA bytes — or with `output: 'planar'` into float planes.
 *
 * Bound to one device and one image size; `ensureSize()` reallocates when the size changes.
 */
export class PackedToneMapper {

	constructor( device, label = 'rayzee:tonemap', { input = 'packed', output = 'rgba8' } = {} ) {

		this.device = device;
		this.label = label;
		this.input = input;
		this.output = output;
		this.width = 0;
		this.height = 0;
		this._pipelines = new Map();
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
	_ensurePipeline( gain = null ) {

		const { wgsl, bindings, version } = currentShader();
		if ( this._shaderVersion !== version ) {

			this._pipelines.clear();
			this._bindings = bindings;
			this._shaderVersion = version;

		}

		const key = gain?.key ?? '';
		let pipeline = this._pipelines.get( key );
		if ( pipeline ) return pipeline;

		pipeline = this.device.createComputePipeline( {
			label: this.label,
			layout: 'auto',
			compute: {
				module: this.device.createShaderModule( { label: this.label, code: toneMapPassWGSL( wgsl, this.input, this.output, gain?.wgsl ) } ),
				entryPoint: 'main',
			},
		} );
		this._pipelines.set( key, pipeline );
		return pipeline;

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

		const bytes = width * height * BYTES_PER_PIXEL[ this.output ];
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
	 * @param {GPUBuffer|GPUTexture} src packed rgba16float, `width * height * 8` bytes, STORAGE-capable;
	 *   or with `input: 'texture'` a float texture at least `width × height`
	 * @param {object} tone
	 * @param {number} tone.exposure raw `renderer.toneMappingExposure`
	 * @param {number} tone.toneMapping Three.js ToneMapping constant
	 * @param {number} [tone.saturation=1]
	 * @param {boolean} [tone.flipY=false]
	 * @param {boolean} [tone.preserveAlpha=false] - the source's alpha, rounded as the CPU rounds it; else 255
	 * @param {{key: string, wgsl: string, entries: GPUBindGroupEntry[]}} [tone.gain] - a per-pixel gain before the
	 *   curve: WGSL defining `rayzee_gain( uv, linear, exposure ) -> f32` over bind group 1
	 * @returns {Promise<Uint8ClampedArray>} RGBA bytes, `width * height * 4`
	 */
	async toRGBA8( src, tone ) {

		return new Uint8ClampedArray( await this._run( src, tone ) );

	}

	/**
	 * The same tone map into four float planes — r, g, b, then the source's alpha — each `width * height`.
	 * Needs `output: 'planar'`.
	 * @param {GPUBuffer|GPUTexture} src - as for toRGBA8
	 * @param {object} tone - as for toRGBA8; `preserveAlpha` does not apply
	 * @returns {Promise<Float32Array>}
	 */
	async toPlanar( src, tone ) {

		return new Float32Array( await this._run( src, tone ) );

	}

	async _run( src, { exposure = 1, toneMapping = 0, saturation = 1, flipY = false, preserveAlpha = false, gain = null } = {} ) {

		if ( this.disposed ) throw new Error( 'PackedToneMapper: disposed' );
		if ( ! this._storage ) throw new Error( 'PackedToneMapper: call ensureSize() first' );

		// A config can be loaded between two readbacks, so the registry is re-checked here rather
		// than only on resize.
		const pipeline = this._ensurePipeline( gain );
		this._ensureTables();

		const { width, height } = this;
		const bytes = width * height * BYTES_PER_PIXEL[ this.output ];

		this._paramU32[ 0 ] = width;
		this._paramU32[ 1 ] = height;
		this._paramU32[ 2 ] = toneMapping >>> 0;
		this._paramU32[ 3 ] = flipY ? 1 : 0;
		this._paramF32[ 4 ] = exposure;
		this._paramF32[ 5 ] = saturation;
		this._paramU32[ 6 ] = preserveAlpha ? 1 : 0;
		this.device.queue.writeBuffer( this._params, 0, this._paramData );

		const tableEntries = [ ...this._tables.entries() ]
			.map( ( [ binding, held ] ) => ( { binding, resource: held.view } ) );

		const group = this.device.createBindGroup( {
			layout: pipeline.getBindGroupLayout( 0 ),
			entries: [
				...tableEntries,
				{ binding: 0, resource: this.input === 'texture' ? src.createView() : { buffer: src, size: width * height * 8 } },
				{ binding: 1, resource: { buffer: this._storage } },
				{ binding: 2, resource: { buffer: this._params } },
			],
		} );

		const encoder = this.device.createCommandEncoder( { label: this.label } );
		const pass = encoder.beginComputePass();
		pass.setPipeline( pipeline );
		pass.setBindGroup( 0, group );
		if ( gain ) pass.setBindGroup( 1, this.device.createBindGroup( { layout: pipeline.getBindGroupLayout( 1 ), entries: gain.entries } ) );
		pass.dispatchWorkgroups( Math.ceil( width / 8 ), Math.ceil( height / 8 ) );
		pass.end();
		encoder.copyBufferToBuffer( this._storage, 0, this._map, 0, bytes );
		this.device.queue.submit( [ encoder.finish() ] );

		await this._map.mapAsync( GPUMapMode.READ );
		const out = this._map.getMappedRange().slice( 0 );
		this._map.unmap();
		return out;

	}

	/** Frees the size-dependent buffers and keeps the pipeline, for a mapper used now and then. */
	release() {

		this._releaseBuffers();
		this.width = this.height = 0;

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
		this._pipelines.clear();

	}

}
