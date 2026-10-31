import { describe, it, expect, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { BidirectionalIntegrator } from '@/core/addons/bidirectional/BidirectionalIntegrator.js';
import { SOURCE, STRATEGY, STRATEGY_ALONE, PASS_TAG_BIT } from '@/core/addons/bidirectional/Bidirectional.js';
import { GUIDE_BINS, GUIDE_ROW_STRIDE, GUIDE_TEXTURE_WIDTH } from '@/core/addons/bidirectional/LightGuide.js';
import { LIGHT_FLOATS } from '@/core/pathtracer/UniformManager.js';
import { LIGHT_VERTEX_STRIDE } from '@/core/pathtracer/PackedRayBuffer.js';
import { CAMERA_PROJECTION_IDS } from '@/core/EngineDefaults.js';

const CAPACITY = 16;
const MB = 1024 * 1024;
const VERTEX_BYTES = LIGHT_VERTEX_STRIDE * 16;

function perspective() {

	const camera = new PerspectiveCamera( 60, 2, 0.1, 100 );
	camera.position.set( 1, 2, 3 );
	camera.lookAt( 0, 0, 0 );
	camera.updateMatrixWorld();
	return camera;

}

function disposals( ...attrs ) {

	const disposed = [];
	for ( const attr of attrs ) attr.addEventListener( 'dispose', () => void disposed.push( attr ) );
	return disposed;

}

function pathTracer( { camera = perspective(), width = 64, height = 32, ...extra } = {} ) {

	const dispatched = [];
	const sized = [];
	const lists = {};
	for ( const type of [ 'directional', 'area', 'point', 'spot' ] ) lists[ `${type}LightsBufferNode` ] = { array: new Float32Array( CAPACITY * LIGHT_FLOATS[ type ] ) };

	return {
		dispatched,
		sized,
		renderer: {},
		...lists,
		numDirectionalLights: { value: 0 }, numAreaLights: { value: 0 }, numPointLights: { value: 0 }, numSpotLights: { value: 0 },
		enableEnvironment: { value: 1 },
		environment: { exactTable: null },
		environmentIntensity: { value: 1 },
		hasSun: { value: 0 },
		sunRadiance: { value: new Vector3( 1, 1, 1 ) },
		sunParams: { value: new Vector4( 0.9999, 6.8e-5, 0, 0 ) },
		emissiveTriangleCount: { value: 0 }, emissiveBoost: { value: 1 }, emissiveTotalPower: { value: 0 },
		_wfRenderWidth: { value: width }, _wfRenderHeight: { value: height },
		maxBounces: { value: 3 },
		_bounceLoopBound: () => 3,
		_packedBuffers: { capacity: 1 << 20 },
		cameraWorldMatrix: { value: camera.matrixWorld },
		cameraProjectionMatrix: { value: camera.projectionMatrix },
		cameraProjection: { value: camera.isOrthographicCamera ? CAMERA_PROJECTION_IDS.orthographic : CAMERA_PROJECTION_IDS.perspective },
		enableDOF: { value: 0 },
		frameCount: 0,
		_kernelManager: {
			dispatch: ( name ) => void dispatched.push( name ),
			setDispatchForCount: ( name, count ) => void sized.push( [ name, count ] ),
		},
		_wfChunkRowBase: { value: 9 }, _wfMaxRayCount: { value: 0 }, _wfCurrentBounce: { value: 0 },
		_useDynamicDispatch: false,
		_bounceEarlyExitThreshold: - 1,
		_sortMaterials: false,
		bounceKernels: [ 'extend', 'shade' ],
		reset: vi.fn(),
		...extra,
	};

}

let pt;

function integrator( options ) {

	pt = pathTracer( options );
	const bd = new BidirectionalIntegrator( pt );
	bd.cacheBytes( 4096 * MB, 64 * 1024 * MB );
	bd.beforeKernelBuild();
	return bd;

}

function lamp( type, values ) {

	const count = pt[ `num${type[ 0 ].toUpperCase()}${type.slice( 1 )}Lights` ];
	pt[ `${type}LightsBufferNode` ].array.set( values, count.value * LIGHT_FLOATS[ type ] );
	count.value ++;

}

const point = ( intensity = 1, color = [ 1, 1, 1 ] ) => lamp( 'point', [ 0, 0, 0, ...color, intensity ] );
const spot = ( angle, intensity = 1 ) => lamp( 'spot', [ 0, 0, 0, 0, - 1, 0, 1, 1, 1, intensity, angle ] );
const area = ( u, v, { intensity = 1, normalize = 0, shape = 0 } = {} ) => lamp( 'area', [ 0, 0, 0, ...u, ...v, 1, 1, 1, intensity, normalize, 0, shape ] );
const directional = ( intensity = 1 ) => lamp( 'directional', [ 0, 1, 0, 1, 1, 1, intensity, 0 ] );

// Each source's chance, as the shaders take it: the stored running sum, differenced.
function chances( bd ) {

	const cdf = bd.uniforms.sourceCdf.array;
	return Array.from( cdf, ( c, i ) => c - ( i > 0 ? cdf[ i - 1 ] : 0 ) );

}

const lampChance = ( bd, type, i ) => chances( bd )[ bd.uniforms.sourceOffsets[ [ 'directional', 'area', 'point', 'spot' ].indexOf( type ) ] + i ];

function withBounds( bd, min = [ - 1, - 1, - 1 ], max = [ 1, 1, 1 ] ) {

	bd._visibleSceneBounds = () => ( { min, max } );
	return bd;

}

describe( 'where light paths start', () => {

	it( 'starts none when nothing emits, and the frame runs as the path tracer\'s own', () => {

		const bd = integrator();
		expect( bd.beginFrame( 3 ) ).toBe( false );
		expect( bd.uniforms.lightPaths.value ).toBe( 0 );
		expect( bd.uniforms.lightTrace.value ).toBe( 0 );
		expect( pt.dispatched ).toEqual( [] );
		expect( pt._wfChunkRowBase.value ).toBe( 9 );

	} );

	it( 'lays the lamp lists out after the fixed sources, by their capacity', () => {

		const bd = integrator();
		expect( bd.uniforms.sourceOffsets ).toEqual( [ SOURCE.LAMPS, SOURCE.LAMPS + CAPACITY, SOURCE.LAMPS + 2 * CAPACITY, SOURCE.LAMPS + 3 * CAPACITY ] );
		expect( bd.uniforms.sourceCount ).toBe( SOURCE.LAMPS + 4 * CAPACITY );
		expect( bd.uniforms.sourceCdf.array ).toHaveLength( SOURCE.LAMPS + 4 * CAPACITY );

		const table = bd.uniforms.sourceCdf.array;
		bd.beforeKernelBuild();
		expect( bd.uniforms.sourceCdf.array ).toBe( table );

	} );

	it( 'gives a point light its flux all round and a spot only its cone\'s', () => {

		const bd = integrator();
		point();
		spot( Math.PI / 2 );
		bd.beginFrame( 3 );

		expect( lampChance( bd, 'point', 0 ) ).toBeCloseTo( 2 / 3, 6 );
		expect( lampChance( bd, 'spot', 0 ) ).toBeCloseTo( 1 / 3, 6 );

	} );

	it( 'weighs area lights by size unless their power is normalised, a disc at π/4 of its square', () => {

		const bd = integrator();
		area( [ 1, 0, 0 ], [ 0, 1, 0 ] );
		area( [ 2, 0, 0 ], [ 0, 1, 0 ] );
		area( [ 1, 0, 0 ], [ 0, 1, 0 ], { shape: 1 } );
		bd.beginFrame( 3 );

		const total = 4 + 8 + Math.PI;
		expect( [ 0, 1, 2 ].map( i => lampChance( bd, 'area', i ) ) ).toEqual( [ 4 / total, 8 / total, Math.PI / total ].map( p => expect.closeTo( p, 6 ) ) );

		const normalised = integrator();
		area( [ 1, 0, 0 ], [ 0, 1, 0 ], { normalize: 1 } );
		area( [ 2, 0, 0 ], [ 0, 1, 0 ], { normalize: 1 } );
		normalised.beginFrame( 3 );
		expect( lampChance( normalised, 'area', 0 ) ).toBeCloseTo( 0.5, 6 );

	} );

	it( 'counts negative intensities and flat area lights as nothing', () => {

		const bd = integrator();
		point( - 5 );
		area( [ 0, 0, 0 ], [ 0, 1, 0 ] );
		point( 1 );
		bd.beginFrame( 3 );

		expect( lampChance( bd, 'point', 0 ) ).toBe( 0 );
		expect( lampChance( bd, 'area', 0 ) ).toBe( 0 );
		expect( lampChance( bd, 'point', 1 ) ).toBe( 1 );

	} );

	it( 'weighs emitters by their boosted power, and ends the table on exactly one', () => {

		const bd = integrator();
		Object.assign( pt, { emissiveTriangleCount: { value: 6 }, emissiveTotalPower: { value: 2 }, emissiveBoost: { value: 1.5 } } );
		point( 1 );
		point( 1, [ 0.3, 0.7, 0.1 ] );
		bd.beginFrame( 3 );

		const emitters = Math.PI * 1.5 * 2;
		const dim = 4 * Math.PI * ( 0.2126 * 0.3 + 0.7152 * 0.7 + 0.0722 * 0.1 );
		expect( bd.uniforms.emitterPick.value ).toBeCloseTo( emitters / ( emitters + 4 * Math.PI + dim ), 6 );
		expect( bd.uniforms.emitterPick.value ).toBe( Math.fround( chances( bd )[ SOURCE.EMITTERS ] ) );
		expect( bd.uniforms.sourceCdf.array.at( - 1 ) ).toBe( 1 );

	} );

	it( 'gives a sun alone every light path, and none in a scene with nothing to light', () => {

		const bd = withBounds( integrator() );
		pt.hasSun.value = 1;
		expect( bd.beginFrame( 3 ) ).toBe( true );
		expect( bd.uniforms.sunPick.value ).toBe( 1 );
		expect( bd.uniforms.sceneCenter.value.toArray() ).toEqual( [ 0, 0, 0 ] );
		expect( bd.uniforms.sceneRadius.value ).toBeCloseTo( Math.sqrt( 3 ), 6 );

		bd._visibleSceneBounds = () => null;
		expect( bd.beginFrame( 3 ) ).toBe( false );

		bd._visibleSceneBounds = () => ( { min: [ 0, 0, 0 ], max: [ 0, 0, 0 ] } );
		expect( bd.beginFrame( 3 ) ).toBe( false );

	} );

	it( 'gives a light at infinity a share of light paths that grows with the scene it crosses', () => {

		const share = ( size ) => {

			const bd = withBounds( integrator(), [ 0, 0, 0 ], [ size, size, size ] );
			pt.hasSun.value = 1;
			pt.sunRadiance.value.set( 1e5, 1e5, 1e5 );
			point( 1 );
			bd.beginFrame( 3 );
			return bd.uniforms.sunPick.value;

		};

		expect( share( 1 ) ).toBeGreaterThan( 0 );
		expect( share( 10 ) ).toBeGreaterThan( share( 1 ) );

	} );

	it( 'starts nothing at the environment or the sun while the environment is off', () => {

		const bd = withBounds( integrator() );
		pt.environment.exactTable = { radianceIntegral: 3 };
		pt.hasSun.value = 1;
		pt.enableEnvironment.value = 0;
		expect( bd.beginFrame( 3 ) ).toBe( false );
		expect( bd.uniforms.envTable.value ).toBe( 1 );

		pt.enableEnvironment.value = 1;
		pt.hasSun.value = 0;
		expect( bd.beginFrame( 3 ) ).toBe( true );
		expect( bd.uniforms.envPick.value ).toBe( 1 );

	} );

	it( 'starts directional lamps on the scene\'s disc too', () => {

		const bd = withBounds( integrator() );
		pt.enableEnvironment.value = 0;
		directional( 2 );
		expect( bd.beginFrame( 3 ) ).toBe( true );
		expect( lampChance( bd, 'directional', 0 ) ).toBe( 1 );

	} );

} );

describe( 'a frame\'s light pass', () => {

	function lit( options ) {

		const bd = integrator( options );
		point();
		return bd;

	}

	it( 'traces half a light path a pixel, within the path pool and the light vertex cache', () => {

		const bd = lit();
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightPaths.value ).toBe( 64 * 32 / 2 );
		expect( bd.uniforms.slotsPerPath.value ).toBe( 4 );
		expect( pt._wfMaxRayCount.value ).toBe( 1024 );
		expect( pt._wfChunkRowBase.value ).toBe( 0 );
		expect( pt.sized[ 0 ] ).toEqual( [ 'lightGenerate', 1024 ] );

		pt._packedBuffers.capacity = 300;
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightPaths.value ).toBe( 300 );

		bd.cacheBytes( 4096 * MB, 100 * VERTEX_BYTES / 0.05 );
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightPaths.value ).toBe( 25 );

	} );

	it( 'reads the camera from its world matrix, and a pixel\'s area on the image plane a unit away', () => {

		const camera = perspective();
		const bd = integrator( { camera } );
		point();
		bd.beginFrame( 3 );

		expect( bd.uniforms.cameraPosition.value.toArray() ).toEqual( [ 1, 2, 3 ] );
		const forward = camera.getWorldDirection( new Vector3() );
		expect( bd.uniforms.cameraForward.value.distanceTo( forward ) ).toBeLessThan( 1e-6 );
		const half = Math.tan( Math.PI / 6 );
		expect( bd.uniforms.pixelArea.value ).toBeCloseTo( ( 2 * half * 2 ) * ( 2 * half ) / ( 64 * 32 ), 10 );

	} );

	it( 'tags every frame\'s light paths, wrapping before the tag runs out of bits', () => {

		const bd = lit();
		bd.beginFrame( 3 );
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightTag.value ).toBe( 2 );
		bd._lightTag = ( 1 << 24 ) - 1;
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightTag.value ).toBe( 1 );

	} );

	it( 'traces light to the camera only through a pinhole', () => {

		const bd = lit();
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightTrace.value ).toBe( 1 );
		expect( pt.dispatched ).toContain( 'lightSplat' );
		bd.resolve( pt._kernelManager );
		expect( pt.dispatched.at( - 1 ) ).toBe( 'splatResolve' );

		pt.dispatched.length = 0;
		pt.enableDOF.value = 1;
		bd.beginFrame( 3 );
		expect( bd.uniforms.lightTrace.value ).toBe( 0 );
		bd.resolve( pt._kernelManager );
		expect( pt.dispatched ).not.toContain( 'lightSplat' );
		expect( pt.dispatched ).not.toContain( 'splatResolve' );

		const ortho = integrator( { camera: new OrthographicCamera( - 1, 1, 1, - 1 ) } );
		point();
		ortho.beginFrame( 3 );
		expect( ortho.uniforms.lightTrace.value ).toBe( 0 );

	} );

	it( 'runs every bounce at full size without a survivor curve', () => {

		const bd = lit();
		bd.beginFrame( 3 );

		expect( pt.dispatched.filter( k => k === 'extend' ) ).toHaveLength( 4 );
		expect( pt.dispatched.filter( k => k === 'enterFull' ) ).toHaveLength( 4 );
		expect( pt.dispatched.filter( k => k === 'lightSnapshot' ) ).toHaveLength( 4 );
		expect( pt.sized.filter( ( [ k ] ) => k === 'extend' ).map( ( [ , n ] ) => n ) ).toEqual( [ 1024, 1024, 1024, 1024 ] );
		expect( pt._wfCurrentBounce.value ).toBe( 3 );
		expect( pt.sized ).toContainEqual( [ 'lightSplat', 1024 * 4 ] );

	} );

	it( 'sizes each bounce from its last survivor curve, and ends where that curve\'s energy runs out', () => {

		const bd = lit( { width: 256, height: 128 } );
		Object.assign( pt, { _useDynamicDispatch: true, _bounceEarlyExitThreshold: 0.01 } );
		bd.beginFrame( 3 );
		const exit = 0.01 * 16384 * 64;
		bd.applyLightCurve( [ 100, 40, 0, 0 ], [ exit * 10, exit / 2, 0, 0 ], bd.curveKey );

		pt.dispatched.length = 0;
		pt.sized.length = 0;
		bd.beginFrame( 3 );

		expect( pt.dispatched.filter( k => k === 'extend' ) ).toHaveLength( 2 );
		expect( pt.dispatched ).not.toContain( 'enterFull' );
		expect( pt.dispatched ).toContain( 'lightCopyback' );
		expect( pt.sized.filter( ( [ k ] ) => k === 'shade' ).map( ( [ , n ] ) => n ) ).toEqual( [ 16384, 100 * 1.5 + 1024 ] );

	} );

	it( 'drops a survivor curve measured for other light paths', () => {

		const bd = lit();
		pt._bounceEarlyExitThreshold = 0.01;
		bd.beginFrame( 3 );
		bd.applyLightCurve( [ 1, 0, 0, 0 ], [ 0, 0, 0, 0 ], bd.curveKey );
		bd.select( 'bidirectional' );

		pt.dispatched.length = 0;
		bd.beginFrame( 3 );
		expect( pt.dispatched.filter( k => k === 'extend' ) ).toHaveLength( 4 );

	} );

	it( 'sorts by material when the camera loop does', () => {

		const bd = lit( { _sortMaterials: true } );
		bd.beginFrame( 0 );
		expect( pt.dispatched.slice( pt.dispatched.indexOf( 'extend' ) + 1, pt.dispatched.indexOf( 'shade' ) ) )
			.toEqual( [ 'resetGlobalHist', 'globalHist', 'globalPrefix', 'globalScatter' ] );

	} );

	it( 'files its light vertices for merging under vcm, and merges after each Shade', () => {

		const bd = lit();
		bd.afterShade( pt._kernelManager );
		expect( pt.dispatched ).toEqual( [ 'connect' ] );

		bd.select( 'vcm' );
		pt.dispatched.length = 0;
		bd.beginFrame( 3 );
		expect( pt.dispatched.slice( - 2 ) ).toEqual( [ 'mergeClear', 'mergeInsert' ] );
		expect( pt.sized.at( - 1 ) ).toEqual( [ 'mergeInsert', 1024 * 4 ] );
		pt.dispatched.length = 0;
		bd.afterShade( pt._kernelManager );
		expect( pt.dispatched ).toEqual( [ 'connect', 'merge' ] );

	} );

	it( 'gives every Shade a fresh pass tag with the high bit set, wrapping within 31 bits', () => {

		const bd = lit();
		bd.beforeShade();
		const first = bd.uniforms.passTag.value;
		bd.beforeShade();
		expect( bd.uniforms.passTag.value ).not.toBe( first );
		expect( ( bd.uniforms.passTag.value & PASS_TAG_BIT ) >>> 0 ).toBe( PASS_TAG_BIT );

		bd._passTag = 0x7FFFFFFF;
		bd.beforeShade();
		expect( bd.uniforms.passTag.value ).toBe( PASS_TAG_BIT );

	} );

} );

