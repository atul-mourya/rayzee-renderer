/**
 * Convert a parsed pbrt IR into a THREE scene graph the engine can ingest.
 *
 * Output: { group, camera, environment, warnings }
 *   - group:       THREE.Group of meshes (fed to PathTracerApp.loadObject3D)
 *   - camera:      PerspectiveCamera matching the pbrt Camera/LookAt, parented
 *                  into the group so AssetLoader.extractCamerasFromModel finds it
 *   - environment: { texture } | null — set by the caller as scene.environment
 *
 * Handedness: pbrt scenes import correctly as-is. A `diag(1,1,-1)` mirror is
 * available behind `convertHandedness` (default OFF) — three's `lookAt` builds
 * a correct camera basis regardless of source handedness, so no mirror is
 * needed. Enable only if a scene comes out z-mirrored against a known reference.
 */

import {
	Group, Mesh, InstancedMesh, PerspectiveCamera, Matrix4, Vector3,
	BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, SphereGeometry,
	DataTexture, FloatType, RGBAFormat, LinearFilter, EquirectangularReflectionMapping,
	SRGBColorSpace
} from 'three';
import { buildMaterial, pFloat, pString, resolveSpectrum } from './PBRTMaterials.js';
import { loopSubdivide } from './LoopSubdivision.js';
import { octahedralToEquirect } from './EqualAreaOctahedral.js';
import { tessellateCurve } from './PBRTCurves.js';
import * as M from './PBRTMath.js';

const FLIP_Z = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1 ];
const MAX_SKY_READBACK = 4096;

// setIndex() only wraps a plain Array; hand it a typed one and it lands on the geometry
// raw, with no .count, and every consumer downstream reads NaN.
function indexAttribute( indices ) {

	if ( indices instanceof Uint32Array ) return new Uint32BufferAttribute( indices, 1 );
	if ( ArrayBuffer.isView( indices ) && indices.BYTES_PER_ELEMENT === 4 ) {

		return new Uint32BufferAttribute( new Uint32Array( indices.buffer, indices.byteOffset, indices.length ), 1 );

	}

	return new Uint32BufferAttribute( Uint32Array.from( indices ), 1 );

}

function grow( array, needed ) {

	if ( needed <= array.length ) return array;
	let length = array.length || 1;
	while ( length < needed ) length *= 2;
	const out = new array.constructor( length );
	out.set( array );
	return out;

}

/** Reuse a Float32Array parameter as-is; the IR is discarded once the scene is built. */
function float32( values ) {

	return values instanceof Float32Array ? values : Float32Array.from( values );

}

// The per-mesh table is a debug aid; an instanced scene reaches tens of millions of rows.
const MAX_REPORT_ROWS = 1000;
// Triangles are chunked across several arrays now, so the 2 GB V8 cap no longer bounds them at
// 26.8M. The remaining ceiling is the GPU side: one storage buffer of 4,096 MB at 80 B a
// triangle is 53.7M. Untested above 26M — raise `maxTriangles` per load to go further.
const DEFAULT_TRIANGLE_BUDGET = 50_000_000;
// Placements are their own budget: geometry is shared, but each costs a TLAS leaf and an
// instance record. isCoastline's 5.09M loaded and rendered at 23 fps.
const DEFAULT_PLACEMENT_BUDGET = 6_000_000;
// Non-instanced shapes merge into a few large meshes: isPalmRig declares 173,338 of them,
// and one BufferGeometry + Mesh each measured 3.3 GB — the loader OOM'd before tracing.
const DEFAULT_MERGE_MIN_SHAPES = 256;
const MERGE_VERTEX_LIMIT = 4096;
const MERGE_BATCH_TRIANGLES = 500_000;
// Curve tessellation defaults. pbrt sweeps a spline analytically; a triangle tracer has to
// pick a resolution, and isMountainB alone declares 5.18M curves — two samples per span and
// a crossed pair of ribbons is 16 triangles a curve.
const DEFAULT_CURVE_STEPS = 2;
const DEFAULT_CURVE_SIDES = { flat: 1, ribbon: 1, cylinder: 2 };

/** Pixels out of an HTMLImageElement / ImageBitmap, which expose none of their own. */
function pixelsFromDrawable( image, srgb ) {

	const size = Math.min( image.width, MAX_SKY_READBACK );
	let canvas = null;

	if ( typeof OffscreenCanvas !== 'undefined' ) canvas = new OffscreenCanvas( size, size );
	else if ( typeof document !== 'undefined' ) {

		canvas = document.createElement( 'canvas' );
		canvas.width = canvas.height = size;

	} else return null;

	try {

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, size, size );
		const { data } = ctx.getImageData( 0, 0, size, size );
		return { data, width: size, height: size, channels: 4, bottomUp: false, srgb };

	} catch {

		return null;

	}

}

/**
 * Names an unreadable texture may have been derived from. Moana binds colour as
 * `"texture reflectance" "el:part_Color"` and leaves `MakeNamedMaterial "el:part"` in the
 * shared library, so the colour survives the .ptx files being a separate download.
 */
function materialNameCandidates( texName ) {

	const out = [ texName ];
	let n = texName;
	const strips = [
		v => v.replace( /-renamed-\d+$/, '' ),
		v => v.replace( /\d+$/, '' ),
		v => v.replace( /_Color$/i, '' ),
		v => v.replace( /\d+$/, '' )
	];

	for ( const strip of strips ) {

		const next = strip( n );
		if ( next !== n && next ) out.push( n = next );

	}

	return out;

}

