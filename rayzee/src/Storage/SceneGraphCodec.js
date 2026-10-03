/**
 * Binary round trip for the three.js scenes the pbrt builder produces, so a reopened archive
 * skips parsing. Geometry, instance matrices and generated textures go to one binary file as
 * raw sections; the tree, materials and animation go to JSON. Textures that came from the
 * archive are stored as their path and decoded from it again.
 *
 * Deliberately narrow: an object type it does not know makes `encodeSceneGraph` throw
 * `SceneGraphUnsupported`, and the scene is simply not cached.
 */

import {
	AnimationClip, BufferAttribute, BufferGeometry, DataTexture, Group, InstancedBufferAttribute, InstancedMesh,
	MaterialLoader, Mesh, Object3D, OrthographicCamera, PerspectiveCamera, DirectionalLight, PointLight, SpotLight,
} from 'three';

export const SCENE_GRAPH_FORMAT = 2;
export const ARCHIVE_PATH = '__rayzeeArchivePath';
export const ARCHIVE_LOADER = '__rayzeeArchiveLoader';

const ALIGN = 64;
const PIECE_BYTES = 32 << 20;
const READ_WINDOW = 64 << 20;

const ARRAYS = { Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray };

const TEXTURE_PROPS = [
	'name', 'mapping', 'channel', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy', 'format', 'type',
	'flipY', 'generateMipmaps', 'premultiplyAlpha', 'unpackAlignment', 'colorSpace',
];

const LIGHT_PROPS = [ 'intensity', 'distance', 'decay', 'angle', 'penumbra' ];
const OBJECT_PROPS = [ 'name', 'visible', 'castShadow', 'receiveShadow', 'frustumCulled', 'renderOrder', 'matrixAutoUpdate' ];

export class SceneGraphUnsupported extends Error {

	constructor( message ) {

		super( message );
		this.name = 'SceneGraphUnsupported';

	}

}

function kindOf( object ) {

	if ( object.isInstancedMesh ) return 'InstancedMesh';
	if ( object.isSkinnedMesh || object.isBatchedMesh ) return null;
	if ( object.isMesh ) return 'Mesh';
	if ( object.isPerspectiveCamera ) return 'PerspectiveCamera';
	if ( object.isOrthographicCamera ) return 'OrthographicCamera';
	if ( object.isDirectionalLight ) return 'DirectionalLight';
	if ( object.isPointLight ) return 'PointLight';
	if ( object.isSpotLight ) return 'SpotLight';
	if ( object.isLight || object.isPoints || object.isLine || object.isSprite || object.isLOD ) return null;
	if ( object.isGroup ) return 'Group';
	return object.constructor === Object3D ? 'Object3D' : null;

}

function portableUserData( userData, where ) {

	try {

		const clone = JSON.parse( JSON.stringify( userData ?? {} ) );
		delete clone[ ARCHIVE_PATH ];
		delete clone[ ARCHIVE_LOADER ];
		return clone;

	} catch {

		throw new SceneGraphUnsupported( `${where}: userData is not plain JSON` );

	}

}

class SectionWriter {

	constructor() {

		this.sections = [];
		this.length = 0;

	}

	add( array ) {

		const offset = Math.ceil( this.length / ALIGN ) * ALIGN;
		this.sections.push( { offset, array } );
		this.length = offset + array.byteLength;
		return { offset, byteLength: array.byteLength, type: array.constructor.name, length: array.length };

	}

}

function encodeAttribute( attribute, sections, where ) {

	if ( attribute.isInterleavedBufferAttribute || ! ArrayBuffer.isView( attribute.array ) ) {

		throw new SceneGraphUnsupported( `${where}: interleaved or non-typed attribute` );

	}

	return {
		section: sections.add( attribute.array ),
		itemSize: attribute.itemSize,
		normalized: attribute.normalized === true,
		name: attribute.name ?? '',
	};

}

function encodeGeometry( geometry, sections ) {

	const where = `geometry ${geometry.name || geometry.uuid}`;
	if ( Object.keys( geometry.morphAttributes ?? {} ).length ) throw new SceneGraphUnsupported( `${where}: morph targets` );

	const attributes = {};
	for ( const [ name, attribute ] of Object.entries( geometry.attributes ) ) attributes[ name ] = encodeAttribute( attribute, sections, where );

	return {
		uuid: geometry.uuid,
		name: geometry.name,
		attributes,
		index: geometry.index ? encodeAttribute( geometry.index, sections, where ) : null,
		groups: geometry.groups.map( ( g ) => ( { ...g } ) ),
		drawRange: { ...geometry.drawRange },
		userData: portableUserData( geometry.userData, where ),
	};

}