describe( 'the light guide', () => {

	function guided() {

		const copies = [];
		const bd = integrator();
		point();
		Object.assign( pt.renderer, {
			initTexture: vi.fn(),
			backend: {
				get: ( resource ) => ( { buffer: { of: resource }, texture: { of: resource } } ),
				device: {
					createCommandEncoder: () => ( { copyBufferToTexture: ( ...args ) => copies.push( args ), finish: () => 'commands' } ),
					queue: { submit: vi.fn() },
				},
			},
		} );
		bd.allocate( 64 * 32 );
		return { bd, copies };

	}

	const builds = ( bd, frames ) => frames.filter( ( f ) => {

		pt.frameCount = f;
		pt.dispatched.length = 0;
		bd.beginFrame( 3 );
		return pt.dispatched.includes( 'guideBuild' );

	} );

	it( 'forgets its counts on a restart', () => {

		const { bd } = guided();
		bd.uniforms.guide.value = 1;
		bd.beginFrame( 3 );
		expect( pt.dispatched[ 0 ] ).toBe( 'guideClear' );
		expect( bd.uniforms.guide.value ).toBe( 0 );

	} );

	it( 'rebuilds its table at frames 1, 2, 4 … 32, then every 32nd', () => {

		const { bd } = guided();
		const frames = Array.from( { length: 100 }, ( _, i ) => i + 1 );
		expect( builds( bd, frames ) ).toEqual( [ 1, 2, 4, 8, 16, 32, 64, 96 ] );

	} );

	it( 'copies the built table into the texture Shade reads, then turns it on', () => {

		const { bd, copies } = guided();
		pt.frameCount = 1;
		bd.beginFrame( 3 );

		const [[ source, destination, size ]] = copies;
		expect( source.bytesPerRow ).toBe( GUIDE_ROW_STRIDE * 4 );
		expect( source.bytesPerRow % 256 ).toBe( 0 );
		expect( source.buffer.of ).toBe( bd._guideBuildAttr );
		expect( destination.texture.of ).toBe( bd._guideTexture );
		expect( size ).toEqual( [ GUIDE_TEXTURE_WIDTH, GUIDE_BINS ] );
		expect( pt.renderer.backend.device.queue.submit ).toHaveBeenCalledWith( [ 'commands' ] );
		expect( bd.uniforms.guide.value ).toBe( 1 );

	} );

	it( 'turned off, restarts the render and neither learns nor builds', () => {

		const { bd } = guided();
		bd.setLightGuiding( false );
		expect( pt.reset ).toHaveBeenCalledOnce();
		expect( builds( bd, [ 1, 2, 32 ] ) ).toEqual( [] );
		expect( bd.uniforms.guideLearning.value ).toBe( 0 );

		bd.setLightGuiding( true );
		expect( builds( bd, [ 1 ] ) ).toEqual( [ 1 ] );
		expect( bd.uniforms.guideLearning.value ).toBe( 1 );

	} );

} );

