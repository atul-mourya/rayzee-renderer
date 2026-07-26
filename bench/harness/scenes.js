/**
 * Deterministic bench scene corpus.
 *
 * Every scene is built from three.js primitives and a procedural environment, so the
 * suite runs with no network access. This is deliberate: `app/public` contains only two
 * untracked .glb files, and every example model plus all 70 HDRIs are remote URLs on
 * assets.rayzee.atulmourya.com. A corpus depending on those would be slow, flaky offline,
 * and would silently change whenever the asset host does.
 *
 * Each scene pins one failure axis. Cameras are hardcoded rather than auto-framed so a
 * geometry tweak can never silently reframe a baseline.
 */

import {
	BoxGeometry,
	Color,
	CylinderGeometry,
	DataTexture,
	DirectionalLight,
	Group,
	Matrix3,
	Mesh,
	MeshPhysicalMaterial,
	PlaneGeometry,
	RepeatWrapping,
	RGBAFormat,
	SphereGeometry,
	SRGBColorSpace,
	Vector3,
} from 'three';

import { generateMaterialSpheres } from '@/core/Processor/generateMaterialSpheres.js';

/** Shared render size. Small keeps goldens cheap and the suite fast. */
export const RENDER_SIZE = { width: 256, height: 256 };

// ── Builders ────────────────────────────────────────────────────

function makeRoom( { size = 6, emissiveCeiling = false } = {} ) {

	const room = new Group();
	const half = size / 2;

	// Cornell-ish box: white floor/ceiling/back, red left, green right.
	const walls = [
		{ color: 0xcccccc, pos: [ 0, - half, 0 ], rot: [ - Math.PI / 2, 0, 0 ] }, // floor
		{ color: 0xcccccc, pos: [ 0, half, 0 ], rot: [ Math.PI / 2, 0, 0 ] }, // ceiling
		{ color: 0xcccccc, pos: [ 0, 0, - half ], rot: [ 0, 0, 0 ] }, // back
		{ color: 0xcc2222, pos: [ - half, 0, 0 ], rot: [ 0, Math.PI / 2, 0 ] }, // left
		{ color: 0x22cc22, pos: [ half, 0, 0 ], rot: [ 0, - Math.PI / 2, 0 ] }, // right
	];

	for ( const wall of walls ) {

		const mesh = new Mesh(
			new PlaneGeometry( size, size ),
			new MeshPhysicalMaterial( { color: wall.color, roughness: 1, metalness: 0 } )
		);
		mesh.position.set( ...wall.pos );
		mesh.rotation.set( ...wall.rot );
		room.add( mesh );

	}

	if ( emissiveCeiling ) {

		const light = new Mesh(
			new PlaneGeometry( size * 0.3, size * 0.3 ),
			new MeshPhysicalMaterial( {
				color: 0x000000,
				emissive: 0xffffff,
				emissiveIntensity: 12,
				roughness: 1,
			} )
		);
		light.position.set( 0, half - 0.01, 0 );
		light.rotation.set( Math.PI / 2, 0, 0 );
		room.add( light );

	}

	return room;

}

function makeGlassRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.7, 48, 48 );

	// Varying IOR and roughness exercises TIR, the transmissive bounce cap and rough
	// refraction — the paths most likely to break when transmission code changes.
	const specs = [
		{ ior: 1.33, roughness: 0.0 },
		{ ior: 1.5, roughness: 0.0 },
		{ ior: 1.5, roughness: 0.15 },
		{ ior: 2.4, roughness: 0.0 },
	];

	specs.forEach( ( spec, index ) => {

		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0xffffff,
			transmission: 1,
			thickness: 1.4,
			ior: spec.ior,
			roughness: spec.roughness,
			metalness: 0,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.8, 0, 0 );
		group.add( mesh );

	} );

	// An opaque backdrop so refraction has something to bend.
	const backdrop = new Mesh(
		new BoxGeometry( 12, 6, 0.2 ),
		new MeshPhysicalMaterial( { color: 0x3366aa, roughness: 0.8, metalness: 0 } )
	);
	backdrop.position.set( 0, 0, - 3 );
	group.add( backdrop );

	return group;

}

