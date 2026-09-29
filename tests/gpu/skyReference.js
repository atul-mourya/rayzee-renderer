/**
 * Brute-force Monte Carlo reference for the physical sky: the same atmosphere, every scattering
 * order and the ground bounce traced exactly, per wavelength bin. Slow; for validation only.
 */

import {
	GROUND_RADIUS as RG, TOP_RADIUS as RT, MIE_PHASE_G, SOLAR_SPECTRUM, SKY_RADIANCE_SCALE, LAMBDA_COUNT,
	rayleighDensity, mieDensity, ozoneDensity, opticalDepth, spectrumToRec709,
} from '@/core/Processor/AtmosphereModel.js';

// Seeded so a failing comparison reproduces.
export function rng( seed = 1 ) {

	let s = seed >>> 0;
	return () => {

		s = ( s + 0x6D2B79F5 ) >>> 0;
		let t = s;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/** Density-weighted path lengths to the top, tabulated finely over (altitude, µ). */
export function depthTable( rows = 256, cols = 512 ) {

	const table = new Float64Array( rows * cols * 3 );
	for ( let j = 0; j < rows; j ++ ) {

		const h = ( RT - RG ) * ( j / ( rows - 1 ) ) ** 2;
		for ( let i = 0; i < cols; i ++ ) {

			const mu = - 1 + 2 * i / ( cols - 1 );
			const d = opticalDepth( h, mu, 256 );
			const o = ( j * cols + i ) * 3;
			if ( d ) {

				table[ o ] = d[ 0 ]; table[ o + 1 ] = d[ 1 ]; table[ o + 2 ] = d[ 2 ];

			} else {

				table[ o ] = table[ o + 1 ] = table[ o + 2 ] = Infinity;

			}

		}

	}

	return { table, rows, cols };

}

function sunDepth( { table, rows, cols }, h, mu ) {

	// The table spans rays that clear the planet; below the horizon the sun is simply hidden.
	const r = RG + h;
	if ( mu < - Math.sqrt( Math.max( 0, 1 - ( RG / r ) ** 2 ) ) ) return null;
	const fy = Math.sqrt( Math.min( Math.max( h / ( RT - RG ), 0 ), 1 ) ) * ( rows - 1 );
	const fx = ( mu + 1 ) / 2 * ( cols - 1 );
	const y0 = Math.min( Math.floor( fy ), rows - 2 ), x0 = Math.min( Math.floor( fx ), cols - 2 );
	const ty = fy - y0, tx = fx - x0;
	const out = [ 0, 0, 0 ];
	for ( let c = 0; c < 3; c ++ ) {

		const at = ( x, y ) => table[ ( y * cols + x ) * 3 + c ];
		const v = ( at( x0, y0 ) * ( 1 - tx ) + at( x0 + 1, y0 ) * tx ) * ( 1 - ty ) + ( at( x0, y0 + 1 ) * ( 1 - tx ) + at( x0 + 1, y0 + 1 ) * tx ) * ty;
		if ( ! Number.isFinite( v ) ) return null;
		out[ c ] = v;

	}

	return out;

}

const rayleighPhase = nu => 3 / ( 16 * Math.PI ) * ( 1 + nu * nu );

function miePhase( nu, g = MIE_PHASE_G ) {

	const g2 = g * g;
	return 3 / ( 8 * Math.PI ) * ( 1 - g2 ) / ( 2 + g2 ) * ( 1 + nu * nu ) / Math.pow( 1 + g2 - 2 * g * nu, 1.5 );

}

function hgPhase( nu, g ) {

	const g2 = g * g;
	return ( 1 - g2 ) / ( 4 * Math.PI * Math.pow( 1 + g2 - 2 * g * nu, 1.5 ) );

}

function frame( w ) {

	const a = Math.abs( w[ 0 ] ) > 0.9 ? [ 0, 1, 0 ] : [ 1, 0, 0 ];
	const u = normalize( cross( a, w ) );
	return [ u, cross( w, u ) ];

}

const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const cross = ( a, b ) => [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
const normalize = a => {

	const l = Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] );
	return [ a[ 0 ] / l, a[ 1 ] / l, a[ 2 ] / l ];

};

function around( w, cosT, phi ) {

	const [ u, v ] = frame( w );
	const s = Math.sqrt( Math.max( 0, 1 - cosT * cosT ) );
	return normalize( [ 0, 1, 2 ].map( i => w[ i ] * cosT + ( u[ i ] * Math.cos( phi ) + v[ i ] * Math.sin( phi ) ) * s ) );

}

function sampleHG( w, g, rand ) {

	const x = rand();
	const s = ( 1 - g * g ) / ( 1 + g - 2 * g * x );
	const cosT = Math.abs( g ) < 1e-3 ? 1 - 2 * x : ( 1 + g * g - s * s ) / ( 2 * g );
	return around( w, cosT, 2 * Math.PI * rand() );

}

function sampleRayleigh( w, rand ) {

	for ( ;; ) {

		const cosT = 1 - 2 * rand();
		if ( rand() * 2 <= 1 + cosT * cosT ) return around( w, cosT, 2 * Math.PI * rand() );

	}

}

function toGround( p, d ) {

	const b = dot( p, d );
	const c = dot( p, p ) - RG * RG;
	const disc = b * b - c;
	if ( disc < 0 || b > 0 ) return Infinity;
	const t = - b - Math.sqrt( disc );
	return t > 0 ? t : Infinity;

}

function toTop( p, d ) {

	const b = dot( p, d );
	const c = dot( p, p ) - RT * RT;
	return - b + Math.sqrt( Math.max( b * b - c, 0 ) );

}

/**
 * Radiance per wavelength bin seen from `altitude` km along `view`, per unit solar irradiance.
 * @returns {Float64Array} one value per bin in `bins`
 */
export function referenceRadiance( { coefficients: c, sun, view, altitude, bins, paths = 20000, seed = 7, depth, maxOrders = 64 } ) {

	const rand = rng( seed );
	const result = new Float64Array( bins.length );

	bins.forEach( ( k, bi ) => {

		const sR = c.rayleigh[ k ], sMs = c.mieScattering[ k ], sMe = c.mieExtinction[ k ], sO = c.ozone[ k ];
		const majorant = sR + sMe + sO;
		const tSun = ( h, mu ) => {

			const d = sunDepth( depth, h, mu );
			return d ? Math.exp( - ( sR * d[ 0 ] + sMe * d[ 1 ] + sO * d[ 2 ] ) ) : 0;

		};

		let sum = 0;
		for ( let n = 0; n < paths; n ++ ) {

			let p = [ 0, RG + altitude, 0 ];
			let d = view;
			let throughput = 1;

			for ( let order = 0; order < maxOrders; order ++ ) {

				const tGround = toGround( p, d );
				const tMax = Math.min( tGround, toTop( p, d ) );

				// Delta tracking against the sea-level majorant.
				let t = 0, collided = false, h = 0;
				for ( ;; ) {

					t -= Math.log( 1 - rand() ) / majorant;
					if ( t >= tMax ) break;
					const q = [ p[ 0 ] + d[ 0 ] * t, p[ 1 ] + d[ 1 ] * t, p[ 2 ] + d[ 2 ] * t ];
					h = Math.hypot( q[ 0 ], q[ 1 ], q[ 2 ] ) - RG;
					const sigmaT = sR * rayleighDensity( h ) + sMe * mieDensity( h ) + sO * ozoneDensity( h );
					if ( rand() * majorant < sigmaT ) {

						p = q;
						collided = true;
						break;

					}

				}

				if ( collided ) {

					const dR = sR * rayleighDensity( h ), dM = sMs * mieDensity( h );
					const sigmaT = dR + sMe * mieDensity( h ) + sO * ozoneDensity( h );
					throughput *= ( dR + dM ) / sigmaT;

					const up = normalize( p );
					const mu = dot( up, sun );
					const nu = dot( d, sun );
					sum += throughput * ( dR * rayleighPhase( nu ) + dM * miePhase( nu ) ) / ( dR + dM ) * tSun( h, mu );

					if ( rand() * ( dR + dM ) < dR ) {

						d = sampleRayleigh( d, rand );

					} else {

						const next = sampleHG( d, MIE_PHASE_G, rand );
						throughput *= miePhase( dot( d, next ) ) / hgPhase( dot( d, next ), MIE_PHASE_G );
						d = next;

					}

				} else if ( tGround <= tMax ) {

					p = [ p[ 0 ] + d[ 0 ] * tGround, p[ 1 ] + d[ 1 ] * tGround, p[ 2 ] + d[ 2 ] * tGround ];
					const n = normalize( p );
					p = [ n[ 0 ] * ( RG + 1e-6 ), n[ 1 ] * ( RG + 1e-6 ), n[ 2 ] * ( RG + 1e-6 ) ];
					const albedo = c.albedo[ k ];
					const mu = dot( n, sun );
					if ( mu > 0 ) sum += throughput * albedo / Math.PI * mu * tSun( 0, mu );
					throughput *= albedo;
					const x = rand();
					d = around( n, Math.sqrt( 1 - x ), 2 * Math.PI * rand() );

				} else {

					break;

				}

				if ( order > 3 ) {

					const q = Math.min( throughput, 0.95 );
					if ( rand() > q ) break;
					throughput /= q;

				}

			}

		}

		result[ bi ] = sum / paths;

	} );

	return result;

}

/** Engine RGB from a full 16-bin spectrum per unit solar irradiance. */
export function spectrumToEngineRGB( perUnit ) {

	const w = spectrumToRec709( SKY_RADIANCE_SCALE );
	return [ 0, 1, 2 ].map( row => {

		let s = 0;
		for ( let k = 0; k < LAMBDA_COUNT; k ++ ) s += perUnit[ k ] * SOLAR_SPECTRUM[ k ] * w[ row * LAMBDA_COUNT + k ];
		return s;

	} );

}

/** Single scattering by straight quadrature — an independent check on the Monte Carlo. */
export function singleScattering( { coefficients: c, sun, view, altitude, bins, depth, steps = 4000 } ) {

	const p0 = [ 0, RG + altitude, 0 ];
	const tGround = toGround( p0, view );
	const tMax = Math.min( tGround, toTop( p0, view ) );
	const nu = dot( view, sun );
	return Float64Array.from( bins, k => {

		const sR = c.rayleigh[ k ], sMs = c.mieScattering[ k ], sMe = c.mieExtinction[ k ], sO = c.ozone[ k ];
		let L = 0, tau = 0;
		for ( let i = 0; i < steps; i ++ ) {

			const t0 = tMax * ( i / steps ) ** 2, t1 = tMax * ( ( i + 1 ) / steps ) ** 2;
			const t = 0.5 * ( t0 + t1 ), dt = t1 - t0;
			const q = [ p0[ 0 ] + view[ 0 ] * t, p0[ 1 ] + view[ 1 ] * t, p0[ 2 ] + view[ 2 ] * t ];
			const h = Math.hypot( q[ 0 ], q[ 1 ], q[ 2 ] ) - RG;
			const dR = sR * rayleighDensity( h ), dM = sMs * mieDensity( h );
			const sigmaT = dR + sMe * mieDensity( h ) + sO * ozoneDensity( h );
			const d = sunDepth( depth, h, dot( normalize( q ), sun ) );
			const tSun = d ? Math.exp( - ( sR * d[ 0 ] + sMe * d[ 1 ] + sO * d[ 2 ] ) ) : 0;
			L += Math.exp( - tau - 0.5 * sigmaT * dt ) * ( dR * rayleighPhase( nu ) + dM * miePhase( nu ) ) * tSun * dt;
			tau += sigmaT * dt;

		}

		return L;

	} );

}
