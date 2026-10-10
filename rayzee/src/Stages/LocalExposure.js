import { Fn, float, int, uint, ivec2, vec2, vec4, uniform, If, Loop, max, min, select, exp, exp2, log2, dot, mix, floor,
	floatBitsToUint, textureLoad, workgroupArray, workgroupBarrier, localId, workgroupId, attributeArray, storage,
	atomicAdd, atomicLoad, atomicStore, toneMappingExposure } from 'three/tsl';
import { TextureNode } from 'three/webgpu';
import { Vector4 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { MAX_RESERVABLE_RENDER_SIZE } from '../Processor/StorageTexturePool.js';

export const LOCAL_EXPOSURE_DEFAULTS = {
	localExposure: false,
	localExposureHighlightContrast: 0.6,
	localExposureShadowContrast: 1.0,
	localExposureDetailStrength: 1.0,
};

// Unreal's sizes: grid cells of 64 half-resolution texels, 32 bins, a 1/32 blurred picture.
const CELL = 128;
const CELL_TEXELS = ( CELL / 2 ) ** 2;
const BINS = 32;
const BIN_MIN = - 16; // exposed log2 luminance the bins span
const BIN_MAX = 16;
const LOG_FLOOR = - 40;
const LOG_CEIL = 40;
const FIXED = 256;
const BLUR_TEXEL = 32;
const BLUR_BLEND = 0.6;
const BLUR_PERCENT = 50;
const MIDDLE_GREY = Math.log2( 0.18 );
const DARKEST = 2 ** - 24;
const MAX_CELLS = Math.ceil( MAX_RESERVABLE_RENDER_SIZE / CELL );
const MAX_BLUR = Math.ceil( MAX_RESERVABLE_RENDER_SIZE / BLUR_TEXEL );
const Y = [ 0.2126, 0.7152, 0.0722 ];

const meterInterval = samples => samples < 16 ? 1 : samples < 64 ? 4 : 16;
const clamp = ( x, a, b ) => Math.min( Math.max( x, a ), b );

/**
 * The gain local exposure applies to one pixel, from the grid and blurred picture as stored. `p` is the
 * stage's 16 parameter floats (`_params`); the shader twins below must stay identical.
 * @param {Float32Array} p
 * @param {Float32Array} grid - two floats a bin: Σ log2 luminance and Σ weight, per cell texel
 * @param {Float32Array} blur - log2 luminance of the blurred picture
 * @param {number} u - image x in [0, 1]
 * @param {number} v - image y in [0, 1], down
 * @param {number} lum - the pixel's linear luminance
 * @param {number} logExposure - log2 of the exposure it is shown at
 */
export function localExposureGain( p, grid, blur, u, v, lum, logExposure ) {

	// Capped: an infinite pixel's y − y would be NaN.
	const logL = Math.min( Math.log2( Math.max( lum, DARKEST ) ), LOG_CEIL );

	const bw = p[ 6 ], bh = p[ 7 ];
	const bx = clamp( u * p[ 2 ] - 0.5, 0, bw - 1 ), by = clamp( v * p[ 3 ] - 0.5, 0, bh - 1 );
	const bx0 = Math.floor( bx ), by0 = Math.floor( by ), bx1 = Math.min( bx0 + 1, bw - 1 ), by1 = Math.min( by0 + 1, bh - 1 );
	const bfx = bx - bx0, bfy = by - by0;
	const blurRow = ( row ) => blur[ row * bw + bx0 ] + ( blur[ row * bw + bx1 ] - blur[ row * bw + bx0 ] ) * bfx;
	const blurred = blurRow( by0 ) + ( blurRow( by1 ) - blurRow( by0 ) ) * bfy;

	const cw = p[ 4 ], ch = p[ 5 ];
	const gx = clamp( u * p[ 0 ] - 0.5, 0, cw - 1 ), gy = clamp( v * p[ 1 ] - 0.5, 0, ch - 1 );
	const gz = clamp( ( logL + p[ 8 ] - BIN_MIN ) / ( BIN_MAX - BIN_MIN ), 0, 1 ) * ( BINS - 1 );
	const gx0 = Math.floor( gx ), gy0 = Math.floor( gy ), gz0 = Math.floor( gz );
	const fx = gx - gx0, fy = gy - gy0, fz = gz - gz0;
	let s = 0, w = 0;
	for ( let k = 0; k < 8; k ++ ) {

		const dx = k & 1, dy = ( k >> 1 ) & 1, dz = k >> 2;
		const weight = ( dx ? fx : 1 - fx ) * ( dy ? fy : 1 - fy ) * ( dz ? fz : 1 - fz );
		const i = ( ( Math.min( gy0 + dy, ch - 1 ) * cw + Math.min( gx0 + dx, cw - 1 ) ) * BINS + Math.min( gz0 + dz, BINS - 1 ) ) * 2;
		s += grid[ i ] * weight;
		w += grid[ i + 1 ] * weight;

	}

	const bilateral = w * CELL_TEXELS < 1e-3 ? blurred : s / w;
	const base = bilateral + ( blurred - bilateral ) * p[ 12 ] + logExposure;
	const y = logL + logExposure;
	const contrast = base > p[ 13 ] ? p[ 9 ] : p[ 10 ];
	return 2 ** ( p[ 13 ] + ( base - p[ 13 ] ) * contrast + ( y - base ) * p[ 11 ] - y );

}

/** The same gain in WGSL, for a pass outside three.js: group 1 holds the grid, the blurred picture and the params. */
export const LOCAL_EXPOSURE_WGSL = /* wgsl */ `
@group(1) @binding(0) var<storage, read> leGrid: array<vec2<f32>>;
@group(1) @binding(1) var<storage, read> leBlur: array<f32>;
@group(1) @binding(2) var<uniform> le: array<vec4<f32>, 4>;

fn rayzee_gain( uv: vec2<f32>, linear: vec3<f32>, exposure: f32 ) -> f32 {
	let logL = min( log2( max( dot( linear, vec3<f32>( ${Y.join( ', ' )} ) ), ${DARKEST} ) ), ${LOG_CEIL}.0 );
	let logExposure = log2( exposure );

	let bs = vec2<i32>( le[ 1 ].zw );
	let bp = clamp( uv * le[ 0 ].zw - 0.5, vec2<f32>( 0.0 ), vec2<f32>( bs - 1 ) );
	let b0 = vec2<i32>( floor( bp ) );
	let b1 = min( b0 + 1, bs - 1 );
	let bf = bp - floor( bp );
	let top = mix( leBlur[ b0.y * bs.x + b0.x ], leBlur[ b0.y * bs.x + b1.x ], bf.x );
	let bottom = mix( leBlur[ b1.y * bs.x + b0.x ], leBlur[ b1.y * bs.x + b1.x ], bf.x );
	let blurred = mix( top, bottom, bf.y );

	let cs = vec2<i32>( le[ 1 ].xy );
	let gp = clamp( uv * le[ 0 ].xy - 0.5, vec2<f32>( 0.0 ), vec2<f32>( cs - 1 ) );
	let gz = clamp( ( logL + le[ 2 ].x - (${BIN_MIN}.0) ) / ${BIN_MAX - BIN_MIN}.0, 0.0, 1.0 ) * ${BINS - 1}.0;
	let g0 = vec3<i32>( vec2<i32>( floor( gp ) ), i32( floor( gz ) ) );
	let gf = vec3<f32>( gp - floor( gp ), gz - floor( gz ) );
	var acc = vec2<f32>( 0.0 );
	for ( var k = 0; k < 8; k++ ) {
		let d = vec3<i32>( k & 1, ( k >> 1u ) & 1, k >> 2u );
		let wv = select( 1.0 - gf, gf, d == vec3<i32>( 1 ) );
		let c = min( g0 + d, vec3<i32>( cs - 1, ${BINS - 1} ) );
		acc += leGrid[ ( c.y * cs.x + c.x ) * ${BINS} + c.z ] * ( wv.x * wv.y * wv.z );
	}

	let bilateral = select( acc.x / acc.y, blurred, acc.y * ${CELL_TEXELS}.0 < 1e-3 );
	let base = mix( bilateral, blurred, le[ 3 ].x ) + logExposure;
	let y = logL + logExposure;
	let contrast = select( le[ 2 ].z, le[ 2 ].y, base > le[ 3 ].y );
	return exp2( le[ 3 ].y + ( base - le[ 3 ].y ) * contrast + ( y - base ) * le[ 2 ].w - y );
}
`;

/**
 * Local exposure — Unreal Engine 5's: the frame's log luminance is split into a base layer (a bilateral grid
 * blended with a blurred picture) and detail; the base's contrast around middle grey is scaled, highlights and
 * shadows apart, and the detail kept. It changes only what is shown: the compositor and every tone-mapped
 * readback apply the same per-pixel gain (`gainNode`, `toneGain`), so a saved picture matches the canvas.
 *
 * Built from `pathtracer:color` when the image restarts, less often as it converges.
 * Events listened: pipeline:reset
 * Textures read: pathtracer:color
 */
export class LocalExposure extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'LocalExposure', { ...options, executionMode: StageExecutionMode.ALWAYS } );

		this.renderer = renderer;
		this.highlightContrast = options.highlightContrast ?? LOCAL_EXPOSURE_DEFAULTS.localExposureHighlightContrast;
		this.shadowContrast = options.shadowContrast ?? LOCAL_EXPOSURE_DEFAULTS.localExposureShadowContrast;
		this.detailStrength = options.detailStrength ?? LOCAL_EXPOSURE_DEFAULTS.localExposureDetailStrength;
		/** Called when the shown picture should be redrawn; the viewer wakes its loop. */
		this.onChange = null;

		this._grid = attributeArray( MAX_CELLS * MAX_CELLS * BINS, 'vec2' );
		this._blur = attributeArray( MAX_BLUR * MAX_BLUR, 'float' );
		this._blurTmp = attributeArray( MAX_BLUR * MAX_BLUR, 'float' );
		this._inputNode = new TextureNode();
		this._widthU = uniform( 1, 'int' );
		this._heightU = uniform( 1, 'int' );
		this._cellsXU = uniform( 1, 'int' );
		this._blurWU = uniform( 1, 'int' );
		this._blurHU = uniform( 1, 'int' );
		this._radiusU = uniform( 1 );
		this._logExposureU = uniform( 0 );
		this._p = [ new Vector4(), new Vector4(), new Vector4(), new Vector4() ].map( v => uniform( v ) );
		this._params = new Float32Array( 16 );

		this._kernels = [ this._buildGridKernel(), this._buildBlurSourceKernel(), this._buildBlurKernel( this._blur, this._blurTmp, true ), this._buildBlurKernel( this._blurTmp, this._blur, false ) ];

		this._built = false;
		this._restarts = 0;
		this._builtAt = { restarts: - 1, samples: - 1 };
		this._stale = false;
		this._paramsBuffer = null;
		this._disposed = false;

	}

	// ── Kernels ──────────────────────────────────────────────

	_buildGridKernel() {

		const input = this._inputNode, grid = this._grid;
		const width = this._widthU, height = this._heightU, cellsX = this._cellsXU, logExposure = this._logExposureU;
		const yw = vec4( ...Y, 0 ).xyz;

		return Fn( () => {

			const lid = localId.y.mul( uint( 16 ) ).add( localId.x );
			const sums = workgroupArray( 'uint', BINS ).toAtomic();
			const weights = workgroupArray( 'uint', BINS ).toAtomic();
			If( lid.lessThan( uint( BINS ) ), () => {

				atomicStore( sums.element( lid ), uint( 0 ) );
				atomicStore( weights.element( lid ), uint( 0 ) );

			} );
			workgroupBarrier();

			const ox = int( workgroupId.x ).mul( int( CELL ) ).add( int( localId.x ).mul( int( 8 ) ) );
			const oy = int( workgroupId.y ).mul( int( CELL ) ).add( int( localId.y ).mul( int( 8 ) ) );

			// Each thread bins its 4×4 half-resolution texels (2×2 pixels each), split between the two nearest bins.
			Loop( { start: int( 0 ), end: int( 8 ), type: 'int', condition: '<', update: 2, name: 'ty' }, ( { ty } ) => {

				Loop( { start: int( 0 ), end: int( 8 ), type: 'int', condition: '<', update: 2, name: 'tx' }, ( { tx } ) => {

					const x = ox.add( tx ), y = oy.add( ty );
					If( x.lessThan( width ).and( y.lessThan( height ) ), () => {

						const x1 = min( x.add( int( 1 ) ), width.sub( int( 1 ) ) ), y1 = min( y.add( int( 1 ) ), height.sub( int( 1 ) ) );
						const lum = dot( textureLoad( input, ivec2( x, y ) ).xyz, yw )
							.add( dot( textureLoad( input, ivec2( x1, y ) ).xyz, yw ) )
							.add( dot( textureLoad( input, ivec2( x, y1 ) ).xyz, yw ) )
							.add( dot( textureLoad( input, ivec2( x1, y1 ) ).xyz, yw ) ).mul( 0.25 ).toVar();
						// A NaN or infinite texel is left out, as the meter leaves it out: max() may keep a NaN on some
						// GPUs, and an infinite one would read as 2^40 and darken its whole cell.
						If( floatBitsToUint( lum ).bitAnd( uint( 0x7f800000 ) ).notEqual( uint( 0x7f800000 ) ), () => {

							const logL = log2( max( lum, DARKEST ) ).clamp( LOG_FLOOR, LOG_CEIL ).toVar();
							const f = logL.add( logExposure ).sub( BIN_MIN ).div( BIN_MAX - BIN_MIN ).clamp( 0.0, 1.0 ).mul( BINS - 1 ).toVar();
							const b0 = uint( floor( f ) ).min( uint( BINS - 1 ) );
							const b1 = b0.add( uint( 1 ) ).min( uint( BINS - 1 ) );
							const w1 = f.sub( floor( f ) );
							const w0 = float( 1 ).sub( w1 );
							const level = logL.sub( LOG_FLOOR ).mul( FIXED );
							atomicAdd( sums.element( b0 ), uint( level.mul( w0 ).add( 0.5 ) ) );
							atomicAdd( weights.element( b0 ), uint( w0.mul( FIXED ).add( 0.5 ) ) );
							atomicAdd( sums.element( b1 ), uint( level.mul( w1 ).add( 0.5 ) ) );
							atomicAdd( weights.element( b1 ), uint( w1.mul( FIXED ).add( 0.5 ) ) );

						} );

					} );

				} );

			} );

			workgroupBarrier();

			If( lid.lessThan( uint( BINS ) ), () => {

				const w = float( atomicLoad( weights.element( lid ) ) ).div( FIXED );
				const s = float( atomicLoad( sums.element( lid ) ) ).div( FIXED ).add( w.mul( LOG_FLOOR ) );
				const cell = uint( workgroupId.y ).mul( uint( cellsX ) ).add( uint( workgroupId.x ) );
				grid.element( cell.mul( uint( BINS ) ).add( lid ) ).assign( vec2( s, w ).div( CELL_TEXELS ) );

			} );

		} )().compute( [ 1, 1, 1 ], [ 16, 16, 1 ] );

	}

	// The log of each 32×32 block's mean luminance: averaged in linear light, like the meter, so noise does not darken it.
	_buildBlurSourceKernel() {

		const input = this._inputNode, out = this._blur;
		const width = this._widthU, height = this._heightU, blurW = this._blurWU;
		const yw = vec4( ...Y, 0 ).xyz;

		return Fn( () => {

			const lid = localId.y.mul( uint( 8 ) ).add( localId.x );
			const ox = int( workgroupId.x ).mul( int( BLUR_TEXEL ) ), oy = int( workgroupId.y ).mul( int( BLUR_TEXEL ) );
			const sum = float( 0 ).toVar();
			const count = float( 0 ).toVar();

			Loop( { start: int( localId.y ), end: int( BLUR_TEXEL ), type: 'int', condition: '<', update: 8, name: 'by' }, ( { by } ) => {

				Loop( { start: int( localId.x ), end: int( BLUR_TEXEL ), type: 'int', condition: '<', update: 8, name: 'bx' }, ( { bx } ) => {

					const x = ox.add( bx ), y = oy.add( by );
					If( x.lessThan( width ).and( y.lessThan( height ) ), () => {

						const lum = dot( textureLoad( input, ivec2( x, y ) ).xyz, yw ).toVar();
						const finite = floatBitsToUint( lum ).bitAnd( uint( 0x7f800000 ) ).notEqual( uint( 0x7f800000 ) );
						sum.addAssign( select( finite, lum.max( 0.0 ), float( 0 ) ) );
						count.addAssign( select( finite, float( 1 ), float( 0 ) ) );

					} );

				} );

			} );

			const sharedSum = workgroupArray( 'float', 64 );
			const sharedCount = workgroupArray( 'float', 64 );
			sharedSum.element( lid ).assign( sum );
			sharedCount.element( lid ).assign( count );
			workgroupBarrier();

			for ( let s = 32; s > 0; s >>= 1 ) {

				If( lid.lessThan( uint( s ) ), () => {

					sharedSum.element( lid ).addAssign( sharedSum.element( lid.add( uint( s ) ) ) );
					sharedCount.element( lid ).addAssign( sharedCount.element( lid.add( uint( s ) ) ) );

				} );
				workgroupBarrier();

			}

			If( lid.equal( uint( 0 ) ), () => {

				const mean = sharedSum.element( uint( 0 ) ).div( max( sharedCount.element( uint( 0 ) ), 1.0 ) );
				out.element( uint( int( workgroupId.y ).mul( blurW ).add( int( workgroupId.x ) ) ) ).assign( log2( max( mean, DARKEST ) ).clamp( LOG_FLOOR, LOG_CEIL ) );

			} );

		} )().compute( [ 1, 1, 1 ], [ 8, 8, 1 ] );

	}

	// Unreal's Gaussian, exp( -16.7 ( x / r )² ), along one axis, mirrored at the edges.
	_buildBlurKernel( src, dst, ax ) {

		const blurW = this._blurWU, blurH = this._blurHU, radius = this._radiusU;

		return Fn( () => {

			const x = int( workgroupId.x ).mul( int( 8 ) ).add( int( localId.x ) );
			const y = int( workgroupId.y ).mul( int( 8 ) ).add( int( localId.y ) );
			If( x.lessThan( blurW ).and( y.lessThan( blurH ) ), () => {

				const size = ax ? blurW : blurH;
				const at = ax ? x : y;
				const reach = int( radius.ceil() );
				const sum = float( 0 ).toVar();
				const total = float( 0 ).toVar();

				Loop( { start: reach.negate(), end: reach.add( int( 1 ) ), type: 'int', condition: '<', name: 'o' }, ( { o } ) => {

					const t = float( o ).div( radius );
					const w = exp( t.mul( t ).mul( - 16.7 ) );
					// Mirrored as often as it takes: the radius follows the width, so across a strip four times wider than
					// tall the vertical pass reaches past one reflection, and clamping there piled the taps on row 0.
					const period = size.mul( int( 2 ) );
					const c = at.add( o ).mod( period ).add( period ).mod( period ).toVar();
					If( c.greaterThanEqual( size ), () => {

						c.assign( period.sub( c ).sub( int( 1 ) ) );

					} );
					const i = ax ? y.mul( blurW ).add( c ) : c.mul( blurW ).add( x );
					sum.addAssign( src.element( uint( i ) ).mul( w ) );
					total.addAssign( w );

				} );

				dst.element( uint( y.mul( blurW ).add( x ) ) ).assign( sum.div( total ) );

			} );

		} )().compute( [ 1, 1, 1 ], [ 8, 8, 1 ] );

	}

	// ── Pipeline ─────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this._restarts ++ );

	}

	render( context ) {

		if ( ! this.enabled ) return;
		const samples = context.getState( 'pathtracer:samples' ) ?? 0;
		const last = this._builtAt;
		if ( this._stale || ! this._built || last.restarts !== this._restarts || samples - last.samples >= meterInterval( samples ) ) this.build( context );

	}

	/** Builds the grid and blurred picture from the image on screen now. */
	build( context = this.context ) {

		const input = context?.getTexture( 'pathtracer:color' );
		const width = input?.image?.width | 0, height = input?.image?.height | 0;
		if ( ! input || width < 1 || height < 1 || this._disposed ) return false;

		this._builtAt.restarts = this._restarts;
		this._builtAt.samples = context.getState( 'pathtracer:samples' ) ?? 0;
		this._stale = false;

		const cellsX = Math.min( MAX_CELLS, Math.ceil( width / CELL ) ), cellsY = Math.min( MAX_CELLS, Math.ceil( height / CELL ) );
		const blurW = Math.min( MAX_BLUR, Math.ceil( width / BLUR_TEXEL ) ), blurH = Math.min( MAX_BLUR, Math.ceil( height / BLUR_TEXEL ) );
		const logExposure = Math.log2( Math.max( this.renderer.toneMappingExposure, 1e-6 ) );

		this._inputNode.value = input;
		this._widthU.value = width;
		this._heightU.value = height;
		this._cellsXU.value = cellsX;
		this._blurWU.value = blurW;
		this._blurHU.value = blurH;
		this._radiusU.value = Math.max( 1, BLUR_PERCENT / 100 * blurW );
		this._logExposureU.value = logExposure;
		this._kernels[ 0 ].dispatchSize = [ cellsX, cellsY, 1 ];
		this._kernels[ 1 ].dispatchSize = [ blurW, blurH, 1 ];
		this._kernels[ 2 ].dispatchSize = this._kernels[ 3 ].dispatchSize = [ Math.ceil( blurW / 8 ), Math.ceil( blurH / 8 ), 1 ];
		this.renderer.compute( this._kernels );

		const p = this._params;
		p.set( [ width / CELL, height / CELL, width / BLUR_TEXEL, height / BLUR_TEXEL, cellsX, cellsY, blurW, blurH, logExposure ], 0 );
		this._built = true;
		this._writeParams();
		return true;

	}

	_writeParams() {

		const p = this._params;
		p[ 9 ] = this.highlightContrast;
		p[ 10 ] = this.shadowContrast;
		p[ 11 ] = this.detailStrength;
		p[ 12 ] = BLUR_BLEND;
		p[ 13 ] = MIDDLE_GREY;
		for ( let i = 0; i < 4; i ++ ) this._p[ i ].value.fromArray( p, i * 4 );
		this.onChange?.();

	}

	/** Whether the image on screen should be built from again though no new samples arrive. */
	get wantsBuild() {

		return this.enabled && ( this._stale || ! this._built );

	}

	updateParameters( params ) {

		for ( const key of [ 'highlightContrast', 'shadowContrast', 'detailStrength' ] ) {

			if ( params[ key ] !== undefined ) this[ key ] = params[ key ];

		}

		this._writeParams();

	}

	setEnabled( enabled ) {

		if ( this.enabled === enabled ) return;
		this.enabled = enabled;
		this._stale = true;
		this.onChange?.();

	}

	// ── Applying ─────────────────────────────────────────────

	/** The gain as a TSL node, for the compositor: `rgb` the shown linear colour, `uv` its image position (y down). */
	gainNode( rgb, uv ) {

		const grid = storage( this._grid.value, 'vec2', MAX_CELLS * MAX_CELLS * BINS ).toReadOnly();
		const blur = storage( this._blur.value, 'float', MAX_BLUR * MAX_BLUR ).toReadOnly();
		const [ p0, p1, p2, p3 ] = this._p;

		return Fn( ( [ color, at ] ) => {

			const logL = log2( max( dot( color, vec4( ...Y, 0 ).xyz ), DARKEST ) ).min( LOG_CEIL ).toVar();
			const logExposure = log2( toneMappingExposure ).toVar();

			const bs = ivec2( p1.zw );
			const bp = at.mul( p0.zw ).sub( 0.5 ).clamp( vec2( 0 ), vec2( bs.sub( int( 1 ) ) ) ).toVar();
			const b0 = ivec2( floor( bp ) ).toVar();
			const b1 = b0.add( int( 1 ) ).min( bs.sub( int( 1 ) ) ).toVar();
			const bf = bp.sub( floor( bp ) ).toVar();
			const blurAt = ( x, y ) => blur.element( uint( y.mul( bs.x ).add( x ) ) );
			const blurred = mix( mix( blurAt( b0.x, b0.y ), blurAt( b1.x, b0.y ), bf.x ), mix( blurAt( b0.x, b1.y ), blurAt( b1.x, b1.y ), bf.x ), bf.y ).toVar();

			const cs = ivec2( p1.xy );
			const gp = at.mul( p0.xy ).sub( 0.5 ).clamp( vec2( 0 ), vec2( cs.sub( int( 1 ) ) ) ).toVar();
			const gz = logL.add( p2.x ).sub( BIN_MIN ).div( BIN_MAX - BIN_MIN ).clamp( 0.0, 1.0 ).mul( BINS - 1 ).toVar();
			const gx0 = int( floor( gp.x ) ), gy0 = int( floor( gp.y ) ), gz0 = int( floor( gz ) );
			const fx = gp.x.sub( floor( gp.x ) ), fy = gp.y.sub( floor( gp.y ) ), fz = gz.sub( floor( gz ) );
			const acc = vec2( 0 ).toVar();
			for ( let k = 0; k < 8; k ++ ) {

				const dx = k & 1, dy = ( k >> 1 ) & 1, dz = k >> 2;
				const weight = ( dx ? fx : fx.oneMinus() ).mul( dy ? fy : fy.oneMinus() ).mul( dz ? fz : fz.oneMinus() );
				const cx = gx0.add( int( dx ) ).min( cs.x.sub( int( 1 ) ) );
				const cy = gy0.add( int( dy ) ).min( cs.y.sub( int( 1 ) ) );
				const cz = gz0.add( int( dz ) ).min( int( BINS - 1 ) );
				acc.addAssign( grid.element( uint( cy.mul( cs.x ).add( cx ).mul( int( BINS ) ).add( cz ) ) ).mul( weight ) );

			}

			const bilateral = select( acc.y.mul( CELL_TEXELS ).lessThan( 1e-3 ), blurred, acc.x.div( acc.y ) );
			const base = mix( bilateral, blurred, p3.x ).add( logExposure ).toVar();
			const y = logL.add( logExposure );
			const contrast = select( base.greaterThan( p3.y ), p2.y, p2.z );
			return exp2( p3.y.add( base.sub( p3.y ).mul( contrast ) ).add( y.sub( base ).mul( p2.w ) ).sub( y ) );

		} )( rgb, uv );

	}

	/**
	 * The gain for a tone-mapping pass outside three.js (`PackedToneMapper`'s `gain`), or null before the
	 * first build. `cpu()` reads the grid back for the CPU tone map.
	 */
	toneGain() {

		if ( ! this.enabled || ! this._built ) return null;
		const backend = this.renderer.backend;
		const grid = backend.get( this._grid.value )?.buffer;
		const blur = backend.get( this._blur.value )?.buffer;
		if ( ! grid || ! blur ) return null;

		this._paramsBuffer ??= backend.device.createBuffer( { label: 'local-exposure-params', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST } );
		backend.device.queue.writeBuffer( this._paramsBuffer, 0, this._params );
		const params = this._params.slice();

		return {
			key: 'local-exposure',
			wgsl: LOCAL_EXPOSURE_WGSL,
			entries: [
				{ binding: 0, resource: { buffer: grid } },
				{ binding: 1, resource: { buffer: blur } },
				{ binding: 2, resource: { buffer: this._paramsBuffer } },
			],
			cpu: async () => {

				const [ g, b ] = await Promise.all( [ this.renderer.getArrayBufferAsync( this._grid.value ), this.renderer.getArrayBufferAsync( this._blur.value ) ] );
				const gridData = new Float32Array( g ), blurData = new Float32Array( b );
				return ( u, v, lum, logExposure ) => localExposureGain( params, gridData, blurData, u, v, lum, logExposure );

			},
		};

	}

	reset() {}

	setSize() {}

	dispose() {

		this._disposed = true;
		this.onChange = null;
		for ( const kernel of this._kernels ) kernel.dispose();
		this._inputNode.dispose();
		this._paramsBuffer?.destroy();
		this._paramsBuffer = null;

	}

}
