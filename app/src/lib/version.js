// __APP_VERSION__ is injected at build time by Vite (see vite.config.js).
// CI: set via VITE_APP_VERSION from semantic-release-export-data plugin.
// Local dev / fallback: read from rayzee/package.json.

/* global __APP_VERSION__ */
import { Logger } from 'rayzee';

export const appVersion = __APP_VERSION__;

export function logVersion() {

	// Console handle for log controls: rayzee.log.setLevel('debug'), rayzee.log.only('bvh')
	globalThis.rayzee = Object.assign( globalThis.rayzee ?? {}, { log: Logger, version: appVersion } );

	console.log(
		`%cRayzee%c ${appVersion}%c  ·  rayzee.log.setLevel('debug') for verbose output`,
		'font-weight:600',
		'color:inherit',
		'color:#7c8494',
	);

	const level = Logger.getLevel();
	if ( level !== 'info' ) console.log( `%c[log] level '${level}' is active`, 'color:#7c8494' );

}