describe( 'its buffers', () => {

	it( 'gives the light vertex cache the least of 256 MB, 45 % of a binding and 5 % of the device, in whole vertices', () => {

		const bd = new BidirectionalIntegrator( pathTracer() );
		expect( bd.cacheBytes( 4096 * MB, 64 * 1024 * MB ) ).toBe( 256 * MB );
		expect( bd.lightVertices ).toBe( 256 * MB / VERTEX_BYTES );
		expect( bd.cacheBytes( 100 * MB, 64 * 1024 * MB ) ).toBe( Math.floor( 45 * MB / VERTEX_BYTES ) * VERTEX_BYTES );
		expect( bd.cacheBytes( 4096 * MB, 1000 * VERTEX_BYTES + 1 ) ).toBe( 50 * VERTEX_BYTES );
		expect( bd.describe() ).toBe( 'bidirectional: 50 light vertex slots' );

	} );

	it( 'keeps a splat image of three counters a pixel, grown only when the frame is larger', () => {

		const bd = integrator();
		expect( bd.gpuResources() ).toBeNull();
		bd.allocate( 100 );
		const splat = bd._splatAttr;
		const disposed = disposals( splat );
		expect( splat.count ).toBe( 300 );
		expect( bd.gpuResources() ).toEqual( [ splat ] );

		bd.allocate( 50 );
		expect( bd._splatAttr ).toBe( splat );
		bd.allocate( 200 );
		expect( bd._splatAttr.count ).toBe( 600 );
		expect( disposed ).toContain( splat );

	} );

	it( 'gives vertex merging a power-of-two hash over the cache, and frees it without merging', () => {

		const bd = integrator();
		bd.cacheBytes( 4096 * MB, 3000 * VERTEX_BYTES / 0.05 );
		bd.select( 'vcm' );
		bd.allocate( 16 );
		expect( bd._mergeHeadAttr.count ).toBe( 4096 );
		expect( bd.uniforms.hashMask.value ).toBe( 4095 );
		expect( bd.gpuResources() ).toHaveLength( 2 );

		bd.cacheBytes( 4096 * MB, 10 * VERTEX_BYTES / 0.05 );
		bd.allocate( 16 );
		expect( bd._mergeHeadAttr.count ).toBe( 1024 );

		const head = bd._mergeHeadAttr;
		const disposed = disposals( head );
		bd.select( 'bidirectional' );
		bd.allocate( 16 );
		expect( bd._mergeHeadAttr ).toBeNull();
		expect( bd.uniforms.hashMask.value ).toBe( 0 );
		expect( disposed ).toContain( head );

	} );

	it( 'makes the guide\'s texture once, and starts it unlearned', () => {

		const bd = integrator();
		bd.allocate( 16 );
		const texture = bd._guideTexture;
		expect( texture.image ).toMatchObject( { width: GUIDE_TEXTURE_WIDTH, height: GUIDE_BINS } );
		expect( bd._guideBuildAttr.count ).toBe( GUIDE_ROW_STRIDE * GUIDE_BINS );

		bd.uniforms.guide.value = 1;
		bd.allocate( 16 );
		expect( bd._guideTexture ).toBe( texture );
		expect( bd.uniforms.guide.value ).toBe( 0 );
		expect( bd.uniforms.guideTexture ).not.toBeNull();

	} );

	it( 'frees everything it holds', () => {

		const bd = integrator();
		bd.select( 'vcm' );
		bd.allocate( 16 );
		const held = [ bd._splatAttr, bd._mergeHeadAttr, bd._guideBuildAttr ];
		const freed = disposals( ...held );
		const texture = bd._guideTexture;
		const disposed = vi.spyOn( texture, 'dispose' );

		bd.dispose();

		expect( freed ).toEqual( expect.arrayContaining( held ) );
		expect( disposed ).toHaveBeenCalledOnce();
		expect( bd.gpuResources() ).toBeNull();
		expect( bd.uniforms.guideTexture ).toBeNull();

	} );

} );

