import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// import basicSsl from '@vitejs/plugin-basic-ssl';

import process from 'process';
import { readFileSync } from 'fs';
const __dirname = path.resolve();
const enginePkg = JSON.parse( readFileSync( path.resolve( __dirname, '../rayzee/package.json' ), 'utf-8' ) );

const ReactCompilerConfig = {}; // Define ReactCompilerConfig

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
			// See bench/README.md.
			allow: [ path.resolve( __dirname, '..' ) ],
		},
		// port: 5174
	},
	assetsInclude: [ "**/*.hdr" ],
	plugins: [
		// Strip onnxruntime WASM files from build output — loaded from CDN at runtime.
		// Prevents Cloudflare Pages 25MB file size limit violation.
		{
			name: 'exclude-ort-wasm',
			generateBundle( _, bundle ) {

				for ( const key of Object.keys( bundle ) ) {

					if ( key.includes( 'ort-wasm' ) && key.endsWith( '.wasm' ) ) {

						delete bundle[ key ];

					}

				}

			}
		},
		// HTTPS so WebGPU works on remote devices (requires secure context)
		// basicSsl(),
		react( {
			babel: {
			  plugins: [
					[ "babel-plugin-react-compiler", ReactCompilerConfig ],
			  ],
			},
		  } ),
		tailwindcss()
	],
	resolve: {
		alias: {
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
