/**
 * pbrt-v4 scenes rendered by a local pbrt-v4 build and by the engine in plain Node on Dawn, compared region by region:
 * how far the engine is from pbrt on each scene the corpus lists (scenes.json), not a pass/fail gate.
 *
 *   RAYZEE_PBRT=~/pbrt-v4/build/pbrt npm run bench:pbrt [-- --only a,b] [--size 256] [--spp 256] [--clamp] [--heavy]
 *     [--scenes list.json]   (another list of the same shape: materials.json is scenes/, one material, medium or film setting each)
 *
 * Scenes are found under RAYZEE_BENCH_MODELS (as bench:load) and app/public/models; a zip is unpacked once into the
 * system's temporary folder. Both renderers draw the scene's own camera at `size` on its longer side: pbrt from a copy
 * of the entry file with its Film resized (references kept in bench/results/pbrt, keyed by the file, the size, the
 * samples and the pbrt binary), the engine through captureHeadless with `sceneRequest` (the file's integrator, depth,
 * exposure, white balance and filter). The engine's firefly clamp is off unless `--clamp`: pbrt has none. Reports, per
 * scene, the engine's mean over pbrt's per channel, a 3 × 3 grid of luminance ratios, and FLIP; writes each pair as one
 * PNG beside report.json.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openAsBlob } from 'node:fs';

register( '../node/resolve.js', import.meta.url );

const here = path.dirname( fileURLToPath( import.meta.url ) );
const repo = path.resolve( here, '..', '..' );
const results = path.join( repo, 'bench', 'results', 'pbrt' );
const DIM = '\x1b[2m', RESET = '\x1b[0m', YELLOW = '\x1b[33m';

const arg = ( name, fallback ) => {

	const at = process.argv.indexOf( `--${name}` );
	return at > 0 ? process.argv[ at + 1 ] : fallback;

};

const only = arg( 'only', null )?.split( ',' ) ?? null;
const size = Number( arg( 'size', 256 ) );
const spp = Number( arg( 'spp', 256 ) );
const clamp = process.argv.includes( '--clamp' );
const heavy = process.argv.includes( '--heavy' );
const pbrt = process.env.RAYZEE_PBRT;
if ( ! pbrt ) {

	console.log( 'bench:pbrt: set RAYZEE_PBRT to a pbrt-v4 executable (the references are its renders)' );
	process.exit( 0 );

}

const { scenes } = JSON.parse( await fs.readFile( path.resolve( arg( 'scenes', path.join( here, 'scenes.json' ) ) ), 'utf8' ) );
const roots = [ ...( process.env.RAYZEE_BENCH_MODELS ?? '' ).split( path.delimiter ).filter( Boolean ), path.join( repo, 'app', 'public', 'models' ), path.join( here, 'scenes' ) ];

const { create, globals } = await import( 'webgpu' );
Object.assign( globalThis, globals );
// Dawn crashes the process if this is collected while a device lives.
const gpu = create( [] );
Object.defineProperty( globalThis.navigator, 'gpu', { value: gpu, configurable: true } );
const { configurePlatform, openHeadless, captureHeadless, compareImages } = await import( 'rayzee' );
const { nodePlatform } = await import( 'rayzee/node' );
const sharp = ( await import( 'sharp' ) ).default;
const { whiteBalanceMatrix } = await import( '../../rayzee/src/color/WhiteBalance.js' );
configurePlatform( nodePlatform() );
configurePlatform( { decodeImage: async ( bytes ) => {

	const { data, info } = await sharp( bytes ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	return { data: new Uint8Array( data.buffer, data.byteOffset, data.length ), width: info.width, height: info.height };

} } );

await fs.mkdir( results, { recursive: true } );
const exists = ( p ) => fs.access( p ).then( () => true, () => false );

async function locate( rel ) {

	for ( const root of roots ) if ( await exists( path.join( root, rel ) ) ) return path.join( root, rel );
	return null;

}

// A zip unpacked once (by its size and time), a folder used where it is. macOS empties temp folders of files older
// than 3 days (dirhelper), and unzip gives files the zip's dates: they are unpacked dated now (-DD), and the marker
// holds their count, so a folder emptied since is unpacked again.
async function unpacked( source ) {

	if ( ! source.endsWith( '.zip' ) ) return source;
	const stat = await fs.stat( source );
	const dir = path.join( os.tmpdir(), 'rayzee-bench-pbrt', `${path.basename( source, '.zip' )}-${stat.size}-${Math.round( stat.mtimeMs )}` );
	const marker = path.join( dir, '.complete' );
	const count = Number( await fs.readFile( marker, 'utf8' ).catch( () => '' ) );
	if ( ! ( count > 0 ) || ( await walk( dir ) ).length !== count ) {

		await fs.rm( dir, { recursive: true, force: true } );
		await fs.mkdir( dir, { recursive: true } );
		execFileSync( 'unzip', [ '-q', '-o', '-DD', source, '-d', dir ] );
		await fs.writeFile( marker, String( ( await walk( dir ) ).length ) );

	}

	return dir;

}

async function walk( dir, rel = '' ) {

	const out = [];
	for ( const entry of await fs.readdir( dir, { withFileTypes: true } ) ) {

		if ( entry.name.startsWith( '.' ) || entry.name === '__MACOSX' ) continue;
		if ( entry.isDirectory() ) out.push( ...await walk( path.join( dir, entry.name ), rel + entry.name + '/' ) );
		else out.push( rel + entry.name );

	}

	return out;

}

// The entry's Film at `size` on its longer side; null where the entry declares none.
function resized( text ) {

	const film = /Film\s+"[^"]*"[^]*?(?=\n\s*[A-Z][A-Za-z]+\s|$)/.exec( text );
	if ( ! film ) return null;
	const read = ( key, fallback ) => Number( new RegExp( `"integer ${key}"\\s*\\[?\\s*(\\d+)` ).exec( film[ 0 ] )?.[ 1 ] ?? fallback );
	const w = read( 'xresolution', 1280 ), h = read( 'yresolution', 720 );
	const s = size / Math.max( w, h );
	const width = Math.max( 1, Math.round( w * s ) ), height = Math.max( 1, Math.round( h * s ) );
	let block = film[ 0 ].replace( /"integer xresolution"\s*\[?\s*\d+\s*\]?/, '' ).replace( /"integer yresolution"\s*\[?\s*\d+\s*\]?/, '' );
	// A gbuffer film writes EXR only; its colour is an rgb film's, which writes the PFM read here.
	block = block.replace( /Film\s+"gbuffer"/, 'Film "rgb"' ).replace( /(Film\s+"[^"]*")/, `$1 "integer xresolution" ${width} "integer yresolution" ${height}` );
	return { text: text.slice( 0, film.index ) + block + text.slice( film.index + film[ 0 ].length ), width, height };

}

function readPFM( bytes ) {

	let at = 0;
	const line = () => {

		const end = bytes.indexOf( 10, at );
		const text = bytes.toString( 'latin1', at, end );
		at = end + 1;
		return text;

	};

	const kind = line();
	const [ width, height ] = line().trim().split( /\s+/ ).map( Number );
	const little = Number( line() ) < 0;
	const channels = kind === 'PF' ? 3 : 1;
	const data = new Float32Array( width * height * 4 );
	for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

		for ( let c = 0; c < 3; c ++ ) {

			const o = at + ( ( ( height - 1 - y ) * width + x ) * channels + ( channels === 3 ? c : 0 ) ) * 4;
			data[ ( y * width + x ) * 4 + c ] = little ? bytes.readFloatLE( o ) : bytes.readFloatBE( o );

		}

		data[ ( y * width + x ) * 4 + 3 ] = 1;

	}

	return { width, height, data };

}

async function reference( dir, entry, film ) {

	const binary = await fs.stat( pbrt );
	const key = createHash( 'sha1' ).update( `${film.text}|${spp}|${binary.size}|${binary.mtimeMs}` ).digest( 'hex' ).slice( 0, 12 );
	const out = path.join( results, `ref-${key}.pfm` );
	if ( ! await exists( out ) ) {

		const copy = path.join( dir, path.dirname( entry ), `.bench-${path.basename( entry )}` );
		await fs.writeFile( copy, film.text );
		try {

			execFileSync( pbrt, [ '--quiet', '--spp', String( spp ), '--outfile', out, path.basename( copy ) ], { cwd: path.dirname( copy ), stdio: [ 'ignore', 'ignore', 'pipe' ] } );

		} finally {

			await fs.rm( copy, { force: true } );

		}

	}

	return readPFM( await fs.readFile( out ) );

}

async function engine( dir, entry, film, settings ) {

	// Only the chosen scene file of a folder holding several (one a camera): the others are left out.
	const files = [];
	for ( const rel of await walk( dir ) ) {

		if ( rel !== entry && rel.endsWith( '.pbrt' ) && /\bWorldBegin\b/.test( await fs.readFile( path.join( dir, rel ), 'latin1' ) ) ) continue;
		// The entry as pbrt reads it: its Film resized.
		const blob = rel === entry ? new Blob( [ film.text ] ) : await openAsBlob( path.join( dir, rel ) );
		files.push( { path: rel, file: new File( [ blob ], path.basename( rel ) ) } );

	}

	const app = await openHeadless( { width: film.width, height: film.height, strict: false } );
	try {

		const started = performance.now();
		await app.loadFile( { name: path.basename( dir ), files } );
		const image = await captureHeadless( app, { samples: spp, sceneRequest: true, colorSpace: 'linear', settings: { ...( clamp ? {} : { fireflyThreshold: 1e9 } ), ...settings } } );
		// The readback is the accumulation; pbrt's film also holds its imaging ratio (shutter × ISO / 100) and white balance.
		filmResponse( image.data, app.settings.get( 'exposure' ), whiteBalanceMatrix( app.settings.get( 'whiteBalance' ), null ) );
		return { image, seconds: ( performance.now() - started ) / 1000, issues: app.issues.map( ( i ) => i.code ) };

	} finally {

		app.dispose();

	}

}

function filmResponse( data, exposure = 1, m = null ) {

	for ( let i = 0; i < data.length; i += 4 ) {

		const r = data[ i ], g = data[ i + 1 ], b = data[ i + 2 ];
		data[ i ] = ( m ? m[ 0 ] * r + m[ 1 ] * g + m[ 2 ] * b : r ) * exposure;
		data[ i + 1 ] = ( m ? m[ 3 ] * r + m[ 4 ] * g + m[ 5 ] * b : g ) * exposure;
		data[ i + 2 ] = ( m ? m[ 6 ] * r + m[ 7 ] * g + m[ 8 ] * b : b ) * exposure;

	}

}

const luminance = ( d, i ) => 0.2126 * d[ i ] + 0.7152 * d[ i + 1 ] + 0.0722 * d[ i + 2 ];

function regions( ours, ref ) {

	const { width, height } = ref;
	const grid = [];
	for ( let gy = 0; gy < 3; gy ++ ) for ( let gx = 0; gx < 3; gx ++ ) {

		let a = 0, b = 0;
		for ( let y = Math.floor( gy * height / 3 ); y < Math.floor( ( gy + 1 ) * height / 3 ); y ++ ) for ( let x = Math.floor( gx * width / 3 ); x < Math.floor( ( gx + 1 ) * width / 3 ); x ++ ) {

			a += luminance( ours.data, ( y * width + x ) * 4 );
			b += luminance( ref.data, ( y * width + x ) * 4 );

		}

		grid.push( b > 0 ? a / b : NaN );

	}

	const mean = [ 0, 1, 2 ].map( ( c ) => {

		let a = 0, b = 0;
		for ( let i = c; i < ours.data.length; i += 4 ) {

			a += ours.data[ i ];
			b += ref.data[ i ];

		}

		return b > 0 ? a / b : NaN;

	} );

	return { mean, grid };

}

async function sideBySide( ours, ref, file ) {

	const { width, height } = ref;
	const px = Buffer.alloc( width * 2 * height * 3 );
	const put = ( d, x0 ) => {

		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) for ( let c = 0; c < 3; c ++ ) {

			const v = Math.max( 0, d[ ( y * width + x ) * 4 + c ] );
			px[ ( y * width * 2 + x0 + x ) * 3 + c ] = Math.round( 255 * Math.pow( v / ( 1 + v ), 1 / 2.2 ) );

		}

	};

	put( ours.data, 0 );
	put( ref.data, width );
	await sharp( px, { raw: { width: width * 2, height, channels: 3 } } ).png().toFile( file );

}

const report = [];
const ratio = ( v ) => ( Number.isFinite( v ) ? v.toFixed( 3 ) : '  -  ' );
for ( const scene of scenes ) {

	if ( only && ! only.includes( scene.id ) ) continue;
	if ( scene.heavy && ! heavy && ! only ) {

		console.log( `${DIM}  skip ${scene.id} (heavy: --heavy or --only ${scene.id})${RESET}` );
		continue;

	}

	const source = await locate( scene.path );
	if ( ! source ) {

		console.log( `${DIM}  skip ${scene.id}: ${scene.path} not under ${roots.join( ', ' )}${RESET}` );
		continue;

	}

	const dir = await unpacked( source );
	const entry = scene.entry;
	const film = resized( await fs.readFile( path.join( dir, entry ), 'utf8' ) );
	if ( ! film ) {

		console.log( `${YELLOW}  skip ${scene.id}: ${entry} declares no Film${RESET}` );
		continue;

	}

	try {

		const ref = await reference( dir, entry, film );
		const { image, seconds, issues } = await engine( dir, entry, film, scene.settings ?? {} );
		const ours = { width: image.width, height: image.height, data: image.data };
		if ( ours.width !== ref.width || ours.height !== ref.height ) throw new Error( `the engine rendered ${ours.width}×${ours.height}, pbrt ${ref.width}×${ref.height}` );
		const { mean, grid } = regions( ours, ref );
		const flip = compareImages( ours, ref, { flip: true } ).flip;
		await sideBySide( ours, ref, path.join( results, `${scene.id}.png` ) );
		report.push( { id: scene.id, size: [ ref.width, ref.height ], spp, mean, grid, flip: flip?.mean ?? null, seconds, issues } );
		console.log( `  ${scene.id.padEnd( 22 )} mean ${mean.map( ratio ).join( ' ' )}  FLIP ${( flip?.mean ?? NaN ).toFixed( 3 )}  ${DIM}(${seconds.toFixed( 1 )} s, engine ÷ pbrt)${RESET}` );
		for ( let r = 0; r < 3; r ++ ) console.log( `${DIM}      ${grid.slice( r * 3, r * 3 + 3 ).map( ratio ).join( '  ' )}${RESET}` );

	} catch ( error ) {

		// A failed pbrt says why on stderr (execFileSync keeps it on the error): its last lines.
		const why = error.stderr?.toString().trim().split( '\n' ).slice( - 3 ).join( ' · ' );
		console.log( `${YELLOW}  ${scene.id}: ${error.message.split( '\n' )[ 0 ]}${why ? `\n    ${why}` : ''}${RESET}` );
		report.push( { id: scene.id, error: why || error.message } );

	}

}

await fs.writeFile( path.join( results, 'report.json' ), JSON.stringify( { size, spp, clamp, scenes: report }, null, '\t' ) );
console.log( `${DIM}  ${report.length} scene(s); pictures (engine | pbrt) and report.json in ${path.relative( repo, results )}${RESET}` );
process.exit( 0 );
