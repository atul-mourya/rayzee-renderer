import { EventDispatcher, HalfFloatType, RGBAFormat, NearestFilter, NoColorSpace, ClampToEdgeWrapping } from 'three';
import { ExternalTexture } from 'three/webgpu';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'oidn' );

// The tile alignment oidn-web's own fitTileDimension uses (its tileScheduler.js).
const OIDN_TILE_ALIGNMENT = 16;

let _initUNetFromURL = null;
async function getInitUNetFromURL() {

	if ( ! _initUNetFromURL ) {

		_initUNetFromURL = ( await import( 'oidn-web' ) ).initUNetFromURL;

	}

	return _initUNetFromURL;

}

import { getAssetConfig } from '../AssetConfig.js';

const MODEL_CONFIG = {
	// No cleanAux flag in oidn-web, so the blob is it — and it must match what setCleanAuxNormal
	// feeds the aux MRT: an `alb_nrm` model wants the point-sampled normal, a `calb_cnrm` model
	// wants the accumulated one. `cleanAux` is carried here rather than inferred from the tier
	// name, which stopped being possible once a tier other than `fast` used a noisy-aux model.
	//
	// `fast-clean` is the same topology and channel width as `fast` (both 641 KB, widest conv 64)
	// so it costs the same to run, and only differs in being trained for a clean guide.
	QUALITY_MODELS: {
		fast: { model: 'rt_hdr_alb_nrm_small', cleanAux: false },
		'fast-clean': { model: 'rt_hdr_calb_cnrm_small', cleanAux: true },
		balance: { model: 'rt_hdr_calb_cnrm', cleanAux: true },
		high: { model: 'rt_hdr_calb_cnrm_large', cleanAux: true }
	},
	DEFAULT_OPTIONS: {
		enableOIDN: true,
		oidnQuality: 'fast',
		// A cap, not a fixed size — the effective tile is min( max( w, h ), this ), so a frame
		// that fits in one tile pays no overlap padding at all. Every tile otherwise runs at
		// tileSize + 2*overlap (96px, 112 for _large): at 1024²/high, 4x512 tiles measured
		// 422ms against 229ms for one 1024 tile. 1024 caps the one-time activation
		// allocation at ~430MB; beyond it larger frames tile and stay bounded.
		tileSize: 1024
	}
};

// Stands in for OIDN's inputScale, which oidn-web only applies on its CPU path — the GPUBuffer
// path leaves the uniform at 1.0. Equivalent because oidn-web does PUForward(col*inputScale) in
// and PUInverse(..)/inputScale out, so pre-multiplying here and dividing it back out of the
// output exposure round-trips.
//
// The scale is produced and consumed entirely on the GPU. Averaging it on the CPU meant copying
// the whole colour buffer back (16 MB at 1024²) and running a per-pixel log loop on the main
// thread, and the `await` on the map drained the queue before the UNet could start.
const OIDN_AUTOEXPOSURE_KEY = 0.18;
const LUM_WG_SIZE = 256;
const LUM_GROUPS = 256;

const INPUT_SCALE_WGSL = /* wgsl */`
const WG: u32 = ${LUM_WG_SIZE}u;
const GROUPS: u32 = ${LUM_GROUPS}u;

@group(0) @binding(0) var<storage, read> col: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> partials: array<f32>;
@group(0) @binding(2) var<uniform> params: vec4<u32>;
@group(0) @binding(3) var<storage, read_write> scaleOut: array<f32>;

var<workgroup> sdata: array<f32, WG>;

fn treeSum( lid: u32 ) {
	var s: u32 = WG >> 1u;
	loop {
		if ( s == 0u ) { break; }
		if ( lid < s ) { sdata[ lid ] = sdata[ lid ] + sdata[ lid + s ]; }
		workgroupBarrier();
		s = s >> 1u;
	}
}

@compute @workgroup_size(${LUM_WG_SIZE})
fn reduce( @builtin(global_invocation_id) gid: vec3<u32>,
		   @builtin(local_invocation_id) lid: vec3<u32>,
		   @builtin(workgroup_id) wid: vec3<u32> ) {

	let total = params.x;
	var sum = 0.0;
	var i = gid.x;
	loop {
		if ( i >= total ) { break; }
		let c = col[ i ].xyz;
		let lum = 0.212671 * c.r + 0.71516 * c.g + 0.072169 * c.b;
		sum = sum + log2( max( lum, 0.0 ) + 0.0001 );
		i = i + WG * GROUPS;
	}

	sdata[ lid.x ] = sum;
	workgroupBarrier();
	treeSum( lid.x );

	if ( lid.x == 0u ) { partials[ wid.x ] = sdata[ 0 ]; }
}

@compute @workgroup_size(${LUM_WG_SIZE})
fn finalize( @builtin(local_invocation_id) lid: vec3<u32> ) {

	var v = 0.0;
	if ( lid.x < GROUPS ) { v = partials[ lid.x ]; }
	sdata[ lid.x ] = v;
	workgroupBarrier();
	treeSum( lid.x );

	if ( lid.x == 0u ) {
		let scale = ${OIDN_AUTOEXPOSURE_KEY} / exp2( sdata[ 0 ] / f32( params.x ) );
		// Mirrors the CPU guard: a non-finite or non-positive scale means no scaling at all.
		scaleOut[ 0 ] = select( 1.0, scale, scale > 0.0 && scale < 3.4e38 );
	}
}
`;

