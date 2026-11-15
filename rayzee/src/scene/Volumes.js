/**
 * Volumes: density (and emission) grids in scene objects, packed as half floats into one 3D texture with their
 * majorants, a header each in a uniform array (VOLUME_LAYOUT). See docs/design/VOLUMES.md.
 */

import { Box3, Color, DataUtils, Matrix4, Object3D, Vector3, Vector4 } from 'three';
import { VOLUME_LAYOUT } from './BufferLayout.js';
import { blackbodyToLinearRGB } from '../color/WhiteBalance.js';
import { convertLinearTriple, getWorkingMatrix } from '../color/WorkingMatrix.js';

const { VEC4S, RAMP, MAX } = VOLUME_LAYOUT;

/** Voxels every volume together may keep on the GPU (half floats); past it the largest grids are halved. */
const MAX_VOLUME_VOXELS = 2 ** 27;

// Majorant cells along a grid's longest side, at most (pbrt keeps 16³).
const MAJORANT_CELLS = 32;
// Every packed grid keeps a zero voxel each side: trilinear lookups at its edge read the background, as OpenVDB's do.
const BORDER = 1;
// Cycles' blackbody: Stefan–Boltzmann's σ in W / mm² K⁴, over π.
const STEFAN_BOLTZMANN = 5.670373e-8 * 1e-6 / Math.PI;

/**
 * A dense grid of values, x fastest: `data[ x + width · ( y + height · z ) ]`. `transform` maps index space, where a
 * voxel's centre is its index (OpenVDB's), into its volume's object space.
 */
export class VolumeGrid {

	/**
	 * @param {Object} grid
	 * @param {number} grid.width
	 * @param {number} grid.height
	 * @param {number} grid.depth
	 * @param {Float32Array} grid.data - width × height × depth values
	 * @param {Matrix4} [grid.transform] - index → object space; identity is one unit a voxel from the origin
	 * @param {string} [grid.name]
	 */
	constructor( { width, height, depth, data, transform = new Matrix4(), name = 'density' } ) {

		if ( ! ( width > 0 && height > 0 && depth > 0 ) ) throw new RangeError( `VolumeGrid: bad size ${width} × ${height} × ${depth}` );
		if ( data.length !== width * height * depth ) throw new RangeError( `VolumeGrid: ${data.length} values for ${width} × ${height} × ${depth}` );
		this.width = width;
		this.height = height;
		this.depth = depth;
		this.data = data;
		this.transform = transform;
		this.name = name;
		this._max = null;

	}

	/** The largest value. */
	get max() {

		if ( this._max === null ) {

			let max = 0;
			for ( let i = 0; i < this.data.length; i ++ ) if ( this.data[ i ] > max ) max = this.data[ i ];
			this._max = max;

		}

		return this._max;

	}

	/** The grid's box in its volume's object space. */
	getBounds( target = new Box3() ) {

		target.min.set( - 0.5, - 0.5, - 0.5 );
		target.max.set( this.width - 0.5, this.height - 0.5, this.depth - 0.5 );
		return target.applyMatrix4( this.transform );

	}

	/**
	 * A grid made of `fn( x, y, z )` over the unit cube centred on the origin, `resolution` voxels along its longest
	 * side: the volume's object space spans [ −0.5, 0.5 ] there.
	 * @param {number|number[]} resolution - voxels a side, or [ width, height, depth ]
	 * @param {function(number, number, number): number} fn
	 */
	static fromFunction( resolution, fn, name = 'density' ) {

		const [ width, height, depth ] = Array.isArray( resolution ) ? resolution : [ resolution, resolution, resolution ];
		const n = Math.max( width, height, depth );
		const data = new Float32Array( width * height * depth );
		let i = 0;
		for ( let z = 0; z < depth; z ++ ) for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			data[ i ++ ] = Math.max( 0, fn( ( x + 0.5 - width / 2 ) / n, ( y + 0.5 - height / 2 ) / n, ( z + 0.5 - depth / 2 ) / n ) );

		}

