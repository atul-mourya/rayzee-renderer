import { describe, it, expect } from 'vitest';
import { AnimationMixer, Group, LoopOnce, Mesh, PerspectiveCamera } from 'three';
import { PBRTParser } from '@/core/Processor/PBRT/PBRTParser.js';
import { findFrameSequence, alignSequences, FrameSequenceMerger, motionFromShutter } from '@/core/Processor/PBRT/PBRTAnimation.js';
import { loadPBRTScene } from '@/core/Processor/PBRT/index.js';

const enc = new TextEncoder();
const parse = src => new PBRTParser().parse( src );

/** Played once and held, so the end time shows the last frame rather than wrapping to the first. */
function mixerAt( root, clip ) {

	const mixer = new AnimationMixer( root );
	const action = mixer.clipAction( clip );
	action.setLoop( LoopOnce );
	action.clampWhenFinished = true;
	action.play();
	return mixer;

}

describe( 'PBRT animated transforms', () => {

	it( 'keeps the start transform as the CTM and records the end one apart', async () => {

		const ir = await parse( `
			WorldBegin
			ActiveTransform EndTime
			Translate 0 0 5
			ActiveTransform All
			Translate 1 0 0
			Shape "sphere"
		` );

		const [ shape ] = ir.shapes;
		expect( [ shape.ctm[ 12 ], shape.ctm[ 13 ], shape.ctm[ 14 ] ] ).toEqual( [ 1, 0, 0 ] );
		expect( [ shape.ctmEnd[ 12 ], shape.ctmEnd[ 13 ], shape.ctmEnd[ 14 ] ] ).toEqual( [ 1, 0, 5 ] );
		expect( ir.hasMotion ).toBe( true );

	} );

	it( 'restores the active transform and both CTMs at AttributeEnd', async () => {

		const ir = await parse( `
			WorldBegin
			AttributeBegin
				ActiveTransform StartTime
				Translate 2 0 0
			AttributeEnd
			Translate 0 3 0
			Shape "sphere"
		` );

		const [ shape ] = ir.shapes;
		expect( shape.ctm[ 13 ] ).toBe( 3 );
		expect( shape.ctm[ 12 ] ).toBe( 0 );
		expect( shape.ctmEnd ).toBeUndefined();
		expect( ir.hasMotion ).toBe( false );

	} );

	it( 'records TransformTimes, a moving camera and a moving placement', async () => {

		const ir = await parse( `
			TransformTimes 0 2
			ActiveTransform EndTime
			Translate 0 0 -4
			ActiveTransform All
			Camera "perspective"
			WorldBegin
			ObjectBegin "rock"
				Shape "sphere"
			ObjectEnd
			ObjectInstance "rock"
			ActiveTransform EndTime
			Translate 1 0 0
			ActiveTransform All
			ObjectInstance "rock"
		` );

		expect( ir.transformTimes ).toEqual( { start: 0, end: 2 } );
		expect( ir.camera.cameraToWorldEnd[ 14 ] ).toBe( 4 );

		const list = ir.instances.get( 'rock' );
		expect( list.count ).toBe( 2 );
		expect( list.matricesEnd[ 12 ] ).toBe( 0 ); // first placement did not move
		expect( list.matricesEnd[ 16 + 12 ] ).toBe( 1 );

	} );

	it( 'turns shutter motion into two keys across the transform times', async () => {

		const ir = motionFromShutter( await parse( `
			TransformTimes 0 0.5
			WorldBegin
			ObjectBegin "rock"
				Shape "sphere"
			ObjectEnd
			ObjectInstance "rock"
			ActiveTransform EndTime
			Translate 1 0 0
			ActiveTransform All
			ObjectInstance "rock"
			Shape "sphere"
		` ) );

		expect( ir.animation ).toMatchObject( { duration: 0.5, frames: 2 } );
		expect( Array.from( ir.shapes[ 0 ].motion.times ) ).toEqual( [ 0, 0.5 ] );
		expect( ir.shapes[ 0 ].motion.matrices[ 16 + 12 ] ).toBe( 1 );

		// The moving placement leaves the static list; the still one stays.
		expect( ir.instances.get( 'rock' ).count ).toBe( 1 );
		expect( ir.animatedInstances ).toHaveLength( 1 );

	} );

	it( 'leaves a scene without motion alone', async () => {

		const ir = motionFromShutter( await parse( 'WorldBegin\nShape "sphere"\n' ) );
		expect( ir.animation ).toBeUndefined();
		expect( ir.shapes[ 0 ].motion ).toBeUndefined();

	} );

} );

