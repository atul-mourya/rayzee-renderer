
import { SphereGeometry, Mesh, MeshPhysicalMaterial, Group, Object3D } from 'three';

/**
 Metalness (increases left to right):
   0.00  0.25  0.50  0.75  1.00
   +-----------------------------> X
 1 |  o     o     o     o     o
   |
0.75  o     o     o     o     o
   |
0.50  o     o     o     o     o
   |
0.25  o     o     o     o     o
   |
 0 |  o     o     o     o     o
   v
   Y

Roughness (decreases bottom to top)

Legend:
o : Sphere
X : Metalness axis
Y : Roughness axis

Example sphere properties:
Top-left     : Metalness 0.00, Roughness 1.00 (Matte)
Top-right    : Metalness 1.00, Roughness 1.00 (Rough Metal)
Bottom-left  : Metalness 0.00, Roughness 0.00 (Glossy Dielectric)
Bottom-right : Metalness 1.00, Roughness 0.00 (Polished Metal)
Center       : Metalness 0.50, Roughness 0.50 (Semi-glossy, Semi-metallic)
 */

export function generateMaterialSpheres( rows = 5, columns = 5, spacing = 1.2 ) {

	const sphereGroup = new Group();
	const sphereGeometry = new SphereGeometry( 0.5, 32, 32 );

	for ( let i = 0; i < rows; i ++ ) {

		for ( let j = 0; j < columns; j ++ ) {

			const material = new MeshPhysicalMaterial( {
				metalness: j / ( columns - 1 ),
				roughness: i / ( rows - 1 ),
				color: 0xFFD700
			} );

			const sphere = new Mesh( sphereGeometry, material );
			sphere.position.set(
				( j - ( columns - 1 ) / 2 ) * spacing,
				( i - ( rows - 1 ) / 2 ) * spacing,
				0
			);

			// Add a label to the sphere
			const label = new Object3D();
			label.name = `Metalness: ${material.metalness.toFixed( 2 )}, Roughness: ${material.roughness.toFixed( 2 )}`;
			sphere.add( label );

			sphereGroup.add( sphere );

		}

	}

	return sphereGroup;

}