function makeBackdrop( { color = 0x555555, roughness = 0.85 } = {} ) {

	const backdrop = new Mesh(
		new BoxGeometry( 14, 8, 0.2 ),
		new MeshPhysicalMaterial( { color, roughness, metalness: 0 } )
	);
	backdrop.position.set( 0, 0, - 3.2 );
	return backdrop;

}

/**
 * Random-walk subsurface scattering across the axes that select different code paths:
 * the entry lottery (weight < 1 falls through to the opaque BRDF), mean-free-path scale
 * (short = surface-like, long = deep transport that hits the step cap) and phase-function
 * anisotropy. Transmission stays 0 — SSS is deliberately independent of it.
 */
function makeSubsurfaceRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.85, 48, 48 );

	const specs = [
		{ weight: 0.4, radiusScale: 0.3, g: 0.0 },
		{ weight: 1.0, radiusScale: 1.0, g: 0.0 },
		{ weight: 1.0, radiusScale: 3.0, g: 0.4 },
	];

	specs.forEach( ( spec, index ) => {

		const material = new MeshPhysicalMaterial( {
			color: 0xf0e0d0,
			roughness: 0.35,
			metalness: 0,
		} );

		// Custom engine properties — MeshPhysicalMaterial has no notion of these, and
		// GeometryExtractor reads them straight off the material with `?? defaults`.
		material.subsurface = spec.weight;
		material.subsurfaceColor = new Color( 0xffd9c0 );
		material.subsurfaceRadius = [ 1.0, 0.35, 0.18 ]; // skin-like: red travels furthest
		material.subsurfaceRadiusScale = spec.radiusScale;
		material.subsurfaceAnisotropy = spec.g;

		const mesh = new Mesh( geometry, material );
		mesh.position.set( ( index - 1 ) * 2.1, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x303845 } ) );

	return group;

}

/**
 * Surface specular anisotropy. The first sphere is isotropic, which routes through the
 * `anisotropy > 0` guard's other branch — so one image covers both the anisotropic GGX
 * sampler/eval/PDF trio and the isotropic path it must not disturb. Rotations differ so a
 * tangent-frame regression shows as streaks pointing the wrong way rather than cancelling.
 */
function makeAnisotropyRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ anisotropy: 0.0, rotation: 0.0, roughness: 0.3 },
		{ anisotropy: 0.5, rotation: 0.0, roughness: 0.3 },
		{ anisotropy: 0.9, rotation: Math.PI / 4, roughness: 0.3 },
		{ anisotropy: 1.0, rotation: Math.PI / 2, roughness: 0.15 },
	];

	specs.forEach( ( spec, index ) => {

		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0xd8d8dd,
			metalness: 1,
			roughness: spec.roughness,
			anisotropy: spec.anisotropy,
			anisotropyRotation: spec.rotation,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.9, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x6a5540, roughness: 0.6 } ) );

	return group;

}

/**
 * Objects resting exactly on y = 0 plus a sun. The catcher plane is analytic (no geometry),
 * and its height is auto-seeded to the scene's min-Y on load — so every object's lowest
 * point sits on the plane and the shadows are contact shadows.
 */