describe( 'its kernels', () => {

	function register( name ) {

		const bd = integrator();
		bd.cacheBytes( 4096 * MB, 3000 * VERTEX_BYTES / 0.05 );
		bd.select( name );
		bd.allocate( 640 * 64 );
		pt._chunkRows = 64;
		const kernels = new Map();
		const node = ( label ) => ( { label } );
		bd.registerKernels( {
			km: { register: ( key, kernel ) => kernels.set( key, kernel ) },
			qm: { MAX_BOUNCE_SNAPSHOTS: 32, activeIndices: { a: node( 'active' ) }, getActiveReadRO: () => node( 'activeRO' ) },
			pb: { rayBuffer: { rw: node( 'rays' ) }, hitBuffer: { rw: node( 'hits' ), ro: node( 'hitsRO' ) } },
			counters: node( 'counters' ), bounceCountsBuf: node( 'curve' ), wfCurrentBounce: node( 'bounce' ),
			copyReadB: node( 'survivors' ), copyWriteA: node( 'next' ),
			maxRays: 5000, w: 640,
			own: ( call ) => Object.assign( call, { owned: true } ),
		} );
		return kernels;

	}

	const covers = ( kernel, axis = 0 ) => kernel.dispatchSize[ axis ] * kernel.workgroupSize[ axis ];

	it( 'registers the merge kernels only under vcm', () => {

		const base = [ 'lightSnapshot', 'lightCopyback', 'guideClear', 'guideBuild', 'lightGenerate', 'connect', 'lightSplat', 'splatResolve' ];
		expect( [ ...register( 'bidirectional' ).keys() ] ).toEqual( base );
		expect( [ ...register( 'vcm' ).keys() ].sort() ).toEqual( [ ...base, 'mergeClear', 'mergeInsert', 'merge' ].sort() );

	} );

	it( 'hands the kernels that read the scene this renderer\'s resources', () => {

		const kernels = register( 'vcm' );
		const owned = [ ...kernels ].filter( ( [ , kernel ] ) => kernel.computeNode.owned ).map( ( [ key ] ) => key );
		expect( owned.sort() ).toEqual( [ 'connect', 'lightGenerate', 'lightSplat', 'merge' ] );

	} );

	it( 'sizes every dispatch to cover its work', () => {

		const kernels = register( 'vcm' );
		for ( const key of [ 'lightCopyback', 'lightGenerate', 'connect', 'merge' ] ) expect( covers( kernels.get( key ) ) ).toBeGreaterThanOrEqual( 5000 );
		for ( const key of [ 'lightSplat', 'mergeInsert' ] ) expect( covers( kernels.get( key ) ) ).toBeGreaterThanOrEqual( 3000 );
		expect( covers( kernels.get( 'splatResolve' ) ) ).toBeGreaterThanOrEqual( 640 );
		expect( covers( kernels.get( 'splatResolve' ), 1 ) ).toBeGreaterThanOrEqual( 64 );
		expect( kernels.get( 'mergeClear' ).count ).toBe( 4096 );
		expect( kernels.get( 'guideBuild' ).count ).toBe( GUIDE_BINS );

	} );

} );