		const transform = new Matrix4().makeScale( 1 / n, 1 / n, 1 / n ).setPosition( ( 0.5 - width / 2 ) / n, ( 0.5 - height / 2 ) / n, ( 0.5 - depth / 2 ) / n );
		return new VolumeGrid( { width, height, depth, data, transform, name } );

	}

	/**
	 * A cloud or a column of smoke drawn from noise, filling the unit cube centred on the origin.
	 * @param {'cloud'|'smoke'} kind
	 * @param {{ resolution?: number, seed?: number }} [options]
	 */
	static procedural( kind, { resolution = 96, seed = 1 } = {} ) {

		const noise = valueNoise( seed );
		const fbm = ( x, y, z, octaves ) => {

			let sum = 0, amplitude = 0.5, f = 1;
			for ( let o = 0; o < octaves; o ++ ) {

				sum += amplitude * noise( x * f, y * f, z * f );
				amplitude *= 0.5;
				f *= 2.03;

			}

			return sum;

		};

		if ( kind === 'cloud' ) {

			// Cumulus: three overlapping puffs with a flat base, eaten at the edge by billowing noise.
			const puffs = [[ 0, 0, 0, 0.3 ], [ - 0.17, - 0.05, 0.04, 0.2 ], [ 0.18, - 0.07, - 0.05, 0.22 ]];
			return VolumeGrid.fromFunction( [ resolution, Math.round( resolution * 0.75 ), resolution ], ( x, y, z ) => {

				let shape = - 1;
				for ( const [ cx, cy, cz, r ] of puffs ) shape = Math.max( shape, 1 - Math.hypot( x - cx, ( y - cy ) * 1.3, z - cz ) / r );
				if ( y < - 0.2 ) shape -= ( - 0.2 - y ) * 12;
				const billow = Math.abs( fbm( x * 6 + 11, y * 6, z * 6, 5 ) * 2 - 1 );
				return Math.min( 1, ( shape - billow * 0.55 ) * 4 );

			} );

		}

		if ( kind === 'smoke' ) {

			// A plume rising from below, widening and breaking up as it climbs.
			return VolumeGrid.fromFunction( [ Math.round( resolution * 0.6 ), resolution, Math.round( resolution * 0.6 ) ], ( x, y, z ) => {

				const h = y + 0.5;
				const swirl = fbm( x * 4, y * 3 - 7, z * 4, 4 ) - 0.5;
				const radius = 0.05 + h * 0.2;
				const r = Math.hypot( x - swirl * h * 0.5, z - Math.sin( y * 9 ) * 0.04 * h );
				const wisps = fbm( x * 9 + 3, y * 7, z * 9, 5 );
				return ( 1 - r / radius ) * ( 1 - h * 0.6 ) * ( wisps * 1.8 - 0.35 ) * 2;

			} );

		}

		throw new Error( `VolumeGrid.procedural: unknown kind "${kind}" (cloud, smoke)` );

	}

}

// Trilinear value noise in [ 0, 1 ] from a hashed lattice.
function valueNoise( seed ) {

	const hash = ( x, y, z ) => {

		let h = Math.imul( x, 0x27d4eb2d ) ^ Math.imul( y, 0x165667b1 ) ^ Math.imul( z, 0x9e3779b1 ) ^ Math.imul( seed, 0x85ebca6b );
		h = Math.imul( h ^ ( h >>> 15 ), 0x2c1b3c6d );
		h = Math.imul( h ^ ( h >>> 12 ), 0x297a2d39 );
		return ( ( h ^ ( h >>> 15 ) ) >>> 0 ) / 4294967296;

	};

	const smooth = ( t ) => t * t * ( 3 - 2 * t );
	return ( x, y, z ) => {

		const x0 = Math.floor( x ), y0 = Math.floor( y ), z0 = Math.floor( z );
		const fx = smooth( x - x0 ), fy = smooth( y - y0 ), fz = smooth( z - z0 );
		const lerp = ( a, b, t ) => a + ( b - a ) * t;
		const plane = ( z ) => lerp(
			lerp( hash( x0, y0, z ), hash( x0 + 1, y0, z ), fx ),
			lerp( hash( x0, y0 + 1, z ), hash( x0 + 1, y0 + 1, z ), fx ), fy );
		return lerp( plane( z0 ), plane( z0 + 1 ), fz );

	};

}