function makeCatcherRig() {

	const group = new Group();

	const sphere = new Mesh(
		new SphereGeometry( 0.9, 48, 48 ),
		new MeshPhysicalMaterial( { color: 0xcc4444, roughness: 0.4, metalness: 0 } )
	);
	sphere.position.set( - 1.8, 0.9, 0 );
	group.add( sphere );

	const box = new Mesh(
		new BoxGeometry( 1.4, 1.8, 1.4 ),
		new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.8, metalness: 0 } )
	);
	box.position.set( 0.6, 0.9, - 0.6 );
	box.rotation.set( 0, 0.5, 0 );
	group.add( box );

	const post = new Mesh(
		new CylinderGeometry( 0.35, 0.35, 2.4, 32 ),
		new MeshPhysicalMaterial( { color: 0x4477cc, roughness: 0.25, metalness: 0.9 } )
	);
	post.position.set( 2.6, 1.2, 0.4 );
	group.add( post );

	// A hard light source: the catcher's shadow ratio is an irradiance-weighted NEE dual sum,
	// and a directional light gives it a crisp edge that env-only lighting would wash out.
	const sun = new DirectionalLight( 0xffffff, 3.5 );
	sun.position.set( 4, 6, 3 ); // default target is the origin, so this aims down-and-left
	group.add( sun );

	return group;

}

// ── Procedural textures ─────────────────────────────────────────
//
// Integer/trig arithmetic only — never Math.random. A texture whose bytes changed between
// runs would silently invalidate every baseline that depends on it.
//
// Sizes differ deliberately: material maps are packed into size-bucketed texture arrays,
// so three distinct dimensions exercise three buckets and the per-bucket index remap.

function makeCheckerAlbedo( size = 128, cells = 8 ) {

	const data = new Uint8Array( size * size * 4 );
	const cell = size / cells;

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			const on = ( Math.floor( x / cell ) + Math.floor( y / cell ) ) % 2 === 0;
			const i = ( y * size + x ) * 4;
			data[ i ] = on ? 222 : 34;
			data[ i + 1 ] = on ? 96 : 142;
			data[ i + 2 ] = on ? 48 : 204;
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;

}

/** Tangent-space normals from an analytic sinusoidal height field. */
function makeBumpNormal( size = 64, bumps = 5, amplitude = 0.35 ) {

	const data = new Uint8Array( size * size * 4 );
	const k = 2 * Math.PI * bumps;

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			const u = x / size;
			const v = y / size;

			// h = A sin(k u) sin(k v)  ⇒  N = normalize( -∂h/∂u, -∂h/∂v, 1 )
			const dhdu = amplitude * k * Math.cos( k * u ) * Math.sin( k * v );
			const dhdv = amplitude * k * Math.sin( k * u ) * Math.cos( k * v );
			const len = Math.hypot( dhdu, dhdv, 1 );

			const i = ( y * size + x ) * 4;
			data[ i ] = Math.round( ( - dhdu / len * 0.5 + 0.5 ) * 255 );
			data[ i + 1 ] = Math.round( ( - dhdv / len * 0.5 + 0.5 ) * 255 );
			data[ i + 2 ] = Math.round( ( 1 / len * 0.5 + 0.5 ) * 255 );
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.needsUpdate = true;
	return texture;

}

