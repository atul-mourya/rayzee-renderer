/**
 * OIDN's kernels on this GPU, called as the engine calls them: the default against the experimental subgroup-matrix
 * kernel (Dawn's unsafe APIs, this process only), median ms a denoise and the distance from the default in 8-bit levels.
 *
 *   npm run bench:oidn -- [--size 1920x1080] [--models fast,high] [--runs 15] [--weights <dir>]
 */

import { create, globals } from 'webgpu';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getAssetConfig } from '../../rayzee/src/AssetConfig.js';

const { values: args } = parseArgs( { options: {
	size: { type: 'string', default: '1920x1080' },
	models: { type: 'string', default: 'fast,high' },
	runs: { type: 'string', default: '15' },
	weights: { type: 'string' },
} } );

const MODELS = { fast: 'rt_hdr_alb_nrm_small', balance: 'rt_hdr_calb_cnrm', high: 'rt_hdr_calb_cnrm_large' };
const VARIANTS = {
	default: {},
	'subgroup-matrix f32': { kernel: 'subgroup-matrix' },
	'subgroup-matrix f16': { kernel: 'subgroup-matrix', subgroupMatrix: { accumulation: 'f16' } },
};

Object.assign( globalThis, globals );
// Held by navigator: Dawn crashes the process if this is collected while a device lives.
Object.defineProperty( globalThis.navigator, 'gpu', { value: create( [ 'enable-dawn-features=allow_unsafe_apis' ] ), configurable: true } );
const { initUNetFromBuffer } = await import( 'oidn-webgpu/dist/oidn.js' );

const adapter = await navigator.gpu.requestAdapter();
const info = adapter.info;
const matrix = adapter.features.has( 'chromium-experimental-subgroup-matrix' );
console.log( `${info.description || `${info.vendor} ${info.architecture}`} · subgroup matrix: ${matrix ? ( info.subgroupMatrixConfigs ?? [] ).map( ( c ) => `${c.componentType}→${c.resultComponentType} ${c.M}×${c.N}×${c.K}` ).join( ', ' ) || 'none listed' : 'not offered'}` );

const limits = {};
for ( const key of [ 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupStorageSize', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY' ] ) limits[ key ] = adapter.limits[ key ];
const device = await adapter.requestDevice( {
	requiredFeatures: [ 'shader-f16', 'subgroups', 'timestamp-query', 'chromium-experimental-subgroup-matrix' ].filter( ( f ) => adapter.features.has( f ) ),
	requiredLimits: limits,
} );
// dawn.node 0.6.1 leaves the device's subgroupMatrixConfigs empty; the library reads them there.
Object.defineProperty( device, 'adapterInfo', { value: info } );

// As OIDNDenoiser sizes it: the frame inside a 16 px border, sides a multiple of 16, one tile up to 1056².
const [ w, h ] = args.size.split( 'x' ).map( Number );
const align = ( n ) => Math.ceil( ( n + 32 ) / 16 ) * 16;
const W = align( w ), H = align( h );
const tile = W * H <= 1056 * 1056 ? Math.max( W, H ) : 1024;

// A noisy picture with clean guides: shapes under a light gradient, exponential noise and a few fireflies.
let seed = 1;
const random = () => ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;
const color = new Float32Array( W * H * 4 ), albedo = new Float32Array( W * H * 4 ), normal = new Float32Array( W * H * 4 );
for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

	const i = ( y * W + x ) * 4, u = x / W - 0.5, v = y / H - 0.5, d = Math.hypot( u, v ) / 0.3;
	const a = d < 1 ? 0.8 : ( ( ( x >> 5 ) + ( y >> 5 ) ) % 2 ? 0.7 : 0.2 );
	const nz = d < 1 ? Math.sqrt( 1 - d * d ) : 1;
	const light = d < 1 ? 0.2 + 0.8 * Math.max( 0, 0.5 * u / 0.3 + 0.8 * nz ) : 0.3 + 0.7 * ( v + 0.5 );
	for ( let c = 0; c < 3; c ++ ) {

		color[ i + c ] = a * light * 0.6 * - Math.log( 1 - random() ) * ( random() < 0.002 ? 20 : 1 );
		albedo[ i + c ] = a;

	}

	normal.set( [ d < 1 ? u / 0.6 + 0.5 : 0.5, d < 1 ? v / 0.6 + 0.5 : 0.5, nz * 0.5 + 0.5, 1 ], i );
	color[ i + 3 ] = albedo[ i + 3 ] = 1;

}

