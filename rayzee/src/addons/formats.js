import { FloatType, Mesh, MeshStandardMaterial, Points, PointsMaterial } from 'three';

/**
 * File formats beyond glTF and .hdr — `rayzee/addons/formats`: FBX, OBJ, STL, PLY, Collada, 3MF and USD models, and
 * EXR environments. PathTracerApp registers all of them itself; on the renderer core, register the ones you read (each
 * three.js loader is downloaded the first time its format is read, and a bundler drops the formats you leave out):
 *
 * @example
 * import { RayzeeRenderer } from 'rayzee/core';
 * import { objFormat, exrFormat } from 'rayzee/addons/formats';
 *
 * renderer.assetLoader.registerFormat( objFormat, exrFormat );
 * await renderer.loadFile( objFile );
 *
 * A model format's `parse( file, { filename, cache } )` resolves to `{ model, result? }`; an environment format's
 * `createLoader( manager )` to a three.js loader whose `loadAsync` resolves to a texture.
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

// OpenPBR's coat darkens its base (coat_darkening, default 1), which three's composer does not read.
function readCoatDarkening( USDComposer ) {

	const proto = USDComposer.prototype;
	const apply = proto._applyOpenPBRSurface;
	if ( typeof apply !== 'function' || proto.__rayzeeCoatDarkening ) return;

	proto._applyOpenPBRSurface = function ( material, shaderPath ) {

		apply.call( this, material, shaderPath );
		if ( material.clearcoat > 0 ) {

			const value = this._getAttributes( shaderPath )[ 'inputs:coat_darkening' ];
			material.coatDarkening = typeof value === 'number' ? value : 1;

		}

	};

	proto.__rayzeeCoatDarkening = true;

}

export const usdFormat = {
	name: 'USD (Universal Scene Description)', label: 'USD', type: 'model', extensions: [ 'usd', 'usda', 'usdc', 'usdz' ],
	async parse( file, { filename, cache } ) {

		if ( ! cache.usd ) {

			const [ { USDLoader }, { USDComposer } ] = await Promise.all( [
				import( 'three/addons/loaders/USDLoader.js' ), import( 'three/addons/loaders/usd/USDComposer.js' ),
			] );
			readCoatDarkening( USDComposer );
			cache.usd = new USDLoader();

		}

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