/** Roughness stripes. Written to G because that is the channel the sampler reads (glTF ORM). */
function makeStripeRoughness( size = 256, stripes = 12 ) {

	const data = new Uint8Array( size * size * 4 );
	const period = size / stripes;

	for ( let y = 0; y < size; y ++ ) {

		const t = Math.floor( y / period ) % 2 === 0 ? 0.12 : 0.9;
		const byte = Math.round( t * 255 );

		for ( let x = 0; x < size; x ++ ) {

			const i = ( y * size + x ) * 4;
			data[ i ] = byte;
			data[ i + 1 ] = byte;
			data[ i + 2 ] = byte;
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.needsUpdate = true;
	return texture;

}

/**
 * Textured geometry across three UV shapes. A non-identity repeat/offset is applied so a
 * texture-matrix regression (the offset.y flip is a bug this repo has already had) shows up
 * as shifted detail rather than passing unnoticed at repeat 1 / offset 0.
 */
function makeTexturedRig() {

	const group = new Group();

	const map = makeCheckerAlbedo();
	const normalMap = makeBumpNormal();
	const roughnessMap = makeStripeRoughness();

	for ( const texture of [ map, normalMap, roughnessMap ] ) {

		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;
		texture.repeat.set( 3, 2 );
		texture.offset.set( 0.15, 0.35 );

	}

	const material = new MeshPhysicalMaterial( {
		map,
		normalMap,
		roughnessMap,
		roughness: 1,
		metalness: 0,
	} );
	material.normalScale.set( 0.8, 0.8 );

	const sphere = new Mesh( new SphereGeometry( 1.1, 64, 48 ), material );
	sphere.position.set( - 1.9, 0.2, 0 );
	group.add( sphere );

	const box = new Mesh( new BoxGeometry( 1.8, 1.8, 1.8 ), material );
	box.position.set( 1.3, 0.1, 0.3 );
	box.rotation.set( 0.3, 0.6, 0 );
	group.add( box );

	const floor = new Mesh( new PlaneGeometry( 12, 12 ), material );
	floor.position.set( 0, - 1.3, 0 );
	floor.rotation.set( - Math.PI / 2, 0, 0 );
	group.add( floor );

	return group;

}

/**
 * Deformable sphere + rigidly-moved box + static floor, built at the pose the BVH is
 * constructed from. deformToPoseB() then moves it, and the scene refits rather than
 * rebuilding — which is the whole point of the scene.
 */
function makeRefitRig() {

	const group = new Group();

	const blob = new Mesh(
		new SphereGeometry( 1.3, 64, 48 ),
		new MeshPhysicalMaterial( { color: 0xdd8844, roughness: 0.35, metalness: 0.1 } )
	);
	blob.name = 'blob';
	blob.position.set( - 1.7, 0.2, 0 );
	group.add( blob );

	const box = new Mesh(
		new BoxGeometry( 1.5, 1.5, 1.5 ),
		new MeshPhysicalMaterial( { color: 0x88aacc, roughness: 0.2, metalness: 0.8 } )
	);
	box.name = 'box';
	box.position.set( 1.9, - 0.4, - 0.3 );
	group.add( box );

	const floor = new Mesh(
		new PlaneGeometry( 14, 14 ),
		new MeshPhysicalMaterial( { color: 0xaaaaaa, roughness: 0.9, metalness: 0 } )
	);
	floor.position.set( 0, - 2, 0 );
	floor.rotation.set( - Math.PI / 2, 0, 0 );
	group.add( floor );

	return group;

}

/**
 * Pose B: a vertex deformation (grows the blob's BLAS bounds) plus a rigid transform (moves
 * the box's world AABB, so the TLAS must change too). Two different refit failure modes, one
 * render — a BLAS that keeps stale bounds and a TLAS that keeps a stale leaf AABB both
 * manifest as rays missing geometry they should hit.
 */
function deformToPoseB( group ) {

	const blob = group.getObjectByName( 'blob' );
	const position = blob.geometry.attributes.position;
	const normal = blob.geometry.attributes.normal;
	const v = new Vector3();
	const n = new Vector3();

	for ( let i = 0; i < position.count; i ++ ) {

		v.fromBufferAttribute( position, i );
		n.fromBufferAttribute( normal, i );

		const displacement = 0.42 * Math.sin( 3.1 * v.x ) * Math.cos( 2.7 * v.y ) + 0.18 * Math.sin( 4.3 * v.z );
		v.addScaledVector( n, displacement );
		position.setXYZ( i, v.x, v.y, v.z );

	}

	position.needsUpdate = true;
	blob.geometry.computeVertexNormals();

	const box = group.getObjectByName( 'box' );
	box.position.set( 2.3, 0.7, 0.6 );
	box.rotation.set( 0.4, 0.7, 0.25 );

}

/**
 * World-space triangle buffers in exactly the layout `PathTracerApp.refitBVH()` expects:
 * 9 floats per triangle, meshes in `app.sceneMeshes` order, triangles in index order,
 * positions through matrixWorld and normals through the normal matrix.
 *
 * Mirrors GeometryExtractor.extractTrianglesInBatch rather than reusing it, because that
 * runs once at load time against the pre-deformation geometry.
 *
 * Reads `app.sceneMeshes` rather than walking the rig, and that distinction is the whole
 * reason this scene is worth having: the engine also owns a hidden ground-projection disk
 * that lands FIRST in the buffer, so a rig-only walk is both 32 triangles short and offset
 * by 32 for everything after it.
 */
function extractWorldTriangles( app ) {

	// One scene-wide pass: per-mesh updateMatrixWorld() reads a possibly-stale parent matrix.
	app.meshScene.updateMatrixWorld( true );

	const meshes = app.sceneMeshes;

	const triangleCountOf = ( geometry ) => (
		geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
	);

	let total = 0;
	for ( const mesh of meshes ) total += triangleCountOf( mesh.geometry );

	const positions = new Float32Array( total * 9 );
	const normals = new Float32Array( total * 9 );
	const v = new Vector3();
	const n = new Vector3();
	const normalMatrix = new Matrix3();
	let out = 0;

	for ( const mesh of meshes ) {

		const geometry = mesh.geometry;
		const position = geometry.attributes.position;
		const normal = geometry.attributes.normal;
		const index = geometry.index;
		const count = triangleCountOf( geometry );

		normalMatrix.getNormalMatrix( mesh.matrixWorld );

		for ( let t = 0; t < count; t ++ ) {

			for ( let corner = 0; corner < 3; corner ++ ) {

				const i = index ? index.getX( t * 3 + corner ) : t * 3 + corner;

				v.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
				positions[ out ] = v.x;
				positions[ out + 1 ] = v.y;
				positions[ out + 2 ] = v.z;

				n.fromBufferAttribute( normal, i ).applyMatrix3( normalMatrix ).normalize();
				normals[ out ] = n.x;
				normals[ out + 1 ] = n.y;
				normals[ out + 2 ] = n.z;

				out += 3;

			}

		}

	}

	return { positions, normals };

}

// ── Scene corpus ────────────────────────────────────────────────

/**
 * @typedef {Object} SceneSpec
 * @property {string} id
 * @property {string} covers        - the failure axis this scene pins
 * @property {number} spp           - samples for the regression render
 * @property {number} truthSpp      - samples for the one-time ground-truth render
 * @property {Object} settings      - engine settings applied before rendering
 * @property {function} build       - async (app) => void; loads geometry + env, sets camera
 */

/** @type {SceneSpec[]} */
export const SCENES = [
	{
		id: 'spheres-gradient',
		covers: 'diffuse GI, GGX metal/rough response, gradient environment importance sampling',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( generateMaterialSpheres(), 'spheres' );
			setCamera( app, [ 0, 0, 9 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'cornell-emissive',
		covers: 'emissive-triangle NEE, MIS weighting, colour bleeding across bounces',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 6, enableEmissiveTriangleSampling: true, enableEnvironment: false },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'color' );

			const scene = makeRoom( { emissiveCeiling: true } );
			const ball = new Mesh(
				new SphereGeometry( 1, 48, 48 ),
				new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.25, metalness: 0 } )
			);
			ball.position.set( - 1.1, - 2, 0.4 );
			scene.add( ball );

			const box = new Mesh(
				new BoxGeometry( 1.6, 3, 1.6 ),
				new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.9, metalness: 0 } )
			);
			box.position.set( 1.3, - 1.5, - 0.8 );
			box.rotation.set( 0, 0.4, 0 );
			scene.add( box );

			await app.loadObject3D( scene, 'cornell' );
			setCamera( app, [ 0, 0, 8.5 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'glass-transmission',
		covers: 'transmission, TIR, IOR sweep, transmissive bounce cap, rough refraction',
		spp: 96,
		truthSpp: 2048,
		settings: { maxBounces: 6, transmissiveBounces: 8 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeGlassRow(), 'glass' );
			setCamera( app, [ 0, 0.6, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'spheres-procedural-sky',
		covers: 'procedural sky evaluation and environment CDF importance sampling',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( generateMaterialSpheres( 3, 3, 1.6 ), 'spheres-sky' );
			setCamera( app, [ 0, 0, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'subsurface-marble',
		covers: 'random-walk subsurface scattering — chromatic collision sampling, Henyey-Greenstein phase, medium stack push/pop, step cap',
		spp: 96,
		// Lower than the rest of the corpus: SSS paths walk many steps inside the medium, so
		// each sample costs several times a diffuse one. 1024 still leaves the truth reference
		// far more converged than the 96-sample render it is measured against.
		truthSpp: 1024,
		settings: { maxBounces: 6, maxSubsurfaceSteps: 32 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeSubsurfaceRow(), 'subsurface' );
			setCamera( app, [ 0, 0.3, 6.5 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'anisotropy-brushed',
		covers: 'surface specular anisotropy — anisotropic GGX sampler/eval/PDF agreement across tangent rotations, plus the isotropic path',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			// Procedural sky rather than a smooth gradient: anisotropic highlights need
			// structure in the environment to smear into a streak.
			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( makeAnisotropyRow(), 'anisotropy' );
			setCamera( app, [ 0, 0.4, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'shadow-catcher-ground',
		covers: 'analytic ground-plane shadow catcher — NEE dual-sum shadow ratio, coverage gate, directional-light occlusion',
		spp: 64,
		truthSpp: 2048,
		// groundCatcherHeight is listed even though the engine overwrites it on load
		// (auto-seeded to the scene's min-Y): every settings key any scene touches has to
		// appear here, or sceneSettingsFloor() will not reset it for the scenes that follow.
		settings: { maxBounces: 4, enableGroundCatcher: true, groundCatcherHeight: 0 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeCatcherRig(), 'catcher' );
			setCamera( app, [ 0, 2.4, 9 ], [ 0, 0.6, 0 ] );

		},
	},
	{
		id: 'textured-normalmap',
		covers: 'material texture arrays — albedo/normal/roughness sampling, size buckets, RepeatWrapping, non-identity UV transform, normalScale',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeTexturedRig(), 'textured' );
			setCamera( app, [ 0, 0.8, 7.5 ], [ 0, - 0.2, 0 ] );

		},
	},
	{
		id: 'refit-deform',
		covers: 'BVH refit — BLAS bound recomputation after vertex deformation and TLAS update after a rigid move',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );

			const rig = makeRefitRig();
			await app.loadObject3D( rig, 'refit' );

			// Move to pose B and refit, rather than building at pose B. Building there would
			// exercise a fresh SAH build — the one path this scene exists NOT to test.
			deformToPoseB( rig );
			const { positions, normals } = extractWorldTriangles( app );
			await app.refitBVH( positions, normals );

			setCamera( app, [ 0, 1.2, 8 ], [ 0, - 0.2, 0 ] );

		},
	},
];

/**
 * Pins the camera explicitly. Must run AFTER loadObject3D, which rebuilds the scene and
 * selects camera index 0 (potentially reframing).
 */
function setCamera( app, position, target ) {

	const camera = app.cameraManager.camera;
	camera.position.set( ...position );
	camera.lookAt( ...target );
	camera.updateMatrixWorld( true );

	const controls = app.cameraManager.controls;
	if ( controls ) {

		controls.target.set( ...target );
		controls.update();

	}

}

export function getScene( id ) {

	const scene = SCENES.find( ( s ) => s.id === id );
	if ( ! scene ) throw new Error( `Unknown bench scene "${id}" (have: ${SCENES.map( ( s ) => s.id ).join( ', ' )})` );
	return scene;

}
