/**
 * HardwareSearch.js — hits found by the GPU's ray tracing hardware in place of the BVH walk, where the host's WebGPU
 * offers ray queries: today a study binding, a patched Deno's `GPUDevice.createRayScene` with `wgpu-ray-query`
 * (docs/design/HARDWARE_RAY_TRACING.md). It builds the structures from the scene — a BLAS a template, read from the geo
 * store; an instance a visible placement — keeps them in step with moves, visibility, material sides and refits, and
 * hands the kernels a SceneSearch whose WGSL placeholders ThreePatches.js §4 fills.
 */

import { wgslFn, select, uint, int, uintBitsToFloat } from 'three/tsl';
import { TRI_SIDE_SHIFT, TRI_BLOCKER_SHIFT, TLAS_LEAF_IDENTITY, TRIANGLE_DATA_LAYOUT } from '../scene/BufferLayout.js';

export const RAY_QUERY_FEATURE = 'wgpu-ray-query';

/** Whether a device can search with the hardware. */
export const hardwareSearchSupported = ( device ) => typeof device?.createRayScene === 'function' && device.features?.has( RAY_QUERY_FEATURE ) === true;

// Instance masks: whether a template blocks light outright (shadow rays stop at the first such hit) or lets some pass.
const MASK = { BLOCKS: 1, PASSES: 2 };
// A template's sides in its table entry's top bits, as the triangle flags hold them: 0 front, 1 back, 2 both.
const SIDE_SHIFT = 24;
const LEAF_BITS = 0xffffff;
const LANES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const FLAGS_LANE = TRIANGLE_DATA_LAYOUT.MATERIAL_FLAGS_OFFSET;
// TLAS instances a scene may hold: wgpu's custom data and DX12's instance id are 24 bits.
const MAX_INSTANCES = LEAF_BITS;
// Triangles past which the walk searches: the BLASes beside the geo store (and a copy of it, where it was created without
// BLAS_INPUT) are memory the walk does not need.
const MAX_TRIANGLES = 20_000_000;

// wgpu's BufferUsages::BLAS_INPUT: a geo store created with it is read in place by the build, not copied.
const BLAS_INPUT = 1 << 10;

const MISS = 0xffffffff;
const closestHitFn = /*@__PURE__*/ wgslFn( `
	fn rayzeeRayQueryClosestHit( origin: vec3f, direction: vec3f, cull: u32 ) -> vec4u {
		return vec4u( 0u, 0xffffffffu, 0u, 0u );
	}
` );
const shadowHitFn = /*@__PURE__*/ wgslFn( `
	fn rayzeeRayQueryShadowHit( origin: vec3f, direction: vec3f, tMax: f32 ) -> vec4u {
		return vec4u( 0u, 0xffffffffu, 0u, 0u );
	}
` );
const unpackBarycentrics = /*@__PURE__*/ wgslFn( `
	fn rayzeeRayQueryBarycentrics( packed: u32 ) -> vec2f {
		return unpack2x16unorm( packed );
	}
` );

