/**
 * The OpenColorIO runtime, and whichever config the engine is colour-managed by right now.
 *
 * The engine never names the OCIO package. A bare specifier in engine source would make a 6 MB
 * WebAssembly bundle a hard dependency of every host, and marking it `@vite-ignore` leaves the
 * browser unable to resolve it at all. So the host supplies it, either way round:
 *
 *   configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } )   // bundled
 *   configureAssets( { ocioRuntimeUrl: '/vendor/ocio/index.js' } )                 // served
 *
 * Exactly one config is live at a time. Everything downstream — the working space, input
 * resolution, view transforms, export — reads it from here.
 */

import { getAssetConfig } from '../AssetConfig.js';
import { createLogger } from '../utils/Logger.js';

const log = createLogger( 'ocio' );

/**
 * OpenColorIO's own messages, routed through the engine's leveled logger instead of straight to the
 * console. Its "Info" lines are notes about the config — the ACES CG v1.0.0 config names four Studio
 * displays as inactive that it does not define, and says so on every load — so they go to `debug`,
 * hidden by default and one `rayzee.log.setLevel( 'debug' )` away. Warnings and errors still show.
 */
function ocioPrint( text ) {

	const line = String( text );
	if ( /\[OpenColorIO Error\]/.test( line ) ) log.error( line );
	else if ( /\[OpenColorIO Warning\]/.test( line ) ) log.warn( line );
	else log.debug( line );

}

let runtimePromise = null;
let runtime = null;
let configInfo = null;
let configId = null;

/** The config's own YAML — the only place its context variables are actually declared. */
let configText = null;

/**
 * Resolve the host-supplied OCIO module.
 * @returns {Promise<Object>} the module namespace, with `createOcioRuntime`
 */
async function loadRuntimeModule() {

	const { ocioRuntimeFactory, ocioRuntimeUrl } = getAssetConfig();

	if ( typeof ocioRuntimeFactory === 'function' ) return await ocioRuntimeFactory();

	if ( typeof ocioRuntimeUrl === 'string' && ocioRuntimeUrl ) {

		return await import( /* @vite-ignore */ ocioRuntimeUrl );

	}

	throw new Error(
		'OpenColorIO runtime not configured. Call configureAssets({ ocioRuntimeFactory: ' +
		"() => import('@bb-studio/ocio') }) before loading a config."
	);

}

/** The live runtime, created on first use. Repeated calls share one instance. */
export async function ensureRuntime() {

	if ( runtime ) return runtime;

	if ( ! runtimePromise ) {

		runtimePromise = ( async () => {

			const mod = await loadRuntimeModule();
			if ( typeof mod.createOcioRuntime !== 'function' ) {

				throw new Error( 'OCIO module has no createOcioRuntime() — wrong package or version' );

			}

			const { ocioWasmUrl } = getAssetConfig();
			runtime = await mod.createOcioRuntime( {
				...( ocioWasmUrl ? { wasmUrl: ocioWasmUrl } : {} ),
				moduleOptions: { print: ocioPrint, printErr: ocioPrint },
			} );
			return runtime;

		} )().catch( err => {

			runtimePromise = null;
			throw err;

		} );

	}

	return await runtimePromise;

}

/** True once a runtime exists, without creating one. */
export function isRuntimeReady() {

	return runtime !== null;

}

/** The OCIO module's own built-in configs, which need no files on disk. */
export async function listBuiltinConfigs() {

	const rt = await ensureRuntime();
	return rt.ocio.listBuiltinConfigs();

}

/**
 * Load a config and make it the engine's.
 *
 * Three shapes, one of which must be given:
 *   { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' }
 *   { text: '<.ocio yaml>', files: [ { relativePath, data } ], configPath: 'config.ocio' }
 *   { files: [...], configPath: 'config.ocio' }
 *
 * A config that references LUTs on disk needs those files mounted alongside it — a partial mount
 * fails at the first missing file, so pass the whole support directory.
 *
 * @returns {Promise<Object>} the config description (see `describeConfig`)
 */
export async function loadConfig( { builtin, text, files = [], configPath = 'config.ocio', id } = {} ) {

	const rt = await ensureRuntime();

	if ( builtin ) {

		configInfo = rt.loadBuiltinConfig( builtin );
		configId = builtin;
		configText = safeBuiltinYaml( rt, builtin );

	} else {

		const packaged = files.map( f => ( {
			relativePath: f.relativePath ?? f.path ?? f.name,
			data: f.data instanceof Uint8Array ? f.data : new Uint8Array( f.data ),
		} ) );

		if ( text !== undefined ) {

			packaged.unshift( { relativePath: configPath, data: new TextEncoder().encode( text ) } );

		}

		if ( ! packaged.some( f => f.relativePath === configPath ) ) {

			throw new Error( `config package has no "${configPath}" — pass configPath to name the .ocio file` );

		}

		configInfo = rt.loadConfigPackage(
			{ configRelativePath: configPath, files: packaged },
			id ? { id } : undefined
		);
		configId = id ?? configInfo.id;
		const main = packaged.find( f => f.relativePath === configPath );
		configText = main ? new TextDecoder().decode( main.data ) : null;

	}

	return describeConfig();

}

