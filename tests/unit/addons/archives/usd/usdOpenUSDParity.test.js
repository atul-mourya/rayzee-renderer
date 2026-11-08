import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector2, Vector3 } from 'three';
import { USDFiles, loadUSDScene } from '@/core/addons/archives/usd/index.js';

// Answers from OpenUSD 25.08 (Blender 5.1's pxr); each .usdc is usdcat's crate of its .usda.
// fixtures/xform.usda: every rotation order, a pivot stack with !invert!, orient + scale, a matrix and
// !resetXformStack!, a triangle of its own size under each. xform-openusd.json: each triangle's world corners
// (UsdGeomXformable::ComputeLocalToWorldTransform).
const fixture = name => readFileSync( new URL( `./fixtures/${name}`, import.meta.url ) );
const OPENUSD = JSON.parse( fixture( 'xform-openusd.json' ) );

// Every triangle's world corners, sorted. The triangles differ in size, so a transform applied to the wrong prim shows;
// merging or rewinding them moves no corner.
async function corners( name ) {

	const bytes = new Uint8Array( fixture( name ) );
	const files = new USDFiles( [ name ], async path => ( path === name ? bytes : null ) );
	const { group } = await loadUSDScene( { files, entryPath: name, resolveImage: async () => null, resolveEnvironment: async () => null } );
	group.updateMatrixWorld( true );
	const out = [];
	group.traverse( mesh => {

		if ( ! mesh.isMesh ) return;
		const position = mesh.geometry.getAttribute( 'position' );
		const placements = mesh.isInstancedMesh ? Array.from( { length: mesh.count }, ( _, i ) => {

			const m = new Matrix4();
			mesh.getMatrixAt( i, m );
			return m.premultiply( mesh.matrixWorld );

		} ) : [ mesh.matrixWorld ];
		for ( const m of placements ) for ( let i = 0; i < position.count; i ++ ) out.push( new Vector3().fromBufferAttribute( position, i ).applyMatrix4( m ).toArray() );

	} );
	return sorted( out );

}

const sorted = points => points.map( p => p.map( v => Math.round( v * 1e4 ) / 1e4 + 0 ) ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] || a[ 2 ] - b[ 2 ] );

describe( 'USD transforms against OpenUSD', () => {

	for ( const name of [ 'xform.usda', 'xform.usdc' ] ) {

		it( `places every triangle of ${name} where OpenUSD does`, async () => {

			expect( await corners( name ) ).toEqual( sorted( Object.values( OPENUSD ).flat() ) );

		} );

	}

	// fixtures/instancer.usda: a PointInstancer under a moved and turned parent, two prototypes (one with a transform of
	// its own and a child mesh), quaternions written real first, per-copy scales and an invisible id.
	// instancer-openusd.json: ComputeInstanceTransformsAtTime and ComputeMaskAtTime applied to each corner. The
	// quaternions are unit at half precision: OpenUSD does not normalise one, the reader does.
	for ( const name of [ 'instancer.usda', 'instancer.usdc' ] ) {

		it( `places every point-instancer copy of ${name} where OpenUSD does`, async () => {

			expect( await corners( name ) ).toEqual( sorted( JSON.parse( fixture( 'instancer-openusd.json' ) ) ) );

		} );

	}

} );

// fixtures/primvars.usda: normals and st as faceVarying (st indexed), uniform with vertex st (indexed), constant, a
// faceVarying `normals` attribute beside a uniform st, and an st with no interpolation (constant). primvars-openusd.json:
// each triangle corner's position, normal and st (UsdGeomPrimvar::ComputeFlattened by interpolation, fan order).
describe( 'USD primvars against OpenUSD', () => {

	const OPENUSD_CORNERS = JSON.parse( fixture( 'primvars-openusd.json' ) );
	const round = values => values.map( v => Math.round( v * 1e4 ) / 1e4 + 0 );
	const order = ( a, b ) => {

		for ( let i = 0; i < a.length; i ++ ) if ( a[ i ] !== b[ i ] ) return a[ i ] - b[ i ];
		return 0;

	};

	for ( const name of [ 'primvars.usda', 'primvars.usdc' ] ) {

		it( `gives every corner of ${name} OpenUSD's normal and st`, async () => {

			const bytes = new Uint8Array( fixture( name ) );
			const files = new USDFiles( [ name ], async path => ( path === name ? bytes : null ) );
			const { group } = await loadUSDScene( { files, entryPath: name, resolveImage: async () => null, resolveEnvironment: async () => null } );
			group.updateMatrixWorld( true );
			const corners = [];
			group.traverse( mesh => {

				if ( ! mesh.isMesh ) return;
				const { position, normal, uv } = mesh.geometry.attributes;
				const index = mesh.geometry.index;
				for ( let i = 0; i < index.count; i ++ ) {

					const v = index.getX( i );
					const p = new Vector3().fromBufferAttribute( position, v ).applyMatrix4( mesh.matrixWorld );
					corners.push( round( [ ...p.toArray(), ...new Vector3().fromBufferAttribute( normal, v ).toArray(), ...new Vector2().fromBufferAttribute( uv, v ).toArray() ] ) );

				}

			} );
			expect( corners.sort( order ) ).toEqual( OPENUSD_CORNERS.map( round ).sort( order ) );

		} );

	}

} );

