import { openZip } from 'rayzee';
import { openSink, zipInto } from '@/lib/zipSink';
import { getRenderRecords, getRenderFiles, saveRender, RENDER_FILES } from '@/utils/database';

const FORMAT = 'rayzee-renders';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Writes every saved render — image, thumbnail, AI variant, HDR copy and details — into one zip.
 * @returns {Promise<number>} renders exported
 */
export async function exportRenders() {

	const sink = await openSink( `rayzee-renders-${new Date().toLocaleDateString( 'sv' )}.zip`, { description: 'Zip archive', extension: '.zip' } );
	const records = await getRenderRecords();
	const zip = zipInto( sink );

	zip.addBytes( 'manifest.json', encoder.encode( JSON.stringify( { format: FORMAT, v: 1, count: records.length, exportedAt: new Date().toISOString() } ) ) );

	for ( const record of records ) {

		zip.addBytes( `renders/${record.id}/details.json`, encoder.encode( JSON.stringify( record ) ) );
		for ( const [ name, blob ] of Object.entries( await getRenderFiles( record.id ) ) ) {

			zip.addBytes( `renders/${record.id}/${name}`, new Uint8Array( await blob.arrayBuffer() ) );

		}

		await sink.drain();
		if ( zip.failure ) throw zip.failure;

	}

	await zip.finish();
	await sink.close();
	return records.length;

}

const sameRender = ( a, b ) => new Date( a.timestamp ).getTime() === new Date( b.timestamp ).getTime() && a.renderTime === b.renderTime;

/**
 * Adds the renders in an export zip to the library, skipping any already there.
 * @returns {Promise<{added: number, skipped: number}>}
 */
export async function importRenders( file ) {

	const zip = await openZip( file );
	const manifestBytes = await zip.read( 'manifest.json' );
	const manifest = manifestBytes && JSON.parse( decoder.decode( manifestBytes ) );
	if ( manifest?.format !== FORMAT ) throw new Error( `${file.name} is not a Rayzee renders export` );

	const existing = await getRenderRecords();
	const ids = [ ...new Set( zip.listing.map( ( e ) => e.path.match( /^renders\/([^/]+)\/details\.json$/ )?.[ 1 ] ).filter( Boolean ) ) ];

	let added = 0;
	let skipped = 0;
	for ( const id of ids ) {

		const details = JSON.parse( decoder.decode( await zip.read( `renders/${id}/details.json` ) ) );
		if ( existing.some( ( r ) => sameRender( r, details ) ) ) {

			skipped ++;
			continue;

		}

		const blob = async ( name ) => {

			const bytes = await zip.read( `renders/${id}/${name}` );
			return bytes ? new Blob( [ bytes ] ) : null;

		};

		const image = await blob( RENDER_FILES.IMAGE );
		if ( ! image ) {

			skipped ++;
			continue;

		}

		await saveRender( {
			image,
			hdr: await blob( RENDER_FILES.HDR ),
			aiGeneratedImage: await blob( RENDER_FILES.AI ),
			colorCorrection: details.colorCorrection,
			renderTime: details.renderTime,
			isEdited: details.isEdited,
			aiPrompt: details.aiPrompt,
			timestamp: new Date( details.timestamp ),
		} );
		added ++;

	}

	if ( added > 0 ) window.dispatchEvent( new Event( 'render-saved' ) );
	return { added, skipped };

}
