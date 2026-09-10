/**
 * Regression cover for issue #13 — loadObject3D()/addModelFromObject3D() used to take a
 * caller-owned Object3D and reparent it, rewrite its node tree in place, and orphan it on
 * dispose. The engine now renders a copy, so the caller's tree is never observed to change.
 */
import { describe, expect, it } from 'vitest';
import {
	BoxGeometry, Bone, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, Object3D,
	PerspectiveCamera, PointLight, Scene, SkinnedMesh, Skeleton, Uint16BufferAttribute, Vector3,
} from 'three';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';

// onModelLoad() reframes the camera through OrbitControls; only these members are touched.
const stubControls = () => ( {
	target: new Vector3(),
	maxDistance: 0,
	saveState() {},
	update() {},
} );

const newLoader = () => new AssetLoader( new Scene(), new PerspectiveCamera(), stubControls() );

const findAll = ( root, predicate ) => {

	const hits = [];
	root.traverse( o => predicate( o ) && hits.push( o ) );
	return hits;

};

function multiMaterialMesh( name ) {

	const geometry = new BoxGeometry();
	geometry.clearGroups(); // BoxGeometry ships one group per face; we want exactly two
	geometry.addGroup( 0, 18, 0 );
	geometry.addGroup( 18, 18, 1 );
	const mesh = new Mesh( geometry, [ new MeshStandardMaterial(), new MeshStandardMaterial() ] );
	mesh.name = name;
	return mesh;

}

function areaLightPlaceholder() {

	const object = new Object3D();
	object.name = 'RectAreaLightPlaceholder_ceiling';
	object.userData = {
		name: 'ceiling', type: 'RectAreaLight',
		color: [ 1, 1, 1 ], intensity: 10, width: 1, height: 1,
	};
	return object;

}

/** A caller's live scene: scene → stage (transformed) → design. */
function hostScene() {

	const scene = new Scene();
	const stage = new Group();
	stage.position.set( 100, 0, - 50 );
	stage.scale.setScalar( 10 );
	scene.add( stage );

	const design = new Group();
	stage.add( design );
	scene.updateMatrixWorld( true );
	return { stage, design };

}

describe( 'AssetLoader — caller-owned Object3D is never mutated', () => {

	it( 'leaves the caller tree parented where it was, through release', async () => {

		const { stage, design } = hostScene();
		design.add( new Mesh( new BoxGeometry(), new MeshStandardMaterial() ) );

		const loader = newLoader();
		await loader.loadObject3D( design );

		expect( design.parent ).toBe( stage );
		expect( loader.targetModel ).not.toBe( design );

		loader.releaseTargetModel();
		expect( design.parent ).toBe( stage );

	} );

	it( 'does not rewrite multi-material meshes in the caller tree', async () => {

		const { design } = hostScene();
		const original = multiMaterialMesh( 'multi' );
		const sourceIndex = original.geometry.index;
		design.add( original );

		const loader = newLoader();
		await loader.loadObject3D( design );

		expect( design.children ).toContain( original );
		expect( Array.isArray( original.material ) ).toBe( true );
		expect( original.geometry.index ).toBe( sourceIndex ); // mergeGroups() reorders in place
		expect( original.geometry.userData.__rayzeeOwned ).toBeUndefined();

		// ...while the rendered copy is split.
		const copies = findAll( loader.targetModel, o => o.isMesh );
		expect( copies ).toHaveLength( 2 );
		expect( copies.every( m => ! Array.isArray( m.material ) ) ).toBe( true );

	} );

	it( 'builds the area light on the copy, never on the caller placeholder', async () => {

		const { design } = hostScene();
		const placeholder = areaLightPlaceholder();
		design.add( placeholder );

		const loader = newLoader();
		await loader.loadObject3D( design );

		expect( findAll( loader.targetModel, o => o.isRectAreaLight ) ).toHaveLength( 1 );
		expect( placeholder.children ).toHaveLength( 0 );

	} );

	it( 'does not rewrite caller light intensities', async () => {

		const { design } = hostScene();
		const light = new PointLight( 0xffffff, 1 );
		design.add( light );

		await newLoader().loadObject3D( design );

		expect( light.intensity ).toBe( 1 );
		expect( light.userData.__candelaConverted ).toBeUndefined();

	} );

	it( 'does not assign a name to the caller object', async () => {

		const { design } = hostScene();

		const loader = newLoader();
		await loader.loadObject3D( design, 'my-model' );

		expect( design.name ).toBe( '' );
		expect( loader.targetModel.name ).toBe( 'my-model' );

	} );

	it( 'bakes the ancestor transform so the copy renders where the host sees it', async () => {

		const { design } = hostScene();
		design.position.set( 1, 2, 3 );
		design.parent.updateMatrixWorld( true );
		const expected = design.matrixWorld.clone();

		const loader = newLoader();
		await loader.loadObject3D( design );

		expect( loader.targetModel.matrixWorld.elements )
			.toEqual( expected.elements.map( v => expect.closeTo( v, 10 ) ) );

	} );

	it( 'rebinds a cloned skeleton onto the cloned bones', async () => {

		const { design } = hostScene();
		const bone = new Bone();
		const geometry = new BoxGeometry();
		const vertexCount = geometry.attributes.position.count;
		geometry.setAttribute( 'skinIndex', new Uint16BufferAttribute( new Uint16Array( vertexCount * 4 ), 4 ) );
		const weights = new Float32Array( vertexCount * 4 );
		for ( let i = 0; i < vertexCount; i ++ ) weights[ i * 4 ] = 1;
		geometry.setAttribute( 'skinWeight', new Float32BufferAttribute( weights, 4 ) );

		const skinned = new SkinnedMesh( geometry, new MeshStandardMaterial() );
		skinned.add( bone );
		skinned.bind( new Skeleton( [ bone ] ) );
		design.add( skinned );

		const loader = newLoader();
		await loader.loadObject3D( design );

		const [ copy ] = findAll( loader.targetModel, o => o.isSkinnedMesh );
		expect( copy ).not.toBe( skinned );
		expect( copy.skeleton ).not.toBe( skinned.skeleton );
		expect( copy.skeleton.bones[ 0 ] ).not.toBe( bone );

	} );

	it( 'reports unserializable userData instead of a raw JSON TypeError', async () => {

		const { design } = hostScene();
		design.name = 'widget';
		const mesh = new Mesh( new BoxGeometry(), new MeshStandardMaterial() );
		mesh.userData.owner = mesh; // a host back-reference; three cannot JSON-clone it
		design.add( mesh );

		await expect( newLoader().loadObject3D( design ) )
			.rejects.toThrow( /widget.*userData must be JSON-serializable/ );

	} );

} );

