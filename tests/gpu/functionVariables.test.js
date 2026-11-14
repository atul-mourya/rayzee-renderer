/**
 * Every compute function the engine builds keeps its own variables under WGSL's 8,192 bytes, which WebKit enforces and
 * Dawn does not: past it Safari refuses the kernel. Built with every compile-time feature on, under each integrator, as
 * the WGSL reaches the device.
 */

import { it, expect } from 'vitest';
import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, SphereGeometry, BoxGeometry, PointLight, SpotLight, DirectionalLight, RectAreaLight, DataTexture, RepeatWrapping, Scene } from 'three';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { openHeadless } from '@/core/viewer/Headless.js';
import { ALL_MATERIAL_LAYERS } from '@/core/shaders/SceneResources.js';
import { Volume, VolumeGrid } from '@/core/scene/Volumes.js';

const LIMIT = 8192;
const ROOT = new URL( '../../', import.meta.url );

class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

// WGSL's size and alignment of a type, for the types TSL declares.
function layoutOf( type, structs ) {

	const t = type.trim();
	if ( [ 'f32', 'i32', 'u32', 'bool' ].includes( t ) ) return { size: 4, align: 4 };
	let m = t.match( /^vec([234])(?:<\w+>|[fiu])$/ );
	if ( m ) return { size: 4 * m[ 1 ], align: m[ 1 ] === '2' ? 8 : 16 };
	m = t.match( /^mat([234])x([234])(?:<f32>|f)$/ );
	if ( m ) return { size: m[ 1 ] * ( m[ 2 ] === '2' ? 8 : 16 ), align: m[ 2 ] === '2' ? 8 : 16 };
	m = t.match( /^array<\s*(.+?)\s*,\s*(\d+)u?\s*>$/ );
	if ( m ) {

		const e = layoutOf( m[ 1 ], structs );
		return { size: Math.ceil( e.size / e.align ) * e.align * m[ 2 ], align: e.align };

	}

	if ( structs[ t ] ) return structs[ t ];
	throw new Error( `no size for ${t}` );

}

/** The bytes of each function's own variables in a WGSL module. */
function functionVariableBytes( code ) {

	const structs = {};
	for ( const m of code.matchAll( /struct\s+(\w+)\s*\{([^}]*)\}/g ) ) {

		let offset = 0, align = 1;
		try {

			for ( const field of m[ 2 ].split( ',' ).filter( ( f ) => f.includes( ':' ) ) ) {

				const l = layoutOf( field.slice( field.indexOf( ':' ) + 1 ), structs );
				offset = Math.ceil( offset / l.align ) * l.align + l.size;
				align = Math.max( align, l.align );

			}

			structs[ m[ 1 ] ] = { size: Math.ceil( offset / align ) * align, align };

		} catch { /* a buffer's runtime-sized struct: never a variable */ }

	}

	const out = {};
	for ( const header of code.matchAll( /\bfn\s+(\w+)\s*\(/g ) ) {

		const open = code.indexOf( '{', header.index );
		let depth = 0, close = open;
		for ( ; close < code.length; close ++ ) {

			if ( code[ close ] === '{' ) depth ++;
			else if ( code[ close ] === '}' && -- depth === 0 ) break;

		}

		let bytes = 0;
		for ( const v of code.slice( open, close ).matchAll( /\bvar\s+\w+\s*:\s*([^;=]+?)\s*[;=]/g ) ) bytes += layoutOf( v[ 1 ], structs ).size;
		out[ header[ 1 ] ] = bytes;

	}

	return out;

}

const texture = () => {

	const t = new DataTexture( new Uint8Array( 64 ).fill( 200 ), 4, 4 );
	t.wrapS = t.wrapT = RepeatWrapping;
	t.needsUpdate = true;
	return t;

};

