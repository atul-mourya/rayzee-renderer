/**
 * EmissiveTriangleBuilder
 *
 * Builds an index of emissive triangles for efficient direct lighting sampling.
 * Instead of randomly searching through all triangles, we maintain a list of
 * only the emissive ones, giving 100% sampling success rate.
 */

import { DataTexture, RGBAFormat, FloatType, NearestFilter, SRGBColorSpace, RepeatWrapping, MirroredRepeatWrapping } from 'three';
import { TRIANGLE_DATA_LAYOUT, TRI_MATERIAL_MASK, TRI_EMIT_SIDE_SHIFT } from '../scene/BufferLayout.js';
import { LightBVHBuilder } from './LightBVHBuilder.js';
import { createLogger, fmt } from '../Logger.js';
import { convertLinearTriple, getWorkingMatrix } from '../color/WorkingMatrix.js';
import { holdImages, releaseImages, rgba8Pixels } from '../materials/TextureCreator.js';

const NO_EMISSION = Object.freeze( { r: 0, g: 0, b: 0 } );

// ── Emission maps ────────────────────────────────────────────────
// A triangle under an emission map is weighed by the map's mean over it, so next-event estimation stops drawing
// triangles whose texels are dark. The light tree reads the same stored weight back for its pdf.

const MAP_SIDE = 256; // largest side a map is read at
// Weight a dark triangle keeps, of its flat weight: above zero, so every emitter stays drawable. Unbiased at any value
// (a triangle next-event estimation rarely draws is found by its BSDF hits, weighed so); 1 % sent 97 % of
// buster_drone.glb's samples to the 83 % of its emitting area that is black.
const MAP_FLOOR = 1e-4;
// 16 points of the R2 sequence over the unit square, folded into the triangle: a lattice aliases with tiled maps.
const MAP_POINTS = Array.from( { length: 16 }, ( _, i ) => {

	const a = ( 0.5 + ( i + 1 ) * 0.7548776662466927 ) % 1, b = ( 0.5 + ( i + 1 ) * 0.5698402909980532 ) % 1;
	return a + b > 1 ? [ 1 - a, 1 - b ] : [ a, b ];

} );

const srgbToLinear = c => ( c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4 );

/**
 * A texture's linear colour at most MAP_SIDE a side, as RGB rows in the order its GPU layer holds them (v = 0 first); or
 * null. Averaged after decoding: an average of sRGB bytes read a sparse bright map up to 2.5× dark.
 */
function mapLevel( texture ) {

	const image = texture?.image;
	if ( ! ( image?.width > 0 && image?.height > 0 ) ) return null;
	let source = null, sourceWidth = image.width, sourceHeight = image.height;
	if ( ArrayBuffer.isView( image.data ) ) source = rgba8Pixels( texture );
	else {

		// An image let go after packing keeps a thumbnail. Drawn at most 4× the size kept, the canvas's own (encoded)
		// filtering stays within each texel kept.
		const drawable = image.data === null ? image.thumbnail : image;
		if ( ! drawable?.width || typeof OffscreenCanvas === 'undefined' ) return null;
		const scale = Math.min( 1, 4 * MAP_SIDE / Math.max( drawable.width, drawable.height ) );
		sourceWidth = Math.max( 1, Math.round( drawable.width * scale ) );
		sourceHeight = Math.max( 1, Math.round( drawable.height * scale ) );
		try {

			const context = new OffscreenCanvas( sourceWidth, sourceHeight ).getContext( '2d', { willReadFrequently: true } );
			context.drawImage( drawable, 0, 0, sourceWidth, sourceHeight );
			source = context.getImageData( 0, 0, sourceWidth, sourceHeight ).data;

		} catch {

			return null;

		}

	}

	if ( ! source ) return null;
	const decode = texture.colorSpace === SRGBColorSpace ? v => srgbToLinear( v / 255 ) : v => v / 255;
	const scale = Math.min( 1, MAP_SIDE / Math.max( sourceWidth, sourceHeight ) );
	const width = Math.max( 1, Math.round( sourceWidth * scale ) ), height = Math.max( 1, Math.round( sourceHeight * scale ) );
	// The packer turns a flipY image over: its first row is the image's last.
	const flip = texture.flipY !== false;
	const out = new Float32Array( width * height * 3 );
	for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

		// Box average of the source texels this one covers.
		const y0 = Math.floor( y * sourceHeight / height ), y1 = Math.max( y0 + 1, Math.floor( ( y + 1 ) * sourceHeight / height ) );
		const x0 = Math.floor( x * sourceWidth / width ), x1 = Math.max( x0 + 1, Math.floor( ( x + 1 ) * sourceWidth / width ) );
		const o = ( ( flip ? height - 1 - y : y ) * width + x ) * 3;
		for ( let sy = y0; sy < y1; sy ++ ) for ( let sx = x0; sx < x1; sx ++ ) {

			const i = ( sy * sourceWidth + sx ) * 4;
			out[ o ] += decode( source[ i ] ); out[ o + 1 ] += decode( source[ i + 1 ] ); out[ o + 2 ] += decode( source[ i + 2 ] );

		}

		const n = ( y1 - y0 ) * ( x1 - x0 );
		out[ o ] /= n; out[ o + 1 ] /= n; out[ o + 2 ] /= n;

	}

	return { data: out, width, height };

}

