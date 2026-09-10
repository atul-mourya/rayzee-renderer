/**
 * SceneMetadata.js
 * Scene-level authoring metadata carried inside an asset file.
 *
 * glTF/GLB carries it in `extras`, which three's GLTFLoader surfaces in three
 * places depending on where the exporter wrote it: top-level `extras` becomes
 * `gltf.userData`, `asset.extras` stays on `gltf.asset.extras`, and a scene's
 * `extras` becomes `gltf.scene.userData`. All three are scanned, and the payload
 * may sit at the root or be namespaced under a `rayzee` key.
 *
 * Recognised payload:
 *   {
 *     "environment": {
 *       "sourceFile": "https://.../brown_photostudio_02_1k.hdr",
 *       "rotation": 0,      // degrees around Y, matches the environmentRotation setting
 *       "intensity": 1      // drives both environmentIntensity and backgroundIntensity
 *     }
 *   }
 *
 * Values may also arrive as JSON strings — DCC custom-property round-trips often
 * stringify nested objects — so every container is parsed leniently.
 */

const ENV_URL_KEYS = [ 'sourceFile', 'url', 'file' ];

function asObject( value ) {

	if ( typeof value === 'string' ) {

		try {

			const parsed = JSON.parse( value );
			return ( parsed && typeof parsed === 'object' ) ? parsed : null;

		} catch {

			return null;

		}

	}

	return ( value && typeof value === 'object' ) ? value : null;

}

function asNumber( value ) {

	const n = typeof value === 'string' ? parseFloat( value ) : value;
	return Number.isFinite( n ) ? n : undefined;

}

function pickPayload( container ) {

	const obj = asObject( container );
	if ( ! obj ) return null;

	const scoped = asObject( obj.rayzee );
	if ( scoped && scoped.environment !== undefined ) return scoped;

	return obj.environment !== undefined ? obj : null;

}

function normalizeEnvironment( raw ) {

	const env = asObject( raw );
	if ( ! env ) return null;

	const sourceFile = ENV_URL_KEYS
		.map( key => env[ key ] )
		.find( value => typeof value === 'string' && value.trim() );
	if ( ! sourceFile ) return null;

	const rotation = asNumber( env.rotation );
	const intensity = asNumber( env.intensity );

	const normalized = { sourceFile: sourceFile.trim() };
	if ( rotation !== undefined ) normalized.rotation = rotation;
	if ( intensity !== undefined ) normalized.intensity = Math.max( 0, intensity );

	return normalized;

}

/**
 * Reads scene metadata out of one `extras`-shaped container.
 * @param {Object|string|null} container
 * @returns {{ environment?: { sourceFile: string, rotation?: number, intensity?: number } }|null}
 */
export function parseSceneMetadata( container ) {

	const payload = pickPayload( container );
	if ( ! payload ) return null;

	const environment = normalizeEnvironment( payload.environment );
	return environment ? { environment } : null;

}

/**
 * Reads scene metadata out of a GLTFLoader parse result.
 * @param {Object} gltf - The object GLTFLoader resolves with
 * @returns {{ environment?: { sourceFile: string, rotation?: number, intensity?: number } }|null}
 */
export function extractSceneMetadata( gltf ) {

	if ( ! gltf ) return null;

	const containers = [ gltf.userData, gltf.asset?.extras, gltf.scene?.userData ];
	if ( Array.isArray( gltf.scenes ) ) containers.push( ...gltf.scenes.map( scene => scene?.userData ) );

	for ( const container of containers ) {

		const metadata = parseSceneMetadata( container );
		if ( metadata ) return metadata;

	}

	return null;

}
