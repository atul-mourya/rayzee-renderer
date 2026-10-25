import { FloatType, Mesh, MeshStandardMaterial, Points, PointsMaterial } from 'three';

/**
 * File formats beyond glTF and .hdr, each registered on its own (`assetLoader.registerFormat( fbxFormat )`) so a host
 * ships only the readers it uses. A model format's `parse( file, { filename, cache } )` resolves to `{ model, result? }`;
 * an environment format's `createLoader( manager )` to a three.js loader whose `loadAsync` resolves to a texture.
 * Each three.js loader is imported the first time its format is read.
 */

export const fbxFormat = {
	name: 'FBX', label: 'FBX', type: 'model', extensions: [ 'fbx' ],
	async parse( file, { cache } ) {

		cache.fbx ??= new ( await import( 'three/addons/loaders/FBXLoader.js' ) ).FBXLoader();
		return { model: cache.fbx.parse( await file.arrayBuffer() ) };

	},
};

export const objFormat = {
	name: 'OBJ', label: 'OBJ', type: 'model', extensions: [ 'obj' ],
	async parse( file, { filename, cache } ) {

		cache.obj ??= new ( await import( 'three/addons/loaders/OBJLoader.js' ) ).OBJLoader();
		const model = cache.obj.parse( await file.text() );
		model.name = filename;
		return { model };

	},
};

export const stlFormat = {
	name: 'STL', label: 'STL', type: 'model', extensions: [ 'stl' ],
	async parse( file, { filename, cache } ) {

		cache.stl ??= new ( await import( 'three/addons/loaders/STLLoader.js' ) ).STLLoader();
		const model = new Mesh( cache.stl.parse( await file.arrayBuffer() ), new MeshStandardMaterial() );
		model.name = filename;
		return { model };

	},
};

export const plyFormat = {
	name: 'PLY (Polygon File Format)', label: 'PLY', type: 'model', extensions: [ 'ply' ],
	async parse( file, { filename, cache } ) {

		cache.ply ??= new ( await import( 'three/addons/loaders/PLYLoader.js' ) ).PLYLoader();
		const geometry = cache.ply.parse( await file.arrayBuffer() );
		let model;
		if ( geometry.index !== null ) {

			model = new Mesh( geometry, new MeshStandardMaterial() );

		} else {

			const material = new PointsMaterial( { size: 0.01 } );
			material.vertexColors = geometry.hasAttribute( 'color' );
			model = new Points( geometry, material );

		}

		model.name = filename;
		return { model };

	},
};

export const colladaFormat = {
	name: 'Collada', label: 'Collada', type: 'model', extensions: [ 'dae' ],
	async parse( file, { filename, cache } ) {

		cache.collada ??= new ( await import( 'three/addons/loaders/ColladaLoader.js' ) ).ColladaLoader();
		const collada = cache.collada.parse( await file.text() );
		collada.scene.name = filename;
		return { model: collada.scene, result: collada };

	},
};

export const threeMFFormat = {
	name: '3D Manufacturing Format', label: '3MF', type: 'model', extensions: [ '3mf' ],
	async parse( file, { cache } ) {

		cache.threemf ??= new ( await import( 'three/addons/loaders/3MFLoader.js' ) ).ThreeMFLoader();
		return { model: cache.threemf.parse( await file.arrayBuffer() ) };

	},
};

export const usdFormat = {
	name: 'USD (Universal Scene Description)', label: 'USD', type: 'model', extensions: [ 'usd', 'usda', 'usdc', 'usdz' ],
	async parse( file, { filename, cache } ) {

		cache.usd ??= new ( await import( 'three/addons/loaders/USDLoader.js' ) ).USDLoader();
		const data = await file.arrayBuffer();
		// parse() returns the group at once but resolves textures later; the materials are read after, so wait for them.
		const model = await new Promise( ( resolve, reject ) => cache.usd.parse( data, '', resolve, reject ) );
		model.name = filename;
		return { model };

	},
};

export const exrFormat = {
	name: 'EXR (OpenEXR)', label: 'EXR', type: 'environment', extensions: [ 'exr' ],
	async createLoader( manager ) {

		const { EXRLoader } = await import( 'three/addons/loaders/EXRLoader.js' );
		return new EXRLoader( manager ).setDataType( FloatType );

	},
};

/** Every format above. */
export const allFormats = [ fbxFormat, objFormat, stlFormat, plyFormat, colladaFormat, threeMFFormat, usdFormat, exrFormat ];
