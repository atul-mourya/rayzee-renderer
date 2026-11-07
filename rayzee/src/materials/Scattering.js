/**
 * The random walk's inputs (single-scatter albedo, mean free path) from the colour a material shows and how far its
 * light spreads, through the classical dipole (Jensen et al. 2001).
 */

/**
 * Total diffuse reflectance of a half space of reduced albedo α′ and relative index η under the classical dipole
 * (Jensen et al. 2001): (α′ / 2) (1 + e^(−4/3 A √(3(1 − α′)))) e^(−√(3(1 − α′))).
 */
export function dipoleReflectance( albedo, eta ) {

	const fdr = - 1.440 / ( eta * eta ) + 0.710 / eta + 0.668 + 0.0636 * eta;
	const A = ( 1 + fdr ) / ( 1 - fdr );
	const s = Math.sqrt( 3 * ( 1 - albedo ) );
	return albedo / 2 * ( 1 + Math.exp( - 4 / 3 * A * s ) ) * Math.exp( - s );

}

/** The reduced albedo whose dipole reflectance is `reflectance` (pbrt inverts its own table the same way). */
export function albedoForReflectance( reflectance, eta ) {

	const target = Math.min( Math.max( reflectance, 0 ), dipoleReflectance( 1, eta ) );
	let lo = 0, hi = 1;
	for ( let i = 0; i < 48; i ++ ) {

		const mid = ( lo + hi ) / 2;
		if ( dipoleReflectance( mid, eta ) < target ) lo = mid;
		else hi = mid;

	}

	return ( lo + hi ) / 2;

}

/**
 * The engine's subsurface inputs for a medium that shows `reflectance` and spreads its light over the diffuse mean free
 * path ld = 1 / σtr — Jensen et al.'s, and the subsurface radius of RenderMan and the Physically Based database — under
 * a boundary of `ior`. With σtr = σt √(3 (1 − α′)) (g = 0), the mean free path is ld √(3 (1 − α′)).
 * @param {number[]} reflectance - linear RGB, 0–1
 * @param {number[]} diffuseMeanFreePath - per channel, in any length unit: the radius comes back in it
 * @param {number} [ior=1.33]
 * @returns {{ subsurfaceColor: number[], subsurfaceRadius: number[] }}
 */
export function subsurfaceFromDiffuse( reflectance, diffuseMeanFreePath, ior = 1.33 ) {

	const subsurfaceColor = reflectance.map( ( r ) => albedoForReflectance( r, ior ) );
	const subsurfaceRadius = diffuseMeanFreePath.map( ( ld, c ) => ld * Math.sqrt( 3 * ( 1 - subsurfaceColor[ c ] ) ) );
	return { subsurfaceColor, subsurfaceRadius };

}
