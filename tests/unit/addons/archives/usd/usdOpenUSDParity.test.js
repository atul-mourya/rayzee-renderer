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

// fixtures/gprims1.usda: Cylinder_1 tapered on each axis and bare, Capsule_1 bare, tapered on each axis, wider at the top,
// and steeper than 45°. gprims1-openusd.json: the cylinders' and the bare capsule's world boxes (ComputeWorldBound), and
// each tapered capsule's rings (axial, radial) as OpenUSD's GeomUtil builds it (Blender 5.1's import): its box is only
// conservative.
describe( 'USD _1 shapes against OpenUSD', () => {

	const OPENUSD1 = JSON.parse( fixture( 'gprims1-openusd.json' ) );
	const AXIS = { Capsule1X: 0, Capsule1Y: 1, Capsule1Z: 2, Capsule1Up: 2, Capsule1Steep: 1 };
	// Each prim stands at its own x (the fixture's translate); a mesh is named by the prim nearest its middle.
	const X = { Cylinder1X: 10, Cylinder1Y: 20, Cylinder1Z: 30, Cylinder1Bare: 40, Capsule1Bare: 50, Capsule1X: 60, Capsule1Y: 70, Capsule1Z: 80, Capsule1Up: 90, Capsule1Steep: 100 };

	async function shapes( name ) {

		const bytes = new Uint8Array( fixture( name ) );
		const files = new USDFiles( [ name ], async path => ( path === name ? bytes : null ) );
		const { group } = await loadUSDScene( { files, entryPath: name, resolveImage: async () => null, resolveEnvironment: async () => null } );
		group.updateMatrixWorld( true );
		const out = {};
		group.traverse( mesh => {

			if ( ! mesh.isMesh ) return;
			mesh.geometry.computeBoundingBox();
			const x = mesh.geometry.boundingBox.clone().applyMatrix4( mesh.matrixWorld ).getCenter( new Vector3() ).x;
			out[ Object.keys( X ).find( prim => Math.abs( X[ prim ] - x ) < 5 ) ] = mesh;

		} );
		expect( Object.keys( out ).sort() ).toEqual( Object.keys( X ).sort() );
		return out;

	}

	for ( const name of [ 'gprims1.usda', 'gprims1.usdc' ] ) {

		it( `bounds every cylinder and the bare capsule of ${name} as OpenUSD does`, async () => {

			const meshes = await shapes( name );
			for ( const [ prim, expected ] of Object.entries( OPENUSD1.bounds ) ) {

				const box = meshes[ prim ].geometry.boundingBox.clone().applyMatrix4( meshes[ prim ].matrixWorld );
				expect( [ box.min.toArray(), box.max.toArray() ].map( p => p.map( v => Math.round( v * 1e4 ) / 1e4 + 0 ) ), prim ).toEqual( expected );

			}

			// A box cannot tell the ends apart: radiusTop is the +axis end's.
			for ( const [ prim, a ] of [[ 'Cylinder1X', 0 ], [ 'Cylinder1Y', 1 ], [ 'Cylinder1Z', 2 ]] ) {

				const position = meshes[ prim ].geometry.getAttribute( 'position' );
				const top = [];
				for ( let i = 0; i < position.count; i ++ ) {

					const p = new Vector3().fromBufferAttribute( position, i ).applyMatrix4( meshes[ prim ].matrixWorld ).toArray();
					p[ 0 ] -= X[ prim ];
					if ( p[ a ] > 0.999 ) top.push( Math.hypot( ...p.filter( ( _, j ) => j !== a ) ) );

				}

				expect( Math.max( ...top ), prim ).toBeCloseTo( 0.25, 6 );

			}

		} );

		it( `puts the tapered capsules of ${name} through OpenUSD's rings, poles exact`, async () => {

			const meshes = await shapes( name );
			for ( const [ prim, rings ] of Object.entries( OPENUSD1.rings ) ) {

				// The mesh's own profile: its rings' (axial, radial) about the prim's origin, by axial.
				const mesh = meshes[ prim ], a = AXIS[ prim ];
				const origin = [ X[ prim ], 0, 0 ];
				const position = mesh.geometry.getAttribute( 'position' );
				const byAxial = new Map();
				for ( let i = 0; i < position.count; i ++ ) {

					const p = new Vector3().fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld ).toArray().map( ( v, j ) => v - origin[ j ] );
					const axial = Math.round( p[ a ] * 1e6 ) / 1e6, radial = Math.hypot( ...p.filter( ( _, j ) => j !== a ) );
					byAxial.set( axial, Math.max( byAxial.get( axial ) ?? 0, radial ) );

				}

				const profile = [ ...byAxial ].sort( ( x, y ) => x[ 0 ] - y[ 0 ] );
				expect( [ profile[ 0 ][ 0 ], profile.at( - 1 )[ 0 ] ], prim ).toEqual( [ rings[ 0 ][ 0 ], rings.at( - 1 )[ 0 ] ].map( v => expect.closeTo( v, 4 ) ) );
				const radius = Math.max( ...rings.map( r => r[ 1 ] ) );
				// Each ring's distance from the profile's polyline: within its chords' sag.
				const toSegment = ( [ z, r ], [ z0, r0 ], [ z1, r1 ] ) => {

					const dz = z1 - z0, dr = r1 - r0, t = Math.min( Math.max( ( ( z - z0 ) * dz + ( r - r0 ) * dr ) / ( dz * dz + dr * dr ), 0 ), 1 );
					return Math.hypot( z - z0 - t * dz, r - r0 - t * dr );

				};

				for ( const ring of rings ) {

					const distance = Math.min( ...profile.slice( 1 ).map( ( end, i ) => toSegment( ring, profile[ i ], end ) ) );
					expect( distance, `${prim} at ${ring}` ).toBeLessThan( 2e-3 * radius );

				}

			}

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
