// Serves the browser example against the engine's source, under the package's own import paths.
import { defineConfig } from 'vite';
import path from 'node:path';

const src = path.resolve( __dirname, '../src' );

export default defineConfig( {
	root: path.resolve( __dirname, 'core-browser' ),
	resolve: {
		alias: [
			{ find: /^rayzee\/core$/, replacement: `${src}/core.js` },
			{ find: /^rayzee\/addons\/physical-sky$/, replacement: `${src}/addons/physicalSky.js` },
		],
	},
	worker: { format: 'es' },
	server: {
		// Cross-origin isolation, as the app has: the engine shares memory with its workers where it may.
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
	},
} );
