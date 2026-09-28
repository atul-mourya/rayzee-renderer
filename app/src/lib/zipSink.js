import { Zip, ZipPassThrough } from 'three/addons/libs/fflate.module.js';

/**
 * Where a zip goes: straight to a file the user picks where the browser allows, else a download
 * assembled in memory — `streamed` says which.
 * @param {string} name
 * @param {{description: string, extension: string}} type
 */
export async function openSink( name, { description, extension } ) {

	if ( typeof window.showSaveFilePicker === 'function' ) {

		const handle = await window.showSaveFilePicker( { suggestedName: name, types: [ { description, accept: { 'application/zip': [ extension ] } } ] } );
		const writable = await handle.createWritable();
		let chain = Promise.resolve();
		return {
			streamed: true,
			handle,
			push: ( chunk ) => {

				chain = chain.then( () => writable.write( chunk ) );

			},
			drain: () => chain,
			close: async () => {

				await chain;
				await writable.close();

			},
			abort: async () => {

				await chain.catch( () => {} );
				await writable.abort();

			},
		};

	}

	const chunks = [];
	return {
		streamed: false,
		handle: null,
		push: ( chunk ) => chunks.push( chunk ),
		drain: () => Promise.resolve(),
		close: async () => {

			const url = URL.createObjectURL( new Blob( chunks, { type: 'application/zip' } ) );
			const link = document.createElement( 'a' );
			link.href = url;
			link.download = name;
			link.click();
			setTimeout( () => URL.revokeObjectURL( url ), 10_000 );

		},
		abort: async () => {

			chunks.length = 0;

		},
	};

}

/** A zip written into a sink; `failure` is set if fflate reports an error. */
export function zipInto( sink ) {

	const state = { failure: null };
	const zip = new Zip( ( error, chunk ) => {

		if ( error ) state.failure = error;
		else sink.push( chunk );

	} );

	return {
		addBytes( path, bytes ) {

			const entry = new ZipPassThrough( path );
			zip.add( entry );
			entry.push( bytes, true );

		},

		/** Streams a Blob in, stored, waiting on the sink between pieces so memory stays flat. */
		async addBlob( path, blob, { onProgress } = {} ) {

			const entry = new ZipPassThrough( path );
			zip.add( entry );
			const reader = blob.stream().getReader();
			let done = 0;
			for ( ;; ) {

				const { value, done: end } = await reader.read();
				if ( end ) break;
				entry.push( value, false );
				done += value.byteLength;
				onProgress?.( done / blob.size );
				await sink.drain();
				if ( state.failure ) throw state.failure;

			}

			entry.push( new Uint8Array( 0 ), true );

		},

		async finish() {

			zip.end();
			await sink.drain();
			if ( state.failure ) throw state.failure;

		},

		get failure() {

			return state.failure;

		},
	};

}