/**
 * A heterogeneous medium in the scene: a density grid, scaled by `density` into extinction per scene unit, scattering
 * `color` of what it stops through a Henyey–Greenstein phase function, and emitting from an optional second grid.
 * Moves, hides and parents as any object; after changing its inputs, call the renderer's `updateVolumes()`.
 */
export class Volume extends Object3D {

	/**
	 * @param {VolumeGrid} [grid] - density
	 * @param {Object} [options]
	 * @param {number} [options.density=1] - extinction per scene unit a unit of grid value
	 * @param {Color|string|number} [options.color=0xffffff] - what a scatter keeps (the albedo)
	 * @param {number} [options.anisotropy=0] - −0.95…0.95; above 0 it scatters forward
	 * @param {VolumeGrid} [options.emissionGrid] - emission (or, with `blackbody`, temperature)
	 * @param {Color|string|number} [options.emissionColor=0xffffff]
	 * @param {number} [options.emissionStrength=0] - light given per scene unit of length a unit of emission grid value
	 * @param {boolean} [options.blackbody=false] - the emission grid is a temperature: it glows as a black body at
	 *   grid × `temperature` kelvin, as bright as Cycles' Principled Volume at Blackbody Intensity `emissionStrength`
	 * @param {number} [options.temperature=1000] - kelvin a unit of the temperature grid
	 */
	constructor( grid = null, options = {} ) {

		super();
		this.type = 'Volume';
		this.grid = grid;
		this.density = options.density ?? 1;
		this.color = new Color( options.color ?? 0xffffff );
		this.anisotropy = options.anisotropy ?? 0;
		this.emissionGrid = options.emissionGrid ?? null;
		this.emissionColor = new Color( options.emissionColor ?? 0xffffff );
		this.emissionStrength = options.emissionStrength ?? 0;
		this.blackbody = options.blackbody ?? false;
		this.temperature = options.temperature ?? 1000;
		/** pbrt's σa × Le: emission scales with what the medium absorbs there. */
		this.emissionFromAbsorption = options.emissionFromAbsorption ?? false;
		/** `( value ) => [ r, g, b ]`, emission per unit length at an emission grid value, in place of the colour above. */
		this.emissionRamp = options.emissionRamp ?? null;
		/** Its frames over time (loaders/FrameSequence.js): the timeline puts each one's grids here. */
		this.sequence = options.sequence ?? null;
		/** Voxels a side its slot keeps for frames to come: a frame that fits is written in place. */
		this.reserve = null;
		/** The space its sequence's frames take, in its own space, beyond the grid shown: what framing and bounds see. */
		this.extent = null;

	}

	get isVolume() {

		return true;

	}

	/** Whether it gives light. */
	get emits() {

		return !! this.emissionGrid && ( this.emissionRamp !== null || this.emissionStrength > 0 );

	}

	/** Shows a frame of its sequence: `{ grid, emission }`, either null where the frame has none. */
	setFrame( { grid, emission } ) {

		this.grid = grid ?? new VolumeGrid( { width: 1, height: 1, depth: 1, data: new Float32Array( 1 ), transform: this.grid.transform } );
		if ( this.emissionGrid ) this.emissionGrid = emission ?? new VolumeGrid( { ...this.grid, data: new Float32Array( this.grid.data.length ) } );

	}

	/** The grid's box in this object's space. */
	getLocalBounds( target = new Box3() ) {

		if ( this.grid ) this.grid.getBounds( target );
		else target.makeEmpty();
		return this.extent ? target.union( this.extent ) : target;

	}

	copy( source, recursive ) {

		super.copy( source, recursive );
		this.grid = source.grid;
		this.density = source.density;
		this.color.copy( source.color );
		this.anisotropy = source.anisotropy;
		this.emissionGrid = source.emissionGrid;
		this.emissionColor.copy( source.emissionColor );
		this.emissionStrength = source.emissionStrength;
		this.blackbody = source.blackbody;
		this.temperature = source.temperature;
		this.emissionFromAbsorption = source.emissionFromAbsorption;
		this.emissionRamp = source.emissionRamp;
		this.sequence = source.sequence;
		this.reserve = source.reserve;
		this.extent = source.extent;
		return this;

	}

}

