import { GBUFFER_MISS_THRESHOLD } from '../Stages/DenoiserSettings.js';

/**
 * History of the frames the path tracer restarted while the view moved, reprojected into the
 * current view and handed to OIDN instead of a single fresh sample.
 *
 * OIDN reads spatially correlated noise as detail, so each pixel takes ONE history pixel (never a
 * bilinear blend), and a history pixel several pixels picked has its length split between them.
 * History length rides in albedo.w; colour.w stays the path tracer's alpha.
 */

export const HISTORY_DEFAULTS = Object.freeze( {
	maxLength: 8,
	// Reflections do not move with the surface.
	smoothLength: 2,
	roughStart: 0.45,
	roughEnd: 0.7,
	depthTolerance: 0.05,
	normalTolerance: 0.8,
	// A moved object's lighting changes as it moves, so its history lags like a reflection.
	movedLength: 2,
} );

const WG = 8;
const PARAMS_BYTES = 304;
const MIN_MOVED_CAPACITY = 16;
const FLAG_CLEAN_AUX = 1;
const FLAG_SPLIT_COPIES = 2;
const FLAG_ORTHOGRAPHIC = 4;
const PICK_MOVED = 0x40000000;

const COMMON_WGSL = /* wgsl */`
struct Params {
	size: vec2<u32>,
	reset: u32,
	flags: u32,
	maxLength: f32,
	smoothLength: f32,
	depthTolerance: f32,
	normalTolerance: f32,
	roughStart: f32,
	roughEnd: f32,
	samples: f32,
	historyScale: f32,
	camWorld: mat4x4<f32>,
	projInv: mat4x4<f32>,
	prevViewProj: mat4x4<f32>,
	prevCamPos: vec4<f32>,
	moved: vec4<u32>,
	movedLength: f32,
	prevCamDir: vec4<f32>,
};

@group(0) @binding(0) var<uniform> P: Params;

fn finite3( v: vec3<f32> ) -> bool {
	let e = bitcast<vec3<u32>>( v ) & vec3<u32>( 0x7f800000u );
	return all( e != vec3<u32>( 0x7f800000u ) );
}

// [0,1]-encoded in and out, renormalised like FinalWrite's clean aux.
fn mixNormal( h: vec3<f32>, c: vec3<f32>, t: f32 ) -> vec3<f32> {
	let m = mix( h * 2.0 - 1.0, c * 2.0 - 1.0, t );
	let l = length( m );
	return select( c, m / l * 0.5 + 0.5, l > 1e-4 );
}
`;

const SELECT_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var geoCur: texture_2d<f32>;
@group(0) @binding(2) var geoPrev: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> picked: array<i32>;
@group(0) @binding(4) var<storage, read_write> copies: array<atomic<u32>>;
@group(0) @binding(5) var instanceLeaf: texture_2d<u32>;
@group(0) @binding(6) var<storage, read> movedLeaves: array<u32>;
@group(0) @binding(7) var<storage, read> movedToPrev: array<mat4x4<f32>>;

fn movedIndex( leaf: u32 ) -> i32 {

	var lo = 0u;
	var hi = P.moved.x;
	loop {

		if ( lo >= hi ) { break; }
		let mid = ( lo + hi ) / 2u;
		let v = movedLeaves[ mid ];
		if ( v == leaf ) { return i32( mid ); }
		if ( v < leaf ) { lo = mid + 1u; } else { hi = mid; }

	}
	return -1;

}

