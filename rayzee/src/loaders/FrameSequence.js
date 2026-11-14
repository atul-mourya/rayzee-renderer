/**
 * Frame sequences: a run of numbered files (`smoke_0001.vdb`, `sky.0042.hdr`) played as one thing over time. What a
 * frame is and where it goes is its owner's (a volume's grids).
 */

// The frame number ends a name, before its extension: `fire_0012.vdb`, `sky.0042.hdr`, `frame7.exr`.
const NUMBERED = /^(.*?)(\d+)(\.[^./\\]+)$/;

/**
 * The numbered runs among `paths`: files of one folder, one name before the number and one extension, two or more of
 * them, longest first, each sorted by its numbers.
 * @param {string[]} paths
 * @returns {{ key: string, name: string, extension: string, paths: string[], numbers: number[] }[]}
 */
export function frameRuns( paths ) {

	const runs = new Map();
	for ( const path of paths ) {

		const slash = path.lastIndexOf( '/' ) + 1;
		const match = path.slice( slash ).match( NUMBERED );
		if ( ! match ) continue;
		const extension = match[ 3 ].slice( 1 ).toLowerCase();
		const key = `${path.slice( 0, slash )}${match[ 1 ]}#.${extension}`;
		let run = runs.get( key );
		// Named for what comes before the number: `fire_0001.vdb` is "fire".
		if ( ! run ) runs.set( key, run = { key, name: match[ 1 ].replace( /[\s._-]+$/, '' ) || path.slice( 0, slash ).replace( /\/$/, '' ).split( '/' ).pop() || 'sequence', extension, frames: [] } );
		run.frames.push( { path, number: Number( match[ 2 ] ) } );

	}

	return [ ...runs.values() ]
		.filter( ( run ) => run.frames.length > 1 )
		.map( ( run ) => {

			run.frames.sort( ( a, b ) => a.number - b.number );
			return { key: run.key, name: run.name, extension: run.extension, paths: run.frames.map( ( f ) => f.path ), numbers: run.frames.map( ( f ) => f.number ) };

		} )
		.sort( ( a, b ) => b.paths.length - a.paths.length );

}

/**
 * Frames decoded on demand, `ahead` more behind each. A seek a newer one overtakes gives null, so a slow player skips
 * frames. A frame handed out is its owner's to dispose.
 */
export class FrameSequence {

	/**
	 * @param {Object} options
	 * @param {Array<function(): Promise<*>>} options.frames - each frame's reader, in order
	 * @param {function(*, number): Promise<*>} options.decode - a frame's bytes (and index) to what its owner applies
	 * @param {function(*): void} [options.release] - lets go of a decoded frame no longer kept
	 * @param {number} [options.fps=24]
	 * @param {number} [options.ahead=2] - frames decoded past the one shown
	 * @param {number} [options.shown=-1] - the frame its owner already shows, decoded apart
	 * @param {string} [options.name]
	 */
	constructor( { frames, decode, release = null, fps = 24, ahead = 2, shown = - 1, name = 'sequence' } ) {

		if ( ! frames?.length ) throw new Error( 'FrameSequence: no frames' );
		this.name = name;
		this.fps = fps;
		this.ahead = ahead;
		this._frames = frames;
		this._decode = decode;
		this._release = release;
		/** @type {Map<number, Promise<*>>} */
		this._cache = new Map();
		this._wanted = shown;
		this._given = new Set();
		/** The frame last handed out, -1 before the first. */
		this.current = shown;
		this._chain = Promise.resolve();
		this._disposed = false;

	}

	get frameCount() {

		return this._frames.length;

	}

	/** Seconds the frames last at `fps`. */
	get duration() {

		return this._frames.length / this.fps;

	}

	/** The frame shown at `time` seconds, the last one held past the end. */
	frameAt( time ) {

		return Math.min( this._frames.length - 1, Math.max( 0, Math.floor( time * this.fps + 1e-6 ) ) );

	}

	/**
	 * The frame `time` falls on, decoded: `{ index, frame }`, or null when it is the one handed out last or a newer seek
	 * overtook this one.
	 * @param {number} time - seconds
	 * @returns {Promise<?{ index: number, frame: * }>}
	 */
	async seek( time ) {

		const index = this.frameAt( time );
		if ( index === this.current && index === this._wanted ) return null;
		this._wanted = index;
		const frame = await this._get( index );
		if ( this._disposed || this._wanted !== index ) return null;
		this.current = index;
		this._given.add( index );
		this._keep( index );
		for ( let k = 1; k <= this.ahead; k ++ ) if ( index + k < this._frames.length ) this._get( index + k ).catch( () => {} );
		return { index, frame };

	}

	/** The decoded frame `index`, one decode at a time: frames ahead queue behind the one asked for. */
	_get( index ) {

		let pending = this._cache.get( index );
		if ( ! pending ) {

			pending = this._chain.catch( () => {} ).then( async () => {

				if ( this._disposed ) throw new Error( 'FrameSequence: disposed' );
				return this._decode( await this._frames[ index ](), index );

			} );
			this._chain = pending;
			this._cache.set( index, pending );
			// A frame that failed is read again when asked for.
			pending.catch( () => this._cache.get( index ) === pending && this._cache.delete( index ) );

		}

		return pending;

	}

	// Keeps the frame shown and the ones ahead of it never handed out; releases what was never handed out.
	_keep( index ) {

		for ( const [ i, pending ] of this._cache ) {

			const given = this._given.has( i );
			if ( i === index || ( ! given && i > index && i <= index + this.ahead ) ) continue;
			this._cache.delete( i );
			this._given.delete( i );
			if ( ! given && this._release ) pending.then( this._release, () => {} );

		}

	}

	dispose() {

		this._disposed = true;
		for ( const [ i, pending ] of this._cache ) if ( this._release && ! this._given.has( i ) ) pending.then( this._release, () => {} );
		this._cache.clear();
		this._given.clear();

	}

}