function encodeTexture( texture, sections ) {

	const record = { uuid: texture.uuid, userData: portableUserData( texture.userData, `texture ${texture.uuid}` ) };
	for ( const prop of TEXTURE_PROPS ) record[ prop ] = texture[ prop ];
	for ( const prop of [ 'repeat', 'offset', 'center' ] ) record[ prop ] = texture[ prop ].toArray();
	record.rotation = texture.rotation;

	const path = texture.userData?.[ ARCHIVE_PATH ];
	if ( path ) {

		record.path = path;
		record.loader = texture.userData[ ARCHIVE_LOADER ] ?? 'image';

	} else if ( texture.isDataTexture && ArrayBuffer.isView( texture.image?.data ) ) {

		record.data = { section: sections.add( texture.image.data ), width: texture.image.width, height: texture.image.height };

	} else {

		throw new SceneGraphUnsupported( `texture ${texture.name || texture.uuid}: no archive path and no pixel data to keep` );

	}

	return record;

}

// Material.toJSON keeps colours as 8-bit sRGB hex, which moves every albedo a little: keep the floats.
function encodeMaterial( material, meta ) {

	const json = material.toJSON( meta );
	json.exactColors = {};
	for ( const [ key, value ] of Object.entries( material ) ) if ( value?.isColor ) json.exactColors[ key ] = [ value.r, value.g, value.b ];
	// MaterialLoader sets `reflectivity` after `ior`, and that setter rewrites ior with rounding.
	if ( material.ior !== undefined ) json.exactIor = material.ior;
	return json;

}

function collectTextures( material, out ) {

	for ( const value of Object.values( material ) ) if ( value?.isTexture ) out.set( value.uuid, value );

}

/**
 * @param {import('three').Object3D} root
 * @param {{environment?: import('three').Texture, animations?: AnimationClip[], stats?: Object}} [extra]
 * @returns {{manifest: Object, sections: Array<{offset:number, array: ArrayBufferView}>, byteLength: number}}
 * @throws {SceneGraphUnsupported}
 */
export function encodeSceneGraph( root, { environment = null, animations = [], stats = {} } = {} ) {

	const sections = new SectionWriter();
	const nodes = [];
	const geometries = new Map();
	const materials = new Map();
	const textures = new Map();

	const visit = ( object, parent ) => {

		const type = kindOf( object );
		if ( ! type ) throw new SceneGraphUnsupported( `${object.type} "${object.name}" cannot be cached` );

		const node = { type, uuid: object.uuid, parent, userData: portableUserData( object.userData, `${type} "${object.name}"` ) };
		for ( const prop of OBJECT_PROPS ) node[ prop ] = object[ prop ];
		node.position = object.position.toArray();
		node.quaternion = object.quaternion.toArray();
		node.scale = object.scale.toArray();
		node.layers = object.layers.mask;
		if ( ! object.matrixAutoUpdate ) node.matrix = object.matrix.toArray();

		if ( object.isMesh ) {

			geometries.set( object.geometry.uuid, object.geometry );
			const list = Array.isArray( object.material ) ? object.material : [ object.material ];
			for ( const material of list ) {

				materials.set( material.uuid, material );
				collectTextures( material, textures );

			}

			node.geometry = object.geometry.uuid;
			node.material = Array.isArray( object.material ) ? list.map( ( m ) => m.uuid ) : object.material.uuid;

		}

		if ( object.isInstancedMesh ) {

			node.count = object.count;
			node.instanceMatrix = sections.add( object.instanceMatrix.array );
			node.instanceColor = object.instanceColor ? sections.add( object.instanceColor.array ) : null;

		}

		if ( object.isCamera ) {

			for ( const prop of [ 'fov', 'aspect', 'near', 'far', 'zoom', 'focus', 'filmGauge', 'filmOffset', 'left', 'right', 'top', 'bottom' ] ) {

				if ( object[ prop ] !== undefined ) node[ prop ] = object[ prop ];

			}

		}

		if ( object.isLight ) {

			node.color = object.color.toArray();
			for ( const prop of LIGHT_PROPS ) if ( object[ prop ] !== undefined ) node[ prop ] = object[ prop ];
			if ( object.target ) node.target = object.target.uuid;

		}

		const index = nodes.push( node ) - 1;
		for ( const child of object.children ) visit( child, index );

	};

	visit( root, - 1 );

	if ( environment ) textures.set( environment.uuid, environment );

	const meta = { textures: {}, images: {} };
	for ( const uuid of textures.keys() ) meta.textures[ uuid ] = { uuid };

	const manifest = {
		v: SCENE_GRAPH_FORMAT,
		nodes,
		geometries: [ ...geometries.values() ].map( ( g ) => encodeGeometry( g, sections ) ),
		textures: [ ...textures.values() ].map( ( t ) => encodeTexture( t, sections ) ),
		materials: [ ...materials.values() ].map( ( m ) => encodeMaterial( m, meta ) ),
		animations: animations.map( ( clip ) => AnimationClip.toJSON( clip ) ),
		environment: environment ? environment.uuid : null,
		stats,
	};

	return { manifest, sections: sections.sections, byteLength: sections.length };

}