/** A map's linear colour as a pyramid of RGB levels (level 0 = mapLevel's size); null where it cannot be read. */
export function emissionMapPyramid( texture ) {

	const first = mapLevel( texture );
	if ( ! first ) return null;
	let { data: level, width, height } = first;
	const levels = [ { data: level, width, height } ];
	while ( width > 1 || height > 1 ) {

		const w = Math.max( 1, width >> 1 ), h = Math.max( 1, height >> 1 );
		const next = new Float32Array( w * h * 3 );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) for ( let c = 0; c < 3; c ++ ) {

			let sum = 0;
			for ( let dy = 0; dy < 2; dy ++ ) for ( let dx = 0; dx < 2; dx ++ ) {

				sum += level[ ( Math.min( height - 1, y * 2 + dy ) * width + Math.min( width - 1, x * 2 + dx ) ) * 3 + c ];

			}

			next[ ( y * w + x ) * 3 + c ] = sum / 4;

		}

		levels.push( { data: next, width: w, height: h } );
		level = next;
		width = w;
		height = h;

	}

	return { levels, wrapS: texture.wrapS, wrapT: texture.wrapT };

}

const wrap = ( i, n, mode ) => {

	if ( mode === RepeatWrapping ) return ( ( i % n ) + n ) % n;
	if ( mode === MirroredRepeatWrapping ) {

		const m = ( ( i % ( 2 * n ) ) + 2 * n ) % ( 2 * n );
		return m < n ? m : 2 * n - 1 - m;

	}

	return Math.min( n - 1, Math.max( 0, i ) );

};

const IDENTITY = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];

/**
 * The mean of `weights · map` over a triangle given by its three uvs, placed by `m` (three's uv transform, column
 * major), read one pyramid level above the one where each of the 16 points covers its share of the triangle's texels:
 * a little blurred, a triangle half under a bright texel is not read as dark.
 */
export function emissionMapMean( pyramid, uvs, weights, m = IDENTITY ) {

	const u = [], v = [];
	for ( let k = 0; k < 3; k ++ ) {

		const x = uvs[ k * 2 ], y = uvs[ k * 2 + 1 ];
		u.push( m[ 0 ] * x + m[ 3 ] * y + m[ 6 ] );
		v.push( m[ 1 ] * x + m[ 4 ] * y + m[ 7 ] );

	}

	const base = pyramid.levels[ 0 ];
	const texels = Math.abs( ( u[ 1 ] - u[ 0 ] ) * ( v[ 2 ] - v[ 0 ] ) - ( u[ 2 ] - u[ 0 ] ) * ( v[ 1 ] - v[ 0 ] ) ) / 2 * base.width * base.height;
	if ( ! Number.isFinite( texels ) ) return NaN;
	const index = Math.min( pyramid.levels.length - 1, Math.max( 0, Math.floor( 0.5 * Math.log2( Math.max( texels / MAP_POINTS.length, 1 ) ) ) ) + 1 );
	const { data, width, height } = pyramid.levels[ index ];
	let sum = 0;
	for ( const [ a, b ] of MAP_POINTS ) {

		const pu = u[ 0 ] + a * ( u[ 1 ] - u[ 0 ] ) + b * ( u[ 2 ] - u[ 0 ] );
		const pv = v[ 0 ] + a * ( v[ 1 ] - v[ 0 ] ) + b * ( v[ 2 ] - v[ 0 ] );
		const x = wrap( Math.floor( pu * width ), width, pyramid.wrapS ), y = wrap( Math.floor( pv * height ), height, pyramid.wrapT );
		const o = ( y * width + x ) * 3;
		sum += weights[ 0 ] * data[ o ] + weights[ 1 ] * data[ o + 1 ] + weights[ 2 ] * data[ o + 2 ];

	}

	return sum / MAP_POINTS.length;

}

/**
 * A material's emission in the working space.
 *
 * The emitter seen directly reads the material buffer, which is already converted, and so does the
 * shader's pick probability. This buffer is the other copy of the same colour — the one next-event
 * estimation lights the scene with — so it has to move with them, or a working space adopted from a
 * config lights everything in the wrong primaries and weights the pick by a colour nothing renders.
 */
function workingEmissive( emissive ) {

	if ( ! emissive ) return NO_EMISSION;
	if ( ! getWorkingMatrix() ) return emissive;

	const rgb = [ emissive.r, emissive.g, emissive.b ];
	convertLinearTriple( rgb );
	return { r: rgb[ 0 ], g: rgb[ 1 ], b: rgb[ 2 ] };

}

const log = createLogger( 'emissive' );

export class EmissiveTriangleBuilder {

	constructor() {

		this.emissiveTriangles = [];
		this.emissiveCount = 0;
		this.totalEmissivePower = 0;
		this.emissiveIndicesArray = null;
		this.emissivePowerArray = null;
		this.cdfArray = null;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;
		// Per-triangle bit-trail (root→leaf path through the Light BVH), indexed by absolute
		// triangleIndex, -1 for non-emissive. Lets the GPU re-walk the descent pdf for MIS.
		this.emissiveBitTrailMap = null;
		this._totalTriangleCount = 0;
		// Mesh indices whose emissive triangles are excluded from the sampled set
		// (per-mesh visibility). Canonical `emissiveTriangles` is never filtered —
		// the GPU-facing arrays are rebuilt from the visible subset in buildLightBVH().
		this._hiddenMeshes = new Set();
		// Emission map → emissionMapPyramid(), and extracted material → its emission map, from prepareEmissionMaps().
		this._emissionMaps = new WeakMap();
		this._materialMaps = new WeakMap();

	}

