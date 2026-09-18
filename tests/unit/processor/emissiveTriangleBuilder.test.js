import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Three.js imports that EmissiveTriangleBuilder needs
vi.mock( 'three', () => ( {
	DataTexture: class {

		constructor( data, w, h ) {

			this.image = { data, width: w, height: h };

		}

	},
	RGBAFormat: 1023,
	FloatType: 1015,
	NearestFilter: 1003,
} ) );

// Mock LightBVHBuilder to avoid its dependencies — minimal functional stand-in:
// single leaf node, identity permutation, zeroed bit-trails.
vi.mock( '@/core/Processor/LightBVHBuilder.js', () => ( {
	LightBVHBuilder: class {

		build( tris ) {

			const n = tris.length;
			return {
				nodeData: new Float32Array( 16 ),
				nodeCount: 1,
				sortedPerm: Int32Array.from( { length: n }, ( _, i ) => i ),
				bitTrails: new Float32Array( n ),
			};

		}

	}
} ) );

import { EmissiveTriangleBuilder } from '@/core/Processor/EmissiveTriangleBuilder.js';

// TRIANGLE_DATA_LAYOUT: 20 uint lanes per tri; material flags at 18, meshIndex at 19
const FLOATS_PER_TRI = 20;
const MAT_FLAGS_OFFSET = 18;
const MESH_INDEX_OFFSET = 19;

function makeTriangleData( triangles ) {

	const data = new Uint32Array( triangles.length * FLOATS_PER_TRI );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < triangles.length; i ++ ) {

		const t = triangles[ i ];
		const base = i * FLOATS_PER_TRI;
		f[ base + 0 ] = t.posA[ 0 ]; f[ base + 1 ] = t.posA[ 1 ]; f[ base + 2 ] = t.posA[ 2 ];
		f[ base + 4 ] = t.posB[ 0 ]; f[ base + 5 ] = t.posB[ 1 ]; f[ base + 6 ] = t.posB[ 2 ];
		f[ base + 8 ] = t.posC[ 0 ]; f[ base + 9 ] = t.posC[ 1 ]; f[ base + 10 ] = t.posC[ 2 ];
		data[ base + MAT_FLAGS_OFFSET ] = t.materialIndex;
		data[ base + MESH_INDEX_OFFSET ] = t.meshIndex ?? 0;

	}

	return data;

}

// Unit triangle in XY plane: A=(0,0,0), B=(1,0,0), C=(0,1,0) → area = 0.5
const UNIT_TRI = { posA: [ 0, 0, 0 ], posB: [ 1, 0, 0 ], posC: [ 0, 1, 0 ] };
const UNIT_TRI_CY = 1 / 3; // centroid y of UNIT_TRI

const IDENT = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

/** The columns extractEmissiveTriangles reads off an InstanceTable. */
/**
 * Stands in for InstanceTable. Rows are placements; `template` says which mesh each one
 * belongs to, and defaults to one placement per mesh in order. Anything instanced pushes
 * later meshes' placements past their own index, which is the point of `placementRunOf`.
 */
function makeTable( placements ) {

	const n = placements.length;
	const table = {
		count: n, isSet: new Uint8Array( n ).fill( 1 ),
		world: new Float32Array( n * 16 ), tlasLeafIndex: new Int32Array( n ),
		sourceMesh: new Int32Array( n ),
		placementRunOf( mesh ) {

			const start = this.sourceMesh.indexOf( mesh );
			if ( start < 0 ) return null;
			let count = 0;
			while ( start + count < this.count && this.sourceMesh[ start + count ] === mesh ) count ++;
			return { start, count };

		},
	};
	placements.forEach( ( p, i ) => {

		table.world.set( p.matrixWorld || IDENT, i * 16 );
		table.tlasLeafIndex[ i ] = p.tlasLeafIndex;
		table.sourceMesh[ i ] = p.template ?? i;

	} );
	return table;

}

