import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, PerspectiveCamera, Vector3 } from 'three';
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

		const { group, triangleCount } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': bytes } } ) );
		// 4000 small shapes merge into one mesh; what has to survive is every triangle.
		expect( triangleCount ).toBe( 4000 );
		const merged = group.children.filter( c => c instanceof Mesh );
		expect( merged ).toHaveLength( 1 );
		expect( merged[ 0 ].geometry.index.count / 3 ).toBe( 4000 );

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

		const { group, triangleCount } = await loadPBRTScene( buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) } } ) );
		const batches = group.children.filter( c => c.isInstancedMesh );

		// One object carrying three transforms, not three objects.
		expect( batches ).toHaveLength( 1 );
		expect( group.children.filter( c => c instanceof Mesh && ! c.isInstancedMesh ) ).toHaveLength( 0 );
		expect( batches[ 0 ].count ).toBe( 3 );
		// Storage counts the geometry once however many placements use it.
		expect( triangleCount ).toBe( 1 );

		const m = new Matrix4();
		const placed = [ 0, 1, 2 ].map( i => {

			batches[ 0 ].getMatrixAt( i, m );
			return m.elements[ 12 ];

		} );
		expect( placed ).toEqual( [ 1, 2, 3 ] );

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


	it( 'stops expanding instances at the placement budget and says how many it dropped', async () => {

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
			maxPlacements: 5
		} ) );

		const batches = group.children.filter( c => c.isInstancedMesh );
		const placed = batches.reduce( ( n, b ) => n + b.count, 0 );
		expect( placed ).toBeGreaterThan( 0 );
		expect( placed ).toBeLessThan( 20 );
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


	it( 'charges storage once for a shared geometry, and placements separately', async () => {

		// The two budgets measure different things: a million placements of one leaf cost a
		// million TLAS leaves but only one leaf's worth of triangles.
		const scene = `
			WorldBegin
			AttributeBegin
				ObjectBegin "leaf"
					Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0  1 1 0 ] "integer indices" [ 0 1 2  1 3 2 ]
				ObjectEnd
			AttributeEnd
			${Array.from( { length: 50 }, ( _, i ) => `AttributeBegin Translate ${i} 0 0 ObjectInstance "leaf" AttributeEnd` ).join( '\n' )}
		`;

		const { triangleCount, placementCount, skippedForBudget } = await loadPBRTScene(
			buildArgs( { vfs: { 'scene.pbrt': enc.encode( scene ) }, maxTriangles: 10 } )
		);

		expect( triangleCount ).toBe( 2 ); // the quad, stored once
		expect( placementCount ).toBe( 50 ); // well under the triangle budget of 10
		expect( skippedForBudget ).toBe( 0 );

	} );

	it( 'merges small non-instanced shapes into one mesh, in world space', async () => {

		const body = Array.from( { length: 300 }, ( _, i ) =>
			`AttributeBegin Translate ${i} 0 0 Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] AttributeEnd`
		).join( '\n' );

		const { group, triangleCount, mergedShapes } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode( `WorldBegin\nMaterial "diffuse" "rgb reflectance" [ 1 1 1 ]\n${body}\n` ) }
		} ) );

		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes ).toHaveLength( 1 );
		expect( mergedShapes ).toBe( 300 );
		expect( triangleCount ).toBe( 300 );

		const mesh = meshes[ 0 ];
		expect( mesh.position.x ).toBe( 0 ); // the transform lives in the vertices now
		const position = mesh.geometry.getAttribute( 'position' );
		expect( position.count ).toBe( 900 );
		expect( position.getX( 299 * 3 ) ).toBeCloseTo( 299, 4 );
		expect( position.getX( 299 * 3 + 1 ) ).toBeCloseTo( 300, 4 );

	} );

	it( 'bakes merged normals through the inverse transpose', async () => {

		const n = ( 1 / Math.SQRT2 ).toFixed( 6 );
		const body = Array.from( { length: 300 }, () =>
			'AttributeBegin Scale 2 1 1 Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 0 1 ] ' +
			`"normal N" [ ${n} ${n} 0  ${n} ${n} 0  ${n} ${n} 0 ] "integer indices" [ 0 1 2 ] AttributeEnd`
		).join( '\n' );

		const { group } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode( `WorldBegin\n${body}\n` ) }
		} ) );

		const normal = group.children.find( c => c instanceof Mesh ).geometry.getAttribute( 'normal' );
		// Scaling x by 2 tilts the normal AWAY from x: (0.447, 0.894, 0), not (0.894, 0.447, 0).
		expect( normal.getX( 0 ) ).toBeCloseTo( 0.4472, 3 );
		expect( normal.getY( 0 ) ).toBeCloseTo( 0.8944, 3 );

	} );

	it( 'keeps merged batches apart per material, and leaves big shapes standalone', async () => {

		const big = [];
		for ( let i = 0; i < 5000; i ++ ) big.push( i, 0, 0, i, 1, 0, i, 0, 1 );

		const body = Array.from( { length: 300 }, ( _, i ) =>
			`AttributeBegin Material "diffuse" "rgb reflectance" [ ${i % 2} 0 0 ] ` +
			'Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] AttributeEnd'
		).join( '\n' );

		const { group } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode(
				`WorldBegin\n${body}\nShape "trianglemesh" "point3 P" [ ${big.join( ' ' )} ]\n`
			) }
		} ) );

		const meshes = group.children.filter( c => c instanceof Mesh );
		expect( meshes.filter( m => m.name.startsWith( 'merged_' ) ) ).toHaveLength( 2 );
		const standalone = meshes.find( m => ! m.name.startsWith( 'merged_' ) );
		expect( standalone.geometry.getAttribute( 'position' ).count ).toBe( 15000 );

	} );

	it( 'leaves shapes alone below the merge threshold', async () => {

		const body = Array.from( { length: 300 }, ( _, i ) =>
			`AttributeBegin Translate ${i} 0 0 Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ] AttributeEnd`
		).join( '\n' );

		const { group, mergedShapes } = await loadPBRTScene( buildArgs( {
			vfs: { 'scene.pbrt': enc.encode( `WorldBegin\n${body}\n` ) },
			mergeShapesAbove: Infinity
		} ) );

		expect( group.children.filter( c => c instanceof Mesh ) ).toHaveLength( 300 );
		expect( mergedShapes ).toBe( 0 );

	} );


	it( 'empties the archive as it consumes it', async () => {

		// Nulling only the loader's own copy frees nothing while the caller still holds the
		// entries object — and that object is every byte of the scene.
		const vfs = {
			'scene.pbrt': enc.encode( 'WorldBegin\nInclude "geo.pbrt"\n' ),
			'geo.pbrt': enc.encode( 'Shape "plymesh" "string filename" "mesh.ply"\n' ),
			'mesh.ply': enc.encode( 'ply' )
		};

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], 3 ) );

		const { group } = await loadPBRTScene( { ...buildArgs(), vfs, plyParser: () => geometry } );

		expect( group.children.filter( c => c instanceof Mesh ) ).toHaveLength( 1 );
		expect( Object.keys( vfs ) ).toEqual( [] );

	} );


	it( 'never resolves an ambiguous basename to the wrong file', async () => {

		// Every Moana element ships its own objects.pbrt, and an element's own Include joined
		// against its directory makes a doubled path that matches no suffix. Guessing the first
		// entry handed each element the FIRST one's templates, so its placements vanished.
		const shape = 'Shape "trianglemesh" "point3 P" [ 0 0 0  1 0 0  0 1 0 ] "integer indices" [ 0 1 2 ]';
		const vfs = {
			'scene.pbrt': enc.encode( 'WorldBegin\nInclude "a/a.pbrt"\nInclude "b/b.pbrt"\n' ),
			'a/a.pbrt': enc.encode( 'Include "a/objects.pbrt"\nObjectInstance "shapeA"\n' ),
			'b/b.pbrt': enc.encode( 'Include "b/objects.pbrt"\nObjectInstance "shapeB"\n' ),
			'a/objects.pbrt': enc.encode( `ObjectBegin "shapeA"\n${shape}\nObjectEnd\n` ),
			'b/objects.pbrt': enc.encode( `ObjectBegin "shapeB"\n${shape}\nObjectEnd\n` )
		};

		const { placementCount, droppedNoTemplate } = await loadPBRTScene( buildArgs( { vfs } ) );

		expect( droppedNoTemplate ).toBe( 0 );
		expect( placementCount ).toBe( 2 );

	} );

	it( 'counts placements dropped for a missing template', async () => {

		const vfs = { 'scene.pbrt': enc.encode(
			'WorldBegin\nAttributeBegin ObjectInstance "ghost" AttributeEnd\nAttributeBegin ObjectInstance "ghost" AttributeEnd\n'
		) };

		const { droppedNoTemplate, warnings } = await loadPBRTScene( buildArgs( { vfs } ) );

		expect( droppedNoTemplate ).toBe( 2 );
		expect( warnings.some( w => /has no template/.test( w ) ) ).toBe( true );

	} );

} );
