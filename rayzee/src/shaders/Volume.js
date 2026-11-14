/**
 * Volumes on the GPU (scene/Volumes.js packs them; docs/design/VOLUMES.md): free flight by delta tracking, shadow-ray
 * transmittance by ratio tracking, both walking each volume's majorant grid cell by cell, and the light a volume gives
 * along a segment. Grey extinction: one majorant serves every channel, so no spectral weights.
 */

import { float, vec3, int, ivec3, uint, If, Loop, Break, abs, dot, floor, log, min, max, mix, step, clamp, ceil, select, bool as tslBool, floatBitsToUint, instanceIndex } from 'three/tsl';

import { VOLUME_LAYOUT } from '../scene/BufferLayout.js';
import { RandomValue, pcgHash } from './Random.js';

const { VEC4S, RAMP, MAX } = VOLUME_LAYOUT;

// Tentative collisions a majorant cell may take before the walk moves on: a guard against a hang, never reached by a
// valid majorant short of optical depths in the hundreds a cell.
const CELL_STEPS = 256;

// Volume `i`'s header and the ray ( origin, dir ) in its grid space.
function volumeAt( volumes, i, origin, dir ) {

	const row = ( k ) => volumes.headers.element( i.mul( VEC4S ).add( k ) );
	const r0 = row( 0 ).toVar(), r1 = row( 1 ).toVar(), r2 = row( 2 ).toVar();
	const atlas = row( 3 ).toVar();
	const size = row( 4 ).toVar();
	const color = row( 5 ).toVar();
	const majorant = row( 6 ).toVar();
	const cells = row( 7 ).toVar();
	const o = vec3( dot( r0.xyz, origin ).add( r0.w ), dot( r1.xyz, origin ).add( r1.w ), dot( r2.xyz, origin ).add( r2.w ) ).toVar();
	const raw = vec3( dot( r0.xyz, dir ), dot( r1.xyz, dir ), dot( r2.xyz, dir ) );
	// Per channel: a TSL select follows its condition's first channel only.
	const d = mix( raw, vec3( 1e-12 ), step( abs( raw ), vec3( 1e-12 ) ) ).toVar();
	return {
		i, o, d, size: size.xyz, anisotropy: size.w, atlas: atlas.xyz, density: atlas.w, color: color.xyz, cell: color.w,
		majorantAt: majorant.xyz, emission: majorant.w, cells: cells.xyz, rampScale: cells.w,
	};

}

// Where the ray is inside the grid's box, within [ tMin, tMax ]: ( enter, leave ), empty when leave ≤ enter.
function boxSpan( v, tMin, tMax ) {

	const inv = vec3( 1.0 ).div( v.d );
	const t0 = v.o.negate().mul( inv );
	const t1 = v.size.sub( v.o ).mul( inv );
	const near = min( t0, t1 ), far = max( t0, t1 );
	return { enter: max( max( max( near.x, near.y ), near.z ), tMin ).toVar(), leave: min( min( min( far.x, far.y ), far.z ), tMax ).toVar() };

}

/** The packed grid at grid-space point `q`: ( density, emission ). */
const lookup = ( volumes, v, q ) => volumes.atlas.sample( v.atlas.add( q ).mul( volumes.invAtlasSize ) ).level( 0 );

/**
 * Walks volume `v`'s majorant grid along its ray over [ enter, leave ], calling `visit( t, majorant, exit )` in each
 * cell with a majorant, where `t` (a variable) starts at the cell's entry and `exit` is where it leaves. `visit`
 * returns a bool node: true stops the walk.
 */
