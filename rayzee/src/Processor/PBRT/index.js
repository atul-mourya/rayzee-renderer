/**
 * PBRT-v4 scene loader.
 *
 * Orchestrates: virtual filesystem (from a zip) → tokenize/parse the entry
 * .pbrt (following Include/Import) → build a THREE scene graph. Geometry,
 * image, and HDR decoding are injected by the host (AssetLoader owns the
 * three/examples loaders) so this module stays dependency-light.
 *
 * Usage (from AssetLoader):
 *   const { group, environment, warnings } = await loadPBRTScene({
 *     vfs, entryPath, plyParser, imageFromBytes, envFromBytes
 *   });
 *   scene.environment = environment?.texture ?? scene.environment;
 *   await loadObject3D(group);
 */

import { PBRTParser } from './PBRTParser.js';
import { PBRTSceneBuilder } from './PBRTSceneBuilder.js';

export { PBRTParser } from './PBRTParser.js';
export { PBRTSceneBuilder } from './PBRTSceneBuilder.js';
export { tokenize } from './PBRTTokenizer.js';

const decoder = new TextDecoder();

/** Normalize a path: forward slashes, collapse "./" and "../". */
function normalizePath( p ) {

	const parts = p.replace( /\\/g, '/' ).split( '/' );
	const out = [];
	for ( const part of parts ) {

		if ( part === '' || part === '.' ) continue;
		if ( part === '..' ) out.pop();
		else out.push( part );

	}

	return out.join( '/' );

}

/** Join a base directory with a relative path. */
function joinPath( dir, rel ) {

	if ( ! dir ) return normalizePath( rel );
	if ( rel.startsWith( '/' ) ) return normalizePath( rel );
	return normalizePath( `${dir}/${rel}` );

}

/**
 * Wraps the zip contents with tolerant, case-insensitive lookup that falls back
 * to a basename match — pbrt scenes are inconsistent about path roots.
 */
class VirtualFS {

	constructor( entries ) {

		// entries: { path: Uint8Array }. Held so a release can drop the caller's reference
		// too — nulling only our own copy frees nothing while the archive object is alive,
		// and that object is every byte of a 30 GB scene.
		this.entries = entries;
		this.records = [];
		this.byPath = new Map(); // normalized lowercase -> { key, norm, bytes }
		this.byBase = new Map(); // basename lowercase -> [ { key, norm, bytes } ] (insertion order)
		for ( const key in entries ) {

			const norm = normalizePath( key ).toLowerCase();
			const rec = { key, norm, bytes: entries[ key ] };
			this.records.push( rec );
			this.byPath.set( norm, rec );
			const base = norm.split( '/' ).pop();
			const bucket = this.byBase.get( base );
			if ( bucket ) bucket.push( rec );
			else this.byBase.set( base, [ rec ] );

		}

	}

	release( rec ) {

		rec.bytes = null;
		delete this.entries[ rec.key ];

	}

	/** Drop every .pbrt entry's bytes. Safe only once parsing is complete. */
	releaseScenes() {

		for ( const rec of this.records ) if ( rec.norm.endsWith( '.pbrt' ) ) this.release( rec );

	}

	findRecord( path ) {

		const norm = normalizePath( path ).toLowerCase();
		if ( this.byPath.has( norm ) ) return this.byPath.get( norm );

		// Resolve by basename (O(1)); among collisions only a path-suffix match will do.
		// The blind first-entry fallback is safe only when the name is unique: every Moana
		// element ships its own `objects.pbrt`, and `Include "isPalmRig/objects.pbrt"` joined
		// against isPalmRig/ makes a doubled path that matches no suffix — so loading several
		// elements together silently handed each one the FIRST element's instance templates,
		// and every placement that referenced a real template was then dropped.
		const bucket = this.byBase.get( norm.split( '/' ).pop() );
		if ( ! bucket ) return null;
		const suffixHit = bucket.find( rec => rec.norm.endsWith( '/' + norm ) );
		return suffixHit || ( bucket.length === 1 ? bucket[ 0 ] : null );

	}

	find( path ) {

		return this.findRecord( path )?.bytes ?? null;

	}

}

