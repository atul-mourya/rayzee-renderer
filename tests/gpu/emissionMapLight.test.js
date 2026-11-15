/**
 * Light sampling reads an emitter's emission map at the point it draws. The same light built as a white half and a black
 * half, no map, is the truth.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataTexture, Group, Mesh, MeshPhysicalMaterial, NearestFilter, PlaneGeometry, SRGBColorSpace } from 'three';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';

const ROOT = new URL( '../../', import.meta.url );
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

const SIZE = 32;

// A white floor under a 2 × 2 light facing down, made of `parts`: [ width, depth, x, z, emissive, map ].
function scene( parts ) {

	const group = new Group();
	const floor = new Mesh( new PlaneGeometry( 6, 6 ), new MeshPhysicalMaterial( { color: 0xffffff, roughness: 1 } ) );
	floor.rotation.x = - Math.PI / 2;
	group.add( floor );
	for ( const [ width, depth, x, z, emissive, map ] of parts ) {

		const light = new Mesh( new PlaneGeometry( width, depth ), new MeshPhysicalMaterial( { color: 0x000000, emissive, emissiveIntensity: 4, emissiveMap: map ?? null } ) );
		light.rotation.x = Math.PI / 2;
		light.position.set( x, 1, z );
		group.add( light );

	}

	return group;

}

describeGPU( 'an emission map in light sampling', () => {

	let app;
	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );
		app.settings.setMany( { enableEnvironment: false, enableEmissiveTriangleSampling: true, maxBounces: 2 } );

	}, 60000 );

	afterAll( () => app?.dispose() );

	// The floor's lower image half: its left and right, then its far and near bands.
	const regions = async ( group, { flatList = false } = {} ) => {

		await app.loadObject3D( group, 'lit' );
		// No light tree: the flat list draws the emitters instead.
		if ( flatList ) app.stages.pathTracer.lightBVHNodeCount.value = 0;
		app.camera.position.set( 0, 0.5, 3.5 );
		app.camera.lookAt( 0, 0, 0 );
		await app.renderFrames( 256 );
		const image = ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data;
		const sum = [ 0, 0, 0, 0 ];
		for ( let y = SIZE / 2; y < SIZE; y ++ ) for ( let x = 0; x < SIZE; x ++ ) {

			const g = image[ ( y * SIZE + x ) * 4 + 1 ];
			sum[ x < SIZE / 2 ? 0 : 1 ] += g;
			sum[ y < SIZE * 3 / 4 ? 2 : 3 ] += g;

		}

		return sum.map( ( v ) => v / ( SIZE * SIZE / 4 ) );

	};

	it.each( [ 'path', 'bidirectional', 'vcm' ] )( 'lights the floor under a map\'s white half, not under its black half, as two plain halves do, either way up, and a grey map as a dimmer light (%s)', async ( integrator ) => {

		app.settings.set( 'integrator', integrator );

		// Half white, big enough that packing it keeps a sharp edge: the left half (u < ½), or the rows of v ≥ ½.
		const half = ( white ) => {

			const map = new DataTexture( Uint8Array.from( { length: 64 * 64 * 4 }, ( _, i ) => ( i % 4 === 3 || white( ( i >> 2 ) % 64, ( i >> 2 ) >> 6 ) ? 255 : 0 ) ), 64, 64 );
			map.colorSpace = SRGBColorSpace;
			map.magFilter = map.minFilter = NearestFilter;
			map.needsUpdate = true;
			return map;

		};

		const left = await regions( scene( [[ 2, 2, 0, 0, 0xffffff, half( ( x ) => x < 32 ) ]] ) );
		const leftTruth = await regions( scene( [[ 1, 2, - 0.5, 0, 0xffffff ], [ 1, 2, 0.5, 0, 0x000000 ]] ) );
		expect( left[ 0 ] ).toBeGreaterThan( left[ 1 ] * 1.5 );
		left.forEach( ( v, i ) => expect( Math.abs( v / leftTruth[ i ] - 1 ) ).toBeLessThan( 0.03 ) );

		// v runs towards +z, the camera's side: lit as the near plain half lights the floor, not the far one.
		const near = await regions( scene( [[ 2, 2, 0, 0, 0xffffff, half( ( x, y ) => y >= 32 ) ]] ) );
		const nearTruth = await regions( scene( [[ 2, 1, 0, 0.5, 0xffffff ], [ 2, 1, 0, - 0.5, 0x000000 ]] ) );
		const farTruth = await regions( scene( [[ 2, 1, 0, - 0.5, 0xffffff ], [ 2, 1, 0, 0.5, 0x000000 ]] ) );
		near.forEach( ( v, i ) => expect( Math.abs( v / nearTruth[ i ] - 1 ) ).toBeLessThan( 0.03 ) );
		near.forEach( ( v, i ) => expect( v ).toBeGreaterThan( farTruth[ i ] * 2 ) );

		// A grey map, a quarter of white: each strategy's weight goes by the flat emission it was drawn by.
		const grey = new DataTexture( new Uint8Array( 64 * 64 * 4 ).fill( 137 ).map( ( v, i ) => ( i % 4 === 3 ? 255 : v ) ), 64, 64 );
		grey.colorSpace = SRGBColorSpace;
		grey.needsUpdate = true;
		const dim = await regions( scene( [[ 2, 2, 0, 0, 0xffffff, grey ]] ) );
		const quarter = await regions( scene( [[ 2, 2, 0, 0, 0x898989 ]] ) );
		dim.forEach( ( v, i ) => expect( Math.abs( v / quarter[ i ] - 1 ) ).toBeLessThan( 0.03 ) );

	}, 120000 );

	it( 'reads the map from the flat list of emitters too, where there is no light tree', async () => {

		app.settings.set( 'integrator', 'path' );
		const map = new DataTexture( Uint8Array.from( { length: 64 * 64 * 4 }, ( _, i ) => ( i % 4 === 3 || ( i >> 2 ) % 64 < 32 ? 255 : 0 ) ), 64, 64 );
		map.colorSpace = SRGBColorSpace;
		map.magFilter = map.minFilter = NearestFilter;
		map.needsUpdate = true;
		const left = await regions( scene( [[ 2, 2, 0, 0, 0xffffff, map ]] ), { flatList: true } );
		const truth = await regions( scene( [[ 1, 2, - 0.5, 0, 0xffffff ], [ 1, 2, 0.5, 0, 0x000000 ]] ), { flatList: true } );
		expect( left[ 0 ] ).toBeGreaterThan( left[ 1 ] * 1.5 );
		left.forEach( ( v, i ) => expect( Math.abs( v / truth[ i ] - 1 ) ).toBeLessThan( 0.03 ) );

	}, 120000 );

} );