/** The volumes under `root`, in traversal order. */
export function collectVolumes( root ) {

	const volumes = [];
	root?.traverse?.( ( object ) => {

		if ( object.isVolume && object.grid ) volumes.push( object );

	} );
	return volumes;

}

// Whether it and every parent are visible.
const shown = ( object ) => {

	for ( let o = object; o; o = o.parent ) if ( ! o.visible ) return false;
	return true;

};

/**
 * A grid halved along every side, each new voxel the mean of the eight it covers (the background past an odd edge).
 * Its transform keeps it where it was.
 */
export function halveGrid( grid ) {

	const { width: w, height: h, depth: d, data } = grid;
	const W = Math.ceil( w / 2 ), H = Math.ceil( h / 2 ), D = Math.ceil( d / 2 );
	const out = new Float32Array( W * H * D );
	for ( let z = 0; z < D; z ++ ) for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		let sum = 0;
		for ( let k = 0; k < 8; k ++ ) {

			const sx = 2 * x + ( k & 1 ), sy = 2 * y + ( ( k >> 1 ) & 1 ), sz = 2 * z + ( k >> 2 );
			if ( sx < w && sy < h && sz < d ) sum += data[ sx + w * ( sy + h * sz ) ];

		}

		out[ x + W * ( y + H * z ) ] = sum / 8;

	}

	const transform = grid.transform.clone().multiply( new Matrix4().makeTranslation( 0.5, 0.5, 0.5 ).scale( new Vector3( 2, 2, 2 ) ) );
	return new VolumeGrid( { width: W, height: H, depth: D, data: out, transform, name: grid.name } );

}

// The emission grid sampled at the density grid's voxels (trilinear, its background 0 outside), so both share a box.
function resampleOnto( grid, onto ) {

	if ( grid.width === onto.width && grid.height === onto.height && grid.depth === onto.depth && grid.transform.equals( onto.transform ) ) return grid.data;

	const toSource = grid.transform.clone().invert().multiply( onto.transform );
	const e = toSource.elements;
	const { width: w, height: h, depth: d, data } = grid;
	const at = ( x, y, z ) => ( x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d ? 0 : data[ x + w * ( y + h * z ) ] );
	const out = new Float32Array( onto.width * onto.height * onto.depth );
	let i = 0;
	for ( let z = 0; z < onto.depth; z ++ ) for ( let y = 0; y < onto.height; y ++ ) for ( let x = 0; x < onto.width; x ++ ) {

		const sx = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
		const sy = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
		const sz = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];
		const x0 = Math.floor( sx ), y0 = Math.floor( sy ), z0 = Math.floor( sz );
		const fx = sx - x0, fy = sy - y0, fz = sz - z0;
		let v = 0;
		for ( let k = 0; k < 8; k ++ ) {

			const dx = k & 1, dy = ( k >> 1 ) & 1, dz = k >> 2;
			v += at( x0 + dx, y0 + dy, z0 + dz ) * ( dx ? fx : 1 - fx ) * ( dy ? fy : 1 - fy ) * ( dz ? fz : 1 - fz );

		}

		out[ i ++ ] = v;

	}

	return out;

}

// The smallest half float at or above v ≥ 0.
function halfAbove( v ) {

	let h = DataUtils.toHalfFloat( v );
	if ( DataUtils.fromHalfFloat( h ) < v ) h ++;
	return h;

}

/**
 * The majorant of each cell of `cell`³ voxels: the largest value a trilinear lookup inside it reads, so the cell's
 * voxels and the ring around them. Grid units, before the volume's density.
 */
