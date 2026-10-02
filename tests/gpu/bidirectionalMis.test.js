/**
 * The bidirectional MIS recursion, composed as the kernels compose it, against the power heuristic from
 * explicit densities, for camera z0 → x1 → x2 → light y0 and its strategies (hit, NEE, connect, light trace):
 * an emitter, a point or directional lamp (no hit), and the environment (at infinity).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { mis, misOnHit, misOnScatter, misPartial, misWeight } from '@/core/TSL/Bidirectional.js';

const CASES = 64;

function random( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( s * 1664525 + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

// Each case: lightPaths, pixelArea, cosCamera, d1 | d2, d3, cIn1, cOut1 | cIn2, cOut2, cL, f1 | r1, f2, r2, areaPdf | neePdf
function makeCases() {

	const r = random( 7 );
	const span = ( lo, hi ) => lo + ( hi - lo ) * r();
	return Array.from( { length: CASES }, () => ( {
		lightPaths: Math.round( span( 1e4, 1e6 ) ), pixelArea: span( 2e-6, 4e-5 ), cosCamera: span( 0.6, 1 ),
		d1: span( 0.5, 6 ), d2: span( 0.2, 4 ), d3: span( 0.3, 5 ),
		cIn1: span( 0.1, 1 ), cOut1: span( 0.1, 1 ), cIn2: span( 0.1, 1 ), cOut2: span( 0.1, 1 ), cL: span( 0.1, 1 ),
		f1: span( 0.05, 4 ), r1: span( 0.05, 4 ), f2: span( 0.05, 4 ), r2: span( 0.05, 4 ),
		areaPdf: span( 0.05, 3 ), neePdf: span( 0.05, 6 ),
	} ) );

}

function expected( c ) {

	const cameraPdfW = 1 / ( c.pixelArea * c.cosCamera ** 3 );
	const camX1 = cameraPdfW * c.cIn1 / c.d1 ** 2;
	const camX2 = c.f1 * c.cIn2 / c.d2 ** 2;
	const camY0 = c.f2 * c.cL / c.d3 ** 2;
	const neeY0 = c.neePdf * c.cL / c.d3 ** 2;
	const lightY0 = c.areaPdf;
	const lightX2 = ( c.cL / Math.PI ) * c.cOut2 / c.d3 ** 2;
	const lightX1 = c.r2 * c.cOut1 / c.d2 ** 2;

	// Relative to the connection x1–x2; light tracing has lightPaths samples per pixel.
	const q = [
		camX2 * camY0 / ( lightY0 * lightX2 ),
		camX2 * neeY0 / ( lightY0 * lightX2 ),
		1,
		c.lightPaths * lightX1 / camX1,
	];
	const sum = q.reduce( ( a, x ) => a + x * x, 0 );
	return q.map( ( x ) => x * x / sum );

}

describeGPU( 'bidirectional MIS', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'weighs the four strategies of a two-bounce path by the power heuristic, summing to one', async () => {

		const cases = makeCases();
		const pack = ( keys ) => new Float32Array( cases.flatMap( ( c ) => keys.map( ( k ) => c[ k ] ) ) );
		const inputs = {
			a: [ pack( [ 'lightPaths', 'pixelArea', 'cosCamera', 'd1' ] ), 'vec4' ],
			b: [ pack( [ 'd2', 'd3', 'cIn1', 'cOut1' ] ), 'vec4' ],
			c: [ pack( [ 'cIn2', 'cOut2', 'cL', 'f1' ] ), 'vec4' ],
			d: [ pack( [ 'r1', 'f2', 'r2', 'areaPdf' ] ), 'vec4' ],
			e: [ pack( [ 'neePdf', 'neePdf', 'neePdf', 'neePdf' ] ), 'vec4' ],
		};

		const out = new Float32Array( await evaluate( renderer, CASES, inputs, 'vec4', ( { a, b, c, d, e } ) => {

			const [ lightPaths, pixelArea, cosCamera, d1 ] = [ a.x, a.y, a.z, a.w ];
			const [ d2, d3, cIn1, cOut1 ] = [ b.x, b.y, b.z, b.w ];
			const [ cIn2, cOut2, cL, f1 ] = [ c.x, c.y, c.z, c.w ];
			const [ r1, f2, r2, areaPdf ] = [ d.x, d.y, d.z, d.w ];
			const neePdf = e.x;

			const emissionPdf = areaPdf.mul( cL ).div( Math.PI );
			const neePdfA = neePdf.mul( cL ).div( d3.mul( d3 ) );

			// Camera subpath, as Generate and Shade carry it.
			const camera = { dVCM: mis( lightPaths.mul( pixelArea ).mul( cosCamera.mul( cosCamera ).mul( cosCamera ) ) ).toVar(), dVC: float( 0 ).toVar() };
			misOnHit( camera, d1, cIn1 );
			const atX1 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };
			misOnScatter( camera, cOut1, f1, r1 );
			misOnHit( camera, d2, cIn2 );
			const atX2 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };
			misOnScatter( camera, cOut2, f2, r2 );
			misOnHit( camera, d3, cL );

			const wHit = misWeight( float( 0 ), mis( neePdfA ).mul( camera.dVCM ).add( mis( emissionPdf ).mul( camera.dVC ) ) );
			const wNEE = misWeight( mis( f2.div( neePdf ) ), misPartial( areaPdf.mul( cOut2 ).div( neePdf.mul( Math.PI ) ), atX2, r2 ) );

			// Light subpath, as LightGenerate and Shade carry it.
			const light = { dVCM: mis( float( 1 ).div( emissionPdf ) ).toVar(), dVC: mis( cL.div( emissionPdf ) ).toVar() };
			light.dVCM.mulAssign( mis( neePdfA ) );
			misOnHit( light, d3, cOut2 );
			const lightAtX2 = { dVCM: light.dVCM.toVar(), dVC: light.dVC.toVar() };
			misOnScatter( light, cIn2, r2, f2 );
			misOnHit( light, d2, cOut1 );

			const dist2 = d2.mul( d2 );
			const wConnect = misWeight(
				misPartial( f1.mul( cIn2 ).div( dist2 ), lightAtX2, f2 ),
				misPartial( r2.mul( cOut1 ).div( dist2 ), atX1, r1 ),
			);

			const cameraPdfW = float( 1 ).div( pixelArea.mul( cosCamera ).mul( cosCamera ).mul( cosCamera ) );
			const wSplat = misWeight( misPartial( cameraPdfW.mul( cIn1 ).div( d1.mul( d1 ) ).div( lightPaths ), light, f1 ), float( 0 ) );

			return vec4( wHit, wNEE, wConnect, wSplat );

		} ) );

		cases.forEach( ( c, i ) => {

			const want = expected( c );
			const got = Array.from( out.subarray( i * 4, i * 4 + 4 ) );
			expect( got[ 0 ] + got[ 1 ] + got[ 2 ] + got[ 3 ] ).toBeCloseTo( 1, 4 );
			got.forEach( ( w, k ) => expect( w ).toBeCloseTo( want[ k ], 4 ) );

		} );

	} );

	// A lamp no camera path can hit: a point (emitting 1/4π a steradian), or a direction at infinity whose light
	// paths start on a disc at `areaPdf` a unit area. NEE picks it with `neePdf`, the source table with `lightPick`.
	for ( const lamp of [ 'point', 'directional' ] ) it( `weighs a ${lamp} lamp's three strategies by the power heuristic, summing to one`, async () => {

		const cases = makeCases().map( ( c, i ) => ( { ...c, lightPick: 0.05 + 0.9 * ( ( i * 37 ) % 64 ) / 64 } ) );
		const pack = ( keys ) => new Float32Array( cases.flatMap( ( c ) => keys.map( ( k ) => c[ k ] ) ) );
		const inputs = {
			a: [ pack( [ 'lightPaths', 'pixelArea', 'cosCamera', 'd1' ] ), 'vec4' ],
			b: [ pack( [ 'd2', 'd3', 'cIn1', 'cOut1' ] ), 'vec4' ],
			c: [ pack( [ 'cIn2', 'cOut2', 'neePdf', 'f1' ] ), 'vec4' ],
			d: [ pack( [ 'r1', 'f2', 'r2', 'areaPdf' ] ), 'vec4' ],
			e: [ pack( [ 'lightPick', 'lightPick', 'lightPick', 'lightPick' ] ), 'vec4' ],
		};
		const atInfinity = lamp === 'directional';

		const out = new Float32Array( await evaluate( renderer, CASES, inputs, 'vec4', ( { a, b, c, d, e } ) => {

			const [ lightPaths, pixelArea, cosCamera, d1 ] = [ a.x, a.y, a.z, a.w ];
			const [ d2, d3, cIn1, cOut1 ] = [ b.x, b.y, b.z, b.w ];
			const [ cIn2, cOut2, neePick, f1 ] = [ c.x, c.y, c.z, c.w ];
			const [ r1, f2, r2, discPdf ] = [ d.x, d.y, d.z, d.w ];
			const lightPick = e.x;
			const emissionPdf = atInfinity ? lightPick.mul( discPdf ) : lightPick.div( 4 * Math.PI );

			const camera = { dVCM: mis( lightPaths.mul( pixelArea ).mul( cosCamera.mul( cosCamera ).mul( cosCamera ) ) ).toVar(), dVC: float( 0 ).toVar() };
			misOnHit( camera, d1, cIn1 );
			const atX1 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };
			misOnScatter( camera, cOut1, f1, r1 );
			misOnHit( camera, d2, cIn2 );
			const atX2 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };

			// Shade's bidirectionalLampNEE: emission density over NEE's, times the cosine at x2.
			const lead = ( atInfinity ? emissionPdf.div( neePick ) : emissionPdf.div( neePick.mul( d3 ).mul( d3 ) ) ).mul( cOut2 );
			const wNEE = misWeight( float( 0 ), misPartial( lead, atX2, r2 ) );

			// LightGenerate's start, then Shade's landing: NEE's pick there, and no distance for a light at infinity.
			const light = { dVCM: mis( float( 1 ).div( emissionPdf ) ).toVar(), dVC: float( 0 ).toVar() };
			light.dVCM.mulAssign( mis( atInfinity ? neePick.div( d3.mul( d3 ) ) : neePick ) );
			misOnHit( light, d3, cOut2 );
			const lightAtX2 = { dVCM: light.dVCM.toVar(), dVC: light.dVC.toVar() };
			misOnScatter( light, cIn2, r2, f2 );
			misOnHit( light, d2, cOut1 );

			const dist2 = d2.mul( d2 );
			const wConnect = misWeight(
				misPartial( f1.mul( cIn2 ).div( dist2 ), lightAtX2, f2 ),
				misPartial( r2.mul( cOut1 ).div( dist2 ), atX1, r1 ),
			);
			const cameraPdfW = float( 1 ).div( pixelArea.mul( cosCamera ).mul( cosCamera ).mul( cosCamera ) );
			const wSplat = misWeight( misPartial( cameraPdfW.mul( cIn1 ).div( d1.mul( d1 ) ).div( lightPaths ), light, f1 ), float( 0 ) );

			return vec4( wNEE, wConnect, wSplat, float( 0 ) );

		} ) );

		cases.forEach( ( c, i ) => {

			const camX1 = c.cIn1 / ( c.pixelArea * c.cosCamera ** 3 * c.d1 ** 2 );
			const camX2 = c.f1 * c.cIn2 / c.d2 ** 2;
			const lightX2 = atInfinity ? c.lightPick * c.areaPdf * c.cOut2 : c.lightPick / ( 4 * Math.PI ) * c.cOut2 / c.d3 ** 2;
			const lightX1 = c.r2 * c.cOut1 / c.d2 ** 2;
			// Relative to the connection; NEE takes the lamp itself with its pick, as light tracing's x2 takes it whole.
			const q = [ camX2 * c.neePdf / lightX2, 1, c.lightPaths * lightX1 / camX1 ];
			const sum = q.reduce( ( s, x ) => s + x * x, 0 );
			const got = Array.from( out.subarray( i * 4, i * 4 + 3 ) );
			expect( got[ 0 ] + got[ 1 ] + got[ 2 ] ).toBeCloseTo( 1, 4 );
			got.forEach( ( w, k ) => expect( w ).toBeCloseTo( q[ k ] * q[ k ] / sum, 4 ) );

		} );

	} );

	// The environment: a light at infinity the camera path hits, drawn by NEE and light paths with `neePdf` a steradian;
	// light paths start on a disc at `areaPdf` a unit area, with the source table's `lightPick`.
	it( 'weighs an environment path\'s four strategies by the power heuristic, summing to one', async () => {

		const cases = makeCases().map( ( c, i ) => ( { ...c, lightPick: 0.05 + 0.9 * ( ( i * 37 ) % 64 ) / 64 } ) );
		const pack = ( keys ) => new Float32Array( cases.flatMap( ( c ) => keys.map( ( k ) => c[ k ] ) ) );
		const inputs = {
			a: [ pack( [ 'lightPaths', 'pixelArea', 'cosCamera', 'd1' ] ), 'vec4' ],
			b: [ pack( [ 'd2', 'd3', 'cIn1', 'cOut1' ] ), 'vec4' ],
			c: [ pack( [ 'cIn2', 'cOut2', 'neePdf', 'f1' ] ), 'vec4' ],
			d: [ pack( [ 'r1', 'f2', 'r2', 'areaPdf' ] ), 'vec4' ],
			e: [ pack( [ 'lightPick', 'lightPick', 'lightPick', 'lightPick' ] ), 'vec4' ],
		};

		const out = new Float32Array( await evaluate( renderer, CASES, inputs, 'vec4', ( { a, b, c, d, e } ) => {

			const [ lightPaths, pixelArea, cosCamera, d1 ] = [ a.x, a.y, a.z, a.w ];
			const [ d2, d3, cIn1, cOut1 ] = [ b.x, b.y, b.z, b.w ];
			const [ cIn2, cOut2, directionPdf, f1 ] = [ c.x, c.y, c.z, c.w ];
			const [ r1, f2, r2, discPdf ] = [ d.x, d.y, d.z, d.w ];
			const lightPick = e.x;
			const emissionPdf = lightPick.mul( directionPdf ).mul( discPdf );

			const camera = { dVCM: mis( lightPaths.mul( pixelArea ).mul( cosCamera.mul( cosCamera ).mul( cosCamera ) ) ).toVar(), dVC: float( 0 ).toVar() };
			misOnHit( camera, d1, cIn1 );
			const atX1 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };
			misOnScatter( camera, cOut1, f1, r1 );
			misOnHit( camera, d2, cIn2 );
			const atX2 = { dVCM: camera.dVCM.toVar(), dVC: camera.dVC.toVar() };
			misOnScatter( camera, cOut2, f2, r2 );

			// Shade's miss branch and bidirectionalEnvironmentNEE.
			const wHit = misWeight( float( 0 ), mis( directionPdf ).mul( camera.dVCM ).add( mis( emissionPdf ).mul( camera.dVC ) ) );
			const wNEE = misWeight( mis( f2.div( directionPdf ) ), misPartial( lightPick.mul( discPdf ).mul( cOut2 ), atX2, r2 ) );

			// LightGenerate's environment start, then Shade's landing, which undoes misOnHit's distance.
			const light = { dVCM: mis( directionPdf.div( emissionPdf ) ).toVar(), dVC: mis( float( 1 ).div( emissionPdf ) ).toVar() };
			light.dVCM.mulAssign( mis( float( 1 ).div( d3.mul( d3 ) ) ) );
			misOnHit( light, d3, cOut2 );
			const lightAtX2 = { dVCM: light.dVCM.toVar(), dVC: light.dVC.toVar() };
			misOnScatter( light, cIn2, r2, f2 );
			misOnHit( light, d2, cOut1 );

			const dist2 = d2.mul( d2 );
			const wConnect = misWeight(
				misPartial( f1.mul( cIn2 ).div( dist2 ), lightAtX2, f2 ),
				misPartial( r2.mul( cOut1 ).div( dist2 ), atX1, r1 ),
			);
			const cameraPdfW = float( 1 ).div( pixelArea.mul( cosCamera ).mul( cosCamera ).mul( cosCamera ) );
			const wSplat = misWeight( misPartial( cameraPdfW.mul( cIn1 ).div( d1.mul( d1 ) ).div( lightPaths ), light, f1 ), float( 0 ) );

			return vec4( wHit, wNEE, wConnect, wSplat );

		} ) );

		cases.forEach( ( c, i ) => {

			const camX1 = c.cIn1 / ( c.pixelArea * c.cosCamera ** 3 * c.d1 ** 2 );
			const camX2 = c.f1 * c.cIn2 / c.d2 ** 2;
			// Area at x2 with the direction: the light path's, against which the others are measured.
			const lightX2 = c.lightPick * c.neePdf * c.areaPdf * c.cOut2;
			const lightX1 = c.r2 * c.cOut1 / c.d2 ** 2;
			const q = [ camX2 * c.f2 / lightX2, camX2 * c.neePdf / lightX2, 1, c.lightPaths * lightX1 / camX1 ];
			const sum = q.reduce( ( s, x ) => s + x * x, 0 );
			const got = Array.from( out.subarray( i * 4, i * 4 + 4 ) );
			expect( got[ 0 ] + got[ 1 ] + got[ 2 ] + got[ 3 ] ).toBeCloseTo( 1, 4 );
			got.forEach( ( w, k ) => expect( w ).toBeCloseTo( q[ k ] * q[ k ] / sum, 4 ) );

		} );

	} );

} );
