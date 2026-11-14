/**
 * Volumes on the GPU against the grid read on the CPU: ratio-tracking transmittance and delta-tracking free flight
 * through a constant grid and a varying one under a turned, scaled object (the world → grid rows, the majorant walk,
 * the packed atlas and its filtering), and the emission integral.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Data3DTexture, RedFormat, RGFormat, HalfFloatType, LinearFilter, Vector3, Euler } from 'three';
import { float, vec4, uint, uniform, uniformArray, texture3D, select } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { Volume, VolumeGrid, packVolumes, writeVolumeHeaders, volumeUniformArray } from '@/core/scene/Volumes.js';
import { volumeTransmittance, volumeFreeFlight, volumeEmission } from '@/core/shaders/Volume.js';

function gpuVolumes( volumeList ) {

	const packed = packVolumes( volumeList );
	const [ w, h, d ] = packed.size;
	const atlas = new Data3DTexture( packed.data, w, h, d );
	atlas.format = packed.channels === 2 ? RGFormat : RedFormat;
	atlas.type = HalfFloatType;
	atlas.minFilter = atlas.magFilter = LinearFilter;
	atlas.unpackAlignment = 1;
	atlas.needsUpdate = true;
	const headers = volumeUniformArray();
	writeVolumeHeaders( headers, packed.entries );
	return {
		packed,
		nodes: {
			headers: uniformArray( headers, 'vec4' ), atlas: texture3D( atlas ), invAtlasSize: uniform( new Vector3( 1 / w, 1 / h, 1 / d ) ),
			count: uniform( packed.entries.length, 'int' ), emission: packed.channels > 1, seed: uniform( 7, 'uint' ),
		},
	};

}

// The packed grid as the GPU filters it: trilinear over voxel centres at index + 0.5, zero past the grid.
function cpuField( entry, channel = 0 ) {

	const grid = channel ? entry.emission : entry.grid;
	const { width: w, height: h, depth: d, data } = grid;
	const at = ( x, y, z ) => ( x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d ? 0 : data[ x + w * ( y + h * z ) ] );
	return ( q ) => {

		const x = q[ 0 ] - 0.5, y = q[ 1 ] - 0.5, z = q[ 2 ] - 0.5;
		const x0 = Math.floor( x ), y0 = Math.floor( y ), z0 = Math.floor( z );
		const fx = x - x0, fy = y - y0, fz = z - z0;
		let v = 0;
		for ( let k = 0; k < 8; k ++ ) {

			const dx = k & 1, dy = ( k >> 1 ) & 1, dz = k >> 2;
			v += at( x0 + dx, y0 + dy, z0 + dz ) * ( dx ? fx : 1 - fx ) * ( dy ? fy : 1 - fy ) * ( dz ? fz : 1 - fz );

		}

		return v;

	};

}

// ∫ field along origin + t · dir over [ 0, tMax ], in the volume's grid space (its header rows), by Simpson's rule.
function cpuIntegral( headers, field, origin, dir, tMax ) {

	const row = ( r ) => headers[ r ];
	const toGrid = ( p ) => [ 0, 1, 2 ].map( ( r ) => row( r ).x * p[ 0 ] + row( r ).y * p[ 1 ] + row( r ).z * p[ 2 ] + row( r ).w );
	const size = [ headers[ 4 ].x, headers[ 4 ].y, headers[ 4 ].z ];
	const steps = 4000, hstep = tMax / steps;
	const f = ( t ) => {

		const q = toGrid( [ origin[ 0 ] + dir[ 0 ] * t, origin[ 1 ] + dir[ 1 ] * t, origin[ 2 ] + dir[ 2 ] * t ] );
		return q.every( ( v, i ) => v >= 0 && v <= size[ i ] ) ? field( q ) : 0;

	};

	let sum = f( 0 ) + f( tMax );
	for ( let k = 1; k < steps; k ++ ) sum += f( k * hstep ) * ( k % 2 ? 4 : 2 );
	return sum * hstep / 3;

}

const N = 1 << 16;

describeGPU( 'volumes', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );
	afterAll( () => renderer?.dispose() );

	// Each element: a ray ( origin, tMax ), ( dir ) and a seed; `rays` lists the distinct rays, repeated.
	const run = ( volumes, rays, fn, outType = 'float' ) => {

		const o = new Float32Array( N * 4 ), d = new Float32Array( N * 4 ), seeds = new Uint32Array( N );
		for ( let i = 0; i < N; i ++ ) {

			const [ origin, dir, tMax ] = rays[ i % rays.length ];
			o.set( [ ...origin, tMax ], i * 4 );
			d.set( [ ...dir, 0 ], i * 4 );
			seeds[ i ] = ( Math.imul( i + 1, 0x9E3779B9 ) ^ 0x51ed270b ) >>> 0;

		}

		return evaluate( renderer, N, { o: [ o, 'vec4' ], d: [ d, 'vec4' ], seed: [ seeds, 'uint' ] }, outType, ( a ) => {

			const rng = uint( a.seed ).toVar();
			return fn( volumes, a.o.xyz.toVar(), a.d.xyz.toVar(), a.o.w.toVar(), rng, a.seed );

		} );

	};

	// Per ray: the mean of the outputs, over its N / rays.length draws.
	const means = ( out, rays, stride = 1, channel = 0 ) => rays.map( ( _, r ) => {

		let sum = 0, n = 0;
		for ( let i = r; i < N; i += rays.length ) {

			sum += out[ i * stride + channel ];
			n ++;

		}

		return sum / n;

	} );

	const constant = ( density ) => {

		const volume = new Volume( VolumeGrid.fromFunction( 16, () => 1 ), { density } );
		return volume;

	};

	const varying = () => {

		const grid = VolumeGrid.fromFunction( [ 24, 18, 30 ], ( x, y, z ) => 0.6 + 0.4 * Math.sin( 9 * x ) * Math.cos( 7 * y + 2 * z ) + ( x > 0.1 && y < 0 ? 0.8 : 0 ) );
		const volume = new Volume( grid, { density: 3 } );
		volume.rotation.copy( new Euler( 0.4, - 0.7, 0.25 ) );
		volume.scale.set( 1.6, 0.9, 1.2 );
		volume.position.set( 0.3, - 0.2, 0.1 );
		return volume;

	};

	const rays = [
		[[ - 2, 0, 0 ], [ 1, 0, 0 ], 10 ],
		[[ - 2, 0.1, - 0.2 ], new Vector3( 1, 0.2, 0.3 ).normalize().toArray(), 10 ],
		[[ 0, 0, 0 ], new Vector3( - 0.3, 1, 0.2 ).normalize().toArray(), 10 ],
		[[ 0.1, 0.05, 0 ], new Vector3( 0.5, - 0.5, 0.7 ).normalize().toArray(), 0.3 ],
		[[ 3, 3, 3 ], new Vector3( - 1, - 1, - 1 ).normalize().toArray(), 10 ],
		[[ 3, 0, 0 ], [ 1, 0, 0 ], 10 ],
	];

	for ( const [ name, make ] of [[ 'a constant grid', () => constant( 1.5 ) ], [ 'a varying grid under a turned, scaled object', varying ]] ) {

		it( `lets through what the grid's optical depth says, in ${name}`, async () => {

			const { packed, nodes } = gpuVolumes( [ make() ] );
			const headers = volumeUniformArray();
			writeVolumeHeaders( headers, packed.entries );
			const field = cpuField( packed.entries[ 0 ] );
			const sigma = packed.entries[ 0 ].volume.density;
			const out = new Float32Array( await run( nodes, rays, ( v, o, d, tMax ) => volumeTransmittance( v, o, d, tMax ) ) );
			const got = means( out, rays );
			rays.forEach( ( [ origin, dir, tMax ], r ) => {

				const expected = Math.exp( - sigma * cpuIntegral( headers, field, origin, dir, tMax ) );
				expect( Math.abs( got[ r ] - expected ), `ray ${r}: ${got[ r ]} against ${expected}` ).toBeLessThan( 0.01 );

			} );

		} );

		it( `collides where the grid's free flight says, in ${name}`, async () => {

			const { packed, nodes } = gpuVolumes( [ make() ] );
			const headers = volumeUniformArray();
			writeVolumeHeaders( headers, packed.entries );
			const field = cpuField( packed.entries[ 0 ] );
			const sigma = packed.entries[ 0 ].volume.density;
			// ( collided, t ): collisions before tMax by half of it, so the distribution's shape is tested too.
			const out = new Float32Array( await run( nodes, rays, ( v, o, d, tMax, rng, seed ) => {

				const first = float( uint( seed ).bitAnd( uint( 0xffff ) ) ).div( 65536.0 );
				const flight = volumeFreeFlight( v, o, d, tMax, first, rng );
				return vec4( select01( flight.index.greaterThanEqual( 0 ) ), select01( flight.t.lessThan( tMax.mul( 0.5 ) ) ), 0, 0 );

			}, 'vec4' ) );
			const collided = means( out, rays, 4, 0 );
			const early = means( out, rays, 4, 1 );
			rays.forEach( ( [ origin, dir, tMax ], r ) => {

				const all = 1 - Math.exp( - sigma * cpuIntegral( headers, field, origin, dir, tMax ) );
				const half = 1 - Math.exp( - sigma * cpuIntegral( headers, field, origin, dir, tMax / 2 ) );
				expect( Math.abs( collided[ r ] - all ), `ray ${r}: ${collided[ r ]} against ${all}` ).toBeLessThan( 0.01 );
				expect( Math.abs( early[ r ] - half ), `ray ${r} half: ${early[ r ]} against ${half}` ).toBeLessThan( 0.01 );

			} );

		} );

	}

	it( 'gives the integral of its emission along a ray', async () => {

		const volume = varying();
		volume.emissionGrid = VolumeGrid.fromFunction( [ 24, 18, 30 ], ( x, y, z ) => Math.max( 0, 1 - 3 * Math.hypot( x, y, z ) ) );
		volume.emissionGrid.transform.copy( volume.grid.transform );
		volume.emissionStrength = 2;
		volume.emissionColor.setRGB( 1, 0.5, 0.25 );
		const { packed, nodes } = gpuVolumes( [ volume ] );
		const headers = volumeUniformArray();
		writeVolumeHeaders( headers, packed.entries );
		const field = cpuField( packed.entries[ 0 ], 1 );
		const out = new Float32Array( await run( nodes, rays, ( v, o, d, tMax, rng ) => vec4( volumeEmission( v, o, d, tMax, rng ), 0 ), 'vec4' ) );
		for ( let c = 0; c < 3; c ++ ) {

			const got = means( out, rays, 4, c );
			rays.forEach( ( [ origin, dir, tMax ], r ) => {

				const expected = cpuIntegral( headers, field, origin, dir, tMax ) * 2 * [ 1, 0.5, 0.25 ][ c ];
				expect( Math.abs( got[ r ] - expected ), `ray ${r} channel ${c}: ${got[ r ]} against ${expected}` ).toBeLessThan( 0.01 + expected * 0.01 );

			} );

		}

	} );

} );

const select01 = ( condition ) => select( condition, float( 1.0 ), float( 0.0 ) );
