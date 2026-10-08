import { BufferAttribute, Vector3, Vector2, Color, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide, RGBAFormat } from "three";
import { MATERIAL_DEFAULTS } from '../EngineDefaults.js';
import { TRIANGLE_DATA_LAYOUT, packNormalOct, packTriangleFlags } from './BufferLayout.js';
import { TEXTURE_CONSTANTS } from './TextureBuckets.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { ChunkedRecords, SHARED_MEMORY_AVAILABLE } from './ChunkedRecords.js';
import { createLogger, fmt, warnOnce } from '../utils/Logger.js';
import { GeometrySpill } from '../Storage/GeometrySpill.js';

const log = createLogger( 'geometry' );

const MAX_TEXTURES_LIMIT = TEXTURE_CONSTANTS.MAX_TEXTURES_LIMIT;

const COLOR_DEFAULTS = new Set( [ 'color', 'emissive', 'attenuationColor', 'sheenColor', 'specularColor', 'subsurfaceColor', 'diffuseTransmissionColor' ] );

/**
 * Where a packed material value came from: the three.js material carried it, a legacy-type
 * conversion (Basic/Lambert/Phong/Toon) produced it, the engine filled it from
 * MATERIAL_DEFAULTS, or a host set it at runtime through setMaterialProperty.
 */
export const MATERIAL_VALUE_SOURCE = Object.freeze( {
	MATERIAL: 'material',
	MAPPED: 'mapped',
	DEFAULT: 'default',
	HOST: 'host',
} );

const IDENTITY_ELEMENTS = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

function isIdentityElements( e ) {

	for ( let i = 0; i < 16; i ++ ) if ( e[ i ] !== IDENTITY_ELEMENTS[ i ] ) return false;
	return true;

}

/**
 * The texture that feeds each GPU map slot. Re-packing texture indices without this loses the
 * unlit routing (a MeshBasicMaterial's map is also its emission map).
 * @param {import('three').Material} material
 * @returns {Object<string, import('three').Texture|undefined>}
 */
export function resolveMaterialTextures( material ) {

	return {
		map: material.map,
		normalMap: material.normalMap,
		bumpMap: material.bumpMap,
		roughnessMap: material.roughnessMap,
		metalnessMap: material.metalnessMap,
		emissiveMap: material.emissiveMap ?? ( material.isMeshBasicMaterial ? material.map : undefined ),
		displacementMap: material.displacementMap,
		anisotropyMap: material.anisotropyMap,
		clearcoatMap: material.clearcoatMap,
		clearcoatRoughnessMap: material.clearcoatRoughnessMap,
		transmissionMap: material.transmissionMap,
		sheenColorMap: material.sheenColorMap,
		sheenRoughnessMap: material.sheenRoughnessMap,
		specularIntensityMap: material.specularIntensityMap,
		specularColorMap: material.specularColorMap,
		diffuseTransmissionMap: material.diffuseTransmissionMap,
		diffuseTransmissionColorMap: material.diffuseTransmissionColorMap,
		iridescenceMap: material.iridescenceMap,
		iridescenceThicknessMap: material.iridescenceThicknessMap,
	};

}

/**
 * glTF 2.0 alphaMode for a three.js material: 0 OPAQUE, 1 MASK, 2 BLEND.
 *
 * The single definition of this rule. alphaMode is the only alpha field the shader reads
 * (MaterialTransmission takes the opaque fast path on 0 and gates its MASK branch on 1), so
 * any control that changes alpha behaviour has to route through here or it does nothing.
 *
 * @param {import('three').Material} material
 * @returns {0|1|2}
 */
export function deriveAlphaMode( material ) {

	// Follow glTF 2.0 specification for alphaMode
	// Check if material explicitly sets alphaMode (from glTF loader)
	if ( material.userData?.gltfExtensions?.KHR_materials_unlit?.alphaMode ) {

		const mode = material.userData.gltfExtensions.KHR_materials_unlit.alphaMode;
		if ( mode === 'BLEND' ) return 2;
		if ( mode === 'MASK' ) return 1;
		return 0; // OPAQUE

	}

	// Fallback logic based on material properties
	if ( material.alphaTest > 0.0 ) {

		return 1; // MASK - alphaTest takes priority

	}

	if ( material.transparent && material.opacity < 1.0 ) {

		return 2; // BLEND - transparent with opacity < 1

	}

	// Check for alpha in diffuse texture
	if ( material.map && material.map.format === RGBAFormat && material.transparent ) {

		return 2; // BLEND - has alpha texture and transparent flag

	}

	return 0; // OPAQUE

}

/**
 * Bytes the three.js geometry behind `object` holds, counting each `BufferGeometry` once.
 *
 * Instanced meshes share one geometry, so counting per placement would over-report by orders of
 * magnitude on a scene with millions of placements. Worth re-reading after extraction:
 * `_compressAttributes` halves normals and colours, which is ~370 MB on a 40M-triangle scene.
 *
 * @param {Object3D} object
 * @returns {number}
 */
export function geometryBytesOf( object ) {

	let bytes = 0;
	const counted = new Set();

	const walk = node => {

		const g = node.isMesh && node.material ? node.geometry : null;
		if ( g && ! counted.has( g.uuid ) ) {

			counted.add( g.uuid );
			for ( const name in g.attributes ) bytes += g.attributes[ name ].array?.byteLength ?? 0;
			bytes += g.index?.array?.byteLength ?? 0;

		}

		if ( node.children ) for ( const child of node.children ) walk( child );

	};

	walk( object );
	return bytes;

}

/** Bytes of InstancedMesh matrix lists under `object`, each list once however many meshes share it. */
export function instanceBytesOf( object ) {

	let bytes = 0;
	const counted = new Set();
	object.traverse?.( node => {

		const array = node.isInstancedMesh ? node.instanceMatrix?.array : null;
		if ( array && ! counted.has( array ) ) {

			counted.add( array );
			bytes += array.byteLength;

		}

	} );
	return bytes;

}

// Affine point and linear direction transforms straight off the matrix elements: no perspective
// divide, no method dispatch, on the hottest per-vertex path of a baked mesh.
function affinePoint( v, e ) {

	const x = v.x, y = v.y, z = v.z;
	v.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
	v.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
	v.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];

}

function linearDir( v, e ) {

	const x = v.x, y = v.y, z = v.z;
	v.x = e[ 0 ] * x + e[ 3 ] * y + e[ 6 ] * z;
	v.y = e[ 1 ] * x + e[ 4 ] * y + e[ 7 ] * z;
	v.z = e[ 2 ] * x + e[ 5 ] * y + e[ 8 ] * z;

}

// Emissive instances become real triangles, so the expansion is capped.
const MAX_EXPANDED_EMISSIVE_TRIANGLES = 1 << 21;

// A skinned or morphed mesh is posed per copy, so it cannot share one set of triangles.
function isDeformable( mesh ) {

	return !! ( mesh.isSkinnedMesh || Object.keys( mesh.geometry?.morphAttributes ?? {} ).length );

}

// Determinant of a column-major matrix's 3x3 basis; negative means the transform mirrors.
function determinant3( e ) {

	return e[ 0 ] * ( e[ 5 ] * e[ 10 ] - e[ 9 ] * e[ 6 ] )
		- e[ 4 ] * ( e[ 1 ] * e[ 10 ] - e[ 9 ] * e[ 2 ] )
		+ e[ 8 ] * ( e[ 1 ] * e[ 6 ] - e[ 5 ] * e[ 2 ] );

}

