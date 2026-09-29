// Physical sky bake kernels; 16 spectral bins travel as four vec4s. The transmittance table holds
// density-weighted path lengths, so it depends only on the planet.

import {
	Fn, float, int, uint, vec3, vec4,
	If, Loop, Return,
	instanceIndex,
	exp, log, sqrt, max, min, clamp, abs, mix, step, floor, dot, sin, cos, tan, asin, acos, atan, smoothstep,
} from 'three/tsl';

import {
	GROUND_RADIUS as RG, TOP_RADIUS as RT,
	RAYLEIGH_SCALE_HEIGHT, MIE_SCALE_HEIGHT, OZONE_PEAK_ALTITUDE, OZONE_HALF_WIDTH,
} from '../Processor/AtmosphereModel.js';

export const TRANSMITTANCE_W = 256;
export const TRANSMITTANCE_H = 64;
// Multiple-scattering tables over sun elevation × altitude, then incoming cells (zenith bands
// uniform in cos × azimuth sectors from the sun over [0, π]) or viewing directions.
export const MS_MU_S = 64;
export const MS_H = 16;
export const MS_BANDS = 16;
export const MS_SECTORS = 8;
export const MS_CELLS = MS_BANDS * MS_SECTORS;
export const MS_VIEW_MU = 16;
export const MS_VIEW_PHI = 8;
export const MS_VIEWS = MS_VIEW_MU * MS_VIEW_PHI;
export const IRRADIANCE_SIZE = 128;

const H_TOP = Math.sqrt( RT * RT - RG * RG );
const SHELL = RT - RG;
const PI = Math.PI;
const G4 = [ 0, 1, 2, 3 ];

const spectrum = f => G4.map( f );

function densities( h ) {

	return {
		r: exp( h.mul( - 1 / RAYLEIGH_SCALE_HEIGHT ) ),
		m: exp( h.mul( - 1 / MIE_SCALE_HEIGHT ) ),
		o: max( float( 0 ), float( 1 ).sub( abs( h.sub( OZONE_PEAK_ALTITUDE ) ).div( OZONE_HALF_WIDTH ) ) ),
	};

}

function extinction( c, d ) {

	return spectrum( g => c.rayleigh[ g ].mul( d.r ).add( c.mieExtinction[ g ].mul( d.m ) ).add( c.ozone[ g ].mul( d.o ) ) );

}

// Energy-conserving segment weight ∫₀^dt e^{−σx} dx = dt·(1 − e^{−σdt})/(σdt), stable as σdt → 0.
function segment( sigmaT, dt ) {

	return spectrum( g => {

		const x = sigmaT[ g ].mul( dt );
		const e = exp( x.negate() );
		const big = float( 1 ).sub( e ).div( max( x, 1e-12 ) );
		const small = float( 1 ).sub( x.mul( 0.5 ) );
		return { weight: mix( small, big, step( 1e-3, x ) ).mul( dt ), transmittance: e };

	} );

}

function bilinear( buffer, width, height, fx, fy, stride = 1, offset = 0 ) {

	const x = clamp( fx, 0, width - 1 );
	const y = clamp( fy, 0, height - 1 );
	const x0 = floor( x ), y0 = floor( y );
	const tx = x.sub( x0 ), ty = y.sub( y0 );
	const ix0 = uint( x0 ), iy0 = uint( y0 );
	const ix1 = min( ix0.add( 1 ), uint( width - 1 ) );
	const iy1 = min( iy0.add( 1 ), uint( height - 1 ) );
	const at = ( ix, iy ) => buffer.element( iy.mul( width ).add( ix ).mul( stride ).add( offset ) );
	return mix( mix( at( ix0, iy0 ), at( ix1, iy0 ), tx ), mix( at( ix0, iy1 ), at( ix1, iy1 ), tx ), ty );

}