function walkMajorants( volumes, v, enter, leave, visit ) {

	const forward = step( 0.0, v.d );
	const cell = clamp( floor( v.o.add( v.d.mul( enter ) ).div( v.cell ) ), vec3( 0.0 ), v.cells.sub( 1.0 ) ).toVar();
	const inv = vec3( 1.0 ).div( v.d ).toVar();
	const tNext = cell.add( forward ).mul( v.cell ).sub( v.o ).mul( inv ).toVar();
	const tDelta = abs( inv.mul( v.cell ) ).toVar();
	const stepBy = forward.mul( 2.0 ).sub( 1.0 ).toVar();
	const t = float( enter ).toVar();
	const steps = int( v.cells.x.add( v.cells.y ).add( v.cells.z ) ).add( 2 );

	Loop( { start: int( 0 ), end: steps, type: 'int', condition: '<' }, () => {

		const exit = min( min( tNext.x, tNext.y ), min( tNext.z, leave ) ).toVar();
		const majorant = volumes.atlas.load( ivec3( v.majorantAt.add( cell ) ) ).level( 0 ).x.mul( v.density ).toVar();
		const stop = tslBool( false ).toVar();
		If( majorant.greaterThan( 0.0 ), () => {

			stop.assign( visit( t, majorant, exit ) );

		} );
		If( stop.or( exit.greaterThanEqual( leave ) ), () => {

			Break();

		} );

		t.assign( exit );
		If( tNext.x.lessThanEqual( tNext.y ).and( tNext.x.lessThanEqual( tNext.z ) ), () => {

			cell.x.addAssign( stepBy.x );
			tNext.x.addAssign( tDelta.x );

		} ).ElseIf( tNext.y.lessThanEqual( tNext.z ), () => {

			cell.y.addAssign( stepBy.y );
			tNext.y.addAssign( tDelta.y );

		} ).Else( () => {

			cell.z.addAssign( stepBy.z );
			tNext.z.addAssign( tDelta.z );

		} );
		If( cell.x.lessThan( 0.0 ).or( cell.y.lessThan( 0.0 ) ).or( cell.z.lessThan( 0.0 ) )
			.or( cell.x.greaterThanEqual( v.cells.x ) ).or( cell.y.greaterThanEqual( v.cells.y ) ).or( cell.z.greaterThanEqual( v.cells.z ) ), () => {

			Break();

		} );

	} );

}

// Over every volume shown: `body( v )` with its header and ray.
function eachVolume( volumes, origin, dir, body ) {

	Loop( { start: int( 0 ), end: volumes.count, type: 'int', condition: '<' }, ( { i } ) => {

		// Held in a variable: every TSL loop's counter is `i` in WGSL, so a nested loop's would hide this one.
		const v = volumeAt( volumes, i.toVar(), origin, dir );
		If( v.density.greaterThanEqual( 0.0 ), () => {

			body( v );

		} );

	} );

}

/**
 * The first collision with any volume before `tMax`, by delta tracking: `{ t, index }`, index −1 (t = tMax) for none.
 * Each volume is tracked up to the nearest found so far (the sum's first collision is the nearest of each's own).
 */
export function volumeFreeFlight( volumes, origin, dir, tMax, firstU, rng ) {

	const best = { t: float( tMax ).toVar(), index: int( - 1 ).toVar() };
	const fresh = tslBool( true ).toVar();
	const uniform = () => {

		const u = float( 0.0 ).toVar();
		If( fresh, () => {

			u.assign( firstU );
			fresh.assign( false );

		} ).Else( () => {

			u.assign( RandomValue( rng ) );

		} );
		return u;

	};

	eachVolume( volumes, origin, dir, ( v ) => {

		const span = boxSpan( v, float( 0.0 ), best.t );
		If( v.density.greaterThan( 0.0 ).and( span.leave.greaterThan( span.enter ) ), () => {

			walkMajorants( volumes, v, span.enter, span.leave, ( t, majorant, exit ) => {

				const hit = tslBool( false ).toVar();
				Loop( { start: int( 0 ), end: int( CELL_STEPS ), type: 'int', condition: '<' }, () => {

					t.subAssign( log( float( 1.0 ).sub( uniform() ) ).div( majorant ) );
					If( t.greaterThanEqual( exit ), () => {

						Break();

					} );
					const sigma = lookup( volumes, v, v.o.add( v.d.mul( t ) ) ).x.mul( v.density );
					If( RandomValue( rng ).mul( majorant ).lessThan( sigma ), () => {

						best.t.assign( t );
						best.index.assign( v.i );
						hit.assign( true );
						Break();

					} );

				} );
				return hit;

			} );

		} );

	} );

	return best;

}

/**
 * The volumes' transmittance over [ 0, tMax ], by ratio tracking with Russian roulette below 0.1 (pbrt-v4). Its stream
 * is seeded from the ray, the thread and the frame: a shadow ray carries no path state.
 */
