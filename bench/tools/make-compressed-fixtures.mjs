/**
 * Builds the compressed-glTF fixtures `npm run bench:node` loads: one torus knot plain and Draco-compressed, and one
 * checker plane with a PNG and with a Basis Universal (KTX2) texture. Each pair renders alike, so a decoder that runs
 * but decodes wrongly fails as surely as one that does not run.
 *
 * The encoders are not dependencies of this repo. Install them in a scratch folder and pass its node_modules:
 *
 *   npm install --prefix /tmp/fx draco3dgltf@1.5.7 @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 ktx2-encoder@0.6.0
 *   node bench/tools/make-compressed-fixtures.mjs /tmp/fx/node_modules
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TorusKnotGeometry, PlaneGeometry } from 'three';
import sharp from 'sharp';

const here = path.dirname( fileURLToPath( import.meta.url ) );
const out = path.resolve( here, '../node/fixtures' );
const deps = process.argv[ 2 ];
if ( ! deps ) throw new Error( 'usage: node bench/tools/make-compressed-fixtures.mjs <node_modules with the encoders>' );

const load = ( spec ) => import( pathToFileURL( path.join( deps, spec ) ).href );
const { Document, NodeIO } = await load( '@gltf-transform/core/dist/index.js' );
const { KHRDracoMeshCompression, KHRTextureBasisu } = await load( '@gltf-transform/extensions/dist/index.js' );
const draco3d = ( await load( 'draco3dgltf/draco3dgltf.js' ) ).default;
const { ktx2 } = await load( 'ktx2-encoder/dist/gltf-transform/index.js' );

const io = new NodeIO()
	.registerExtensions( [ KHRDracoMeshCompression, KHRTextureBasisu ] )
	.registerDependencies( {
		'draco3d.encoder': await draco3d.createEncoderModule(),
		'draco3d.decoder': await draco3d.createDecoderModule(),
	} );

function documentOf( geometry, { color, roughness, texture } ) {

	const doc = new Document();
	const buffer = doc.createBuffer();
	const attr = ( name, type ) => doc.createAccessor( name ).setType( type ).setBuffer( buffer )
		.setArray( new Float32Array( geometry.getAttribute( name ).array ) );

	const prim = doc.createPrimitive()
		.setAttribute( 'POSITION', attr( 'position', 'VEC3' ) )
		.setAttribute( 'NORMAL', attr( 'normal', 'VEC3' ) )
		.setAttribute( 'TEXCOORD_0', attr( 'uv', 'VEC2' ) )
		.setIndices( doc.createAccessor().setType( 'SCALAR' ).setBuffer( buffer ).setArray( new Uint32Array( geometry.index.array ) ) );

	const material = doc.createMaterial().setBaseColorFactor( color ).setRoughnessFactor( roughness ).setMetallicFactor( 0 );
	if ( texture ) material.setBaseColorTexture( doc.createTexture().setMimeType( 'image/png' ).setImage( texture ) );
	prim.setMaterial( material );

	doc.createScene().addChild( doc.createNode().setMesh( doc.createMesh().addPrimitive( prim ) ) );
	return doc;

}

async function checkerPNG( size, cells ) {

	const pixels = new Uint8Array( size * size * 4 );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const on = ( Math.floor( x * cells / size ) + Math.floor( y * cells / size ) ) % 2 === 0;
		pixels.set( on ? [ 230, 120, 40, 255 ] : [ 40, 90, 200, 255 ], ( y * size + x ) * 4 );

	}

	return new Uint8Array( await sharp( pixels, { raw: { width: size, height: size, channels: 4 } } ).png().toBuffer() );

}

const imageDecoder = async ( bytes ) => {

	const { data, info } = await sharp( bytes ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	return { data: new Uint8Array( data ), width: info.width, height: info.height };

};

fs.mkdirSync( out, { recursive: true } );

const knot = new TorusKnotGeometry( 0.6, 0.2, 64, 12 );
const knotLook = { color: [ 0.8, 0.5, 0.3, 1 ], roughness: 0.4 };
fs.writeFileSync( path.join( out, 'knot.glb' ), await io.writeBinary( documentOf( knot, knotLook ) ) );
const dracoKnot = documentOf( knot, knotLook );
dracoKnot.createExtension( KHRDracoMeshCompression ).setRequired( true );
fs.writeFileSync( path.join( out, 'knot-draco.glb' ), await io.writeBinary( dracoKnot ) );

const plane = new PlaneGeometry( 2, 2 );
const png = await checkerPNG( 128, 8 );
const planeLook = { color: [ 1, 1, 1, 1 ], roughness: 0.6, texture: png };
fs.writeFileSync( path.join( out, 'checker.glb' ), await io.writeBinary( documentOf( plane, planeLook ) ) );
const basisPlane = documentOf( plane, planeLook );
await basisPlane.transform( ktx2( { isUASTC: false, generateMipmap: false, imageDecoder } ) );
fs.writeFileSync( path.join( out, 'checker-ktx2.glb' ), await io.writeBinary( basisPlane ) );

for ( const f of fs.readdirSync( out ) ) console.log( f, fs.statSync( path.join( out, f ) ).size, 'bytes' );