// Bruneton's (x_mu, x_r) parameterisation, from altitude so low heights keep their precision.
function transmittanceCoord( h, mu ) {

	const r = h.add( RG );
	const rho = sqrt( max( h.mul( h.add( 2 * RG ) ), 0 ) );
	const rmu = r.mul( mu );
	const dTop = rmu.negate().add( sqrt( max( rmu.mul( rmu ).add( H_TOP * H_TOP ).sub( rho.mul( rho ) ), 0 ) ) );
	const dMin = float( SHELL ).sub( h );
	const dMax = rho.add( H_TOP );
	return {
		x: dTop.sub( dMin ).div( max( dMax.sub( dMin ), 1e-6 ) ).mul( TRANSMITTANCE_W - 1 ),
		y: rho.div( H_TOP ).mul( TRANSMITTANCE_H - 1 ),
		rho, r,
	};

}

/**
 * Transmittance from altitude `h` towards the sun at zenith cosine `muS`, faded out as the disc
 * sinks behind the planet.
 */
function sunTransmittance( lut, c, h, muS, sunSinRadius ) {

	const tc = transmittanceCoord( h, muS );
	const depth = bilinear( lut, TRANSMITTANCE_W, TRANSMITTANCE_H, tc.x, tc.y ).xyz;
	const visible = smoothstep( sunSinRadius.negate(), sunSinRadius, muS.add( tc.rho.div( tc.r ) ) );
	return spectrum( g => exp( c.rayleigh[ g ].mul( depth.x ).add( c.mieExtinction[ g ].mul( depth.y ) ).add( c.ozone[ g ].mul( depth.z ) ).negate() ).mul( visible ) );

}

// Altitude on a squared axis: the air that scatters most is packed into the first few km.
const msAltitude = j => float( j ).div( MS_H - 1 ).pow( 2 ).mul( SHELL );
const msAltitudeCoord = h => sqrt( clamp( h.div( SHELL ), 0, 1 ) ).mul( MS_H - 1 );

// Sun elevation on an arctangent axis centred just below the horizon: through twilight the
// scattered light falls by orders of magnitude per few degrees, and it is interpolated in log.
const SUN_CENTRE = - 3 * PI / 180;
const SUN_WIDTH = 15 * PI / 180;
const SUN_U0 = 0.5 + Math.atan( ( - PI / 2 - SUN_CENTRE ) / SUN_WIDTH ) / PI;
const SUN_U1 = 0.5 + Math.atan( ( PI / 2 - SUN_CENTRE ) / SUN_WIDTH ) / PI;
const sunAxis = ( i, n ) => sin( clamp( tan( float( i ).div( n - 1 ).mul( SUN_U1 - SUN_U0 ).add( SUN_U0 - 0.5 ).mul( PI ) ).mul( SUN_WIDTH ).add( SUN_CENTRE ), - PI / 2, PI / 2 ) );
const sunCoord = ( muS, n ) => atan( asin( clamp( muS, - 1, 1 ) ).sub( SUN_CENTRE ).div( SUN_WIDTH ) ).div( PI ).add( 0.5 - SUN_U0 ).div( SUN_U1 - SUN_U0 ).mul( n - 1 );
const LOG_FLOOR = 1e-30;
const toLog = v => log( max( v, vec4( LOG_FLOOR ) ) );

/**
 * Ψ for Rayleigh (0–3) and Mie (4–7) toward a view of zenith cosine `muV` and cosine of azimuth
 * from the sun `cosPhi`, interpolated in log over all four axes.
 */