export function volumeTransmittance( volumes, origin, dir, tMax ) {

	const hash = ( state ) => pcgHash( { state } );
	const bits = floatBitsToUint;
	const thread = hash( uint( instanceIndex ).bitXor( uint( volumes.seed ).mul( uint( 0xC2B2AE35 ) ) ) );
	const direction = bits( dir.x ).bitXor( bits( dir.y ).mul( uint( 0x9E3779B9 ) ) ).bitXor( bits( dir.z ).mul( uint( 0x85EBCA6B ) ) ).bitXor( bits( tMax ) );
	const rng = hash( bits( origin.x ).bitXor( hash( bits( origin.y ).bitXor( hash( bits( origin.z ).bitXor( hash( direction.bitXor( thread ) ) ) ) ) ) ) ).toVar();
	const T = float( 1.0 ).toVar();

	eachVolume( volumes, origin, dir, ( v ) => {

		const span = boxSpan( v, float( 0.0 ), tMax );
		If( T.greaterThan( 0.0 ).and( v.density.greaterThan( 0.0 ) ).and( span.leave.greaterThan( span.enter ) ), () => {

			walkMajorants( volumes, v, span.enter, span.leave, ( t, majorant, exit ) => {

				Loop( { start: int( 0 ), end: int( CELL_STEPS ), type: 'int', condition: '<' }, () => {

					t.subAssign( log( float( 1.0 ).sub( RandomValue( rng ) ) ).div( majorant ) );
					If( t.greaterThanEqual( exit ), () => {

						Break();

					} );
					const sigma = lookup( volumes, v, v.o.add( v.d.mul( t ) ) ).x.mul( v.density );
					T.mulAssign( max( float( 1.0 ).sub( sigma.div( majorant ) ), 0.0 ) );
					If( T.lessThan( 0.1 ), () => {

						T.assign( select( RandomValue( rng ).lessThan( 0.75 ), float( 0.0 ), T.div( 0.25 ) ) );

					} );
					If( T.equal( 0.0 ), () => {

						Break();

					} );

				} );
				return T.equal( 0.0 );

			} );

		} );

	} );

	return T;

}

// Emission per unit length at ( density, emission ) grid values.
function emissionAt( volumes, v, values ) {

	const x = values.y.mul( v.rampScale ).toVar();
	const i0 = int( clamp( floor( x ), 0.0, float( RAMP - 2 ) ) ).toVar();
	const base = int( MAX * VEC4S ).add( v.i.mul( RAMP ) ).add( i0 );
	const Le = mix( volumes.headers.element( base ).xyz, volumes.headers.element( base.add( 1 ) ).xyz, clamp( x.sub( float( i0 ) ), 0.0, 1.0 ) );
	// pbrt's σa × Le: what the medium absorbs there.
	const absorbed = vec3( 1.0 ).sub( v.color ).mul( values.x.mul( v.density ) );
	return select( v.emission.greaterThan( 1.5 ), Le.mul( absorbed ), Le );

}

/**
 * The volumes' emission integrated over [ 0, tMax ] at stratified points, more where more voxels are crossed (≤ 16).
 * Before the path's throughput.
 */
export function volumeEmission( volumes, origin, dir, tMax, rng ) {

	const light = vec3( 0.0 ).toVar();
	eachVolume( volumes, origin, dir, ( v ) => {

		If( v.emission.greaterThan( 0.5 ), () => {

			const span = boxSpan( v, float( 0.0 ), tMax );
			const length = span.leave.sub( span.enter ).toVar();
			If( length.greaterThan( 0.0 ), () => {

				const voxels = length.mul( max( max( abs( v.d.x ), abs( v.d.y ) ), abs( v.d.z ) ) );
				const n = int( clamp( ceil( voxels.mul( 0.25 ) ), 1.0, 16.0 ) ).toVar();
				const jitter = RandomValue( rng ).toVar();
				const sum = vec3( 0.0 ).toVar();
				Loop( { start: int( 0 ), end: n, type: 'int', condition: '<' }, ( { i } ) => {

					const t = span.enter.add( length.mul( float( i ).add( jitter ) ).div( float( n ) ) );
					sum.addAssign( emissionAt( volumes, v, lookup( volumes, v, v.o.add( v.d.mul( t ) ) ) ) );

				} );
				light.addAssign( sum.mul( length.div( float( n ) ) ) );

			} );

		} );

	} );

	return light;

}

/** Volume `index`'s scattering colour and anisotropy. */
export function volumeMedium( volumes, index ) {

	const base = index.mul( VEC4S );
	return { color: volumes.headers.element( base.add( 5 ) ).xyz, anisotropy: volumes.headers.element( base.add( 4 ) ).w };

}
