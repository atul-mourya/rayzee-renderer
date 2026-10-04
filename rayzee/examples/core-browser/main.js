/**
 * The renderer core in a page — `rayzee/core` plus one add-on, the physical sky — accumulating samples on a canvas.
 * No viewer: no camera controls, denoisers or gizmo, so the camera is placed by hand.
 *
 *   npm run example:browser         # from the repository root, then open the printed URL
 */

import { Scene, Mesh, SphereGeometry, BoxGeometry, PlaneGeometry, MeshPhysicalMaterial } from 'three';
import { RayzeeRenderer, EngineEvents } from 'rayzee/core';
import { PhysicalSky } from 'rayzee/addons/physical-sky';

const canvas = document.querySelector( 'canvas' );
const status = document.querySelector( '#status' );

const renderer = await new RayzeeRenderer( canvas ).init();
renderer.environmentManager.setProceduralSky( PhysicalSky );

const scene = new Scene();
const floor = new Mesh( new PlaneGeometry( 8, 8 ), new MeshPhysicalMaterial( { color: 0xb0b0b0, roughness: 0.8 } ) );
floor.rotation.x = - Math.PI / 2;
const gold = new Mesh( new SphereGeometry( 0.6, 64, 32 ), new MeshPhysicalMaterial( { color: 0xffc36b, metalness: 1, roughness: 0.25 } ) );
gold.position.set( - 0.8, 0.6, 0 );
const glass = new Mesh( new SphereGeometry( 0.6, 64, 32 ), new MeshPhysicalMaterial( { color: 0xffffff, transmission: 1, roughness: 0, ior: 1.5, thickness: 1.2 } ) );
glass.position.set( 0.8, 0.6, 0 );
const block = new Mesh( new BoxGeometry( 0.5, 1.4, 0.5 ), new MeshPhysicalMaterial( { color: 0x4f7dd6, roughness: 0.4, clearcoat: 1 } ) );
block.position.set( 0, 0.7, - 1.2 );
scene.add( floor, gold, glass, block );

await renderer.loadObject3D( scene, 'example' );

// The physical sky: late afternoon sun, from the add-on.
const sky = renderer.environmentManager.params;
sky.skySunDirection.set( - 0.6, 0.35, - 0.7 ).normalize();
await renderer.environmentManager.setMode( 'procedural' );

renderer.camera.position.set( 0, 1.4, 4.2 );
renderer.camera.lookAt( 0, 0.5, 0 );
// Keep refining to 512 samples rather than stopping once the image counts as converged.
renderer.settings.setMany( { useAdaptiveSampling: false, maxSamples: 512 } );
renderer.reset();

renderer.addEventListener( EngineEvents.FRAME, () => {

	status.textContent = `${renderer.getFrameCount()} samples · rayzee/core + rayzee/addons/physical-sky`;

} );
renderer.animate();