function sampleMultipleScattering( psi, h, muS, muV, cosPhi ) {

	const axes = [
		[ clamp( sunCoord( muS, MS_MU_S ), 0, MS_MU_S - 1 ), MS_MU_S ],
		[ clamp( msAltitudeCoord( h ), 0, MS_H - 1 ), MS_H ],
		[ clamp( muV.add( 1 ).mul( 0.5 * ( MS_VIEW_MU - 1 ) ), 0, MS_VIEW_MU - 1 ), MS_VIEW_MU ],
		[ clamp( acos( clamp( cosPhi, - 1, 1 ) ).mul( ( MS_VIEW_PHI - 1 ) / PI ), 0, MS_VIEW_PHI - 1 ), MS_VIEW_PHI ],
	].map( ( [ f, n ] ) => {

		const i0 = floor( f );
		const t = f.sub( i0 ).toVar();
		const a0 = uint( i0 ).toVar();
		return { t, i0: a0, i1: min( a0.add( 1 ), uint( n - 1 ) ).toVar() };

	} );

	// Row-major (h, μs, µv, φ): stride of each axis in texels.
	const strides = [ MS_VIEWS, MS_MU_S * MS_VIEWS, MS_VIEW_PHI, 1 ];
	const corners = [];
	for ( let k = 0; k < 16; k ++ ) {

		let index = uint( 0 );
		axes.forEach( ( axis, a ) => {

			index = index.add( ( ( k >> a ) & 1 ? axis.i1 : axis.i0 ).mul( strides[ a ] ) );

		} );
		corners.push( index.mul( 8 ).toVar() );

	}

	return Array.from( { length: 8 }, ( _, c ) => {

		let level = corners.map( base => psi.element( base.add( c ) ) );
		for ( let a = 0; a < 4; a ++ ) {

			const next = [];
			for ( let k = 0; k < level.length; k += 2 ) next.push( mix( level[ k ], level[ k + 1 ], axes[ a ].t ) );
			level = next;

		}

		return exp( level[ 0 ] );

	} );

}

function skyIrradiance( irrLUT, muS ) {

	const fx = sunCoord( muS, IRRADIANCE_SIZE );
	return spectrum( g => exp( bilinear( irrLUT, IRRADIANCE_SIZE, 1, fx, float( 0 ), 4, g ) ) );

}

// Ray from altitude h along zenith cosine mu: distance to the ground (if it hits) or to the top.
function rayExtent( h, mu ) {

	const r = h.add( RG ).toVar();
	const b = r.mul( mu ).toVar();
	const cGround = h.mul( h.add( 2 * RG ) ).toVar();
	const discGround = b.mul( b ).sub( cGround );
	const hitsGround = mu.lessThan( 0 ).and( discGround.greaterThanEqual( 0 ) ).toVar();
	const tGround = cGround.div( max( b.negate().add( sqrt( max( discGround, 0 ) ) ), 1e-9 ) );
	const tTop = b.negate().add( sqrt( max( b.mul( b ).add( float( RT ).sub( r ).mul( r.add( RT ) ) ), 0 ) ) );
	return { r, b, cGround, hitsGround, tMax: hitsGround.select( tGround, tTop ).toVar() };

}

// Cosine of a direction's azimuth from the sun, in the local horizontal plane.
const azimuthCos = ( nu, mu, muS ) => nu.sub( mu.mul( muS ) ).div( max( sqrt( float( 1 ).sub( mu.mul( mu ) ).mul( float( 1 ).sub( muS.mul( muS ) ) ) ), 1e-4 ) );

// Altitude, sun zenith cosine and the ray's own zenith cosine at distance t along the ray.
function alongRay( ray, t, muS0, nu ) {

	const q = t.mul( t.add( ray.b.mul( 2 ) ) );
	const rt = sqrt( ray.r.mul( ray.r ).add( q ) );
	const h = max( ray.cGround.add( q ).div( rt.add( RG ) ), 0 );
	return {
		h,
		muS: clamp( ray.r.mul( muS0 ).add( t.mul( nu ) ).div( rt ), - 1, 1 ),
		mu: clamp( ray.b.add( t ).div( rt ), - 1, 1 ),
	};

}

const rayleighPhase = nu => nu.mul( nu ).add( 1 ).mul( 3 / ( 16 * PI ) );

// Cornette-Shanks.
function miePhase( nu, g ) {

	const g2 = g * g;
	const k = 3 / ( 8 * PI ) * ( 1 - g2 ) / ( 2 + g2 );
	const denom = max( float( 1 + g2 ).sub( nu.mul( 2 * g ) ), 1e-6 );
	return nu.mul( nu ).add( 1 ).mul( k ).div( denom.mul( sqrt( denom ) ) );

}

