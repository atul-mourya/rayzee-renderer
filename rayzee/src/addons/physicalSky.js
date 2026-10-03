/**
 * The physical sky — `rayzee/addons/physical-sky`: Bruneton's atmosphere baked on the GPU for environment mode
 * 'procedural', with its importance-sampling table and analytic sun. PathTracerApp installs it itself; on the renderer
 * core, install it once:
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { PhysicalSky } from 'rayzee/addons/physical-sky';
 *
 * renderer.environmentManager.setProceduralSky( PhysicalSky );
 * await renderer.environmentManager.setMode( 'procedural' );
 */

export { PhysicalSky } from '../Processor/PhysicalSky.js';