describe( 'AssetLoader — release frees engine allocations only', () => {

	it( 'disposes split geometry but not the resources shared with the caller', async () => {

		const { design } = hostScene();
		const original = multiMaterialMesh( 'multi' );
		design.add( original );

		const disposed = [];
		original.geometry.addEventListener( 'dispose', () => disposed.push( 'source-geometry' ) );
		original.material.forEach( ( m, i ) => m.addEventListener( 'dispose', () => disposed.push( `source-material-${i}` ) ) );

		const loader = newLoader();
		await loader.loadObject3D( design );

		findAll( loader.targetModel, o => o.isMesh )
			.forEach( ( m, i ) => m.geometry.addEventListener( 'dispose', () => disposed.push( `split-${i}` ) ) );

		loader.releaseTargetModel();

		expect( disposed.sort() ).toEqual( [ 'split-0', 'split-1' ] );

	} );

} );

describe( 'AssetLoader.appendObject3D', () => {

	it( 'carries the source uuid onto the copy, and gives a second copy its own', () => {

		const { design } = hostScene();
		const loader = newLoader();

		const first = loader.appendObject3D( design ).root;
		const second = loader.appendObject3D( design ).root;

		expect( first ).not.toBe( design );
		expect( first.uuid ).toBe( design.uuid );
		expect( second.uuid ).not.toBe( first.uuid );
		expect( loader.scene.children ).toHaveLength( 2 );

	} );

} );

describe( 'AssetLoader.processModelObjects — traversal safety', () => {

	// Object3D.traverse() caches children.length, so splitting in place used to shift later
	// siblings down a slot and skip every other one.
	it.each( [ 2, 3 ] )( 'splits all %i multi-material siblings', ( n ) => {

		const root = new Group();
		const meshes = Array.from( { length: n }, ( _, i ) => multiMaterialMesh( `m${i}` ) );
		meshes.forEach( m => root.add( m ) );

		newLoader().processModelObjects( root );

		expect( meshes.filter( m => root.children.includes( m ) ) ).toHaveLength( 0 );
		expect( root.children ).toHaveLength( n );
		expect( findAll( root, o => o.isMesh && Array.isArray( o.material ) ) ).toHaveLength( 0 );

	} );

	it( 'still processes siblings that follow a split', () => {

		const root = new Group();
		root.add( multiMaterialMesh( 'multi' ) );
		const light = new PointLight( 0xffffff, 1 );
		root.add( light );

		newLoader().processModelObjects( root );

		expect( light.userData.__candelaConverted ).toBe( true );

	} );

} );