	/**
	 * Reads the emission maps of `materials`' emitters, so extraction can weigh their triangles by them. Decodes an image
	 * the packer has let go, and lets it go again. Call before the material textures are packed: packing renumbers the
	 * materials' maps, so each material's map is looked up here, at once.
	 * @param {Array} materials - extracted materials, which name their emission map by its index in `emissiveMaps`
	 * @param {Array<import('three').Texture>} emissiveMaps
	 */
	async prepareEmissionMaps( materials, emissiveMaps = [] ) {

		for ( const material of materials ) {

			const map = material?.emissiveMap >= 0 && material.emissiveIntensity > 0 ? emissiveMaps[ material.emissiveMap ] : null;
			if ( map ) this._materialMaps.set( material, map );

		}

		const maps = [ ...new Set( materials.map( m => m && this._materialMaps.get( m ) ) ) ].filter( map => map && ! this._emissionMaps.has( map ) );
		if ( maps.length === 0 ) return;
		try {

			await holdImages( maps );
			for ( const map of maps ) this._emissionMaps.set( map, emissionMapPyramid( map ) );

		} catch ( error ) {

			log.warn( `emission maps could not be read; their emitters are weighed by colour alone: ${error?.message ?? error}` );

		} finally {

			releaseImages( maps );

		}

	}