/**
 * Writes an encoded graph into a storage entry: `graph.json` and `data.bin`.
 * @param {{release?: boolean}} [options] - drop each section's array once written, so a graph
 *   written during a build does not keep arrays the build has since replaced
 */
export async function writeSceneGraph( writer, { manifest, sections }, { release = false } = {} ) {

	for ( const section of sections ) {

		const { offset, array } = section;
		const bytes = new Uint8Array( array.buffer, array.byteOffset, array.byteLength );
		for ( let at = 0; at < bytes.length; at += PIECE_BYTES ) {

			await writer.write( 'data.bin', bytes.subarray( at, Math.min( bytes.length, at + PIECE_BYTES ) ), { at: offset + at } );

		}

		if ( release ) section.array = null;

	}

	if ( sections.length === 0 ) await writer.write( 'data.bin', new Uint8Array( 0 ) );
	await writer.writeJSON( 'graph.json', manifest );

}

function arrayType( type ) {

	const ArrayType = ARRAYS[ type ];
	if ( ! ArrayType ) throw new Error( `scene graph: unknown array type ${type}` );
	return ArrayType;

}

/**
 * Every section of the file, read in one forward pass of large windows — thousands of small
 * reads cost ~0.5 ms each through File.slice, which made decoding slower than parsing.
 * @returns {Promise<Map<number, ArrayBufferView>>} keyed by offset
 */
async function readSections( file, sections ) {

	const out = new Map();
	const ordered = [ ...sections ].sort( ( a, b ) => a.offset - b.offset );
	let window = null;
	let windowStart = 0;

	for ( const section of ordered ) {

		const { offset, byteLength, type } = section;
		const ArrayType = arrayType( type );
		const end = offset + byteLength;

		if ( byteLength > READ_WINDOW ) {

			out.set( offset, new ArrayType( await file.slice( offset, end ).arrayBuffer() ) );
			continue;

		}

		if ( ! window || offset < windowStart || end > windowStart + window.byteLength ) {

			windowStart = offset;
			window = await file.slice( offset, Math.min( file.size, offset + READ_WINDOW ) ).arrayBuffer();

		}

		out.set( offset, new ArrayType( window.slice( offset - windowStart, end - windowStart ) ) );

	}

	return out;

}

function sectionsOf( manifest ) {

	const all = [];
	for ( const node of manifest.nodes ) {

		if ( node.instanceMatrix ) all.push( node.instanceMatrix );
		if ( node.instanceColor ) all.push( node.instanceColor );

	}

	for ( const g of manifest.geometries ) {

		for ( const a of Object.values( g.attributes ) ) all.push( a.section );
		if ( g.index ) all.push( g.index.section );

	}

	for ( const t of manifest.textures ) if ( t.data ) all.push( t.data.section );
	return all;

}

function decodeAttribute( arrays, record ) {

	const attribute = new BufferAttribute( arrays.get( record.section.offset ), record.itemSize, record.normalized );
	attribute.name = record.name;
	return attribute;

}

function applyTextureProps( texture, record ) {

	for ( const prop of TEXTURE_PROPS ) if ( record[ prop ] !== undefined ) texture[ prop ] = record[ prop ];
	texture.repeat.fromArray( record.repeat );
	texture.offset.fromArray( record.offset );
	texture.center.fromArray( record.center );
	texture.rotation = record.rotation;
	texture.uuid = record.uuid;
	Object.assign( texture.userData, record.userData );
	texture.needsUpdate = true;

}

/**
 * @param {Object} manifest - `graph.json`
 * @param {Blob} data - `data.bin`
 * @param {{loadTexture: function(string, string): Promise<?import('three').Texture>}} io - decodes an
 *   archive path with the loader it was first read with ('image' or 'environment')
 * @returns {Promise<{root: Object3D, environment: ?import('three').Texture, animations: AnimationClip[], stats: Object}>}
 */