/**
 * @param {Object} io
 * @param {Node} io.transmittance - storage vec4, TRANSMITTANCE_W × TRANSMITTANCE_H
 */
export function buildTransmittanceKernel( { transmittance }, steps = 256 ) {

	const count = TRANSMITTANCE_W * TRANSMITTANCE_H;

	return Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( count ) ), () => {

			Return();

		} );

		const xMu = float( idx.mod( TRANSMITTANCE_W ) ).div( TRANSMITTANCE_W - 1 );
		const xR = float( idx.div( TRANSMITTANCE_W ) ).div( TRANSMITTANCE_H - 1 );
		const rho = xR.mul( H_TOP ).toVar();
		const r = sqrt( rho.mul( rho ).add( RG * RG ) ).toVar();
		const dMin = float( RT ).sub( r );
		const dMax = rho.add( H_TOP );
		const d = dMin.add( xMu.mul( dMax.sub( dMin ) ) ).toVar();
		const mu = clamp( float( H_TOP * H_TOP ).sub( rho.mul( rho ) ).sub( d.mul( d ) ).div( max( r.mul( d ).mul( 2 ), 1e-9 ) ), - 1, 1 ).toVar();
		const rho2 = rho.mul( rho ).toVar();
		const rmu2 = r.mul( mu ).mul( 2 ).toVar();

		const depth = vec3( 0 ).toVar();
		Loop( { start: int( 0 ), end: int( steps ), type: 'int', condition: '<' }, ( { i } ) => {

			const f0 = float( i ).div( steps );
			const f1 = float( i ).add( 1 ).div( steps );
			const t0 = d.mul( f0.mul( f0 ) );
			const t1 = d.mul( f1.mul( f1 ) );
			const t = t0.add( t1 ).mul( 0.5 );
			const q = t.mul( t.add( rmu2 ) );
			const h = max( rho2.add( q ).div( sqrt( r.mul( r ).add( q ) ).add( RG ) ), 0 );
			const dens = densities( h );
			depth.addAssign( vec3( dens.r, dens.m, dens.o ).mul( t1.sub( t0 ) ) );

		} );

		transmittance.element( idx ).assign( vec4( depth, 0 ) );

	} )().compute( count, [ 64 ] );

}

// Cells are π/32 sr each; a band's cells share its centre cosine.
const CELL_SOLID_ANGLE = 4 * PI / MS_CELLS;

// Direction of ray `k` of a cell's `samples`², azimuth from the sun in the plane of +x.
function cellRay( band, sector, k, samples ) {

	const u = float( band ).add( float( k.div( samples ) ).add( 0.5 ).div( samples ) ).div( MS_BANDS );
	const cosT = u.mul( 2 ).sub( 1 );
	const sinT = sqrt( max( float( 1 ).sub( cosT.mul( cosT ) ), 0 ) );
	const phi = float( sector ).add( float( k.mod( samples ) ).add( 0.5 ).div( samples ) ).mul( PI / MS_SECTORS );
	return vec3( sinT.mul( cos( phi ) ), cosT, sinT.mul( sin( phi ) ) );

}

// Light of one scattering order arriving at the ground, per unit solar irradiance.
function groundIrradiance( groundE, muS ) {

	const fx = sunCoord( muS, MS_MU_S );
	return spectrum( g => bilinear( groundE, MS_MU_S, 1, fx, float( 0 ), 4, g ) );

}

/**
 * One scattering order's radiance arriving at each (μs, h) from each incoming cell, per unit solar
 * irradiance; order n + 1 scatters order n's Ψ and ground light. Order 1 also writes f_ms per cell.
 */