export function majorantGrid( grid, cell ) {

	const { width: w, height: h, depth: d, data } = grid;
	const dims = [ w, h, d ];
	const sizes = dims.map( ( n ) => Math.ceil( n / cell ) );
	// The max over voxels [ c·k − 1, c·( k + 1 ) ] along one axis at a time: x, then y, then z.
	let src = data;
	const shape = dims.slice();
	for ( let axis = 0; axis < 3; axis ++ ) {

		const len = shape[ axis ];
		const n = sizes[ axis ];
		const stride = axis === 0 ? 1 : axis === 1 ? shape[ 0 ] : shape[ 0 ] * shape[ 1 ];
		const outShape = shape.slice();
		outShape[ axis ] = n;
		const outStride = axis === 0 ? 1 : axis === 1 ? outShape[ 0 ] : outShape[ 0 ] * outShape[ 1 ];
		const out = new Float32Array( outShape[ 0 ] * outShape[ 1 ] * outShape[ 2 ] );
		const lines = shape[ 0 ] * shape[ 1 ] * shape[ 2 ] / len;
		for ( let l = 0; l < lines; l ++ ) {

			let base, outBase;
			if ( axis === 0 ) {

				base = l * len;
				outBase = l * n;

			} else if ( axis === 1 ) {

				const x = l % shape[ 0 ], z = Math.floor( l / shape[ 0 ] );
				base = x + z * shape[ 0 ] * len;
				outBase = x + z * outShape[ 0 ] * n;

			} else {

				base = l;
				outBase = l;

			}

			for ( let k = 0; k < n; k ++ ) {

				let m = 0;
				for ( let s = Math.max( 0, k * cell - 1 ), e = Math.min( len - 1, ( k + 1 ) * cell ); s <= e; s ++ ) {

					const v = src[ base + s * stride ];
					if ( v > m ) m = v;

				}

				out[ outBase + k * outStride ] = m;

			}

		}

		src = out;
		shape[ axis ] = n;

	}

	return { width: sizes[ 0 ], height: sizes[ 1 ], depth: sizes[ 2 ], data: src };

}

/**
 * Places boxes ( `[ w, h, d ]` ) in a 3D texture no side of which passes `limit`: slabs along z, shelves along y within
 * a slab, boxes along x within a shelf. Tries a few widths and keeps the smallest texture.
 * @returns {{ size: number[], origins: number[][] }}
 */
export function packBoxes( boxes, limit ) {

	const over = boxes.find( ( b ) => b.some( ( n ) => n > limit ) );
	if ( over ) throw new RangeError( `a volume of ${over.join( ' × ' )} does not fit a 3D texture of ${limit} a side` );
	const order = boxes.map( ( _, i ) => i ).sort( ( a, b ) => boxes[ b ][ 2 ] - boxes[ a ][ 2 ] || boxes[ b ][ 1 ] - boxes[ a ][ 1 ] );
	const widest = Math.max( ...boxes.map( ( b ) => b[ 0 ] ) );
	const area = boxes.reduce( ( sum, b ) => sum + b[ 0 ] * b[ 1 ], 0 );
	let best = null;
	for ( const width of new Set( [ widest, Math.ceil( Math.sqrt( area ) ), widest * 2, widest + 64 ].map( ( w ) => Math.min( limit, Math.max( widest, w ) ) ) ) ) {

		const origins = [];
		let slabZ = 0, slabDepth = 0, shelfY = 0, shelfHeight = 0, x = 0, height = 0;
		for ( const i of order ) {

			const [ w, h, d ] = boxes[ i ];
			if ( x + w > width ) {

				shelfY += shelfHeight;
				x = 0;
				shelfHeight = 0;

			}

			if ( shelfY + h > limit ) {

				slabZ += slabDepth;
				shelfY = 0;
				slabDepth = 0;

			}

			origins[ i ] = [ x, shelfY, slabZ ];
			x += w;
			shelfHeight = Math.max( shelfHeight, h );
			slabDepth = Math.max( slabDepth, d );
			height = Math.max( height, shelfY + shelfHeight );

		}

		const size = [ width, height, slabZ + slabDepth ];
		if ( size[ 2 ] > limit ) continue;
		if ( ! best || size[ 0 ] * size[ 1 ] * size[ 2 ] < best.size[ 0 ] * best.size[ 1 ] * best.size[ 2 ] ) best = { size, origins };

	}

	if ( ! best ) throw new RangeError( `volumes do not fit a 3D texture of ${limit} a side` );
	return best;

}

/**
 * Every volume's voxels and majorants in one texture's worth of half floats, and where each landed.
 * @param {Volume[]} volumes
 * @param {{ maxVoxels?: number, maxDimension?: number }} [options]
 * @returns {{ size: number[], channels: number, data: Uint16Array, entries: Object[], halved: string[] }}
 */
