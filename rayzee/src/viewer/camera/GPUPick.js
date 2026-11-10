import { Fn, If, Loop, Break, uniform, storage, uint, int, vec3, floatBitsToUint } from 'three/tsl';
import { StorageBufferAttribute } from 'three/webgpu';
import { Vector3 } from 'three';
import { Ray, HitInfo } from '../../shaders/Struct.js';
import { traverseBVH } from '../../shaders/BVHTraversal.js';
import { offsetRayOrigin } from '../../shaders/Common.js';
import { KernelManager } from '../../pathtracer/KernelManager.js';

const MAX_SKIPS = 8;
const OUT_LANES = 12;

/**
 * One ray through the path tracer's own BVH: what the camera sees, hidden meshes and culled faces left out, as rendered.
 * The kernel is built once per scene buffer set and read back a frame later.
 */
export class GPUPick {

	constructor( renderer ) {

		this.renderer = renderer;
		this.origin = uniform( new Vector3() );
		this.direction = uniform( new Vector3( 0, 0, - 1 ) );
		this.skipMesh = uniform( - 1, 'int' );
		this._out = new StorageBufferAttribute( new Uint32Array( OUT_LANES ), 1 );
		this._kernel = null;
		this._ready = null;
		this._key = null;
		this._queue = Promise.resolve();

	}

	/**
	 * @param {import('../../pathtracer/PathTracerStage.js').PathTracerStage} stage
	 * @param {Vector3} origin - world space
	 * @param {Vector3} direction - world space, unit length
	 * @param {number} [skipMesh] - a mesh index the ray passes through (the floor)
	 * @returns {Promise<?{ point: Vector3, normal: Vector3, meshIndex: number, instanceLeaf: number, triangleIndex: number }|undefined>}
	 *   null for a miss, undefined while the stage has no scene to trace
	 */
	pick( stage, origin, direction, skipMesh = - 1 ) {

		const o = origin.clone(), d = direction.clone();
		const run = this._queue.then( () => this._trace( stage, o, d, skipMesh ) );
		this._queue = run.catch( () => {} );
		return run;

	}

	async _trace( stage, origin, direction, skipMesh ) {

		const key = [ stage.bvhStorageAttr, stage._bvhParts, stage._geoParts, stage._shadeParts ];
		if ( ! this._key || key.some( ( k, i ) => k !== this._key[ i ] ) ) {

			const nodes = stage.sceneStorageNodes?.();
			if ( ! nodes ) return undefined;
			this._kernel?.dispose();
			this._key = key;
			this._kernel = this._build( nodes );
			this._ready = KernelManager.canCompileInBackground ? this.renderer.compileComputeAsync( this._kernel ) : null;

		}

		await this._ready;
		this.origin.value.copy( origin );
		this.direction.value.copy( direction );
		this.skipMesh.value = skipMesh;
		this.renderer.compute( this._kernel );
		const u = new Uint32Array( await this.renderer.getArrayBufferAsync( this._out ) );
		if ( u[ 0 ] === 0 ) return null;
		const f = new Float32Array( u.buffer );
		return {
			point: new Vector3( f[ 1 ], f[ 2 ], f[ 3 ] ),
			normal: new Vector3( f[ 4 ], f[ 5 ], f[ 6 ] ),
			meshIndex: u[ 7 ],
			instanceLeaf: u[ 8 ] - 1,
			triangleIndex: u[ 9 ],
		};

	}

	_build( { bvh, triangles } ) {

		const out = storage( this._out, 'uint', OUT_LANES );
		const { skipMesh } = this;

		return Fn( () => {

			const origin = vec3( this.origin ).toVar();
			const direction = vec3( this.direction ).toVar();
			out.element( 0 ).assign( uint( 0 ) );

			Loop( MAX_SKIPS, () => {

				const hit = HitInfo.wrap( traverseBVH( Ray( { origin, direction } ), bvh, triangles ) ).toVar();
				If( hit.didHit.not(), () => {

					Break();

				} );

				If( hit.meshIndex.notEqual( skipMesh ), () => {

					out.element( 0 ).assign( uint( 1 ) );
					out.element( 1 ).assign( floatBitsToUint( hit.hitPoint.x ) );
					out.element( 2 ).assign( floatBitsToUint( hit.hitPoint.y ) );
					out.element( 3 ).assign( floatBitsToUint( hit.hitPoint.z ) );
					out.element( 4 ).assign( floatBitsToUint( hit.normal.x ) );
					out.element( 5 ).assign( floatBitsToUint( hit.normal.y ) );
					out.element( 6 ).assign( floatBitsToUint( hit.normal.z ) );
					out.element( 7 ).assign( uint( hit.meshIndex ) );
					out.element( 8 ).assign( uint( hit.instanceLeaf.add( int( 1 ) ) ) );
					out.element( 9 ).assign( uint( hit.triangleIndex ) );
					Break();

				} );

				origin.assign( offsetRayOrigin( hit.hitPoint, direction ) );

			} );

		} )().compute( 1, [ 1, 1, 1 ] );

	}

	dispose() {

		this._kernel?.dispose();
		this._kernel = null;
		this._key = null;
		this._out = null;

	}

}

const _leafMaps = new WeakMap();

/** Placements by TLAS leaf, built once per leaf array. */
function placementsByLeaf( table ) {

	const leaves = table.tlasLeafIndex;
	let entry = _leafMaps.get( table );
	if ( entry?.leaves === leaves && entry.count === table.count ) return entry.map;

	const map = new Map();
	for ( let p = 0; p < table.count; p ++ ) {

		const leaf = leaves[ p ];
		if ( leaf < 0 ) continue;
		const list = map.get( leaf );
		if ( list ) list.push( p );
		else map.set( leaf, [ p ] );

	}

	entry = { leaves, count: table.count, map };
	_leafMaps.set( table, entry );
	return map;

}

/**
 * The scene mesh (and InstancedMesh copy) a GPU hit belongs to. A shared geometry's triangles carry their first owner's
 * mesh index, so a transformed hit is resolved through its TLAS leaf; copy clusters leave only the distance.
 * @returns {{ object: ?import('three').Object3D, instanceId?: number }}
 */
export function pickedObject( processor, hit ) {

	const meshes = processor?.meshes ?? [];
	if ( hit.instanceLeaf < 0 ) return { object: meshes[ hit.meshIndex ] ?? null };

	const table = processor.instanceTable;
	if ( ! table || table.clusterCount ) return { object: null };

	const placements = placementsByLeaf( table ).get( hit.instanceLeaf );
	if ( ! placements ) return { object: null };

	let p = placements[ 0 ];
	if ( placements.length > 1 ) {

		const ranges = processor.meshTriangleRanges ?? [];
		p = placements.find( q => {

			const range = ranges[ table.sourceMesh[ q ] ];
			return range && hit.triangleIndex >= range.start && hit.triangleIndex < range.start + range.count;

		} ) ?? p;

	}

	const m = table.sourceMesh[ p ];
	const object = meshes[ m ] ?? null;
	return object?.isInstancedMesh ? { object, instanceId: p - table.placementRunOf( m ).start } : { object };

}
