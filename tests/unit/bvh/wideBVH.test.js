import { describe, it, expect, vi } from 'vitest';
import { BVH_LEAF_MARKERS, BVH_FOLDED_LEAF_MAX, WIDE_NODE, CLUSTER_COUNT_SHIFT, encodeClusterBoxes, packCopyRecord, unpackCopyRecord, COMPACT_RECORD_LANES } from '@/core/scene/BufferLayout.js';
import { Matrix4, Quaternion, Vector3 } from 'three';

vi.mock( '@/core/bvh/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	},
} ) );

import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { collapse, collapseSteps, WideWriter } from '@/core/bvh/WideBVH.js';

const LANES = 20;
const BASE_SLOT = [ 2, 4, 5 ];

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function triangles( n ) {

	const data = new Uint32Array( n * LANES );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < n; i ++ ) {

		const s = 10 ** ( rand() * 3 - 2 );
		const x = rand() * 20, y = rand() * 20, z = rand() * 20;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + rand() * s, y + rand() * s * 0.2, z ], i * LANES + 4 );
		f.set( [ x, y + rand() * s, z + rand() * s ], i * LANES + 8 );
		data[ i * LANES + 19 ] = i;

	}

	return data;

}

function binaryTree( n ) {

	const builder = new BVHBuilder();
	builder.enableReinsertionOptimization = false;
	builder.useMortonCodes = false;
	const bvh = builder.flattenBVH( builder.buildSync( triangles( n ) ) );
	return { nodes: bvh instanceof Float32Array ? bvh : new Float32Array( bvh ), triangles: builder.reorderedTriangleData };

}

// Child k's box of a wide node, decoded as the traversal decodes it.
function childBox( u, f, o, k ) {

	const out = [];
	for ( let a = 0; a < 3; a ++ ) {

		const step = 2 ** ( ( ( u[ o + 1 ] >>> ( a * 8 ) ) & 255 ) - 127 );
		const base = f[ o + BASE_SLOT[ a ] ];
		out[ a ] = base + ( ( u[ o + 6 + a ] >>> ( k * 8 ) ) & 255 ) * step;
		out[ 3 + a ] = base + ( ( u[ o + 9 + a ] >>> ( k * 8 ) ) & 255 ) * step;

	}

	return out;

}