/**
 * Whether any material under `object` holds a texture, so the GPU needs the triangles' texture coordinates. A scene
 * with none (Moana's USD: its Ptex is baked into colours) is uploaded without them.
 */
export function usesTextureCoordinates( object ) {

	let uses = false;
	const seen = new Set();
	object.traverse( node => {

		if ( uses || ! node.isMesh || ! node.material ) return;
		for ( const material of Array.isArray( node.material ) ? node.material : [ node.material ] ) {

			if ( seen.has( material ) ) continue;
			seen.add( material );
			for ( const key in material ) if ( material[ key ]?.isTexture ) uses = true;

		}

	} );
	return uses;

}

/**
 * Stores a geometry's float attribute in [−1, 1] as normalized 16-bit integers, which three.js reads back as floats.
 * Left as floats when out of that range (or NaN) rather than silently clamped, or when morph targets use it.
 */
export function packUnitAttribute( g, name ) {

	const attr = g.getAttribute( name );
	if ( ! attr || attr.normalized || ! ( attr.array instanceof Float32Array ) ) return;
	if ( g.morphAttributes?.[ name ]?.length ) return;

	const src = attr.array;
	for ( let i = 0; i < src.length; i ++ ) {

		const v = src[ i ];
		if ( ! ( v >= - 1.0001 && v <= 1.0001 ) ) return;

	}

	const packed = new Int16Array( src.length );
	for ( let i = 0; i < src.length; i ++ ) packed[ i ] = Math.round( Math.max( - 1, Math.min( 1, src[ i ] ) ) * 32767 );
	g.setAttribute( name, new BufferAttribute( packed, attr.itemSize, true ) );

}

export class GeometryExtractor {

	/** @param {{issues?: import('../EngineIssues.js').IssueLog}} [options] */
	constructor( { issues = null } = {} ) {

		this._issues = issues;
		this._droppedTextures = 0;

		// Object pools for reusing objects
		this._vectorPool = {
			vec3: Array( 9 ).fill().map( () => new Vector3() ),
			vec2: Array( 6 ).fill().map( () => new Vector2() )
		};

		this._geometryRanges = new Map();
		this.expandedTriangleCount = 0;
		this._allocatePlacements( 0 );
		this._matrixPool = {
			mat3: new Matrix3(),
			mat4: new Matrix4()
		};

		// Arrays to store extracted data
		this.resetArrays();

		// Triangle tracking
		this.triangleCount = 0;
		this.currentTriangleIndex = 0;

	}

	// Get a Vector3 from the pool
	_getVec3( index = 0 ) {

		return this._vectorPool.vec3[ index % this._vectorPool.vec3.length ];

	}

	// Get a Vector2 from the pool
	_getVec2( index = 0 ) {

		return this._vectorPool.vec2[ index % this._vectorPool.vec2.length ];

	}

	extract( object ) {

		this.resetArrays();

		// Pre-count the exact triangle total so the buffer is allocated once.
		// Doubling-with-copy rounded up to the next power of two (wasting ~1GB on
		// an 8.5M-tri scene) and held old+new during the copy (~3GB transient),
		// which overflowed the browser's ArrayBuffer allocator. Exact avoids both.
		const totalTriangles = this._countTriangles( object );
		this._triangleCapacity = Math.max( 1024, totalTriangles );
		this._allocateTriangles( this._triangleCapacity );
		this.currentTriangleIndex = 0;

		// One `{ sourceMesh, matrixWorld }` object per placement cost 1.6 GB at 6M of them.
		this._allocatePlacements( this._countPlacements( object ) );
		this._geometryUses = this._countGeometryUses( object );
		this.bakeInverse = new Map();

		// Single traversal: extract geometry, materials, lights, and cameras
		this.traverseObject( object );
		this._compressAttributes( object );

		this.logStats();
		return this.getExtractedData();

	}

	/**
	 * `extract()`, handing each stored range to `onRange( meshIndex, range )` as soon as it is
	 * written and awaiting `pause( triangles )` every `yieldEvery` triangles, so a build can work
	 * on the first meshes while the rest are read. The store is lazy and sized exactly
	 * ({@link _countStoredTriangles}): a chunk takes memory when first written, and the receiver
	 * may send it to disk once it is done with it. `releaseGeometry( geometry )` is handed each
	 * geometry after its last read, already compressed, unless something else still holds its arrays.
	 */
	async extractStreaming( object, { onStore, onRange, pause, yieldEvery = 1 << 20, releaseGeometry = null } ) {

		this.resetArrays();
		this._triangleCapacity = Math.max( 1, this._countStoredTriangles( object ) );
		this._allocateTriangles( this._triangleCapacity, true );
		onStore?.( this.triangles );
		this.currentTriangleIndex = 0;
		this._allocatePlacements( this._countPlacements( object ) );
		this._geometryUses = this._countGeometryUses( object );
		this.bakeInverse = new Map();
		this._onRange = onRange;
		this._releaseAfterRead = releaseGeometry ? this._geometryReleaser( object, releaseGeometry ) : null;

		try {

			// Depth-first pre-order, as traverseObject: mesh indices follow the same walk.
			const stack = [ object ];
			let yielded = 0;
			while ( stack.length ) {

				const node = stack.pop();
				this._visit( node );
				if ( node.children ) for ( let i = node.children.length - 1; i >= 0; i -- ) stack.push( node.children[ i ] );
				if ( this.currentTriangleIndex - yielded >= yieldEvery ) {

					yielded = this.currentTriangleIndex;
					await pause( this.currentTriangleIndex );

				}

			}

		} finally {

			this._onRange = null;
			this._releaseAfterRead = null;

		}

		this._compressAttributes( object );
		this.triangles.trimInPlace( this.currentTriangleIndex );
		this._streamedStore = true;

		this.logStats();
		return this.getExtractedData();

	}

	/**
	 * Triangles `extract()` will store: a geometry shared under one material once, an emissive
	 * instanced mesh once per instance (it is expanded), everything else once per mesh.
	 * @private
	 */
	_countStoredTriangles( object ) {

		const seen = new Set();
		let count = 0;
		const walk = node => {

			if ( node.isMesh && node.geometry && node.material ) {

				const g = node.geometry;
				const tris = Math.ceil( ( g.index ? g.index.count : ( g.attributes.position?.count ?? 0 ) ) / 3 );
				const material = Array.isArray( node.material ) ? node.material[ 0 ] : node.material;
				const e = material?.emissive;
				const emissive = material?.emissiveIntensity > 0 && !! e && ( e.r > 0 || e.g > 0 || e.b > 0 );
				const instances = node.isInstancedMesh ? ( node.count ?? 0 ) : 1;

				if ( emissive && node.isInstancedMesh && ! isDeformable( node ) && tris * instances <= MAX_EXPANDED_EMISSIVE_TRIANGLES ) count += tris * instances;
				else if ( emissive || isDeformable( node ) ) count += tris;
				else {

					const key = `${g.uuid}|${material?.uuid}`;
					if ( ! seen.has( key ) ) {

						seen.add( key );
						count += tris;

					}

				}

			}

			if ( node.children ) for ( const child of node.children ) walk( child );

		};

		walk( object );
		return count;

	}