export function buildIncomingKernel( io, { first, out, cellSamples = 2, steps = 20 } ) {

	const { transmittance, transfer, multipleScattering: psi, groundE, coefficients: c, sunSinRadius, mieG } = io;
	const count = MS_MU_S * MS_H * MS_CELLS;
	const rays = cellSamples * cellSamples;

	return Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( count ) ), () => {

			Return();

		} );

		const cell = idx.mod( MS_CELLS );
		const texel = idx.div( MS_CELLS );
		const muS = sunAxis( texel.mod( MS_MU_S ), MS_MU_S ).toVar();
		const h0 = max( msAltitude( texel.div( MS_MU_S ) ), 1e-3 ).toVar();
		const sun = vec3( sqrt( max( float( 1 ).sub( muS.mul( muS ) ), 0 ) ), muS, 0 ).toVar();

		const L = spectrum( () => vec4( 0 ).toVar() );
		const F = first ? spectrum( () => vec4( 0 ).toVar() ) : null;

		Loop( { start: int( 0 ), end: int( rays ), type: 'int', condition: '<', name: 'ray' }, ( { ray: k } ) => {

			const dir = cellRay( cell.div( MS_SECTORS ), cell.mod( MS_SECTORS ), k, cellSamples ).toVar();
			const nu = dot( dir, sun ).toVar();
			const phaseR = first ? rayleighPhase( nu ).toVar() : null;
			const phaseM = first ? miePhase( nu, mieG ).toVar() : null;
			const held = first ? null : Array.from( { length: 8 }, () => vec4( 0 ).toVar() );

			const ray = rayExtent( h0, dir.y );
			const throughput = spectrum( () => vec4( 1 ).toVar() );

			Loop( { start: int( 0 ), end: int( steps ), type: 'int', condition: '<' }, ( { i } ) => {

				const f0 = float( i ).div( steps );
				const f1 = float( i ).add( 1 ).div( steps );
				const t0 = ray.tMax.mul( f0.mul( f0 ) );
				const dt = ray.tMax.mul( f1.mul( f1 ) ).sub( t0 );
				const at = alongRay( ray, t0.add( dt.mul( 0.5 ) ), muS, nu );
				const dens = densities( at.h );
				const sR = spectrum( g => c.rayleigh[ g ].mul( dens.r ) );
				const sM = spectrum( g => c.mieScattering[ g ].mul( dens.m ) );
				const seg = segment( extinction( c, dens ), dt );

				let source;
				if ( first ) {

					const tSun = sunTransmittance( transmittance, c, at.h, at.muS, sunSinRadius );
					source = spectrum( g => tSun[ g ].mul( sR[ g ].mul( phaseR ).add( sM[ g ].mul( phaseM ) ) ) );

				} else {

					If( i.mod( 2 ).equal( 0 ), () => {

						const next = sampleMultipleScattering( psi, at.h, at.muS, at.mu, azimuthCos( nu, at.mu, at.muS ) );
						for ( let j = 0; j < 8; j ++ ) held[ j ].assign( next[ j ] );

					} );
					source = spectrum( g => sR[ g ].mul( held[ g ] ).add( sM[ g ].mul( held[ 4 + g ] ) ) );

				}

				for ( const g of G4 ) {

					L[ g ].addAssign( throughput[ g ].mul( source[ g ] ).mul( seg[ g ].weight ) );
					if ( F ) F[ g ].addAssign( throughput[ g ].mul( sR[ g ].add( sM[ g ] ) ).mul( seg[ g ].weight ) );
					throughput[ g ].mulAssign( seg[ g ].transmittance );

				}

			} );

			If( ray.hitsGround, () => {

				const muG = clamp( ray.r.mul( muS ).add( ray.tMax.mul( nu ) ).div( RG ), - 1, 1 );
				let lit;
				if ( first ) {

					const tSun = sunTransmittance( transmittance, c, float( 0 ), muG, sunSinRadius );
					lit = spectrum( g => tSun[ g ].mul( max( muG, 0 ) ) );

				} else {

					lit = groundIrradiance( groundE, muG );

				}

				for ( const g of G4 ) L[ g ].addAssign( throughput[ g ].mul( lit[ g ] ).mul( c.albedo[ g ] ).mul( 1 / PI ) );

			} );

		} );

		for ( const g of G4 ) {

			out.element( idx.mul( 4 ).add( g ) ).assign( L[ g ].div( rays ) );
			if ( F ) transfer.element( idx.mul( 4 ).add( g ) ).assign( F[ g ].div( rays ) );

		}

	} )().compute( count, [ 64 ] );

}