/** Forget the config. The engine falls back to its uncoloured-managed behaviour. */
export function unloadConfig() {

	configInfo = null;
	configId = null;
	configText = null;

}

export function hasConfig() {

	return configInfo !== null;

}

/** The raw runtime, for callers that need a processor. Null before a config is loaded. */
export function getRuntime() {

	return configInfo ? runtime : null;

}

/** The raw `OcioRuntimeConfigInfo`, or null. */
export function getConfigInfo() {

	return configInfo;

}

/**
 * What the config offers, in the engine's own shape.
 *
 * The important part is `roles`: a config tells us what its own scene-linear space is, what a
 * colour picker should work in, and what "no colour management" means. Reading those beats
 * hardcoding names, which is what makes an arbitrary studio config work rather than only ACES.
 */
export function describeConfig() {

	if ( ! configInfo ) return null;

	const roles = Object.fromEntries( configInfo.roles.map( r => [ r.name, r.colorSpace ] ) );

	return {
		id: configId,
		// The config's own `name:`, when it declares one — what a menu should call a loaded folder.
		name: configText?.match( /^name:\s*(\S.*?)\s*$/m )?.[ 1 ] ?? null,
		ocioVersion: configInfo.ocioVersion,
		version: configInfo.version,

		roles,
		sceneLinear: roles.scene_linear ?? null,
		colorPicking: roles.color_picking ?? roles.texture_paint ?? null,
		texturePaint: roles.texture_paint ?? roles.color_picking ?? null,
		data: roles.data ?? null,
		compositingLog: roles.compositing_log ?? roles.color_timing ?? null,

		colorSpaces: configInfo.colorSpaces.map( c => ( {
			name: c.name,
			family: c.family,
			// What the config author says each space is for — `working-space`, `texture`, `file-io`.
			// Menus are meant to be filtered by these; without them every menu lists everything.
			categories: c.categories ?? [],
			encoding: c.encoding,
			isData: c.isData,
			aliases: c.aliases,
			description: c.description,
		} ) ),

		displays: configInfo.displays.slice(),
		defaultDisplay: configInfo.defaultDisplay,
		views: Object.fromEntries(
			Object.entries( configInfo.viewsByDisplay ).map( ( [ d, vs ] ) => [ d, vs.map( v => ( {
				name: v.name,
				transform: v.transform,
				colorSpace: v.colorSpace,
				looks: v.looks,
				description: v.description,
			} ) ) ] )
		),
		defaultViews: { ...configInfo.defaultViewsByDisplay },

		looks: configInfo.looks.map( l => ( {
			name: l.name,
			processSpace: l.processSpace,
			description: l.description,
			forward: l.hasForwardTransform,
			inverse: l.hasInverseTransform,
		} ) ),

		namedTransforms: configInfo.namedTransforms.map( n => n.name ),
		fileRules: configInfo.fileRules.map( r => ( {
			index: r.index, name: r.name, colorSpace: r.colorSpace,
			pattern: r.pattern, extension: r.extension, regex: r.regex,
		} ) ),

		contextVariables: collectContextVariables(),
	};

}

function safeBuiltinYaml( rt, name ) {

	try {

		return rt.ocio.getBuiltinConfigYaml( name );

	} catch {

		return null;

	}

}

/**
 * The context variables a config uses, with the defaults it declares.
 *
 * Read from the config's own text, because that is the only place they are. OCIO's description of
 * a loaded config lists colour spaces, looks and rules, but a `$SHOT` almost always sits inside a
 * file transform's path, which that description does not carry — reading the description found
 * none in practice. Two sources, merged:
 *   - the `environment:` block, where an OCIO v2 config declares its variables and their defaults
 *   - every `$VAR` / `${VAR}` reference, for configs that use one without declaring it
 *
 * @returns {Array<{ name: string, default: ?string, declared: boolean }>}
 */
function collectContextVariables() {

	if ( ! configText ) return [];

	const found = new Map();

	const lines = configText.split( /\r?\n/ );
	const at = lines.findIndex( l => /^environment:\s*(\{\s*\})?\s*$/.test( l ) );
	if ( at >= 0 && ! /\{\s*\}/.test( lines[ at ] ) ) {

		for ( let i = at + 1; i < lines.length; i ++ ) {

			const line = lines[ i ];
			if ( /^\S/.test( line ) ) break;
			const m = line.match( /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/ );
			if ( m ) found.set( m[ 1 ], { name: m[ 1 ], default: m[ 2 ].replace( /^["']|["']$/g, '' ) || null, declared: true } );

		}

	}

	for ( const m of configText.matchAll( /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g ) ) {

		if ( ! found.has( m[ 1 ] ) ) found.set( m[ 1 ], { name: m[ 1 ], default: null, declared: false } );

	}

	return [ ...found.values() ].sort( ( a, b ) => a.name.localeCompare( b.name ) );

}

/** Drop everything, including the runtime itself. Tests and `dispose()` use this. */
export function resetOcio() {

	unloadConfig();
	runtime?.dispose?.();
	runtime = null;
	runtimePromise = null;

}
