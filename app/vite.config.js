import path from "path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// import basicSsl from '@vitejs/plugin-basic-ssl';

import process from 'process';
import { cpSync, mkdirSync, readFileSync } from 'fs';
import { DOCS, sendSiteFile, siteFiles } from '../scripts/check-docs.mjs';
const __dirname = path.resolve();
const enginePkg = JSON.parse( readFileSync( path.resolve( __dirname, '../rayzee/package.json' ), 'utf-8' ) );

// The docs site at docs/ beside the app (the Help menu's pages): served in dev, copied into the build.
function docsSite() {

	return {
		name: 'rayzee-docs-site',
		configureServer( server ) {

			server.middlewares.use( ( req, res, next ) => {

				const url = req.url.split( '?' )[ 0 ];
				if ( url === '/docs' ) {

					res.writeHead( 301, { location: '/docs/' } );
					res.end();

				} else if ( url.startsWith( '/docs/' ) ) sendSiteFile( res, url.slice( '/docs'.length ) );
				else next();

			} );

		},
		writeBundle( { dir } ) {

			for ( const file of siteFiles() ) {

				const to = path.join( dir, 'docs', file );
				mkdirSync( path.dirname( to ), { recursive: true } );
				cpSync( path.join( DOCS, file ), to );

			}

		},
	};

}

export default defineConfig( {
	envDir: path.resolve( __dirname, '..' ),
	base: './',
	server: {
		// Expose to LAN
		host: true,
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
		fs: {
			// The regression bench harness lives outside this Vite root, in the repo's
			// `bench/` directory. Serving it needs the monorepo root allow-listed.
			// See docs/design/BENCH.md (bench:ab).
			allow: [ path.resolve( __dirname, '..' ) ],
		},
		// port: 5174
	},
	assetsInclude: [ "**/*.hdr" ],
	plugins: [
		// HTTPS so WebGPU works on remote devices (requires secure context)
		// basicSsl(),
		react(),
		babel( { include: /\/app\/src\/.*\.jsx?$/, presets: [ reactCompilerPreset() ] } ),
		tailwindcss(),
		docsSite(),
	],
	resolve: {
		alias: {
			// Before "rayzee", which would also take "rayzee/encoders".
			"rayzee/encoders": path.resolve( __dirname, "../rayzee/src/output/ImageEncoders.js" ),
			"rayzee": path.resolve( __dirname, "../rayzee/src/index.js" ),
			"@/core": path.resolve( __dirname, "../rayzee/src" ),
			"@": path.resolve( __dirname, "./src" ),
		},
	},
	// Only define specific environment variables that are needed
	// Avoid exposing all of process.env for security reasons
	define: {
		'process.env.NODE_ENV': JSON.stringify( process.env.NODE_ENV ),
		'__APP_VERSION__': JSON.stringify( process.env.VITE_APP_VERSION || enginePkg.version ),
	}
} );
