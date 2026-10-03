/**
 * The renderer core (`rayzee/core`) imports nothing from the layers above it. Walks the static imports
 * from its entry and fails on any module the viewer or a capability owns. See docs/CORE_AND_ADDONS.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../../rayzee/src' );

// Static `import … from '…'` and `export … from '…'`, not `import( … )`.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function reachable( entry ) {

	const seen = new Set();
	const queue = [ resolve( SRC, entry ) ];
	while ( queue.length ) {

		const file = queue.pop();
		if ( seen.has( file ) ) continue;
		seen.add( file );
		const text = readFileSync( file, 'utf8' );
		for ( const [ , spec ] of text.matchAll( STATIC_IMPORT ) ) {

			if ( ! spec.startsWith( '.' ) ) continue;
			let target = resolve( dirname( file ), spec.split( '?' )[ 0 ] );
			if ( ! existsSync( target ) && existsSync( target + '.js' ) ) target += '.js';
			queue.push( target );

		}

	}

	return [ ...seen ].map( f => relative( SRC, f ) );

}

const ABOVE_THE_CORE = [
	/^PathTracerApp\.js$/,
	/^Headless\.js$/,
	/^Stages\/(NormalDepth|MotionVector|ASVGF|NRD|Variance|BilateralFilter|EdgeFilter|AutoExposure)\.js$/,
	/^managers\/(CameraManager|InteractionManager|TransformManager|OverlayManager|AnimationManager|DenoisingManager|GoboManager|IESManager|VideoRenderManager|WalkControls)\.js$/,
	/^managers\/(timeline|helpers)\//,
	/^Passes\//,
	/^neural\//,
	/^SceneState\/SceneState\.js$/,
];

describe( 'the renderer core', () => {

	const modules = reachable( 'core.js' );

	it( 'reaches the path tracer and the compositor', () => {

		expect( modules ).toContain( 'RayzeeRenderer.js' );
		expect( modules ).toContain( 'Stages/PathTracer.js' );
		expect( modules ).toContain( 'Stages/Compositor.js' );

	} );

	it( 'imports no denoiser, camera controls, gizmo, overlay, timeline or viewer', () => {

		const leaks = modules.filter( m => ABOVE_THE_CORE.some( rule => rule.test( m ) ) );
		expect( leaks ).toEqual( [] );

	} );

	it( 'is what the full entry builds on', () => {

		expect( reachable( 'index.js' ) ).toEqual( expect.arrayContaining( [ 'RayzeeRenderer.js', 'PathTracerApp.js' ] ) );

	} );

} );
