const ARCHIVE_PATH = /\.(zip|tar|tgz|gz)$/i;
const MODEL_PATH = /\.(glb|gltf)$/i;

function pathOf( url ) {

	try {

		return new URL( url, globalThis.location?.href ?? 'http://localhost/' ).pathname;

	} catch {

		return '';

	}

}

/** A URL whose path ends in an archive extension (.zip, .tar, .tar.gz, .tgz). */
export const isArchiveUrl = url => ARCHIVE_PATH.test( pathOf( url ) );

/** What File → Import from URL accepts: http(s), and a glTF or an archive by its path. */
export function isImportableUrl( url ) {

	if ( ! /^https?:\/\//i.test( url ?? '' ) ) return false;
	const path = pathOf( url );
	return MODEL_PATH.test( path ) || ARCHIVE_PATH.test( path );

}
