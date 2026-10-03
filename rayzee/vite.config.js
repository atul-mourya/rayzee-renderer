import path from "path";
import { defineConfig } from "vite";


const __dirname = path.resolve();

// Two passes: ES with both entries sharing chunks, then UMD, which holds one entry only.
const umd = process.env.RAYZEE_FORMAT === 'umd';

export default defineConfig( {
	base: './',
	plugins: [],
	// assetsInclude: [ "**/*.hdr" ],
	define: {
		'process.env.NODE_ENV': JSON.stringify( process.env.NODE_ENV )
	},
	// Workers are imported `?worker&inline`, so they are embedded in the bundle
	// rather than emitted as side-chunks. ESM keeps them module workers, matching
	// how they were spawned when they were separate assets.
	worker: {
		format: 'es',
	},
	build: {
		lib: {
			entry: umd
				? { rayzee: path.resolve( __dirname, "src/index.js" ) }
				: { rayzee: path.resolve( __dirname, "src/index.js" ), "rayzee-core": path.resolve( __dirname, "src/core.js" ) },
			name: "Rayzee",
		},
		outDir: "dist",
		emptyOutDir: ! umd,
		rolldownOptions: {
			onwarn( warning, warn ) {

				if ( warning.code === 'EMPTY_IMPORT_META' ) return;
				warn( warning );

			},
			external: [
				"three",
				/^three\//,
				/^three\/examples\//,
				/^oidn-web(\/|$)/,
			],
			output: umd ? [
				{
					format: "umd",
					entryFileNames: "rayzee.umd.js",
					name: "Rayzee",
					globals: ( id ) => {

						if ( id === "three" || id.startsWith( "three/" ) || id.startsWith( "three\\/" ) ) return "THREE";
						if ( id === "oidn-web" || id.startsWith( "oidn-web/" ) ) return "OIDNWeb";
						return id;

					},
				},
			] : [
				{
					format: "es",
					entryFileNames: "[name].es.js",
					globals: { three: "THREE" },
				},
			],
		},
		// 'hidden': maps are excluded from the tarball, so a sourceMappingURL comment
		// would only produce "map not found" warnings downstream.
		sourcemap: 'hidden',
	},
} );
