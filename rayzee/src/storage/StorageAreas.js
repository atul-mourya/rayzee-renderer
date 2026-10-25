export const STORAGE_KIND = Object.freeze( { CACHE: 'cache', USER: 'user', SCRATCH: 'scratch' } );

/** Areas the engine itself writes; hosts define their own with `defineArea`. */
export const ENGINE_AREAS = Object.freeze( { DOWNLOADS: 'downloads', ARCHIVES: 'archives', SCENES: 'scenes', CDF: 'cdf', SPILL: 'spill' } );

/** Per-namespace managers opened on this page, shared by every app on it. */
export const sharedByNamespace = new Map();

/** The storage an app on this page opened for `namespace`, or null — for code that holds no app. */
export function sharedStorage( namespace ) {

	return sharedByNamespace.get( namespace )?.storage ?? null;

}

/** A scene is stored only when rebuilding it took at least this long (decision D6). */
export const SCENE_CACHE_MIN_BUILD_MS = 10_000;

// File.slice reads measured 1.7–2.2 GB/s in Chrome (phase 0); kept conservative.
const READ_BYTES_PER_MS = 1.5e6;

/** Worth storing: the build was slow, and reading it back would take under a third as long. */
export function worthStoring( buildMs, bytes, minBuildMs = SCENE_CACHE_MIN_BUILD_MS ) {

	return buildMs >= minBuildMs && bytes / READ_BYTES_PER_MS < buildMs / 3;

}