describe( 'controls', () => {

	it( 'is vcm with vertex merging, bidirectional without', () => {

		const bd = integrator();
		expect( bd.name ).toBe( 'bidirectional' );
		bd.select( 'vcm' );
		expect( [ bd.name, bd.merging, bd.uniforms.merging ] ).toEqual( [ 'vcm', true, true ] );
		bd.select( 'bidirectional' );
		expect( [ bd.name, bd.uniforms.merging ] ).toEqual( [ 'bidirectional', false ] );
		expect( bd.hitStride ).toBeGreaterThan( 0 );

	} );

	it( 'keeps one strategy, weighted or alone, for verification', () => {

		const bd = integrator();
		const view = ( ...args ) => {

			bd.setBidirectionalStrategy( ...args );
			return bd.uniforms.strategyView.value;

		};

		expect( view( 'connect' ) ).toBe( STRATEGY.CONNECT );
		expect( view( 'lightTrace', { alone: true } ) ).toBe( STRATEGY.LIGHT_TRACE + STRATEGY_ALONE );
		expect( view( 'merge', { alone: true } ) ).toBe( STRATEGY.MERGE + STRATEGY_ALONE );
		expect( view( 'all', { alone: true } ) ).toBe( STRATEGY.ALL );
		expect( view( 'typo' ) ).toBe( STRATEGY.ALL );
		expect( view() ).toBe( STRATEGY.ALL );

	} );

	it( 'keeps the merge radius and trust above zero', () => {

		const bd = integrator();
		bd.setMergeRadius( 0 );
		expect( bd._mergeRadiusPixels ).toBe( 1e-3 );
		bd.setMergeRadius();
		expect( bd._mergeRadiusPixels ).toBe( 1 );
		bd.setMergeTrust( - 1 );
		expect( bd.uniforms.mergeTrust.value ).toBeCloseTo( 1e-4, 8 );
		bd.setMergeTrust();
		expect( bd.uniforms.mergeTrust.value ).toBe( 0.25 );

	} );

} );

