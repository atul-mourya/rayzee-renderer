import { openStorage } from 'rayzee';

const MiB = 1024 * 1024;
const NAMESPACE = 'rayzee-storage-bench';

async function clear() {

	const top = await navigator.storage.getDirectory();
	await top.removeEntry( NAMESPACE, { recursive: true } ).catch( () => {} );

}

function stream( bytes, chunk ) {

	let sent = 0;
	const data = new Uint8Array( chunk ).fill( 3 );
	return new ReadableStream( {
		pull( controller ) {

			if ( sent >= bytes ) {

				controller.close();
				return;

			}

			controller.enqueue( data.slice() );
			sent += chunk;

		},
	} );

}

async function timedStream( area, key, bytes, chunk ) {

	const writer = await area.create( key );
	const t0 = performance.now();
	await writer.writeStream( 'data', stream( bytes, chunk ) );
	await writer.commit();
	return ( bytes / MiB ) / ( ( performance.now() - t0 ) / 1000 );

}

async function selfTest( { sizeMiB = 512 } = {} ) {

	await clear();
	const { storage, reason } = await openStorage( { namespace: NAMESPACE } );
	if ( ! storage ) throw new Error( `storage unavailable: ${reason}` );

	const out = { transport: storage._transport.inline ? 'inline' : 'worker' };
	try {

		const area = storage.area( 'downloads' );
		const writer = await area.create( 'roundtrip' );
		await writer.write( 'data', new Uint8Array( [ 5, 6, 7 ] ) );
		await writer.writeJSON( 'info.json', { ok: true } );
		await writer.commit();
		const entry = await area.open( 'roundtrip' );
		out.roundtrip = [ ...new Uint8Array( await ( await entry.file( 'data' ) ).arrayBuffer() ) ].join( ',' ) === '5,6,7'
			&& ( await entry.json( 'info.json' ) ).ok === true;
		entry.release();

		const bytes = sizeMiB * MiB;
		// The first large write of a session runs ~3× slower; measure after it.
		out.firstStreamMiBs = await timedStream( area, 'warm', bytes, 256 * 1024 );
		out.streamMiBs = await timedStream( area, 'stream', bytes, 256 * 1024 );

		const big = await area.open( 'stream' );
		out.streamSizeOK = ( await big.file( 'data' ) ).size === bytes;
		big.release();

		const direct = await area.create( 'direct' );
		const t0 = performance.now();
		for ( let at = 0; at < bytes; at += 8 * MiB ) await direct.write( 'data', new Uint8Array( 8 * MiB ), { transfer: true } );
		await direct.commit();
		out.directWriteMiBs = ( bytes / MiB ) / ( ( performance.now() - t0 ) / 1000 );

		out.usage = await storage.usage();

	} finally {

		storage.dispose();
		await clear();

	}

	return out;

}

globalThis.__bench = { ready: Promise.resolve(), storage: { selfTest } };