	/**
	 * Extract emissive triangles from processed geometry
	 * @param {Uint32Array} triangleData - Packed triangle records
	 * @param {Array} materials - Array of material objects
	 * @param {number} triangleCount - Total number of triangles
	 * @param {import('../scene/InstanceTable.js').InstanceTable} [table] - per placement; triangles are
	 *        stored in object space, so power, bounds and the emission cone all have to be
	 *        measured after the instance transform. One record per triangle, so a template
	 *        placed more than once is lit by its first placement — the extractor expands an
	 *        emissive instanced mesh into per-instance triangles to avoid exactly that.
	 */
	extractEmissiveTriangles( triangleData, materials, triangleCount, table = null ) {

		this.emissiveTriangles = [];
		this._emissiveMeshes = null;
		this.totalEmissivePower = 0;
		this._totalTriangleCount = triangleCount;

		const FLOATS_PER_TRIANGLE = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const MATERIAL_FLAGS_OFFSET = TRIANGLE_DATA_LAYOUT.MATERIAL_FLAGS_OFFSET;
		const MESH_INDEX_OFFSET = TRIANGLE_DATA_LAYOUT.MESH_INDEX_OFFSET;
		const { UV_AB_OFFSET, UV_C_OFFSET } = TRIANGLE_DATA_LAYOUT;
		// Flat array or ChunkedRecords; the chunk is resolved once per triangle.
		const chunked = triangleData && triangleData.chunks ? triangleData : null;
		const chunkedF = chunked ? chunked.viewAs( Float32Array ) : null;
		const flatU = chunked ? null : triangleData;
		const flatF = chunked ? null : new Float32Array( triangleData.buffer, triangleData.byteOffset, triangleData.length );

		// Once per material, not once per triangle: this loop runs over every triangle in the scene.
		const emissiveOf = new Map();
		const mapOf = new Map();
		const uvs = new Float32Array( 6 );

		for ( let i = 0; i < triangleCount; i ++ ) {

			// A chunk a build spilled holds no emitters: that is why it could be spilled.
			if ( chunked?.spilledChunks && ! chunked.isResident( i, 1 ) ) {

				i = ( ( ( i / chunked.recordsPerChunk ) | 0 ) + 1 ) * chunked.recordsPerChunk - 1;
				continue;

			}

			const triU = chunked ? chunked.chunkFor( i ) : flatU;
			const triFloats = chunked ? chunkedF.chunkFor( i ) : flatF;
			const baseOffset = chunked ? chunked.baseOf( i ) : i * FLOATS_PER_TRIANGLE;
			const materialIndex = triU[ baseOffset + MATERIAL_FLAGS_OFFSET ] & TRI_MATERIAL_MASK;
			const meshIndex = triU[ baseOffset + MESH_INDEX_OFFSET ];

			// Get material
			const material = materials[ materialIndex ];
			if ( ! material ) continue;

			// Check if emissive
			let emissive = emissiveOf.get( material );
			if ( emissive === undefined ) {

				emissive = workingEmissive( material.emissive );
				emissiveOf.set( material, emissive );

			}

			const emissiveIntensity = material.emissiveIntensity || 0;

			const isEmissive = emissiveIntensity > 0 && (
				emissive.r > 0 || emissive.g > 0 || emissive.b > 0
			);

			if ( isEmissive ) {

				// Calculate triangle area for power weighting
				// Positions are at offsets 0-11, in the instance's own space
				// `meshIndex` names the template the triangle belongs to, never a row of the
				// per-placement table: indexing the table with it put one object's matrix on
				// another object's light as soon as any instanced mesh came earlier.
				const placement = table?.placementRunOf?.( meshIndex )?.start ?? - 1;
				const hasInstance = placement >= 0 && table.isSet[ placement ];
				const mo = hasInstance ? table.matrixRow( placement ) : 0;
				const m = hasInstance ? table.rowArray : null;
				const px = ( x, y, z ) => ( m ? m[ mo ] * x + m[ mo + 4 ] * y + m[ mo + 8 ] * z + m[ mo + 12 ] : x );
				const py = ( x, y, z ) => ( m ? m[ mo + 1 ] * x + m[ mo + 5 ] * y + m[ mo + 9 ] * z + m[ mo + 13 ] : y );
				const pz = ( x, y, z ) => ( m ? m[ mo + 2 ] * x + m[ mo + 6 ] * y + m[ mo + 10 ] * z + m[ mo + 14 ] : z );

				const o0x = triFloats[ baseOffset + 0 ], o0y = triFloats[ baseOffset + 1 ], o0z = triFloats[ baseOffset + 2 ];
				const o1x = triFloats[ baseOffset + 4 ], o1y = triFloats[ baseOffset + 5 ], o1z = triFloats[ baseOffset + 6 ];
				const o2x = triFloats[ baseOffset + 8 ], o2y = triFloats[ baseOffset + 9 ], o2z = triFloats[ baseOffset + 10 ];

				const v0x = px( o0x, o0y, o0z ), v0y = py( o0x, o0y, o0z ), v0z = pz( o0x, o0y, o0z );
				const v1x = px( o1x, o1y, o1z ), v1y = py( o1x, o1y, o1z ), v1z = pz( o1x, o1y, o1z );
				const v2x = px( o2x, o2y, o2z ), v2y = py( o2x, o2y, o2z ), v2z = pz( o2x, o2y, o2z );

				const area = this._calculateTriangleArea( v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z );

				// Calculate emissive power (Rec.709 luminance * intensity * area) — must match the
				// shader's calculateEmissiveLightPdf luma weighting for MIS consistency.
				const luma = 0.2126 * emissive.r + 0.7152 * emissive.g + 0.0722 * emissive.b;
				const flatPower = luma * emissiveIntensity * area;

				// The light tree's weight: times the emission map's mean over the triangle, as luma of colour × map.
				let map = mapOf.get( material );
				if ( map === undefined ) {

					const texture = this._materialMaps.get( material );
					const pyramid = texture ? this._emissionMaps.get( texture ) : null;
					map = pyramid ? {
						pyramid, matrix: material.emissiveMapMatrices?.length === 9 ? material.emissiveMapMatrices : IDENTITY,
						weights: [ 0.2126 * emissive.r / luma, 0.7152 * emissive.g / luma, 0.0722 * emissive.b / luma ],
					} : null;
					mapOf.set( material, map );

				}

				let mapScale = 1;
				if ( map ) {

					uvs[ 0 ] = triFloats[ baseOffset + UV_AB_OFFSET ]; uvs[ 1 ] = triFloats[ baseOffset + UV_AB_OFFSET + 1 ];
					uvs[ 2 ] = triFloats[ baseOffset + UV_AB_OFFSET + 2 ]; uvs[ 3 ] = triFloats[ baseOffset + UV_AB_OFFSET + 3 ];
					uvs[ 4 ] = triFloats[ baseOffset + UV_C_OFFSET ]; uvs[ 5 ] = triFloats[ baseOffset + UV_C_OFFSET + 1 ];
					const mean = emissionMapMean( map.pyramid, uvs, map.weights, map.matrix );
					// A uv or transform that is not a number reads as colour alone: NaN would poison the whole tree.
					mapScale = Number.isFinite( mean ) ? Math.max( MAP_FLOOR, mean ) : 1;

				}

				const power = flatPower * mapScale;

				// Geometric normal (emission cone axis). BackSide flips it; DoubleSide → two-sided. The sides are the
				// triangle's emitting ones, as the shaders read them.
				const emitSide = ( triU[ baseOffset + MATERIAL_FLAGS_OFFSET ] >>> TRI_EMIT_SIDE_SHIFT ) & 3;
				let nx = ( v1y - v0y ) * ( v2z - v0z ) - ( v1z - v0z ) * ( v2y - v0y );
				let ny = ( v1z - v0z ) * ( v2x - v0x ) - ( v1x - v0x ) * ( v2z - v0z );
				let nz = ( v1x - v0x ) * ( v2y - v0y ) - ( v1y - v0y ) * ( v2x - v0x );
				const nl = Math.sqrt( nx * nx + ny * ny + nz * nz ) || 1;
				const sideSign = emitSide === 1 ? - 1 : 1;
				nx = nx / nl * sideSign;
				ny = ny / nl * sideSign;
				nz = nz / nl * sideSign;
				const twoSided = emitSide === 2;

				// Centroid for BVH split decisions
				const cx = ( v0x + v1x + v2x ) / 3;
				const cy = ( v0y + v1y + v2y ) / 3;
				const cz = ( v0z + v1z + v2z ) / 3;

				// AABB for BVH node bounds
				const bMinX = Math.min( v0x, v1x, v2x );
				const bMinY = Math.min( v0y, v1y, v2y );
				const bMinZ = Math.min( v0z, v1z, v2z );
				const bMaxX = Math.max( v0x, v1x, v2x );
				const bMaxY = Math.max( v0y, v1y, v2y );
				const bMaxZ = Math.max( v0z, v1z, v2z );

				this.emissiveTriangles.push( {
					triangleIndex: i,
					materialIndex: materialIndex,
					meshIndex: meshIndex,
					sideSign,
					instanceLeaf: hasInstance ? table.tlasLeafIndex[ placement ] : - 1,
					power,
					// Colour alone: the bidirectional integrator draws its light paths' starts by it.
					flatPower,
					mapScale,
					area: area,
					emissive: { r: emissive.r, g: emissive.g, b: emissive.b },
					emissiveIntensity: emissiveIntensity,
					cx, cy, cz,
					bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ,
					nx, ny, nz, twoSided,
				} );

				this.totalEmissivePower += flatPower;

			}

		}

		this.emissiveCount = this.emissiveTriangles.length;

		if ( this.emissiveCount > 0 ) {

			log.debug( `${fmt.n( this.emissiveCount )} emissive tris (${( this.emissiveCount / triangleCount * 100 ).toFixed( 2 )}%) · total power ${this.totalEmissivePower.toFixed( 2 )}` );

		}

		// Build data arrays
		this._buildDataArrays();

		return this.emissiveCount;

	}