/**
 * Ψₙ(μs, h, view) for Rayleigh and Mie, in log, summed in `psiSum`; the last stage adds the tail
 * Ψₙ·f/(1 − f). Earlier stages also write order n's ground irradiance.
 */
export function buildScatterKernel( io, { incoming, stage } ) {

	const { transfer, phaseCells, multipleScattering: psi, psiSum, groundE } = io;
	const count = MS_MU_S * MS_H * MS_VIEWS;
	const groups = MS_CELLS / 4;
	const last = stage === 'last';

	return Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( count ) ), () => {

			Return();

		} );

		const view = idx.mod( MS_VIEWS );
		const texel = idx.div( MS_VIEWS );
		const cells = texel.mul( MS_CELLS );

		let tail = null;
		if ( last ) {

			const f = spectrum( () => vec4( 0 ).toVar() );
			Loop( { start: int( 0 ), end: int( MS_CELLS ), type: 'int', condition: '<' }, ( { i } ) => {

				for ( const g of G4 ) f[ g ].addAssign( transfer.element( cells.add( uint( i ) ).mul( 4 ).add( g ) ) );

			} );
			tail = spectrum( g => {

				const fg = min( f[ g ].div( MS_CELLS ), 0.95 );
				return fg.div( float( 1 ).sub( fg ) ).toVar();

			} );

		}

		for ( let lobe = 0; lobe < 2; lobe ++ ) {

			const acc = spectrum( () => vec4( 0 ).toVar() );
			Loop( { start: int( 0 ), end: int( groups ), type: 'int', condition: '<' }, ( { i } ) => {

				const w = phaseCells.element( uint( lobe * MS_VIEWS ).add( view ).mul( groups ).add( uint( i ) ) ).toVar();
				for ( let k = 0; k < 4; k ++ ) {

					const cellIdx = cells.add( uint( i ).mul( 4 ).add( k ) ).mul( 4 );
					const wk = w.element( int( k ) );
					for ( const g of G4 ) acc[ g ].addAssign( incoming.element( cellIdx.add( g ) ).mul( wk ) );

				}

			} );

			for ( const g of G4 ) {

				const slot = idx.mul( 8 ).add( lobe * 4 + g );
				if ( stage === 'first' ) {

					psiSum.element( slot ).assign( acc[ g ] );
					psi.element( slot ).assign( toLog( acc[ g ] ) );

				} else if ( stage === 'middle' ) {

					psiSum.element( slot ).addAssign( acc[ g ] );
					psi.element( slot ).assign( toLog( acc[ g ] ) );

				} else {

					psi.element( slot ).assign( toLog( psiSum.element( slot ).add( acc[ g ].mul( tail[ g ].add( 1 ) ) ) ) );

				}

			}

		}

		if ( ! last ) {

			// One thread per sun elevation sums the upper cells at the ground row.
			If( texel.lessThan( uint( MS_MU_S ) ).and( view.equal( uint( 0 ) ) ), () => {

				const E = spectrum( () => vec4( 0 ).toVar() );
				Loop( { start: int( MS_CELLS / 2 ), end: int( MS_CELLS ), type: 'int', condition: '<' }, ( { i } ) => {

					const band = uint( i ).div( MS_SECTORS );
					const cosT = float( band ).add( 0.5 ).div( MS_BANDS ).mul( 2 ).sub( 1 );
					for ( const g of G4 ) E[ g ].addAssign( incoming.element( cells.add( uint( i ) ).mul( 4 ).add( g ) ).mul( cosT ) );

				} );
				for ( const g of G4 ) groundE.element( texel.mul( 4 ).add( g ) ).assign( E[ g ].mul( CELL_SOLID_ANGLE ) );

			} );

		}

	} )().compute( count, [ 64 ] );

}

// Single plus multiple scattering along one view ray, per unit solar irradiance. Ψ is smooth
// along the ray, so it is looked up every MS_STRIDE steps and held in between.
const MS_STRIDE = 4;