describe( 'collapse to a 4-wide tree', () => {

	it( 'reaches every triangle once, inside every box on its way down', () => {

		const { nodes, triangles: tris } = binaryTree( 5000 );
		const u = new Uint32Array( nodes.buffer, nodes.byteOffset, nodes.length );
		const out = new WideWriter();
		const { root, stack } = collapse( { f: nodes, u, at: ( n ) => n * 16 }, 0, out );
		expect( root ).toBe( 0 );

		const f32 = new Float32Array( tris.buffer, tris.byteOffset, tris.length );
		const seen = new Uint8Array( 5000 );
		const visit = ( ref, box ) => {

			let first, count;
			if ( ref >= 0x80000000 ) {

				const v = ( ~ ref ) >>> 0;
				first = v >>> 4;
				count = v & BVH_FOLDED_LEAF_MAX;

			} else {

				const w = out.at( ref );
				if ( w.u[ w.o + 3 ] === WIDE_NODE ) {

					expect( w.u[ w.o ] ).toBeGreaterThan( 1 );
					for ( let k = 0; k < w.u[ w.o ]; k ++ ) visit( w.u[ w.o + 12 + k ], childBox( w.u, w.f, w.o, k ) );
					return;

				}

				expect( w.u[ w.o + 3 ] ).toBe( BVH_LEAF_MARKERS.TRIANGLE_LEAF );
				first = w.u[ w.o ];
				count = w.u[ w.o + 1 ];

			}

			for ( let t = first; t < first + count; t ++ ) {

				seen[ t ] ++;
				if ( ! box ) continue;
				for ( let c = 0; c < 3; c ++ ) for ( let a = 0; a < 3; a ++ ) {

					const v = f32[ t * LANES + c * 4 + a ];
					expect( v ).toBeGreaterThanOrEqual( box[ a ] );
					expect( v ).toBeLessThanOrEqual( box[ 3 + a ] );

				}

			}

		};

		visit( root, null );
		expect( Array.from( seen ).every( ( v ) => v === 1 ) ).toBe( true );
		expect( out.count ).toBeLessThan( nodes.length / 16 / 2 );

		// The walk's stack: a wide node pushes all its children, the nearest's walk on top of the rest.
		const need = ( ref ) => {

			if ( ref >= 0x80000000 ) return 0;
			const w = out.at( ref );
			if ( w.u[ w.o + 3 ] !== WIDE_NODE ) return 0;
			const c = w.u[ w.o ];
			let deepest = 0;
			for ( let k = 0; k < c; k ++ ) deepest = Math.max( deepest, need( w.u[ w.o + 12 + k ] ) );
			return Math.max( c, c - 1 + deepest );

		};

		expect( stack ).toBe( need( root ) );
		expect( stack ).toBeGreaterThan( 4 );

	} );

	it( 'in steps: asks for nodes not loaded, and sends pages and late nodes to the same places', () => {

		const { nodes } = binaryTree( 3000 );
		const u = new Uint32Array( nodes.buffer, nodes.byteOffset, nodes.length );
		const whole = new WideWriter( 7 );
		collapse( { f: nodes, u, at: ( n ) => n * 16 }, 0, whole );

		// Eight loaded pages of 64 binary nodes (an expansion reads up to seven nodes); wide pages of 16.
		const loaded = new Map();
		const src = { f: null, u: null, at( n ) {

			const page = loaded.get( n >> 6 );
			if ( ! page ) return - 1;
			this.f = page.f;
			this.u = page.u;
			return ( n & 63 ) * 16;

		} };
		const sent = new Float32Array( ( whole.count + 7 ) * 16 );
		let sends = 0;
		const out = new WideWriter( 7, ( first, data ) => {

			sends ++;
			sent.set( data, first * 16 );

		}, 16 );
		const steps = collapseSteps( src, 0, out );
		let step, needs = 0;
		while ( ! ( step = steps.next() ).done ) {

			if ( step.value.need === undefined ) {

				out.flush();
				continue;

			}

			needs ++;
			const p = step.value.need >> 6;
			if ( loaded.size >= 8 ) loaded.delete( loaded.keys().next().value );
			const f = nodes.slice( p * 64 * 16, ( p + 1 ) * 64 * 16 );
			loaded.set( p, { f, u: new Uint32Array( f.buffer ) } );

		}

		out.flush( true );
		expect( needs ).toBeGreaterThan( nodes.length / 16 / 64 );
		expect( step.value.root ).toBe( 7 );
		expect( sends ).toBeGreaterThan( whole.count / 16 );
		for ( let n = 7; n < 7 + whole.count; n ++ ) {

			const a = whole.at( n );
			expect( Array.from( sent.subarray( n * 16, n * 16 + 16 ) ) ).toEqual( Array.from( a.f.subarray( a.o, a.o + 16 ) ) );

		}

	} );

	it( 'packs a copy record to 32 bytes: near the origin within 2e-5 of a copy\'s size, far out what 12 lanes lose', () => {

		const m = new Matrix4(), inv = new Matrix4(), q = new Quaternion(), axis = new Vector3();
		const record = new Float32Array( 12 ), out = new Float32Array( 12 );
		const packed = new Float32Array( COMPACT_RECORD_LANES ), packedU = new Uint32Array( packed.buffer );
		// Points around each copy, in its own units, back through each record. Far out both lose what an f32 position
		// there holds, over the copy's scale.
		const errors = ( spread ) => {

			let packedWorst = 0, originalWorst = 0;
			for ( let i = 0; i < 1000; i ++ ) {

				axis.set( rand() - 0.5, rand() - 0.5, rand() - 0.5 ).normalize();
				q.setFromAxisAngle( axis, rand() * Math.PI * 2 );
				const s = 10 ** ( rand() * 3 - 1 );
				m.compose( new Vector3( rand() - 0.5, rand() - 0.5, rand() - 0.5 ).multiplyScalar( spread ), q, new Vector3( s, s * ( 0.25 + rand() * 4 ), s * ( i % 7 === 0 ? - 1 : 1 ) ) );
				const e = inv.copy( m ).invert().elements;
				record.set( [ e[ 0 ], e[ 4 ], e[ 8 ], e[ 12 ], e[ 1 ], e[ 5 ], e[ 9 ], e[ 13 ], e[ 2 ], e[ 6 ], e[ 10 ], e[ 14 ] ] );
				expect( packCopyRecord( record, 0, packed, packedU, 0 ) ).toBeLessThan( 1e-5 );
				unpackCopyRecord( packed, packedU, 0, out );
				for ( let k = 0; k < 4; k ++ ) {

					const local = new Vector3( rand() - 0.5, rand() - 0.5, rand() - 0.5 );
					const p = local.clone().applyMatrix4( m );
					for ( let r = 0; r < 3; r ++ ) {

						const want = local.getComponent( r );
						const original = record[ r * 4 ] * p.x + record[ r * 4 + 1 ] * p.y + record[ r * 4 + 2 ] * p.z + record[ r * 4 + 3 ];
						const got = out[ r * 4 ] * ( p.x - packed[ 0 ] ) + out[ r * 4 + 1 ] * ( p.y - packed[ 1 ] ) + out[ r * 4 + 2 ] * ( p.z - packed[ 2 ] );
						packedWorst = Math.max( packedWorst, Math.abs( got - want ) );
						originalWorst = Math.max( originalWorst, Math.abs( original - want ) );

					}

				}

			}

			return { packedWorst, originalWorst };

		};

		expect( errors( 1 ).packedWorst ).toBeLessThan( 2e-5 );
		const far = errors( 4e5 );
		expect( far.packedWorst ).toBeLessThan( far.originalWorst * 2 );

	} );

	it( 'says how sheared a record is', () => {

		const record = Float32Array.of( 1, 0.3, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7 );
		const packed = new Float32Array( COMPACT_RECORD_LANES );
		expect( packCopyRecord( record, 0, packed, new Uint32Array( packed.buffer ), 0 ) ).toBeGreaterThan( 0.2 );

	} );

} );
