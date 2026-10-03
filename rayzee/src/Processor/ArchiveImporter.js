/**
 * Scene archives (.zip, .tar, .tar.gz) and the pbrt scenes in them — `rayzee/addons/archives`. The asset loader reads
 * single files itself; an archive needs this importer installed on it (PathTracerApp installs it):
 *
 * @example
 * import { ArchiveImporter } from 'rayzee/addons/archives';
 * renderer.assetLoader.setArchiveImporter( new ArchiveImporter( renderer.assetLoader ) );
 */

import { FloatType, EquirectangularReflectionMapping, Texture, SRGBColorSpace, RepeatWrapping, LoadingManager } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { zipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import {
	detectArchiveKind, readTarGz, elementFilter, listArchiveElements, openTar, indexTarHeaders } from './ArchiveReader.js';
import { openZip, readZipDirectory } from './ZipReader.js';
import { unpackTarGz, loadTarIndex, saveTarIndex } from './ArchiveCache.js';
import { setEnvironmentSource } from '../Storage/CDFCache.js';
import { fileIdentity, identityKey, sampleHash } from '../Storage/identity.js';
import { ENGINE_AREAS } from '../Storage/StorageManager.js';
import { encodeSceneGraph, writeSceneGraph, decodeSceneGraph, SceneGraphUnsupported, SCENE_GRAPH_FORMAT, ARCHIVE_PATH, ARCHIVE_LOADER } from '../Storage/SceneGraphCodec.js';
import { worthStoring } from '../Storage/sceneCachePolicy.js';
import { VERSION } from '../version.js';
import { updateLoading } from './utils';
import { loadPBRTScene, pickEntryPath, VirtualFS, PBRT_BUILD_REVISION } from './PBRT/index.js';
import { pfmTexture } from './PBRT/PFM.js';
import { extractSceneMetadata } from './SceneMetadata.js';
import { ISSUE_CODES, ISSUE_SEVERITY } from '../EngineIssues.js';
import { SUPPORTED_FORMATS as MODEL_FORMATS } from './AssetLoader.js';

// Loose USD layers inside a ZIP compose into one scene; these pick out the
// layers and the image assets they reference.
const USD_LAYER_RE = /\.(usd|usda|usdc)$/i;
const USD_IMAGE_RE = /\.(png|jpg|jpeg|avif)$/i;
const MTL_TEXTURE_TIMEOUT_MS = 30000;
/**
 * Unpacked size past which a multi-part scene archive asks which parts to load rather than
 * taking all of them. Not a hard limit — picking every part is a valid answer.
 *
 * Measured on Moana: a 7.5 GB archive of 15 parts parses to 40M triangles and ~7.3 GB of CPU
 * memory, which loads on a freshly started browser and fails on one that has been up a while.
 * Anything near that is worth a question, because the failure past it kills the tab rather than
 * throwing. Override per load with `promptBytes`.
 */
export const ARCHIVE_ELEMENT_PROMPT_BYTES = 4_000_000_000;

export class ArchiveImporter {

	/** The archive formats it adds to the loader's. */
	static FORMATS = {
		'zip': { type: 'archive', name: 'ZIP Archive' },
		'gz': { type: 'archive', name: 'Gzipped TAR Archive' },
		'tgz': { type: 'archive', name: 'Gzipped TAR Archive' },
		'tar': { type: 'archive', name: 'TAR Archive' },
	};

	/** @param {import('./AssetLoader.js').AssetLoader} loader - the loader it reads archives for */
	constructor( loader ) {

		this.loader = loader;
		this._pendingGraph = null;
		this.lastPBRTStats = null;

	}

	/** Drops a parsed scene still waiting to be stored: the model it was for is gone. */
	release() {

		this._pendingGraph = null;

	}

	/** First bytes of a file, without pulling the whole thing into memory. */
	async _readHead( file, bytes = 512 ) {

		if ( file instanceof Uint8Array ) return file.subarray( 0, bytes );
		if ( typeof file.slice === 'function' && typeof file.arrayBuffer === 'function' ) {

			return new Uint8Array( await file.slice( 0, bytes ).arrayBuffer() );

		}

		return new Uint8Array( ( await this.loader.readFileAsArrayBuffer( file ) ).slice( 0, bytes ) );

	}

	/**
	 * Enumerates a TAR/TAR.GZ archive without keeping any of it, so a caller can offer a
	 * choice before committing memory. ZIP archives are random-access and report directly.
	 * @returns {Promise<{kind:string, root:string|null, elements:Array, entryCount:number, totalBytes:number}>}
	 */
	async inspectArchive( file ) {

		const kind = detectArchiveKind( await this._readHead( file ) );
		const scanning = p => updateLoading( {
			isLoading: true, status: `Scanning archive… ${( p.bytes / 1e9 ).toFixed( 1 )} GB`, progress: 4
		} );

		let listing;
		if ( kind === 'gzip' ) {

			const unpacked = await this._unpackGzip( file, file.name );
			if ( unpacked ) {

				listing = unpacked.index.listing;
				unpacked.release();

			} else {

				( { listing } = await readTarGz( file, { filter: () => false, onProgress: scanning } ) );

			}

		} else if ( kind === 'tar' ) {

			listing = ( await loadTarIndex( file, this.loader.storage ) )?.listing ?? await indexTarHeaders( file, { onProgress: scanning } );

		} else {

			listing = ( await readZipDirectory( file ) ).map( e => ( { path: e.name, size: e.size } ) );

		}

		const { root, elements } = listArchiveElements( listing );
		return {
			kind: kind ?? 'zip', root, elements,
			entryCount: listing.length,
			totalBytes: listing.reduce( ( n, e ) => n + e.size, 0 )
		};

	}

	/**
	 * A .tar.gz unpacked to storage, or null to read it the old way (no storage, or no room).
	 * @private
	 */
	async _unpackGzip( file, filename ) {

		try {

			return await unpackTarGz( file, {
				storage: this.loader.storage,
				label: filename,
				onProgress: bytes => updateLoading( {
					isLoading: true, status: `Unpacking archive… ${( bytes / 1e9 ).toFixed( 1 )} GB`, progress: 4
				} ),
			} );

		} catch ( error ) {

			// A corrupt stream fails the same way in memory, where the error reads better.
			console.warn( `Unpacking "${filename}" to storage failed, reading it in memory: ${error.message}` );
			return null;

		}

	}

	/**
	 * @param {File|Blob} file
	 * @param {string} filename
	 * @param {object} [options]
	 * @param {string} [options.pbrtEntry] - which .pbrt to load when the archive holds several
	 *   independent scenes; the issue log lists what else was available.
	 * @param {string|string[]} [options.element] - path prefix of one subtree to load on its own,
	 *   or several to load together, as reported by `inspectArchive()`. Everything above them
	 *   (scene file, materials, textures) comes along; subtrees left out are skipped without ever
	 *   being held in memory, and the Includes that point at them only warn.
	 * @param {number} [options.byteBudget] - cap on retained bytes when no element is chosen.
	 * @param {number} [options.promptBytes] - size past which a multi-part archive asks which
	 *   parts to load instead of taking all of them.
	 * @param {number} [options.maxTriangles] - stop past this many STORED triangles.
	 * @param {number} [options.maxPlacements] - stop past this many instance placements.
	 * @param {number} [options.mergeShapesAbove] - merge small non-instanced shapes past this count.
	 * @param {number} [options.curveSteps] - samples per spline span when tessellating curves.
	 * @param {number} [options.curveSides] - 1 ribbon, 2 crossed ribbons, >=3 closed tube.
	 * @param {number} [options.curveTolerance] - how far a curve strip may stray from the curve, as a
	 *   fraction of its half-width (default 0.05); 0 samples every span `curveSteps` times.
	 * @param {boolean} [options.instanceIncludes] - place a file included again under the same
	 *   material as another instance of its first reading (default true).
	 */
	async loadArchiveFromFile( file, filename, { pbrtEntry = null, element = null, byteBudget, promptBytes, ...pbrt } = {} ) {

		try {

			const kind = detectArchiveKind( await this._readHead( file ) );
			const archiveId = this.loader.storage ? identityKey( await fileIdentity( file ) ) : null;
			const lazy = { element, promptBytes, pbrtEntry, pbrt, archiveId };

			// A seekable archive is indexed rather than read: entries are pulled out as the scene
			// asks for them and never all held at once. That is the difference between a 7 GB archive
			// being refused and loading. A .tar.gz becomes seekable by unpacking it to storage.
			if ( kind === 'tar' ) return await this._loadSeekable( file, filename, lazy );

			if ( kind === 'gzip' ) {

				const unpacked = await this._unpackGzip( file, filename );
				if ( unpacked ) {

					try {

						return await this._loadSeekable( unpacked.file, filename, { ...lazy, index: unpacked.index } );

					} finally {

						unpacked.release();

					}

				}

				const entries = await this._readStreamedArchive( file, filename, kind, element, byteBudget );

				// A pbrt scene archive takes priority — it owns its own geometry/texture refs.
				if ( pickEntryPath( entries ) ) return await this.loadPBRTFromZip( entries, filename, pbrtEntry, pbrt );
				const result = await this._loadNonPBRTArchive( entries, filename );
				this.loader._sourceKey = this.loader._keyed( 'archive', archiveId );
				return result;

			}

			return await this._loadSeekable( file, filename, { ...lazy, zip: true } );

		} catch ( error ) {

			if ( error?.code !== 'ARCHIVE_NEEDS_ELEMENT' ) console.error( 'Error loading archive:', error );
			throw error;

		}

	}

	async _loadNonPBRTArchive( entries, filename ) {

		const result = await this.processObjMtlPairsInZip( entries, filename );
		if ( result ) return result;
		return await this.findAndLoadModelFromZip( entries, filename );

	}

	/**
	 * Loads a seekable archive — a .tar (or a .tar.gz unpacked to one) or a .zip — reading each
	 * entry only when the scene asks for it.
	 * @private
	 */
	async _loadSeekable( file, filename, { element, promptBytes, pbrtEntry, pbrt, index = null, zip = false, archiveId = null } ) {

		const source = await this._openSeekableArchive( file, filename, element, promptBytes, { index, zip } );
		source.archiveId = archiveId;
		source.elements = ( Array.isArray( element ) ? element : [ element ] ).filter( Boolean );
		if ( source.listing.some( e => e.path.toLowerCase().endsWith( '.pbrt' ) ) ) {

			return await this.loadPBRTFromZip( {}, filename, pbrtEntry, pbrt, source );

		}

		// Not a pbrt scene: fall back to materialising it, which those paths still expect.
		for ( const e of source.listing ) if ( e.offset !== undefined ) source.entries[ e.path ] ??= await source.read( e.path );
		const result = await this._loadNonPBRTArchive( source.entries, filename );
		this.loader._sourceKey = this.loader._keyed( 'archive', archiveId );
		return result;

	}

	/**
	 * The parsed scene stored for this archive and these options, decoded — its textures read back
	 * out of the archive — or null.
	 * @private
	 */
	async _loadStoredGraph( key, source, { imageFromBytes, envFromBytes } ) {

		const area = this.loader.storage?.area( ENGINE_AREAS.SCENES );
		const entry = area ? await area.open( key ) : null;
		if ( ! entry ) return null;

		const start = performance.now();
		let failure = null;
		try {

			updateLoading( { isLoading: true, status: 'Opening the stored scene...', progress: 6 } );
			const manifest = await entry.json( 'graph.json' );
			const data = await entry.file( 'data.bin' );
			const vfs = new VirtualFS( {}, source );
			const decoded = await decodeSceneGraph( manifest, data, {
				loadTexture: async ( path, loader ) => {

					const bytes = await vfs.readPath( path );
					if ( ! bytes ) return null;
					return loader === 'environment' ? envFromBytes( bytes, path ) : imageFromBytes( bytes, path );

				},
			} );

			return {
				...decoded.stats,
				group: decoded.root,
				environment: decoded.environment ? { texture: decoded.environment } : null,
				animations: decoded.animations,
				report: null,
				parseMs: 0,
				buildMs: performance.now() - start,
				fromStorage: true,
			};

		} catch ( error ) {

			failure = error;
			return null;

		} finally {

			entry.release();
			if ( failure ) {

				console.warn( `The stored scene could not be used, parsing the archive instead: ${failure.message}` );
				this.loader._issues?.warn( ISSUE_CODES.STORAGE_ENTRY_CORRUPT, `stored scene unusable: ${failure.message}`, { key } );
				area.remove( key ).catch( () => {} );

			}

		}

	}

	/**
	 * Stores a freshly parsed scene for the next open. Encoded here, before onModelLoad or the
	 * build touch it; written in the background.
	 * @private
	 */
	_storeGraph( key, built, label ) {

		const area = this.loader.storage?.area( ENGINE_AREAS.SCENES );
		if ( ! area ) return;

		let encoded;
		try {

			encoded = encodeSceneGraph( built.group, {
				environment: built.environment?.texture ?? null,
				animations: built.animations ?? [],
				stats: {
					meshCount: built.meshCount, entryPath: built.entryPath, candidates: built.candidates, frames: built.frames,
					warnings: built.warnings, triangleCount: built.triangleCount, placementCount: built.placementCount,
					mergedShapes: built.mergedShapes, skippedForBudget: built.skippedForBudget, droppedNoTemplate: built.droppedNoTemplate,
				},
			} );

		} catch ( error ) {

			if ( error instanceof SceneGraphUnsupported ) console.info( `Scene not stored for next time: ${error.message}` );
			else console.warn( 'Scene not stored for next time:', error );
			return;

		}

		const pending = { key, encoded, label, parseMs: ( built.parseMs ?? 0 ) + ( built.buildMs ?? 0 ), triangles: built.triangleCount ?? null };

		// A parse slow enough on its own is written now, during the build. Held until the build
		// ends, it kept every array the build replaces alive with it — the float normals and the
		// instance matrices, ~1 GB on the whole Moana subset, at the build's peak.
		if ( worthStoring( pending.parseMs, encoded.byteLength ) ) this._writeGraph( area, pending );
		else this._pendingGraph = pending;

	}

	/**
	 * Writes the scene encoded at parse time once the build is done, when the whole cold load —
	 * parse plus build — was slow enough to be worth it (decision D6).
	 * @param {number} buildMs - the SceneProcessor build that followed the parse
	 */
	flushPendingGraph( buildMs ) {

		const pending = this._pendingGraph;
		this._pendingGraph = null;
		const area = this.loader.storage?.area( ENGINE_AREAS.SCENES );
		if ( ! pending || ! area || ! worthStoring( pending.parseMs + buildMs, pending.encoded.byteLength ) ) return;
		this._writeGraph( area, pending );

	}

	/** Writes an encoded graph in the background, letting each array go once it is on disk. @private */
	_writeGraph( area, pending ) {

		( async () => {

			const writer = await area.create( pending.key, { label: `${pending.label} (scene)`, expectedBytes: pending.encoded.byteLength } );
			if ( ! writer ) return;
			try {

				await writeSceneGraph( writer, pending.encoded, { release: true } );
				await writer.commit( { triangles: pending.triangles } );

			} catch ( error ) {

				await writer.abort();
				console.warn( 'Storing the scene failed:', error );

			}

		} )().catch( error => console.warn( 'Storing the scene failed:', error ) );

	}

	/**
	 * Index a seekable archive without retaining it. Entries are read back from the File on
	 * demand, so residency is the open include chain rather than the whole archive.
	 *
	 * Indexing is cheap and the whole archive is never held, but *parsing* all of it is not:
	 * the scene that comes out is what runs the tab out of memory. So a large multi-part archive
	 * stops here and asks which parts to load, the same as the streamed path does. The index is
	 * already built at that point, so the question costs nothing.
	 * @private
	 */
	async _openSeekableArchive( file, filename, element, promptBytes, { index = null, zip = false } = {} ) {

		const chosen = Array.isArray( element ) ? element.filter( Boolean ) : ( element ? [ element ] : [] );
		const filter = chosen.length ? elementFilter( chosen ) : null;

		let source;
		if ( zip ) {

			source = await openZip( file, { filter } );

		} else {

			const saved = index ?? await loadTarIndex( file, this.loader.storage );
			source = await openTar( file, {
				index: saved,
				headersOnly: true,
				filter,
				onProgress: p => updateLoading( {
					isLoading: true, status: `Indexing archive… ${( p.bytes / 1e9 ).toFixed( 1 )} GB`, progress: 4
				} ),
			} );
			if ( ! saved ) saveTarIndex( file, this.loader.storage, source.index ).catch( () => {} );

		}

		const totalBytes = source.listing.reduce( ( n, e ) => n + e.size, 0 );

		if ( chosen.length === 0 ) this._requireElementChoice( filename, source.listing, totalBytes, promptBytes );

		console.info(
			`Archive "${filename}": indexed ${source.indexed} entries, ` +
			`${( totalBytes / 1e9 ).toFixed( 1 )} GB, none resident` +
			( chosen.length ? `, ${chosen.length} part${chosen.length > 1 ? 's' : ''} selected.` : '.' )
		);

		return source;

	}

	/**
	 * Stop and ask which parts to load, when the archive is big enough that the answer matters
	 * and it actually has parts to choose between. Not a capability limit — selecting every part
	 * is a valid answer and loads the whole scene.
	 * @private
	 */
	_requireElementChoice( filename, listing, totalBytes, promptBytes = ARCHIVE_ELEMENT_PROMPT_BYTES ) {

		if ( totalBytes < promptBytes ) return;

		const { root, elements } = listArchiveElements( listing );
		if ( elements.length < 2 ) return;

		const error = new Error(
			`"${filename}" holds ${( totalBytes / 1e9 ).toFixed( 1 )} GB across ${elements.length} parts. ` +
			'Choose which to load — loading all of them at once may exhaust memory.'
		);
		error.code = 'ARCHIVE_NEEDS_ELEMENT';
		error.root = root;
		error.elements = elements;
		error.totalBytes = totalBytes;

		// Logged as a warning on purpose: recording an ERROR makes a strict host throw an
		// EngineIssueError from inside record(), and the caller never learns which parts it
		// could have chosen. The typed throw below is the refusal, and it carries the list.
		this.loader._issues?.record(
			ISSUE_CODES.ASSET_ARCHIVE_TOO_LARGE,
			`archive holds ${( totalBytes / 1e9 ).toFixed( 1 )} GB across ${elements.length} parts; choose which to load`,
			{ root, elements: elements.map( e => e.prefix ), totalBytes },
			ISSUE_SEVERITY.WARNING
		);

		throw error;

	}

	async _readStreamedArchive( file, filename, kind, element, byteBudget ) {

		const chosen = Array.isArray( element ) ? element.filter( Boolean ) : ( element ? [ element ] : [] );
		const { entries, listing, retainedBytes, truncated } = await readTarGz( file, {
			filter: chosen.length ? elementFilter( chosen ) : null,
			...( byteBudget === undefined ? {} : { byteBudget } ),
			onProgress: p => updateLoading( {
				isLoading: true,
				status: `Reading archive… ${( p.bytes / 1e9 ).toFixed( 1 )} GB`,
				progress: 4
			} )
		} );

		// Choosing every part is a valid answer, so a selection is not refused again for being
		// large: the read budget exists to stop an unasked-for whole-archive load. Past this
		// point the scene's own memory preflight is what refuses, with a figure to act on.
		if ( truncated && chosen.length === 0 ) {

			const { root, elements } = listArchiveElements( listing );
			const total = listing.reduce( ( n, e ) => n + e.size, 0 );
			const error = new Error(
				`"${filename}" unpacks to ${( total / 1e9 ).toFixed( 1 )} GB, past the load budget. ` +
				`Load one of its ${elements.length} parts instead.`
			);
			error.code = 'ARCHIVE_NEEDS_ELEMENT';
			error.root = root;
			error.elements = elements;
			error.totalBytes = total;
			// Warning, not error: a strict host's throw from record() would replace the typed
			// error below and take the part list with it.
			this.loader._issues?.record(
				ISSUE_CODES.ASSET_ARCHIVE_TOO_LARGE,
				`archive unpacks to ${( total / 1e9 ).toFixed( 1 )} GB; choose one of ${elements.length} parts`,
				{ root, elements: elements.map( e => e.prefix ), totalBytes: total },
				ISSUE_SEVERITY.WARNING
			);
			throw error;

		}

		if ( truncated ) {

			const keep = elementFilter( chosen );
			const missing = listing.filter( e => keep( e.path, e.size ) && ! entries[ e.path ] ).length;
			this.loader._issues?.record(
				ISSUE_CODES.ASSET_ARCHIVE_TOO_LARGE,
				`${missing} files of the chosen parts were left out: they did not fit the ${( ( byteBudget ?? 1.5e9 ) / 1e9 ).toFixed( 1 )} GB in-memory read budget`,
				{ elements: chosen, missing, retainedBytes },
				ISSUE_SEVERITY.WARNING
			);

		}

		if ( chosen.length ) {

			console.info(
				`Archive "${filename}": loaded ${chosen.map( c => `"${c}"` ).join( ', ' )} — ` +
				`${Object.keys( entries ).length} of ${listing.length} files, ${( retainedBytes / 1048576 ).toFixed( 1 )} MB.`
			);

		}

		return entries;

	}

	/**
	 * Loads a pbrt-v4 scene from an unzipped archive. Parses the entry .pbrt
	 * (following Include/Import), builds a THREE.Group, sets the infinite light
	 * as the scene environment, and runs the standard onModelLoad pipeline.
	 * @param {Object<string, Uint8Array>} zip - unzipped entries (path → bytes); consumed, entry by entry
	 * @param {string} filename - original archive name (for display/events)
	 */
	async loadPBRTFromZip( zip, filename, entryPath = null, options = {}, source = null ) {

		updateLoading( { isLoading: true, status: 'Parsing PBRT scene...', progress: 5 } );

		// Geometry decoder — reuse the cached PLYLoader (pbrt leans on .ply meshes).
		if ( ! this.loader.loaderCache.ply ) {

			const { PLYLoader } = await import( 'three/examples/jsm/loaders/PLYLoader.js' );
			this.loader.loaderCache.ply = new PLYLoader();

		}

		const plyParser = ( buf ) => this.loader.loaderCache.ply.parse( buf );

		// Texture maps — decode by extension (pbrt uses .png/.jpg but also .exr/.hdr/.tga). Tagged
		// with their archive path so a stored scene can read them back instead of keeping pixels.
		const imageFromBytes = async ( bytes, fname ) => {

			const texture = await this._pbrtTextureFromBytes( bytes, fname );
			if ( texture ) texture.userData[ ARCHIVE_PATH ] = fname;
			return texture;

		};

		// Infinite-light maps → HDR/EXR/LDR via the shared environment decoder.
		const envFromBytes = async ( bytes, fname ) => {

			const ext = fname.split( '.' ).pop().toLowerCase();
			const blob = new Blob( [ bytes ] );
			const url = ext === 'pfm' ? null : URL.createObjectURL( blob );
			try {

				const texture = url ? await this.loader.loadEnvironmentByExtension( url, ext ) : pfmTexture( bytes );
				texture.mapping = EquirectangularReflectionMapping;
				setEnvironmentSource( texture, `bytes:${await sampleHash( blob )}` );
				texture.userData[ ARCHIVE_PATH ] = fname;
				texture.userData[ ARCHIVE_LOADER ] = 'environment';
				return texture;

			} finally {

				if ( url ) URL.revokeObjectURL( url );

			}

		};

		const pbrtStart = performance.now();
		const shape = {
			animation: options.animation, maxTriangles: options.maxTriangles, maxPlacements: options.maxPlacements,
			mergeShapesAbove: options.mergeShapesAbove, curveSteps: options.curveSteps, curveSides: options.curveSides,
			curveTolerance: options.curveTolerance, instanceIncludes: options.instanceIncludes,
		};
		const graphKey = source?.archiveId
			? this.loader._keyed( `pbrt:${SCENE_GRAPH_FORMAT}.${PBRT_BUILD_REVISION}:${VERSION}`, `${source.archiveId}|${entryPath ?? ''}|${[ ...( source.elements ?? [] ) ].sort().join( ',' )}|${JSON.stringify( shape )}` )
			: null;

		const stored = graphKey ? await this._loadStoredGraph( graphKey, source, { imageFromBytes, envFromBytes } ) : null;
		const built = stored ?? await loadPBRTScene( { vfs: zip, source, entryPath, plyParser, imageFromBytes, envFromBytes, ...shape } );

		const { group, environment, animations, report, warnings, meshCount, entryPath: loadedEntry, candidates,
			frames, parseMs, buildMs, triangleCount, placementCount, mergedShapes, skippedForBudget,
			droppedNoTemplate } = built;
		if ( stored ) console.info( `PBRT scene "${loadedEntry}" opened from storage in ${( buildMs / 1000 ).toFixed( 1 )} s, skipping the parse` );

		// Phase breakdown for scaling work; the engine's own build timings live in
		// SceneProcessor.performanceMetrics.
		this.lastPBRTStats = {
			parseMs, buildMs, loaderMs: performance.now() - pbrtStart,
			triangleCount, placementCount, mergedShapes, skippedForBudget, droppedNoTemplate, meshCount,
			frames: frames?.length ?? 1
		};

		// An archive can hold several independent scenes (bistro ships three views). Only one is
		// loaded, so name it and the alternatives rather than leave the user comparing against a
		// reference of a different scene. A frame sequence loads whole, as its animation.
		const loaded = new Set( frames ?? [ loadedEntry ] );
		const others = candidates.filter( p => ! loaded.has( p ) );
		if ( others.length > 0 ) {

			console.warn( `PBRT archive holds ${candidates.length} scenes; loaded "${loadedEntry}". Others: ${others.join( ', ' )}` );
			this.loader._issues?.record(
				ISSUE_CODES.ASSET_AMBIGUOUS_ENTRY,
				`archive holds ${candidates.length} pbrt scenes; loaded "${loadedEntry}"`,
				{ loaded: loadedEntry, alternatives: others },
				ISSUE_SEVERITY.WARNING
			);

		}

		// Diagnostics — surface what each mesh resolved to (helps debug black/wrong materials).
		if ( report && report.length && typeof console.table === 'function' ) {

			const shown = report.length < meshCount ? ` (first ${report.length} of ${meshCount})` : '';
			console.groupCollapsed( `PBRT loader: ${meshCount} mesh(es) from "${loadedEntry}"${shown}` );
			console.table( report );
			console.groupEnd();

		}

		if ( warnings && warnings.length ) {

			console.warn( `PBRT loader: ${warnings.length} warning(s) parsing "${loadedEntry}"` );
			warnings.forEach( w => console.warn( '  •', w ) );

		}

		// Infinite light → scene environment (CDF is built later in loadSceneData).
		if ( environment?.texture ) {

			environment.texture.generateMipmaps = true;
			this.loader.applyEnvironmentToScene( environment.texture );

		}

		group.name = loadedEntry || filename;
		this.loader.releaseTargetModel();
		this.loader._sourceKey = graphKey;
		// Before onModelLoad and the build touch the new group.
		if ( graphKey && ! stored ) this._storeGraph( graphKey, built, filename );
		this.loader.targetModel = group;
		this.loader.animations = animations ?? [];

		// The light's own orientation and `scale` are already baked into the texture, so the
		// scene is only correct at rotation 0 / intensity 1 — pinned, whatever the host's defaults.
		// Without an infinite light pbrt has no environment at all.
		this.loader.sceneMetadata = { environment: environment?.texture ? { rotation: 0, intensity: 1 } : { enabled: false } };

		updateLoading( { isLoading: true, status: 'Processing PBRT geometry...', progress: 10 } );
		await this.loader.onModelLoad( this.loader.targetModel );

		this.loader.dispatchEvent( { type: 'load', model: group, filename: `${loadedEntry} (from ZIP)` } );
		return group;

	}

	/**
	 * Decodes a pbrt texture map from raw bytes, picking a decoder by extension.
	 * ImageBitmap can't handle EXR/HDR/TGA, which pbrt scenes use freely.
	 * @param {Uint8Array} bytes
	 * @param {string} fname
	 * @returns {Promise<import('three').Texture>}
	 */
	async _pbrtTextureFromBytes( bytes, fname ) {

		const ext = fname.split( '.' ).pop().toLowerCase();
		let tex;

		if ( ext === 'exr' || ext === 'hdr' ) {

			const loader = ext === 'hdr'
				? ( this.loader.loaderCache.hdr || ( this.loader.loaderCache.hdr = new HDRLoader().setDataType( FloatType ) ) )
				: ( this.loader.loaderCache.exr || ( this.loader.loaderCache.exr = new EXRLoader().setDataType( FloatType ) ) );
			tex = await this._loadViaObjectURL( loader, bytes );
			// HDR/EXR maps are linear — leave colorSpace as the loader set it.

		} else if ( ext === 'pfm' ) {

			tex = pfmTexture( bytes );

		} else if ( ext === 'tga' ) {

			if ( ! this.loader.loaderCache.tga ) {

				const { TGALoader } = await import( 'three/examples/jsm/loaders/TGALoader.js' );
				this.loader.loaderCache.tga = new TGALoader();

			}

			tex = await this._loadViaObjectURL( this.loader.loaderCache.tga, bytes );
			tex.colorSpace = SRGBColorSpace;

		} else {

			// png / jpg / webp / gif / bmp
			const bitmap = await createImageBitmap( new Blob( [ bytes ] ) );
			tex = new Texture( bitmap );
			tex.colorSpace = SRGBColorSpace;

		}

		tex.wrapS = tex.wrapT = RepeatWrapping;
		tex.needsUpdate = true;
		return tex;

	}

	/** Decode bytes through a three loader's loadAsync via a transient object URL. */
	async _loadViaObjectURL( loader, bytes ) {

		const url = URL.createObjectURL( new Blob( [ bytes ] ) );
		try {

			return await loader.loadAsync( url );

		} finally {

			URL.revokeObjectURL( url );

		}

	}

	async processObjMtlPairsInZip( zip, filename ) {

		const objFiles = [];
		const mtlFiles = [];

		for ( const path in zip ) {

			const lowerPath = path.toLowerCase();
			if ( lowerPath.endsWith( '.obj' ) ) objFiles.push( { path, content: zip[ path ] } );
			else if ( lowerPath.endsWith( '.mtl' ) ) mtlFiles.push( { path, content: zip[ path ] } );

		}

		if ( objFiles.length > 0 && mtlFiles.length > 0 ) {

			console.log( `Found ${objFiles.length} OBJ files and ${mtlFiles.length} MTL files in ZIP` );
			const matches = this.findMatchingObjMtlPairs( objFiles, mtlFiles );

			if ( matches.length > 0 ) {

				console.log( `Found ${matches.length} matching OBJ+MTL pairs` );
				return await this.loadOBJMTLPairFromZip( matches[ 0 ].obj, matches[ 0 ].mtl, zip, filename );

			}

			if ( matches.length === 0 ) {

				console.log( 'No matching pairs by name, using first OBJ and MTL files' );
				return await this.loadOBJMTLPairFromZip( objFiles[ 0 ], mtlFiles[ 0 ], zip, filename );

			}

		}

		return null;

	}

	findMatchingObjMtlPairs( objFiles, mtlFiles ) {

		const matches = [];
		for ( const objFile of objFiles ) {

			const objBaseName = objFile.path.split( '/' ).pop().replace( /\.obj$/i, '' ).toLowerCase();

			for ( const mtlFile of mtlFiles ) {

				const mtlBaseName = mtlFile.path.split( '/' ).pop().replace( /\.mtl$/i, '' ).toLowerCase();
				if ( objBaseName === mtlBaseName || objBaseName.includes( mtlBaseName ) || mtlBaseName.includes( objBaseName ) ) {

					matches.push( { obj: objFile, mtl: mtlFile } );
					break;

				}

			}

		}

		return matches;

	}

	async findAndLoadModelFromZip( zip ) {

		const mainModelFiles = [
			'scene.gltf', 'scene.glb', 'model.gltf', 'model.glb',
			'main.gltf', 'main.glb', 'asset.gltf', 'asset.glb'
		];

		for ( const mainFile of mainModelFiles ) {

			if ( zip[ mainFile ] ) {

				console.log( `Found main model file: ${mainFile}` );
				const extension = mainFile.split( '.' ).pop().toLowerCase();
				return await this.loadModelFromZipEntry( zip[ mainFile ], mainFile, extension, zip );

			}

		}

		for ( const path in zip ) {

			const extension = path.split( '.' ).pop().toLowerCase();
			if ( MODEL_FORMATS[ extension ] && MODEL_FORMATS[ extension ].type === 'model' ) {

				// A loose layer is only one slice of a USD scene — hand the whole
				// archive over so its references and payloads can resolve.
				if ( USD_LAYER_RE.test( path ) ) return await this.loadUSDHierarchyFromZip( zip );

				console.log( `Loading model file from ZIP: ${path}` );
				return await this.loadModelFromZipEntry( zip[ path ], path, extension, zip );

			}

		}

		throw new Error( 'No supported model files found in the ZIP archive' );

	}

	// USDLoader only builds a cross-layer asset map on its USDZ branch, so repack
	// the archive as USDZ — root layer first, per AOUSD core spec 16.4.1.2 — and
	// let the loader resolve the references/payloads itself.
	async loadUSDHierarchyFromZip( zip ) {

		const layers = Object.keys( zip ).filter( name => USD_LAYER_RE.test( name ) );
		if ( layers.length === 0 ) throw new Error( 'No USD layers found in the ZIP archive' );

		const root = ArchiveImporter._pickUSDRootLayer( layers );
		console.log( `Loading USD scene from ZIP: ${root} (${layers.length} layers)` );

		const packed = { [ root ]: [ zip[ root ], { level: 0 } ] };
		for ( const name of Object.keys( zip ) ) {

			if ( name === root ) continue;
			if ( USD_LAYER_RE.test( name ) || USD_IMAGE_RE.test( name ) ) packed[ name ] = [ zip[ name ], { level: 0 } ];

		}

		return await this.loader.loadUSDFromArrayBuffer( zipSync( packed ), root );

	}

	// Shallowest layer wins; among ties prefer the <dir>/<dir>.usd convention so a
	// set's entry point beats its sibling variants.
	static _pickUSDRootLayer( layers ) {

		const depth = name => name.split( '/' ).length;
		const minDepth = Math.min( ...layers.map( depth ) );
		const candidates = layers.filter( name => depth( name ) === minDepth );

		const conventional = candidates.find( name => {

			const parts = name.split( '/' );
			return parts.length > 1 && parts[ parts.length - 1 ].replace( USD_LAYER_RE, '' ) === parts[ parts.length - 2 ];

		} );

		return conventional || candidates[ 0 ];

	}

	async loadModelFromZipEntry( fileContent, filePath, extension, zipContents ) {

		try {

			updateLoading( { isLoading: true, status: `Processing ${extension.toUpperCase()} from ZIP...`, progress: 5 } );
			const blob = new Blob( [ fileContent.buffer ], { type: 'application/octet-stream' } );
			const blobUrl = URL.createObjectURL( blob );
			let result;

			switch ( extension ) {

				case 'glb':
				case 'gltf':
					result = await this.handleGltfFromZip( extension, fileContent, filePath, zipContents );
					break;
				case 'fbx':
					result = await this.loader.loadFBXFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'obj':
					result = await this.handleObjFromZip( fileContent, filePath, zipContents );
					break;
				case 'stl':
					result = await this.loader.loadSTLFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'ply':
					result = await this.loader.loadPLYFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'dae':
					{

						const daeContent = strFromU8( fileContent );
						const daeFile = new File( [ new Blob( [ daeContent ] ) ], filePath );
						result = await this.loader.loadColladaFromFile( daeFile, filePath );

					}

					break;
				case '3mf':
					result = await this.loader.load3MFFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'usd':
				case 'usda':
				case 'usdc':
				case 'usdz':
					result = await this.loader.loadUSDFromArrayBuffer( fileContent, filePath );
					break;
				default:
					throw new Error( `Support for ${extension} files is not yet implemented` );

			}

			URL.revokeObjectURL( blobUrl );
			this.loader.dispatchEvent( {
				type: 'load',
				model: this.loader.targetModel,
				filename: `${filePath} (from ZIP)`
			} );
			return result;

		} catch ( error ) {

			console.error( `Error loading ${extension} from ZIP:`, error );
			this.loader.dispatchEvent( { type: 'error', message: error.message, filename: filePath } );
			throw error;

		}

	}

	async handleGltfFromZip( extension, fileContent, filePath, zipContents ) {

		if ( extension === 'gltf' ) {

			const gltfContent = strFromU8( fileContent );
			const manager = new LoadingManager();
			const gltfDir = filePath.split( '/' ).slice( 0, - 1 ).join( '/' );

			manager.setURLModifier( url => this.resolveZipResource( url, gltfDir, zipContents ) );
			const loader = await this.loader.createGLTFLoader();
			loader.manager = manager;

			try {

				return await new Promise( ( resolve, reject ) => {

					loader.parse( gltfContent, '',
						gltf => {

							try {

								this.loader._throwDeferred();

							} catch ( error ) {

								reject( error );
								return;

							}

							this.loader.releaseTargetModel();
							this.loader.targetModel = gltf.scene;
							this.loader.sceneMetadata = extractSceneMetadata( gltf );
							this.loader.onModelLoad( this.loader.targetModel ).then( () => resolve( gltf ) );

						},
						error => reject( error )
					);

				} );

			} finally {

				this.loader._disposeGLTFLoader( loader );

			}

		} else {

			return await this.loader.loadGLBFromArrayBuffer( fileContent.buffer, filePath );

		}

	}

	async handleObjFromZip( fileContent, filePath, zipContents ) {

		const objContent = strFromU8( fileContent );
		const mtlMatch = objContent.match( /mtllib\s+([^\s]+)/ );
		let materials = null;

		if ( mtlMatch && mtlMatch[ 1 ] ) {

			materials = await this.loadMtlFromZip( mtlMatch[ 1 ], filePath, zipContents );

		}

		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const objLoader = new OBJLoader();
		if ( materials ) objLoader.setMaterials( materials );

		const object = objLoader.parse( objContent );
		object.name = filePath;

		this.loader.releaseTargetModel();
		this.loader.targetModel = object;
		await this.loader.onModelLoad( this.loader.targetModel );
		return object;

	}

	// MTLLoader returns Texture objects whose `.image` only lands on a later tick, and
	// SceneProcessor._bucketTextures drops any texture without one — so handing the model
	// over before the maps decode renders the whole scene untextured. Replaces preload().
	async preloadMtlTextures( materials ) {

		const pending = [];
		const loadTexture = materials.loadTexture.bind( materials );

		materials.loadTexture = ( url, mapping, onLoad, onProgress, onError ) => {

			let settle;
			pending.push( new Promise( resolve => ( settle = resolve ) ) );
			return loadTexture( url, mapping,
				texture => {

					settle();
					onLoad?.( texture );

				},
				onProgress,
				error => {

					settle();
					onError?.( error );

				}
			);

		};

		materials.preload();
		if ( pending.length === 0 ) return materials;

		let timer;
		const decoded = await Promise.race( [
			Promise.all( pending ).then( () => true ),
			new Promise( resolve => ( timer = setTimeout( () => resolve( false ), MTL_TEXTURE_TIMEOUT_MS ) ) )
		] );
		clearTimeout( timer );

		if ( ! decoded ) this.loader._issues?.record(
			ISSUE_CODES.TEXTURE_BUILD_FAILED,
			`MTL textures did not decode within ${MTL_TEXTURE_TIMEOUT_MS}ms; affected materials render untextured`,
			{ pending: pending.length }
		);

		return materials;

	}

	async loadMtlFromZip( mtlFilename, objPath, zipContents ) {

		const objDir = objPath.split( '/' ).slice( 0, - 1 ).join( '/' );
		const possibleMtlPaths = [
			mtlFilename,
			`${objDir}/${mtlFilename}`,
			mtlFilename.split( '/' ).pop()
		];

		for ( const path of possibleMtlPaths ) {

			if ( zipContents[ path ] ) {

				const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
				const mtlContent = strFromU8( zipContents[ path ] );
				const manager = new LoadingManager();
				manager.setURLModifier( url => this.resolveZipResource( url, objDir, zipContents ) );
				const mtlLoader = new MTLLoader( manager );
				const materials = mtlLoader.parse( mtlContent, objDir );
				await this.preloadMtlTextures( materials );
				return materials;

			}

		}

		return null;

	}

	resolveZipResource( url, baseDir, zipContents ) {

		const normalizedUrl = url.replace( /^\.\/|^\//, '' );
		const possiblePaths = [
			normalizedUrl,
			`${baseDir}/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const path of possiblePaths ) {

			if ( zipContents[ path ] ) {

				const fileBlob = new Blob( [ zipContents[ path ].buffer ], { type: 'application/octet-stream' } );
				return URL.createObjectURL( fileBlob );

			}

		}

		console.warn( `Resource not found in ZIP: ${url}` );
		return url;

	}

	async loadOBJMTLPairFromZip( objFile, mtlFile, zip, filename ) {

		const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const createdUrls = [];
		const manager = new LoadingManager();
		const objDir = objFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );
		const mtlDir = mtlFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );

		manager.setURLModifier( url => this.resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) );
		const mtlContent = this.prepareFixedMtlContent( mtlFile );
		const materials = new MTLLoader( manager ).parse( mtlContent, mtlDir );
		await this.preloadMtlTextures( materials );

		const objLoader = new OBJLoader( manager );
		objLoader.setMaterials( materials );
		const objContent = strFromU8( objFile.content );
		const object = objLoader.parse( objContent );

		this.loader.releaseTargetModel();
		this.loader.targetModel = object;
		await this.loader.onModelLoad( this.loader.targetModel );

		createdUrls.forEach( url => URL.revokeObjectURL( url ) );
		this.loader.dispatchEvent( {
			type: 'load',
			model: object,
			filename: `${objFile.path} (from ${filename})`
		} );

		return object;

	}

	prepareFixedMtlContent( mtlFile ) {

		const mtlContent = strFromU8( mtlFile.content );
		return mtlContent
			.replace( new RegExp( `${mtlFile.path.split( '/' ).pop()}\\s+`, 'g' ), ' ' )
			.replace( /([a-zA-Z_]+)([\\/])/g, '$1 $2' );

	}

	resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) {

		const cleanUrl = url.split( '?' )[ 0 ].split( '#' )[ 0 ];
		let normalizedUrl = cleanUrl.replace( /^\.\/|^\//, '' );

		const mtlFilename = mtlFile.path.split( '/' ).pop();
		if ( normalizedUrl.startsWith( mtlFilename ) ) {

			normalizedUrl = normalizedUrl.substring( mtlFilename.length ).replace( /^\.\/|^\/|^\./, '' );

		}

		const possibleLocations = [
			normalizedUrl,
			`${objDir}/${normalizedUrl}`,
			`${mtlDir}/${normalizedUrl}`,
			`textures/${normalizedUrl}`,
			`texture/${normalizedUrl}`,
			`materials/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const location of possibleLocations ) {

			if ( zip[ location ] ) {

				const blob = new Blob( [ zip[ location ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		return this.findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) || url;

	}

	findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) {

		const textureFilename = normalizedUrl.split( '/' ).pop();

		for ( const zipPath in zip ) {

			if ( zipPath.endsWith( textureFilename ) ) {

				const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		if ( textureFilename && textureFilename.length > 5 ) {

			for ( const zipPath in zip ) {

				const zipFilename = zipPath.split( '/' ).pop();
				if ( zipFilename.includes( textureFilename ) || textureFilename.includes( zipFilename ) ) {

					const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
					const blobUrl = URL.createObjectURL( blob );
					createdUrls.push( blobUrl );
					return blobUrl;

				}

			}

		}

		return null;

	}

}