function inscatter( { transmittance, multipleScattering, coefficients: c, sunSinRadius, mieG }, ray, muS0, nu, steps ) {

	const L = spectrum( () => vec4( 0 ).toVar() );
	const throughput = spectrum( () => vec4( 1 ).toVar() );
	const psi = multipleScattering ? Array.from( { length: 8 }, () => vec4( 0 ).toVar() ) : null;
	const phaseR = rayleighPhase( nu ).toVar();
	const phaseM = miePhase( nu, mieG ).toVar();
	const tMax = ray.tMax;

	Loop( { start: int( 0 ), end: int( steps ), type: 'int', condition: '<' }, ( { i } ) => {

		// Squared spacing puts the samples where the air is densest, next to the viewer.
		const f0 = float( i ).div( steps );
		const f1 = float( i ).add( 1 ).div( steps );
		const t0 = tMax.mul( f0.mul( f0 ) );
		const t1 = tMax.mul( f1.mul( f1 ) );
		const dt = t1.sub( t0 );
		const t = t0.add( dt.mul( 0.5 ) );

		const at = alongRay( ray, t, muS0, nu );
		const dens = densities( at.h );
		const sR = spectrum( g => c.rayleigh[ g ].mul( dens.r ) );
		const sM = spectrum( g => c.mieScattering[ g ].mul( dens.m ) );
		const tSun = sunTransmittance( transmittance, c, at.h, at.muS, sunSinRadius );
		const seg = segment( extinction( c, dens ), dt );

		if ( psi ) {

			If( i.mod( MS_STRIDE ).equal( 0 ), () => {

				const next = sampleMultipleScattering( multipleScattering, at.h, at.muS, at.mu, azimuthCos( nu, at.mu, at.muS ) );
				for ( let k = 0; k < 8; k ++ ) psi[ k ].assign( next[ k ] );

			} );

		}

		for ( const g of G4 ) {

			let S = tSun[ g ].mul( sR[ g ].mul( phaseR ).add( sM[ g ].mul( phaseM ) ) );
			if ( psi ) S = S.add( sR[ g ].mul( psi[ g ] ) ).add( sM[ g ].mul( psi[ 4 + g ] ) );
			L[ g ].addAssign( throughput[ g ].mul( S ).mul( seg[ g ].weight ) );
			throughput[ g ].mulAssign( seg[ g ].transmittance );

		}

	} );

	return { L, throughput };

}

/**
 * Sky irradiance on level ground per unit solar irradiance, against the sun's zenith cosine.
 */
export function buildIrradianceKernel( io, { sqrtDirections = 12, steps = 32 } = {} ) {

	const { irradiance: out } = io;
	const count = IRRADIANCE_SIZE;
	const directions = sqrtDirections * sqrtDirections;
	const h0 = float( 1e-3 );

	return Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( count ) ), () => {

			Return();

		} );

		const muS = sunAxis( idx, IRRADIANCE_SIZE ).toVar();
		const sun = vec3( sqrt( max( float( 1 ).sub( muS.mul( muS ) ), 0 ) ), muS, 0 ).toVar();
		const E = spectrum( () => vec4( 0 ).toVar() );

		Loop( { start: int( 0 ), end: int( directions ), type: 'int', condition: '<', name: 'dirIndex' }, ( { dirIndex: k } ) => {

			// Cosine-weighted, so the estimate is π × the mean radiance.
			const a = float( k.div( sqrtDirections ) ).add( 0.5 ).div( sqrtDirections );
			const bb = float( k.mod( sqrtDirections ) ).add( 0.5 ).div( sqrtDirections );
			const sinT = sqrt( a );
			const phi = bb.mul( 2 * PI );
			const dir = vec3( sinT.mul( cos( phi ) ), sqrt( max( float( 1 ).sub( a ), 0 ) ), sinT.mul( sin( phi ) ) ).toVar();
			const { L } = inscatter( io, rayExtent( h0, dir.y ), muS, dot( dir, sun ), steps );
			for ( const g of G4 ) E[ g ].addAssign( L[ g ] );

		} );

		for ( const g of G4 ) out.element( idx.mul( 4 ).add( g ) ).assign( toLog( E[ g ].mul( PI / directions ) ) );

	} )().compute( count, [ 64 ] );

}