	/**
	 * Counts each geometry's reads, and returns what to call after each mesh: on a geometry's
	 * last read it is compressed and handed to `release`. Never a host's geometry, a deforming
	 * one, one GeometrySpill cannot swap, or one sharing an array with another geometry.
	 * @private
	 */
	_geometryReleaser( object, release ) {

		const reads = new Map();
		const holders = new Map();
		const kept = new Set();

		const walk = ( node, external ) => {

			external ||= !! node.userData?.__rayzeeExternal;
			const g = node.isMesh && node.material ? node.geometry : null;
			if ( g ) {

				if ( ! reads.has( g ) ) {

					if ( ! GeometrySpill.canTake( g ) ) kept.add( g );
					for ( const attribute of [ ...Object.values( g.attributes ), g.index ] ) {

						const array = attribute?.array;
						if ( ! array ) continue;
						const holder = holders.get( array );
						if ( holder && holder !== g ) kept.add( g ).add( holder );
						else holders.set( array, g );

					}

				}

				reads.set( g, ( reads.get( g ) ?? 0 ) + 1 );
				if ( external || isDeformable( node ) ) kept.add( g );

			}

			if ( node.children ) for ( const child of node.children ) walk( child, external );

		};

		walk( object, false );

		return mesh => {

			const g = mesh.material ? mesh.geometry : null;
			if ( ! g || ! reads.has( g ) ) return;
			const left = reads.get( g ) - 1;
			if ( left > 0 ) return void reads.set( g, left );
			reads.delete( g );
			if ( kept.has( g ) ) return;
			this._compressGeometry( g );
			release( g );

		};

	}

	/**
	 * The sizes a memory preflight needs, without doing any of the work: what `extract()` would
	 * store, plus the three.js geometry already resident behind it.
	 *
	 * Geometry is counted once per unique `BufferGeometry` — instanced meshes share one, so
	 * counting per placement would over-report by orders of magnitude on a scene like Moana.
	 *
	 * @param {Object3D} object
	 * @returns {{triangles: number, placements: number, meshes: number, geometryBytes: number}}
	 */
	surveyScene( object ) {

		let meshes = 0;
		const walk = node => {

			if ( node.isMesh && node.geometry && node.material ) meshes ++;
			if ( node.children ) for ( const child of node.children ) walk( child );

		};

		walk( object );

		return {
			triangles: this._countTriangles( object ),
			placements: this._countPlacements( object ),
			meshes,
			geometryBytes: geometryBytesOf( object ),
			instanceBytes: instanceBytesOf( object ),
		};

	}

	/**
	 * How many meshes use each geometry+material pair. A pair used once has nothing to share, so
	 * it is baked to world space and its ray is never transformed. Walks everything, so a mesh
	 * the extraction later skips only ever over-counts — towards object space, never a bad bake.
	 * @private
	 */
	_countGeometryUses( object ) {

		const uses = new Map();

		object.traverse( ( o ) => {

			if ( ! o.isMesh || ! o.geometry || ! o.material ) return;
			const key = `${o.geometry.uuid}|${o.material.uuid}`;
			uses.set( key, ( uses.get( key ) ?? 0 ) + 1 );

		} );

		return uses;

	}

	// Placements extract() will record: one per mesh, or one per instance of an InstancedMesh.
	_countPlacements( object ) {

		let count = 0;

		if ( object.isMesh && object.geometry && object.material ) {

			count += object.isInstancedMesh && object.instanceMatrix
				? ( object.count ?? object.instanceMatrix.array.length / 16 )
				: 1;

		}

		if ( object.children ) {

			for ( const child of object.children ) count += this._countPlacements( child );

		}

		return count;

	}

	_allocatePlacements( count ) {

		this.instanceCount = 0;
		this.instanceCapacity = count;
		this.instanceSource = new Int32Array( count );
		// Placement transforms as runs of rows (InstanceTable): an InstancedMesh's own matrix list read where it is,
		// or rows of the extractor's own. A copy of every list was 3 GB beside them on the Moana island.
		this._runs = { first: [], arrays: [], arrayOf: [], base: [], owned: [] };
		this._runArrayIndex = new Map();
		this._singles = null;
		this._singlesUsed = 0;
		this._singlesRun = null;
		this._compressed = new Set();
		this._matrixLists = new Map();

	}

	/** Starts a run of rows at the next placement. @private */
	_beginRun( array, base, owned ) {

		const runs = this._runs;
		let a = this._runArrayIndex.get( array );
		if ( a === undefined ) this._runArrayIndex.set( array, a = runs.arrays.push( array ) - 1 );
		runs.first.push( this.instanceCount );
		runs.arrayOf.push( a );
		runs.base.push( base );
		runs.owned.push( owned );

	}

	/** The row for a placement of a mesh without instances, appended to the extractor's own array. @private */
	_singleRow() {

		const runs = this._runs;
		if ( ! this._singles ) {

			this._singles = new Float32Array( 1024 * 16 );
			this._singlesIndex = runs.arrays.push( this._singles ) - 1;

		}

		if ( this._singlesUsed + 16 > this._singles.length ) {

			const grown = new Float32Array( this._singles.length * 2 );
			grown.set( this._singles );
			this._singles = runs.arrays[ this._singlesIndex ] = grown;

		}

		if ( this._singlesRun !== runs.first.length - 1 ) {

			runs.first.push( this.instanceCount );
			runs.arrayOf.push( this._singlesIndex );
			runs.base.push( this._singlesUsed );
			runs.owned.push( 1 );
			this._singlesRun = runs.first.length - 1;

		}

		const o = this._singlesUsed;
		this._singlesUsed += 16;
		return o;

	}

	/** The runs, closed at the placement count (InstanceTable.allocate). @private */
	_matrixRuns() {

		const runs = this._runs;
		return { first: [ ...runs.first, this.instanceCount ], arrays: runs.arrays, arrayOf: runs.arrayOf, base: runs.base, owned: runs.owned };

	}

	/**
	 * Halve the scene graph's normal/tangent/colour attributes as normalized 16-bit integers.
	 *
	 * three.js denormalizes on read and uploads them as `snorm16`, so every CPU-side consumer
	 * keeps working; the triangle buffer already stores normals as a coarser oct16 pair.
	 * Positions and UVs keep the full float range.
	 * @private
	 */
	_compressAttributes( object ) {

		// A host's own Object3D is rendered as a copy, but the copy shares its geometry by
		// reference, so rewriting an attribute there would rewrite the host's data. Its whole
		// subtree is skipped rather than the root alone.
		const walk = ( o, visit ) => {

			if ( o.userData?.__rayzeeExternal ) return;
			visit( o );
			for ( const child of o.children ) walk( child, visit );

		};

		walk( object, o => {

			if ( o.isMesh && o.geometry ) this._compressGeometry( o.geometry );

		} );

	}

	/** One geometry's share of {@link _compressAttributes}; each geometry is done once. @private */
	_compressGeometry( g ) {

		if ( this._compressed.has( g.uuid ) ) return;
		this._compressed.add( g.uuid );

		for ( const name of [ 'normal', 'tangent', 'color' ] ) packUnitAttribute( g, name );

	}

