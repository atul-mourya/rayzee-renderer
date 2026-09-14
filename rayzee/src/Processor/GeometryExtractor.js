import { Vector3, Vector2, Color, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide, RGBAFormat } from "three";
import {
	TEXTURE_CONSTANTS, TRIANGLE_DATA_LAYOUT, packNormalOct, packTriangleFlags
} from '../EngineDefaults.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { createLogger, fmt, warnOnce } from '../utils/Logger.js';

const log = createLogger( 'geometry' );

const MAX_TEXTURES_LIMIT = TEXTURE_CONSTANTS.MAX_TEXTURES_LIMIT;

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
		this.instances = [];
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

		// Single traversal: extract geometry, materials, lights, and cameras
		this.traverseObject( object );

		this.logStats();
		return this.getExtractedData();

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

		const previous = this.triangleData;
		this._allocateTriangles( needed );
		this.triangleData.set( previous );
		this._triangleCapacity = needed;

	}

	/**
	 * The record is a uint buffer; positions and UVs are written as f32 through a view of the
	 * same memory, so a packed lane's bit pattern is never round-tripped through an f32.
	 * @private
	 */
	_allocateTriangles( capacity ) {

		this.triangleData = new Uint32Array( capacity * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );
		this.triangleFloats = new Float32Array( this.triangleData.buffer );

	}

	traverseObject( object ) {

		// Process the current object
		if ( object.isMesh ) {

			this.processMesh( object );

		} else if ( object.isDirectionalLight ) {

			this.directionalLights.push( object );

		} else if ( object.isCamera ) {

			this.cameras.push( object );

		}

		// Process children recursively
		if ( object.children ) {

			for ( const child of object.children ) {

				this.traverseObject( child );

			}

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
		// keys its entries by triangle index, which sharing would make ambiguous.
		const key = `${mesh.geometry.uuid}|${materialIndex}`;
		const shared = this._emissiveMaterial( materialIndex ) ? null : this._geometryRanges.get( key );

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
			this._recordPlacements( mesh, meshIndex );
			return;

		}

		const rangeStart = this.currentTriangleIndex;

		// Extract geometry with both material and mesh indices
		this.extractGeometry( mesh, materialIndex, meshIndex );

		const range = {
			start: rangeStart, count: this.currentTriangleIndex - rangeStart,
			expandedStart: this.expandedTriangleCount
		};
		this.expandedTriangleCount += range.count;
		this.meshTriangleRanges.push( range );
		if ( range.count > 0 ) this._geometryRanges.set( key, { ...range, meshIndex } );
		this._recordPlacements( mesh, meshIndex );

	}

	/**
	 * One placement per object, or one per instance for an InstancedMesh. The scene graph
	 * holds a single object either way — only this list grows, so a million placements cost
	 * a matrix each rather than a million Object3Ds.
	 * @private
	 */
	_recordPlacements( mesh, meshIndex ) {

		const world = mesh.matrixWorld.elements;

		if ( ! mesh.isInstancedMesh || ! mesh.instanceMatrix ) {

			this.instances.push( { sourceMesh: meshIndex, matrixWorld: Float64Array.from( world ) } );
			return;

		}

		const arr = mesh.instanceMatrix.array;
		const count = mesh.count ?? ( arr.length / 16 );

		for ( let i = 0; i < count; i ++ ) {

			const o = i * 16;
			const m = new Float64Array( 16 );

			// world = mesh.matrixWorld * instanceMatrix, both column-major.
			for ( let c = 0; c < 4; c ++ ) {

				for ( let r = 0; r < 4; r ++ ) {

					m[ c * 4 + r ] = world[ r ] * arr[ o + c * 4 ]
						+ world[ 4 + r ] * arr[ o + c * 4 + 1 ]
						+ world[ 8 + r ] * arr[ o + c * 4 + 2 ]
						+ world[ 12 + r ] * arr[ o + c * 4 + 3 ];

				}

			}

			this.instances.push( { sourceMesh: meshIndex, matrixWorld: m } );

		}

	}

	/** True when this material emits — those meshes keep their own triangles. */
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

		// Defaults optimized for physically-based path tracing
		return {
			emissive: new Color( 0, 0, 0 ),
			emissiveIntensity: 1.0,
			roughness: 1.0,
			metalness: 0.0,
			ior: 1.5, // Common dielectric IOR (glass, plastic)
			opacity: 1.0,
			transmission: 0.0,
			thickness: 0.1,
			attenuationColor: new Color( 0xffffff ),
			attenuationDistance: Infinity, // No attenuation by default
			dispersion: 0.0,
			sheen: 0.0,
			sheenRoughness: 1.0,
			sheenColor: new Color( 0x000000 ),
			specularIntensity: 1.0,
			specularColor: new Color( 0xffffff ),
			clearcoat: 0.0,
			clearcoatRoughness: 0.0,
			iridescence: 0.0,
			iridescenceIOR: 1.3,
			iridescenceThicknessRange: [ 100, 400 ],
			normalScale: { x: 1, y: 1 },
			bumpScale: 1.0,
			displacementScale: 1.0,
			alphaTest: 0.0,
			// Subsurface scattering (no native MeshPhysicalMaterial equivalent)
			subsurface: 0.0,
			subsurfaceColor: new Color( 0xffffff ),
			subsurfaceRadius: [ 1.0, 0.2, 0.1 ], // skin-like: red travels furthest
			subsurfaceRadiusScale: 1.0,
			subsurfaceAnisotropy: 0.0,
			// Surface specular anisotropy (native MeshPhysicalMaterial / KHR_materials_anisotropy)
			anisotropy: 0.0,
			anisotropyRotation: 0.0
		};

	}

	mapLegacyMaterialToPhysical( material, materialType ) {

		// Map legacy material properties to physically-based equivalents
		const mapped = {};

		switch ( materialType ) {

			case 'basic':
				// MeshBasicMaterial -> Unlit/Emissive material
				mapped.emissive = material.color.clone();
				mapped.emissiveIntensity = 1.0;
				mapped.color = new Color( 0x000000 ); // No diffuse reflection
				mapped.roughness = 1.0;
				mapped.metalness = 0.0;
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

				// Convert specular color to specular intensity
				if ( material.specular ) {

					const specularLuminance = material.specular.r * 0.299 +
                                        material.specular.g * 0.587 +
                                        material.specular.b * 0.114;
					mapped.specularIntensity = Math.min( specularLuminance * 2.0, 1.0 );
					mapped.specularColor = material.specular.clone();

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

		// A transmissive surface is a dielectric interface whose IOR drives refraction, so it wins
		// over the metal Fresnel hack: glTF defaults metallicFactor to 1, which otherwise stamps
		// 2.5 onto water/glass authored as MeshStandardMaterial.
		const isTransmissive = ( material.transmission ?? 0.0 ) > 0.0;
		const isMetallic = ( material.metalness ?? legacyMapping.metalness ?? 0.0 ) > 0.1;
		const defaultIOR = ( isMetallic && ! isTransmissive ) ? 2.5 : defaults.ior;

		// Handle color conversion for different material types
		let baseColor = material.color || new Color( 0xffffff );
		if ( materialType === 'basic' && ! material.map ) {

			// For basic materials without textures, treat color as emissive
			baseColor = new Color( 0x000000 );

		}

		return {
			uuid: material.uuid,

			// Base material properties
			color: baseColor,
			emissive: legacyMapping.emissive ?? material.emissive ?? defaults.emissive,
			emissiveIntensity: legacyMapping.emissiveIntensity ?? material.emissiveIntensity ?? defaults.emissiveIntensity,

			// Surface properties
			// Floor at 0.02 (the sampler's own VNDF-PDF clamp, MaterialProperties.js) rather than
			// 0.05, so near-mirror metals stay sharp without entering a new firefly regime.
			roughness: Math.max( 0.02, legacyMapping.roughness ?? material.roughness ?? defaults.roughness ),
			metalness: legacyMapping.metalness ?? material.metalness ?? defaults.metalness,

			// Optical properties
			ior: material.ior ?? defaultIOR,
			opacity: material.opacity ?? defaults.opacity,

			// Transmission properties (MeshPhysicalMaterial only)
			transmission: material.transmission ?? defaults.transmission,
			thickness: material.thickness ?? defaults.thickness,
			attenuationColor: material.attenuationColor ?? defaults.attenuationColor,
			attenuationDistance: material.attenuationDistance ?? defaults.attenuationDistance,

			// Advanced properties (MeshPhysicalMaterial only)
			dispersion: material.dispersion ?? defaults.dispersion,
			sheen: material.sheen ?? defaults.sheen,
			sheenRoughness: material.sheenRoughness ?? defaults.sheenRoughness,
			sheenColor: material.sheenColor ?? defaults.sheenColor,
			clearcoat: material.clearcoat ?? defaults.clearcoat,
			clearcoatRoughness: material.clearcoatRoughness ?? defaults.clearcoatRoughness,
			iridescence: material.iridescence ?? defaults.iridescence,
			iridescenceIOR: material.iridescenceIOR ?? defaults.iridescenceIOR,
			iridescenceThicknessRange: material.iridescenceThicknessRange ?? defaults.iridescenceThicknessRange,

			// Subsurface scattering (custom props; MeshPhysicalMaterial has none)
			subsurface: material.subsurface ?? defaults.subsurface,
			subsurfaceColor: material.subsurfaceColor ?? defaults.subsurfaceColor,
			subsurfaceRadius: material.subsurfaceRadius ?? defaults.subsurfaceRadius,
			subsurfaceRadiusScale: material.subsurfaceRadiusScale ?? defaults.subsurfaceRadiusScale,
			subsurfaceAnisotropy: material.subsurfaceAnisotropy ?? defaults.subsurfaceAnisotropy,

			// Surface specular anisotropy (native MeshPhysicalMaterial / KHR_materials_anisotropy)
			anisotropy: material.anisotropy ?? defaults.anisotropy,
			anisotropyRotation: material.anisotropyRotation ?? defaults.anisotropyRotation,

			// Specular properties (for compatibility)
			specularIntensity: legacyMapping.specularIntensity ?? material.specularIntensity ?? defaults.specularIntensity,
			specularColor: legacyMapping.specularColor ?? material.specularColor ?? defaults.specularColor,

			// Surface detail properties
			normalScale: material.normalScale ?? defaults.normalScale,
			bumpScale: material.bumpScale ?? defaults.bumpScale,
			displacementScale: material.displacementScale ?? defaults.displacementScale,

			// Transparency and alpha
			transparent: material.transparent ? 1 : 0,
			alphaTest: material.alphaTest ?? defaults.alphaTest,
			alphaMode: deriveAlphaMode( material ),

			// Rendering properties
			side: this.getMaterialSide( material ),
			depthWrite: material.depthWrite ?? true ? 1 : 0,

			// Texture processing
			map: this.processTexture( material.map, this.maps ),
			normalMap: this.processTexture( material.normalMap, this.normalMaps ),
			bumpMap: this.processTexture( material.bumpMap, this.bumpMaps ),
			roughnessMap: this.processTexture( material.roughnessMap, this.roughnessMaps ),
			metalnessMap: this.processTexture( material.metalnessMap, this.metalnessMaps ),
			emissiveMap: this.processTexture( material.emissiveMap, this.emissiveMaps ),
			displacementMap: this.processTexture( material.displacementMap, this.displacementMaps ),
			anisotropyMap: this.processTexture( material.anisotropyMap, this.anisotropyMaps ),

			// Advanced texture maps (MeshPhysicalMaterial only). Folded into their scalar factors
			// in ShadeKernel (applyExtensionMaps). thicknessMap stays dropped — thickness has no
			// render effect yet (see gap-plan Phase 4.4).
			clearcoatMap: this.processTexture( material.clearcoatMap, this.clearcoatMaps ),
			clearcoatRoughnessMap: this.processTexture( material.clearcoatRoughnessMap, this.clearcoatRoughnessMaps ),
			transmissionMap: this.processTexture( material.transmissionMap, this.transmissionMaps ),
			thicknessMap: this.processTexture( material.thicknessMap, [] ),
			sheenColorMap: this.processTexture( material.sheenColorMap, this.sheenColorMaps ),
			sheenRoughnessMap: this.processTexture( material.sheenRoughnessMap, this.sheenRoughnessMaps ),
			specularIntensityMap: this.processTexture( material.specularIntensityMap, this.specularIntensityMaps ),
			specularColorMap: this.processTexture( material.specularColorMap, this.specularColorMaps ),
			iridescenceMap: this.processTexture( material.iridescenceMap, this.iridescenceMaps ),
			iridescenceThicknessMap: this.processTexture( material.iridescenceThicknessMap, this.iridescenceThicknessMaps ),

			// Texture transformation matrices
			mapMatrix: this.getTextureMatrix( material.map ),
			normalMapMatrices: this.getTextureMatrix( material.normalMap ),
			bumpMapMatrices: this.getTextureMatrix( material.bumpMap ),
			roughnessMapMatrices: this.getTextureMatrix( material.roughnessMap ),
			metalnessMapMatrices: this.getTextureMatrix( material.metalnessMap ),
			emissiveMapMatrices: this.getTextureMatrix( material.emissiveMap ),
			displacementMapMatrices: this.getTextureMatrix( material.displacementMap ),

			// Material type for debugging/optimization
			originalType: materialType
		};

	}

	getTextureMatrix( texture ) {

		if ( ! texture ) return new Matrix3().elements;
		texture.updateMatrix();
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

	extractGeometry( mesh, materialIndex, meshIndex ) {

		mesh.updateMatrix();
		mesh.updateMatrixWorld();

		const geometry = mesh.geometry;
		if ( ! geometry.attributes.normal ) geometry.computeVertexNormals();
		const positions = geometry.attributes.position;
		const normals = geometry.attributes.normal;
		const uvs = geometry.attributes.uv;
		const indices = geometry.index ? geometry.index.array : null;

		const triangleCount = indices ? indices.length / 3 : positions.count / 3;

		// Extract triangles with both material and mesh indices
		this.extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex, meshIndex );

	}

	// triangle extraction that stores directly in texture format
	extractTrianglesInBatch( positions, normals, uvs, indices, triangleCount, materialIndex, meshIndex ) {

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

		// Batch process triangles to avoid excessive function calls
		for ( let i = 0; i < triangleCount; i ++ ) {

			const i3 = i * 3;
			const idxA = indices ? indices[ i3 + 0 ] : i3 + 0;
			const idxB = indices ? indices[ i3 + 1 ] : i3 + 1;
			const idxC = indices ? indices[ i3 + 2 ] : i3 + 2;

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

			// Object space: the instance's transform lives on its TLAS leaf, and the ray is
			// moved into this space on the way down. Baking it here instead would mean one
			// copy of the triangles per placement.
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
		const offset = triangleIndex * L.FLOATS_PER_TRIANGLE;
		const f = this.triangleFloats;
		const u = this.triangleData;

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

	// Get the raw Float32Array (optimal for worker transfer and zero-copy textures)
	getTriangleData() {

		if ( ! this.triangleData ) return null;

		// Return only the used portion of the array
		return this.triangleData.subarray( 0, this.currentTriangleIndex * TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );

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
		this.triangleData = null;
		this.triangleCount = 0;
		this.currentTriangleIndex = 0;

		// Reset other arrays
		this.materials = [];
		this.materialTriangleCounts = []; // Per-material triangle count (for sort-bin remap, item 41)
		this.meshes = [];
		this.meshTriangleRanges = []; // Per-mesh { start, count } for TLAS/BLAS
		this._geometryRanges = new Map(); // geometry+material -> the range that already holds it
		this.expandedTriangleCount = 0; // triangles as a per-mesh walk would count them
		this.instances = []; // one per placement: { sourceMesh, matrixWorld }
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
			instances: this.instances,
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
			directionalLights: this.directionalLights,
			cameras: this.cameras
		};

	}

}

// Export the data layout constants
export { TRIANGLE_DATA_LAYOUT };