@compute @workgroup_size(${ WG }, ${ WG })
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {

	if ( gid.x >= P.size.x || gid.y >= P.size.y ) { return; }

	let g = textureLoad( geoCur, vec2<i32>( gid.xy ), 0 );
	var best = -1.0;
	var pick = -1;
	var movedFlag = 0;

	if ( P.reset == 0u && g.w < ${ GBUFFER_MISS_THRESHOLD.toFixed( 1 ) } ) {

		let size = vec2<f32>( P.size );
		let uv = ( vec2<f32>( gid.xy ) + 0.5 ) / size;
		// Depth is along the ray: from the camera, or from its image plane when orthographic.
		let ortho = ( P.flags & ${ FLAG_ORTHOGRAPHIC }u ) != 0u;
		let ndc = vec2<f32>( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0 );
		var origin = P.camWorld[ 3 ].xyz;
		var dir: vec3<f32>;
		if ( ortho ) {
			origin = ( P.camWorld * vec4<f32>( ( P.projInv * vec4<f32>( ndc, 0.0, 1.0 ) ).xy, 0.0, 1.0 ) ).xyz;
			dir = - normalize( P.camWorld[ 2 ].xyz );
		} else {
			let rc = P.projInv * vec4<f32>( ndc, 1.0, 1.0 );
			dir = normalize( ( P.camWorld * vec4<f32>( rc.xyz / rc.w, 0.0 ) ).xyz );
		}
		var wp = origin + dir * g.w;
		var n = g.xyz * 2.0 - 1.0;

		// A moved object's surface is looked for where the object was.
		let leaf = textureLoad( instanceLeaf, vec2<i32>( gid.xy ), 0 ).x;
		if ( leaf > 0u && P.moved.x > 0u ) {

			let m = movedIndex( leaf - 1u );
			if ( m >= 0 ) {

				let toPrev = movedToPrev[ u32( m ) ];
				wp = ( toPrev * vec4<f32>( wp, 1.0 ) ).xyz;
				n = normalize( ( toPrev * vec4<f32>( n, 0.0 ) ).xyz );
				movedFlag = ${ PICK_MOVED };

			}

		}

		let clip = P.prevViewProj * vec4<f32>( wp, 1.0 );

		if ( clip.w > 0.0 ) {

			let pos = vec2<f32>( clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5 ) * size - 0.5;
			let base = vec2<i32>( floor( pos ) );
			let f = fract( pos );
			let expected = select( length( wp - P.prevCamPos.xyz ), dot( wp - P.prevCamPos.xyz, P.prevCamDir.xyz ), ortho );

			for ( var j = 0; j < 2; j++ ) {
				for ( var i = 0; i < 2; i++ ) {

					let q = base + vec2<i32>( i, j );
					if ( any( q < vec2<i32>( 0 ) ) || any( q >= vec2<i32>( P.size ) ) ) { continue; }
					let h = textureLoad( geoPrev, q, 0 );
					if ( abs( h.w - expected ) >= P.depthTolerance * expected ) { continue; }
					if ( dot( n, h.xyz * 2.0 - 1.0 ) <= P.normalTolerance ) { continue; }
					let w = select( 1.0 - f.x, f.x, i == 1 ) * select( 1.0 - f.y, f.y, j == 1 );
					if ( w > best ) { best = w; pick = q.y * i32( P.size.x ) + q.x; }

				}
			}

		}

	}

	picked[ gid.y * P.size.x + gid.x ] = select( pick, pick | movedFlag, pick >= 0 );
	if ( pick >= 0 ) { atomicAdd( &copies[ u32( pick ) ], 1u ); }

}
`;

const BLEND_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var curColor: texture_2d<f32>;
@group(0) @binding(2) var curAlbedo: texture_2d<f32>;
@group(0) @binding(3) var curNormal: texture_2d<f32>;
@group(0) @binding(4) var shading: texture_2d<f32>;
@group(0) @binding(5) var histColor: texture_2d<f32>;
@group(0) @binding(6) var histAlbedo: texture_2d<f32>;
@group(0) @binding(7) var histNormal: texture_2d<f32>;
@group(0) @binding(8) var<storage, read> picked: array<i32>;
@group(0) @binding(9) var<storage, read> copies: array<u32>;
@group(0) @binding(10) var outColor: texture_storage_2d<rgba32float, write>;
@group(0) @binding(11) var outAlbedo: texture_storage_2d<rgba32float, write>;
@group(0) @binding(12) var outNormal: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(${ WG }, ${ WG })
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {

	if ( gid.x >= P.size.x || gid.y >= P.size.y ) { return; }

	let p = vec2<i32>( gid.xy );
	var cur = textureLoad( curColor, p, 0 );
	if ( ! finite3( cur.xyz ) ) { cur = vec4<f32>( 0.0, 0.0, 0.0, cur.w ); }
	let ca = textureLoad( curAlbedo, p, 0 );
	let cn = textureLoad( curNormal, p, 0 );

	var len = 0.0;
	var hc = cur.xyz;
	var ha = ca.xyz;
	var hn = cn.xyz;
	let raw = picked[ gid.y * P.size.x + gid.x ];
	let movedPx = raw >= 0 && ( raw & ${ PICK_MOVED } ) != 0;
	let pick = select( raw, raw & ~${ PICK_MOVED }, raw >= 0 );

	if ( pick >= 0 ) {

		let q = vec2<i32>( pick % i32( P.size.x ), pick / i32( P.size.x ) );
		let c = textureLoad( histColor, q, 0 ).xyz;

		if ( finite3( c ) ) {

			let a = textureLoad( histAlbedo, q, 0 );
			hc = c;
			ha = a.xyz;
			hn = textureLoad( histNormal, q, 0 ).xyz;
			len = a.w;
			if ( ( P.flags & ${ FLAG_SPLIT_COPIES }u ) != 0u ) { len = len / f32( max( copies[ u32( pick ) ], 1u ) ); }

		}

	}

	let rough = textureLoad( shading, p, 0 ).w;
	var cap = mix( P.smoothLength, P.maxLength, smoothstep( P.roughStart, P.roughEnd, rough ) );
	if ( movedPx ) { cap = min( cap, P.movedLength ); }
	let newLen = min( len + 1.0, cap );
	let t = 1.0 / newLen;

	textureStore( outColor, p, vec4<f32>( mix( hc, cur.xyz, t ), cur.w ) );
	textureStore( outAlbedo, p, vec4<f32>( mix( ha, ca.xyz, t ), newLen ) );
	let n = select( cn.xyz, mixNormal( hn, cn.xyz, t ), ( P.flags & ${ FLAG_CLEAN_AUX }u ) != 0u );
	textureStore( outNormal, p, vec4<f32>( n, cn.w ) );

}
`;