	// Sum the exact triangle count over every mesh extract() will process
	// (mirrors traverseObject/processMesh guards) so we can allocate once.
	_countTriangles( object ) {

		let count = 0;

		if ( object.isMesh && object.geometry && object.material ) {

			const indices = object.geometry.index;
			const positions = object.geometry.attributes.position;
			if ( indices ) count += Math.ceil( indices.count / 3 );
			else if ( positions ) count += Math.ceil( positions.count / 3 );

		}

		if ( object.children ) {

			for ( const child of object.children ) count += this._countTriangles( child );

		}

		return count;

	}

	// Safety net only: extract() pre-counts and allocates exactly, so this should
	// not fire. Grow to exactly `needed` (never double) to avoid a memory spike.
	_ensureCapacity( needed ) {

		if ( needed <= this._triangleCapacity ) return;

		// A streamed store may already have chunks on disk: it grows where it stands.
		if ( this._onRange ) {

			this.triangles.grow( needed );
			this._triangleCapacity = needed;
			return;

		}

		const previous = this.triangles;
		const used = this.currentTriangleIndex;
		this._allocateTriangles( needed );
		for ( let t = 0; t < used; t ++ ) {

			this.triangles.chunkFor( t ).set(
				previous.chunkFor( t ).subarray( previous.baseOf( t ), previous.baseOf( t ) + previous.lanesPerRecord ),
				this.triangles.baseOf( t )
			);

		}

		this._triangleCapacity = needed;

	}

	/**
	 * The record is a uint buffer; positions and UVs are written as f32 through a view of the
	 * same memory, so a packed lane's bit pattern is never round-tripped through an f32.
	 *
	 * Chunked, because one array cannot hold more than ~26M triangles at 80 bytes each — the
	 * V8 ArrayBuffer cap, well below what the GPU buffer can take.
	 * @private
	 */
	_allocateTriangles( capacity, lazy = false ) {

		// Shared-backed so a refit reads and writes them in place; copying them into shared memory
		// on first refit would be a second copy of the largest thing in the scene.
		this.triangles = ( lazy ? ChunkedRecords.lazy : ( ...a ) => new ChunkedRecords( ...a ) )(
			capacity, TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE, Uint32Array,
			undefined, SHARED_MEMORY_AVAILABLE
		);
		this.triangleFloatChunks = this.triangles.viewAs( Float32Array );
		this.triangleData = this.triangles.single;
		this.triangleFloats = this.triangleFloatChunks.single;

	}

	traverseObject( object ) {

		this._visit( object );

		// Process children recursively
		if ( object.children ) {

			for ( const child of object.children ) {

				this.traverseObject( child );

			}

		}

	}

	/** @private */
	_visit( object ) {

		if ( object.isMesh ) {

			this.processMesh( object );
			this._releaseAfterRead?.( object );

		} else if ( object.isDirectionalLight ) {

			this.directionalLights.push( object );

		} else if ( object.isCamera ) {

			this.cameras.push( object );

		}

	}

	processMesh( mesh ) {

		if ( ! mesh.geometry || ! mesh.material ) {

			console.warn( 'Skipping mesh with missing geometry or material:', mesh );
			return;

		}

		// Process material and get its index
		const materialIndex = this.processMaterial( mesh.material );
		mesh.userData.materialIndex = materialIndex;

		// Assign mesh index and store mesh reference
		const meshIndex = this.meshes.length;
		this.meshes.push( mesh );
		mesh.userData.meshIndex = meshIndex;

		// Triangles are stored in object space, so two placements of the same geometry can
		// point at one copy — and later at one BLAS. The material is part of the key because
		// the material index is baked per triangle.
		// Emissive geometry opts out: each placement is a separate light, and the light BVH
		// keys its entries by triangle index, which sharing would make ambiguous. So does
		// anything that deforms: a skinned or morphed copy needs triangles of its own, or an
		// animation refit writes one copy's pose into every other.
		const key = `${mesh.geometry.uuid}|${materialIndex}`;
		const deformable = isDeformable( mesh );
		const shareable = ! this._emissiveMaterial( materialIndex ) && ! deformable;
		const shared = shareable ? this._geometryRanges.get( key ) : null;

		// `expandedStart` is where this mesh's triangles sit in a per-mesh walk of the scene,
		// which is the shape refit callers can build. `start` is where they are actually
		// stored, which is the owner's copy when the geometry is shared.
		if ( shared ) {

			const range = {
				start: shared.start, count: shared.count,
				expandedStart: this.expandedTriangleCount, sharedFrom: shared.meshIndex
			};
			this.expandedTriangleCount += shared.count;
			this.meshTriangleRanges.push( range );
			this._recordPlacements( mesh, meshIndex, false, false, shared.count > 0 );
			return;

		}

		const rangeStart = this.currentTriangleIndex;

		// Emission is measured per triangle, so instances of an emissive geometry have to be
		// real triangles rather than one copy placed many times — otherwise the scene is lit by
		// the first instance alone. Their triangles are baked, so this mesh keeps one placement.
		const expand = mesh.isInstancedMesh && ! deformable
			&& this._emissiveMaterial( materialIndex ) && this._canExpand( mesh );

		// Object space only pays when a second placement can reuse the copy. A geometry used
		// once — or an emissive one, which never shares — is baked to world space instead, so
		// a ray reaching it skips the per-instance transform entirely.
		const bake = expand || ( ! mesh.isInstancedMesh && ! deformable && (
			this._geometryUses.get( `${mesh.geometry.uuid}|${mesh.material?.uuid}` ) === 1
			|| this._emissiveMaterial( materialIndex )
		) );

		this.extractGeometry( mesh, materialIndex, meshIndex, bake, expand );

		const range = {
			start: rangeStart, count: this.currentTriangleIndex - rangeStart,
			expandedStart: this.expandedTriangleCount
		};
		this.expandedTriangleCount += range.count;
		this.meshTriangleRanges.push( range );
		if ( range.count > 0 && ! bake && shareable ) this._geometryRanges.set( key, { ...range, meshIndex } );
		this._recordPlacements( mesh, meshIndex, bake, expand, range.count > 0 && shareable );
		if ( range.count > 0 ) this._onRange?.( meshIndex, range );

	}

