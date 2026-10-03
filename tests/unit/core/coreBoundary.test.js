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
	/^addons\//,
	/^(Processor\/(PhysicalSky|AtmosphereModel)|TSL\/(Atmosphere|EnvironmentCDF))\.js$/,
	/^Processor\/(ArchiveImporter|ArchiveReader|ArchiveCache|ZipReader)\.js$/,
	/^Processor\/PBRT\//,
	/^Storage\/SceneGraphCodec\.js$/,
	/^integrators\//,
	/^Color\/(ColorManagement|OcioViews|OcioRuntime|LutBake|ColorSpaces|InputColorSpaces|BakedViews|Displays)\.js$/,
	/^TSL\/(Bidirectional|BidirectionalLamps|LightGenerateKernel|ConnectKernel|LightSplatKernel|MergeKernel|LightGuide)\.js$/,
];

// What a capability may not reach: the viewer, or another capability.
const VIEWER = ABOVE_THE_CORE.slice( 0, 8 );

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

	it( 'leaves the physical sky to its add-on, which reaches no viewer code', () => {

		const sky = reachable( 'addons/physicalSky.js' );
		expect( sky ).toContain( 'Processor/PhysicalSky.js' );
		expect( sky.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves archives and pbrt to their add-on, which reaches no viewer code', () => {

		const archives = reachable( 'addons/archives.js' );
		expect( archives ).toEqual( expect.arrayContaining( [ 'Processor/ArchiveImporter.js', 'Processor/PBRT/index.js' ] ) );
		expect( archives.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves bidirectional and vertex merging to their add-on, which reaches no viewer code', () => {

		const bidirectional = reachable( 'addons/bidirectional.js' );
		expect( bidirectional ).toEqual( expect.arrayContaining( [ 'integrators/BidirectionalIntegrator.js', 'TSL/ConnectKernel.js' ] ) );
		expect( bidirectional.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'leaves the OCIO pipeline to its add-on, which reaches no viewer code', () => {

		const color = reachable( 'addons/color.js' );
		expect( color ).toEqual( expect.arrayContaining( [ 'Color/ColorManagement.js', 'Color/OcioRuntime.js' ] ) );
		expect( color.filter( m => VIEWER.some( rule => rule.test( m ) ) ) ).toEqual( [] );

	} );

	it( 'is what the full entry builds on', () => {

		expect( reachable( 'index.js' ) ).toEqual( expect.arrayContaining( [ 'RayzeeRenderer.js', 'PathTracerApp.js' ] ) );

	} );

} );
