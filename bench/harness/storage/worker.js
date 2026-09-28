let sink = null;

async function fileHandle( name, create = true ) {

	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle( 'storage-bench', { create: true } );
	return dir.getFileHandle( name, { create } );

}

function pattern( bytes ) {

	const buffer = new Uint32Array( bytes / 4 );
	let x = 0x9e3779b9;
	for ( let i = 0; i < buffer.length; i ++ ) {

		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		buffer[ i ] = x;

	}

	return new Uint8Array( buffer.buffer );

}

const ops = {

	async write( { name, bytes, chunk } ) {

		const data = pattern( chunk );
		const handle = await ( await fileHandle( name ) ).createSyncAccessHandle();
		handle.truncate( 0 );
		const t0 = performance.now();
		for ( let at = 0; at < bytes; at += chunk ) handle.write( data, { at } );
		handle.flush();
		const ms = performance.now() - t0;
		handle.close();
		return { ms };

	},

	async read( { name, chunk, transfer } ) {

		const handle = await ( await fileHandle( name, false ) ).createSyncAccessHandle();
		const size = handle.getSize();
		const t0 = performance.now();
		for ( let at = 0; at < size; at += chunk ) {

			const buffer = new ArrayBuffer( Math.min( chunk, size - at ) );
			handle.read( buffer, { at } );
			if ( transfer ) postMessage( { chunk: buffer }, [ buffer ] );

		}

		const ms = performance.now() - t0;
		handle.close();
		return { ms, size };

	},

	async readShared( { name, chunk } ) {

		const handle = await ( await fileHandle( name, false ) ).createSyncAccessHandle();
		const size = handle.getSize();
		const target = new SharedArrayBuffer( chunk );
		const t0 = performance.now();
		for ( let at = 0; at < size; at += chunk ) handle.read( new Uint8Array( target, 0, Math.min( chunk, size - at ) ), { at } );
		const ms = performance.now() - t0;
		handle.close();
		return { ms, size };

	},

	async randomRead( { name, count, size } ) {

		const handle = await ( await fileHandle( name, false ) ).createSyncAccessHandle();
		const total = handle.getSize();
		const buffer = new Uint8Array( size );
		let seed = 12345;
		const t0 = performance.now();
		for ( let i = 0; i < count; i ++ ) {

			seed = ( seed * 1103515245 + 12345 ) >>> 0;
			const at = Math.floor( ( seed / 0x100000000 ) * ( total - size ) );
			handle.read( buffer, { at } );

		}

		const ms = performance.now() - t0;
		handle.close();
		return { ms };

	},

	async sinkOpen( { name } ) {

		sink = await ( await fileHandle( name ) ).createSyncAccessHandle();
		sink.truncate( 0 );
		sink.position = 0;
		return {};

	},

	async sinkWrite( { buffer } ) {

		sink.write( new Uint8Array( buffer ), { at: sink.position } );
		sink.position += buffer.byteLength;
		return {};

	},

	async sinkClose() {

		sink.flush();
		const size = sink.getSize();
		sink.close();
		sink = null;
		return { size };

	},

};

self.onmessage = async ( { data } ) => {

	const { id, op, args } = data;
	try {

		postMessage( { id, result: await ops[ op ]( args ) } );

	} catch ( error ) {

		postMessage( { id, error: `${error.name}: ${error.message}` } );

	}

};
