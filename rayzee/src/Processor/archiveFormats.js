/** What the archive add-on reads, known before its code loads (rayzee/addons/archives; PathTracerApp loads it on first use). */
export const ARCHIVE_FORMATS = Object.freeze( {
	'zip': { type: 'archive', name: 'ZIP Archive' },
	'gz': { type: 'archive', name: 'Gzipped TAR Archive' },
	'tgz': { type: 'archive', name: 'Gzipped TAR Archive' },
	'tar': { type: 'archive', name: 'TAR Archive' },
} );
