import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { focusDistanceOfHit, viewDepth } from '@/core/managers/InteractionManager.js';

describe( 'focusDistanceOfHit', () => {

	const camera = new PerspectiveCamera( 60, 1.5, 0.1, 100 );
	camera.position.set( 2, 1, 5 );
	camera.lookAt( 0, 0, 0 );
	camera.updateMatrixWorld();
	const forward = camera.getWorldDirection( new Vector3() );

	const hitAt = ( ndc, distance ) => {

		const raycaster = new Raycaster();
		raycaster.setFromCamera( ndc, camera );
		return { distance, point: raycaster.ray.at( distance, new Vector3() ) };

	};

	it( 'returns the depth along the view axis, which is what a flat focal plane needs', () => {

		const hit = hitAt( { x: 0.9, y: - 0.8 }, 4 );
		const depth = hit.point.clone().sub( camera.position ).dot( forward );

		expect( focusDistanceOfHit( hit, camera ) ).toBeCloseTo( depth, 6 );
		expect( viewDepth( hit.point, camera ) ).toBeCloseTo( depth, 6 );
		expect( depth ).toBeLessThan( 3.5 );

	} );

	it( 'is the hit distance at the image centre', () => {

		expect( focusDistanceOfHit( hitAt( { x: 0, y: 0 }, 4 ), camera ) ).toBeCloseTo( 4, 6 );

	} );

	it( 'keeps the distance along the ray for a panorama', () => {

		expect( focusDistanceOfHit( hitAt( { x: 0.9, y: - 0.8 }, 4 ), camera, true ) ).toBe( 4 );

	} );

} );
