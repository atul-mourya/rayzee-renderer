import { ENGINE_AREAS } from './StorageManager.js';
import { sharedStorage } from './shared.js';
import { getAssetConfig } from '../AssetConfig.js';

const FORMAT = 1;

/**
 * Where an environment texture came from, recorded by the loader so its sampling tables can be
 * found again. Pixels edited in place (skies, colour conversion) change the key or clear it.
 */
export function setEnvironmentSource( texture, source ) {

	if ( texture && source ) texture.userData.__rayzeeSource = source;

}

function keyFor( texture ) {

	const source = texture?.userData?.__rayzeeSource;
	if ( ! source ) return null;
	const { width = 0, height = 0 } = texture.image ?? {};
	return `cdf:${FORMAT}:${source}|${width}x${height}|${texture.userData.__rayzeeColorSpace ?? 'native'}`;

}

const area = () => sharedStorage( getAssetConfig().cacheNamespace )?.area( ENGINE_AREAS.CDF ) ?? null;

/** @returns {Promise<?{marginalData: Float32Array, conditionalData: Float32Array, totalSum: number, compensationDelta: number, width: number, height: number}>} */
export async function loadCDF( texture ) {

	const key = keyFor( texture );
	const entry = key ? await area()?.open( key ) : null;
	if ( ! entry ) return null;

	try {

		const [ marginal, conditional ] = await Promise.all( [ entry.file( 'marginal.f32' ), entry.file( 'conditional.f32' ) ] );
		if ( ! marginal || ! conditional ) return null;
		const { totalSum, compensationDelta, width, height } = entry.extra;
		return {
			marginalData: new Float32Array( await marginal.arrayBuffer() ),
			conditionalData: new Float32Array( await conditional.arrayBuffer() ),
			totalSum, compensationDelta, width, height,
		};

	} finally {

		entry.release();

	}

}

export async function saveCDF( texture, { marginalData, conditionalData, totalSum, compensationDelta, width, height } ) {

	const key = keyFor( texture );
	const target = key ? area() : null;
	if ( ! target || ! marginalData || ! conditionalData ) return false;

	const writer = await target.create( key, { label: texture.name || 'environment', expectedBytes: marginalData.byteLength + conditionalData.byteLength } );
	if ( ! writer ) return false;

	try {

		await writer.write( 'marginal.f32', marginalData );
		await writer.write( 'conditional.f32', conditionalData );
		await writer.commit( { totalSum, compensationDelta, width, height } );
		return true;

	} catch {

		await writer.abort();
		return false;

	}

}