export class PBRTSceneBuilder {

	/**
	 * @param {object} resolvers
	 * @param {(filename:string)=>Promise<BufferGeometry>} [resolvers.resolvePLY]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveImage]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveEnvironment]
	 * @param {boolean} [resolvers.convertHandedness=false]
	 */
	constructor( resolvers = {} ) {

		this.maxTriangles = resolvers.maxTriangles ?? DEFAULT_TRIANGLE_BUDGET;
		this.maxPlacements = resolvers.maxPlacements ?? DEFAULT_PLACEMENT_BUDGET;
		this.mergeShapesAbove = resolvers.mergeShapesAbove ?? DEFAULT_MERGE_MIN_SHAPES;
		this.curveSteps = resolvers.curveSteps ?? DEFAULT_CURVE_STEPS;
		this.curveSides = resolvers.curveSides ?? null;
		this.resolvePLY = resolvers.resolvePLY || ( async () => null );
		this.resolveImage = resolvers.resolveImage || ( async () => null );
		this.resolveEnvironment = resolvers.resolveEnvironment || resolvers.resolveImage || ( async () => null );
		this.convertHandedness = resolvers.convertHandedness === true;

		this.warnings = [];
		this.report = []; // per-mesh diagnostics for debugging imports
		this._materialCache = new Map(); // material obj -> Map(areaLight obj -> MeshPhysicalMaterial)
		this._textureCache = new Map(); // texName -> { texture } | { constant }
		this._geometryCache = new Map(); // shape object -> Promise<BufferGeometry|null>
		this._materialBySignature = new Map(); // visual signature -> shared MeshPhysicalMaterial
		this._noUVMaterials = new Map(); // textured material -> its map-less clone
		this._plyCache = new Map(); // filename -> Promise<BufferGeometry|null>

	}

	warn( msg ) {

		this.warnings.push( msg );

	}

	/**
	 * @param {object} ir - output of PBRTParser
	 * @returns {Promise<{group:Group, camera:PerspectiveCamera|null, environment:object|null, warnings:string[]}>}
	 */
	async build( ir ) {

		this.ir = ir;
		this._recoveredColors = 0;
		this.reportedMeshes = 0;
		this.triangleCount = 0; // stored triangles — a shared geometry counts once
		this.placementCount = 0;
		this.skippedForBudget = 0;
		this._countedGeometries = new WeakSet();
		const group = new Group();
		group.name = 'PBRTScene';

		this._batches = ir.shapes.length >= this.mergeShapesAbove ? new Map() : null;
		this._mergedBatches = 0;
		this.mergedShapes = 0;
		this.droppedNoTemplate = 0;

		// Shapes (direct + instanced)
		for ( let i = 0; i < ir.shapes.length; i ++ ) {

			if ( this._overBudget() ) {

				this.skippedForBudget += ir.shapes.length - i;
				break;

			}

			const shape = ir.shapes[ i ];
			const [ geometry, sharedMaterial ] = await Promise.all( [
				this._batches ? this._createGeometry( shape ) : this._buildGeometry( shape ),
				this._getMaterial( shape )
			] );
			if ( ! geometry ) continue;

			if ( this._batches && geometry.getAttribute( 'position' ).count <= MERGE_VERTEX_LIMIT ) {

				this._mergeShape( shape, geometry, sharedMaterial, group );
				ir.shapes[ i ] = null; // its parsed arrays are copied out; let them go
				continue;

			}

			const mesh = this._meshFromGeometry( shape, geometry, sharedMaterial, shape.ctm, `shape_${i}` );
			if ( mesh ) group.add( mesh );

		}

		if ( this._batches ) {

			for ( const slot of this._batches.values() ) {

				this._flushBatch( slot[ 0 ], group );
				this._flushBatch( slot[ 1 ], group );

			}

			this._batches = null;

		}

		await this._buildInstances( ir, group );

		if ( this.skippedForBudget > 0 ) this.warn(
			`stopped at ${this.triangleCount.toLocaleString()} stored triangles ` +
			`(budget ${this.maxTriangles.toLocaleString()}) and ${this.placementCount.toLocaleString()} placements ` +
			`(budget ${this.maxPlacements.toLocaleString()}); ${this.skippedForBudget.toLocaleString()} placement(s) skipped`
		);

		// Camera
		let camera = null;
		if ( ir.camera ) {

			camera = this._buildCamera( ir.camera, ir.film );
			if ( camera ) group.add( camera );

		}

		// Infinite light → environment
		const environment = await this._buildEnvironment( ir.lights );

		this._reportUnsupportedLights( ir.lights );

		if ( this._recoveredColors > 0 ) this.warn(
			`${this._recoveredColors} unreadable texture(s) fell back to the like-named material's colour`
		);

		return {
			group, camera, environment,
			report: this.report,
			meshCount: this.reportedMeshes,
			triangleCount: this.triangleCount,
			placementCount: this.placementCount,
			mergedShapes: this.mergedShapes,
			droppedNoTemplate: this.droppedNoTemplate,
			skippedForBudget: this.skippedForBudget,
			warnings: this.warnings.concat( ir.warnings || [] )
		};

	}

