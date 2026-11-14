/**
 * A run of OpenVDB frames as one volume whose grids change over time (loaders/FrameSequence.js), each frame read in a
 * worker. Apart from OpenVDB.js, which the worker imports: a module cannot start a worker that imports it.
 */

import { Box3, Matrix4, Vector3 } from 'three';
import OpenVDBWorker from './OpenVDBWorker.js?worker&inline';
import { createWorker, hasWorkers } from '../Platform.js';
import { FrameSequence } from './FrameSequence.js';
import { readOpenVDB, readVolumeFrame, pickGrids, volumeGroup, upAxisOf } from './OpenVDB.js';
import { VolumeGrid, growReserve } from '../scene/Volumes.js';

// Voxels a frame is read at, at most: half the volumes' budget, so its slot can grow a quarter each side; and its side,
// at most the 3D texture's guaranteed 2048 less the packed border.
const FRAME_VOXELS = 2 ** 26;
const FRAME_SIDE = 2046;
// An idle worker is let go after this: kept, it would hold a Node process open.
const IDLE_MS = 2000;

let worker = null, idle = null, queue = Promise.resolve();

function decodeInWorker( bytes, request ) {

	const run = () => new Promise( ( resolve, reject ) => {

		clearTimeout( idle );
		try {

			worker ??= createWorker( OpenVDBWorker );

		} catch {

			resolve( readVolumeFrame( bytes, request ) );
			return;

		}

		const done = () => {

			idle = setTimeout( () => {

				worker?.terminate();
				worker = null;

			}, IDLE_MS );

		};

		worker.onmessage = ( { data } ) => {

			done();
			if ( data.error ) reject( new Error( data.error ) );
			else resolve( { grid: fromPlain( data.result.grid ), emission: fromPlain( data.result.emission ), factor: data.result.factor } );

		};

		worker.onerror = ( event ) => {

			event?.preventDefault?.();
			worker.terminate();
			worker = null;
			reject( new Error( `OpenVDB worker failed: ${event?.message ?? 'unknown error'}` ) );

		};

		const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
		worker.postMessage( { bytes: buffer, request }, [ buffer ] );

	} );

	const result = queue.then( run, run );
	queue = result.catch( () => {} );
	return result;

}

const fromPlain = ( g ) => g && new VolumeGrid( { ...g, transform: new Matrix4().fromArray( g.transform ) } );

// The frames read at load to learn the run's extent: the first, the last and three between.
const SAMPLES = 5;

/**
 * The index box the run's frames take, from the active boxes the sampled files record for the picked grids (one map
 * across the run: a simulator's are), null where none records one; the hottest glow among them; and the first sampled
 * frame recording a box (−1 for none).
 */
async function sampleExtent( frames, first, names, glow ) {

	const n = frames.length;
	const picks = [ ...new Set( Array.from( { length: SAMPLES }, ( _, k ) => Math.round( k * ( n - 1 ) / ( SAMPLES - 1 ) ) ) ) ];
	const lo = [ Infinity, Infinity, Infinity ], hi = [ - Infinity, - Infinity, - Infinity ];
	let peak = 0, lit = - 1;
	for ( const i of picks ) {

		const { grids } = readOpenVDB( i === 0 ? first : new Uint8Array( await frames[ i ]() ) );
		peak = Math.max( peak, grids.find( ( g ) => g.name === glow )?.maxValue() ?? 0 );
		for ( const grid of grids ) {

			const { file_bbox_min: min, file_bbox_max: max } = grid.metadata;
			if ( ! names.includes( grid.name ) || ! min || ! max || min.some( ( v, k ) => v > max[ k ] ) ) continue;
			if ( lit < 0 ) lit = i;
			for ( let k = 0; k < 3; k ++ ) {

				lo[ k ] = Math.min( lo[ k ], min[ k ] );
				hi[ k ] = Math.max( hi[ k ], max[ k ] );

			}

		}

	}

	return { box: lo[ 0 ] <= hi[ 0 ] ? { min: lo, max: hi } : null, peak, lit };

}

/**
 * A run of .vdb frames as a volume in a group named `name`: the first frame read now (the first holding anything, where
 * the run starts empty), the rest as the timeline reaches them. Grids are picked by the first frame's names, as `volumeFromOpenVDB` picks them. A few frames are sampled for
 * the run's extent: the camera frames it whole, its frames are read at one resolution, and its place on the GPU is
 * sized once.
 * @param {Array<function(): Promise<ArrayBuffer|Uint8Array>>} frames - each frame's reader, in order
 * @param {{ name?: string, fps?: number }} [options]
 * @returns {Promise<import('three').Group>}
 */
export async function volumeSequenceFromOpenVDB( frames, { name = 'volume', fps = 24 } = {} ) {

	const bytes = new Uint8Array( await frames[ 0 ]() );
	const file = readOpenVDB( bytes );
	const picked = pickGrids( file.grids, name );
	const names = [ picked.density?.name, picked.glow?.name ].filter( Boolean );
	const request = { density: picked.density?.name ?? null, emission: picked.glow?.name ?? null, maxVoxels: FRAME_VOXELS, maxSide: FRAME_SIDE, factor: 1 };
	const { box: extent, peak, lit } = await sampleExtent( frames, bytes, names, picked.glow?.name );
	if ( extent ) {

		const size = extent.min.map( ( v, k ) => extent.max[ k ] - v + 1 );
		while ( size.reduce( ( p, v ) => p * Math.ceil( v / request.factor ), 1 ) > FRAME_VOXELS || Math.max( ...size ) / request.factor > FRAME_SIDE ) request.factor *= 2;

	}

	let first = readVolumeFrame( bytes, request ), shown = 0;
	// A run may start empty (a fire not yet lit): it opens on its first frame holding anything, else on nothing.
	for ( let k = 1; ! first.grid && k <= lit; k ++ ) {

		const frame = readVolumeFrame( new Uint8Array( await frames[ k ]() ), request );
		if ( frame.grid ) [ first, shown ] = [ frame, k ];

	}

	request.factor = Math.max( request.factor, first.factor );
	const empty = () => new VolumeGrid( { width: 1, height: 1, depth: 1, data: new Float32Array( 1 ), transform: ( picked.density ?? picked.glow ).transform ?? new Matrix4() } );
	const group = volumeGroup( first.grid ?? empty(), first.emission, picked, name, { up: upAxisOf( file.metadata ), peak } );
	const volume = group.children[ 0 ];
	volume.reserve = growReserve( volume );
	if ( extent ) {

		const f = request.factor;
		const size = extent.min.map( ( v, k ) => Math.ceil( ( extent.max[ k ] - v + 1 ) / f ) );
		volume.reserve = volume.reserve.map( ( n, k ) => Math.max( n, Math.ceil( size[ k ] * 1.1 ) ) );
		const toWorld = ( picked.density ?? picked.glow ).transform ?? new Matrix4();
		volume.extent = new Box3( new Vector3( ...extent.min ).subScalar( 0.5 ), new Vector3( ...extent.max ).addScalar( 0.5 ) ).applyMatrix4( toWorld );

	}

	const decode = hasWorkers() ? decodeInWorker : async ( b, r ) => readVolumeFrame( b, r );
	volume.sequence = new FrameSequence( {
		frames, fps, name, shown,
		// Frames read coarser once one needed it stay so: a resolution changing back and forth would flicker.
		decode: async ( frame ) => {

			const result = await decode( frame, { ...request } );
			request.factor = Math.max( request.factor, result.factor );
			return result;

		},
	} );
	return group;

}