// The sky without its sun disc, in the engine's equirect mapping (row 0 = nadir). Radiance depends
// only on elevation and azimuth from the sun, mirrored: rows are the equirect's own, so the horizon
// stays exact, and columns cover [0, π] as π·s², dense around the sun.
export const SKY_COLUMNS = 256;
const columnAzimuth = k => float( k ).div( SKY_COLUMNS - 1 ).pow( 2 ).mul( PI );

/** @returns {Array} kernels: the half-sky rows, then the equirect filled from them */
export function buildSkyViewKernels( io, { width, height, steps = 40, multipleScattering = true } ) {

	const { sky, skyRows, irradiance, coefficients: c, rgb, sunDirection, altitude, sunSinRadius, transmittance } = io;
	const scatter = multipleScattering ? io : { ...io, multipleScattering: null };
	const rowCount = SKY_COLUMNS * height;

	const rows = Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( rowCount ) ), () => {

			Return();

		} );

		const phi = float( 1 ).sub( float( idx.div( SKY_COLUMNS ) ).add( 0.5 ).div( height ) ).mul( PI );
		const dirY = cos( phi ).toVar();
		const h0 = max( altitude, 1e-3 ).toVar();
		const muS0 = sunDirection.y.toVar();
		const nu = sin( phi ).mul( cos( columnAzimuth( idx.mod( SKY_COLUMNS ) ) ) ).mul( sqrt( max( float( 1 ).sub( muS0.mul( muS0 ) ), 0 ) ) ).add( dirY.mul( muS0 ) ).toVar();
		const ray = rayExtent( h0, dirY );

		const { L, throughput } = inscatter( scatter, ray, muS0, nu, steps );

		If( ray.hitsGround, () => {

			const muG = clamp( ray.r.mul( muS0 ).add( ray.tMax.mul( nu ) ).div( RG ), - 1, 1 ).toVar();
			const tSun = sunTransmittance( transmittance, c, float( 0 ), muG, sunSinRadius );
			const eSky = skyIrradiance( irradiance, muG );
			for ( const g of G4 ) {

				L[ g ].addAssign( throughput[ g ].mul( c.albedo[ g ] ).mul( 1 / PI ).mul( tSun[ g ].mul( max( muG, 0 ) ).add( eSky[ g ] ) ) );

			}

		} );

		const radiance = spectrum( g => L[ g ].mul( c.solar[ g ] ) );
		const channel = row => radiance.reduce( ( acc, s, g ) => acc.add( dot( s, rgb[ row * 4 + g ] ) ), float( 0 ) );
		skyRows.element( idx ).assign( vec4( max( vec3( channel( 0 ), channel( 1 ), channel( 2 ) ), vec3( 0 ) ), 1 ) );

	} )().compute( rowCount, [ 64 ] );

	const fill = Fn( () => {

		const idx = instanceIndex;
		If( idx.greaterThanEqual( uint( width * height ) ), () => {

			Return();

		} );

		const theta = float( idx.mod( width ) ).add( 0.5 ).div( width ).sub( 0.5 ).mul( 2 * PI );
		const d = theta.sub( atan( sunDirection.z, sunDirection.x ) );
		const azimuth = abs( atan( sin( d ), cos( d ) ) );
		const x = sqrt( azimuth.div( PI ) ).mul( SKY_COLUMNS - 1 ).toVar();
		const k = min( floor( x ), SKY_COLUMNS - 2 ).toVar();
		const base = idx.div( width ).mul( SKY_COLUMNS ).add( uint( k ) ).toVar();
		sky.element( idx ).assign( mix( skyRows.element( base ), skyRows.element( base.add( 1 ) ), x.sub( k ) ) );

	} )().compute( width * height, [ 64 ] );

	return [ rows, fill ];

}