export function packVolumes( volumes, { maxVoxels = MAX_VOLUME_VOXELS, maxDimension = 2048 } = {} ) {

	const halved = [];
	const sources = volumes.slice( 0, MAX ).map( ( volume ) => {

		// Packed while it has one, glowing or not: a strength through 0 rewrites a header, not the atlas.
		const { grid, emission } = unifyGrids( volume.grid, volume.emissionGrid ?? null );
		return { volume, grid, emission, source: volume.grid, sourceEmission: emission ? volume.emissionGrid : null, reserve: volume.reserve ?? null };

	} );

	// A sequence's frames come at the size they are read at: its slot is never halved, and its room to grow stops at the
	// texture's side.
	const slotOf = ( s ) => [ s.grid.width, s.grid.height, s.grid.depth ].map( ( n, k ) => Math.max( n, Math.min( s.reserve?.[ k ] ?? 0, maxDimension - 2 * BORDER ) ) );
	const voxels = () => sources.reduce( ( sum, s ) => sum + slotOf( s ).reduce( ( a, b ) => a * b ), 0 );
	for ( ;; ) {

		const halvable = sources.filter( ( s ) => ! s.reserve );
		const tooLong = halvable.find( ( s ) => Math.max( s.grid.width, s.grid.height, s.grid.depth ) + 2 * BORDER > maxDimension );
		const largest = voxels() > maxVoxels && halvable.length ? halvable.reduce( ( a, b ) => ( b.grid.data.length > a.grid.data.length ? b : a ) ) : null;
		const s = tooLong ?? largest;
		if ( ! s ) break;
		halved.push( s.volume.name || s.grid.name );
		s.grid = halveGrid( s.grid );
		if ( s.emission ) s.emission = halveGrid( s.emission );

	}

	const channels = sources.some( ( s ) => s.emission ) ? 2 : 1;
	const boxes = [];
	for ( const s of sources ) {

		s.slot = slotOf( s );
		s.cell = Math.max( 1, Math.ceil( Math.max( ...s.slot ) / MAJORANT_CELLS ) );
		s.majorantSlot = s.slot.map( ( n ) => Math.ceil( n / s.cell ) );
		boxes.push( s.slot.map( ( n ) => n + 2 * BORDER ), s.majorantSlot );

	}

	const { size, origins } = packBoxes( boxes, maxDimension );
	const data = new Uint16Array( size[ 0 ] * size[ 1 ] * size[ 2 ] * channels );
	const entries = sources.map( ( s, v ) => {

		const entry = {
			volume: s.volume, source: s.source, sourceEmission: s.sourceEmission, cell: s.cell, slot: s.slot,
			atlas: origins[ 2 * v ].map( ( o ) => o + BORDER ), majorant: origins[ 2 * v + 1 ],
		};
		const frame = packVolumeFrame( entry, s.grid, s.emission, channels );
		const write = ( box, origin, values ) => {

			for ( let z = 0; z < box[ 2 ]; z ++ ) for ( let y = 0; y < box[ 1 ]; y ++ ) {

				const row = ( box[ 1 ] * z + y ) * box[ 0 ] * channels;
				data.set( values.subarray( row, row + box[ 0 ] * channels ), ( origin[ 0 ] + size[ 0 ] * ( origin[ 1 ] + y + size[ 1 ] * ( origin[ 2 ] + z ) ) ) * channels );

			}

		};

		write( frame.voxelSize, frame.voxelOrigin, frame.voxels );
		write( frame.majorantSize, frame.majorantOrigin, frame.majorants );
		return entry;

	} );

	return { size, channels, data, entries, halved };

}

/** A sequence volume's slot after its current frame outgrew it: a quarter more than the larger of the two each side. */
export function growReserve( volume ) {

	const { grid } = unifyGrids( volume.grid, volume.emissionGrid ?? null );
	return [ grid.width, grid.height, grid.depth ].map( ( n, k ) => Math.ceil( Math.max( n, volume.reserve?.[ k ] ?? 0 ) * 1.25 ) );

}

/**
 * A density grid and an emission grid on one box: the density grid's index space, grown over the emission grid's
 * unless `grow` is false (emission that shows only where there is density), the emission resampled onto it. Either
 * unchanged where they already share one.
 */
