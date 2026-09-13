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
	Group, Mesh, PerspectiveCamera, Matrix4, Vector3,
	BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, SphereGeometry,
	DataTexture, FloatType, RGBAFormat, LinearFilter, EquirectangularReflectionMapping
} from 'three';
import { buildMaterial, pFloat, pString, resolveSpectrum } from './PBRTMaterials.js';
import { loopSubdivide } from './LoopSubdivision.js';
import { octahedralToEquirect } from './EqualAreaOctahedral.js';
import * as M from './PBRTMath.js';

const FLIP_Z = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1 ];

export class PBRTSceneBuilder {

	/**
	 * @param {object} resolvers
	 * @param {(filename:string)=>Promise<BufferGeometry>} [resolvers.resolvePLY]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveImage]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveEnvironment]
	 * @param {boolean} [resolvers.convertHandedness=false]
	 */
	constructor( resolvers = {} ) {

		this.resolvePLY = resolvers.resolvePLY || ( async () => null );
		this.resolveImage = resolvers.resolveImage || ( async () => null );
		this.resolveEnvironment = resolvers.resolveEnvironment || resolvers.resolveImage || ( async () => null );
		this.convertHandedness = resolvers.convertHandedness === true;

		this.warnings = [];
		this.report = []; // per-mesh diagnostics for debugging imports
		this._materialCache = new Map(); // material obj -> Map(areaLight obj -> MeshPhysicalMaterial)
		this._textureCache = new Map(); // texName -> { texture } | { constant }

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
		const group = new Group();
		group.name = 'PBRTScene';

		// Shapes (direct + instanced)
		for ( let i = 0; i < ir.shapes.length; i ++ ) {

			const mesh = await this._buildShapeMesh( ir.shapes[ i ], ir.shapes[ i ].ctm, `shape_${i}` );
			if ( mesh ) group.add( mesh );

		}

		await this._buildInstances( ir, group );

		// Camera
		let camera = null;
		if ( ir.camera ) {

			camera = this._buildCamera( ir.camera, ir.film );
			if ( camera ) group.add( camera );

		}

		// Infinite light → environment
		const environment = await this._buildEnvironment( ir.lights );

		this._reportUnsupportedLights( ir.lights );

		return {
			group, camera, environment,
			report: this.report,
			warnings: this.warnings.concat( ir.warnings || [] )
		};

	}

	// ── shapes ─────────────────────────────────────────────────────

	async _buildInstances( ir, group ) {

		let n = 0;
		for ( const inst of ir.instances ) {

			const template = ir.objects.get( inst.name );
			if ( ! template ) {

				this.warn( `ObjectInstance "${inst.name}" has no template` ); continue;

			}

			for ( const shape of template ) {

				// instance placement: instanceCTM * (shape relative to its ObjectBegin frame)
				const worldCTM = M.multiply( inst.ctm, shape.relativeCTM || shape.ctm );
				const mesh = await this._buildShapeMesh( shape, worldCTM, `instance_${n ++}` );
				if ( mesh ) group.add( mesh );

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

		// A textured material on geometry with no UVs samples a single texel — the
		// usual cause of "black"/wrong meshes on import. Drop the map, but on a CLONE:
		// _getMaterial caches and shares one instance across every shape using the
		// same NamedMaterial, so mutating it would strip the texture from sibling
		// meshes that DO have UVs.
		const hasUV = !! geometry.getAttribute( 'uv' );
		let material = sharedMaterial;
		if ( sharedMaterial.map && ! hasUV ) {

			this.warn( `${name} (${shape.type}, "${shape.material?.type || 'diffuse'}") has a texture map but no UVs — dropping map, using base color` );
			material = sharedMaterial.clone();
			material.map = null;

		}

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
		geometry.computeBoundingBox();
		const worldSize = geometry.boundingBox
			? geometry.boundingBox.clone().applyMatrix4( mesh.matrix ).getSize( new Vector3() )
			: new Vector3();

		this.report.push( {
			mesh: name,
			shape: shape.type,
			material: shape.material?.type || 'diffuse',
			color: '#' + material.color.getHexString(),
			map: material.map ? 'yes' : '-',
			uv: hasUV ? 'yes' : 'NO',
			normals: geometry.getAttribute( 'normal' ) ? 'yes' : 'NO',
			emissive: material.emissiveIntensity > 0 ? `#${material.emissive.getHexString()}×${material.emissiveIntensity}` : '-',
			size: `${worldSize.x.toFixed( 2 )}×${worldSize.y.toFixed( 2 )}×${worldSize.z.toFixed( 2 )}`,
			tris: geometry.index ? geometry.index.count / 3 : geometry.getAttribute( 'position' ).count / 3
		} );

		return mesh;

	}

	async _buildGeometry( shape ) {

		switch ( shape.type ) {

			case 'trianglemesh': return this._triangleMesh( shape.params );
			case 'bilinearmesh': return this._bilinearMesh( shape.params );
			case 'loopsubdiv': return this._loopSubdiv( shape.params );
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
		geo.setAttribute( 'position', new Float32BufferAttribute( Float32Array.from( P ), 3 ) );

		const N = params.N?.value;
		if ( N && N.length === P.length ) geo.setAttribute( 'normal', new Float32BufferAttribute( Float32Array.from( N ), 3 ) );

		const uv = ( params.uv || params.st )?.value;
		if ( uv && uv.length === ( P.length / 3 ) * 2 ) geo.setAttribute( 'uv', new Float32BufferAttribute( Float32Array.from( uv ), 2 ) );

		const indices = params.indices?.value;
		if ( indices && indices.length ) geo.setIndex( indices );

		if ( ! N ) geo.computeVertexNormals();
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

	async _plyMesh( params ) {

		const filename = pString( params, 'filename', null );
		if ( ! filename ) {

			this.warn( 'plymesh missing filename' ); return null;

		}

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

		byLight.set( shape.areaLight, material );
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

			this.warn( `texture class "${def.class}" not supported (texture "${name}")` );

		}

		this._textureCache.set( name, result );
		return result;

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
		const data = image?.data;
		if ( ! data || ! image.width || image.width !== image.height ) {

			if ( image?.width !== image?.height ) this.warn(
				`infinite-light image "${filename}" is ${image?.width}x${image?.height}, not square — ` +
				'read as equirectangular, but pbrt would read it as equal-area octahedral'
			);
			return null;

		}

		const channels = data.length / ( image.width * image.height );
		if ( ! Number.isInteger( channels ) || channels < 3 ) return null;

		// three's EXR/HDR loaders fill DataTexture rows bottom-up; pbrt reads the square top-down.
		const { data: pixels, width, height } = octahedralToEquirect(
			{ data, width: image.width, height: image.height, channels, bottomUp: true },
			inf.ctm, scale
		);

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