const upload = ( data ) => {

	const buffer = device.createBuffer( { size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC } );
	device.queue.writeBuffer( buffer, 0, data );
	return { data: buffer, width: W, height: H };

};
const images = { color: upload( color ), albedo: upload( albedo ), normal: upload( normal ) };

function denoise( unet, read ) {

	return new Promise( ( resolve, reject ) => unet.tileExecute( { ...images, scheduling: 'event-loop', error: reject, done: async ( out ) => {

		await device.queue.onSubmittedWorkDone();
		if ( ! read ) return resolve( null );
		const map = device.createBuffer( { size: out.data.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST } );
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer( out.data, 0, map, 0, out.data.size );
		device.queue.submit( [ encoder.finish() ] );
		await map.mapAsync( GPUMapMode.READ );
		const pixels = new Float32Array( map.getMappedRange().slice( 0 ) );
		map.unmap();
		map.destroy();
		resolve( pixels );

	} } ) );

}

const level = ( x ) => Math.round( 255 * ( Math.max( 0, x ) / ( 1 + Math.max( 0, x ) ) ) ** ( 1 / 2.2 ) );
function levels( a, b ) {

	let sum = 0, max = 0, n = 0;
	for ( let y = 16; y < 16 + h; y ++ ) for ( let x = 16; x < 16 + w; x ++ ) for ( let c = 0; c < 3; c ++ ) {

		const i = ( y * W + x ) * 4 + c, d = Math.abs( level( a[ i ] ) - level( b[ i ] ) );
		sum += d; max = Math.max( max, d ); n ++;

	}

	return { mean: sum / n, max };

}

const median = ( list ) => [ ...list ].sort( ( p, q ) => p - q )[ list.length >> 1 ];
const base = args.weights ? `file://${path.resolve( args.weights )}/` : getAssetConfig().oidnWeightsBaseUrl;
console.log( `${w}×${h} (${W}×${H} with the border, tile ${tile}), median of ${args.runs}\n` );

for ( const name of args.models.split( ',' ) ) {

	const url = `${base}${MODELS[ name ]}.tza`;
	const bytes = url.startsWith( 'file:' ) ? ( await readFile( new URL( url ) ) ).buffer : await ( await fetch( url ) ).arrayBuffer();
	let reference = null, defaultMs = null;

	for ( const [ variant, options ] of Object.entries( VARIANTS ) ) {

		if ( variant !== 'default' && ! matrix ) continue;
		const unet = await initUNetFromBuffer( bytes.slice( 0 ), { device }, { aux: true, hdr: true, maxTileSize: tile, dynamicTile: false, ...options } );
		const engaged = unet.getRuntimeInfo().kernel?.subgroupMatrix;
		const out = await denoise( unet, true );
		for ( let i = 0; i < 3; i ++ ) await denoise( unet );
		const times = [];
		for ( let i = 0; i < Number( args.runs ); i ++ ) {

			const t = performance.now();
			await denoise( unet );
			times.push( performance.now() - t );

		}

		unet.dispose();
		const ms = median( times );
		reference ??= out;
		defaultMs ??= ms;
		const diff = variant === 'default' ? '' : `, ${levels( out, reference ).mean.toFixed( 3 )} levels mean (max ${levels( out, reference ).max}) from the default`;
		const note = variant !== 'default' && ! engaged ? ' — did not engage, ran the default' : '';
		console.log( `  ${name.padEnd( 7 )} ${variant.padEnd( 20 )} ${ms.toFixed( 1 ).padStart( 7 )} ms${variant === 'default' ? '' : ` (${( ( ms / defaultMs - 1 ) * 100 ).toFixed( 1 )} %)`}${diff}${note}` );

	}

}

device.destroy();
process.exit( 0 );
