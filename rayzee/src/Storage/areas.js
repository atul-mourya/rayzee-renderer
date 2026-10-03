export const STORAGE_KIND = Object.freeze( { CACHE: 'cache', USER: 'user', SCRATCH: 'scratch' } );

/** Areas the engine itself writes; hosts define their own with `defineArea`. */
export const ENGINE_AREAS = Object.freeze( { DOWNLOADS: 'downloads', ARCHIVES: 'archives', SCENES: 'scenes', CDF: 'cdf', SPILL: 'spill' } );