export function unifyGrids( grid, emission, { grow = true } = {} ) {

	if ( ! emission ) return { grid, emission: null };
	if ( emission.transform.equals( grid.transform ) && emission.width === grid.width && emission.height === grid.height && emission.depth === grid.depth ) return { grid, emission };
	if ( ! grow ) return { grid, emission: new VolumeGrid( { ...grid, data: resampleOnto( emission, grid ), name: emission.name } ) };
	const box = emission.getBounds().applyMatrix4( grid.transform.clone().invert() );
	const lo = [ Math.min( 0, Math.floor( box.min.x + 0.5 ) ), Math.min( 0, Math.floor( box.min.y + 0.5 ) ), Math.min( 0, Math.floor( box.min.z + 0.5 ) ) ];
	const hi = [ Math.max( grid.width, Math.ceil( box.max.x + 0.5 ) ), Math.max( grid.height, Math.ceil( box.max.y + 0.5 ) ), Math.max( grid.depth, Math.ceil( box.max.z + 0.5 ) ) ];
	if ( lo.some( ( v ) => v < 0 ) || hi[ 0 ] > grid.width || hi[ 1 ] > grid.height || hi[ 2 ] > grid.depth ) grid = regrid( grid, lo, hi );
	return { grid, emission: new VolumeGrid( { ...grid, data: resampleOnto( emission, grid ), name: emission.name } ) };

}

/**
 * A frame's voxels (with the zero ring) and majorants as half floats for its slot, recorded on `entry`; null when it
 * does not fit the slot or the atlas lacks its emission channel.
 * @returns {?{ voxels: Uint16Array, voxelOrigin: number[], voxelSize: number[], majorants: Uint16Array, majorantOrigin: number[], majorantSize: number[] }}
 */
export function packVolumeFrame( entry, grid, emission, channels ) {

	const dims = [ grid.width, grid.height, grid.depth ];
	if ( dims.some( ( n, k ) => n > entry.slot[ k ] ) || ( emission && channels < 2 ) ) return null;
	const [ w, h, d ] = dims;
	const box = dims.map( ( n ) => n + 2 * BORDER );
	const voxels = new Uint16Array( box[ 0 ] * box[ 1 ] * box[ 2 ] * channels );
	for ( let z = 0; z < d; z ++ ) for ( let y = 0; y < h; y ++ ) {

		let src = w * ( y + h * z );
		let dst = ( BORDER + box[ 0 ] * ( y + BORDER + box[ 1 ] * ( z + BORDER ) ) ) * channels;
		for ( let x = 0; x < w; x ++, src ++, dst += channels ) {

			voxels[ dst ] = DataUtils.toHalfFloat( grid.data[ src ] );
			if ( emission ) voxels[ dst + 1 ] = DataUtils.toHalfFloat( emission.data[ src ] );

		}

	}

	const m = majorantGrid( grid, entry.cell );
	const majorants = new Uint16Array( m.data.length * channels );
	// A whisker over: filtering weighs in fixed point, and its sum may pass the largest texel by a rounding.
	for ( let i = 0; i < m.data.length; i ++ ) majorants[ i * channels ] = halfAbove( m.data[ i ] * 1.001 );
	entry.grid = grid;
	entry.emission = emission;
	entry.majorantSize = [ m.width, m.height, m.depth ];
	return {
		voxels, voxelOrigin: entry.atlas.map( ( o ) => o - BORDER ), voxelSize: box,
		majorants, majorantOrigin: entry.majorant, majorantSize: entry.majorantSize,
	};

}

// The grid over index box [ lo, hi ), its values moved, the background outside.
function regrid( grid, lo, hi ) {

	const [ W, H, D ] = [ hi[ 0 ] - lo[ 0 ], hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ];
	const out = new Float32Array( W * H * D );
	const { width: w, height: h, depth: d, data } = grid;
	for ( let z = 0; z < d; z ++ ) for ( let y = 0; y < h; y ++ ) {

		out.set( data.subarray( w * ( y + h * z ), w * ( y + h * z + 1 ) ), - lo[ 0 ] + W * ( y - lo[ 1 ] + H * ( z - lo[ 2 ] ) ) );

	}

	const transform = grid.transform.clone().multiply( new Matrix4().makeTranslation( lo[ 0 ], lo[ 1 ], lo[ 2 ] ) );
	return new VolumeGrid( { width: W, height: H, depth: D, data: out, transform, name: grid.name } );

}

