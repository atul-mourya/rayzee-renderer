/**
 * The hardware search's structures, on a stand-in device: which instances a scene gets and how they are packed, where
 * it keeps the walk, and how edits reach the structures. The searches themselves need a device with ray queries
 * (a patched Deno); bench and GPU checks cover those.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { HardwareSearch, hardwareSearchSupported, RAY_QUERY_FEATURE } from '@/core/pathtracer/HardwareSearch.js';
import { TRI_SIDE_SHIFT, TRI_BLOCKER_SHIFT, TLAS_LEAF_IDENTITY } from '@/core/scene/BufferLayout.js';

beforeAll( () => {

	globalThis.GPUShaderStage ??= { COMPUTE: 4 };
	globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };

} );

const LANES = 20;

function device() {

	const calls = { scenes: [], updates: [], writes: [] };
	return {
		calls,
		features: new Set( [ RAY_QUERY_FEATURE ] ),
		createBindGroupLayout: () => ( {} ),
		createBindGroup: () => ( {} ),
		createBuffer: ( { size } ) => ( { size, destroy() {} } ),
		queue: { writeBuffer: ( _buffer, _offset, data ) => calls.writes.push( Array.from( data ) ) },
		createRayScene( _vertices, stride, geometries, words ) {

			const scene = {
				capacity: words.length / 16,
				updateInstances( w ) {

					calls.updates.push( { kind: 'instances', words: Array.from( w ) } );
					return w.length / 16 <= this.capacity;

				},
				updateGeometries( _vertices, g, w ) {

					calls.updates.push( { kind: 'geometries', geometries: Array.from( g ), words: Array.from( w ) } );
					return true;

				},
				destroy() {

					this.destroyed = true;

				},
			};
			calls.scenes.push( { stride, geometries: Array.from( geometries ), words: Array.from( words ), scene } );
			return scene;

		},
	};

}

// Three templates: 0 (2 triangles, front, blocks) placed twice — baked at leaf 5, moved at leaf 6 — 1 (1 triangle, back,
// one triangle lets light through) placed once at leaf 7 and hidden, 2 (1 triangle, both sides) at leaf 8.
function stage( { gpu = device(), ...overrides } = {} ) {

	const triangles = new Uint32Array( 4 * LANES );
	const flags = [ ( 0 << TRI_SIDE_SHIFT ) | ( 1 << TRI_BLOCKER_SHIFT ), ( 0 << TRI_SIDE_SHIFT ) | ( 1 << TRI_BLOCKER_SHIFT ), 1 << TRI_SIDE_SHIFT, ( 2 << TRI_SIDE_SHIFT ) | ( 1 << TRI_BLOCKER_SHIFT ) ];
	flags.forEach( ( f, i ) => triangles[ i * LANES + 18 ] = f );
	const tree = new Float32Array( 16 * 9 );
	new Uint32Array( tree.buffer )[ 5 * 16 + 1 ] = TLAS_LEAF_IDENTITY;
	const moved = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1 ]; // column-major: translation (3, 4, 5)
	const identity = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
	const table = {
		count: 4, templateCount: 3, clusterCount: 0,
		tplTriOffset: [ 0, 2, 3 ], tplTriCount: [ 2, 1, 1 ],
		sourceMesh: [ 0, 0, 1, 2 ], visible: [ 1, 1, 0, 1 ],
		leafOfPlacement: ( p ) => [ 5, 6, 7, 8 ][ p ],
		matrixWorldOf: ( p ) => ( p === 1 ? moved : identity ),
	};
	const geo = { name: 'geo' };
	const backend = {
		device: gpu,
		get: () => ( { buffer: { name: 'gpu geo' } } ),
		updateAttribute() {},
		createStorageAttribute() {},
	};
	return {
		gpu,
		renderer: { backend },
		_instanceTable: table,
		triangleGeoAttr: geo,
		bvhStorageAttr: {},
		compactLayout: false,
		_geoParts: { attrs: [ geo ] },
		_triangleFlat: new Float32Array( triangles.buffer ),
		cpuTree: tree,
		placementEdits: 0,
		geometryEdits: 0,
		...overrides,
	};

}

describe( 'HardwareSearch', () => {

	it( 'needs a device with ray queries and the scene binding', () => {

		expect( hardwareSearchSupported( null ) ).toBe( false );
		expect( hardwareSearchSupported( { features: new Set( [ RAY_QUERY_FEATURE ] ) } ) ).toBe( false );
		expect( hardwareSearchSupported( { features: new Set(), createRayScene() {} } ) ).toBe( false );
		expect( hardwareSearchSupported( device() ) ).toBe( true );

	} );

	it( 'builds a BLAS a template and an instance a visible placement', () => {

		const s = stage();
		const search = new HardwareSearch( s );
		expect( search.prepare() ).toBe( true );
		const [ built ] = s.gpu.calls.scenes;
		// [ first vertex, vertex count ] a template: the geo store's rows, three a triangle
		expect( built.stride ).toBe( 16 );
		expect( built.geometries ).toEqual( [ 0, 6, 6, 3, 9, 3 ] );
		const words = new Uint32Array( built.words );
		const floats = new Float32Array( words.buffer );
		expect( words.length / 16 ).toBe( 3 ); // the hidden placement is left out
		// baked: identity rows; moved: row-major object-to-world
		expect( Array.from( floats.subarray( 0, 12 ) ) ).toEqual( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 ] );
		expect( Array.from( floats.subarray( 16, 28 ) ) ).toEqual( [ 1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 5 ] );
		// geometry, then the mask: 1 blocks outright, 2 lets light through
		expect( [ words[ 12 ], words[ 14 ] ] ).toEqual( [ 0, 1 ] );
		expect( [ words[ 28 ], words[ 30 ] ] ).toEqual( [ 0, 1 ] );
		expect( [ words[ 44 ], words[ 46 ] ] ).toEqual( [ 2, 1 ] );
		// the table: classes, then ( leaf + 1 | side << 24, first triangle ) an instance — 0 for a baked one
		expect( s.gpu.calls.writes.at( - 1 ) ).toEqual( [ 1, 0, 0, 0, 7, 0, 9 | ( 2 << 24 ), 3 ] );

	} );

	it( 'counts a template that lets light through, or mixes sides, as such', () => {

		const s = stage();
		s._instanceTable.visible = [ 1, 1, 1, 1 ];
		new HardwareSearch( s ).prepare();
		const words = new Uint32Array( s.gpu.calls.scenes[ 0 ].words );
		expect( words[ 2 * 16 + 14 ] ).toBe( 2 );
		expect( s.gpu.calls.writes.at( - 1 ).slice( 6, 8 ) ).toEqual( [ 8 | ( 1 << 24 ), 2 ] );
		expect( s.gpu.calls.writes.at( - 1 )[ 0 ] ).toBe( 3 );

	} );

	it( 'keeps the walk for a scene it cannot hold', () => {

		for ( const [ overrides, reason ] of [
			[ { compactLayout: true }, /compact/ ],
			[ { _geoParts: { attrs: [ {}, {} ] } }, /parts/ ],
			[ { _triangleFlat: null, _triangleRecords: { chunks: [ null ] } }, /on disk/ ],
			[ { _instanceTable: null }, /no scene/ ],
		] ) {

			const search = new HardwareSearch( stage( overrides ) );
			expect( search.prepare() ).toBe( false );
			expect( search.reason ).toMatch( reason );
			expect( search.claims( 'fn rayzeeRayQueryClosestHit( origin: vec3f' ) ).toBe( false );

		}

		const clustered = stage();
		clustered._instanceTable.clusterCount = 2;
		expect( new HardwareSearch( clustered ).prepare() ).toBe( false );

	} );

	it( 'follows edits: placements rebuild the instances, geometry the BLASes too', () => {

		const s = stage();
		const search = new HardwareSearch( s );
		search.prepare();
		expect( search.refresh() ).toBe( false );
		s.placementEdits ++;
		expect( search.refresh() ).toBe( true );
		expect( s.gpu.calls.updates.at( - 1 ).kind ).toBe( 'instances' );
		s.geometryEdits ++;
		expect( search.refresh() ).toBe( true );
		expect( s.gpu.calls.updates.at( - 1 ) ).toMatchObject( { kind: 'geometries', geometries: [ 0, 1, 2 ] } );
		// a refit of template 2's triangle (3) rebuilds its BLAS alone; edits of unknown extent rebuild every one
		s.takeGeometryEdits = () => [[ 3, 1 ]];
		s.geometryEdits ++;
		search.refresh();
		expect( s.gpu.calls.updates.at( - 1 ) ).toMatchObject( { kind: 'geometries', geometries: [ 2 ] } );
		s.takeGeometryEdits = () => null;
		s.geometryEdits ++;
		search.refresh();
		expect( s.gpu.calls.updates.at( - 1 ).geometries ).toEqual( [ 0, 1, 2 ] );
		// more instances than the scene was built for: built anew
		s._instanceTable.visible = [ 1, 1, 1, 1 ];
		s.placementEdits ++;
		expect( search.refresh() ).toBe( true );
		expect( s.gpu.calls.scenes.length ).toBe( 2 );
		expect( s.gpu.calls.scenes[ 0 ].scene.destroyed ).toBe( true );

	} );

	it( 'rewrites a kernel that calls its placeholders, and binds its structures after three\'s groups', () => {

		const s = stage();
		const search = new HardwareSearch( s );
		expect( s.renderer.backend.rayQueries ).toBe( search );
		expect( s.geoUsage ).toBe( 1 << 10 ); // the geo store is created as a BLAS input, built from in place
		search.prepare();
		const kernel = 'fn rayzeeRayQueryClosestHit ( origin: vec3f, direction: vec3f, cull: u32 ) -> vec4u {\n\treturn vec4u( 0u );\n}\nfn main() {}\n';
		expect( search.claims( kernel ) ).toBe( true );
		expect( search.claims( 'fn main() {}' ) ).toBe( false );
		const code = search.rewrite( kernel, 2 );
		expect( code.startsWith( 'enable wgpu_ray_query;' ) ).toBe( true );
		expect( code ).toContain( 'rayQueryInitialize' );
		expect( code ).not.toContain( 'return vec4u( 0u );' );
		expect( code ).toContain( '@group(2) @binding(0) var rayzeeTLAS: acceleration_structure;' );
		// never a candidate loop: naga's Metal output does not end one
		expect( code ).not.toMatch( /while\s*\(\s*rayQueryProceed/ );
		search.dispose();
		expect( s.renderer.backend.rayQueries ).toBe( null );
		expect( s.geoUsage ).toBe( 0 );

	} );

} );