// Sample-weighted mean of history and a still accumulation.
const MERGE_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(1) var accColor: texture_2d<f32>;
@group(0) @binding(2) var accAlbedo: texture_2d<f32>;
@group(0) @binding(3) var accNormal: texture_2d<f32>;
@group(0) @binding(4) var histColor: texture_2d<f32>;
@group(0) @binding(5) var histAlbedo: texture_2d<f32>;
@group(0) @binding(6) var histNormal: texture_2d<f32>;
@group(0) @binding(7) var outColor: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var outAlbedo: texture_storage_2d<rgba32float, write>;
@group(0) @binding(9) var outNormal: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(${ WG }, ${ WG })
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {

	if ( gid.x >= P.size.x || gid.y >= P.size.y ) { return; }

	let p = vec2<i32>( gid.xy );
	let ac = textureLoad( accColor, p, 0 );
	let aa = textureLoad( accAlbedo, p, 0 );
	let an = textureLoad( accNormal, p, 0 );

	var k = 0.0;
	var hc = ac.xyz;
	var ha = aa.xyz;
	var hn = an.xyz;

	if ( P.reset == 0u ) {

		let c = textureLoad( histColor, p, 0 ).xyz;

		if ( finite3( c ) ) {

			let a = textureLoad( histAlbedo, p, 0 );
			k = a.w * P.historyScale;
			hc = c;
			ha = a.xyz;
			hn = textureLoad( histNormal, p, 0 ).xyz;

		}

	}

	let t = P.samples / max( k + P.samples, 1e-6 );
	textureStore( outColor, p, vec4<f32>( mix( hc, ac.xyz, t ), ac.w ) );
	textureStore( outAlbedo, p, vec4<f32>( mix( ha, aa.xyz, t ), min( k + P.samples, P.maxLength ) ) );
	let n = select( an.xyz, mixNormal( hn, an.xyz, t ), ( P.flags & ${ FLAG_CLEAN_AUX }u ) != 0u );
	textureStore( outNormal, p, vec4<f32>( n, an.w ) );

}
`;

const texEntry = ( binding ) => ( { binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } } );
const outEntry = ( binding ) => ( { binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } } );
const bufEntry = ( binding, type ) => ( { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } } );

export class OIDNTemporalHistory {

	/** @param {GPUDevice} device */
	constructor( device ) {

		this.device = device;
		this.settings = { ...HISTORY_DEFAULTS, cleanAux: false, splitCopies: true };
		this.valid = false;
		this.width = 0;
		this.height = 0;

		this._sets = null;
		this._current = 0;
		this._picked = null;
		this._copies = null;
		this._paramsBuffer = null;
		this._pipelines = null;
		this._movedLeaves = null;
		this._movedToPrev = null;
		this._movedCapacity = 0;
		this._movedCount = 0;

		this._paramData = new ArrayBuffer( PARAMS_BYTES );
		this._paramU32 = new Uint32Array( this._paramData );
		this._paramF32 = new Float32Array( this._paramData );
		this._prevViewProj = new Float32Array( 16 );
		this._prevCamPos = new Float32Array( 4 );
		this._prevCamDir = new Float32Array( 4 );

	}

	/** The history OIDN reads while the view moves, or null before the first frame. */
	get textures() {

		return this.valid ? this._sets[ this._current ] : null;

	}

	invalidate() {

		this.valid = false;

	}

	/**
	 * Blends the frame just traced (a restart: one sample) into the reprojected history.
	 * @param {Object} src - GPUTextures { color, albedo, normal, geo, geoPrev, shading, leaf } and { width, height }
	 * @param {{ world: Float32Array, projInv: Float32Array, viewProj: Float32Array, orthographic: boolean }} camera - of that frame
	 * @param {?{ count: number, leaves: Uint32Array, toPrev: Float32Array }} [moved] - TLAS leaves
	 *   (ascending) that moved since the last frame, with each one's current→previous world matrix
	 */
	accumulate( src, camera, moved = null ) {

		if ( ! this._ensure( src.width, src.height ) ) return;

		this._uploadMoved( moved );
		this._writeParams( camera, ! this.valid, 0, 1 );
		const from = this._sets[ this._current ];
		const to = this._sets[ 1 - this._current ];
		const { select, blend } = this._pipelines;

		const encoder = this.device.createCommandEncoder( { label: 'oidn-history' } );
		encoder.clearBuffer( this._copies );
		this._dispatch( encoder, select, [
			{ buffer: this._paramsBuffer }, src.geo, src.geoPrev, { buffer: this._picked }, { buffer: this._copies },
			src.leaf, { buffer: this._movedLeaves }, { buffer: this._movedToPrev },
		] );
		this._dispatch( encoder, blend, [
			{ buffer: this._paramsBuffer }, src.color, src.albedo, src.normal, src.shading,
			from.color, from.albedo, from.normal, { buffer: this._picked }, { buffer: this._copies },
			to.color, to.albedo, to.normal,
		] );
		this.device.queue.submit( [ encoder.finish() ] );

		this._current = 1 - this._current;
		this.valid = true;
		this._rememberCamera( camera );

	}

	/**
	 * Sample-weighted mean of the history and a still accumulation of `samples` frames.
	 * @param {Object} src - as for accumulate; only colour, albedo and normal are read
	 * @param {number} samples
	 * @param {Object} camera - of the accumulation
	 * @param {Object} [options]
	 * @param {boolean} [options.commit] - make the result the history (a move is starting)
	 * @param {boolean} [options.keepHistory] - false merges nothing in: the result is the accumulation
	 * @param {number} [options.historyScale] - weight on the history's sample count
	 * @returns {?{ color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }}
	 */
	merge( src, samples, camera, { commit = false, keepHistory = true, historyScale = 1 } = {} ) {

		if ( ! this._ensure( src.width, src.height ) ) return null;

		this._writeParams( camera, ! this.valid || ! keepHistory, samples, historyScale );
		const from = this._sets[ this._current ];
		const to = this._sets[ 1 - this._current ];

		const encoder = this.device.createCommandEncoder( { label: 'oidn-history-merge' } );
		this._dispatch( encoder, this._pipelines.merge, [
			{ buffer: this._paramsBuffer }, src.color, src.albedo, src.normal,
			from.color, from.albedo, from.normal, to.color, to.albedo, to.normal,
		] );
		this.device.queue.submit( [ encoder.finish() ] );

		if ( commit ) {

			this._current = 1 - this._current;
			this.valid = true;
			this._rememberCamera( camera );

		}

		return to;

	}

	dispose() {

		this._releaseTextures();
		this._paramsBuffer?.destroy();
		this._movedLeaves?.destroy();
		this._movedToPrev?.destroy();
		this._paramsBuffer = null;
		this._movedLeaves = null;
		this._movedToPrev = null;
		this._movedCapacity = 0;
		this._pipelines = null;

	}

	gpuBytes() {

		if ( ! this._sets ) return 0;
		return this._sets.length * 3 * this.width * this.height * 16 + this._picked.size + this._copies.size;

	}

	_ensure( width, height ) {

		if ( ! width || ! height ) return false;
		this._ensurePipelines();
		if ( this._sets && this.width === width && this.height === height ) return true;

		this._releaseTextures();

		const device = this.device;
		const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
		const make = ( label ) => device.createTexture( { label, size: { width, height }, format: 'rgba32float', usage } );
		this._sets = [ 0, 1 ].map( i => ( {
			color: make( `oidn-history-color-${ i }` ),
			albedo: make( `oidn-history-albedo-${ i }` ),
			normal: make( `oidn-history-normal-${ i }` ),
		} ) );
		this._picked = device.createBuffer( { label: 'oidn-history-picked', size: width * height * 4, usage: GPUBufferUsage.STORAGE } );
		this._copies = device.createBuffer( { label: 'oidn-history-copies', size: width * height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );

		this.width = width;
		this.height = height;
		this._current = 0;
		this.valid = false;
		return true;

	}

	_ensurePipelines() {

		if ( this._pipelines ) return;

		const device = this.device;
		const build = ( label, code, entries ) => {

			const layout = device.createBindGroupLayout( { label, entries } );
			const pipeline = device.createComputePipeline( {
				label,
				layout: device.createPipelineLayout( { bindGroupLayouts: [ layout ] } ),
				compute: { module: device.createShaderModule( { label, code } ), entryPoint: 'main' },
			} );
			return { pipeline, layout };

		};

		const uniform = bufEntry( 0, 'uniform' );
		this._pipelines = {
			select: build( 'oidn-history-select', SELECT_WGSL, [
				uniform, texEntry( 1 ), texEntry( 2 ), bufEntry( 3, 'storage' ), bufEntry( 4, 'storage' ),
				{ binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
				bufEntry( 6, 'read-only-storage' ), bufEntry( 7, 'read-only-storage' ),
			] ),
			blend: build( 'oidn-history-blend', BLEND_WGSL, [
				uniform, ...[ 1, 2, 3, 4, 5, 6, 7 ].map( texEntry ),
				bufEntry( 8, 'read-only-storage' ), bufEntry( 9, 'read-only-storage' ),
				outEntry( 10 ), outEntry( 11 ), outEntry( 12 ),
			] ),
			merge: build( 'oidn-history-merge', MERGE_WGSL, [
				uniform, ...[ 1, 2, 3, 4, 5, 6 ].map( texEntry ), outEntry( 7 ), outEntry( 8 ), outEntry( 9 ),
			] ),
		};

		this._paramsBuffer = device.createBuffer( {
			label: 'oidn-history-params',
			size: PARAMS_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		} );
		this._growMoved( MIN_MOVED_CAPACITY );

	}

	_growMoved( capacity ) {

		this._movedLeaves?.destroy();
		this._movedToPrev?.destroy();
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
		this._movedLeaves = this.device.createBuffer( { label: 'oidn-history-moved-leaves', size: capacity * 4, usage } );
		this._movedToPrev = this.device.createBuffer( { label: 'oidn-history-moved-matrices', size: capacity * 64, usage } );
		this._movedCapacity = capacity;

	}

	_uploadMoved( moved ) {

		this._movedCount = moved?.count ?? 0;
		if ( ! this._movedCount ) return;
		if ( this._movedCount > this._movedCapacity ) this._growMoved( Math.max( this._movedCount, this._movedCapacity * 2 ) );
		this.device.queue.writeBuffer( this._movedLeaves, 0, moved.leaves, 0, this._movedCount );
		this.device.queue.writeBuffer( this._movedToPrev, 0, moved.toPrev, 0, this._movedCount * 16 );

	}

	// Resources in binding order; GPUTextures get a view.
	_dispatch( encoder, { pipeline, layout }, resources ) {

		const entries = resources.map( ( r, binding ) => ( {
			binding,
			resource: r.buffer ? r : r.createView(),
		} ) );
		const pass = encoder.beginComputePass();
		pass.setPipeline( pipeline );
		pass.setBindGroup( 0, this.device.createBindGroup( { layout, entries } ) );
		pass.dispatchWorkgroups( Math.ceil( this.width / WG ), Math.ceil( this.height / WG ) );
		pass.end();

	}

	_writeParams( camera, reset, samples, historyScale ) {

		const s = this.settings;
		const u = this._paramU32;
		const f = this._paramF32;
		u[ 0 ] = this.width;
		u[ 1 ] = this.height;
		u[ 2 ] = reset ? 1 : 0;
		u[ 3 ] = ( s.cleanAux ? FLAG_CLEAN_AUX : 0 ) | ( s.splitCopies ? FLAG_SPLIT_COPIES : 0 ) | ( camera.orthographic ? FLAG_ORTHOGRAPHIC : 0 );
		f[ 4 ] = s.maxLength;
		f[ 5 ] = s.smoothLength;
		f[ 6 ] = s.depthTolerance;
		f[ 7 ] = s.normalTolerance;
		f[ 8 ] = s.roughStart;
		f[ 9 ] = s.roughEnd;
		f[ 10 ] = samples;
		f[ 11 ] = historyScale;
		f.set( camera.world, 12 );
		f.set( camera.projInv, 28 );
		f.set( this._prevViewProj, 44 );
		f.set( this._prevCamPos, 60 );
		u[ 64 ] = this._movedCount;
		f[ 68 ] = s.movedLength;
		f.set( this._prevCamDir, 72 );
		this.device.queue.writeBuffer( this._paramsBuffer, 0, this._paramData );

	}

	_rememberCamera( camera ) {

		this._prevViewProj.set( camera.viewProj );
		this._prevCamPos[ 0 ] = camera.world[ 12 ];
		this._prevCamPos[ 1 ] = camera.world[ 13 ];
		this._prevCamPos[ 2 ] = camera.world[ 14 ];
		const back = Math.hypot( camera.world[ 8 ], camera.world[ 9 ], camera.world[ 10 ] );
		this._prevCamDir[ 0 ] = - camera.world[ 8 ] / back;
		this._prevCamDir[ 1 ] = - camera.world[ 9 ] / back;
		this._prevCamDir[ 2 ] = - camera.world[ 10 ] / back;

	}

	_releaseTextures() {

		this._sets?.forEach( set => Object.values( set ).forEach( t => t.destroy() ) );
		this._picked?.destroy();
		this._copies?.destroy();
		this._sets = null;
		this._picked = null;
		this._copies = null;
		this.width = 0;
		this.height = 0;
		this.valid = false;

	}

}