	/** Mesh indices owning at least one emissive triangle. */
	get emissiveMeshes() {

		return this._emissiveMeshes ??= new Set( this.emissiveTriangles.map( t => t.meshIndex ) );

	}

	/**
	 * Re-measure every emitter at its placement's current matrix. Call buildLightBVH() after.
	 * @param {Uint32Array|object} triangleData - packed triangle records, flat or chunked
	 * @param {import('../scene/InstanceTable.js').InstanceTable} table
	 */
	refreshTransforms( triangleData, table ) {

		const chunked = triangleData && triangleData.chunks ? triangleData : null;
		const chunkedF = chunked ? chunked.viewAs( Float32Array ) : null;
		const flatF = chunked ? null : new Float32Array( triangleData.buffer, triangleData.byteOffset, triangleData.length );
		const FLOATS_PER_TRIANGLE = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		this.totalEmissivePower = 0;

		for ( const tri of this.emissiveTriangles ) {

			const f = chunked ? chunkedF.chunkFor( tri.triangleIndex ) : flatF;
			const b = chunked ? chunked.baseOf( tri.triangleIndex ) : tri.triangleIndex * FLOATS_PER_TRIANGLE;
			const v = [ f[ b ], f[ b + 1 ], f[ b + 2 ], f[ b + 4 ], f[ b + 5 ], f[ b + 6 ], f[ b + 8 ], f[ b + 9 ], f[ b + 10 ] ];

			// As extraction resolves it.
			const placement = table.placementRunOf?.( tri.meshIndex )?.start ?? - 1;
			if ( placement >= 0 && table.isSet[ placement ] ) {

				const o = table.matrixRow( placement ), m = table.rowArray;
				for ( let k = 0; k < 9; k += 3 ) {

					const x = v[ k ], y = v[ k + 1 ], z = v[ k + 2 ];
					v[ k ] = m[ o ] * x + m[ o + 4 ] * y + m[ o + 8 ] * z + m[ o + 12 ];
					v[ k + 1 ] = m[ o + 1 ] * x + m[ o + 5 ] * y + m[ o + 9 ] * z + m[ o + 13 ];
					v[ k + 2 ] = m[ o + 2 ] * x + m[ o + 6 ] * y + m[ o + 10 ] * z + m[ o + 14 ];

				}

			}

			const [ v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z ] = v;
			const area = this._calculateTriangleArea( v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z );
			const e = tri.emissive;
			tri.flatPower = ( 0.2126 * e.r + 0.7152 * e.g + 0.0722 * e.b ) * tri.emissiveIntensity * area;
			tri.power = tri.flatPower * tri.mapScale;
			tri.area = area;

			const nx = ( v1y - v0y ) * ( v2z - v0z ) - ( v1z - v0z ) * ( v2y - v0y );
			const ny = ( v1z - v0z ) * ( v2x - v0x ) - ( v1x - v0x ) * ( v2z - v0z );
			const nz = ( v1x - v0x ) * ( v2y - v0y ) - ( v1y - v0y ) * ( v2x - v0x );
			const nl = ( Math.sqrt( nx * nx + ny * ny + nz * nz ) || 1 ) / tri.sideSign;
			tri.nx = nx / nl; tri.ny = ny / nl; tri.nz = nz / nl;

			tri.cx = ( v0x + v1x + v2x ) / 3; tri.cy = ( v0y + v1y + v2y ) / 3; tri.cz = ( v0z + v1z + v2z ) / 3;
			tri.bMinX = Math.min( v0x, v1x, v2x ); tri.bMinY = Math.min( v0y, v1y, v2y ); tri.bMinZ = Math.min( v0z, v1z, v2z );
			tri.bMaxX = Math.max( v0x, v1x, v2x ); tri.bMaxY = Math.max( v0y, v1y, v2y ); tri.bMaxZ = Math.max( v0z, v1z, v2z );

			this.totalEmissivePower += tri.flatPower;

		}

		this._buildDataArrays();

	}