/** Byte offset of `needle` in `bytes` at or after `from`, or -1. */
function findBytes( bytes, needle, from = 0 ) {

	const first = needle[ 0 ];
	const last = bytes.length - needle.length;
	outer: for ( let i = from; i <= last; i ++ ) {

		if ( bytes[ i ] !== first ) continue;
		for ( let j = 1; j < needle.length; j ++ ) if ( bytes[ i + j ] !== needle[ j ] ) continue outer;
		return i;

	}

	return - 1;

}

const ASCII = s => Uint8Array.from( s, c => c.charCodeAt( 0 ) );
const WORLD_BEGIN = ASCII( 'WorldBegin' );
const INCLUDE_WORDS = [ ASCII( 'Include' ), ASCII( 'Import' ) ];

function startsLine( bytes, at ) {

	for ( let i = at - 1; i >= 0; i -- ) {

		const b = bytes[ i ];
		if ( b === 10 ) return true;
		if ( b !== 32 && b !== 9 ) return false;

	}

	return true;

}

/** True when the entry declares a world block, i.e. it is a scene and not a fragment. */
function hasWorldBegin( bytes ) {

	for ( let at = findBytes( bytes, WORLD_BEGIN ); at >= 0; at = findBytes( bytes, WORLD_BEGIN, at + 1 ) ) {

		if ( startsLine( bytes, at ) ) return true;

	}

	return false;

}

/** Basenames this entry pulls in via Include/Import, lowercased. */
function includedBasenames( bytes, out ) {

	for ( const word of INCLUDE_WORDS ) {

		for ( let at = findBytes( bytes, word ); at >= 0; at = findBytes( bytes, word, at + 1 ) ) {

			if ( ! startsLine( bytes, at ) ) continue;
			let i = at + word.length;
			while ( i < bytes.length && ( bytes[ i ] === 32 || bytes[ i ] === 9 ) ) i ++;
			if ( bytes[ i ] !== 34 ) continue;
			const start = ++ i;
			while ( i < bytes.length && bytes[ i ] !== 34 && bytes[ i ] !== 10 ) i ++;
			if ( bytes[ i ] !== 34 ) continue;
			const path = decoder.decode( bytes.subarray( start, i ) );
			out.add( normalizePath( path ).toLowerCase().split( '/' ).pop() );

		}

	}

}

/**
 * Rank every .pbrt in the archive that could be a top-level scene, best first.
 *
 * Name shape alone is not enough: a scene's `geometry.pbrt` fragment carries a shorter
 * name than the real entry and would win on sort, loading every shape with an unresolved
 * NamedMaterial and no camera or lights. Content decides first — a fragment has no
 * `WorldBegin` and is named by someone else's Include — and the name only breaks ties.
 *
 * More than one survivor is a real archive shape, not an error: transparent-machines
 * ships five independent frames side by side. Callers should say which one they took.
 */
export function listEntryPaths( entries ) {

	const pbrts = Object.keys( entries ).filter( k => k.toLowerCase().endsWith( '.pbrt' ) );
	if ( pbrts.length <= 1 ) return pbrts;

	// Scanned over bytes: a fragment can be gigabytes, past what a string would hold.
	const included = new Set();
	const worlds = new Map();
	for ( const k of pbrts ) {

		const bytes = entries[ k ];
		worlds.set( k, hasWorldBegin( bytes ) );
		includedBasenames( bytes, included );

	}

	const narrow = ( candidates, keep ) => {

		const kept = candidates.filter( keep );
		return kept.length ? kept : candidates;

	};

	let pool = narrow( pbrts, k => worlds.get( k ) );
	pool = narrow( pool, k => ! included.has( k.toLowerCase().split( '/' ).pop() ) );
	pool = narrow( pool, k => /(^|\/)(scene|main)\.pbrt$/i.test( k ) );

	// Shallowest, then shortest name, then the path itself — the last key keeps the
	// order independent of however the zip happened to enumerate its entries.
	return pool.sort( ( a, b ) => {

		const da = a.split( '/' ).length, db = b.split( '/' ).length;
		if ( da !== db ) return da - db;
		if ( a.length !== b.length ) return a.length - b.length;
		return a < b ? - 1 : a > b ? 1 : 0;

	} );

}

