import { describe, it, expect } from 'vitest';
import { subsurfaceFromDiffuse, dipoleReflectance } from '@/core/materials/Scattering.js';
import { namedScattering } from '@/core/addons/archives/pbrt/PBRTScattering.js';

describe( 'subsurfaceFromDiffuse', () => {

	// A measured medium, seen as its dipole colour and diffuse mean free path 1 / σtr, comes back as its own coefficients.
	it( 'recovers a measured medium\'s single-scatter albedo and mean free path', () => {

		for ( const name of [ 'Skin1', 'Wholemilk', 'Marble', 'Ketchup', 'Coke' ] ) {

			const { sigmaS, sigmaA } = namedScattering( name );
			const sigmaT = sigmaS.map( ( s, c ) => s + sigmaA[ c ] );
			const albedo = sigmaS.map( ( s, c ) => s / sigmaT[ c ] );
			const reflectance = albedo.map( ( a ) => dipoleReflectance( a, 1.33 ) );
			const diffuse = sigmaT.map( ( t, c ) => 1 / Math.sqrt( 3 * sigmaA[ c ] * t ) );

			const { subsurfaceColor, subsurfaceRadius } = subsurfaceFromDiffuse( reflectance, diffuse, 1.33 );
			subsurfaceColor.forEach( ( a, c ) => expect( a ).toBeCloseTo( albedo[ c ], 6 ) );
			subsurfaceRadius.forEach( ( r, c ) => expect( r / ( 1 / sigmaT[ c ] ) ).toBeCloseTo( 1, 4 ) );

		}

	} );

	it( 'matches RenderMan\'s skin: Jensen\'s Skin1 spreads 3.67, 1.37 and 0.68 mm', () => {

		const { sigmaS, sigmaA } = namedScattering( 'Skin1' );
		const diffuse = sigmaS.map( ( s, c ) => 1 / Math.sqrt( 3 * sigmaA[ c ] * ( s + sigmaA[ c ] ) ) );
		[ 3.67, 1.37, 0.68 ].forEach( ( d, c ) => expect( diffuse[ c ] ).toBeCloseTo( d, 2 ) );

	} );

} );
