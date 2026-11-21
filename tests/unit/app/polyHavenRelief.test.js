import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshPhysicalMaterial, Texture } from 'three';
vi.mock( '@/lib/appProxy', () => ( { getApp: () => null } ) );
import { PolyHavenMaterialLoader } from '@/services/PolyHavenMaterialLoader';

function relief( geometry, scale = 1 ) {

	const material = new MeshPhysicalMaterial( { displacementMap: new Texture() } );
	material.displacementMap.repeat.set( 2, 2 );
	const mesh = new Mesh( geometry, material );
	mesh.scale.setScalar( scale );
	PolyHavenMaterialLoader.fitDisplacement( mesh, material );
	return material.displacementScale / PolyHavenMaterialLoader.RELIEF_OF_TILE;

}

describe( 'PolyHaven relief', () => {

	it( 'sizes a mesh without uvs as the engine projects it: one uv unit its largest extent', () => {

		const box = new BoxGeometry( 4, 2, 1 );
		// Each face of BoxGeometry spans the whole uv square: the 4 × 2 face's tile is 2 wide at repeat 2.
		expect( relief( box ) ).toBeGreaterThan( 0 );
		box.deleteAttribute( 'uv' );
		expect( relief( box ) ).toBeCloseTo( 2, 9 );
		expect( relief( box, 3 ) ).toBeCloseTo( 6, 9 );

	} );

} );