/** Uniform array elements the headers and ramps take. */
const VOLUME_UNIFORM_VEC4S = MAX * ( VEC4S + RAMP );

const _world = new Matrix4();
const _color = new Color();
const _rgb = [ 0, 0, 0 ];

function working( color ) {

	if ( ! getWorkingMatrix() ) return;
	_rgb[ 0 ] = color.r;
	_rgb[ 1 ] = color.g;
	_rgb[ 2 ] = color.b;
	convertLinearTriple( _rgb );
	color.setRGB( _rgb[ 0 ], _rgb[ 1 ], _rgb[ 2 ] );

}

/**
 * Writes the packed volumes' headers and emission ramps into `out` (Vector4s, VOLUME_UNIFORM_VEC4S of them), as they
 * stand now: their world matrices, visibility and inputs, colours in the working space.
 */
export function writeVolumeHeaders( out, entries ) {

	for ( const v of out ) v.set( 0, 0, 0, 0 );
	entries.forEach( ( entry, i ) => {

		const { volume, grid, emission, cell } = entry;
		volume.updateWorldMatrix( true, false );
		// World → index ( its centre at the index ) → grid ( + 0.5 ).
		_world.copy( volume.matrixWorld ).multiply( grid.transform ).invert().premultiply( new Matrix4().makeTranslation( 0.5, 0.5, 0.5 ) );
		const e = _world.elements;
		const h = i * VEC4S;
		for ( let r = 0; r < 3; r ++ ) out[ h + r ].set( e[ r ], e[ 4 + r ], e[ 8 + r ], e[ 12 + r ] );
		out[ h + 3 ].set( ...entry.atlas, shown( volume ) ? Math.max( 0, volume.density ) : - 1 );
		out[ h + 4 ].set( grid.width, grid.height, grid.depth, Math.min( 0.95, Math.max( - 0.95, volume.anisotropy ) ) );
		_color.copy( volume.color );
		working( _color );
		out[ h + 5 ].set( Math.min( 1, Math.max( 0, _color.r ) ), Math.min( 1, Math.max( 0, _color.g ) ), Math.min( 1, Math.max( 0, _color.b ) ), cell );
		const peak = emission?.max ?? 0;
		const emits = peak > 0 && volume.emits;
		out[ h + 6 ].set( ...entry.majorant, emits ? ( volume.emissionFromAbsorption ? 2 : 1 ) : 0 );
		out[ h + 7 ].set( ...entry.majorantSize, emits ? ( RAMP - 1 ) / peak : 0 );
		if ( ! emits ) return;

		const ramp = MAX * VEC4S + i * RAMP;
		for ( let k = 0; k < RAMP; k ++ ) {

			const value = k / ( RAMP - 1 ) * peak;
			if ( volume.emissionRamp ) {

				_color.setRGB( ...volume.emissionRamp( value ) );

			} else if ( volume.blackbody ) {

				const kelvin = value * volume.temperature;
				_color.setRGB( ...blackbodyToLinearRGB( kelvin ) ).multiplyScalar( volume.emissionStrength * STEFAN_BOLTZMANN * kelvin ** 4 );

			} else {

				_color.copy( volume.emissionColor ).multiplyScalar( volume.emissionStrength * value );

			}

			working( _color );
			out[ ramp + k ].set( Math.max( 0, _color.r ), Math.max( 0, _color.g ), Math.max( 0, _color.b ), 0 );

		}

	} );

}

/** Vector4s for {@link writeVolumeHeaders}. */
export const volumeUniformArray = () => Array.from( { length: VOLUME_UNIFORM_VEC4S }, () => new Vector4() );

const _box = new Box3();

/** Grows `box` over the world boxes of the volumes under `root`: three.js's Box3.setFromObject sees no volume. */
export function expandByVolumes( box, root ) {

	for ( const volume of collectVolumes( root ) ) {

		volume.updateWorldMatrix( true, false );
		box.union( volume.getLocalBounds( _box ).applyMatrix4( volume.matrixWorld ) );

	}

	return box;

}
