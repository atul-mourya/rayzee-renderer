import { describe, it, expect } from 'vitest';
import { Matrix4, OrthographicCamera, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { ViewCamera, viewMatrixOf } from '@/core/scene/ViewCamera.js';

function camera() {

	const c = new ViewCamera( 60, 2, 0.1, 100 );
	c.position.set( 1, 2, 10 );
	c.updateMatrixWorld();
	return c;

}

describe( 'ViewCamera', () => {

	it( 'is an ordinary perspective camera until it turns orthographic', () => {

		const c = camera();
		const reference = new PerspectiveCamera( 60, 2, 0.1, 100 );

		expect( c ).toBeInstanceOf( PerspectiveCamera );
		expect( [ c.isPerspectiveCamera, c.isOrthographicCamera ] ).toEqual( [ true, false ] );
		expect( c.projectionMatrix.equals( reference.projectionMatrix ) ).toBe( true );

	} );

	it( 'projects exactly as an OrthographicCamera of the same frustum, zoom included', () => {

		const c = camera();
		c.orthographic = true;
		c.orthoHalfHeight = 3;
		c.zoom = 2;
		c.updateProjectionMatrix();

		const reference = new OrthographicCamera( - 6, 6, 3, - 3, 0.1, 100 );
		reference.zoom = 2;
		reference.updateProjectionMatrix();

		expect( [ c.isPerspectiveCamera, c.isOrthographicCamera ] ).toEqual( [ false, true ] );
		expect( c.projectionMatrix.equals( reference.projectionMatrix ) ).toBe( true );
		expect( c.projectionMatrixInverse.equals( reference.projectionMatrixInverse ) ).toBe( true );

	} );

	it( 'is picked from as an orthographic camera: parallel rays from its image plane', () => {

		const c = camera();
		c.orthographic = true;
		c.orthoHalfHeight = 3;
		c.updateProjectionMatrix();

		const raycaster = new Raycaster();
		raycaster.setFromCamera( { x: 1, y: - 1 }, c );

		expect( raycaster.ray.origin.x ).toBeCloseTo( 1 + 6, 6 );
		expect( raycaster.ray.origin.y ).toBeCloseTo( 2 - 3, 6 );
		expect( raycaster.ray.origin.z ).toBeCloseTo( 10, 6 );
		expect( raycaster.ray.direction.equals( new Vector3( 0, 0, - 1 ) ) ).toBe( true );

	} );

	it( 'keeps its projection through clone', () => {

		const c = camera();
		c.orthographic = true;
		c.orthoHalfHeight = 4;
		const copy = c.clone();

		expect( copy ).toBeInstanceOf( ViewCamera );
		expect( [ copy.isOrthographicCamera, copy.orthoHalfHeight ] ).toEqual( [ true, 4 ] );

	} );

} );

describe( 'viewMatrixOf', () => {

	const identity = ( m ) => m.elements.every( ( v, i ) => Math.abs( v - ( i % 5 === 0 ? 1 : 0 ) ) < 1e-12 );

	it( 'undoes a mirrored camera\'s world matrix, which three\'s own view matrix does not', () => {

		const c = camera();
		c.scale.set( - 1, 1, 1 );
		c.lookAt( 3, 0, 0 );
		c.updateMatrixWorld();

		expect( identity( viewMatrixOf( c, new Matrix4() ).multiply( c.matrixWorld ) ) ).toBe( true );
		expect( identity( c.matrixWorldInverse.clone().multiply( c.matrixWorld ) ) ).toBe( false );

	} );

	it( 'is three\'s view matrix for any camera without a mirror, scaled or not', () => {

		for ( const scale of [ 1, 2 ] ) {

			const c = camera();
			c.scale.setScalar( scale );
			c.lookAt( 3, 0, 0 );
			c.updateMatrixWorld();
			expect( viewMatrixOf( c, new Matrix4() ).elements ).toEqual( c.matrixWorldInverse.elements );

		}

	} );

} );