async function largestFunctions( integrator ) {

	configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
	configureAssets( { oidnWeightsBaseUrl: new URL( 'tests/__nothing__/', ROOT ).href } );
	const app = await openHeadless( { width: 16, height: 16, strict: false } );
	const device = app.renderer.backend.device;
	const modules = [];
	const create = device.createShaderModule.bind( device );
	device.createShaderModule = ( descriptor ) => {

		if ( descriptor.code.includes( '@compute' ) ) modules.push( { label: descriptor.label, code: String( descriptor.code ) } );
		return create( descriptor );

	};

	// Every feature the kernels compile in only on demand.
	const pt = app.stages.pathTracer;
	const md = pt.materialData;
	pt._layersToCompile = () => ALL_MATERIAL_LAYERS;
	pt._lightRadiusNeeded = () => ! pt._integrator;
	pt._clearcoatNormalsNeeded = () => ! pt._integrator;
	pt._regularizeNeeded = () => ! pt._integrator;
	md.hasTransmission = md.hasTransmissionMaps = md.hasBumpMaps = md.hasRelativeIOR = () => true;
	const releaseHitDistance = pt.requestOutput( 'hitDistance', { encode: ( d, z ) => d.div( z.max( 1e-4 ) ).clamp( 0.0, 1.0 ) } );
	const releaseEmission = pt.requestOutput( 'emission' );
	app.settings.set( 'fogDensity', integrator === 'path' ? 0.05 : 0 );
	app.settings.set( 'integrator', integrator );

	const floor = new Mesh( new PlaneGeometry( 8, 8 ), new MeshStandardMaterial( { normalMap: texture(), bumpMap: texture(), displacementMap: texture(), displacementScale: 0.01 } ) );
	floor.rotation.x = - Math.PI / 2;
	const glass = new Mesh( new SphereGeometry( 0.6, 16, 8 ), new MeshPhysicalMaterial( { transmission: 1, dispersion: 0.3, attenuationDistance: 2, transmissionMap: texture() } ) );
	const coat = new Mesh( new SphereGeometry( 0.6, 16, 8 ), new MeshPhysicalMaterial( { clearcoat: 1, clearcoatNormalMap: texture(), sheen: 1, iridescence: 1, anisotropy: 0.5, map: texture(), alphaTest: 0.5 } ) );
	const lamp = new Mesh( new BoxGeometry( 0.5, 0.5, 0.5 ), new MeshStandardMaterial( { emissive: 0xffffff, emissiveIntensity: 4 } ) );
	glass.position.set( - 1, 0.6, 0 );
	coat.position.set( 1, 0.6, 0 );
	lamp.position.set( 0, 2, - 1 );
	const point = new PointLight( 0xffffff, 20 );
	point.userData.radius = 0.1;
	const rect = new RectAreaLight( 0xffffff, 5, 1, 1 );
	const smoke = new Volume( VolumeGrid.fromFunction( 8, () => 1 ), { emissionGrid: VolumeGrid.fromFunction( 8, () => 1 ), emissionStrength: 1 } );
	await app.loadObject3D( new Scene().add( floor, glass, coat, lamp, point, new SpotLight(), new DirectionalLight(), rect, smoke ), 'features' );
	await app.environmentManager.setMode( 'procedural' );
	await app.renderFrames( 1 );

	releaseHitDistance?.();
	releaseEmission?.();
	app.dispose();

	const largest = {};
	for ( const { label, code } of modules ) {

		for ( const [ name, bytes ] of Object.entries( functionVariableBytes( code ) ) ) {

			const key = `${label} ${name}`;
			largest[ key ] = Math.max( largest[ key ] ?? 0, bytes );

		}

	}

	return largest;

}

describeGPU( 'compute functions\' own variables', () => {

	for ( const integrator of [ 'path', 'vcm' ] ) {

		it( `stay under ${LIMIT} bytes with every feature compiled in (${integrator})`, async () => {

			const largest = await largestFunctions( integrator );
			expect( Object.keys( largest ).length ).toBeGreaterThan( 10 );
			const over = Object.entries( largest ).filter( ( [ , bytes ] ) => bytes >= LIMIT );
			expect( over ).toEqual( [] );

		}, 120000 );

	}

} );
