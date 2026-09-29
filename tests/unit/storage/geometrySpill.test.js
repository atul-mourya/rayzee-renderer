import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, SphereGeometry } from 'three';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { GeometrySpill } from '@/core/Storage/GeometrySpill.js';

function snapshot( geometry ) {

	const out = {};
	for ( const [ name, attribute ] of Object.entries( geometry.attributes ) ) out[ name ] = attribute.array.slice();
	if ( geometry.index ) out.index = geometry.index.array.slice();
	return out;

}

function big() {

	// Past the size that gets a write of its own.
	const g = new BufferGeometry();
	const positions = new Float32Array( 3 * 800_000 );
	for ( let i = 0; i < positions.length; i ++ ) positions[ i ] = Math.sin( i );
	g.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	return g;

}

describe( 'GeometrySpill', () => {

	let storage, uninstall;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	it( 'empties the arrays while they are on disk and puts back exactly what was there', async () => {

		const box = new BoxGeometry( 1, 2, 3 );
		const sphere = new SphereGeometry( 1, 12, 6 );
		const large = big();
		const before = [ box, sphere, large ].map( snapshot );
		const counts = box.attributes.position.count;

		const spill = await GeometrySpill.create( storage, 'spill:geo' );
		for ( const g of [ box, sphere, large ] ) spill.add( g );

		expect( box.attributes.position.array.length ).toBe( 0 );
		expect( box.index.array.length ).toBe( 0 );
		expect( large.attributes.position.array.length ).toBe( 0 );
		expect( box.attributes.position.count ).toBe( counts );

		await spill.written();
		expect( spill.queuedBytes ).toBe( 0 );
		await spill.restore();

		expect( [ box, sphere, large ].map( snapshot ) ).toEqual( before );
		expect( box.attributes.position.array ).toBeInstanceOf( Float32Array );
		expect( box.index.array.constructor ).toBe( before[ 0 ].index.constructor );

		await spill.dispose();
		expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 );

	}, 60000 );

	it( 'restores two attributes sharing one array as one array', async () => {

		const g = new BufferGeometry();
		const shared = Float32Array.from( { length: 30 }, ( _, i ) => i );
		g.setAttribute( 'position', new BufferAttribute( shared, 3 ) );
		g.setAttribute( 'normal', new BufferAttribute( shared, 3 ) );

		const spill = await GeometrySpill.create( storage, 'spill:shared' );
		spill.add( g );
		await spill.restore();

		expect( g.attributes.position.array ).toBe( g.attributes.normal.array );
		expect( Array.from( g.attributes.position.array ) ).toEqual( Array.from( shared ) );
		await spill.dispose();

	} );

	it( 'drops bounds computed while the arrays were empty, and keeps ones computed before', async () => {

		const fresh = new BoxGeometry();
		const bounded = new BoxGeometry( 2, 2, 2 );
		bounded.computeBoundingBox();

		const spill = await GeometrySpill.create( storage, 'spill:bounds' );
		spill.add( fresh );
		spill.add( bounded );
		fresh.computeBoundingBox();
		await spill.restore();

		expect( fresh.boundingBox ).toBeNull();
		expect( bounded.boundingBox.max.x ).toBe( 1 );
		await spill.dispose();

	} );

	it( 'keeps an array in memory when its write fails', async () => {

		const g = new SphereGeometry( 1, 8, 4 );
		const before = snapshot( g );
		const spill = await GeometrySpill.create( storage, 'spill:fail' );
		spill._store.writeAt = async () => {

			throw new Error( 'quota' );

		};

		spill.add( g );
		await spill.written();
		expect( spill.error?.message ).toBe( 'quota' );
		await spill.restore();

		expect( snapshot( g ) ).toEqual( before );
		await spill.dispose();

	} );

	it( 'takes only geometry made of plain attributes', () => {

		const morphed = new BoxGeometry();
		morphed.morphAttributes.position = [ morphed.attributes.position.clone() ];

		expect( GeometrySpill.canTake( new BoxGeometry() ) ).toBe( true );
		expect( GeometrySpill.canTake( morphed ) ).toBe( false );

	} );

} );
