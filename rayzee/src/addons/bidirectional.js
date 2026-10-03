/**
 * Bidirectional path tracing and vertex merging — `rayzee/addons/bidirectional`: the path tracer's 'bidirectional'
 * and 'vcm' integrators. PathTracerApp registers them itself; on the renderer core, register them once:
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { BidirectionalIntegrator } from 'rayzee/addons/bidirectional';
 *
 * renderer.stages.pathTracer.registerIntegrator( [ 'bidirectional', 'vcm' ], pt => new BidirectionalIntegrator( pt ) );
 * renderer.settings.set( 'integrator', 'bidirectional' );
 */

export { BidirectionalIntegrator } from '../integrators/BidirectionalIntegrator.js';
