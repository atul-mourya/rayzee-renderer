/**
 * The renderer core on its own — `rayzee/core`, no viewer, no add-ons — rendering a scene in plain Node on Dawn (the
 * `webgpu` package, the WebGPU inside Chrome) and writing a PNG.
 *
 *   npm run example:node            # from the repository root: builds the engine, then runs this
 *
 * `npm run bench:node` runs it too, so it keeps working.
 */

import { create, globals } from 'webgpu';
import { Scene, Mesh, SphereGeometry, BoxGeometry, PlaneGeometry, MeshPhysicalMaterial } from 'three';
import sharp from 'sharp';
import { RayzeeRenderer, configurePlatform } from 'rayzee/core';
import { nodePlatform } from 'rayzee/node';

Object.assign( globalThis, globals );
// Keep the reference: Dawn crashes the process if this is garbage-collected while a device lives.
const gpu = create( [] );
Object.defineProperty( globalThis.navigator, 'gpu', { value: gpu, configurable: true } );
configurePlatform( nodePlatform() );

const width = 640, height = 400, samples = 128;
const out = process.argv[ 2 ] ?? 'core-node.png';

// strict: throw where the renderer would otherwise degrade and carry on — right for a batch render.
const renderer = new RayzeeRenderer( null, { strict: true, storage: false } );
renderer.setReservedRenderResolution( Math.max( width, height ) );
await renderer.init();
renderer.setCanvasSize( width, height );
renderer.setDeterministicMode( true );

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
renderer.environmentManager.params.solidSkyColor.set( 0xe8edf2 );
await renderer.environmentManager.setMode( 'color' );   // a plain sky lights the scene

renderer.camera.position.set( 0, 1.4, 4.2 );
renderer.camera.lookAt( 0, 0.5, 0 );

await renderer.renderFrames( samples );
const { data } = await renderer.renderToBuffer( { colorSpace: 'srgb' } );
renderer.dispose();

let sum = 0;
for ( let i = 0; i < data.length; i += 4 ) sum += data[ i ] + data[ i + 1 ] + data[ i + 2 ];
const mean = sum / ( width * height * 3 );
if ( ! ( mean > 5 ) ) throw new Error( `the image came out empty (mean ${mean.toFixed( 2 )})` );

await sharp( Buffer.from( data.buffer, data.byteOffset, data.byteLength ), { raw: { width, height, channels: 4 } } ).png().toFile( out );
console.log( `${out}: ${width}×${height}, ${samples} samples, mean level ${mean.toFixed( 1 )}` );