describe( 'the merge radius', () => {

	function merging( options ) {

		const bd = withBounds( integrator( options ) );
		bd.select( 'vcm' );
		point();
		return bd;

	}

	it( 'grows with distance from a perspective camera, by a pixel\'s footprint', () => {

		const bd = merging();
		bd.beginFrame( 3 );
		const slope = Math.sqrt( bd.uniforms.pixelArea.value );
		expect( bd.uniforms.mergeSlope.value ).toBeCloseTo( slope, 6 );
		expect( bd.uniforms.mergeConst.value ).toBe( 0 );
		expect( bd.uniforms.mergeMin.value ).toBeCloseTo( slope * 1e-3 * Math.sqrt( 3 ), 9 );

	} );

	it( 'is one pixel\'s height everywhere for an orthographic camera', () => {

		const bd = merging( { camera: new OrthographicCamera( - 4, 4, 2, - 2 ) } );
		bd.beginFrame( 3 );
		expect( bd.uniforms.mergeConst.value ).toBeCloseTo( 4 / 32, 6 );
		expect( bd.uniforms.mergeSlope.value ).toBe( 0 );
		expect( bd.uniforms.mergeMin.value ).toBeCloseTo( 4 / 32, 6 );

	} );

	it( 'is one pixel\'s angle for a panorama', () => {

		const bd = merging();
		pt.cameraProjection.value = CAMERA_PROJECTION_IDS.equirectangular;
		bd.beginFrame( 3 );
		expect( bd.uniforms.mergeSlope.value ).toBeCloseTo( 2 * Math.PI / 64, 6 );

	} );

	it( 'shrinks as samples accumulate, and never past a tenth of the distance', () => {

		const bd = merging();
		bd.beginFrame( 3 );
		const first = bd.uniforms.mergeSlope.value;
		pt.frameCount = 15;
		bd.beginFrame( 3 );
		expect( bd.uniforms.mergeSlope.value / first ).toBeCloseTo( 16 ** ( - 0.125 ), 6 );

		bd.setMergeRadius( 1e6 );
		bd.beginFrame( 3 );
		expect( bd.uniforms.mergeSlope.value ).toBe( 0.1 );

	} );

} );
