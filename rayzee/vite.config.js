import path from "path";
import { defineConfig } from "vite";


const __dirname = path.resolve();

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
			entry: path.resolve( __dirname, "src/index.js" ),
			name: "Rayzee",
			fileName: ( format ) => `rayzee.${format}.js`,
		},
		outDir: "dist",
		rolldownOptions: {
			onwarn( warning, warn ) {

				if ( warning.code === 'EMPTY_IMPORT_META' ) return;
				warn( warning );

			},
			external: [
				"three",
				/^three\//,
				/^three\/examples\//,
				"oidn-web",
				/^@tensorflow\/tfjs-core/,
			],
			output: [
				{
					format: "es",
					entryFileNames: "rayzee.es.js",
					globals: { three: "THREE" },
				},
				{
					format: "umd",
					entryFileNames: "rayzee.umd.js",
					name: "Rayzee",
					globals: ( id ) => {

						if ( id === "three" || id.startsWith( "three/" ) || id.startsWith( "three\\/" ) ) return "THREE";
						if ( id === "oidn-web" ) return "OIDNWeb";
						if ( id.startsWith( "@tensorflow/tfjs-core" ) ) return "tf";
						return id;

					},
				},
			],
		},
		// 'hidden': maps are excluded from the tarball, so a sourceMappingURL comment
		// would only produce "map not found" warnings downstream.
		sourcemap: 'hidden',
	},
} );
