import { describe, it, expect } from 'vitest';
import { MeshPhysicalMaterial, FrontSide, BackSide, DoubleSide } from 'three';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';

const sideOf = params => new GeometryExtractor().getMaterialSide( new MeshPhysicalMaterial( params ) );

describe( 'GeometryExtractor.getMaterialSide', () => {

	it( 'maps three.js sides onto the triangle flag', () => {

		expect( sideOf( { side: FrontSide } ) ).toBe( 0 );
		expect( sideOf( { side: BackSide } ) ).toBe( 1 );
		expect( sideOf( { side: DoubleSide } ) ).toBe( 2 );
		expect( sideOf( { side: FrontSide, transmission: 1 } ) ).toBe( 2 );

	} );

} );
