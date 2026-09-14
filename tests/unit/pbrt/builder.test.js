import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { loadPBRTScene, pickEntryPath } from '@/core/Processor/PBRT/index.js';

const enc = new TextEncoder();

const SCENE = `
	LookAt 0 0 5   0 0 0   0 1 0
	Camera "perspective" "float fov" 40
	Film "rgb" "integer xresolution" 800 "integer yresolution" 600
	WorldBegin
	LightSource "infinite" "rgb L" [ 0.4 0.5 0.6 ]
	AttributeBegin
		AreaLightSource "diffuse" "rgb L" [ 8 8 8 ]
		Material "diffuse" "rgb reflectance" [ 0.2 0.3 0.4 ]
		Shape "trianglemesh" "point3 P" [ -1 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
	AttributeEnd
	Material "diffuse" "rgb reflectance" [ 0.8 0.8 0.8 ]
	Translate 0 -1 0
	Shape "sphere" "float radius" 0.5
`;

function buildArgs( extra = {} ) {

	return {
		vfs: { 'scene.pbrt': enc.encode( SCENE ) },
		plyParser: () => null,
		imageFromBytes: async () => null,
		...extra
	};

}

describe( 'PBRT scene builder', () => {

	it( 'auto-detects the entry .pbrt', () => {

		expect( pickEntryPath( { 'a/deep/foo.pbrt': 1, 'scene.pbrt': 1 } ) ).toBe( 'scene.pbrt' );

	} );

	it( 'picks the scene over its shorter-named Include fragments', () => {

		const entries = {
			'contemporary-bathroom.pbrt': enc.encode( 'WorldBegin\nInclude "materials.pbrt"\nInclude "geometry.pbrt"\n' ),
			'geometry.pbrt': enc.encode( 'AttributeBegin\n NamedMaterial "wood"\nAttributeEnd\n' ),
			'materials.pbrt': enc.encode( 'MakeNamedMaterial "wood" "string type" [ "diffuse" ]\n' )
		};

		expect( pickEntryPath( entries ) ).toBe( 'contemporary-bathroom.pbrt' );

	} );

	it( 'builds meshes, a camera, and an environment', async () => {

		const { group, camera, environment, warnings } = await loadPBRTScene( buildArgs() );

		const meshes = group.children.filter( c => c instanceof Mesh );
		const cameras = group.children.filter( c => c instanceof PerspectiveCamera );

		expect( meshes ).toHaveLength( 2 );
		expect( cameras ).toHaveLength( 1 );
		expect( camera ).toBe( cameras[ 0 ] );
		expect( environment.texture ).toBeTruthy();
		// constant infinite light radiance baked into the float texture (float32)
		const px = environment.texture.image.data;
		expect( px[ 0 ] ).toBeCloseTo( 0.4, 5 );
		expect( px[ 1 ] ).toBeCloseTo( 0.5, 5 );
		expect( px[ 2 ] ).toBeCloseTo( 0.6, 5 );
		expect( warnings ).toEqual( [] );

	} );

	// pbrt's camera space is left-handed, so a bare LookAt already means a left-right
	// flip against three's lookAt(); `Scale -1 1 1` cancels that rather than adding one.
	// Both expectations are anchored on the published reference renders.
	it( 'mirrors a plain LookAt camera to match pbrt (killeroo-simple)', async () => {

		const { camera } = await loadPBRTScene( buildArgs() );
		expect( camera.scale.x ).toBe( - 1 );
		expect( camera.matrixWorld.determinant() ).toBeLessThan( 0 );

	} );

	it( 'leaves a "Scale -1 1 1" camera alone (contemporary-bathroom)', async () => {

		const scaled = `Scale -1 1 1\n${SCENE}`;
		const { camera } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scaled ) } } ) );

		expect( camera.scale.x ).toBe( 1 );
		expect( camera.matrixWorld.determinant() ).toBeGreaterThan( 0 );

		// Same eye and same view direction either way — only the left/right sense differs.
		const plain = ( await loadPBRTScene( buildArgs() ) ).camera;
		expect( camera.position.distanceTo( plain.position ) ).toBeLessThan( 1e-6 );

		const forward = m => new Vector3( 0, 0, - 1 ).applyMatrix4( m ).sub( new Vector3().setFromMatrixPosition( m ) );
		expect( forward( camera.matrixWorld ).angleTo( forward( plain.matrixWorld ) ) ).toBeLessThan( 1e-6 );

	} );

	it( 'maps area-light L onto an emissive material', async () => {

		const { group } = await loadPBRTScene( buildArgs() );
		const triMesh = group.children.find( c => c instanceof Mesh && c.geometry.getAttribute( 'position' ).count === 3 );

		expect( triMesh.material.emissive.r ).toBeCloseTo( 8, 5 );
		expect( triMesh.material.emissiveIntensity ).toBe( 1 );

	} );

	it( 'resolves a `scale` texture (tint × inner) and a `mix` material', async () => {

		const enc2 = new TextEncoder();
		const scene = `
			Camera "perspective" "float fov" 30
			Film "rgb" "integer xresolution" 800 "integer yresolution" 600
			WorldBegin
			Texture "base" "spectrum" "imagemap" "string filename" "wood.png"
			Texture "tinted" "spectrum" "scale" "texture tex" "base" "rgb scale" [ 0.5 0.2 0.1 ]
			MakeNamedMaterial "Red" "string type" "diffuse" "rgb reflectance" [ 1 0 0 ]
			MakeNamedMaterial "Blue" "string type" "diffuse" "rgb reflectance" [ 0 0 1 ]
			MakeNamedMaterial "Glossy" "string type" "diffuse" "texture reflectance" "tinted"
			NamedMaterial "Glossy"
			Shape "sphere" "float radius" 1
			Material "mix" "string materials" [ "Red" "Blue" ] "float amount" 0.2
			Shape "sphere" "float radius" 1
			Material "mix" "string materials" [ "Red" "Blue" ] "float amount" 0.8
			Shape "sphere" "float radius" 1
		`;
		// Stub image: any non-null Texture so the texture path resolves
		const stubTex = { isTexture: true };
		const r = await loadPBRTScene( {
			vfs: { 'scene.pbrt': enc2.encode( scene ), 'wood.png': enc2.encode( 'x' ) },
			plyParser: () => null,
			imageFromBytes: async () => stubTex
		} );

		expect( r.warnings.filter( w => /not supported/.test( w ) ) ).toEqual( [] );
		const spheres = r.group.children.filter( c => c instanceof Mesh );
		expect( spheres ).toHaveLength( 3 );

		// 1) scale texture: map = inner texture, color = scale tint (0.5, 0.2, 0.1)
		expect( spheres[ 0 ].material.map ).toBe( stubTex );
		expect( spheres[ 0 ].material.color.r ).toBeCloseTo( 0.5, 5 );
		expect( spheres[ 0 ].material.color.g ).toBeCloseTo( 0.2, 5 );
		expect( spheres[ 0 ].material.color.b ).toBeCloseTo( 0.1, 5 );

		// 2) mix(amount=0.2): lerp(Red, Blue, 0.2) → (0.8, 0, 0.2)
		expect( spheres[ 1 ].material.color.r ).toBeCloseTo( 0.8, 5 );
		expect( spheres[ 1 ].material.color.b ).toBeCloseTo( 0.2, 5 );

		// 3) mix(amount=0.8): lerp(Red, Blue, 0.8) → (0.2, 0, 0.8)
		expect( spheres[ 2 ].material.color.r ).toBeCloseTo( 0.2, 5 );
		expect( spheres[ 2 ].material.color.b ).toBeCloseTo( 0.8, 5 );

	} );

	it( 'drops the map on a UV-less mesh without corrupting the shared textured material', async () => {

		// Two shapes share one NamedMaterial that carries a texture. One shape has
		// UVs, the other doesn't. The UV-less shape must NOT strip the map from the
		// shared cached material instance the UV'd shape relies on.
		const enc2 = new TextEncoder();
		const scene = `
			Camera "perspective" "float fov" 30
			Film "rgb" "integer xresolution" 64 "integer yresolution" 64
			WorldBegin
			Texture "wood" "spectrum" "imagemap" "string filename" "wood.png"
			MakeNamedMaterial "Wood" "string type" "diffuse" "texture reflectance" "wood"
			NamedMaterial "Wood"
			Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "point2 uv" [ 0 0 1 0 0 1 ] "integer indices" [ 0 1 2 ]
			Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [ 0 1 2 ]
		`;
		const stubTex = { isTexture: true, clone() {

			return { ...this };

		} };
		const r = await loadPBRTScene( {
			vfs: { 'scene.pbrt': enc2.encode( scene ), 'wood.png': enc2.encode( 'x' ) },
			plyParser: () => null,
			imageFromBytes: async () => stubTex
		} );

		const meshes = r.group.children.filter( c => c instanceof Mesh );
		expect( meshes ).toHaveLength( 2 );
		const withUV = meshes.find( m => m.geometry.getAttribute( 'uv' ) );
		const noUV = meshes.find( m => ! m.geometry.getAttribute( 'uv' ) );

		// The UV'd mesh keeps its texture; the UV-less one drops it on a clone.
		expect( withUV.material.map ).toBe( stubTex );
		expect( noUV.material.map ).toBe( null );
		// Distinct instances — the shared material was not mutated.
		expect( noUV.material ).not.toBe( withUV.material );

	} );

	it( 'maps diffuse reflectance onto base color', async () => {

		const { group } = await loadPBRTScene( buildArgs() );
		const sphere = group.children.find( c => c instanceof Mesh && c.geometry.type === 'SphereGeometry' );

		expect( sphere.material.color.r ).toBeCloseTo( 0.8, 5 );
		expect( sphere.material.roughness ).toBe( 1 );
		expect( sphere.material.metalness ).toBe( 0 );

	} );

	it( 'defaults to no handedness flip (camera in pbrt coords)', async () => {

		// Default: convertHandedness false → camera eye z=5 stays at 5.
		const defaulted = await loadPBRTScene( buildArgs() );
		expect( defaulted.camera.position.z ).toBeCloseTo( 5, 4 );

		// Opt-in flip: eye z=5 → -5 after the mirror.
		const flipped = await loadPBRTScene( buildArgs( { convertHandedness: true } ) );
		expect( flipped.camera.position.z ).toBeCloseTo( - 5, 4 );

	} );

	it( 'records the sphere translate in its baked matrix', async () => {

		const { group } = await loadPBRTScene( buildArgs() );
		const sphere = group.children.find( c => c instanceof Mesh && c.geometry.type === 'SphereGeometry' );
		const t = sphere.matrix.elements.slice( 12, 15 );
		expect( t[ 0 ] ).toBeCloseTo( 0, 5 );
		expect( t[ 1 ] ).toBeCloseTo( - 1, 5 );
		expect( t[ 2 ] ).toBeCloseTo( 0, 5 );

	} );


	it( 'recovers a colour for an unreadable ptex texture from the like-named material', async () => {

		// The Moana conversion binds colour through ptex and leaves the matching
		// MakeNamedMaterial behind; the .ptx files ship separately, so without this the
		// whole scene renders the default grey.
		const scene = `
			WorldBegin
			MakeNamedMaterial "el:bark" "rgb reflectance" [ 0.24 0.2 0.17 ] "string type" [ "diffuse" ]
			MakeNamedMaterial "el:leaf" "rgb reflectance" [ 0.3 0.38 0.16 ] "string type" [ "diffuse" ]
			AttributeBegin
				Texture "el:bark_Color" "spectrum" "ptex" "string filename" [ "../textures/bark.ptx" ]
				Material "diffuse" "texture reflectance" "el:bark_Color"
				Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
			AttributeEnd
			AttributeBegin
				Texture "el:leaf0001_Color-renamed-3" "spectrum" "ptex" "string filename" [ "../textures/leaf.ptx" ]
				Material "diffuse" "texture reflectance" "el:leaf0001_Color-renamed-3"
				Shape "trianglemesh" "point3 P" [ 0 0 1  1 0 1  0 1 1 ] "integer indices" [ 0 1 2 ]
			AttributeEnd
		`;

		const { group, warnings } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) } } ) );
		const meshes = group.children.filter( c => c instanceof Mesh );

		expect( meshes[ 0 ].material.color.r ).toBeCloseTo( 0.24, 5 );
		expect( meshes[ 0 ].material.color.g ).toBeCloseTo( 0.2, 5 );
		expect( meshes[ 1 ].material.color.r ).toBeCloseTo( 0.3, 5 );
		expect( meshes[ 1 ].material.color.b ).toBeCloseTo( 0.16, 5 );

		// One summary line, not one warning per texture.
		expect( warnings.filter( w => /not supported/.test( w ) ) ).toEqual( [] );
		expect( warnings.some( w => /fell back to the like-named material/.test( w ) ) ).toBe( true );

	} );

	it( 'still warns when an unsupported texture has no material to fall back on', async () => {

		const scene = `
			WorldBegin
			AttributeBegin
				Texture "orphan_Color" "spectrum" "ptex" "string filename" [ "x.ptx" ]
				Material "diffuse" "texture reflectance" "orphan_Color"
				Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
			AttributeEnd
		`;

		const { warnings } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) } } ) );
		expect( warnings.some( w => /texture class "ptex" not supported/.test( w ) ) ).toBe( true );

	} );

	it( 'parses a scene handed over as bytes, never as one string', async () => {

		// Ironwood scene files run to 800 MB — past the longest string V8 will build — so the
		// loader must hand the lexer bytes and never decode the file whole.
		const body = Array.from( { length: 4000 }, ( _, i ) =>
			`Shape "trianglemesh" "point3 P" [ ${i} 0 0  ${i + 1} 0 0  ${i} 1 0 ] "integer indices" [ 0 1 2 ]`
		).join( '\n' );
		const bytes = enc.encode( `WorldBegin\nMaterial "diffuse" "rgb reflectance" [ 1 1 1 ]\n${body}\n` );

		const { group } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': bytes } } ) );
		expect( group.children.filter( c => c instanceof Mesh ) ).toHaveLength( 4000 );

	} );


	it( 'shares one geometry across every placement of an instanced object', async () => {

		// Moana places a single 208-triangle leaf 2.25 million times; rebuilding it per
		// placement is the difference between seconds and minutes, and between MB and GB.
		const scene = `
			WorldBegin
			AttributeBegin
				ObjectBegin "leaf"
					Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]
				ObjectEnd
			AttributeEnd
			AttributeBegin Translate 1 0 0  ObjectInstance "leaf" AttributeEnd
			AttributeBegin Translate 2 0 0  ObjectInstance "leaf" AttributeEnd
			AttributeBegin Translate 3 0 0  ObjectInstance "leaf" AttributeEnd
		`;

		const { group } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) } } ) );
		const meshes = group.children.filter( c => c instanceof Mesh );

		expect( meshes ).toHaveLength( 3 );
		expect( meshes[ 1 ].geometry ).toBe( meshes[ 0 ].geometry );
		expect( meshes[ 2 ].geometry ).toBe( meshes[ 0 ].geometry );
		// Placement still differs — only the geometry is shared.
		expect( meshes.map( m => m.position.x ) ).toEqual( [ 1, 2, 3 ] );

	} );

	it( 'decodes a .ply once when two shapes name it', async () => {

		let decodes = 0;
		const scene = `
			WorldBegin
			Shape "plymesh" "string filename" "m.ply"
			Shape "plymesh" "string filename" "m.ply"
		`;

		const { group } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode( scene ), 'm.ply': enc.encode( 'ply' ) },
			plyParser: () => {

				decodes ++;
				const g = new BufferGeometry();
				g.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ) );
				return g;

			}
		} ) );

		expect( decodes ).toBe( 1 );
		expect( group.children.filter( c => c instanceof Mesh ) ).toHaveLength( 2 );

	} );


	it( 'stops expanding instances at the triangle budget and says how many it dropped', async () => {

		const scene = `
			WorldBegin
			AttributeBegin
				ObjectBegin "quad"
					Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0  1 1 0 ] "integer indices" [ 0 1 2  1 3 2 ]
				ObjectEnd
			AttributeEnd
			${Array.from( { length: 20 }, ( _, i ) => `AttributeBegin Translate ${i} 0 0 ObjectInstance "quad" AttributeEnd` ).join( '\n' )}
		`;

		const { group, warnings } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode( scene ) },
			maxTriangles: 10
		} ) );

		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes.length ).toBeGreaterThan( 0 );
		expect( meshes.length ).toBeLessThan( 20 );
		expect( warnings.some( w => /placement\(s\) skipped/.test( w ) ) ).toBe( true );

	} );


	it( 'gives a trianglemesh a real index attribute, not a bare typed array', async () => {

		// setIndex() only wraps a plain Array. Handing it the parser's Int32Array put a raw
		// buffer on geometry.index, where .count reads undefined and every triangle count
		// downstream became NaN — with nothing thrown.
		const scene = `
			WorldBegin
			Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0  1 1 0 ] "integer indices" [ 0 1 2  1 3 2 ]
		`;

		const { group, triangleCount } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) } } ) );
		const geometry = group.children.find( c => c instanceof Mesh ).geometry;

		expect( geometry.index.isBufferAttribute ).toBe( true );
		expect( geometry.index.count ).toBe( 6 );
		expect( triangleCount ).toBe( 2 );

	} );

} );
