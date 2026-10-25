import { describe, it, expect } from 'vitest';
import { Mesh, BufferGeometry, Float32BufferAttribute } from 'three';
import { loadPBRTScene } from '@/core/addons/archives/pbrt/index.js';

const enc = new TextEncoder();

// Mirrors veach-ajar: plymeshes placed by per-shape Transform inside AttributeBegin.
const SCENE = `
	Camera "perspective" "float fov" 36
	Film "rgb" "integer xresolution" 1280 "integer yresolution" 720
	WorldBegin
	NamedMaterial "x"
	Shape "plymesh" "string filename" "untransformed.ply"
	AttributeBegin
		Transform [ 1.8 0 0 0  0 1 0 0  0 0 1 0  2.3 0 0 1 ]
		Shape "plymesh" "string filename" "floor.ply"
	AttributeEnd
	AttributeBegin
		Transform [ -0.0757886 0 0.0468591 0  0 0.0891049 0 0  -0.0468591 0 -0.0757886 0  -1.95645 0.648205 -1.77687 1 ]
		Shape "plymesh" "string filename" "pot.ply"
	AttributeEnd
`;

// Stub PLY: a 2-unit triangle so we can read scale off the baked matrix.
function stubGeometry() {

	const g = new BufferGeometry();
	g.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ) );
	g.setIndex( [ 0, 1, 2 ] );
	return g;

}

function args( extra = {} ) {

	return {
		vfs: {
			'scene.pbrt': enc.encode( SCENE ),
			'untransformed.ply': enc.encode( 'x' ),
			'floor.ply': enc.encode( 'x' ),
			'pot.ply': enc.encode( 'x' )
		},
		plyParser: () => stubGeometry(),
		imageFromBytes: async () => null,
		convertHandedness: false, // isolate the transform from the z-flip
		...extra
	};

}

// Column-major scale extraction: length of each basis column.
function columnScales( m ) {

	const e = m.elements;
	return [
		Math.hypot( e[ 0 ], e[ 1 ], e[ 2 ] ),
		Math.hypot( e[ 4 ], e[ 5 ], e[ 6 ] ),
		Math.hypot( e[ 8 ], e[ 9 ], e[ 10 ] )
	];

}

describe( 'PBRT per-shape Transform', () => {

	it( 'applies per-shape Transform scale + translation to the baked mesh matrix', async () => {

		const { group } = await loadPBRTScene( args() );
		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes ).toHaveLength( 3 );

		const [ untransformed, floor, pot ] = meshes;

		// Untransformed: identity matrix
		expect( columnScales( untransformed.matrix ) ).toEqual( [ 1, 1, 1 ] );

		// Floor: scaled x1.8 in X, translated +2.3 in X
		const floorScale = columnScales( floor.matrix );
		expect( floorScale[ 0 ] ).toBeCloseTo( 1.8, 4 );
		expect( floorScale[ 1 ] ).toBeCloseTo( 1.0, 4 );
		expect( floor.matrix.elements[ 12 ] ).toBeCloseTo( 2.3, 4 );

		// Pot: uniform ~0.0891 scale (this is what makes pots small; if the
		// transform is dropped, the pot renders at full PLY size = "big mesh")
		const potScale = columnScales( pot.matrix );
		expect( potScale[ 0 ] ).toBeCloseTo( 0.0891, 3 );
		expect( potScale[ 1 ] ).toBeCloseTo( 0.0891, 3 );
		expect( potScale[ 2 ] ).toBeCloseTo( 0.0891, 3 );
		expect( pot.matrix.elements[ 12 ] ).toBeCloseTo( - 1.95645, 4 );

	} );

	it( 'survives updateMatrix() (GeometryExtractor recomposes from TRS)', async () => {

		// GeometryExtractor calls mesh.updateMatrix() before baking geometry. The
		// transform must be stored in position/quaternion/scale, or it is lost here.
		const { group } = await loadPBRTScene( args() );
		const pot = group.children.filter( c => c instanceof Mesh )[ 2 ];

		pot.updateMatrix(); // simulate GeometryExtractor.js:501

		const scale = columnScales( pot.matrix );
		expect( scale[ 0 ] ).toBeCloseTo( 0.0891, 3 );
		expect( scale[ 1 ] ).toBeCloseTo( 0.0891, 3 );
		expect( scale[ 2 ] ).toBeCloseTo( 0.0891, 3 );
		expect( pot.matrix.elements[ 12 ] ).toBeCloseTo( - 1.95645, 4 );

	} );

} );