const COLOR_SCALE_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> col: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> scaleBuf: array<f32>;

@compute @workgroup_size(64)
fn main( @builtin(global_invocation_id) gid: vec3<u32>,
		 @builtin(num_workgroups) nwg: vec3<u32> ) {
	let i = gid.y * nwg.x * 64u + gid.x;
	if ( i >= arrayLength( &col ) ) { return; }
	let c = col[ i ];
	col[ i ] = vec4<f32>( c.xyz * scaleBuf[ 0 ], c.w );
}
`;

const SCALE_WG_SIZE = 64;
// 1D would exceed maxComputeWorkgroupsPerDimension (65535) past ~2048², so the dispatch is 2D.
const SCALE_MAX_WG_X = 32768;

// Denoised linear float -> a picture the pipeline can sample, on the card. The result keeps the
// renderer's own units: no exposure, no grade, no tone curve. Compositor and the renderer's output
// pass apply those to this picture exactly as they do to the raw one.
const UNPACK_WG_SIZE = 16;
const UNPACK_PARAMS_BYTES = 32;

const UNPACK_WGSL = /* wgsl */`
struct UnpackParams {
	srcWidth: u32,
	tileX: u32,
	tileY: u32,
	tileW: u32,
	tileH: u32,
	pad0: u32,
	pad1: u32,
	pad2: u32,
};

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> P: UnpackParams;
@group(0) @binding(2) var<storage, read> scaleBuf: array<f32>;
@group(0) @binding(3) var<storage, read> inColor: array<vec4<f32>>;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(${UNPACK_WG_SIZE}, ${UNPACK_WG_SIZE})
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {

	if ( gid.x >= P.tileW || gid.y >= P.tileH ) { return; }

	let px = P.tileX + gid.x;
	let py = P.tileY + gid.y;
	let si = py * P.srcWidth + px;

	// scaleBuf is the autoexposure factor the input was multiplied by; dividing it out returns
	// the renderer's units. Alpha rides through from the path tracer so a transparent background
	// survives the denoise.
	textureStore( dst, vec2<u32>( px, py ), vec4<f32>( src[ si ].xyz / scaleBuf[ 0 ], inColor[ si ].w ) );
}
`;

export class OIDNDenoiser extends EventDispatcher {

	/**
	 * @param {import('three/webgpu').WebGPURenderer} renderer
	 * @param {Object} [options]
	 */
	constructor( renderer, options = {} ) {

		super();

		if ( ! renderer ) throw new Error( 'OIDNDenoiser requires a renderer' );

		this.renderer = renderer;
		// The size everything is measured in. The denoiser paints no canvas: its result is a
		// picture handed to the pipeline, so this is the only size it knows.
		this._renderWidth = renderer.domElement.width;
		this._renderHeight = renderer.domElement.height;

		// WebGPU GPU-native path (no CPU readback for inputs)
		// backendParams: () => { device: GPUDevice, adapterInfo: GPUAdapterInfo|null }
		// getGPUTextures: () => { color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }
		this.backendParamsGetter = options.backendParams || null;
		this.getGPUTextures = options.getGPUTextures || null;
		this.gpuDevice = null;

		// Cached GPU storage buffers for texture→buffer copies (reused across denoise calls)
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputBufferSize = { width: 0, height: 0 };
		// Shared pad-strip buffer for non-256-aligned widths. Reused across
		// color/albedo/normal copies within the same encoder (WebGPU command
		// order guarantees the overwrites are serialized).
		this._gpuInputPadBuffer = null;
		this._gpuInputPaddedRowBytes = 0;
		// The autoexposure scale never leaves the GPU — _applyColorScale and the output pack
		// both read _inputScaleBuffer directly.
		this._lumReducePipeline = null;
		this._lumFinalizePipeline = null;
		this._lumLayout = null;
		this._lumBindGroup = null;
		this._lumPartials = null;
		this._lumParams = null;
		this._inputScaleBuffer = null;

		this._colorScalePipeline = null;
		this._colorScaleBindGroup = null;

		// The denoised picture, written on the card and handed to the pipeline like any other
		// stage's output. `_outTexture` wraps `_outGPUTexture` so three.js can sample it.
		this._unpackPipeline = null;
		this._outGPUTexture = null;
		this._outTexture = null;
		this._outTexSize = { width: 0, height: 0 };

		// Merge options with defaults
		this.config = { ...MODEL_CONFIG.DEFAULT_OPTIONS, ...options };

		// Destructure for easier access
		this.enabled = this.config.enableOIDN;
		this.quality = this.config.oidnQuality;
		this.maxTileSize = this.config.tileSize;
		// The size actually baked into the live UNet, so a change forces a rebuild.
		this._activeTileSize = 0;

		// State management
		this.state = {
			isDenoising: false,
			isLoading: false,
			abortController: null
		};

		// Tiles written into the output picture by the run in flight; zero means the library gave
		// no per-tile progress and the whole image has to be written at the end.
		this._tilesWritten = 0;

		// Identifies the live run. A run superseded by abort() must not clear the state its
		// successor already owns.
		this._runId = 0;
		// The output picture holds a denoised frame the pipeline can show.
		this._hasOutput = false;
		// Wall time of the last completed denoise, for cadence policy. 0 until one finishes.
		this.lastDenoiseMs = 0;

		this.currentTZAUrl = null;
		this.unet = null;
		// A start() requested while the UNet is still loading is deferred here and fired
		// once loading finishes, instead of being silently dropped.
		this._pendingStart = false;
		this._pendingStartContinuous = false;
		// A weight load requested while another is in flight, to run when that one finishes.
		this._reloadPending = false;

		// Initialize asynchronously
		this._initialize().catch( error => {

			log.error( 'init failed:', error );
			this.dispatchEvent( { type: 'error', error } );

		} );

	}

	async _initialize() {

		try {

			await this._setupUNetDenoiser();

		} catch ( error ) {

			throw new Error( `Initialization failed: ${error.message}` );

		}

	}

	/**
	 * Whether the tier's model expects a clean (accumulated) auxiliary guide rather than a
	 * point-sampled one. The aux MRT has to be fed to match, or the guide fights the weights.
	 * @param {string} [quality] defaults to the active tier
	 * @returns {boolean}
	 */
	expectsCleanAux( quality = this.quality ) {

		const { QUALITY_MODELS } = MODEL_CONFIG;
		return ( QUALITY_MODELS[ quality ] || QUALITY_MODELS.balance ).cleanAux;

	}

	/**
	 * Engine, precision, model, kernel, tile state and resource counts from the live UNet.
	 * @returns {Object|null} null before the weights load
	 */
	getRuntimeInfo() {

		return this.unet?.getRuntimeInfo?.() ?? null;

	}

	/**
	 * Arms per-layer GPU timestamping for the next denoise. Needs `timestamp-query` on the
	 * device; one denoise only, so call it again for each capture.
	 * @returns {boolean} whether the capture was armed
	 */
	profileNextDenoise() {

		return this.unet?.profileNextExecution?.() ?? false;

	}

	/**
	 * Per-layer GPU timings from the last denoise armed by {@link profileNextDenoise}.
	 * @returns {Promise<Object|null>}
	 */
	async getLastDenoiseProfile() {

		return ( await this.unet?.getLastExecutionProfile?.() ) ?? null;

	}

	/**
	 * Largest tile that still covers the frame, bounded by the configured cap. One tile means
	 * zero overlap, which is the cheapest configuration oidn-web has.
	 * @returns {number}
	 */
	_resolveTileSize() {

		const longest = Math.max( this._renderWidth, this._renderHeight );
		if ( ! longest ) return this.maxTileSize;

		// Rounded up to the model's 16-pixel alignment, not clamped to the exact frame. The
		// library's own fitTileDimension aligns the size up and then clamps it back to whatever
		// cap it is handed, so handing it the raw frame size hands it an unaligned tile — and an
		// unaligned tile measured 4x the cost of the whole denoise: 336 ms at 900x900 against
		// 86 ms once aligned, with 896x896 unaffected either way.
		const aligned = Math.ceil( longest / OIDN_TILE_ALIGNMENT ) * OIDN_TILE_ALIGNMENT;
		if ( aligned <= this.maxTileSize ) return aligned;

		// The cap has to be aligned too, or a cap somebody picked by hand lands on the same slow
		// path. Rounded down, so it never rises above what the caller asked for.
		return Math.max( OIDN_TILE_ALIGNMENT, Math.floor( this.maxTileSize / OIDN_TILE_ALIGNMENT ) * OIDN_TILE_ALIGNMENT );

	}

	async _setupUNetDenoiser() {

		if ( this.state.isLoading ) {

			// Dropping this would leave `quality` describing weights that were never fetched, and
			// nothing would ever fetch them. Reachable on every render now that the refreshes and
			// the finished image use different tiers. Flag it; the running load picks it up.
			this._reloadPending = true;
			return;

		}

		do {

			this._reloadPending = false;
			this.state.isLoading = true;

			try {

				await this._loadUNetWeights();

			} catch ( error ) {

				log.error( 'UNet weights failed to load:', error );
				this.dispatchEvent( { type: 'error', error: new Error( `Denoiser loading failed: ${error.message}` ) } );

			} finally {

				this.state.isLoading = false;

			}

		} while ( this._reloadPending );

		// Fire a start() that arrived mid-load. Guard on unet+enabled so a failed load
		// or a disable during loading doesn't kick off a denoise. Outside the loop, so a
		// no-op reload still releases it — it used to be stranded by the early return below.
		if ( this._pendingStart && this.unet && this.enabled ) {

			const continuous = this._pendingStartContinuous;
			this._pendingStart = false;
			this._pendingStartContinuous = false;
			this.start( { continuous } );

		}

	}

	async _loadUNetWeights() {

		const tzaUrl = this._generateTzaUrl();
		const tileSize = this._resolveTileSize();

		// maxTileSize is a constructor arg, so comparing the URL alone left tileSize changes inert.
		if ( this.currentTZAUrl === tzaUrl && this._activeTileSize === tileSize && this.unet ) return;

		this.dispatchEvent( { type: 'loading', message: 'Loading UNet denoiser...' } );

		// Dispose previous instance
		if ( this.unet ) {

			this.unet.dispose();
			this.unet = null;

		}

		// GPU-native path: share the existing GPUDevice so oidn-web uses the
		// same device as the renderer — no second device, no CPU roundtrip for inputs.
		let backendParams;
		if ( this.backendParamsGetter ) {

			const params = this.backendParamsGetter();
			this.gpuDevice = params?.device ?? null;
			backendParams = params?.device ? params : undefined;

		}

		const initFn = await getInitUNetFromURL();
		this.unet = await initFn( tzaUrl, backendParams, {
			aux: true,
			hdr: true,
			maxTileSize: tileSize,
			// Adaptive tiling ignores maxTileSize, starts at 384, and cannot see that overlap
			// padding only vanishes once a tile covers the image — so it settles smaller.
			dynamicTile: false
		} );

		this.currentTZAUrl = tzaUrl;
		this._activeTileSize = tileSize;
		this.dispatchEvent( { type: 'loaded' } );
		log.debug( 'UNet weights loaded:', tzaUrl );

	}

	_generateTzaUrl() {

		const { oidnWeightsBaseUrl } = getAssetConfig();
		const { QUALITY_MODELS } = MODEL_CONFIG;
		const tier = QUALITY_MODELS[ this.quality ] || QUALITY_MODELS.balance;
		return `${oidnWeightsBaseUrl}${tier.model}.tza`;

	}

	// Public configuration methods with validation
	async updateConfiguration( newConfig ) {

		const hasChanged = Object.keys( newConfig ).some( key => this.config[ key ] !== newConfig[ key ] );

		if ( ! hasChanged ) return;

		// Update configuration
		Object.assign( this.config, newConfig );
		this.quality = this.config.oidnQuality;
		this.maxTileSize = this.config.tileSize;

		// Reload denoiser if necessary
		await this._setupUNetDenoiser();

	}

	async updateQuality( value ) {

		if ( ! Object.prototype.hasOwnProperty.call( MODEL_CONFIG.QUALITY_MODELS, value ) ) {

			throw new Error( `Invalid quality setting: ${value}. Must be one of: ${Object.keys( MODEL_CONFIG.QUALITY_MODELS ).join( ', ' )}` );

		}

		await this.updateConfiguration( { oidnQuality: value } );

	}

	/**
	 * @param {Object}  [options]
	 * @param {boolean} [options.continuous=false] - A cadence run rather than the final denoise.
	 *   Tagged onto the start/end events so consumers can tell a background refresh from the
	 *   one-shot denoise that ends a render.
	 */
	async start( { continuous = false } = {} ) {

		if ( ! this.enabled || this.state.isDenoising ) {

			return false;

		}

		// The tile tracks the frame size, so a resolution change since the last build has to be
		// rebuilt into the UNet before denoising — otherwise the frame tiles when it need not.
		if ( this.unet && ! this.state.isLoading && this._activeTileSize !== this._resolveTileSize() ) {

			await this._setupUNetDenoiser();

		}

		// UNet weights still loading — defer the start (fired from _setupUNetDenoiser's
		// finally) rather than silently dropping this frame's denoise request.
		if ( this.state.isLoading ) {

			// A deferred cadence run must stay a cadence run, or it surfaces as the final
			// denoise: tile border, status badge, upscaler chain. A non-cadence start joining
			// the same deferral wins.
			this._pendingStartContinuous = this._pendingStart
				? this._pendingStartContinuous && continuous
				: continuous;
			this._pendingStart = true;
			return false;

		}

		this.dispatchEvent( { type: 'start', continuous } );

		const startTime = performance.now();
		const success = await this.execute( continuous );

		if ( success ) {

			this.renderer?.resetState?.();

			this.lastDenoiseMs = performance.now() - startTime;
			log.debug( `denoise complete in ${fmt.ms( this.lastDenoiseMs )} · quality ${this.quality}` );

		}

		return success;

	}

	async execute( continuous = false ) {

		if ( ! this.enabled || ! this.unet ) return false;

		// Create abort controller for this execution
		const runId = ++ this._runId;
		this.state.abortController = new AbortController();
		this.state.isDenoising = true;

		try {

			// The GPU path bails out early — no textures yet, no device — by returning false, and
			// a caller that read that as success published a picture nothing had written to.
			return await this._executeUNetGPU( continuous ) !== false;

		} catch ( error ) {

			if ( error.name === 'AbortError' ) {

				log.debug( 'denoise aborted' );

			} else {

				log.error( 'denoise error:', error );

			}

			return false;

		} finally {

			// An aborted run resolves after its replacement has already started; clearing the
			// shared state then would strand the live run without an abort controller.
			if ( this._runId === runId ) {

				this.state.isDenoising = false;
				this.state.abortController = null;

			}

			this.dispatchEvent( { type: 'end', continuous } );

		}

	}

	/**
	 * GPU-native execution path. Copies render target textures into GPU storage buffers
	 * via copyTextureToBuffer (GPU-only, no CPU roundtrip), then passes those buffers to
	 * oidn-web's well-tested GPUBuffer path.
	 *
	 * Note: oidn-web's GPUTexture input path produces NaN outputs — using GPUBuffer instead.
	 */
	async _executeUNetGPU( continuous = false ) {

		const width = this._renderWidth;
		const height = this._renderHeight;

		if ( ! this.getGPUTextures ) {

			log.warn( 'GPU mode enabled but getGPUTextures not provided' );
			return false;

		}

		const textures = this.getGPUTextures();
		if ( ! textures?.color ) {

			log.warn( 'GPU textures not ready yet' );
			return false;

		}

		const device = this.gpuDevice;
		if ( ! device ) {

			log.warn( 'gpuDevice not available' );
			return false;

		}

		// Ensure storage buffers are sized correctly (recreate on resolution change)
		this._ensureGPUInputBuffers( width, height );

		// Copy render target textures → tightly packed GPU storage buffers for oidn-web.
		// copyTextureToBuffer requires bytesPerRow to be a multiple of 256. When the tight
		// row size (width * 16) isn't aligned, copy via a shared pre-allocated padded buffer
		// (see _ensureGPUInputBuffers) then strip padding row-by-row. The pad buffer is
		// reused across color/albedo/normal — safe because WebGPU serializes commands
		// within a single encoder.
		const encoder = device.createCommandEncoder( { label: 'oidn-tex-to-buf' } );
		const tightRowBytes = width * 16; // rgba32float
		const paddedRowBytes = this._gpuInputPaddedRowBytes;
		const needsPadStrip = paddedRowBytes > tightRowBytes;
		const padBuf = this._gpuInputPadBuffer;

		const copyTex = ( tex, tightBuf ) => {

			if ( ! needsPadStrip ) {

				encoder.copyTextureToBuffer(
					{ texture: tex, mipLevel: 0 },
					{ buffer: tightBuf, offset: 0, bytesPerRow: tightRowBytes, rowsPerImage: height },
					{ width, height, depthOrArrayLayers: 1 }
				);

			} else {

				encoder.copyTextureToBuffer(
					{ texture: tex, mipLevel: 0 },
					{ buffer: padBuf, offset: 0, bytesPerRow: paddedRowBytes, rowsPerImage: height },
					{ width, height, depthOrArrayLayers: 1 }
				);

				for ( let row = 0; row < height; row ++ ) {

					encoder.copyBufferToBuffer( padBuf, row * paddedRowBytes, tightBuf, row * tightRowBytes, tightRowBytes );

				}

			}

		};

		copyTex( textures.color, this._gpuInputBuffers.color );
		copyTex( textures.albedo, this._gpuInputBuffers.albedo );
		// The normal stays [0,1]-encoded. This contradicts OIDN's API ("must be in the [-1,1]
		// range") but is right for this port: OIDN's own getNormal (cpu_input_process.isph) does
		// `value*0.5+0.5` before the network, and oidn-web omits that remap. Decoding to [-1,1]
		// measured 0.878 -> 2.439 denoise ratio at 64 spp. Do not "fix" it.
		copyTex( textures.normal, this._gpuInputBuffers.normal );

		device.queue.submit( [ encoder.finish() ] );

		// Autoexposure and the pre-multiply it drives, both on the GPU and both queued behind the
		// copies above. Nothing is awaited here — an await would drain the queue before the UNet.
		this._computeInputScale( device, width * height );
		this._applyColorScale( device, width * height );

		// Pass GPU storage buffers to oidn-web (GPUBuffer path, well-tested)
		const config = {
			color: { data: this._gpuInputBuffers.color, width, height },
			albedo: { data: this._gpuInputBuffers.albedo, width, height },
			normal: { data: this._gpuInputBuffers.normal, width, height }
		};

		return this._executeWithAbortGPU( config, continuous );

	}

	/**
	 * Creates or recreates the GPU storage buffers used as oidn-web inputs.
	 * Reuses existing buffers if the resolution hasn't changed.
	 * Usage: COPY_DST (for copyTextureToBuffer) | STORAGE (for oidn-web WGSL read) | COPY_SRC
	 */
	_ensureGPUInputBuffers( width, height ) {

		const { width: cw, height: ch } = this._gpuInputBufferSize;
		if ( cw === width && ch === height && this._gpuInputBuffers.color ) return;

		// Destroy stale buffers
		this._destroyGPUInputBuffers();

		const device = this.gpuDevice;
		const byteSize = width * height * 16; // rgba32float, tightly packed for oidn-web
		const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;

		this._gpuInputBuffers.color = device.createBuffer( { label: 'oidn-in-color', size: byteSize, usage } );
		this._gpuInputBuffers.albedo = device.createBuffer( { label: 'oidn-in-albedo', size: byteSize, usage } );
		this._gpuInputBuffers.normal = device.createBuffer( { label: 'oidn-in-normal', size: byteSize, usage } );
		this._gpuInputBufferSize = { width, height };

		// Pre-allocate the row-pad staging buffer when width * 16 isn't 256-aligned.
		// Shared across the three texture copies; recreated only on resolution change.
		const tightRowBytes = width * 16;
		const paddedRowBytes = Math.ceil( tightRowBytes / 256 ) * 256;
		if ( paddedRowBytes !== tightRowBytes ) {

			this._gpuInputPadBuffer = device.createBuffer( {
				label: 'oidn-in-pad',
				size: paddedRowBytes * height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
			} );
			this._gpuInputPaddedRowBytes = paddedRowBytes;

		} else {

			this._gpuInputPaddedRowBytes = tightRowBytes;

		}

	}

	_destroyGPUInputBuffers() {

		this._gpuInputBuffers.color?.destroy();
		this._gpuInputBuffers.albedo?.destroy();
		this._gpuInputBuffers.normal?.destroy();
		this._gpuInputPadBuffer?.destroy();

		// Bind groups hold the destroyed buffers; pipelines are device-scoped and survive.
		this._colorScaleBindGroup = null;
		this._lumBindGroup = null;
		this._lumPartials?.destroy();
		this._lumPartials = null;
		this._lumParams?.destroy();
		this._lumParams = null;
		this._inputScaleBuffer?.destroy();
		this._inputScaleBuffer = null;
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputPadBuffer = null;
		this._gpuInputPaddedRowBytes = 0;
		this._gpuInputBufferSize = { width: 0, height: 0 };

	}

	/**
	 * Builds the autoexposure reduction, the colour pre-multiply and the output pack. All three
	 * share the scale buffer, so they are created together.
	 * @returns {boolean} whether the GPU path is usable
	 */
	_ensureScalePipelines( device ) {

		const buffer = this._gpuInputBuffers.color;
		if ( ! device || ! buffer ) return false;

		if ( ! this._lumLayout ) {

			// Explicit rather than 'auto': `finalize` does not reference `col`, and an auto
			// layout would drop that binding and reject the shared bind group.
			this._lumLayout = device.createBindGroupLayout( {
				label: 'oidn-autoexposure',
				entries: [
					{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
					{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
					{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
					{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
				]
			} );

			const module = device.createShaderModule( { label: 'oidn-autoexposure', code: INPUT_SCALE_WGSL } );
			const layout = device.createPipelineLayout( { bindGroupLayouts: [ this._lumLayout ] } );
			this._lumReducePipeline = device.createComputePipeline( {
				label: 'oidn-autoexposure-reduce', layout, compute: { module, entryPoint: 'reduce' }
			} );
			this._lumFinalizePipeline = device.createComputePipeline( {
				label: 'oidn-autoexposure-finalize', layout, compute: { module, entryPoint: 'finalize' }
			} );

		}

		if ( ! this._colorScalePipeline ) {

			this._colorScalePipeline = device.createComputePipeline( {
				label: 'oidn-color-scale',
				layout: 'auto',
				compute: {
					module: device.createShaderModule( { label: 'oidn-color-scale', code: COLOR_SCALE_WGSL } ),
					entryPoint: 'main'
				}
			} );

		}

		if ( ! this._unpackPipeline ) {

			this._unpackPipeline = device.createComputePipeline( {
				label: 'oidn-output-unpack',
				layout: 'auto',
				compute: {
					module: device.createShaderModule( { label: 'oidn-output-unpack', code: UNPACK_WGSL } ),
					entryPoint: 'main'
				}
			} );

		}

		if ( ! this._inputScaleBuffer ) {

			this._inputScaleBuffer = device.createBuffer( {
				label: 'oidn-input-scale',
				// COPY_SRC is for debugging only: it lets the chosen exposure be read back.
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
				size: 4
			} );
			this._lumPartials = device.createBuffer( {
				label: 'oidn-autoexposure-partials',
				size: LUM_GROUPS * 4,
				usage: GPUBufferUsage.STORAGE
			} );
			this._lumParams = device.createBuffer( {
				label: 'oidn-autoexposure-params',
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
			} );

		}

		if ( ! this._lumBindGroup ) {

			this._lumBindGroup = device.createBindGroup( {
				label: 'oidn-autoexposure',
				layout: this._lumLayout,
				entries: [
					{ binding: 0, resource: { buffer } },
					{ binding: 1, resource: { buffer: this._lumPartials } },
					{ binding: 2, resource: { buffer: this._lumParams } },
					{ binding: 3, resource: { buffer: this._inputScaleBuffer } }
				]
			} );

		}

		if ( ! this._colorScaleBindGroup ) {

			this._colorScaleBindGroup = device.createBindGroup( {
				label: 'oidn-color-scale',
				layout: this._colorScalePipeline.getBindGroupLayout( 0 ),
				entries: [
					{ binding: 0, resource: { buffer } },
					{ binding: 1, resource: { buffer: this._inputScaleBuffer } }
				]
			} );

		}

		return true;

	}

	/** Writes OIDN's autoexposure scale into `_inputScaleBuffer`. Never read back. */
	_computeInputScale( device, pixelCount ) {

		if ( ! this._ensureScalePipelines( device ) ) return;

		if ( globalThis.__OIDN_NO_INPUT_SCALE ) {

			device.queue.writeBuffer( this._inputScaleBuffer, 0, new Float32Array( [ 1.0 ] ) );
			return;

		}

		device.queue.writeBuffer( this._lumParams, 0, new Uint32Array( [ pixelCount, 0, 0, 0 ] ) );

		const encoder = device.createCommandEncoder( { label: 'oidn-autoexposure' } );

		// Two passes, not two dispatches in one: `finalize` consumes what `reduce` wrote, and
		// pass boundaries are where WebGPU guarantees that ordering.
		const reduce = encoder.beginComputePass( { label: 'oidn-autoexposure-reduce' } );
		reduce.setPipeline( this._lumReducePipeline );
		reduce.setBindGroup( 0, this._lumBindGroup );
		reduce.dispatchWorkgroups( LUM_GROUPS, 1, 1 );
		reduce.end();

		const finalize = encoder.beginComputePass( { label: 'oidn-autoexposure-finalize' } );
		finalize.setPipeline( this._lumFinalizePipeline );
		finalize.setBindGroup( 0, this._lumBindGroup );
		finalize.dispatchWorkgroups( 1, 1, 1 );
		finalize.end();

		device.queue.submit( [ encoder.finish() ] );

	}

	/** Pre-multiplies the colour buffer by the autoexposure scale. */
	_applyColorScale( device, pixelCount ) {

		if ( ! this._ensureScalePipelines( device ) ) return;

		const wgTotal = Math.ceil( pixelCount / SCALE_WG_SIZE );
		const wgX = Math.min( wgTotal, SCALE_MAX_WG_X );
		const wgY = Math.ceil( wgTotal / wgX );

		const encoder = device.createCommandEncoder( { label: 'oidn-color-scale' } );
		const pass = encoder.beginComputePass( { label: 'oidn-color-scale' } );
		pass.setPipeline( this._colorScalePipeline );
		pass.setBindGroup( 0, this._colorScaleBindGroup );
		pass.dispatchWorkgroups( wgX, wgY, 1 );
		pass.end();
		device.queue.submit( [ encoder.finish() ] );

	}

	/**
	 * The picture the pipeline samples, or null until a denoise has produced one. Owned here and
	 * replaced on a resize, so callers re-read it rather than holding on to it.
	 * @returns {?import('three').Texture}
	 */
	get outputTexture() {

		return this._outTexture;

	}

	/**
	 * Makes sure the output picture exists at the render size. A resize makes a new one rather than
	 * resizing in place: three.js caches the card-side handle against the wrapper, so the wrapper
	 * has to be new too.
	 */
	_ensureOutputTexture( device, width, height ) {

		if ( this._outGPUTexture && this._outTexSize.width === width && this._outTexSize.height === height ) return;

		this._releaseOutputTexture();

		// Half float, like NRD's output: this picture is read once, by the display. Full float
		// would double both the memory it holds and the bandwidth of writing and sampling it, to
		// carry precision the tone curve and an 8-bit canvas immediately throw away. Measured
		// identical to within 0.02/255 of the mean.
		this._outGPUTexture = device.createTexture( {
			label: 'oidn-output',
			size: { width, height, depthOrArrayLayers: 1 },
			format: 'rgba16float',
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
		} );

		const tex = new ExternalTexture( this._outGPUTexture );
		tex.name = 'oidn:output';
		tex.image = { width, height, depth: 1 };
		tex.type = HalfFloatType;
		tex.format = RGBAFormat;
		tex.colorSpace = NoColorSpace;
		tex.minFilter = NearestFilter;
		tex.magFilter = NearestFilter;
		tex.wrapS = ClampToEdgeWrapping;
		tex.wrapT = ClampToEdgeWrapping;
		tex.generateMipmaps = false;
		tex.flipY = false;

		this._outTexture = tex;
		this._outTexSize = { width, height };

	}

	_releaseOutputTexture() {

		this._outTexture?.dispose();
		this._outGPUTexture?.destroy();
		this._outTexture = null;
		this._outGPUTexture = null;
		this._outTexSize = { width: 0, height: 0 };

	}

	/**
	 * Writes a rectangle of the denoised buffer into the output picture, on the card.
	 *
	 * @param {GPUBuffer} src - denoised rgba32float, full image
	 * @param {number} srcWidth
	 * @param {{x: number, y: number, width: number, height: number}} rect
	 */
	_unpackToTexture( src, srcWidth, rect ) {

		const device = this.gpuDevice;
		if ( ! device || ! this._ensureScalePipelines( device ) ) return;

		const { x, y, width, height } = rect;

		this._ensureOutputTexture( device, this._renderWidth, this._renderHeight );
		if ( ! this._outGPUTexture ) return;

		const params = device.createBuffer( {
			label: 'oidn-unpack-params',
			size: UNPACK_PARAMS_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		} );

		try {

			device.queue.writeBuffer( params, 0, new Uint32Array( [ srcWidth, x, y, width, height, 0, 0, 0 ] ) );

			const bindGroup = device.createBindGroup( {
				label: 'oidn-output-unpack',
				layout: this._unpackPipeline.getBindGroupLayout( 0 ),
				entries: [
					{ binding: 0, resource: { buffer: src } },
					{ binding: 1, resource: { buffer: params } },
					{ binding: 2, resource: { buffer: this._inputScaleBuffer } },
					{ binding: 3, resource: { buffer: this._gpuInputBuffers.color } },
					{ binding: 4, resource: this._outGPUTexture.createView() }
				]
			} );

			const encoder = device.createCommandEncoder( { label: 'oidn-output-unpack' } );
			const pass = encoder.beginComputePass( { label: 'oidn-output-unpack' } );
			pass.setPipeline( this._unpackPipeline );
			pass.setBindGroup( 0, bindGroup );
			pass.dispatchWorkgroups(
				Math.ceil( width / UNPACK_WG_SIZE ),
				Math.ceil( height / UNPACK_WG_SIZE ),
				1
			);
			pass.end();
			device.queue.submit( [ encoder.finish() ] );

			// Set here rather than when the run resolves: 'end' is dispatched from execute()'s
			// finally, which runs first, so a listener that waits for the run would see the very
			// first denoise as having produced nothing.
			this._hasOutput = true;

		} finally {

			params.destroy();

		}

	}


	/**
	 * Promise wrapper around tileExecute for the GPU path. Each tile is written straight into the
	 * output picture on the card, so there is nothing to await between a tile finishing and it
	 * being visible.
	 */
	_executeWithAbortGPU( config, continuous = false ) {

		return new Promise( ( resolve, reject ) => {

			if ( this.state.abortController?.signal.aborted ) {

				reject( new DOMException( 'Aborted', 'AbortError' ) );
				return;

			}

			let abortDenoise = null;

			// Fresh per-run list of tile-blit promises (the progress callback appends to it).
			this._tilesWritten = 0;

			const abortHandler = () => {

				if ( abortDenoise ) {

					abortDenoise();
					abortDenoise = null;

				}

				reject( new DOMException( 'Aborted', 'AbortError' ) );

			};

			this.state.abortController.signal.addEventListener( 'abort', abortHandler, { once: true } );

			abortDenoise = this.unet.tileExecute( {
				...config,
				done: async ( output ) => {

					this.state.abortController.signal.removeEventListener( 'abort', abortHandler );
					abortDenoise = null;

					try {

						// Nothing to wait for on the normal path: the progress callback wrote every
						// tile straight into the output picture, and tiles cover the image exactly.
						if ( this._tilesWritten === 0 ) this._displayGPUOutput( output );

						// DENOISING_END (which gates screenshot/video capture) fires only after this
						// resolves, so what a capture reads is always a complete picture.
						resolve();

					} catch ( err ) {

						reject( err );

					}

				},
				progress: ( outputData, _tileData, tile ) => {

					// oidn-web GPU path: tileData is null, but outputData holds the assembled
					// full-image buffer updated after each tile. The pack pass reads that tile's
					// rectangle straight out of it, so there are no row-by-row buffer copies.
					if ( ! outputData?.data || ! tile ) return;

					const fullWidth = outputData.width;
					const fullHeight = outputData.height;

					// Clamp tile to image bounds (edge tiles may extend past the image)
					const width = Math.min( tile.width, fullWidth - tile.x );
					const height = Math.min( tile.height, fullHeight - tile.y );
					if ( width <= 0 || height <= 0 ) return;

					const rect = { x: tile.x, y: tile.y, width, height };

					this._unpackToTexture( outputData.data, fullWidth, rect );
					this._tilesWritten ++;

					this.dispatchEvent( {
						type: 'tileProgress',
						tile: rect,
						imageWidth: fullWidth,
						imageHeight: fullHeight,
						continuous
					} );

				}
			} );

		} );

	}

	/**
	 * Degenerate fallback when no per-tile progress was emitted: one authoritative full paint.
	 * @param {{ data: GPUBuffer, width: number, height: number }} output
	 */
	_displayGPUOutput( { data: gpuBuffer, width, height } ) {

		if ( ! this.gpuDevice ) {

			log.error( 'gpuDevice not available for the output picture' );
			return;

		}

		this._unpackToTexture( gpuBuffer, width, { x: 0, y: 0, width, height } );

	}

	abort() {

		// Cancel any start deferred during loading so a reset supersedes it.
		this._pendingStart = false;
		this._pendingStartContinuous = false;

		if ( ! this.enabled || ! this.state.isDenoising ) return;

		// Signal abort to current operation
		this.state.abortController?.abort();

		// No 'end' here: the aborted execute()'s finally always runs and dispatches one, tagged
		// with that run's `continuous`. Dispatching here too emitted a second, untagged end —
		// a cancelled cadence run announcing itself as the denoise that finishes a render.
		this.state.isDenoising = false;

		log.debug( 'denoise aborted' );

	}

	// Whether the output picture holds a denoised frame the pipeline can show.
	get hasOutput() {

		return this._hasOutput;

	}

	// Call when the picture stops describing anything the viewer should see — a scene change, or a
	// resize. The picture itself is kept and overwritten by the next denoise.
	invalidateOutput() {

		this._hasOutput = false;

	}

	setSize( width, height ) {

		if ( width <= 0 || height <= 0 ) {

			throw new Error( `Invalid dimensions: ${width}x${height}` );

		}

		this._renderWidth = width;
		this._renderHeight = height;
		this._hasOutput = false;
		// The old measurement describes the old size, and callers size their policy on it.
		this.lastDenoiseMs = 0;

		// Reinitialize denoiser if tile size changes relative to image size
		this._setupUNetDenoiser().catch( error => {

			log.error( 'reinitialize after size change failed:', error );

		} );

	}

	dispose() {

		// Abort any ongoing operations
		this.abort();

		// Dispose resources
		this.unet?.dispose();
		this._destroyGPUInputBuffers();
		this._releaseOutputTexture();
		this._colorScalePipeline = null;
		this._lumReducePipeline = null;
		this._lumFinalizePipeline = null;
		this._lumLayout = null;
		this._unpackPipeline = null;

		// Clear references
		this.unet = null;
		this.state.abortController = null;

		// Remove all event listeners
		this.removeAllListeners?.();

		log.debug( 'disposed' );

	}

}