const PLACEHOLDER = /fn\s+rayzeeRayQuery(ClosestHit|ShadowHit)\s*\(/;

// A query returns distance bits, triangle, TLAS leaf + 1 (0: baked into world space), barycentrics as 2 × 16-bit unorm.
const searchHit = ( query ) => ( {
	didHit: query.y.notEqual( uint( MISS ) ),
	distance: uintBitsToFloat( query.x ),
	triangle: int( query.y ),
	instanceLeaf: int( query.z ).sub( int( 1 ) ),
	barycentrics: unpackBarycentrics( query.w ),
} );

// One opaque query (FORCE_OPAQUE): naga's Metal output never ends a candidate loop, so none is written. The instance
// table's first entry holds the mask classes the scene has; entries follow it.
const QUERY_WGSL = /* wgsl */`
fn rayzeeQuery( origin: vec3f, direction: vec3f, flags: u32, mask: u32, tMin: f32, tMax: f32 ) -> vec4u {
	var rq: ray_query;
	rayQueryInitialize( &rq, rayzeeTLAS, RayDesc( flags | 1u, mask, tMin, tMax, origin, direction ) );
	rayQueryProceed( &rq );
	let hit = rayQueryGetCommittedIntersection( &rq );
	if ( hit.kind == RAY_QUERY_INTERSECTION_NONE ) {
		return vec4u( 0u, 0xffffffffu, 0u, 0u );
	}
	let instance = rayzeeInstances[ hit.instance_index + 1u ];
	return vec4u( bitcast<u32>( hit.t ), instance.y + hit.primitive_index, instance.x & ${LEAF_BITS}u, pack2x16unorm( hit.barycentrics ) );
}

fn rayzeeNormal( packed: u32 ) -> vec3f {
	let e = unpack2x16snorm( packed );
	var nx = e.x;
	var ny = e.y;
	let nz = 1.0 - abs( e.x ) - abs( e.y );
	if ( nz < 0.0 ) {
		let tx = ( 1.0 - abs( ny ) ) * select( -1.0, 1.0, nx >= 0.0 );
		let ty = ( 1.0 - abs( nx ) ) * select( -1.0, 1.0, ny >= 0.0 );
		nx = tx;
		ny = ty;
	}
	return normalize( vec3f( nx, ny, nz ) );
}
`;

// The walk's closest hit must clear its triangle's rounding error (pbrt's bound, BVHTraversal rayTriangle), or a ray
// leaving a surface hits it again; a query cannot test each triangle, so it starts past the error at the origin.
// A camera ray keeps only the faces the walk keeps (sideAccepts, on the interpolated normal in object space): from a
// face it would cull the search starts again just past it — whole queries, never a candidate loop (naga's Metal output
// never ends one). The side is the template's (one mixing sides counts as both).
const CLOSEST_BODY = /* wgsl */`{
	let o = abs( origin );
	var tMin = 8e-6 * max( 1.0, max( o.x, max( o.y, o.z ) ) );
	if ( cull == 0u ) {
		return rayzeeQuery( origin, direction, 0u, 0xffu, tMin, 1e20 );
	}
	for ( var k = 0u; k < 8u; k ++ ) {
		var rq: ray_query;
		rayQueryInitialize( &rq, rayzeeTLAS, RayDesc( 1u, 0xffu, tMin, 1e20, origin, direction ) );
		rayQueryProceed( &rq );
		let hit = rayQueryGetCommittedIntersection( &rq );
		if ( hit.kind == RAY_QUERY_INTERSECTION_NONE ) {
			break;
		}
		let entry = rayzeeInstances[ hit.instance_index + 1u ];
		let tri = entry.y + hit.primitive_index;
		let side = entry.x >> ${SIDE_SHIFT}u;
		var keep = side == 2u;
		if ( ! keep ) {
			let b = hit.barycentrics;
			let n = normalize( rayzeeNormal( rayzeeGeo[ tri * 3u ].w ) * ( 1.0 - b.x - b.y )
				+ rayzeeNormal( rayzeeGeo[ tri * 3u + 1u ].w ) * b.x + rayzeeNormal( rayzeeGeo[ tri * 3u + 2u ].w ) * b.y );
			let d = dot( hit.world_to_object * vec4f( direction, 0.0 ), n );
			keep = ( side == 0u && d < -0.0001 ) || ( side == 1u && d > 0.0001 );
		}
		if ( keep ) {
			return vec4u( bitcast<u32>( hit.t ), tri, entry.x & ${LEAF_BITS}u, pack2x16unorm( hit.barycentrics ) );
		}
		tMin = max( hit.t * 1.0000003, hit.t + 1e-30 );
	}
	return vec4u( 0u, 0xffffffffu, 0u, 0u );
}`;

// Any instance that blocks outright (the first found ends the search), else the nearest surface light may pass:
// traceShadowRay walks on from it. Past the origin's rounding error too: the walk's shadow rays never find the surface
// they leave, a query from it does.
const SHADOW_BODY = /* wgsl */`{
	let o = abs( origin );
	let tMin = 8e-6 * max( 1.0, max( o.x, max( o.y, o.z ) ) );
	let classes = rayzeeInstances[ 0 ].x;
	if ( ( classes & ${MASK.BLOCKS}u ) != 0u ) {
		let blocker = rayzeeQuery( origin, direction, 4u, ${MASK.BLOCKS}u, tMin, tMax );
		if ( blocker.y != 0xffffffffu ) {
			return blocker;
		}
	}
	if ( ( classes & ${MASK.PASSES}u ) != 0u ) {
		return rayzeeQuery( origin, direction, 0u, ${MASK.PASSES}u, tMin, tMax );
	}
	return vec4u( 0u, 0xffffffffu, 0u, 0u );
}`;

const BODIES = { rayzeeRayQueryClosestHit: CLOSEST_BODY, rayzeeRayQueryShadowHit: SHADOW_BODY };

/** A function's body in WGSL `code`, from the `{` after its name to the matching `}`. */
function bodyOf( code, name ) {

	const at = code.search( new RegExp( `fn\\s+${name}\\s*\\(` ) );
	if ( at < 0 ) return null;
	const open = code.indexOf( '{', at );
	let depth = 0;
	for ( let close = open; close < code.length; close ++ ) {

		if ( code[ close ] === '{' ) depth ++;
		else if ( code[ close ] === '}' && -- depth === 0 ) return { open, close };

	}

	return null;

}

export class HardwareSearch {

	/**
	 * @param {import('./PathTracer.js').PathTracer} stage - the scene it searches
	 */
	constructor( stage ) {

		this.stage = stage;
		this.backend = stage.renderer.backend;
		this.device = this.backend.device;
		this.scene = null; // GPURayScene
		this.table = null; // instance table buffer: [ mask classes, 0 ], then [ leaf + 1 | side << 24, first triangle ] an instance
		this.group = null;
		this.reason = null; // why the last scene searches with the walk
		this._built = null; // what the structures were built from
		this._failure = null;
		this.layout = this.device.createBindGroupLayout( { label: 'rayzee ray queries', entries: [
			{ binding: 0, visibility: GPUShaderStage.COMPUTE, accelerationStructure: {} },
			{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
			{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
		] } );
		this.backend.rayQueries = this;
		stage.geoUsage = BLAS_INPUT;

		/** @type {import('../shaders/SceneResources.js').SceneSearch} */
		this.search = {
			name: 'hardware',
			closestHit: ( { origin, direction, cull } ) => searchHit( closestHitFn( origin, direction, select( cull, uint( 1 ), uint( 0 ) ) ).toVar() ),
			shadowHit: ( { origin, direction, maxDistance } ) => searchHit( shadowHitFn( origin, direction, maxDistance ).toVar() ),
			prepare: () => this.prepare(),
			beforeFrame: () => this.refresh(),
			failure: () => this._failure,
			reason: () => this.reason,
		};

	}

	// ---- three patch (ThreePatches.js §4) ----

	claims( code ) {

		return this.group !== null && PLACEHOLDER.test( code );

	}

	rewrite( code, group ) {

		for ( const [ name, body ] of Object.entries( BODIES ) ) {

			const at = bodyOf( code, name );
			if ( at ) code = code.slice( 0, at.open ) + body + code.slice( at.close + 1 );

		}

		return `enable wgpu_ray_query;\n${code}\n${QUERY_WGSL}` +
			`@group(${group}) @binding(0) var rayzeeTLAS: acceleration_structure;\n` +
			`@group(${group}) @binding(1) var<storage, read> rayzeeInstances: array<vec2u>;\n` +
			`@group(${group}) @binding(2) var<storage, read> rayzeeGeo: array<vec4u>;\n`;

	}

	failed( error ) {

		this._failure = String( error?.message ?? error );

	}

	// ---- structures ----

	/** Builds the structures for the stage's scene when it changed. False, with `reason`, where the walk must search. */
	prepare() {

		const source = this._source();
		if ( ! source.ok ) {

			this.reason = source.reason;
			this._release();
			return false;

		}

		if ( this._built?.geo === source.geo && this._built.table === source.table && this.scene ) {

			this.refresh();
			return true;

		}

		this._release();
		const geometries = [];
		const geometryOf = new Int32Array( source.table.templateCount ).fill( - 1 );
		for ( let t = 0; t < source.table.templateCount; t ++ ) {

			const count = source.table.tplTriCount[ t ];
			if ( count <= 0 ) continue;
			geometryOf[ t ] = geometries.length / 2;
			geometries.push( source.table.tplTriOffset[ t ] * 3, count * 3 );

		}

		if ( geometries.length === 0 ) {

			this.reason = 'no triangles';
			return false;

		}

		this._built = { geo: source.geo, table: source.table, geometryOf, geometryCount: geometries.length / 2, versions: this._versions() };
		const { words, lookup } = this._instances();
		if ( words.length / 16 > MAX_INSTANCES ) {

			this.reason = `${words.length / 16} instances: past ${MAX_INSTANCES}`;
			this._built = null;
			return false;

		}

		this._upload( source.geo );
		this.scene = this.device.createRayScene( this.backend.get( source.geo ).buffer, 16, new Uint32Array( geometries ), words );
		this._writeTable( lookup, true );
		this.reason = null;
		this._failure = null;
		return true;

	}

	/** Brings the structures in step with the scene's edits since the last frame. True when they changed. */
	refresh() {

		const built = this._built;
		if ( ! built || ! this.scene ) return false;
		const versions = this._versions();
		const was = built.versions;
		if ( versions.placements === was.placements && versions.geometry === was.geometry ) return false;
		built.versions = versions;

		const { words, lookup } = this._instances();
		let ok;
		if ( versions.geometry !== was.geometry ) {

			// Refits: positions changed (three uploads them at its next dispatch; copied now, they must be there first).
			this._upload( built.geo );
			const all = new Uint32Array( built.geometryCount ).map( ( _, i ) => i );
			ok = this.scene.updateGeometries( this.backend.get( built.geo ).buffer, all, words );

		} else {

			ok = this.scene.updateInstances( words );

		}

		if ( ! ok ) {

			// More instances than the scene was built for: build anew.
			this._built = null;
			return this.prepare();

		}

		this._writeTable( lookup, false );
		return true;

	}

	// The geo store's latest positions on the GPU now: the structures copy them before three's next dispatch would.
	_upload( geo ) {

		if ( this.backend.get( geo ).buffer ) this.backend.updateAttribute( geo );
		else this.backend.createStorageAttribute( geo );

	}

	_source() {

		const stage = this.stage;
		const table = stage._instanceTable;
		const geo = stage.triangleGeoAttr;
		if ( ! table || ! geo || ! stage.bvhStorageAttr ) return { ok: false, reason: 'no scene' };
		if ( stage.compactLayout ) return { ok: false, reason: 'compact layout: no plain positions' };
		if ( table.clusterCount > 0 ) return { ok: false, reason: 'copy clusters' };
		if ( stage._geoParts?.attrs.length > 1 ) return { ok: false, reason: 'triangle store in parts' };
		if ( stage.triangleCount > MAX_TRIANGLES ) return { ok: false, reason: `${stage.triangleCount} triangles: past ${MAX_TRIANGLES}` };
		if ( ! stage._triangleFlat && ! stage._triangleRecords?.chunks?.every( Boolean ) ) return { ok: false, reason: 'triangle records on disk' };
		if ( ! stage.cpuTree && ! stage._bvhRecords ) return { ok: false, reason: 'BVH on disk' };
		return { ok: true, table, geo };

	}

	_versions() {

		const stage = this.stage;
		return { placements: stage.placementEdits, geometry: stage.geometryEdits };

	}

	// Each template's mask: its sides (a template mixing them shows both) and whether every triangle blocks light.
	_masks() {

		const stage = this.stage;
		const table = this._built.table;
		const flat = stage._triangleFlat;
		const words = flat ? new Uint32Array( flat.buffer, flat.byteOffset, flat.length ) : null;
		const records = stage._triangleRecords;
		const views = records ? records.chunks.map( ( c ) => new Uint32Array( c.buffer, c.byteOffset, c.length ) ) : null;
		const per = records?.recordsPerChunk;
		const flagsOf = words ? ( i ) => words[ i * LANES + FLAGS_LANE ] : ( i ) => views[ ( i / per ) | 0 ][ ( i % per ) * LANES + FLAGS_LANE ];

		const masks = new Uint8Array( table.templateCount );
		const sides = new Uint8Array( table.templateCount );
		for ( let t = 0; t < table.templateCount; t ++ ) {

			let seen = 0, blocks = true;
			for ( let i = table.tplTriOffset[ t ], end = i + table.tplTriCount[ t ]; i < end; i ++ ) {

				const flags = flagsOf( i );
				seen |= 1 << ( ( flags >>> TRI_SIDE_SHIFT ) & 3 );
				blocks &&= ( ( flags >>> TRI_BLOCKER_SHIFT ) & 1 ) === 1;

			}

			// seen: 1 front, 2 back, 4 both
			sides[ t ] = seen === 1 ? 0 : seen === 2 ? 1 : 2;
			masks[ t ] = blocks ? MASK.BLOCKS : MASK.PASSES;

		}

		return { masks, sides };

	}

	// The TLAS instances (16 words each: 3×4 object-to-world rows, geometry, custom data, mask) and the table the
	// queries read ( leaf + 1, first triangle ) — one a visible placement.
	_instances() {

		const stage = this.stage;
		const { table, geometryOf } = this._built;
		const { masks, sides } = this._masks();
		const words = new Uint32Array( table.count * 16 );
		const floats = new Float32Array( words.buffer );
		const lookup = [];
		let n = 0;
		this._classes = 0;
		for ( let p = 0; p < table.count; p ++ ) {

			const template = table.sourceMesh[ p ];
			const geometry = geometryOf[ template ];
			const leaf = table.leafOfPlacement( p );
			if ( geometry < 0 || leaf < 0 || ! table.visible[ p ] ) continue;

			const records = stage._bvhRecords ? stage._bvhRecords.chunkFor( leaf ) : stage.cpuTree;
			const at = stage._bvhRecords ? stage._bvhRecords.baseOf( leaf ) : leaf * 16;
			const baked = ( new Uint32Array( records.buffer, records.byteOffset + at * 4, 2 )[ 1 ] & TLAS_LEAF_IDENTITY ) !== 0;
			const o = n * 16;
			if ( baked ) {

				floats.set( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 ], o );

			} else {

				const w = table.matrixWorldOf( p ); // column-major
				floats.set( [ w[ 0 ], w[ 4 ], w[ 8 ], w[ 12 ], w[ 1 ], w[ 5 ], w[ 9 ], w[ 13 ], w[ 2 ], w[ 6 ], w[ 10 ], w[ 14 ] ], o );

			}

			words[ o + 12 ] = geometry;
			words[ o + 13 ] = 0;
			words[ o + 14 ] = masks[ template ];
			this._classes |= masks[ template ];
			if ( leaf + 1 > LEAF_BITS ) throw new Error( `TLAS leaf ${leaf} past ${LEAF_BITS}` );
			lookup.push( ( ( baked ? 0 : leaf + 1 ) | ( sides[ template ] << SIDE_SHIFT ) ) >>> 0, table.tplTriOffset[ template ] );
			n ++;

		}

		return { words: words.subarray( 0, n * 16 ), lookup };

	}

	_writeTable( lookup, rebind ) {

		const data = new Uint32Array( 2 + lookup.length );
		data[ 0 ] = this._classes;
		data.set( lookup, 2 );
		if ( ! this.table || this.table.size < data.byteLength ) {

			this.table?.destroy();
			this.table = this.device.createBuffer( { label: 'rayzee ray query instances', size: Math.max( data.byteLength, 16 ), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
			rebind = true;

		}

		this.device.queue.writeBuffer( this.table, 0, data );
		if ( rebind ) this.group = this.device.createBindGroup( { label: 'rayzee ray queries', layout: this.layout, entries: [
			{ binding: 0, resource: this.scene },
			{ binding: 1, resource: { buffer: this.table } },
			{ binding: 2, resource: { buffer: this.backend.get( this._built.geo ).buffer } },
		] } );

	}

	_release() {

		this.scene?.destroy();
		this.scene = null;
		this.group = null;
		this._built = null;

	}

	dispose() {

		this._release();
		this.table?.destroy();
		this.table = null;
		if ( this.backend.rayQueries === this ) this.backend.rayQueries = null;
		this.stage.geoUsage = 0;

	}

}