	/**
	 * One placement per object, or one per instance for an InstancedMesh. The scene graph
	 * holds a single object either way — only this list grows, so a million placements cost
	 * a matrix each rather than a million Object3Ds.
	 * @private
	 */
	_recordPlacements( mesh, meshIndex, baked = false, expanded = false, groupable = false ) {

		const world = mesh.matrixWorld.elements;
		const src = this.instanceSource;

		// Expanded instances live in the triangles, so the mesh keeps a single placement. The
		// recorded inverse is the host's alone: moving the host is a delta that applies to
		// every instance equally, which is exactly what composing against it produces.
		if ( ! mesh.isInstancedMesh || ! mesh.instanceMatrix || expanded ) {

			const d = this._singleRow();
			const dst = this._singles;
			const p = this._nextPlacement();
			src[ p ] = meshIndex;

			if ( baked ) {

				// The triangles already carry this pose, so the placement starts at identity. A
				// later move composes against the inverse of what was baked in.
				for ( let k = 0; k < 16; k ++ ) dst[ d + k ] = k % 5 === 0 ? 1 : 0;
				this.bakeInverse.set( meshIndex, Float32Array.from( this._matrixPool.mat4.copy( mesh.matrixWorld ).invert().elements ) );

			} else {

				for ( let k = 0; k < 16; k ++ ) dst[ d + k ] = world[ k ];

			}

			return;

		}

		const arr = mesh.instanceMatrix.array;
		const count = mesh.count ?? ( arr.length / 16 );
		if ( groupable && count > 0 ) {

			let list = this._matrixLists.get( mesh.instanceMatrix );
			if ( ! list ) this._matrixLists.set( mesh.instanceMatrix, list = [] );
			list.push( { meshIndex, start: this.instanceCount, count, world: Float32Array.from( world ) } );

		}

		if ( count <= 0 ) return;

		// A pbrt archive bakes the CTM into every instance, so the host needs no multiply and the list is read in place.
		const identityHost = isIdentityElements( world ) && arr.length >= count * 16;
		const dst = identityHost ? arr : new Float32Array( count * 16 );
		this._beginRun( identityHost ? mesh.instanceMatrix : dst, 0, identityHost ? 0 : 1 );

		for ( let i = 0; i < count; i ++ ) {

			const o = i * 16;
			const p = this._nextPlacement();
			const d = i * 16;
			src[ p ] = meshIndex;
			if ( identityHost ) continue;

			// world = mesh.matrixWorld * instanceMatrix, both column-major.
			for ( let c = 0; c < 4; c ++ ) {

				for ( let r = 0; r < 4; r ++ ) {

					dst[ d + c * 4 + r ] = world[ r ] * arr[ o + c * 4 ]
						+ world[ 4 + r ] * arr[ o + c * 4 + 1 ]
						+ world[ 8 + r ] * arr[ o + c * 4 + 2 ]
						+ world[ 12 + r ] * arr[ o + c * 4 + 3 ];

				}

			}

		}

	}

	/**
	 * Instanced meshes sharing one matrix attribute under the same host transform: one object traced once a copy
	 * (InstanceTable.setGroups). A scene builder shares the attribute between a template's shapes for this.
	 * @returns {Array<{members: number[], starts: number[], count: number}>}
	 * @private
	 */
	_instanceGroups() {

		const groups = [];
		for ( const list of this._matrixLists.values() ) {

			const open = [];
			for ( const member of list ) {

				const group = open.find( g => g.count === member.count && g.world.every( ( v, k ) => v === member.world[ k ] ) );
				if ( group ) {

					group.members.push( member.meshIndex );
					group.starts.push( member.start );

				} else open.push( { world: member.world, count: member.count, members: [ member.meshIndex ], starts: [ member.start ] } );

			}

			for ( const g of open ) if ( g.members.length >= 2 ) groups.push( { members: g.members, starts: g.starts, count: g.count } );

		}

		this._matrixLists.clear();
		return groups;

	}

	/** Next free placement slot, growing only if the pre-count was short. @private */
	_nextPlacement() {

		if ( this.instanceCount >= this.instanceCapacity ) {

			const grown = Math.max( 16, this.instanceCapacity * 2 );
			const srcCol = new Int32Array( grown );
			srcCol.set( this.instanceSource );
			this.instanceSource = srcCol;
			this.instanceCapacity = grown;

		}

		return this.instanceCount ++;

	}

	/** True when this material emits — those meshes keep their own triangles. */
	/**
	 * Is expanding this instanced mesh into real triangles within budget? Past it the scene is
	 * lit by the first instance, which is wrong but bounded.
	 * @private
	 */
	_canExpand( mesh ) {

		const g = mesh.geometry;
		const tris = ( g.index ? g.index.count : g.attributes.position.count ) / 3;
		const count = mesh.count ?? ( mesh.instanceMatrix?.array.length ?? 0 ) / 16;
		if ( tris * count <= MAX_EXPANDED_EMISSIVE_TRIANGLES ) return true;

		this._issues?.record(
			ISSUE_CODES.EMISSIVE_INSTANCES_COLLAPSED,
			`"${mesh.name || 'instanced mesh'}" would need ${Math.round( tris * count ).toLocaleString()} triangles to light every instance; lighting the first one only`,
			{ instances: count, trianglesPerInstance: tris, limit: MAX_EXPANDED_EMISSIVE_TRIANGLES }
		);
		return false;

	}

	_emissiveMaterial( materialIndex ) {

		const m = this.materials[ materialIndex ];
		if ( ! m || ! ( m.emissiveIntensity > 0 ) ) return false;
		const e = m.emissive;
		return !! e && ( e.r > 0 || e.g > 0 || e.b > 0 );

	}

	processMaterial( material ) {

		// Check if material already exists in our array (O(1) Map lookup)
		let materialIndex = this._materialUuidMap.get( material.uuid ) ?? - 1;
		if ( materialIndex === - 1 ) {

			// Force enable depth write if it's disabled
			if ( material.depthWrite === false ) {

				material.depthWrite = true;
				// Fires per offending material; the fix is identical every time, so warn once.
				warnOnce( log, 'depthWrite', 'material had depthWrite disabled — enabled for rastered rendering' );

			}

			// Create a new material object and add it to the array
			const newMaterial = this.createMaterialObject( material );
			this.materials.push( newMaterial );
			materialIndex = this.materials.length - 1;
			this._materialUuidMap.set( material.uuid, materialIndex );

		}

		return materialIndex;

	}


	getMaterialType( material ) {

		// Detect material type for appropriate property mapping
		if ( material.isMeshPhysicalMaterial ) return 'physical';
		if ( material.isMeshStandardMaterial ) return 'standard';
		if ( material.isMeshPhongMaterial ) return 'phong';
		if ( material.isMeshLambertMaterial ) return 'lambert';
		if ( material.isMeshBasicMaterial ) return 'basic';
		if ( material.isMeshToonMaterial ) return 'toon';
		return 'unknown';

	}

	getPhysicalDefaults() {

		const defaults = {};
		for ( const [ key, value ] of Object.entries( MATERIAL_DEFAULTS ) ) {

			defaults[ key ] = COLOR_DEFAULTS.has( key ) ? new Color().fromArray( value ) : Array.isArray( value ) ? [ ...value ] : value;

		}

		defaults.normalScale = { x: MATERIAL_DEFAULTS.normalScale[ 0 ], y: MATERIAL_DEFAULTS.normalScale[ 1 ] };
		return defaults;

	}

	mapLegacyMaterialToPhysical( material, materialType ) {

		// Map legacy material properties to physically-based equivalents
		const mapped = {};

		switch ( materialType ) {

			case 'basic':
				// Unlit (GLTFLoader's KHR_materials_unlit): colour and texture are emission, nothing reflects.
				mapped.emissive = material.color.clone();
				mapped.emissiveIntensity = 1.0;
				mapped.color = new Color( 0x000000 );
				mapped.roughness = 1.0;
				mapped.metalness = 0.0;
				mapped.specularIntensity = 0.0;
				break;

			case 'lambert':
				// MeshLambertMaterial -> Pure diffuse
				mapped.roughness = 1.0;
				mapped.metalness = 0.0;
				mapped.specularIntensity = 0.0; // No specular
				break;

			case 'phong':
				// MeshPhongMaterial -> Convert shininess to roughness
				{

					const shininess = material.shininess || 30;
					mapped.roughness = Math.sqrt( 2.0 / ( shininess + 2 ) );
					mapped.metalness = 0.0;

				}

				// Strength in specularIntensity, hue alone in specularColor; carrying it in both squared it.
				if ( material.specular ) {

					const s = material.specular;
					const specularLuminance = s.r * 0.299 + s.g * 0.587 + s.b * 0.114;
					const peak = Math.max( s.r, s.g, s.b );
					mapped.specularIntensity = Math.min( specularLuminance * 2.0, 1.0 );
					mapped.specularColor = peak > 0 ? s.clone().multiplyScalar( 1 / peak ) : new Color( 1, 1, 1 );

				}

				break;

			case 'toon':
				// MeshToonMaterial -> Stylized but physically plausible
				mapped.roughness = 0.9;
				mapped.metalness = 0.0;
				break;

			case 'standard':
			case 'physical':
				// Already physically-based, no conversion needed
				break;

		}

		return mapped;

	}

