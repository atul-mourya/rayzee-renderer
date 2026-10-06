/** What the archive add-on reads, known before its code loads (rayzee/addons/archives; PathTracerApp loads it on first use). */
export const ARCHIVE_FORMATS = Object.freeze( {
	'zip': { type: 'archive', name: 'ZIP Archive' },
	'gz': { type: 'archive', name: 'Gzipped TAR Archive' },
	'tgz': { type: 'archive', name: 'Gzipped TAR Archive' },
	'tar': { type: 'archive', name: 'TAR Archive' },
} );

const isBlob = value => typeof Blob !== 'undefined' && value instanceof Blob;

/** Whether `loadFile` was handed a folder (`{ files }`) rather than a File or a URL. */
export const isFolderInput = input => !! input && typeof input === 'object' && ! isBlob( input ) && input.files != null;

const hidden = segment => segment.startsWith( '.' ) || segment === '__MACOSX';

/**
 * A folder's files as `{ name, files: [{ path, file }] }`: paths '/'-separated and sorted, hidden files and folders
 * left out. Each of `files` is a File, whose path is its `webkitRelativePath` (a folder picker sets it) or else its
 * name, or `{ path, file }`. `name` defaults to the folder all paths share, else the first file `isModel` accepts.
 * @param {{name?: string, files: Iterable<File|{path: string, file: Blob}>}} input
 * @param {{isModel?: function(string): boolean}} [options]
 */
export function localFolder( { name = null, files }, { isModel = () => false } = {} ) {

	const byPath = new Map();
	for ( const item of files ) {

		const file = isBlob( item ) ? item : item.file;
		const raw = isBlob( item ) ? ( item.webkitRelativePath || item.name ) : item.path;
		const path = String( raw ?? '' ).replace( /\\/g, '/' ).split( '/' ).filter( s => s && s !== '.' ).join( '/' );
		if ( ! path || ! file || path.split( '/' ).some( hidden ) ) continue;
		byPath.set( path, { path, file } );

	}

	const list = [ ...byPath.values() ].sort( ( a, b ) => ( a.path < b.path ? - 1 : a.path > b.path ? 1 : 0 ) );
	const top = list[ 0 ]?.path.split( '/' )[ 0 ];
	const shared = list.length > 0 && list.every( e => e.path.startsWith( top + '/' ) ) ? top : null;
	const named = name ?? shared ?? ( list.find( e => isModel( e.path ) ) ?? list[ 0 ] )?.path.split( '/' ).pop() ?? 'Folder';
	return { name: named, files: list, flat: shared === null && list.every( e => ! e.path.includes( '/' ) ) };

}
