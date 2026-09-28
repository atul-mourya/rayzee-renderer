import { APP_AREAS } from '@/lib/storage';
import { muxChunks } from '@/lib/VideoEncoder';

const JOB_FILE = 'job.json';
const CHUNKS = 'chunks.bin';
const VIDEO = 'video.webm';
const RECORD_HEADER = 17; // frame u32, key u8, timestamp f64, length u32

const toBase64 = bytes => btoa( String.fromCharCode( ...new Uint8Array( bytes ) ) );
const fromBase64 = text => Uint8Array.from( atob( text ), c => c.charCodeAt( 0 ) );

function portableConfig( config ) {

	if ( ! config ) return null;
	const { description, ...rest } = config;
	const out = { ...rest };
	if ( description ) out.description = toBase64( ArrayBuffer.isView( description ) ? description.buffer.slice( description.byteOffset, description.byteOffset + description.byteLength ) : description );
	return out;

}

function liveConfig( config ) {

	if ( ! config ) return null;
	return config.description ? { ...config, description: fromBase64( config.description ) } : config;

}

function encodeRecord( frame, chunk ) {

	const out = new Uint8Array( RECORD_HEADER + chunk.byteLength );
	const view = new DataView( out.buffer );
	view.setUint32( 0, frame, true );
	view.setUint8( 4, chunk.type === 'key' ? 1 : 0 );
	view.setFloat64( 5, chunk.timestamp, true );
	view.setUint32( 13, chunk.byteLength, true );
	chunk.copyTo( out.subarray( RECORD_HEADER ) );
	return out;

}

async function* readRecords( file, length ) {

	let at = 0;
	while ( at + RECORD_HEADER <= length ) {

		const view = new DataView( await file.slice( at, at + RECORD_HEADER ).arrayBuffer() );
		const size = view.getUint32( 13, true );
		if ( at + RECORD_HEADER + size > length ) return;
		const data = new Uint8Array( await file.slice( at + RECORD_HEADER, at + RECORD_HEADER + size ).arrayBuffer() );
		yield { frame: view.getUint32( 0, true ), key: view.getUint8( 4 ) === 1, timestamp: view.getFloat64( 5, true ), data };
		at += RECORD_HEADER + size;

	}

}

/**
 * A video render on disk: every finished frame's encoded chunks are appended to a journal and
 * committed, so a render interrupted at frame 250 of 300 still has frames 0–249. The WebM is
 * muxed from the journal at the end.
 */
export class VideoJob {

	constructor( storage, key, job ) {

		this._storage = storage;
		this.key = key;
		this.job = job;

	}

	get _area() {

		return this._storage.area( APP_AREAS.JOBS );

	}

	get framesDone() {

		return this.job.framesDone;

	}

	/**
	 * @param {import('rayzee').StorageManager} storage
	 * @param {{width:number, height:number, fps:number, codec:string, bitrate?:number, totalFrames:number, label?:string, options?:Object}} spec
	 * @returns {Promise<?VideoJob>} null when storage cannot take it
	 */
	static async start( storage, spec ) {

		if ( ! storage ) return null;
		const key = `video:${Date.now()}`;
		const job = { kind: 'video', ...spec, framesDone: 0, decoderConfig: null, startedAt: Date.now() };
		const writer = await storage.area( APP_AREAS.JOBS ).create( key, { label: spec.label ?? 'Video render', growable: [ CHUNKS ], extra: { kind: 'video' } } );
		if ( ! writer ) return null;

		try {

			await writer.writeJSON( JOB_FILE, job );
			await writer.write( CHUNKS, new Uint8Array( 0 ) );
			await writer.commit();

		} catch ( error ) {

			await writer.abort();
			throw error;

		}

		return new VideoJob( storage, key, job );

	}

	/** Unfinished video jobs, newest first. */
	static async unfinished( storage ) {

		if ( ! storage ) return [];
		const out = [];
		for ( const meta of await storage.area( APP_AREAS.JOBS ).list() ) {

			if ( meta.extra?.kind !== 'video' ) continue;
			const entry = await storage.area( APP_AREAS.JOBS ).open( meta.key );
			const job = await entry?.json( JOB_FILE );
			entry?.release();
			if ( job && job.framesDone < job.totalFrames ) out.push( new VideoJob( storage, meta.key, job ) );

		}

		return out.sort( ( a, b ) => b.job.startedAt - a.job.startedAt );

	}

	/** Commits one frame's chunks; the job then counts `frame + 1` frames done. */
	async appendFrame( frame, chunks, decoderConfig = null ) {

		const writer = await this._area.edit( this.key );
		if ( ! writer ) throw new Error( 'video job: its storage entry is gone' );

		try {

			for ( const chunk of chunks ) await writer.write( CHUNKS, encodeRecord( frame, chunk ), { transfer: true } );
			const next = { ...this.job, framesDone: frame + 1, decoderConfig: this.job.decoderConfig ?? portableConfig( decoderConfig ) };
			await writer.writeJSON( JOB_FILE, next );
			await writer.commit();
			this.job = next;

		} catch ( error ) {

			await writer.abort();
			throw error;

		}

	}

	/** Muxes every committed frame into `video.webm` and resolves the finished File. */
	async finalize() {

		const entry = await this._area.open( this.key, { wait: true } );
		if ( ! entry ) throw new Error( 'video job: its storage entry is gone' );
		let chunks, length;
		try {

			chunks = await entry.file( CHUNKS );
			length = entry.meta.files[ CHUNKS ];

		} finally {

			entry.release();

		}

		const writer = await this._area.edit( this.key );
		try {

			const { width, height, codec, fps } = this.job;
			await muxChunks( readRecords( chunks, length ), {
				width, height, codec, fps,
				decoderConfig: liveConfig( this.job.decoderConfig ),
				write: ( data, position ) => writer.write( VIDEO, data, { at: position } ),
			} );
			await writer.commit( { finished: true } );

		} catch ( error ) {

			await writer.abort();
			throw error;

		}

		const done = await this._area.open( this.key, { wait: true } );
		const file = await done.file( VIDEO );
		done.release();
		return new File( [ file ], `animation-${this.job.startedAt}.webm`, { type: 'video/webm' } );

	}

	async discard() {

		return this._area.remove( this.key );

	}

}
