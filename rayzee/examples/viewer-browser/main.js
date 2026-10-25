/**
 * The full engine in a page — `rayzee`, the viewer: camera controls, denoisers, every add-on — loading a model and a
 * sky, then denoising the finished image with OIDN.
 *
 *   npm run example:viewer          # from the repository root, then open the printed URL
 */

import { PathTracerApp, EngineEvents } from 'rayzee';

const canvas = document.querySelector( 'canvas' );
const status = document.querySelector( '#status' );

const engine = new PathTracerApp( canvas );
// What the engine works around instead of failing on: an unknown setting, a missing add-on, …
engine.addEventListener( EngineEvents.ISSUE, ( { issue } ) => console.warn( `rayzee: ${issue.message}` ) );
await engine.init();
await engine.loadModel( 'https://assets.rayzee.atulmourya.com/models/CornellBox1.glb' );
await engine.loadEnvironment( 'https://assets.rayzee.atulmourya.com/hdri/Polyhaven/raw/adams_place_bridge_1k.hdr' );

engine.settings.setMany( { maxBounces: 8, exposure: 1 } );

// OIDN denoises the image once it has converged (needs the optional oidn-webgpu package).
engine.denoisingManager.setOIDNEnabled( true );
engine.denoisingManager.setOIDNQuality( 'balance' ); // 'fast' | 'fast-clean' | 'balance' | 'high'

engine.addEventListener( EngineEvents.FRAME, () => {

	status.textContent = `${engine.getFrameCount()} samples`;

} );
engine.addEventListener( EngineEvents.DENOISING_START, () => {

	status.textContent = 'denoising…';

} );
engine.addEventListener( EngineEvents.DENOISING_END, () => {

	status.textContent = `${engine.getFrameCount()} samples · denoised`;

} );

// The engine sizes itself from the canvas's CSS size.
window.addEventListener( 'resize', () => engine.onResize() );

engine.animate();