// fixtures/gprims.usda: Cylinder, Cone, Capsule and Plane on each axis, a Cube and a Sphere, each moved apart along x.
// gprims-openusd.json: each prim's world box (UsdGeomBBoxCache::ComputeWorldBound).
describe( 'USD implicit shapes against OpenUSD', () => {

	for ( const name of [ 'gprims.usda', 'gprims.usdc' ] ) {

		it( `sizes and turns every shape of ${name} as OpenUSD bounds it`, async () => {

			const bytes = new Uint8Array( fixture( name ) );
			const files = new USDFiles( [ name ], async path => ( path === name ? bytes : null ) );
			const { group } = await loadUSDScene( { files, entryPath: name, resolveImage: async () => null, resolveEnvironment: async () => null } );
			group.updateMatrixWorld( true );
			const boxes = [];
			group.traverse( mesh => {

				if ( ! mesh.isMesh ) return;
				mesh.geometry.computeBoundingBox();
				const box = mesh.geometry.boundingBox.clone().applyMatrix4( mesh.matrixWorld );
				boxes.push( [ box.min.toArray(), box.max.toArray() ].map( p => p.map( v => Math.round( v * 1e4 ) / 1e4 + 0 ) ) );

			} );
			const byX = ( a, b ) => a[ 0 ][ 0 ] - b[ 0 ][ 0 ];
			expect( boxes.sort( byX ) ).toEqual( Object.values( JSON.parse( fixture( 'gprims-openusd.json' ) ) ).sort( byX ) );

		} );

	}

} );

// fixtures/bindings.usda: a binding inherited, one overridden below, a full-purpose one above an all-purpose one, one
// strongerThanDescendants, a preview one beside an all-purpose one, and point-instancer prototypes bound by their own
// parents (one under the instancer, one outside two instancers, also drawn where it stands); each at its own x.
// bindings-openusd.json: UsdShadeMaterialBindingAPI::ComputeBoundMaterial for the full purpose.
describe( 'USD material bindings against OpenUSD', () => {

	const COLOURS = { Red: [ 1, 0, 0 ], Green: [ 0, 1, 0 ], Blue: [ 0, 0, 1 ] };
	const PLACE = {
		0: '/Inherit/Tri', 2: '/Own/Tri', 4: '/FullAbove/Tri', 6: '/Stronger/Tri', 8: '/Preview/Tri',
		10: '/PI1/Prototypes/P/Tri', 12: '/Outside/P/Tri', 14: '/Outside/P/Tri', 20: '/Outside/P/Tri',
	};

	for ( const name of [ 'bindings.usda', 'bindings.usdc' ] ) {

		it( `binds every mesh of ${name} to OpenUSD's material`, async () => {

			const bytes = new Uint8Array( fixture( name ) );
			const files = new USDFiles( [ name ], async path => ( path === name ? bytes : null ) );
			const { group } = await loadUSDScene( { files, entryPath: name, resolveImage: async () => null, resolveEnvironment: async () => null } );
			group.updateMatrixWorld( true );
			const byX = {};
			group.traverse( mesh => {

				if ( ! mesh.isMesh ) return;
				const placements = mesh.isInstancedMesh ? Array.from( { length: mesh.count }, ( _, i ) => {

					const m = new Matrix4();
					mesh.getMatrixAt( i, m );
					return m.premultiply( mesh.matrixWorld );

				} ) : [ mesh.matrixWorld ];
				for ( const m of placements ) {

					const corner = new Vector3().fromBufferAttribute( mesh.geometry.getAttribute( 'position' ), 0 ).applyMatrix4( m );
					byX[ Math.floor( corner.x / 2 ) * 2 ] = mesh.material.color.toArray().map( v => Math.round( v * 100 ) / 100 );

				}

			} );
			const openusd = JSON.parse( fixture( 'bindings-openusd.json' ) );
			const want = Object.fromEntries( Object.entries( PLACE ).map( ( [ x, path ] ) => [ x, COLOURS[ openusd[ path ] ] ] ) );
			expect( byX ).toEqual( want );

		} );

	}

} );
