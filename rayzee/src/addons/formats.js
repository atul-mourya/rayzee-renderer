import { FloatType, MathUtils, Mesh, MeshStandardMaterial, Points, PointsMaterial } from 'three';

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

// FBXLoader gives a camera naming no shape (AspectWidth / AspectHeight) the window's. It is lent FBX's default, 320 × 200,
// a hair off so that a shape the file gives (its `userData.aspect`) is told apart.
const FBX_STAND_IN = { innerWidth: 320, innerHeight: 200 + 2 ** - 20 };
const FBX_STAND_IN_ASPECT = FBX_STAND_IN.innerWidth / FBX_STAND_IN.innerHeight;

function withWindowSize( size, parse ) {

	const host = globalThis.window;
	if ( ! host ) {

		globalThis.window = { ...size };
		try {

			return parse();

		} finally {

			delete globalThis.window;

		}

	}

	const own = Object.fromEntries( Object.keys( size ).map( ( key ) => [ key, Object.getOwnPropertyDescriptor( host, key ) ] ) );
	for ( const key in size ) Object.defineProperty( host, key, { value: size[ key ], configurable: true } );
	try {

		return parse();

	} finally {

		for ( const key in own ) own[ key ] ? Object.defineProperty( host, key, own[ key ] ) : delete host[ key ];

	}

}

export const fbxFormat = {
	name: 'FBX', label: 'FBX', type: 'model', extensions: [ 'fbx' ],
	async parse( file, { cache } ) {

		cache.fbx ??= new ( await import( 'three/addons/loaders/FBXLoader.js' ) ).FBXLoader();
		const data = await file.arrayBuffer();
		const model = withWindowSize( FBX_STAND_IN, () => cache.fbx.parse( data ) );
		// FBXLoader reads the file's unit (centimetres a unit) but leaves the model in it; the engine's is the metre.
		const unit = model.userData.unitScaleFactor;
		if ( unit > 0 && unit !== 100 ) model.scale.multiplyScalar( unit / 100 );
		model.traverse( ( camera ) => {

			if ( ! camera.isPerspectiveCamera ) return;
			if ( camera.aspect !== FBX_STAND_IN_ASPECT ) {

				if ( camera.aspect > 0 && Number.isFinite( camera.aspect ) ) camera.userData.aspect = camera.aspect;
				return;

			}

			camera.aspect = 320 / 200;
			camera.updateProjectionMatrix();

		} );
		return { model };

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

// ColladaLoader keeps no shape and reads yfov alone. A camera's shape is its aspect_ratio, else xfov with yfov (xmag with
// ymag); xfov with a shape gives the view's height (Blender writes xfov and aspect_ratio).
function colladaCameraShape( camera, { technique, parameters: p = {} } = {} ) {

	const halfTan = ( degrees ) => Math.tan( MathUtils.degToRad( degrees ) / 2 );
	const aspect = p.aspect_ratio ?? ( technique === 'orthographic' ? p.xmag / p.ymag : halfTan( p.xfov ) / halfTan( p.yfov ) );
	if ( ! ( aspect > 0 && Number.isFinite( aspect ) ) ) return;

	camera.userData.aspect = aspect;
	if ( ! camera.isPerspectiveCamera ) return;
	camera.aspect = aspect;
	if ( p.yfov === undefined && p.xfov > 0 ) camera.fov = MathUtils.radToDeg( 2 * Math.atan( halfTan( p.xfov ) / aspect ) );
	camera.updateProjectionMatrix();

}

// ColladaLoader throws on an <image> without <init_from>, an empty <effect> or a <float> <transparent>, and paints magenta
// a material symbol its one binding names otherwise: each is read as the nearest valid file. Returns the undo.
function repairCollada( { prototype: parser }, { prototype: composer } ) {

	const { parseImage, parseEffect, parseEffectParameters } = parser;
	const { resolveMaterialBinding } = composer;
	parser.parseImage = function ( xml ) {

		// Three reads a direct child only: one inside <create_2d> (COLLADA 1.5) is no file to it either.
		if ( [ ...xml.childNodes ].some( ( child ) => child.nodeName === 'init_from' ) ) parseImage.call( this, xml );

	};

	parser.parseEffect = function ( xml ) {

		parseEffect.call( this, xml );
		const profile = this.library.effects[ xml.getAttribute( 'id' ) ].profile ??= { surfaces: {}, samplers: {} };
		const technique = profile.technique ??= {};
		if ( ! technique.parameters ) Object.assign( technique, { type: technique.type ?? 'lambert', parameters: {} } );

	};

	parser.parseEffectParameters = function ( xml ) {

		const data = parseEffectParameters.call( this, xml );
		const transparent = data.transparent?.data;
		if ( transparent && ! transparent.color && ! transparent.texture ) transparent.color = new Array( 4 ).fill( Number.isFinite( transparent.float ) ? transparent.float : 1 );
		return data;

	};

	composer.resolveMaterialBinding = function ( keys, instanceMaterials ) {

		// One material, and one the file defines: a binding to a missing one keeps three's fallback.
		const bound = [ ...new Set( Object.values( instanceMaterials ) ) ];
		if ( bound.length !== 1 || ! this.library.materials?.[ bound[ 0 ] ] ) return resolveMaterialBinding.call( this, keys, instanceMaterials );
		return resolveMaterialBinding.call( this, keys, { ...Object.fromEntries( keys.map( ( key ) => [ key, bound[ 0 ] ] ) ), ...instanceMaterials } );

	};

	return () => {

		Object.assign( parser, { parseImage, parseEffect, parseEffectParameters } );
		composer.resolveMaterialBinding = resolveMaterialBinding;

	};

}

export const colladaFormat = {
	name: 'Collada', label: 'Collada', type: 'model', extensions: [ 'dae' ],
	async parse( file, { filename, cache } ) {

		cache.collada ??= new ( await import( 'three/addons/loaders/ColladaLoader.js' ) ).ColladaLoader();
		const [ { ColladaComposer }, { ColladaParser } ] = await Promise.all( [
			import( 'three/addons/loaders/collada/ColladaComposer.js' ),
			import( 'three/addons/loaders/collada/ColladaParser.js' ),
		] );
		const text = await file.text();

		// The camera is built from the file's values, then cloned into the scene: what it carries, the clones do.
		const buildCamera = ColladaComposer.prototype.buildCamera;
		ColladaComposer.prototype.buildCamera = function ( data ) {

			const camera = buildCamera.call( this, data );
			colladaCameraShape( camera, data.optics );
			return camera;

		};

		const undoRepairs = repairCollada( ColladaParser, ColladaComposer );
		let collada;
		try {

			collada = cache.collada.parse( text );

		} finally {

			ColladaComposer.prototype.buildCamera = buildCamera;
			undoRepairs();

		}

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

		const { WorkerEXRLoader } = await import( '../loaders/EXRDecode.js' );
		return new WorkerEXRLoader( manager ).setDataType( FloatType );

	},
};

/** Every format above. */
export const allFormats = [ fbxFormat, objFormat, stlFormat, plyFormat, colladaFormat, threeMFFormat, usdFormat, exrFormat ];