	/**
	 * Calculate triangle area using cross product
	 */
	_calculateTriangleArea( v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z ) {

		// Edge vectors
		const e1x = v1x - v0x;
		const e1y = v1y - v0y;
		const e1z = v1z - v0z;
		const e2x = v2x - v0x;
		const e2y = v2y - v0y;
		const e2z = v2z - v0z;

		// Cross product
		const cx = e1y * e2z - e1z * e2y;
		const cy = e1z * e2x - e1x * e2z;
		const cz = e1x * e2y - e1y * e2x;

		// Half the length of cross product
		return Math.sqrt( cx * cx + cy * cy + cz * cz ) * 0.5;

	}

	/**
	 * Build typed arrays for GPU upload
	 */
	_buildDataArrays() {

		// Array of emissive triangle indices
		this.emissiveIndicesArray = new Int32Array( this.emissiveCount );

		// Array of emissive power for each triangle (for importance sampling)
		this.emissivePowerArray = new Float32Array( this.emissiveCount );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			this.emissiveIndicesArray[ i ] = this.emissiveTriangles[ i ].triangleIndex;
			this.emissivePowerArray[ i ] = this.emissiveTriangles[ i ].flatPower;

		}

		// Build CDF for importance sampling (optional but recommended)
		this._buildCDF();

	}

	/**
	 * Build Cumulative Distribution Function for importance sampling
	 * This allows sampling brighter emissive triangles more frequently
	 */
	_buildCDF() {

		if ( this.emissiveCount === 0 ) {

			this.cdfArray = new Float32Array( 1 );
			this.cdfArray[ 0 ] = 0;
			return;

		}

		this.cdfArray = new Float32Array( this.emissiveCount );

		let cumulativeSum = 0;
		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			cumulativeSum += this.emissivePowerArray[ i ];
			this.cdfArray[ i ] = cumulativeSum;

		}

		// Normalize CDF to [0, 1]
		if ( cumulativeSum > 0 ) {

			for ( let i = 0; i < this.emissiveCount; i ++ ) {

				this.cdfArray[ i ] /= cumulativeSum;

			}

		}

	}

	/**
	 * Binary search in CDF for importance sampling
	 * @param {number} u - Random value in [0, 1]
	 * @returns {number} - Index of selected emissive triangle
	 */
	sampleCDF( u ) {

		if ( this.emissiveCount === 0 ) return - 1;
		if ( this.emissiveCount === 1 ) return 0;

		// Binary search
		let left = 0;
		let right = this.emissiveCount - 1;

		while ( left < right ) {

			const mid = Math.floor( ( left + right ) / 2 );
			if ( this.cdfArray[ mid ] < u ) {

				left = mid + 1;

			} else {

				right = mid;

			}

		}

		return left;

	}

	/**
	 * Get data for GPU upload
	 */
	getGPUData() {

		return {
			emissiveIndices: this.emissiveIndicesArray,
			emissivePower: this.emissivePowerArray,
			emissiveCDF: this.cdfArray,
			emissiveCount: this.emissiveCount,
			totalPower: this.totalEmissivePower
		};

	}

	/**
	 * Create a DataTexture for GPU upload of emissive indices
	 * We'll pack the indices into a texture for efficient access
	 */
	createEmissiveTexture() {

		if ( this.emissiveCount === 0 ) {

			// Create a 1x1 dummy texture
			const dummyData = new Float32Array( 4 );

			return new DataTexture(
				dummyData,
				1,
				1,
				RGBAFormat,
				FloatType
			);

		}

		// Pack data into RGBA texture: R=triangleIndex, G=power, B=cdf, A=unused
		// Each pixel stores data for one emissive triangle
		const data = new Float32Array( this.emissiveCount * 4 );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const offset = i * 4;
			data[ offset + 0 ] = this.emissiveIndicesArray[ i ]; // R: triangle index
			data[ offset + 1 ] = this.emissivePowerArray[ i ]; // G: power
			data[ offset + 2 ] = this.cdfArray[ i ]; // B: CDF value
			data[ offset + 3 ] = 0; // A: unused

		}

		// Calculate texture dimensions (prefer square-ish textures)
		const width = Math.ceil( Math.sqrt( this.emissiveCount ) );
		const height = Math.ceil( this.emissiveCount / width );

		// Pad data if needed
		const requiredSize = width * height * 4;
		const paddedData = new Float32Array( requiredSize );
		paddedData.set( data );

		const texture = new DataTexture(
			paddedData,
			width,
			height,
			RGBAFormat,
			FloatType
		);

		texture.needsUpdate = true;
		texture.generateMipmaps = false;
		texture.minFilter = NearestFilter;
		texture.magFilter = NearestFilter;

		log.debug( `emissive texture ${fmt.px( width, height )} · ${fmt.n( this.emissiveCount )} entries` );

		return texture;

	}

	/**
	 * Create raw Float32Array for storage buffer (no 2D DataTexture padding).
	 * Each emissive entry is 2 vec4s (8 floats):
	 *   vec4[0]: triangleIndex, power, cdf, selectionPdf
	 *   vec4[1]: emission.r, emission.g, emission.b, area
	 * @returns {Float32Array} Tightly-packed emissive data
	 */
	createEmissiveRawData() {

		if ( this.emissiveCount === 0 ) {

			return new Float32Array( 8 ); // 2 dummy vec4s

		}

		const data = new Float32Array( this.emissiveCount * 8 );

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const tri = this.emissiveTriangles[ i ];
			const offset = i * 8;

			// vec4[0]: triangleIndex, power, cdf, selectionPdf
			data[ offset + 0 ] = tri.triangleIndex;
			data[ offset + 1 ] = tri.power;
			data[ offset + 2 ] = this.cdfArray[ i ];
			// Slot 3 used to repeat power/total, which the shader recomputes anyway. It now
			// names the TLAS leaf that owns this emitter, so sampling can put the triangle
			// back into world space.
			data[ offset + 3 ] = tri.instanceLeaf;

			// vec4[1]: pre-multiplied emission (emissive * intensity), area
			data[ offset + 4 ] = tri.emissive.r * tri.emissiveIntensity;
			data[ offset + 5 ] = tri.emissive.g * tri.emissiveIntensity;
			data[ offset + 6 ] = tri.emissive.b * tri.emissiveIntensity;
			data[ offset + 7 ] = tri.area;

		}

		log.debug( `emissive raw data ${fmt.n( this.emissiveCount )} entries (${fmt.mb( data.byteLength )})` );

		return data;

	}

	/**
	 * Get statistics for debugging
	 */
	getStats() {

		if ( this.emissiveCount === 0 ) {

			return {
				count: 0,
				totalPower: 0,
				averagePower: 0,
				minPower: 0,
				maxPower: 0
			};

		}

		let minPower = Infinity;
		let maxPower = - Infinity;

		for ( let i = 0; i < this.emissiveCount; i ++ ) {

			const power = this.emissivePowerArray[ i ];
			minPower = Math.min( minPower, power );
			maxPower = Math.max( maxPower, power );

		}

		return {
			count: this.emissiveCount,
			totalPower: this.totalEmissivePower,
			averagePower: this.totalEmissivePower / this.emissiveCount,
			minPower: minPower,
			maxPower: maxPower
		};

	}

	/**
	 * Fast update when a material's emissive properties change.
	 * Avoids full triangle scan when possible — only rescans if the set of
	 * emissive triangles may have changed (material became or stopped being emissive).
	 * @param {number} materialIndex - Index of the changed material
	 * @param {object} material - The updated material object
	 * @param {Array} triangleData - Full triangle data (only needed for full rescan)
	 * @param {Array} materials - Materials array (only needed for full rescan)
	 * @param {number} triangleCount - Total triangles (only needed for full rescan)
	 * @param {import('../scene/InstanceTable.js').InstanceTable} [table] - placements (full rescan): shared geometry is in object space
	 * @returns {boolean} true if data changed and needs GPU re-upload
	 */
	updateMaterialEmissive( materialIndex, material, triangleData, materials, triangleCount, table = null ) {

		const emissive = workingEmissive( material.emissive );
		const emissiveIntensity = material.emissiveIntensity || 0;
		const isNowEmissive = emissiveIntensity > 0 && ( emissive.r > 0 || emissive.g > 0 || emissive.b > 0 );

		// Check if this material had any emissive triangles before
		const hadEmissive = this.emissiveTriangles.some( t => t.materialIndex === materialIndex );

		// If the emissive set changed (gained or lost emissive status), full rescan needed
		if ( isNowEmissive !== hadEmissive ) {

			this.extractEmissiveTriangles( triangleData, materials, triangleCount, table );
			return true;

		}

		// If not emissive before and not now, nothing to do
		if ( ! isNowEmissive ) return false;

		// Fast path: update the canonical entries only. Derived arrays, CDF and
		// totals are rebuilt by the buildLightBVH() call that always follows.
		// Rec.709 luma — must match the build path + shader MIS weighting.
		const luma = 0.2126 * emissive.r + 0.7152 * emissive.g + 0.0722 * emissive.b;

		for ( const tri of this.emissiveTriangles ) {

			if ( tri.materialIndex === materialIndex ) {

				tri.flatPower = luma * emissiveIntensity * tri.area;
				tri.power = tri.flatPower * tri.mapScale;
				tri.emissive = { r: emissive.r, g: emissive.g, b: emissive.b };
				tri.emissiveIntensity = emissiveIntensity;

			}

		}

		return true;

	}

	/**
	 * Set the meshes whose emissive triangles must be excluded from sampling
	 * (per-mesh visibility). Indices that don't own emissive triangles are
	 * ignored so non-emissive visibility toggles are no-ops.
	 * @param {Set<number>|Iterable<number>} hiddenMeshIndices
	 * @returns {boolean} true if the effective hidden set changed (caller should rebuild)
	 */
	setHiddenMeshes( hiddenMeshIndices ) {

		const emissiveMeshes = new Set();
		for ( const tri of this.emissiveTriangles ) emissiveMeshes.add( tri.meshIndex );

		const next = new Set();
		for ( const m of hiddenMeshIndices ) if ( emissiveMeshes.has( m ) ) next.add( m );

		const prev = this._hiddenMeshes;
		let changed = next.size !== prev.size;
		if ( ! changed ) {

			for ( const m of next ) {

				if ( ! prev.has( m ) ) {

					changed = true;
					break;

				}

			}

		}

		this._hiddenMeshes = next;
		return changed;

	}

	/**
	 * Build a Light BVH over the VISIBLE emissive triangles (canonical set minus
	 * hidden meshes). Authoritative for the GPU-facing emissiveCount /
	 * totalEmissivePower / sorted raw data / bit-trail map.
	 * @returns {number} nodeCount
	 */
	buildLightBVH() {

		const active = this._hiddenMeshes.size === 0
			? this.emissiveTriangles
			: this.emissiveTriangles.filter( t => ! this._hiddenMeshes.has( t.meshIndex ) );

		this.emissiveCount = active.length;
		this.totalEmissivePower = 0;
		for ( const tri of active ) this.totalEmissivePower += tri.flatPower;

		if ( active.length === 0 ) {

			// Dummy single leaf node (whole-sphere cone)
			this.lightBVHNodeData = new Float32Array( 16 );
			this.lightBVHNodeData[ 7 ] = 1.0; // isLeaf
			this.lightBVHNodeData[ 14 ] = 1.0; // cone axis z
			this.lightBVHNodeData[ 15 ] = - 1.0; // cosThetaO = whole sphere
			this.lightBVHNodeCount = 1;
			// Shade reads the map only while emissiveTriangleCount > 0: one over every triangle was 446 MB on the Moana
			// island, in the tab, on the GPU and in Chrome's upload pool.
			this.emissiveBitTrailMap = new Float32Array( 4 ).fill( - 1 );
			this.emissiveIndicesArray = new Int32Array( 0 );
			this.emissivePowerArray = new Float32Array( 0 );
			this._buildCDF();
			this.emissiveTriangleData = new Float32Array( 8 ); // 2 dummy vec4s
			return 1;

		}

		const builder = new LightBVHBuilder();
		const { nodeData, nodeCount, sortedPerm, bitTrails } = builder.build( active );
		this.lightBVHNodeData = nodeData;
		this.lightBVHNodeCount = nodeCount;

		// Rebuild emissive raw data in sorted leaf order so node start/count refs are valid
		this._rebuildSortedEmissiveData( sortedPerm, active );

		// Build the per-triangle bit-trail map (indexed by absolute triangleIndex; -1 = non-emissive/hidden)
		this.emissiveBitTrailMap = new Float32Array( Math.max( this._totalTriangleCount, 1 ) ).fill( - 1 );
		for ( let i = 0; i < sortedPerm.length; i ++ ) {

			const triIndex = active[ sortedPerm[ i ] ].triangleIndex;
			this.emissiveBitTrailMap[ triIndex ] = bitTrails[ i ];

		}

		return nodeCount;

	}

	/**
	 * Rebuild emissive arrays and raw GPU data in the sorted leaf order given by sortedPerm.
	 * @param {Int32Array} sortedPerm - sortedPerm[i] = index into `tris` for position i
	 * @param {Array} tris - The (visible) triangle set the Light BVH was built over
	 * @private
	 */
	_rebuildSortedEmissiveData( sortedPerm, tris ) {

		const n = sortedPerm.length;

		// Rebuild typed arrays in sorted order
		this.emissiveIndicesArray = new Int32Array( n );
		this.emissivePowerArray = new Float32Array( n );

		for ( let i = 0; i < n; i ++ ) {

			const origIdx = sortedPerm[ i ];
			this.emissiveIndicesArray[ i ] = tris[ origIdx ].triangleIndex;
			this.emissivePowerArray[ i ] = tris[ origIdx ].flatPower;

		}

		// Rebuild CDF for the sorted order (so fallback path still works)
		this._buildCDF();

		// Rebuild raw emissive GPU data (2 vec4s per entry) in sorted order
		const data = new Float32Array( n * 8 );

		for ( let i = 0; i < n; i ++ ) {

			const origIdx = sortedPerm[ i ];
			const tri = tris[ origIdx ];
			const offset = i * 8;

			// vec4[0]: triangleIndex, power, cdf, instance. This is the authoritative writer —
			// buildLightBVH re-sorts the entries and replaces emissiveTriangleData, so the
			// instance has to be carried here too, not only in createEmissiveRawData.
			data[ offset + 0 ] = tri.triangleIndex;
			data[ offset + 1 ] = tri.power;
			data[ offset + 2 ] = this.cdfArray[ i ];
			data[ offset + 3 ] = tri.instanceLeaf;

			// vec4[1]: pre-multiplied emission (emissive * intensity), area
			data[ offset + 4 ] = tri.emissive.r * tri.emissiveIntensity;
			data[ offset + 5 ] = tri.emissive.g * tri.emissiveIntensity;
			data[ offset + 6 ] = tri.emissive.b * tri.emissiveIntensity;
			data[ offset + 7 ] = tri.area;

		}

		this.emissiveTriangleData = data;
		log.debug( `rebuilt sorted emissive data · ${fmt.n( n )} entries` );

	}

	/**
	 * Clear all data
	 */
	clear() {

		this.emissiveTriangles = [];
		this.emissiveCount = 0;
		this.totalEmissivePower = 0;
		this.emissiveIndicesArray = null;
		this.emissivePowerArray = null;
		this.cdfArray = null;
		this.lightBVHNodeData = null;
		this.lightBVHNodeCount = 0;
		// Per-triangle bit-trail (root→leaf path through the Light BVH), indexed by absolute
		// triangleIndex, -1 for non-emissive. Lets the GPU re-walk the descent pdf for MIS.
		this.emissiveBitTrailMap = null;
		this._totalTriangleCount = 0;
		this._hiddenMeshes = new Set();

	}

}