describe( 'EmissiveTriangleBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new EmissiveTriangleBuilder();

	} );

	// ── _calculateTriangleArea ────────────────────────────────

	describe( '_calculateTriangleArea', () => {

		it( 'unit right triangle has area 0.5', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 1, 0, 0, 0, 1, 0 );
			expect( area ).toBeCloseTo( 0.5 );

		} );

		it( 'degenerate triangle (all same point) has area 0', () => {

			const area = builder._calculateTriangleArea( 1, 1, 1, 1, 1, 1, 1, 1, 1 );
			expect( area ).toBe( 0 );

		} );

		it( 'scaled right triangle has correct area', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 2, 0, 0, 0, 3, 0 );
			expect( area ).toBeCloseTo( 3.0 );

		} );

		it( '3D triangle in arbitrary plane', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 2, 0, 0, 1, Math.sqrt( 3 ), 0 );
			expect( area ).toBeCloseTo( Math.sqrt( 3 ) );

		} );

		it( 'collinear points have area 0', () => {

			const area = builder._calculateTriangleArea( 0, 0, 0, 1, 1, 1, 2, 2, 2 );
			expect( area ).toBeCloseTo( 0 );

		} );

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'initializes with empty state', () => {

			expect( builder.emissiveTriangles ).toEqual( [] );
			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );

		} );

	} );

	// ── extractEmissiveTriangles ──────────────────────────────

	describe( 'extractEmissiveTriangles', () => {

		it( 'finds emissive triangles', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
			] );
			const materials = [
				{ emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5 },
			];

			const count = builder.extractEmissiveTriangles( triangleData, materials, 2 );
			expect( count ).toBe( 1 );
			expect( builder.emissiveTriangles[ 0 ].triangleIndex ).toBe( 1 );

		} );

		it( 'returns 0 for no emissive triangles', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];

			expect( builder.extractEmissiveTriangles( triangleData, materials, 1 ) ).toBe( 0 );

		} );

		it( 'skips triangles with missing material', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 99 } ] );
			expect( builder.extractEmissiveTriangles( triangleData, [], 1 ) ).toBe( 0 );

		} );

		it( 'ignores material visible flag (per-mesh visibility handled at BLAS-pointer level)', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5, visible: 0 } ];

			// Material visible flag no longer affects emissive extraction
			expect( builder.extractEmissiveTriangles( triangleData, materials, 1 ) ).toBe( 1 );

		} );

		it( 'calculates power as Rec.709 luma * intensity * area', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 3, g: 6, b: 9 }, emissiveIntensity: 2 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			// Rec.709 luma must match the shader (calculateEmissiveLightPdf) for MIS consistency
			const luma = 0.2126 * 3 + 0.7152 * 6 + 0.0722 * 9;
			const expectedPower = luma * 2 * 0.5; // luma * intensity * area
			expect( builder.emissiveTriangles[ 0 ].power ).toBeCloseTo( expectedPower );

		} );

		it( 'computes centroid and AABB', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const tri = builder.emissiveTriangles[ 0 ];

			// Centroid of (0,0,0),(1,0,0),(0,1,0)
			expect( tri.cx ).toBeCloseTo( 1 / 3 );
			expect( tri.cy ).toBeCloseTo( 1 / 3 );
			expect( tri.cz ).toBeCloseTo( 0 );

			// AABB
			expect( tri.bMinX ).toBe( 0 );
			expect( tri.bMinY ).toBe( 0 );
			expect( tri.bMaxX ).toBe( 1 );
			expect( tri.bMaxY ).toBe( 1 );

		} );

		it( 'accumulates totalEmissivePower across triangles', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 3 );
			const singlePower = builder.emissiveTriangles[ 0 ].power;
			expect( builder.totalEmissivePower ).toBeCloseTo( singlePower * 3 );

		} );

		it( 'builds emissiveIndicesArray and emissivePowerArray', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [
				{ emissive: { r: 1, g: 0, b: 0 }, emissiveIntensity: 2 },
				{ emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 },
			];

			builder.extractEmissiveTriangles( triangleData, materials, 3 );
			expect( builder.emissiveIndicesArray ).toHaveLength( 2 );
			expect( builder.emissivePowerArray ).toHaveLength( 2 );
			expect( builder.emissiveIndicesArray[ 0 ] ).toBe( 0 );
			expect( builder.emissiveIndicesArray[ 1 ] ).toBe( 2 );

		} );

	} );

	// ── CDF ───────────────────────────────────────────────────

	describe( 'CDF', () => {

		it( 'builds normalized CDF summing to 1.0', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.cdfArray ).toHaveLength( 2 );
			expect( builder.cdfArray[ 1 ] ).toBeCloseTo( 1.0 );

		} );

		it( 'equal-power triangles have evenly spaced CDF', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.cdfArray[ 0 ] ).toBeCloseTo( 0.5 );
			expect( builder.cdfArray[ 1 ] ).toBeCloseTo( 1.0 );

		} );

		it( 'handles zero emissive count', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.cdfArray ).toHaveLength( 1 );
			expect( builder.cdfArray[ 0 ] ).toBe( 0 );

		} );

	} );

	// ── sampleCDF ─────────────────────────────────────────────

	describe( 'sampleCDF', () => {

		it( 'returns -1 for empty set', () => {

			expect( builder.sampleCDF( 0.5 ) ).toBe( - 1 );

		} );

		it( 'returns 0 for single emissive triangle', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.sampleCDF( 0.0 ) ).toBe( 0 );
			expect( builder.sampleCDF( 0.5 ) ).toBe( 0 );
			expect( builder.sampleCDF( 1.0 ) ).toBe( 0 );

		} );

		it( 'binary search selects correct index based on CDF', () => {

			// Two triangles with different power (big has 4x area → 4x power)
			const big = { posA: [ 0, 0, 0 ], posB: [ 2, 0, 0 ], posC: [ 0, 2, 0 ], materialIndex: 0 };
			const small = { ...UNIT_TRI, materialIndex: 0 };

			const triangleData = makeTriangleData( [ big, small ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			// CDF[0] ≈ 0.8 (big tri has 4x power), CDF[1] = 1.0
			// u < CDF[0] → index 0 (big tri)
			expect( builder.sampleCDF( 0.0 ) ).toBe( 0 );
			// u > CDF[0] → index 1 (small tri)
			expect( builder.sampleCDF( 0.9 ) ).toBe( 1 );

		} );

	} );

	// ── getGPUData ────────────────────────────────────────────

	describe( 'getGPUData', () => {

		it( 'returns all required fields', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const data = builder.getGPUData();
			expect( data ).toHaveProperty( 'emissiveIndices' );
			expect( data ).toHaveProperty( 'emissivePower' );
			expect( data ).toHaveProperty( 'emissiveCDF' );
			expect( data.emissiveCount ).toBe( 1 );
			expect( data.totalPower ).toBeGreaterThan( 0 );

		} );

	} );

	// ── createEmissiveRawData ─────────────────────────────────

	describe( 'createEmissiveRawData', () => {

		it( 'returns 8-float dummy for zero emissives', () => {

			const data = builder.createEmissiveRawData();
			expect( data ).toHaveLength( 8 );

		} );

		it( 'packs 2 vec4s per entry (8 floats)', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 0 },
			] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			expect( builder.createEmissiveRawData() ).toHaveLength( 16 );

		} );

		it( 'stores triangle index, power, cdf and the owning instance in vec4[0]', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1, makeTable( [ { matrixWorld: null, tlasLeafIndex: 4 } ] ) );

			const data = builder.createEmissiveRawData();
			expect( data[ 0 ] ).toBe( 0 ); // triangleIndex
			expect( data[ 1 ] ).toBeGreaterThan( 0 ); // power
			expect( data[ 2 ] ).toBeCloseTo( 1.0 ); // CDF (single entry = 1.0)
			// Slot 3 was a repeat of power/total, which the shader recomputes; it now names the
			// TLAS leaf so sampling can put the triangle back into world space.
			expect( data[ 3 ] ).toBe( 4 );

		} );

		it( 'measures power and bounds after the instance transform', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];

			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const plainArea = builder.emissiveTriangles[ 0 ].area;

			const scaled = new ( builder.constructor )();
			// Uniform scale of 3 — area grows by 9, and the centroid moves with the translation.
			const m = [ 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 5, 0, 1 ];
			scaled.extractEmissiveTriangles( triangleData, materials, 1, makeTable( [ { matrixWorld: m, tlasLeafIndex: 0 } ] ) );
			const t = scaled.emissiveTriangles[ 0 ];

			expect( t.area ).toBeCloseTo( plainArea * 9, 5 );
			expect( t.cy ).toBeCloseTo( builder.emissiveTriangles[ 0 ].cy * 3 + 5, 5 );

		} );

		it( 'reads the placement of its own mesh, not the row that shares its index', () => {

			// Mesh 0 is instanced four times, so mesh 1's only placement is row 4. Indexing the
			// table by mesh index put row 1's matrix and leaf on mesh 1's light.
			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0, meshIndex: 1 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			const wrong = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 99, 0, 1 ];
			const right = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 7, 0, 1 ];

			const table = makeTable( [
				{ matrixWorld: null, tlasLeafIndex: 10, template: 0 },
				{ matrixWorld: wrong, tlasLeafIndex: 11, template: 0 },
				{ matrixWorld: wrong, tlasLeafIndex: 12, template: 0 },
				{ matrixWorld: wrong, tlasLeafIndex: 13, template: 0 },
				{ matrixWorld: right, tlasLeafIndex: 14, template: 1 },
			] );

			const b = new ( builder.constructor )();
			b.extractEmissiveTriangles( triangleData, materials, 1, table );

			expect( b.emissiveTriangles[ 0 ].instanceLeaf ).toBe( 14 );
			expect( b.emissiveTriangles[ 0 ].cy ).toBeCloseTo( 7 + UNIT_TRI_CY, 5 );

		} );

		it( 'stores pre-multiplied emission and area in vec4[1]', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 2, g: 3, b: 4 }, emissiveIntensity: 5 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const data = builder.createEmissiveRawData();
			expect( data[ 4 ] ).toBeCloseTo( 10 ); // 2 * 5
			expect( data[ 5 ] ).toBeCloseTo( 15 ); // 3 * 5
			expect( data[ 6 ] ).toBeCloseTo( 20 ); // 4 * 5
			expect( data[ 7 ] ).toBeCloseTo( 0.5 ); // unit tri area

		} );

	} );

	// ── createEmissiveTexture ─────────────────────────────────

	describe( 'createEmissiveTexture', () => {

		it( 'returns 1x1 dummy texture for zero emissives', () => {

			const tex = builder.createEmissiveTexture();
			expect( tex ).toBeDefined();

		} );

		it( 'creates texture for emissive data', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			const tex = builder.createEmissiveTexture();
			expect( tex ).toBeDefined();

		} );

	} );

	// ── getStats ──────────────────────────────────────────────

	describe( 'getStats', () => {

		it( 'returns zero stats when empty', () => {

			const stats = builder.getStats();
			expect( stats.count ).toBe( 0 );
			expect( stats.totalPower ).toBe( 0 );
			expect( stats.averagePower ).toBe( 0 );
			expect( stats.minPower ).toBe( 0 );
			expect( stats.maxPower ).toBe( 0 );

		} );

		it( 'computes correct min/max/average', () => {

			const big = { posA: [ 0, 0, 0 ], posB: [ 4, 0, 0 ], posC: [ 0, 4, 0 ], materialIndex: 0 };
			const small = { ...UNIT_TRI, materialIndex: 0 };

			const triangleData = makeTriangleData( [ big, small ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			const stats = builder.getStats();
			expect( stats.count ).toBe( 2 );
			expect( stats.minPower ).toBeLessThan( stats.maxPower );
			expect( stats.averagePower ).toBeCloseTo( stats.totalPower / 2 );

		} );

	} );

	// ── updateMaterialEmissive ────────────────────────────────

	describe( 'updateMaterialEmissive', () => {

		it( 'returns false when material was and remains non-emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( false );

		} );

		it( 'triggers full rescan when material becomes emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 5 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			expect( builder.emissiveCount ).toBe( 1 );

		} );

		it( 'triggers full rescan when material stops being emissive', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			expect( builder.emissiveCount ).toBe( 1 );

			materials[ 0 ] = { emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 0 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			expect( builder.emissiveCount ).toBe( 0 );

		} );

		it( 'fast-updates power when emissive intensity changes (via the buildLightBVH that always follows)', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );
			const oldPower = builder.totalEmissivePower;

			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 10 };
			expect( builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 1 ) ).toBe( true );
			builder.buildLightBVH(); // production flow: SceneProcessor rebuilds after every change
			expect( builder.totalEmissivePower ).toBeGreaterThan( oldPower );
			expect( builder.totalEmissivePower ).toBeCloseTo( oldPower * 10 );

		} );

		it( 'fast-updates CDF and raw data after power change', () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1 },
			] );
			const materials = [
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 },
			];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );

			// Change mat 0 intensity → CDF + packed data rebuilt by the follow-up build
			materials[ 0 ] = { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 100 };
			builder.updateMaterialEmissive( 0, materials[ 0 ], triangleData, materials, 2 );
			builder.buildLightBVH();

			// Last CDF entry always 1.0; mat-0 entry dominates the distribution
			expect( builder.cdfArray[ builder.cdfArray.length - 1 ] ).toBeCloseTo( 1.0 );
			expect( builder.emissivePowerArray[ 0 ] ).toBeCloseTo( builder.emissivePowerArray[ 1 ] * 100 );
			// Pre-multiplied emission in vec4[1] reflects the new intensity
			expect( builder.emissiveTriangleData[ 4 ] ).toBeCloseTo( 100 );

		} );

	} );

	// ── setHiddenMeshes / per-mesh visibility ─────────────────

	describe( 'setHiddenMeshes', () => {

		const twoMeshSetup = () => {

			const triangleData = makeTriangleData( [
				{ ...UNIT_TRI, materialIndex: 0, meshIndex: 0 },
				{ ...UNIT_TRI, materialIndex: 1, meshIndex: 1 },
			] );
			const materials = [
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 2 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 4 },
			];
			builder.extractEmissiveTriangles( triangleData, materials, 2 );
			builder.buildLightBVH();

		};

		it( 'hiding an emissive mesh removes its triangles from the sampled set', () => {

			twoMeshSetup();
			const fullPower = builder.totalEmissivePower;

			expect( builder.setHiddenMeshes( new Set( [ 0 ] ) ) ).toBe( true );
			builder.buildLightBVH();

			expect( builder.emissiveCount ).toBe( 1 );
			expect( builder.totalEmissivePower ).toBeCloseTo( fullPower * ( 4 / 6 ) );
			expect( builder.emissiveIndicesArray[ 0 ] ).toBe( 1 );
			// Hidden triangle's bit-trail is -1 (not in the Light BVH)
			expect( builder.emissiveBitTrailMap[ 0 ] ).toBe( - 1 );
			expect( builder.emissiveBitTrailMap[ 1 ] ).not.toBe( - 1 );

		} );

		it( 'returns false when hidden meshes own no emissive triangles', () => {

			twoMeshSetup();
			expect( builder.setHiddenMeshes( new Set( [ 99 ] ) ) ).toBe( false );

		} );

		it( 'returns false when the effective hidden set is unchanged', () => {

			twoMeshSetup();
			expect( builder.setHiddenMeshes( new Set( [ 1 ] ) ) ).toBe( true );
			expect( builder.setHiddenMeshes( new Set( [ 1, 99 ] ) ) ).toBe( false );

		} );

		it( 'unhiding restores the full sampled set', () => {

			twoMeshSetup();
			const fullPower = builder.totalEmissivePower;

			builder.setHiddenMeshes( new Set( [ 0 ] ) );
			builder.buildLightBVH();
			expect( builder.setHiddenMeshes( new Set() ) ).toBe( true );
			builder.buildLightBVH();

			expect( builder.emissiveCount ).toBe( 2 );
			expect( builder.totalEmissivePower ).toBeCloseTo( fullPower );

		} );

		it( 'hiding all emitters yields the empty-set dummy Light BVH', () => {

			twoMeshSetup();
			builder.setHiddenMeshes( new Set( [ 0, 1 ] ) );
			const nodeCount = builder.buildLightBVH();

			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );
			expect( nodeCount ).toBe( 1 );
			expect( builder.emissiveBitTrailMap.every( v => v === - 1 ) ).toBe( true );

		} );

		it( 'canonical set survives hide → material edit → unhide', () => {

			twoMeshSetup();
			builder.setHiddenMeshes( new Set( [ 0 ] ) );
			builder.buildLightBVH();

			// Edit the HIDDEN mesh's material while it's hidden
			const materials = [
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 20 },
				{ emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 4 },
			];
			builder.updateMaterialEmissive( 0, materials[ 0 ], null, materials, 2 );
			builder.buildLightBVH();
			expect( builder.emissiveCount ).toBe( 1 ); // still hidden

			builder.setHiddenMeshes( new Set() );
			builder.buildLightBVH();
			expect( builder.emissiveCount ).toBe( 2 );
			// The edit made while hidden is reflected once visible again (luma(1,1,1)=1, area 0.5)
			expect( builder.totalEmissivePower ).toBeCloseTo( 20 * 0.5 + 4 * 0.5 );

		} );

	} );

	// ── clear ─────────────────────────────────────────────────

	describe( 'clear', () => {

		it( 'resets all state', () => {

			const triangleData = makeTriangleData( [ { ...UNIT_TRI, materialIndex: 0 } ] );
			const materials = [ { emissive: { r: 1, g: 1, b: 1 }, emissiveIntensity: 1 } ];
			builder.extractEmissiveTriangles( triangleData, materials, 1 );

			builder.clear();

			expect( builder.emissiveTriangles ).toEqual( [] );
			expect( builder.emissiveCount ).toBe( 0 );
			expect( builder.totalEmissivePower ).toBe( 0 );
			expect( builder.emissiveIndicesArray ).toBeNull();
			expect( builder.emissivePowerArray ).toBeNull();
			expect( builder.cdfArray ).toBeNull();
			expect( builder.lightBVHNodeData ).toBeNull();
			expect( builder.lightBVHNodeCount ).toBe( 0 );

		} );

	} );

} );