/** Best top-level .pbrt entry, or null when the archive has none. */
export function pickEntryPath( entries ) {

	return listEntryPaths( entries )[ 0 ] || null;

}

/**
 * @param {object} args
 * @param {Object<string,Uint8Array>} args.vfs - zip entries (path → bytes)
 * @param {string} [args.entryPath] - top .pbrt; auto-detected if omitted
 * @param {(buf:ArrayBuffer)=>import('three').BufferGeometry} args.plyParser
 * @param {(bytes:Uint8Array, filename:string)=>Promise<import('three').Texture>} args.imageFromBytes
 * @param {(bytes:Uint8Array, filename:string)=>Promise<import('three').Texture>} [args.envFromBytes]
 * @param {boolean} [args.convertHandedness=true]
 * @returns {Promise<{group, camera, environment, warnings, entryPath}>}
 */
export async function loadPBRTScene( args ) {

	const { vfs: rawEntries, plyParser, imageFromBytes, envFromBytes, convertHandedness } = args;
	const vfs = new VirtualFS( rawEntries );

	const entryPath = args.entryPath || pickEntryPath( rawEntries );
	if ( ! entryPath ) throw new Error( 'PBRT loader: no .pbrt file found in archive' );

	const entryBytes = vfs.find( entryPath );
	if ( ! entryBytes ) throw new Error( `PBRT loader: entry "${entryPath}" not readable` );

	const baseDir = entryPath.includes( '/' ) ? entryPath.slice( 0, entryPath.lastIndexOf( '/' ) ) : '';

	// Parse (with Include resolution). Bytes go straight to the lexer — a scene file can
	// be larger than the longest string JavaScript will build.
	const parser = new PBRTParser( {
		resolveInclude: ( path, currentDir ) => vfs.find( joinPath( currentDir, path ) ) || vfs.find( path ),
		maxPlacements: args.maxPlacements
	} );

	const parseStart = performance.now();
	const ir = parser.parse( entryBytes, baseDir );
	const parseMs = performance.now() - parseStart;

	// Scene text is dead once parsed, and it is the bulk of a big element — isIronwoodA1 is
	// 6.9 GB of it. Freeing before the builder runs halves peak while geometry is allocated.
	// Only after the whole parse: a file can be Included more than once (isHibiscusYoung
	// pulls its xgBonsai scatter in six times, once per placement of the plant).
	vfs.releaseScenes();

	// Build scene graph
	const sliceBuf = ( bytes ) => (
		bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? bytes.buffer
			: bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength )
	);

	// Cached against the RESOLVED entry, not the spelling used, so a file is decoded once and
	// its source bytes can go — isCoral's 8,596 .ply files are 2.3 GB of the load.
	const plyCache = new Map();
	const decodePly = ( rec ) => {

		const bytes = rec.bytes;
		if ( ! bytes ) return null;
		vfs.release( rec );
		return plyParser( sliceBuf( bytes ) );

	};

	const builder = new PBRTSceneBuilder( {
		convertHandedness,
		maxTriangles: args.maxTriangles,
		maxPlacements: args.maxPlacements,
		mergeShapesAbove: args.mergeShapesAbove,
		curveSteps: args.curveSteps,
		curveSides: args.curveSides,
		resolvePLY: async ( filename ) => {

			const rec = vfs.findRecord( filename );
			if ( ! rec ) return null;
			if ( ! plyCache.has( rec.norm ) ) plyCache.set( rec.norm, decodePly( rec ) );
			return plyCache.get( rec.norm );

		},
		resolveImage: async ( filename ) => {

			const bytes = vfs.find( filename );
			if ( ! bytes ) return null;
			return imageFromBytes( bytes, filename );

		},
		resolveEnvironment: async ( filename ) => {

			const bytes = vfs.find( filename );
			if ( ! bytes ) return null;
			return ( envFromBytes || imageFromBytes )( bytes, filename );

		}
	} );

	const buildStart = performance.now();
	const result = await builder.build( ir );
	return { ...result, entryPath, parseMs, buildMs: performance.now() - buildStart };

}