	createMaterialObject( material ) {

		const defaults = this.getPhysicalDefaults();
		const materialType = this.getMaterialType( material );
		const legacyMapping = this.mapLegacyMaterialToPhysical( material, materialType );
		const textures = resolveMaterialTextures( material );
		const sources = {};

		const pick = ( key ) => {

			if ( legacyMapping[ key ] !== undefined ) {

				sources[ key ] = MATERIAL_VALUE_SOURCE.MAPPED;
				return legacyMapping[ key ];

			}

			if ( material[ key ] !== undefined && material[ key ] !== null ) {

				sources[ key ] = MATERIAL_VALUE_SOURCE.MATERIAL;
				return material[ key ];

			}

			sources[ key ] = MATERIAL_VALUE_SOURCE.DEFAULT;
			return defaults[ key ];

		};

		for ( const key of [ 'transparent', 'alphaMode', 'side', 'depthWrite' ] ) sources[ key ] = MATERIAL_VALUE_SOURCE.MATERIAL;

		return {
			uuid: material.uuid,

			color: pick( 'color' ),
			emissive: pick( 'emissive' ),
			emissiveIntensity: pick( 'emissiveIntensity' ),

			// Floor at 0.02 (the sampler's own VNDF-PDF clamp, MaterialProperties.js) rather than
			// 0.05, so near-mirror metals stay sharp without entering a new firefly regime.
			roughness: Math.max( 0.02, pick( 'roughness' ) ),
			metalness: pick( 'metalness' ),

			ior: pick( 'ior' ),
			opacity: pick( 'opacity' ),

			transmission: pick( 'transmission' ),
			thickness: pick( 'thickness' ),
			attenuationColor: pick( 'attenuationColor' ),
			attenuationDistance: pick( 'attenuationDistance' ),

			dispersion: pick( 'dispersion' ),
			sheen: pick( 'sheen' ),
			sheenRoughness: pick( 'sheenRoughness' ),
			sheenColor: pick( 'sheenColor' ),
			clearcoat: pick( 'clearcoat' ),
			clearcoatRoughness: pick( 'clearcoatRoughness' ),
			iridescence: pick( 'iridescence' ),
			iridescenceIOR: pick( 'iridescenceIOR' ),
			iridescenceThicknessRange: pick( 'iridescenceThicknessRange' ),

			subsurface: pick( 'subsurface' ),
			subsurfaceColor: pick( 'subsurfaceColor' ),
			subsurfaceRadius: pick( 'subsurfaceRadius' ),
			subsurfaceRadiusScale: pick( 'subsurfaceRadiusScale' ),
			subsurfaceAnisotropy: pick( 'subsurfaceAnisotropy' ),

			anisotropy: pick( 'anisotropy' ),
			anisotropyRotation: pick( 'anisotropyRotation' ),

			specularIntensity: pick( 'specularIntensity' ),
			specularColor: pick( 'specularColor' ),

			diffuseTransmission: pick( 'diffuseTransmission' ),
			diffuseTransmissionColor: pick( 'diffuseTransmissionColor' ),

			normalScale: pick( 'normalScale' ),
			bumpScale: pick( 'bumpScale' ),
			displacementScale: pick( 'displacementScale' ),

			transparent: material.transparent ? 1 : 0,
			alphaTest: pick( 'alphaTest' ),
			alphaMode: deriveAlphaMode( material ),

			side: this.getMaterialSide( material ),
			depthWrite: material.depthWrite ?? true ? 1 : 0,

			map: this.processTexture( textures.map, this.maps ),
			normalMap: this.processTexture( textures.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( textures.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( textures.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( textures.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( textures.emissiveMap, this.emissiveMaps ),
			displacementMap: this.processTexture( textures.displacementMap, this.displacementMaps ),
			anisotropyMap: this.processTexture( textures.anisotropyMap, this.anisotropyMaps ),

			// Advanced texture maps (MeshPhysicalMaterial only). Folded into their scalar factors
			// in ShadeKernel (applyExtensionMaps). thicknessMap stays dropped — thickness has no
			// render effect yet (see gap-plan Phase 4.4).
			clearcoatMap: this.processTexture( textures.clearcoatMap, this.clearcoatMaps ),
			clearcoatRoughnessMap: this.processTexture( textures.clearcoatRoughnessMap, this.clearcoatRoughnessMaps ),
			transmissionMap: this.processTexture( textures.transmissionMap, this.transmissionMaps ),
			thicknessMap: this.processTexture( material.thicknessMap, [] ),
			sheenColorMap: this.processTexture( textures.sheenColorMap, this.sheenColorMaps ),
			sheenRoughnessMap: this.processTexture( textures.sheenRoughnessMap, this.sheenRoughnessMaps ),
			specularIntensityMap: this.processTexture( textures.specularIntensityMap, this.specularIntensityMaps ),
			specularColorMap: this.processTexture( textures.specularColorMap, this.specularColorMaps ),
			diffuseTransmissionMap: this.processTexture( textures.diffuseTransmissionMap, this.diffuseTransmissionMaps ),
			diffuseTransmissionColorMap: this.processTexture( textures.diffuseTransmissionColorMap, this.diffuseTransmissionColorMaps ),
			iridescenceMap: this.processTexture( textures.iridescenceMap, this.iridescenceMaps ),
			iridescenceThicknessMap: this.processTexture( textures.iridescenceThicknessMap, this.iridescenceThicknessMaps ),

			mapMatrix: this.getTextureMatrix( textures.map ),
			normalMapMatrices: this.getTextureMatrix( textures.normalMap ),
			bumpMapMatrices: this.getTextureMatrix( textures.bumpMap ),
			roughnessMapMatrices: this.getTextureMatrix( textures.roughnessMap ),
			metalnessMapMatrices: this.getTextureMatrix( textures.metalnessMap ),
			emissiveMapMatrices: this.getTextureMatrix( textures.emissiveMap ),
			displacementMapMatrices: this.getTextureMatrix( textures.displacementMap ),

			sources,
			originalType: materialType
		};

	}

	getTextureMatrix( texture ) {

		if ( ! texture ) return new Matrix3().elements;
		// GLTFLoader writes `matrix` itself for a rotated KHR_texture_transform (glTF is
		// T·R·S, three is T·S·R) and clears the flag; updateMatrix() ignores the flag.
		if ( texture.matrixAutoUpdate ) texture.updateMatrix();
		return texture.matrix.elements;

	}

	getMaterialSide( material ) {

		if ( material.transmission > 0.0 ) return 2;
		switch ( material.side ) {

			case FrontSide: return 0;
			case BackSide: return 1;
			case DoubleSide: return 2;
			default: return 0;

		}

	}

	processTexture( texture, textureArray ) {

		if ( ! texture ) return - 1;

		// O(1) lookup via WeakMap<array, Map<uuid, index>>
		let indexMap = this._textureIndexCache.get( textureArray );
		if ( ! indexMap ) {

			indexMap = new Map();
			this._textureIndexCache.set( textureArray, indexMap );

		}

		const uuid = texture.source.uuid;
		const cachedIndex = indexMap.get( uuid );
		if ( cachedIndex !== undefined ) return cachedIndex;

		if ( textureArray.length < MAX_TEXTURES_LIMIT ) {

			textureArray.push( texture );
			const newIndex = textureArray.length - 1;
			indexMap.set( uuid, newIndex );
			return newIndex;

		}

		this._droppedTextures ++;
		if ( this._droppedTextures === 1 ) {

			this._issues?.record(
				ISSUE_CODES.TEXTURE_LIMIT_EXCEEDED,
				`scene needs more than ${MAX_TEXTURES_LIMIT} distinct textures for one map type; the rest render untextured`,
				{ limit: MAX_TEXTURES_LIMIT, firstDropped: texture.name || texture.source?.uuid }
			);

		}

		return - 1;

	}

	extractGeometry( mesh, materialIndex, meshIndex, bake = false, expandInstances = false ) {

		mesh.updateMatrix();
		mesh.updateMatrixWorld();

		const geometry = mesh.geometry;
		if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
		const positions = geometry.attributes.position;
		const normals = geometry.attributes.normal;
		const uvs = geometry.attributes.uv;
		const indices = geometry.index ? geometry.index.array : null;

		const triangleCount = indices ? indices.length / 3 : positions.count / 3;

		if ( expandInstances ) {

			const count = mesh.count ?? ( mesh.instanceMatrix.array.length / 16 );
			const inst = this._matrixPool.mat4;
			const world = new Matrix4();

			for ( let i = 0; i < count; i ++ ) {

				inst.fromArray( mesh.instanceMatrix.array, i * 16 );
				world.multiplyMatrices( mesh.matrixWorld, inst );
				const normalMatrix = new Matrix3().getNormalMatrix( world );
				this.extractTrianglesInBatch(
					positions, normals, uvs, indices, triangleCount, materialIndex, meshIndex,
					world, normalMatrix, determinant3( world.elements ) < 0
				);

			}

			return;

		}

		const bakeMatrix = bake ? this._matrixPool.mat4.copy( mesh.matrixWorld ) : null;
		const bakeNormal = bake ? this._matrixPool.mat3.getNormalMatrix( mesh.matrixWorld ) : null;
		// A mirroring transform reverses which way the vertices wind, so the face normal the
		// cross product yields would point into the surface. Swap two corners and it points out.
		const flip = bake && determinant3( bakeMatrix.elements ) < 0;

		this.extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex, meshIndex, bakeMatrix, bakeNormal, flip );

	}

	// triangle extraction that stores directly in texture format
	extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex, meshIndex, bakeMatrix = null, bakeNormal = null, flipWinding = false ) {

		// Track per-material triangle count for sort-bin remap (item 41)
		while ( this.materialTriangleCounts.length <= materialIndex ) this.materialTriangleCounts.push( 0 );
		this.materialTriangleCounts[ materialIndex ] += triangleCount;

		// Pre-allocate objects for positions, normals, and UVs
		const posA = this._getVec3( 0 );
		const posB = this._getVec3( 1 );
		const posC = this._getVec3( 2 );

		const normalA = this._getVec3( 3 );
		const normalB = this._getVec3( 4 );
		const normalC = this._getVec3( 5 );

		const uvA = this._getVec2( 0 );
		const uvB = this._getVec2( 1 );
		const uvC = this._getVec2( 2 );

		// Ensure capacity for this batch up front (single grow check per mesh)
		this._ensureCapacity( this.currentTriangleIndex + triangleCount );

		const bm = bakeMatrix?.elements, bn = bakeNormal?.elements;

		// Batch process triangles to avoid excessive function calls
		for ( let i = 0; i < triangleCount; i ++ ) {

			const i3 = i * 3;
			const idxA = indices ? indices[ i3 + 0 ] : i3 + 0;
			const b = flipWinding ? 2 : 1, c = flipWinding ? 1 : 2;
			const idxB = indices ? indices[ i3 + b ] : i3 + b;
			const idxC = indices ? indices[ i3 + c ] : i3 + c;

			this.getVertex( positions, idxA, posA );
			this.getVertex( positions, idxB, posB );
			this.getVertex( positions, idxC, posC );

			this.getVertex( normals, idxA, normalA );
			this.getVertex( normals, idxB, normalB );
			this.getVertex( normals, idxC, normalC );

			if ( uvs ) {

				this.getVertex( uvs, idxA, uvA );
				this.getVertex( uvs, idxB, uvB );
				this.getVertex( uvs, idxC, uvC );

			} else {

				uvA.set( 0, 0 );
				uvB.set( 0, 0 );
				uvC.set( 0, 0 );

			}

			// Shared geometry stays in object space, its transform on the TLAS leaf, so every
			// placement reads one copy. Single-use geometry is baked to world here instead.
			if ( bakeMatrix ) {

				affinePoint( posA, bm ); affinePoint( posB, bm ); affinePoint( posC, bm );
				linearDir( normalA, bn ); linearDir( normalB, bn ); linearDir( normalC, bn );

			}

			normalA.normalize();
			normalB.normalize();
			normalC.normalize();

			// Pack triangle datas
			this.packTriangleDataTextureFormat(
				this.currentTriangleIndex,
				posA, posB, posC,
				normalA, normalB, normalC,
				uvA, uvB, uvC,
				materialIndex,
				meshIndex
			);

			this.currentTriangleIndex ++;

		}

	}

	// Pack one triangle into its 5 uvec4 lanes (see TRIANGLE_DATA_LAYOUT).
	packTriangleDataTextureFormat( triangleIndex, posA, posB, posC, normalA, normalB, normalC, uvA, uvB, uvC, materialIndex, meshIndex ) {

		const L = TRIANGLE_DATA_LAYOUT;
		// One chunk resolve per triangle; its 20 lanes are contiguous inside that chunk.
		const offset = this.triangles.baseOf( triangleIndex );
		const f = this.triangleFloatChunks.chunkFor( triangleIndex );
		const u = this.triangles.chunkFor( triangleIndex );

		f[ offset + L.POSITION_A_OFFSET + 0 ] = posA.x;
		f[ offset + L.POSITION_A_OFFSET + 1 ] = posA.y;
		f[ offset + L.POSITION_A_OFFSET + 2 ] = posA.z;
		u[ offset + L.NORMAL_A_PACKED_OFFSET ] = packNormalOct( normalA.x, normalA.y, normalA.z );

		f[ offset + L.POSITION_B_OFFSET + 0 ] = posB.x;
		f[ offset + L.POSITION_B_OFFSET + 1 ] = posB.y;
		f[ offset + L.POSITION_B_OFFSET + 2 ] = posB.z;
		u[ offset + L.NORMAL_B_PACKED_OFFSET ] = packNormalOct( normalB.x, normalB.y, normalB.z );

		f[ offset + L.POSITION_C_OFFSET + 0 ] = posC.x;
		f[ offset + L.POSITION_C_OFFSET + 1 ] = posC.y;
		f[ offset + L.POSITION_C_OFFSET + 2 ] = posC.z;
		u[ offset + L.NORMAL_C_PACKED_OFFSET ] = packNormalOct( normalC.x, normalC.y, normalC.z );

		f[ offset + L.UV_AB_OFFSET + 0 ] = uvA.x;
		f[ offset + L.UV_AB_OFFSET + 1 ] = uvA.y;
		f[ offset + L.UV_AB_OFFSET + 2 ] = uvB.x;
		f[ offset + L.UV_AB_OFFSET + 3 ] = uvB.y;

		f[ offset + L.UV_C_OFFSET + 0 ] = uvC.x;
		f[ offset + L.UV_C_OFFSET + 1 ] = uvC.y;

		u[ offset + L.MATERIAL_FLAGS_OFFSET ] = packTriangleFlags( materialIndex, this.materials[ materialIndex ] );
		u[ offset + L.MESH_INDEX_OFFSET ] = meshIndex;

	}

	/** The filled triangle records, as one chunk when they fit and several when they do not. */
	/**
	 * Lets go of the triangle store once its owner has taken it. The extractor's own reference
	 * (and its float view) kept every chunk alive, so a spilled chunk never left memory.
	 */
	releaseTriangles() {

		this.triangles = null;
		this.triangleData = null;
		this.triangleFloatChunks = null;
		this.triangleFloats = null;

	}

	getTriangleData() {

		if ( ! this.triangles ) return null;
		// A streamed store is trimmed where it stands: its receiver holds chunks of it on disk.
		return this._streamedStore ? this.triangles : this.triangles.trimTo( this.currentTriangleIndex );

	}

	// Get triangle count
	getTriangleCount() {

		return this.currentTriangleIndex;

	}

	// Optimized attribute access methods
	getVertex( attribute, index, target ) {

		if ( attribute.itemSize === 2 ) {

			target.x = attribute.getX( index );
			target.y = attribute.getY( index );

		} else if ( attribute.itemSize >= 3 ) {

			target.x = attribute.getX( index );
			target.y = attribute.getY( index );
			target.z = attribute.getZ( index );

		}

		return target;

	}

	logStats() {

		const usedBytes = this.currentTriangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4;

		log.debug( fmt.list( [
			`${fmt.count( this.currentTriangleIndex, 'tri' )} (${fmt.mb( usedBytes )})`,
			fmt.count( this.materials.length, 'material' ),
			fmt.count( this.maps.length, 'map' ),
		] ) );

	}

	/**
	 * Extract only materials and texture references without processing geometry.
	 * Skips triangle counting, Float32Array allocation, and vertex extraction.
	 */
	extractMaterialsOnly( object ) {

		this.resetArrays();

		this._traverseMaterialsOnly( object );

		return this.getExtractedData();

	}

	_traverseMaterialsOnly( object ) {

		if ( object.isMesh && object.geometry && object.material ) {

			const materialIndex = this.processMaterial( object.material );
			object.userData.materialIndex = materialIndex;

			const meshIndex = this.meshes.length;
			this.meshes.push( object );
			object.userData.meshIndex = meshIndex;

		} else if ( object.isDirectionalLight ) {

			this.directionalLights.push( object );

		} else if ( object.isCamera ) {

			this.cameras.push( object );

		}

		if ( object.children ) {

			for ( const child of object.children ) {

				this._traverseMaterialsOnly( child );

			}

		}

	}

	resetArrays() {

		this._droppedTextures = 0;

		// Reset triangle data
		this.triangles = null;
		this._streamedStore = false;
		this.triangleData = null;
		this.triangleFloatChunks = null;
		this.triangleFloats = null;
		this.triangleCount = 0;
		this.currentTriangleIndex = 0;

		// Reset other arrays
		this.materials = [];
		this.materialTriangleCounts = []; // Per-material triangle count (for sort-bin remap, item 41)
		this.meshes = [];
		this.meshTriangleRanges = []; // Per-mesh { start, count } for TLAS/BLAS
		this._geometryRanges = new Map(); // geometry+material -> the range that already holds it
		this.expandedTriangleCount = 0; // triangles as a per-mesh walk would count them
		this._allocatePlacements( 0 ); // SoA placements: sourceMesh column + 16 floats each
		this.maps = [];
		this.normalMaps = [];
		this.bumpMaps = [];
		this.metalnessMaps = [];
		this.emissiveMaps = [];
		this.roughnessMaps = [];
		this.displacementMaps = [];
		this.anisotropyMaps = [];
		this.transmissionMaps = [];
		this.clearcoatMaps = [];
		this.clearcoatRoughnessMaps = [];
		this.sheenColorMaps = [];
		this.sheenRoughnessMaps = [];
		this.iridescenceMaps = [];
		this.iridescenceThicknessMaps = [];
		this.specularIntensityMaps = [];
		this.specularColorMaps = [];
		this.diffuseTransmissionMaps = [];
		this.diffuseTransmissionColorMaps = [];
		this.directionalLights = [];
		this.cameras = [];

		// UUID → index lookup caches (O(1) instead of O(n) findIndex)
		this._materialUuidMap = new Map();
		this._textureIndexCache = new WeakMap();

	}

	getExtractedData() {

		return {
			triangleData: this.getTriangleData(), // Texture-ready Float32Array format
			triangleCount: this.getTriangleCount(),
			materials: this.materials,
			materialTriangleCounts: this.materialTriangleCounts,
			meshes: this.meshes,
			meshTriangleRanges: this.meshTriangleRanges, // Per-mesh { start, count } for TLAS/BLAS
			expandedTriangleCount: this.expandedTriangleCount,
			instanceSource: this.instanceSource.subarray( 0, this.instanceCount ),
			matrixRuns: this._matrixRuns(),
			instanceCount: this.instanceCount,
			instanceGroups: this._instanceGroups(),
			// meshIndex -> inverse of the pose baked into its triangles; only baked meshes appear.
			bakeInverse: this.bakeInverse,
			maps: this.maps,
			normalMaps: this.normalMaps,
			bumpMaps: this.bumpMaps,
			metalnessMaps: this.metalnessMaps,
			emissiveMaps: this.emissiveMaps,
			roughnessMaps: this.roughnessMaps,
			displacementMaps: this.displacementMaps,
			anisotropyMaps: this.anisotropyMaps,
			transmissionMaps: this.transmissionMaps,
			clearcoatMaps: this.clearcoatMaps,
			clearcoatRoughnessMaps: this.clearcoatRoughnessMaps,
			sheenColorMaps: this.sheenColorMaps,
			sheenRoughnessMaps: this.sheenRoughnessMaps,
			iridescenceMaps: this.iridescenceMaps,
			iridescenceThicknessMaps: this.iridescenceThicknessMaps,
			specularIntensityMaps: this.specularIntensityMaps,
			specularColorMaps: this.specularColorMaps,
			diffuseTransmissionMaps: this.diffuseTransmissionMaps,
			diffuseTransmissionColorMaps: this.diffuseTransmissionColorMaps,
			directionalLights: this.directionalLights,
			cameras: this.cameras
		};

	}

}

// Export the data layout constants
export { TRIANGLE_DATA_LAYOUT };
