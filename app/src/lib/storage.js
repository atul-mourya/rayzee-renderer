import { STORAGE_KIND } from 'rayzee';
import { getApp } from '@/lib/appProxy';

export const APP_AREAS = Object.freeze( { RENDERS: 'renders', SESSIONS: 'sessions', PROJECTS: 'projects', JOBS: 'jobs' } );

const AREA_TEXT = {
	renders: { label: 'Saved renders', hint: 'Images in the Results tab' },
	sessions: { label: 'Sessions', hint: 'Your last scene and edits, offered after a reload' },
	projects: { label: 'Recent projects', hint: 'Projects opened or saved recently' },
	jobs: { label: 'Render jobs', hint: 'Unfinished video and still renders that can resume' },
	downloads: { label: 'Downloads', hint: 'Models, skies and weights fetched from the web' },
	archives: { label: 'Unpacked archives', hint: 'Compressed scene archives kept unpacked, and archive indexes' },
	scenes: { label: 'Scene cache', hint: 'Built scenes that reopen without rebuilding' },
	cdf: { label: 'Sky sampling tables', hint: 'Lighting tables precomputed for environment maps' },
	spill: { label: 'Memory spill', hint: 'Scene data moved out of memory while a large scene is open (experimental)' },
};

const ORDER = [ 'renders', 'sessions', 'projects', 'jobs', 'downloads', 'archives', 'scenes', 'cdf', 'spill' ];

/** @returns {?import('rayzee').StorageManager} */
export function getStorage() {

	return getApp()?.storage ?? null;

}

export function ensureAppAreas( storage ) {

	if ( ! storage ) return;
	for ( const name of Object.values( APP_AREAS ) ) storage.defineArea( name, { kind: STORAGE_KIND.USER } );

}

export function formatBytes( bytes ) {

	if ( ! Number.isFinite( bytes ) ) return '—';
	if ( bytes < 1024 ) return `${bytes} B`;
	const units = [ 'KB', 'MB', 'GB', 'TB' ];
	let value = bytes / 1024;
	let unit = 0;
	while ( value >= 1024 && unit < units.length - 1 ) {

		value /= 1024;
		unit ++;

	}

	return `${value.toFixed( value < 10 ? 1 : 0 )} ${units[ unit ]}`;

}

/** Turns `storage.usage()` into what the Storage dialog shows, user data first. */
export function describeUsage( usage ) {

	const rank = ( name ) => {

		const i = ORDER.indexOf( name );
		return i === - 1 ? ORDER.length : i;

	};

	const rows = Object.entries( usage.areas )
		.map( ( [ name, area ] ) => ( {
			name,
			kind: area.kind,
			bytes: area.bytes,
			entries: area.entries,
			label: AREA_TEXT[ name ]?.label ?? name,
			hint: AREA_TEXT[ name ]?.hint ?? '',
		} ) )
		.sort( ( a, b ) => rank( a.name ) - rank( b.name ) || a.name.localeCompare( b.name ) );

	const userBytes = rows.filter( ( r ) => r.kind === STORAGE_KIND.USER ).reduce( ( n, r ) => n + r.bytes, 0 );

	return {
		rows,
		userBytes,
		cacheBytes: usage.cacheBytes,
		budget: usage.budget,
		quota: usage.quota,
		siteBytes: usage.usage,
		persisted: usage.persisted,
	};

}
