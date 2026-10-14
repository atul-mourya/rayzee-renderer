import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { compareLoads, loadFailures, parseRoots, phaseDepth, resolveModels, summarisePhases } from '../../../bench/lib/load.js';

const GATES = { unchangedPct: 15, minDeltaMs: 100, memoryPct: 2, minMemoryBytes: 16 * 2 ** 20 };

const load = ( phases, { peak = 400e6, triangles = 1000 } = {} ) => ( {
	phases,
	counts: { triangles, meshes: 10, materials: 3 },
	memory: { hostPeakLiveBytes: peak },
	issues: [],
} );

// Round-to-round drift both sides share, as a busy machine produces.
const DRIFT = [ 1, 1.3, 0.9, 1.15, 1.05 ];
const rounds = ( phases, scale = () => 1, extra = {} ) => DRIFT.map( ( d, i ) => load(
	Object.fromEntries( Object.entries( phases ).map( ( [ k, v ] ) => [ k, v * d * scale( k, i ) + ( extra[ k ] ?? 0 ) ] ) )
) );

const BASE = { ready: 9000, load: 6000, parse: 2500, scene: 3000, blas: 2000, tlas: 30, textures: 900, upload: 400, firstFrame: 3000 };

describe( 'bench:load', () => {

	describe( 'compareLoads', () => {

		it( 'calls identical code unchanged, through drift both sides share', () => {

			const result = compareLoads( rounds( BASE ), rounds( BASE ), GATES );
			expect( result.slower ).toEqual( [] );
			expect( result.phases.every( ( p ) => p.verdict === 'unchanged' ) ).toBe( true );

		} );

		it( 'names the phase a delay was put in, and blames the phases around it only as containing it', () => {

			const delay = ( ms ) => ( { textures: ms, scene: ms, load: ms, ready: ms } );
			const small = compareLoads( rounds( BASE ), rounds( BASE, () => 1, delay( 300 ) ), GATES );
			expect( small.slower ).toEqual( [ 'textures' ] );
			expect( small.phases.find( ( p ) => p.key === 'textures' ).deltaMs ).toBeCloseTo( 300, 0 );

			const large = compareLoads( rounds( BASE ), rounds( BASE, () => 1, delay( 2000 ) ), GATES );
			expect( large.slower.sort() ).toEqual( [ 'load', 'ready', 'scene', 'textures' ] );
			expect( large.culprits ).toEqual( [ 'textures' ] );

		} );

		it( 'ignores a large relative change worth less than minDeltaMs', () => {

			const result = compareLoads( rounds( BASE ), rounds( BASE, ( k ) => ( k === 'tlas' ? 1.6 : 1 ) ), GATES );
			expect( result.phases.find( ( p ) => p.key === 'tlas' ).verdict ).toBe( 'unchanged' );

		} );

		it( 'pairs by round, so a regression survives drift larger than itself', () => {

			// Up to 30 % drift between rounds, +20 % on every round: independent medians could not see it.
			const result = compareLoads( rounds( BASE ), rounds( BASE, ( k ) => ( k === 'blas' ? 1.2 : 1 ) ), GATES );
			expect( result.phases.find( ( p ) => p.key === 'blas' ).verdict ).toBe( 'slower' );
			expect( result.culprits ).toEqual( [ 'blas' ] );

		} );

		it( 'gives no verdict on a change one round contradicts', () => {

			const head = rounds( BASE, ( k, i ) => ( k === 'parse' ? [ 1.8, 0.95, 1.7, 1.6, 0.97 ][ i ] : 1 ) );
			expect( compareLoads( rounds( BASE ), head, GATES ).phases.find( ( p ) => p.key === 'parse' ).verdict ).toBe( 'inconclusive' );

		} );

		it( 'reports a phase measured on one side only without a verdict', () => {

			const base = rounds( BASE ).map( ( r ) => ( { ...r, phases: { ...r.phases, kernels: undefined } } ) );
			const head = rounds( { ...BASE, kernels: 5 } );
			expect( compareLoads( base, head, GATES ).phases.find( ( p ) => p.key === 'kernels' ).verdict ).toBe( 'one side only' );

		} );

		it( 'pairs only rounds both sides finished', () => {

			const head = rounds( BASE );
			head[ 1 ] = { error: 'boom', phases: {}, issues: [] };
			const blas = compareLoads( rounds( BASE ), head, GATES ).phases.find( ( p ) => p.key === 'blas' );
			expect( blas.roundDeltasPct ).toHaveLength( 4 );

		} );

		it( 'flags host memory growth past both thresholds, and only then', () => {

			const base = rounds( BASE );
			const grow = ( bytes ) => rounds( BASE ).map( ( r ) => ( { ...r, memory: { hostPeakLiveBytes: 400e6 + bytes } } ) );
			expect( compareLoads( base, grow( 40e6 ), GATES ).memory.verdict ).toBe( 'larger' );
			expect( compareLoads( base, grow( 4e6 ), GATES ).memory.verdict ).toBe( 'unchanged' );
			expect( compareLoads( base, grow( - 40e6 ), GATES ).memory.verdict ).toBe( 'smaller' );

		} );

		it( 'says when the two sides built different scenes', () => {

			const head = rounds( BASE ).map( ( r ) => ( { ...r, counts: { ...r.counts, triangles: 999 } } ) );
			expect( compareLoads( rounds( BASE ), head, GATES ).counts ).toEqual( [ { key: 'triangles', base: 1000, head: 999 } ] );

		} );

	} );

	describe( 'loadFailures', () => {

		const issues = [
			{ code: 'texture.build_failed', severity: 'error', message: 'a' },
			{ code: 'asset.ambiguous_entry', severity: 'warning', message: 'b' },
		];

		it( 'fails on an error and on an error-severity issue, not on a warning', () => {

			expect( loadFailures( { error: 'Error: no .pbrt\n at x', issues } ) ).toEqual( [ 'load failed: Error: no .pbrt', 'error texture.build_failed: a' ] );
			expect( loadFailures( { issues: [ issues[ 1 ] ] } ) ).toEqual( [] );

		} );

		it( 'fails on a request to the network', () => {

			expect( loadFailures( { network: [ 'https://www.gstatic.com/draco/v1/decoders/draco_decoder.wasm' ] } ) )
				.toEqual( [ 'reached for the network: https://www.gstatic.com/draco/v1/decoders/draco_decoder.wasm' ] );

		} );

		it( 'fails on warnings too under strict', () => {

			expect( loadFailures( { issues }, { strict: true } ) ).toHaveLength( 2 );

		} );

	} );

	describe( 'resolveModels', () => {

		const config = { models: [
			{ id: 'a', path: 'a.glb' },
			{ id: 'b', path: 'deep/b.zip', options: { element: 'b/x' } },
			{ id: 'big', path: 'big.zip', heavy: true },
		] };
		const present = new Set( [ '/one/a.glb', '/two/deep/b.zip', '/two/a.glb', '/one/big.zip' ] );
		const exists = ( p ) => present.has( p );

		it( 'takes each model from the first root that holds it', () => {

			const { models } = resolveModels( config, { roots: [ '/one', '/two' ], exists } );
			expect( models.map( ( m ) => [ m.id, m.file ] ) ).toEqual( [[ 'a', '/one/a.glb' ], [ 'b', '/two/deep/b.zip' ]] );
			expect( models[ 1 ].options ).toEqual( { element: 'b/x' } );

		} );

		it( 'skips a missing model with a reason instead of failing', () => {

			const { models, skipped } = resolveModels( config, { roots: [ '/one' ], exists } );
			expect( models.map( ( m ) => m.id ) ).toEqual( [ 'a' ] );
			expect( skipped.map( ( s ) => s.id ) ).toEqual( [ 'b', 'big' ] );
			expect( skipped[ 0 ].reason ).toContain( 'deep/b.zip' );

		} );

		it( 'loads a heavy model only when asked for', () => {

			expect( resolveModels( config, { roots: [ '/one' ], heavy: true, exists } ).models.map( ( m ) => m.id ) ).toEqual( [ 'a', 'big' ] );
			expect( resolveModels( config, { roots: [ '/one' ], only: [ 'big' ], exists } ).models.map( ( m ) => m.id ) ).toEqual( [ 'big' ] );

		} );

		it( 'refuses an unknown --only id and a malformed list', () => {

			expect( () => resolveModels( config, { roots: [], only: [ 'nope' ], exists } ) ).toThrow( /unknown model.*nope/ );
			expect( () => resolveModels( { models: [ { id: 'a' } ] }, { roots: [], exists } ) ).toThrow( /id and a path/ );
			expect( () => resolveModels( { models: [ { id: 'a', path: 'x' }, { id: 'a', path: 'y' } ] }, { roots: [], exists } ) ).toThrow( /twice/ );

		} );

	} );

	describe( 'parseRoots', () => {

		it( 'resolves against the repo, expands ~ and splits on the path delimiter', () => {

			const value = [ 'app/public/models', '~/assets', '', '/abs' ].join( path.delimiter );
			expect( parseRoots( value, { repoRoot: '/repo', home: '/home/me' } ) ).toEqual( [ '/repo/app/public/models', '/home/me/assets', '/abs' ] );
			expect( parseRoots( [ 'x' ], { repoRoot: '/repo', home: '/h' } ) ).toEqual( [ '/repo/x' ] );

		} );

	} );

	it( 'summarises each phase over the measured loads, skipping failed ones', () => {

		const summary = summarisePhases( [ load( { ready: 10, blas: 4 } ), { error: 'x', phases: {} }, load( { ready: 30, blas: 2 } ), load( { ready: 20 } ) ] );
		expect( summary.ready ).toEqual( { median: 20, min: 10, max: 30, n: 3 } );
		expect( summary.blas.n ).toBe( 2 );
		expect( summary.parse ).toBeUndefined();

	} );

	it( 'nests each phase under the one it runs inside', () => {

		expect( [ 'ready', 'load', 'scene', 'textures', 'firstFrame' ].map( phaseDepth ) ).toEqual( [ 0, 1, 2, 3, 1 ] );

	} );

} );