describe( 'PBRT frame sequences', () => {

	it( 'finds the sequence the best scene belongs to, in number order', () => {

		const frames = findFrameSequence( [ 'zd/frame25.pbrt', 'zd/frame120.pbrt', 'zd/frame35.pbrt' ] );
		expect( frames.map( f => f.number ) ).toEqual( [ 25, 35, 120 ] );
		expect( frames[ 0 ].path ).toBe( 'zd/frame25.pbrt' );

	} );

	it( 'does not treat differently named views as frames', () => {

		expect( findFrameSequence( [ 'bistro/bistro_cafe.pbrt', 'bistro/bistro_vespa.pbrt' ] ) ).toBeNull();
		expect( findFrameSequence( [ 'scene.pbrt', 'frame1.pbrt', 'frame2.pbrt' ] ) ).toBeNull();
		expect( findFrameSequence( [ 'a/frame1.pbrt', 'b/frame2.pbrt' ] ) ).toBeNull();

	} );

	it( 'aligns repeated parts through an insertion instead of sliding them', () => {

		// Three identical parts (7), then a new one arrives at the front.
		const prev = Int32Array.of( 1, 7, 7, 7, 2 );
		const next = Int32Array.of( 1, 9, 7, 7, 7, 2 );
		expect( Array.from( alignSequences( prev, next ) ) ).toEqual( [ 0, - 1, 1, 2, 3, 4 ] );

		const removed = Int32Array.of( 1, 7, 7, 2 );
		expect( Array.from( alignSequences( prev, removed ) ).filter( i => i >= 0 ) ).toHaveLength( 4 );

	} );

	it( 'follows a moving shape, shows arrivals and hides departures', async () => {

		const frame = ( x, extra ) => parse( `
			LookAt ${x} 0 5  ${x} 0 0  0 1 0
			Camera "perspective" "float fov" 40
			WorldBegin
			AttributeBegin
				Translate ${x} 0 0
				Shape "sphere" "float radius" 1
			AttributeEnd
			${extra}
		` );

		const merger = new FrameSequenceMerger( [ 0, 1, 2 ], 'test' );
		merger.addFrame( await frame( 0, 'Shape "sphere" "float radius" 0.25' ) );
		merger.addFrame( await frame( 1, 'Shape "sphere" "float radius" 0.25' ) );
		merger.addFrame( await frame( 2, 'Shape "sphere" "float radius" 3' ) );
		const ir = merger.finish();

		expect( ir.shapes ).toHaveLength( 3 );
		const [ mover, leaver, arrival ] = ir.shapes;

		expect( Array.from( [ 0, 1, 2 ], k => mover.motion.matrices[ k * 16 + 12 ] ) ).toEqual( [ 0, 1, 2 ] );
		expect( mover.motion.visible ).toBeNull();

		expect( leaver.params.radius.value[ 0 ] ).toBe( 0.25 );
		expect( Array.from( leaver.motion.visible ) ).toEqual( [ 1, 1, 0 ] );

		expect( arrival.params.radius.value[ 0 ] ).toBe( 3 );
		expect( Array.from( arrival.motion.visible ) ).toEqual( [ 0, 0, 1 ] );

		expect( ir.camera.motion.matrices[ 16 * 2 + 12 ] ).toBeCloseTo( 2 );
		expect( ir.animation ).toEqual( { name: 'test', duration: 2, frames: 3 } );

	} );

	it( 'pulls moving placements out of the static list', async () => {

		const frame = x => parse( `
			WorldBegin
			ObjectBegin "rock"
				Shape "sphere"
			ObjectEnd
			ObjectInstance "rock"
			Translate ${x} 0 0
			ObjectInstance "rock"
		` );

		const merger = new FrameSequenceMerger( [ 0, 1 ], 'test' );
		merger.addFrame( await frame( 0 ) );
		merger.addFrame( await frame( 4 ) );
		const ir = merger.finish();

		expect( ir.instances.get( 'rock' ).count ).toBe( 1 );
		expect( ir.instanceCount ).toBe( 1 );
		expect( ir.animatedInstances ).toHaveLength( 1 );
		expect( ir.animatedInstances[ 0 ].motion.matrices[ 16 + 12 ] ).toBe( 4 );

	} );

	it( 'instances a template a frame redefined from that frame only', async () => {

		const frame = radius => parse( `
			WorldBegin
			ObjectBegin "rock"
				Shape "sphere" "float radius" ${radius}
			ObjectEnd
			ObjectInstance "rock"
		` );

		const merger = new FrameSequenceMerger( [ 0, 1, 2 ], 'test' );
		merger.addFrame( await frame( 1 ) );
		merger.addFrame( await frame( 1 ) );
		merger.addFrame( await frame( 2 ) );
		const ir = merger.finish();

		expect( ir.objects.get( 'rock' )[ 0 ].params.radius.value[ 0 ] ).toBe( 1 );
		expect( ir.objects.get( 'rock @2' )[ 0 ].params.radius.value[ 0 ] ).toBe( 2 );

		const byName = Object.fromEntries( ir.animatedInstances.map( p => [ p.name, Array.from( p.motion.visible ) ] ) );
		expect( byName ).toEqual( { 'rock': [ 1, 1, 0 ], 'rock @2': [ 0, 0, 1 ] } );
		expect( ir.instances.get( 'rock' ).count ).toBe( 0 );

	} );

} );

