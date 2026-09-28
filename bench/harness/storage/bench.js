const MiB = 1024 * 1024;

const worker = new Worker( new URL( './worker.js', import.meta.url ), { type: 'module' } );
const pending = new Map();
let nextId = 0;
let onChunk = null;

worker.onmessage = ( { data } ) => {

	if ( data.chunk ) {

		onChunk?.( data.chunk );
		return;

	}

	const request = pending.get( data.id );
	pending.delete( data.id );
	if ( data.error ) request.reject( new Error( data.error ) );
	else request.resolve( data.result );

};

function call( op, args = {}, transfer = [] ) {

	return new Promise( ( resolve, reject ) => {

		const id = nextId ++;
		pending.set( id, { resolve, reject } );
		worker.postMessage( { id, op, args }, transfer );

	} );

}

async function benchDir() {

	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle( 'storage-bench', { create: true } );

}

async function clear() {

	const root = await navigator.storage.getDirectory();
	await root.removeEntry( 'storage-bench', { recursive: true } ).catch( () => {} );

}

const mbps = ( bytes, ms ) => ( bytes / MiB ) / ( ms / 1000 );

async function writeWritable( name, bytes, chunk ) {

	const dir = await benchDir();
	const handle = await dir.getFileHandle( name, { create: true } );
	const data = new Uint8Array( chunk ).fill( 7 );
	const writable = await handle.createWritable();
	const t0 = performance.now();
	for ( let at = 0; at < bytes; at += chunk ) await writable.write( data );
	await writable.close();
	return performance.now() - t0;

}

async function readFileSlices( name, chunk ) {

	const file = await ( await ( await benchDir() ).getFileHandle( name ) ).getFile();
	const t0 = performance.now();
	for ( let at = 0; at < file.size; at += chunk ) await file.slice( at, at + chunk ).arrayBuffer();
	return { ms: performance.now() - t0, size: file.size };

}

async function randomReadFile( name, count, size ) {

	const file = await ( await ( await benchDir() ).getFileHandle( name ) ).getFile();
	let seed = 12345;
	const t0 = performance.now();
	for ( let i = 0; i < count; i ++ ) {

		seed = ( seed * 1103515245 + 12345 ) >>> 0;
		const at = Math.floor( ( seed / 0x100000000 ) * ( file.size - size ) );
		await file.slice( at, at + size ).arrayBuffer();

	}

	return performance.now() - t0;

}

async function readTransferred( name, chunk ) {

	let received = 0;
	onChunk = ( buffer ) => {

		received += buffer.byteLength;

	};

	const t0 = performance.now();
	const { size } = await call( 'read', { name, chunk, transfer: true } );
	onChunk = null;
	return { ms: performance.now() - t0, size, received };

}

async function gunzip( url, mode, batch = 8 * MiB ) {

	const response = await fetch( url );
	const reader = response.body.pipeThrough( new DecompressionStream( 'gzip' ) ).getReader();

	const retained = [];
	let staging = new Uint8Array( batch );
	let filled = 0;
	let total = 0;
	let inFlight = [];

	if ( mode === 'opfs' ) await call( 'sinkOpen', { name: 'gunzip.tar' } );

	const flush = async () => {

		if ( filled === 0 ) return;
		const out = staging.buffer.slice( 0, filled );
		if ( mode === 'opfs' ) {

			inFlight.push( call( 'sinkWrite', { buffer: out }, [ out ] ) );
			if ( inFlight.length >= 4 ) {

				await inFlight.shift();

			}

		} else {

			retained.push( out );

		}

		staging = new Uint8Array( batch );
		filled = 0;

	};

	const t0 = performance.now();
	for ( ;; ) {

		const { done, value } = await reader.read();
		if ( done ) break;
		let offset = 0;
		while ( offset < value.length ) {

			const n = Math.min( value.length - offset, batch - filled );
			staging.set( value.subarray( offset, offset + n ), filled );
			filled += n;
			offset += n;
			total += n;
			if ( filled === batch ) await flush();

		}

	}

	await flush();
	await Promise.all( inFlight );
	inFlight = [];
	let written = 0;
	if ( mode === 'opfs' ) written = ( await call( 'sinkClose' ) ).size;
	const ms = performance.now() - t0;

	return { ms, bytes: total, written, retainedBytes: retained.reduce( ( n, b ) => n + b.byteLength, 0 ) };

}

async function run( { sizeMiB = 2048, chunkMiB = 64, randomCount = 2000, randomKiB = 64, gzURL = null } = {} ) {

	const bytes = sizeMiB * MiB;
	const chunk = chunkMiB * MiB;
	const results = { crossOriginIsolated: globalThis.crossOriginIsolated === true, userAgent: navigator.userAgent };

	await clear();

	const estimate = await navigator.storage.estimate();
	results.quotaGiB = estimate.quota / ( 1024 * MiB );
	results.persisted = await navigator.storage.persisted();

	const write = await call( 'write', { name: 'seq.bin', bytes, chunk } );
	results.writeSync = mbps( bytes, write.ms );

	if ( typeof FileSystemFileHandle.prototype.createWritable === 'function' ) {

		results.writeWritable = mbps( bytes, await writeWritable( 'seq-writable.bin', bytes, chunk ) );
		await ( await benchDir() ).removeEntry( 'seq-writable.bin' );

	}

	const readSync = await call( 'read', { name: 'seq.bin', chunk, transfer: false } );
	results.readSync = mbps( readSync.size, readSync.ms );

	const readXfer = await readTransferred( 'seq.bin', chunk );
	results.readSyncTransfer = mbps( readXfer.size, readXfer.ms );

	if ( results.crossOriginIsolated ) {

		const shared = await call( 'readShared', { name: 'seq.bin', chunk } );
		results.readSyncShared = mbps( shared.size, shared.ms );

	}

	const fileRead = await readFileSlices( 'seq.bin', chunk );
	results.readFileSlices = mbps( fileRead.size, fileRead.ms );

	const rSync = await call( 'randomRead', { name: 'seq.bin', count: randomCount, size: randomKiB * 1024 } );
	results.randomSyncPerReadMs = rSync.ms / randomCount;
	results.randomFilePerReadMs = ( await randomReadFile( 'seq.bin', randomCount, randomKiB * 1024 ) ) / randomCount;

	if ( gzURL ) {

		const memory = await gunzip( gzURL, 'memory' );
		results.gunzipMemory = { mbps: mbps( memory.bytes, memory.ms ), ms: memory.ms, bytes: memory.bytes, retainedBytes: memory.retainedBytes };
		const opfs = await gunzip( gzURL, 'opfs' );
		results.gunzipOPFS = { mbps: mbps( opfs.bytes, opfs.ms ), ms: opfs.ms, bytes: opfs.bytes, written: opfs.written, retainedBytes: opfs.retainedBytes };

	}

	await clear();
	return results;

}

globalThis.__storageBench = { run };
globalThis.__storageBenchReady = true;
