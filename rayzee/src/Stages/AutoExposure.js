import { Fn, float, int, uint, ivec2, vec2, vec4, uniform, If, Loop, max, min, select, exp, log2, dot,
	textureLoad, workgroupArray, workgroupBarrier, localId, workgroupId, attributeArray,
	atomicAdd, atomicLoad, atomicStore, floatBitsToUint } from 'three/tsl';
import { TextureNode, ReadbackBuffer } from 'three/webgpu';
import { Matrix3, Vector2, Vector3 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { getWorkingMatrix } from '../Color/WorkingMatrix.js';

export const AUTO_EXPOSURE_DEFAULTS = {
	autoExposure: false,
	autoExposureMetering: 'center',
	autoExposureStrength: 0.3,
	autoExposureKeyValue: 0.18,
	autoExposureMinExposure: 0.1,
	autoExposureMaxExposure: 20.0,
	autoExposureAdaptSpeedBright: 3.0,
	autoExposureAdaptSpeedDark: 1.0,
};

export const METERING_MODES = [ 'average', 'center', 'spot' ];

const GRID = 64; // metering tiles per axis at most
const MIN_TILE = 8; // pixels per tile side at least, so a one-sample image averages enough of them
const WG = 8;
const BINS = 256;
const LOG2_MIN = - 16;
const LOG2_MAX = 12;
const BIN_STOPS = ( LOG2_MAX - LOG2_MIN ) / BINS;
// A tile below this has no light to meter: a black or transparent background is not part of the exposure.
const BLACK = 2 ** - 24;
const WEIGHT_SCALE = 65536;
const MAX_TILE_READS = 256;
const SPOT_FALLOFF = 128; // Gaussian over image heights: σ ≈ 6 % of the frame height
const TRANSITION_STOPS = 1.5;
const SETTLED_STOPS = 0.01;
const MAX_STEP_SECONDS = 0.25;
const ROOM_SECONDS = 4; // camera motion the room level takes to follow
const MOTION_HOLD = 0.3; // a metering of a new view counts as motion for this long
const DAMP_UNTIL = 1.5; // stops from the manual exposure: the room level is damped up to here...
const FOLLOW_FROM = 3; // ...and followed fully from here
const REC709_Y = [ 0.2126, 0.7152, 0.0722 ];

/**
 * One adaptation step in stops: constant speed while far, exponential near the target, never past it.
 * @param {number} current - exposure, log2
 * @param {number} target - exposure, log2
 * @param {number} dt - seconds; Infinity lands on the target
 * @param {number} speedBright - stops a second while the scene gets brighter (exposure falls)
 * @param {number} speedDark - stops a second while it gets darker
 */
export function adaptExposureEV( current, target, dt, speedBright, speedDark ) {

	const delta = target - current;
	if ( delta === 0 || ! ( dt > 0 ) ) return current;
	const speed = Math.max( delta < 0 ? speedBright : speedDark, 1e-3 );
	if ( dt === Infinity ) return target;
	const step = Math.min( speed * dt, Math.abs( delta ) * ( 1 - Math.exp( - speed * dt / TRANSITION_STOPS ) ) );
	return current + Math.sign( delta ) * step;

}

/**
 * Where the exposure aims, in stops from the manual exposure: the room level, damped to `strength` near the
 * manual exposure and followed far from it, plus the view's difference from the room at `strength`.
 */
export function blendExposureEV( room, view, strength ) {

	const a = Math.abs( room );
	const w = a <= DAMP_UNTIL ? strength : a >= FOLLOW_FROM ? 1 : strength + ( 1 - strength ) * ( a - DAMP_UNTIL ) / ( FOLLOW_FROM - DAMP_UNTIL );
	return room * w + strength * ( view - room );

}

// Luminance weights of the working space: Rec.709's Y row through the working matrix's inverse.
function workingLuminance( matrix, out ) {

	if ( ! matrix ) return out.fromArray( REC709_Y );
	const inv = new Matrix3().set( ...matrix ).invert().elements; // column-major
	return out.set(
		REC709_Y[ 0 ] * inv[ 0 ] + REC709_Y[ 1 ] * inv[ 1 ] + REC709_Y[ 2 ] * inv[ 2 ],
		REC709_Y[ 0 ] * inv[ 3 ] + REC709_Y[ 1 ] * inv[ 4 ] + REC709_Y[ 2 ] * inv[ 5 ],
		REC709_Y[ 0 ] * inv[ 6 ] + REC709_Y[ 1 ] * inv[ 7 ] + REC709_Y[ 2 ] * inv[ 8 ],
	);

}

// Fewer meterings as the image converges: its metered brightness settles like the noise does.
const meterInterval = samples => samples < 16 ? 1 : samples < 64 ? 4 : 16;

/**
 * Auto exposure: meters the accumulated image on the GPU and adapts on the CPU.
 *
 * Tiles are averaged in linear light, weighted by alpha, so a one-sample image meters like the
 * converged one; the percentile-clipped mean of their log2 histogram is read back. It aims at a room
 * level learned while the view changes plus a damped share of each view (`blendExposureEV`), moves in
 * stops every loop frame (`update()`), in video time (`advance()`), or with each metering (`instant`),
 * and is applied as 2^EV × the manual exposure.
 *
 * Events listened: pipeline:reset, pipeline:lightingChanged (lands on the next metering)
 * Textures read: pathtracer:color
 * State published: autoexposure:value, autoexposure:avgLuminance
 */
export class AutoExposure extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'AutoExposure', { ...options, executionMode: StageExecutionMode.ALWAYS } );

		this.renderer = renderer;

		this.metering = options.metering ?? AUTO_EXPOSURE_DEFAULTS.autoExposureMetering;
		this.meteringPoint = new Vector2( 0.5, 0.5 ); // image uv, y down
		this.keyValue = options.keyValue ?? AUTO_EXPOSURE_DEFAULTS.autoExposureKeyValue;
		this.minExposure = options.minExposure ?? AUTO_EXPOSURE_DEFAULTS.autoExposureMinExposure;
		this.maxExposure = options.maxExposure ?? AUTO_EXPOSURE_DEFAULTS.autoExposureMaxExposure;
		this.adaptSpeedBright = options.adaptSpeedBright ?? AUTO_EXPOSURE_DEFAULTS.autoExposureAdaptSpeedBright;
		this.adaptSpeedDark = options.adaptSpeedDark ?? AUTO_EXPOSURE_DEFAULTS.autoExposureAdaptSpeedDark;
		this.centerWeight = options.centerWeight ?? 8.0;
		this.strength = options.strength ?? AUTO_EXPOSURE_DEFAULTS.autoExposureStrength;
		this.instant = false;
		/** Called when a metering moves the target, or a change needs a frame; the viewer wakes its loop. */
		this.onChange = null;

		this._lowU = uniform( options.lowPercentile ?? 0.10 );
		this._highU = uniform( options.highPercentile ?? 0.90 );
		this._falloffU = uniform( new Vector2() );
		this._pointU = uniform( new Vector2( 0.5, 0.5 ) );
		this._lumWeightsU = uniform( new Vector3().fromArray( REC709_Y ) );
		this._widthU = uniform( 1, 'int' );
		this._heightU = uniform( 1, 'int' );
		this._strideU = uniform( 1, 'int' );
		this._gridXU = uniform( GRID, 'int' );
		this._gridYU = uniform( GRID, 'int' );
		this._inputNode = new TextureNode();
		this._workingMatrix = undefined;

		this._histogram = attributeArray( BINS, 'uint' ).toAtomic();
		this._result = attributeArray( 1, 'vec4' );
		this._readback = new ReadbackBuffer( 16 );
		this._readback.name = 'AutoExposure';
		this._kernels = [ this._buildTileKernel(), this._buildResolveKernel() ];

		this._compensation = 1;
		this._exposureEV = 0;
		this._targetEV = null;
		this._viewEV = null;
		this._roomEV = null;
		this._clock = 0;
		this._movingUntil = - 1;
		this._viewMoves = 0;
		this._landed = null;
		this._meteredLog2 = null;
		this._snap = true;
		this._lastUpdate = null;
		this._emittedEV = null;
		this._pending = null;
		this._generation = 0;
		this._restarts = 0;
		this._meteredAt = { restarts: - 1, samples: - 1 };
		this._stale = false;
		this._disposed = false;

	}

	// ── Kernels ──────────────────────────────────────────────

	_buildTileKernel() {

		const input = this._inputNode;
		const hist = this._histogram;
		const width = this._widthU, height = this._heightU, stride = this._strideU, gridX = this._gridXU, gridY = this._gridYU;
		const lumWeights = this._lumWeightsU, falloff = this._falloffU, point = this._pointU;

		return Fn( () => {

			const lid = localId.y.mul( uint( WG ) ).add( localId.x );
			const tx = int( workgroupId.x ), ty = int( workgroupId.y );
			const x0 = tx.mul( width ).div( gridX ).toVar(), x1 = tx.add( int( 1 ) ).mul( width ).div( gridX ).toVar();
			const y0 = ty.mul( height ).div( gridY ).toVar(), y1 = ty.add( int( 1 ) ).mul( height ).div( gridY ).toVar();
			const step = stride.mul( int( WG ) );

			const sum = float( 0 ).toVar();
			const cover = float( 0 ).toVar();

			// Whole 8×8 blocks, every stride-th: skipping single pixels would still fetch their memory.
			Loop( { start: y0.add( int( localId.y ) ), end: y1, type: 'int', condition: '<', update: step, name: 'py' }, ( { py } ) => {

				Loop( { start: x0.add( int( localId.x ) ), end: x1, type: 'int', condition: '<', update: step, name: 'px' }, ( { px } ) => {

					const c = textureLoad( input, ivec2( px, py ) );
					const lum = dot( c.xyz, lumWeights ).toVar();
					// NaN or Inf would poison the whole tile.
					const finite = floatBitsToUint( lum ).bitAnd( uint( 0x7f800000 ) ).notEqual( uint( 0x7f800000 ) );
					const alpha = c.w.clamp( 0.0, 1.0 );
					sum.addAssign( select( finite, lum.clamp( 0.0, 1e6 ), float( 0 ) ).mul( alpha ) );
					cover.addAssign( alpha );

				} );

			} );

			const sharedSum = workgroupArray( 'float', WG * WG );
			const sharedCover = workgroupArray( 'float', WG * WG );
			sharedSum.element( lid ).assign( sum );
			sharedCover.element( lid ).assign( cover );
			workgroupBarrier();

			for ( let s = ( WG * WG ) >> 1; s > 0; s >>= 1 ) {

				If( lid.lessThan( uint( s ) ), () => {

					sharedSum.element( lid ).addAssign( sharedSum.element( lid.add( uint( s ) ) ) );
					sharedCover.element( lid ).addAssign( sharedCover.element( lid.add( uint( s ) ) ) );

				} );
				workgroupBarrier();

			}

			If( lid.equal( uint( 0 ) ), () => {

				const total = sharedSum.element( uint( 0 ) ).toVar();
				const covered = sharedCover.element( uint( 0 ) ).toVar();
				const readsAlong = ( span ) => span.div( step ).mul( int( WG ) ).add( min( span.mod( step ), int( WG ) ) );
				const reads = float( readsAlong( x1.sub( x0 ) ).mul( readsAlong( y1.sub( y0 ) ) ) );

				If( covered.greaterThan( 0.0 ).and( total.greaterThan( covered.mul( BLACK ) ) ), () => {

					const level = log2( total.div( covered ) );
					const bin = uint( level.sub( LOG2_MIN ).div( BIN_STOPS ).floor().clamp( 0.0, BINS - 1 ) );
					const uv = vec2( float( x0.add( x1 ) ).div( float( width ) ), float( y0.add( y1 ) ).div( float( height ) ) ).mul( 0.5 );
					const d = uv.sub( point );
					const weight = exp( dot( d.mul( d ), falloff ).negate() ).mul( covered.div( max( reads, 1.0 ) ) );
					const q = uint( weight.mul( WEIGHT_SCALE ).add( 0.5 ) );
					If( q.greaterThan( uint( 0 ) ), () => {

						atomicAdd( hist.element( bin ), q );

					} );

				} );

			} );

		} )().compute( [ GRID, GRID, 1 ], [ WG, WG, 1 ] );

	}

	_buildResolveKernel() {

		const hist = this._histogram;
		const result = this._result;
		const low = this._lowU, high = this._highU;

		return Fn( () => {

			const t = localId.x;
			const weight = float( atomicLoad( hist.element( t ) ) ).toVar();
			atomicStore( hist.element( t ), uint( 0 ) );

			const scan = workgroupArray( 'float', BINS );
			const levels = workgroupArray( 'float', BINS );
			scan.element( t ).assign( weight );
			workgroupBarrier();

			for ( let offset = 1; offset < BINS; offset <<= 1 ) {

				const v = scan.element( t ).toVar();
				If( t.greaterThanEqual( uint( offset ) ), () => {

					v.addAssign( scan.element( t.sub( uint( offset ) ) ) );

				} );
				workgroupBarrier();
				scan.element( t ).assign( v );
				workgroupBarrier();

			}

			const total = scan.element( uint( BINS - 1 ) ).toVar();
			const above = scan.element( t ).toVar();
			workgroupBarrier();

			// Only the bin's share inside the percentiles: a bin crossing one moves the mean smoothly.
			const part = max( min( above, total.mul( high ) ).sub( max( above.sub( weight ), total.mul( low ) ) ), 0.0 );
			scan.element( t ).assign( part );
			levels.element( t ).assign( part.mul( float( t ).add( 0.5 ).mul( BIN_STOPS ).add( LOG2_MIN ) ) );
			workgroupBarrier();

			for ( let s = BINS >> 1; s > 0; s >>= 1 ) {

				If( t.lessThan( uint( s ) ), () => {

					scan.element( t ).addAssign( scan.element( t.add( uint( s ) ) ) );
					levels.element( t ).addAssign( levels.element( t.add( uint( s ) ) ) );

				} );
				workgroupBarrier();

			}

			If( t.equal( uint( 0 ) ), () => {

				const kept = scan.element( uint( 0 ) );
				result.element( uint( 0 ) ).assign( vec4( levels.element( uint( 0 ) ).div( max( kept, 1e-6 ) ), total.div( WEIGHT_SCALE ), kept.div( WEIGHT_SCALE ), 1.0 ) );

			} );

		} )().compute( [ 1, 1, 1 ], [ BINS, 1, 1 ] );

	}

	// ── Pipeline ─────────────────────────────────────────────

	setupEventListeners() {

		this.on( 'pipeline:reset', () => this._restarts ++ );
		this.on( 'pipeline:lightingChanged', () => this.resetHistory() );

	}

	render( context ) {

		if ( ! this.enabled ) return;

		if ( ! this._pending ) {

			const samples = context.getState( 'pathtracer:samples' ) ?? 0;
			const last = this._meteredAt;
			const due = this._stale || this._targetEV === null || last.restarts !== this._restarts || samples - last.samples >= meterInterval( samples );
			if ( due ) this._meter( context, samples );

		}

		context.setState( 'autoexposure:value', this.renderer.toneMappingExposure );
		context.setState( 'autoexposure:avgLuminance', this.luminance );

	}

	/**
	 * Meters the current image once, after any metering in flight, and resolves to the metered
	 * luminance (log2), or null when nothing could be metered. Does not move the exposure.
	 */
	async meter( context = this.context ) {

		while ( this._pending ) await this._pending;
		const done = this._meter( context, context?.getState( 'pathtracer:samples' ) ?? 0 );
		return done ? ( await done ) : null;

	}

	_meter( context, samples ) {

		const input = context?.getTexture( 'pathtracer:color' );
		const width = input?.image?.width | 0, height = input?.image?.height | 0;
		if ( ! input || width < 1 || height < 1 || this._disposed ) return null;

		this._meteredAt.restarts = this._restarts;
		this._meteredAt.samples = samples;
		this._stale = false;

		const matrix = getWorkingMatrix();
		if ( matrix !== this._workingMatrix ) {

			this._workingMatrix = matrix;
			workingLuminance( matrix, this._lumWeightsU.value );

		}

		const gridX = Math.min( GRID, Math.max( 1, Math.floor( width / MIN_TILE ) ) );
		const gridY = Math.min( GRID, Math.max( 1, Math.floor( height / MIN_TILE ) ) );
		const tileReads = ( width / gridX ) * ( height / gridY );
		this._gridXU.value = gridX;
		this._gridYU.value = gridY;
		this._kernels[ 0 ].dispatchSize = [ gridX, gridY, 1 ];
		this._strideU.value = Math.max( 1, Math.round( Math.sqrt( tileReads / MAX_TILE_READS ) ) );
		this._widthU.value = width;
		this._heightU.value = height;
		this._updateMeteringPattern( width / height );
		this._inputNode.value = input;

		this.renderer.compute( this._kernels );

		const generation = this._generation;
		const image = { restarts: this._restarts, moves: this._viewMoves };
		const pending = this.renderer.getArrayBufferAsync( this._result.value, this._readback ).then( ( readback ) => {

			const data = readback?.buffer ? new Float32Array( readback.buffer.slice( 0, 16 ) ) : null;
			this._readback.release();
			return data && generation === this._generation && ! this._disposed ? this._applyMetering( data, image ) : null;

		}, () => {

			if ( ! this._disposed && this._readback._mapped ) this._readback.release();
			return null;

		} ).finally( () => {

			if ( this._pending === pending ) this._pending = null;

		} );

		this._pending = pending;
		return pending;

	}

	_updateMeteringPattern( aspect ) {

		const falloff = this._falloffU.value;
		const point = this._pointU.value;

		if ( this.metering === 'average' ) {

			falloff.set( 0, 0 );

		} else if ( this.metering === 'spot' ) {

			falloff.set( SPOT_FALLOFF * aspect * aspect, SPOT_FALLOFF );
			point.copy( this.meteringPoint );
			return;

		} else {

			falloff.set( this.centerWeight, this.centerWeight );

		}

		point.set( 0.5, 0.5 );

	}

	// `image` is the restart and view count it was metered at; none re-reads the same image.
	_applyMetering( data, image = this._landed ) {

		const [ level, total, kept ] = data;
		if ( ! this.enabled || ! ( total > 0 && kept > 0 ) || ! Number.isFinite( level ) ) return null;

		const before = this._viewEV;
		this._meteredLog2 = level;
		this._viewEV = this._inRange( Math.log2( this.keyValue ) - level );

		if ( this._roomEV === null ) {

			this._roomEV = this._viewEV;

		} else if ( image?.moves !== this._landed?.moves ) {

			this._movingUntil = this._clock + MOTION_HOLD;

		} else if ( image === this._landed || image.restarts !== this._landed.restarts ) {

			// The scene changed under a still camera, or the meter reads it differently: the room changed with it.
			this._roomEV += this._viewEV - before;

		}

		this._landed = image;

		const target = this._aim();
		const moved = this._targetEV === null || Math.abs( target - this._targetEV ) > SETTLED_STOPS;
		this._targetEV = target;
		if ( moved || this.settling ) this.onChange?.();
		return level;

	}

	// ── Adaptation ───────────────────────────────────────────

	/**
	 * Steps the exposure by the wall-clock time since the last call. Returns whether it changed.
	 * @param {number} [now=performance.now()]
	 */
	update( now = performance.now() ) {

		const dt = this._lastUpdate === null ? 0 : Math.min( ( now - this._lastUpdate ) / 1000, MAX_STEP_SECONDS );
		const changed = this.advance( dt );
		// Settled and still, the loop may sleep: the time until the next metering is not adaptation time.
		this._lastUpdate = this.settling || this._clock <= this._movingUntil ? now : null;
		return changed;

	}

	/**
	 * Steps the exposure by `seconds` towards the last metering; Infinity lands on it. Returns whether it changed.
	 * @param {number} seconds
	 */
	advance( seconds ) {

		if ( ! this.enabled || this._targetEV === null ) return false;

		// The room level learns only while the view changes: staring at one view does not make it the room.
		if ( seconds > 0 && seconds !== Infinity ) {

			this._clock += seconds;
			if ( this._clock <= this._movingUntil ) {

				this._roomEV += ( this._viewEV - this._roomEV ) * ( 1 - Math.exp( - Math.min( seconds, MAX_STEP_SECONDS ) / ROOM_SECONDS ) );
				this._targetEV = this._aim();

			}

		}

		const before = this._exposureEV;
		if ( this._snap || this.instant ) {

			this._exposureEV = this._targetEV;
			this._snap = false;

		} else {

			this._exposureEV = adaptExposureEV( before, this._targetEV, seconds, this.adaptSpeedBright, this.adaptSpeedDark );
			if ( Math.abs( this._targetEV - this._exposureEV ) <= SETTLED_STOPS ) this._exposureEV = this._targetEV;

		}

		if ( this._exposureEV === before ) return false;
		this._apply();
		return true;

	}

	_inRange( ev ) {

		return Math.min( Math.max( ev, Math.log2( this.minExposure ) ), Math.log2( this.maxExposure ) );

	}

	_aim() {

		return this._inRange( blendExposureEV( this._roomEV, this._viewEV, this.strength ) );

	}

	/** The camera moved: readings until it stops are of other views, not of a changed scene. */
	noteViewChanged() {

		this._viewMoves ++;

	}

	/** Whether the exposure is still on its way to the last metering. */
	get settling() {

		return this.enabled && this._targetEV !== null && ( this._snap || Math.abs( this._targetEV - this._exposureEV ) > 0 );

	}

	/** Whether the image on screen should be metered again though no new samples arrive. */
	get wantsMetering() {

		return this.enabled && ! this._pending && ( this._stale || this._targetEV === null );

	}

	_apply() {

		this.renderer.toneMappingExposure = this.enabled ? 2 ** this._exposureEV * this._compensation : this._compensation;
		if ( ! this.enabled || ( this._emittedEV !== null && Math.abs( this._exposureEV - this._emittedEV ) < 0.005 ) ) return;

		this._emittedEV = this._exposureEV;
		this.emit( 'autoexposure:updated', {
			exposure: this.renderer.toneMappingExposure,
			autoExposure: this.getExposure(),
			targetExposure: this._targetEV === null ? null : 2 ** this._targetEV,
			luminance: this.luminance,
		} );

	}

	// ── State ────────────────────────────────────────────────

	/**
	 * @param {boolean} enabled
	 * @param {number} [compensation] - the manual exposure, multiplied in while on and applied alone while off
	 */
	setEnabled( enabled, compensation = this._compensation ) {

		this._compensation = compensation;
		if ( enabled === this.enabled ) {

			this._apply();
			return;

		}

		this.enabled = enabled;
		this._emittedEV = null;
		if ( enabled ) this.resetHistory();
		this._apply();
		this.onChange?.();

	}

	/** The manual exposure: a bias in stops on top of the metered exposure while auto exposure is on. */
	setCompensation( value ) {

		this._compensation = value;
		this._apply();

	}

	/** Forget the exposure history: the next metering is applied at once. */
	resetHistory() {

		this._generation ++;
		this._targetEV = null;
		this._viewEV = null;
		this._roomEV = null;
		this._landed = null;
		this._meteredLog2 = null;
		this._snap = true;

	}

	/** Lands on the last metering now. */
	snap() {

		this._snap = true;
		this.advance( 0 );

	}

	/** The metered exposure, without compensation. */
	getExposure() {

		return 2 ** this._exposureEV;

	}

	/** Geometric mean luminance of the last metering, or null. */
	get luminance() {

		return this._meteredLog2 === null ? null : 2 ** this._meteredLog2;

	}

	getLuminance() {

		return this.luminance;

	}

	updateParameters( params ) {

		const metering = params.metering;
		if ( metering !== undefined && METERING_MODES.includes( metering ) ) this.metering = metering;
		if ( params.meteringPoint ) this.meteringPoint.set( params.meteringPoint.x, params.meteringPoint.y );
		for ( const key of [ 'keyValue', 'minExposure', 'maxExposure', 'adaptSpeedBright', 'adaptSpeedDark', 'centerWeight', 'strength' ] ) {

			if ( params[ key ] !== undefined ) this[ key ] = params[ key ];

		}

		if ( params.lowPercentile !== undefined ) this._lowU.value = params.lowPercentile;
		if ( params.highPercentile !== undefined ) this._highU.value = params.highPercentile;

		this._stale = true;
		if ( this._meteredLog2 !== null ) this._applyMetering( [ this._meteredLog2, 1, 1 ] );
		this.onChange?.();

	}

	reset() {}

	setSize() {}

	dispose() {

		this._disposed = true;
		this.onChange = null;
		for ( const kernel of this._kernels ) kernel.dispose();
		this._readback.dispose();
		this._inputNode.dispose();

	}

}
