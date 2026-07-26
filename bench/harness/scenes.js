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
	Group,
	Mesh,
	MeshPhysicalMaterial,
	PlaneGeometry,
	SphereGeometry,
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