export async function decodeSceneGraph( manifest, data, { loadTexture } ) {

	if ( manifest?.v !== SCENE_GRAPH_FORMAT ) throw new Error( 'scene graph: unknown format' );

	const arrays = await readSections( data, sectionsOf( manifest ) );
	const section = ( record ) => arrays.get( record.offset );

	const textures = {};
	for ( const record of manifest.textures ) {

		let texture;
		if ( record.path ) {

			texture = await loadTexture( record.path, record.loader );
			if ( ! texture ) throw new Error( `scene graph: "${record.path}" is missing from the archive` );
			texture.userData[ ARCHIVE_PATH ] = record.path;
			texture.userData[ ARCHIVE_LOADER ] = record.loader;

		} else {

			texture = new DataTexture( section( record.data.section ), record.data.width, record.data.height );

		}

		applyTextureProps( texture, record );
		textures[ record.uuid ] = texture;

	}

	const materialLoader = new MaterialLoader().setTextures( textures );
	const materials = {};
	for ( const json of manifest.materials ) {

		const material = materialLoader.parse( json );
		for ( const [ key, rgb ] of Object.entries( json.exactColors ?? {} ) ) material[ key ]?.setRGB( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );
		if ( json.exactIor !== undefined ) material.ior = json.exactIor;
		materials[ json.uuid ] = material;

	}

	const geometries = {};
	for ( const record of manifest.geometries ) {

		const geometry = new BufferGeometry();
		geometry.uuid = record.uuid;
		geometry.name = record.name;
		for ( const [ name, attribute ] of Object.entries( record.attributes ) ) geometry.setAttribute( name, decodeAttribute( arrays, attribute ) );
		if ( record.index ) geometry.setIndex( decodeAttribute( arrays, record.index ) );
		for ( const g of record.groups ) geometry.addGroup( g.start, g.count, g.materialIndex );
		geometry.setDrawRange( record.drawRange.start, record.drawRange.count );
		geometry.userData = record.userData;
		geometries[ record.uuid ] = geometry;

	}

	const built = [];
	for ( const node of manifest.nodes ) {

		const material = Array.isArray( node.material ) ? node.material.map( ( u ) => materials[ u ] ) : materials[ node.material ];
		let object;
		switch ( node.type ) {

			case 'InstancedMesh': {

				// Built for one instance, then given the stored matrices: no second full-size array.
				object = new InstancedMesh( geometries[ node.geometry ], material, 1 );
				object.instanceMatrix = new InstancedBufferAttribute( section( node.instanceMatrix ), 16 );
				object.count = node.count;
				if ( node.instanceColor ) object.instanceColor = new InstancedBufferAttribute( section( node.instanceColor ), 3 );
				break;

			}

			case 'Mesh': object = new Mesh( geometries[ node.geometry ], material ); break;
			case 'PerspectiveCamera': object = new PerspectiveCamera(); break;
			case 'OrthographicCamera': object = new OrthographicCamera(); break;
			case 'Group': object = new Group(); break;
			case 'DirectionalLight': object = new DirectionalLight(); break;
			case 'PointLight': object = new PointLight(); break;
			case 'SpotLight': object = new SpotLight(); break;
			default: object = new Object3D();

		}

		object.uuid = node.uuid;
		for ( const prop of OBJECT_PROPS ) object[ prop ] = node[ prop ];
		object.position.fromArray( node.position );
		object.quaternion.fromArray( node.quaternion );
		object.scale.fromArray( node.scale );
		object.layers.mask = node.layers;
		object.userData = node.userData;
		if ( node.matrix ) object.matrix.fromArray( node.matrix );

		if ( object.isCamera ) {

			for ( const prop of [ 'fov', 'aspect', 'near', 'far', 'zoom', 'focus', 'filmGauge', 'filmOffset', 'left', 'right', 'top', 'bottom' ] ) {

				if ( node[ prop ] !== undefined ) object[ prop ] = node[ prop ];

			}

			object.updateProjectionMatrix();

		}

		if ( object.isLight ) {

			object.color.fromArray( node.color );
			for ( const prop of LIGHT_PROPS ) if ( node[ prop ] !== undefined ) object[ prop ] = node[ prop ];

		}

		built.push( object );
		if ( node.parent >= 0 ) built[ node.parent ].add( object );

	}

	// A light aims at its target, which is stored as an object of its own.
	const byUuid = new Map( built.map( ( object ) => [ object.uuid, object ] ) );
	manifest.nodes.forEach( ( node, i ) => {

		if ( node.target && byUuid.has( node.target ) ) built[ i ].target = byUuid.get( node.target );

	} );

	return {
		root: built[ 0 ],
		environment: manifest.environment ? textures[ manifest.environment ] : null,
		animations: manifest.animations.map( ( json ) => AnimationClip.parse( json ) ),
		stats: manifest.stats,
	};

}