	// ── shapes ─────────────────────────────────────────────────────

	_overBudget() {

		return this.triangleCount >= this.maxTriangles || this.placementCount >= this.maxPlacements;

	}

	/**
	 * Charge a geometry's triangles to the storage budget once, however many placements use
	 * it. Returns its triangle count either way.
	 * @private
	 */
	_accountGeometry( geometry ) {

		const tris = geometry.index ? geometry.index.count / 3 : geometry.getAttribute( 'position' ).count / 3;
		if ( ! this._countedGeometries.has( geometry ) ) {

			this._countedGeometries.add( geometry );
			this.triangleCount += tris;

		}

		return tris;

	}

	/**
	 * Placements become InstancedMesh batches: one object per template shape, carrying a
	 * matrix per placement. Moana's beach ground cover alone is 21 million placements, and a
	 * Three.js object each would be the whole budget before a triangle is traced.
	 */
	async _buildInstances( ir, group ) {

		let n = 0;
		if ( ir.skippedInstances > 0 ) this.skippedForBudget += ir.skippedInstances;

		const scratch = new Float64Array( 16 );
		const matrix = new Matrix4();

		for ( const [ name, list ] of ir.instances ) {

			const template = ir.objects.get( name );
			if ( ! template ) {

				// Counted, not just warned: these are placements that silently leave the scene,
				// and a caller reading skippedForBudget would otherwise be told nothing was lost.
				this.droppedNoTemplate += list.count;
				this.warn( `ObjectInstance "${name}" has no template — ${list.count.toLocaleString()} placement(s) dropped` );
				continue;

			}

			for ( const shape of template ) {

				if ( this._overBudget() ) {

					this.skippedForBudget += list.count;
					continue;

				}

				const [ geometry, sharedMaterial ] = await Promise.all( [
					this._buildGeometry( shape ),
					this._getMaterial( shape )
				] );
				if ( ! geometry ) continue;

				const tris = this._accountGeometry( geometry );
				const affordable = Math.max( 0, this.maxPlacements - this.placementCount );
				const count = Math.min( list.count, affordable );
				if ( count < list.count ) this.skippedForBudget += list.count - count;
				if ( count === 0 ) continue;

				const material = this._materialForGeometry( shape, geometry, sharedMaterial, `instances_${name}` );
				const mesh = new InstancedMesh( geometry, material, count );
				mesh.name = `instance_${n ++}`;
				mesh.frustumCulled = false;

				const rel = shape.relativeCTM || shape.ctm;
				for ( let i = 0; i < count; i ++ ) {

					M.multiplyInto( scratch, list.matrices, i * 16, rel );
					mesh.setMatrixAt( i, matrix.fromArray( this.convertHandedness ? M.multiply( FLIP_Z, scratch ) : scratch ) );

				}

				mesh.instanceMatrix.needsUpdate = true;
				group.add( mesh );

				this.placementCount += count;
				this.reportedMeshes += count;
				if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
					mesh: `${mesh.name} ×${count}`,
					shape: shape.type,
					material: shape.material?.type || 'diffuse',
					color: '#' + material.color.getHexString(),
					map: material.map ? 'yes' : '-',
					uv: geometry.getAttribute( 'uv' ) ? 'yes' : 'NO',
					normals: geometry.getAttribute( 'normal' ) ? 'yes' : 'NO',
					emissive: material.emissiveIntensity > 0 ? `#${material.emissive.getHexString()}×${material.emissiveIntensity}` : '-',
					size: `instanced`,
					tris,
				} );

			}

		}

	}

	async _buildShapeMesh( shape, ctm, name ) {

		// Geometry parse and material/texture resolution are independent — overlap them.
		const [ geometry, sharedMaterial ] = await Promise.all( [
			this._buildGeometry( shape ),
			this._getMaterial( shape )
		] );
		if ( ! geometry ) return null;
		return this._meshFromGeometry( shape, geometry, sharedMaterial, ctm, name );

	}

	_meshFromGeometry( shape, geometry, sharedMaterial, ctm, name ) {

		const hasUV = !! geometry.getAttribute( 'uv' );
		const material = this._materialForGeometry( shape, geometry, sharedMaterial, name );

		const mesh = new Mesh( geometry, material );
		mesh.name = name;

		// Apply the world transform via TRS, NOT a direct mesh.matrix assignment:
		// GeometryExtractor calls mesh.updateMatrix(), which recomposes the matrix
		// from position/quaternion/scale. A directly-set matrix gets overwritten
		// with identity there — silently dropping every per-shape Transform.
		// decompose() round-trips the handedness mirror (det<0) via a negative scale axis.
		const world = this.convertHandedness ? M.multiply( FLIP_Z, ctm ) : ctm;
		new Matrix4().fromArray( world ).decompose( mesh.position, mesh.quaternion, mesh.scale );
		mesh.updateMatrix();

		// World-space dimensions (object bbox transformed by the baked matrix) —
		// surfaces an oversized/under-scaled mesh at a glance.
		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
		const worldSize = geometry.boundingBox
			? geometry.boundingBox.clone().applyMatrix4( mesh.matrix ).getSize( new Vector3() )
			: new Vector3();

		const tris = this._accountGeometry( geometry );
		this.placementCount ++;
		this.reportedMeshes ++;
		if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
			mesh: name,
			shape: shape.type,
			material: shape.material?.type || 'diffuse',
			color: '#' + material.color.getHexString(),
			map: material.map ? 'yes' : '-',
			uv: hasUV ? 'yes' : 'NO',
			normals: geometry.getAttribute( 'normal' ) ? 'yes' : 'NO',
			emissive: material.emissiveIntensity > 0 ? `#${material.emissive.getHexString()}×${material.emissiveIntensity}` : '-',
			size: `${worldSize.x.toFixed( 2 )}×${worldSize.y.toFixed( 2 )}×${worldSize.z.toFixed( 2 )}`,
			tris
		} );

		return mesh;

	}

	/**
	 * A textured material on geometry with no UVs samples a single texel — the usual cause of
	 * "black"/wrong meshes on import. Drop the map, but on a CLONE: _getMaterial shares one
	 * instance across every shape using the same NamedMaterial, so mutating it would strip
	 * the texture from siblings that DO have UVs.
	 * @private
	 */
	_materialForGeometry( shape, geometry, sharedMaterial, name ) {

		if ( ! sharedMaterial.map || geometry.getAttribute( 'uv' ) ) return sharedMaterial;

		// One clone per source material, not per shape — else 173,000 warnings and 173,000
		// materials, defeating every downstream cache that keys on material identity.
		let material = this._noUVMaterials.get( sharedMaterial );
		if ( ! material ) {

			this.warn( `${name} (${shape.type}, "${shape.material?.type || 'diffuse'}") has a texture map but no UVs — dropping map, using base color` );
			material = sharedMaterial.clone();
			material.map = null;
			this._noUVMaterials.set( sharedMaterial, material );

		}

		return material;

	}

	/**
	 * Copy one shape's triangles into a world-space batch, keyed by material and UV presence.
	 * Nothing references the source geometry afterwards, so it is collectable on return.
	 * @private
	 */
	_mergeShape( shape, geometry, sharedMaterial, group ) {

		const material = this._materialForGeometry( shape, geometry, sharedMaterial, 'merged shape' );
		const position = geometry.getAttribute( 'position' );
		const normal = geometry.getAttribute( 'normal' );
		const uv = geometry.getAttribute( 'uv' );
		const index = geometry.index;
		const vertices = position.count;

		// Charged directly: a merged shape stores its own copy even when two share one .ply.
		this.triangleCount += ( index ? index.count : vertices ) / 3;
		this.reportedMeshes ++;
		this.mergedShapes ++;

		let slot = this._batches.get( material );
		if ( ! slot ) this._batches.set( material, slot = [ null, null ] );
		const k = uv ? 1 : 0;
		let batch = slot[ k ];
		if ( ! batch ) slot[ k ] = batch = {
			material,
			positions: new Float32Array( 3072 ),
			normals: new Float32Array( 3072 ),
			uvs: uv ? new Float32Array( 2048 ) : null,
			indices: new Uint32Array( 3072 ),
			vertexCount: 0, indexCount: 0, triangles: 0
		};

		const world = this.convertHandedness ? M.multiply( FLIP_Z, shape.ctm ) : shape.ctm;
		const inv = M.invert( world );
		const base = batch.vertexCount;

		batch.positions = grow( batch.positions, ( base + vertices ) * 3 );
		batch.normals = grow( batch.normals, ( base + vertices ) * 3 );
		if ( uv ) batch.uvs = grow( batch.uvs, ( base + vertices ) * 2 );

		const src = position.array, dst = batch.positions;
		const nsrc = normal ? normal.array : null, ndst = batch.normals;
		for ( let i = 0; i < vertices; i ++ ) {

			const s = i * 3, d = ( base + i ) * 3;
			const x = src[ s ], y = src[ s + 1 ], z = src[ s + 2 ];
			dst[ d ] = world[ 0 ] * x + world[ 4 ] * y + world[ 8 ] * z + world[ 12 ];
			dst[ d + 1 ] = world[ 1 ] * x + world[ 5 ] * y + world[ 9 ] * z + world[ 13 ];
			dst[ d + 2 ] = world[ 2 ] * x + world[ 6 ] * y + world[ 10 ] * z + world[ 14 ];

			if ( ! nsrc ) continue;
			// Inverse transpose, which in column-major order is the inverse read by rows.
			const nx = nsrc[ s ], ny = nsrc[ s + 1 ], nz = nsrc[ s + 2 ];
			let a = inv[ 0 ] * nx + inv[ 1 ] * ny + inv[ 2 ] * nz;
			let b = inv[ 4 ] * nx + inv[ 5 ] * ny + inv[ 6 ] * nz;
			let c = inv[ 8 ] * nx + inv[ 9 ] * ny + inv[ 10 ] * nz;
			const len = Math.hypot( a, b, c );
			if ( len > 0 ) {

				a /= len; b /= len; c /= len;

			}

			ndst[ d ] = a; ndst[ d + 1 ] = b; ndst[ d + 2 ] = c;

		}

		if ( uv ) batch.uvs.set( uv.array.subarray( 0, vertices * 2 ), base * 2 );

		const count = index ? index.count : vertices;
		batch.indices = grow( batch.indices, batch.indexCount + count );
		const idst = batch.indices;
		const isrc = index ? index.array : null;
		for ( let i = 0; i < count; i ++ ) idst[ batch.indexCount + i ] = base + ( isrc ? isrc[ i ] : i );

		batch.vertexCount += vertices;
		batch.indexCount += count;
		batch.triangles += count / 3;

		if ( batch.triangles >= MERGE_BATCH_TRIANGLES ) {

			this._flushBatch( batch, group );
			slot[ k ] = null;

		}

	}

	/** Turn one accumulated batch into a single Mesh at the scene origin. @private */
	_flushBatch( batch, group ) {

		if ( ! batch || batch.triangles === 0 ) return;

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new Float32BufferAttribute( batch.positions.slice( 0, batch.vertexCount * 3 ), 3 ) );
		geometry.setAttribute( 'normal', new Float32BufferAttribute( batch.normals.slice( 0, batch.vertexCount * 3 ), 3 ) );
		if ( batch.uvs ) geometry.setAttribute( 'uv', new Float32BufferAttribute( batch.uvs.slice( 0, batch.vertexCount * 2 ), 2 ) );
		geometry.setIndex( new Uint32BufferAttribute( batch.indices.slice( 0, batch.indexCount ), 1 ) );

		const mesh = new Mesh( geometry, batch.material );
		mesh.name = `merged_${this._mergedBatches ++}`;
		mesh.frustumCulled = false;
		group.add( mesh );

		this.placementCount ++;
		if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
			mesh: mesh.name,
			shape: 'merged',
			material: '-',
			color: '#' + batch.material.color.getHexString(),
			map: batch.material.map ? 'yes' : '-',
			uv: batch.uvs ? 'yes' : 'NO',
			normals: 'yes',
			emissive: batch.material.emissiveIntensity > 0 ? `#${batch.material.emissive.getHexString()}×${batch.material.emissiveIntensity}` : '-',
			size: 'merged',
			tris: batch.triangles
		} );

		batch.positions = batch.normals = batch.uvs = batch.indices = null;

	}

	_buildGeometry( shape ) {

		// An ObjectInstance template is built once per placement, and the Moana palm debris
		// alone places one 208-triangle leaf 2.25 million times. three.js is happy to share
		// one BufferGeometry across meshes; only the per-mesh matrix differs.
		let pending = this._geometryCache.get( shape );
		if ( ! pending ) this._geometryCache.set( shape, pending = this._createGeometry( shape ) );
		return pending;

	}

	async _createGeometry( shape ) {

		switch ( shape.type ) {

			case 'trianglemesh': return this._triangleMesh( shape.params );
			case 'bilinearmesh': return this._bilinearMesh( shape.params );
			case 'loopsubdiv': return this._loopSubdiv( shape.params );
			case 'curve': return this._curve( shape.params );
			case 'plymesh': return this._plyMesh( shape.params );
			case 'sphere': return this._sphere( shape.params );
			case 'disk': return this._disk( shape.params );
			default:
				this.warn( `shape "${shape.type}" not supported — skipped` );
				return null;

		}

	}

	_triangleMesh( params ) {

		const P = params.P?.value;
		if ( ! P || P.length < 9 ) {

			this.warn( 'trianglemesh missing P' ); return null;

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( float32( P ), 3 ) );

		const N = params.N?.value;
		if ( N && N.length === P.length ) geo.setAttribute( 'normal', new Float32BufferAttribute( float32( N ), 3 ) );

		const uv = ( params.uv || params.st )?.value;
		if ( uv && uv.length === ( P.length / 3 ) * 2 ) geo.setAttribute( 'uv', new Float32BufferAttribute( float32( uv ), 2 ) );

		const indices = params.indices?.value;
		if ( indices && indices.length ) geo.setIndex( indexAttribute( indices ) );

		if ( ! N ) geo.computeVertexNormals();
		return geo;

	}

	_curve( params ) {

		const P = params.P?.value;
		if ( ! P || P.length < 12 ) {

			this.warn( 'curve needs at least 4 control points' ); return null;

		}

		const degree = Math.round( pFloat( params, 'degree', 3 ) );
		if ( degree !== 3 ) {

			this.warn( `curve degree ${degree} not supported — only cubic` ); return null;

		}

		const type = pString( params, 'type', 'flat' );
		const width = pFloat( params, 'width', 1 );
		const built = tessellateCurve( {
			P,
			basis: pString( params, 'basis', 'bezier' ),
			width0: pFloat( params, 'width0', width ),
			width1: pFloat( params, 'width1', width ),
			N: params.N?.value || null,
			steps: this.curveSteps,
			sides: this.curveSides ?? DEFAULT_CURVE_SIDES[ type ] ?? 1
		} );

		if ( ! built ) {

			this.warn( 'curve could not be tessellated' ); return null;

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( built.positions, 3 ) );
		geo.setIndex( new Uint32BufferAttribute( built.indices, 1 ) );
		geo.computeVertexNormals();
		return geo;

	}

	_loopSubdiv( params ) {

		const P = params.P?.value;
		const indices = params.indices?.value;
		if ( ! P || P.length < 9 || ! indices || indices.length < 3 ) {

			this.warn( 'loopsubdiv missing P/indices' ); return null;

		}

		// pbrt's default is 3; each level quadruples the face count, so a deep level on
		// a dense cage is worth refusing rather than stalling the import.
		const requested = Math.max( 0, Math.min( 6, Math.round( pFloat( params, 'levels', 3 ) ) ) );
		const { positions, indices: faces, levels } = loopSubdivide( P, indices, requested );

		if ( levels < requested ) this.warn(
			`loopsubdiv refined ${levels}/${requested} levels — the control mesh is too dense for the triangle budget`
		);

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
		geo.setIndex( new Uint32BufferAttribute( faces, 1 ) );
		geo.computeVertexNormals();
		return geo;

	}

	// Bilinear patch mesh → triangulate each quad (P + indices in quads of 4).
	_bilinearMesh( params ) {

		const P = params.P?.value;
		const quad = params.indices?.value;
		if ( ! P || ! quad ) {

			this.warn( 'bilinearmesh missing P/indices' ); return null;

		}

		const tris = [];
		for ( let i = 0; i + 3 < quad.length; i += 4 ) {

			const [ a, b, c, d ] = [ quad[ i ], quad[ i + 1 ], quad[ i + 2 ], quad[ i + 3 ] ];
			tris.push( a, b, c, a, c, d );

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( Float32Array.from( P ), 3 ) );
		geo.setIndex( tris );
		geo.computeVertexNormals();
		return geo;

	}

	_plyMesh( params ) {

		const filename = pString( params, 'filename', null );
		if ( ! filename ) {

			this.warn( 'plymesh missing filename' ); return null;

		}

		// Two shapes can name the same .ply, and decoding it twice costs the full parse.
		let pending = this._plyCache.get( filename );
		if ( ! pending ) this._plyCache.set( filename, pending = this._decodePly( filename ) );
		return pending;

	}

	async _decodePly( filename ) {

		try {

			const geo = await this.resolvePLY( filename );
			if ( ! geo ) {

				this.warn( `plymesh file not found: ${filename}` ); return null;

			}

			if ( ! geo.getAttribute( 'normal' ) ) geo.computeVertexNormals();
			return geo;

		} catch ( e ) {

			this.warn( `failed to load plymesh ${filename}: ${e.message}` );
			return null;

		}

	}

	_sphere( params ) {

		const radius = pFloat( params, 'radius', 1 );
		return new SphereGeometry( radius, 48, 32 );

	}

	_disk( params ) {

		// Approximate as a thin ring/disk in the z=height plane.
		const radius = pFloat( params, 'radius', 1 );
		const inner = pFloat( params, 'innerradius', 0 );
		const h = pFloat( params, 'height', 0 );
		const seg = 48;
		const pos = [];
		const idx = [];
		for ( let i = 0; i < seg; i ++ ) {

			const a0 = ( i / seg ) * Math.PI * 2;
			const a1 = ( ( i + 1 ) / seg ) * Math.PI * 2;
			const base = pos.length / 3;
			pos.push( Math.cos( a0 ) * inner, Math.sin( a0 ) * inner, h );
			pos.push( Math.cos( a0 ) * radius, Math.sin( a0 ) * radius, h );
			pos.push( Math.cos( a1 ) * radius, Math.sin( a1 ) * radius, h );
			pos.push( Math.cos( a1 ) * inner, Math.sin( a1 ) * inner, h );
			idx.push( base, base + 1, base + 2, base, base + 2, base + 3 );

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( Float32Array.from( pos ), 3 ) );
		geo.setIndex( idx );
		geo.computeVertexNormals();
		return geo;

	}

	// ── materials (with area-light emission) ───────────────────────

	async _getMaterial( shape ) {

		// Cache by (material, areaLight) object identity — many shapes share a
		// NamedMaterial, so this dedupes the build + texture-decode work. Nested
		// Map keys on the object refs directly (null is a valid key).
		let byLight = this._materialCache.get( shape.material );
		if ( ! byLight ) {

			byLight = new Map();
			this._materialCache.set( shape.material, byLight );

		}

		if ( byLight.has( shape.areaLight ) ) return byLight.get( shape.areaLight );

		const ctx = {
			resolveNamedTexture: ( n ) => this._resolveNamedTexture( n ),
			namedMaterials: this.ir.namedMaterials,
			warn: ( m ) => this.warn( m )
		};
		const material = await buildMaterial( shape.material, ctx );

		if ( shape.areaLight ) await this._applyAreaLight( material, shape.areaLight, ctx );

		const shared = this._dedupeMaterial( material );
		byLight.set( shape.areaLight, shared );
		return shared;

	}

	/**
	 * Collapse materials that render identically onto one instance — an inline `Material` per
	 * shape is a distinct object every time, so every batch would hold exactly one shape.
	 * @private
	 */
	_dedupeMaterial( material ) {

		const c = material.color, e = material.emissive;
		const key = `${c.r},${c.g},${c.b}|${e.r},${e.g},${e.b}|${material.emissiveIntensity}|` +
			`${material.map ? material.map.uuid : '-'}|${material.roughness}|${material.metalness}|` +
			`${material.transmission}|${material.ior}|${material.thickness}|` +
			`${material.clearcoat}|${material.clearcoatRoughness}|${material.opacity}|${material.side}`;

		const existing = this._materialBySignature.get( key );
		if ( existing ) return existing;
		this._materialBySignature.set( key, material );
		return material;

	}

	async _applyAreaLight( material, areaLight, ctx ) {

		const L = await resolveSpectrum( areaLight.params, 'L', ctx, [ 1, 1, 1 ] );
		const scale = pFloat( areaLight.params, 'scale', 1 );
		const rgb = L.rgb || [ 1, 1, 1 ];
		material.emissive.setRGB( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );
		material.emissiveIntensity = scale;

	}

	async _resolveNamedTexture( name ) {

		if ( this._textureCache.has( name ) ) return this._textureCache.get( name );

		const def = this.ir.namedTextures.get( name );
		let result = null;

		if ( ! def ) {

			this.warn( `named texture "${name}" not defined` );

		} else if ( def.class === 'imagemap' ) {

			const filename = pString( def.params, 'filename', null );
			if ( filename ) {

				try {

					const tex = await this.resolveImage( filename );
					if ( tex ) result = { texture: tex };
					else this.warn( `image not found for texture "${name}": ${filename}` );

				} catch ( e ) {

					this.warn( `failed to load texture "${name}" (${filename}): ${e.message}` );

				}

			}

		} else if ( def.class === 'constant' ) {

			const v = def.params.value;
			if ( v && v.type === 'rgb' ) result = { constant: [ v.value[ 0 ], v.value[ 1 ], v.value[ 2 ] ] };
			else if ( v ) result = { constant: [ v.value[ 0 ], v.value[ 0 ], v.value[ 0 ] ] };

		} else if ( def.class === 'scale' ) {

			// Scale = inner_texture * scale_factor. Resolve the inner (recursively if
			// it's a named ref) and the scale factor (rgb/float/spectrum), then propagate
			// both: the inner texture passes through as the `map`, and the scale becomes
			// the material's color tint (three.js multiplies map.rgb × color.rgb).
			result = await this._resolveScaleTexture( name, def );

		} else {

			const recovered = this._colorFromLikeNamedMaterial( name );
			if ( recovered ) {

				result = { constant: recovered.rgb };
				this._recoveredColors ++;

			} else {

				this.warn( `texture class "${def.class}" not supported (texture "${name}")` );

			}

		}

		this._textureCache.set( name, result );
		return result;

	}

	_colorFromLikeNamedMaterial( texName ) {

		for ( const candidate of materialNameCandidates( texName ) ) {

			const mat = this.ir?.namedMaterials?.get( candidate );
			const p = mat?.params?.reflectance;
			if ( p && ( p.type === 'rgb' || p.type === 'color' ) ) {

				return { name: candidate, rgb: [ p.value[ 0 ], p.value[ 1 ], p.value[ 2 ] ] };

			}

		}

		return null;

	}

	async _resolveScaleTexture( name, def ) {

		// pbrt-v4 uses "tex" (the inner texture or constant) and "scale" (the multiplier).
		const innerP = def.params.tex;
		let inner = null;

		if ( innerP?.type === 'texture' && typeof innerP.value[ 0 ] === 'string' ) {

			inner = await this._resolveNamedTexture( innerP.value[ 0 ] );

		} else if ( innerP?.type === 'rgb' || innerP?.type === 'color' ) {

			inner = { constant: [ innerP.value[ 0 ], innerP.value[ 1 ], innerP.value[ 2 ] ] };

		} else if ( innerP?.type === 'float' ) {

			const v = innerP.value[ 0 ];
			inner = { constant: [ v, v, v ] };

		}

		const sP = def.params.scale;
		let scale = [ 1, 1, 1 ];
		if ( sP?.type === 'rgb' || sP?.type === 'color' ) scale = [ sP.value[ 0 ], sP.value[ 1 ], sP.value[ 2 ] ];
		else if ( sP?.type === 'float' ) {

			const v = sP.value[ 0 ]; scale = [ v, v, v ];

		}

		if ( inner?.texture ) {

			const c = inner.constant || [ 1, 1, 1 ];
			return {
				texture: inner.texture,
				constant: [ c[ 0 ] * scale[ 0 ], c[ 1 ] * scale[ 1 ], c[ 2 ] * scale[ 2 ] ]
			};

		}

		const c = inner?.constant || [ 1, 1, 1 ];
		return { constant: [ c[ 0 ] * scale[ 0 ], c[ 1 ] * scale[ 1 ], c[ 2 ] * scale[ 2 ] ] };

	}

	// ── camera ─────────────────────────────────────────────────────

	_buildCamera( cam, film ) {

		const m = new Matrix4().fromArray( cam.cameraToWorld );
		const e = m.elements;

		// Columns of cameraToWorld: right(0), up(1), dir(2), eye(3).
		let eye = new Vector3( e[ 12 ], e[ 13 ], e[ 14 ] );
		let dir = new Vector3( e[ 8 ], e[ 9 ], e[ 10 ] );
		let up = new Vector3( e[ 4 ], e[ 5 ], e[ 6 ] );

		if ( this.convertHandedness ) {

			eye.z *= - 1; dir.z *= - 1; up.z *= - 1;

		}

		const target = eye.clone().add( dir );

		const aspect = film && film.yresolution ? film.xresolution / film.yresolution : 16 / 9;
		const fov = this._verticalFov( cam.params, aspect );

		const camera = new PerspectiveCamera( fov, aspect, 0.01, 10000 );
		camera.name = 'PBRT Camera';
		camera.up.copy( up.normalize() );
		camera.position.copy( eye );
		camera.lookAt( target );

		// pbrt's camera space is left-handed: image-right is cameraToWorld's first column,
		// = cross(up, dir). three's lookAt() builds cross(up, -dir) — the opposite — so a
		// plain pbrt scene imports left-right flipped against pbrt's own render. An
		// exported scene's `Scale -1 1 1` already negates that column (det < 0), and then
		// lookAt() happens to agree and no correction is wanted. Hence: mirror exactly when
		// the scene does NOT. Verified against the reference images for contemporary-bathroom
		// (has the Scale) and killeroos/killeroo-simple (does not).
		if ( ( M.determinant3( cam.cameraToWorld ) > 0 ) !== this.convertHandedness ) camera.scale.x = - 1;

		camera.updateMatrixWorld( true );
		return camera;

	}

	// pbrt `fov` is the angle along the SHORTER image axis. THREE uses vertical fov.
	_verticalFov( params, aspect ) {

		const pbrtFov = pFloat( params, 'fov', 90 );
		if ( aspect >= 1 ) return pbrtFov; // landscape: shorter axis is vertical
		// portrait: pbrt fov is horizontal → convert to vertical
		const h = pbrtFov * Math.PI / 180;
		const v = 2 * Math.atan( Math.tan( h / 2 ) / aspect );
		return v * 180 / Math.PI;

	}

	// ── lights / environment ───────────────────────────────────────

	/**
	 * A square infinite-light image is pbrt's equal-area octahedral layout, not a
	 * lat-long panorama — resample it, folding in the light's transform and `scale`.
	 * Returns null when the image is not square (nothing to convert) or its pixels are
	 * not readable, leaving the caller's equirectangular path in place.
	 */
	_equirectFromInfiniteLight( tex, inf, scale, filename ) {

		const image = tex.image;
		if ( ! image?.width || image.width !== image.height ) {

			if ( image?.width !== image?.height ) this.warn(
				`infinite-light image "${filename}" is ${image?.width}x${image?.height}, not square — ` +
				'read as equirectangular, but pbrt would read it as equal-area octahedral'
			);
			return null;

		}

		let src = null;

		if ( image.data ) {

			const channels = image.data.length / ( image.width * image.height );
			if ( ! Number.isInteger( channels ) || channels < 3 ) return null;
			// three's EXR/HDR loaders fill DataTexture rows bottom-up; pbrt reads the square top-down.
			src = { data: image.data, width: image.width, height: image.height, channels, bottomUp: true };

		} else {

			// A PNG sky has no readable pixels of its own; without these the octahedral map
			// used to fall through and be sampled as a lat-long panorama.
			src = pixelsFromDrawable( image, tex.colorSpace === SRGBColorSpace );
			if ( ! src ) {

				this.warn( `infinite-light image "${filename}" could not be read back for octahedral conversion` );
				return null;

			}

		}

		const { data: pixels, width, height } = octahedralToEquirect( src, inf.ctm, scale );

		const out = new DataTexture( pixels, width, height, RGBAFormat, FloatType );
		out.mapping = EquirectangularReflectionMapping;
		out.minFilter = LinearFilter;
		out.magFilter = LinearFilter;
		out.needsUpdate = true;
		return out;

	}

	async _buildEnvironment( lights ) {

		const inf = lights.find( l => l.type === 'infinite' );
		if ( ! inf ) return null;

		const scale = pFloat( inf.params, 'scale', 1 );
		const filename = pString( inf.params, 'filename', null );

		if ( filename ) {

			try {

				const tex = await this.resolveEnvironment( filename );
				if ( tex ) {

					const converted = this._equirectFromInfiniteLight( tex, inf, scale, filename );
					if ( converted ) return { texture: converted };

					tex.mapping = EquirectangularReflectionMapping;
					return { texture: tex };

				}

				this.warn( `infinite-light image not found: ${filename}` );

			} catch ( e ) {

				this.warn( `failed to load infinite-light image ${filename}: ${e.message}` );

			}

		}

		// Constant-radiance infinite light → tiny float texture (CDF-buildable).
		const ctx = { resolveNamedTexture: async () => null, warn: ( m ) => this.warn( m ) };
		const L = await resolveSpectrum( inf.params, 'L', ctx, [ 1, 1, 1 ] );
		const rgb = ( L.rgb || [ 1, 1, 1 ] ).map( v => v * scale );

		const w = 2, h = 1;
		const data = new Float32Array( w * h * 4 );
		for ( let i = 0; i < w * h; i ++ ) {

			data[ i * 4 + 0 ] = rgb[ 0 ];
			data[ i * 4 + 1 ] = rgb[ 1 ];
			data[ i * 4 + 2 ] = rgb[ 2 ];
			data[ i * 4 + 3 ] = 1;

		}

		const tex = new DataTexture( data, w, h, RGBAFormat, FloatType );
		tex.mapping = EquirectangularReflectionMapping;
		tex.minFilter = LinearFilter;
		tex.magFilter = LinearFilter;
		tex.needsUpdate = true;
		return { texture: tex };

	}

	_reportUnsupportedLights( lights ) {

		for ( const l of lights ) {

			if ( l.type !== 'infinite' ) {

				this.warn( `light "${l.type}" not supported (only infinite lights and emissive area lights are mapped)` );

			}

		}

	}

}