describe( 'PBRT animation clip', () => {

	const frameFile = x => enc.encode( `
		LookAt ${x} 0 5  ${x} 0 0  0 1 0
		Camera "perspective" "float fov" 40
		WorldBegin
		Include "materials.pbrt"
		AttributeBegin
			NamedMaterial "red"
			Translate ${x} 0 0
			Shape "sphere" "float radius" 1
		AttributeEnd
		Shape "sphere" "float radius" 0.5
		${x === 2 ? 'Shape "sphere" "float radius" 3' : ''}
	` );

	const vfs = () => ( {
		'anim/frame10.pbrt': frameFile( 0 ),
		'anim/frame40.pbrt': frameFile( 1 ),
		'anim/frame70.pbrt': frameFile( 2 ),
		'anim/materials.pbrt': enc.encode( 'MakeNamedMaterial "red" "string type" "diffuse" "rgb reflectance" [ 1 0 0 ]\n' )
	} );

	const args = extra => ( { vfs: vfs(), plyParser: () => null, imageFromBytes: async () => null, ...extra } );

	it( 'loads every frame as one clip timed by frame number at 30 fps', async () => {

		const { group, animations, frames, entryPath } = await loadPBRTScene( args() );

		expect( frames ).toEqual( [ 'anim/frame10.pbrt', 'anim/frame40.pbrt', 'anim/frame70.pbrt' ] );
		expect( entryPath ).toBe( 'anim/frame10.pbrt' );
		expect( animations ).toHaveLength( 1 );

		const [ clip ] = animations;
		expect( clip.name ).toBe( 'anim · frames 10–70' );
		expect( clip.duration ).toBeCloseTo( 2 );

		// Every track names a node that exists in the built scene.
		const names = new Set();
		group.traverse( o => names.add( o.name ) );
		for ( const track of clip.tracks ) expect( names.has( track.name.slice( 0, track.name.lastIndexOf( '.' ) ) ) ).toBe( true );

		const trackNames = clip.tracks.map( t => t.name );
		expect( trackNames ).toContain( 'PBRT Camera.position' );
		expect( trackNames.filter( n => n.endsWith( '.visible' ) ) ).toHaveLength( 1 );

	} );

	it( 'builds the first frame, with later arrivals hidden, and plays to the last', async () => {

		const { group, animations } = await loadPBRTScene( args() );
		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes ).toHaveLength( 3 );

		const [ mover, still, arrival ] = meshes;
		expect( mover.position.x ).toBe( 0 );
		expect( still.visible ).toBe( true );
		expect( arrival.visible ).toBe( false );

		const mixer = mixerAt( group, animations[ 0 ] );
		mixer.setTime( 1.25 );
		expect( mover.position.x ).toBeCloseTo( 1.25 );
		expect( arrival.visible ).toBe( false );

		// The nearest frame's shapes are shown, so a seek a hair short of a key still gets that key's.
		mixer.setTime( 1.75 );
		expect( arrival.visible ).toBe( true );
		mixer.setTime( 2 - 1e-6 );
		expect( arrival.visible ).toBe( true );

		mixer.setTime( 2 );

		const camera = group.children.find( c => c instanceof PerspectiveCamera );
		expect( camera.position.x ).toBeCloseTo( 2 );

	} );

	it( 'keeps moving shapes out of merged batches', async () => {

		const { group } = await loadPBRTScene( args( { mergeShapesAbove: 1 } ) );
		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes.some( m => m.name.startsWith( 'merged_' ) ) ).toBe( true );
		expect( meshes.filter( m => m.name.startsWith( 'shape_' ) ) ).toHaveLength( 2 );

	} );

	it( 'loads one frame when animation is off or a frame is asked for', async () => {

		const off = await loadPBRTScene( args( { animation: false } ) );
		expect( off.animations ).toEqual( [] );
		expect( off.frames ).toBeNull();

		const one = await loadPBRTScene( args( { entryPath: 'anim/frame40.pbrt' } ) );
		expect( one.animations ).toEqual( [] );
		expect( one.entryPath ).toBe( 'anim/frame40.pbrt' );

	} );

	it( 'moves a placement group when an instance moves', async () => {

		const frame = x => enc.encode( `
			WorldBegin
			ObjectBegin "rock"
				Shape "sphere"
			ObjectEnd
			Translate ${x} 0 0
			ObjectInstance "rock"
		` );

		const { group, animations } = await loadPBRTScene( {
			vfs: { 'frame1.pbrt': frame( 0 ), 'frame2.pbrt': frame( 3 ) },
			plyParser: () => null, imageFromBytes: async () => null
		} );

		const node = group.children.find( c => c instanceof Group && c.name.startsWith( 'placement_' ) );
		expect( node.children ).toHaveLength( 1 );

		const mixer = mixerAt( group, animations[ 0 ] );
		mixer.setTime( animations[ 0 ].duration );
		expect( node.position.x ).toBeCloseTo( 3 );

	} );

} );
