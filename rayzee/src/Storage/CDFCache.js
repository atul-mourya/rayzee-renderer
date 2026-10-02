import { ENGINE_AREAS } from './StorageManager.js';
import { sharedStorage } from './shared.js';
import { getAssetConfig } from '../AssetConfig.js';

const FORMAT = 2;

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

const FILES = [ 'marginal.f32', 'conditional.f32', 'exactConditional.f32', 'exactMarginal.f32' ];

/** @returns {Promise<?Object>} the fields of an EquirectHDRInfo build */
export async function loadCDF( texture ) {

	const key = keyFor( texture );
	const entry = key ? await area()?.open( key ) : null;
	if ( ! entry ) return null;

	try {

		const files = await Promise.all( FILES.map( name => entry.file( name ) ) );
		if ( files.some( f => ! f ) ) return null;
		const [ marginalData, conditionalData, exactConditional, exactMarginal ] = await Promise.all( files.map( async f => new Float32Array( await f.arrayBuffer() ) ) );
		const { totalSum, compensationDelta, width, height, exactWidth, exactHeight, radianceIntegral } = entry.extra;
		return { marginalData, conditionalData, totalSum, compensationDelta, width, height, exactConditional, exactMarginal, exactWidth, exactHeight, radianceIntegral };

	} finally {

		entry.release();

	}

}

export async function saveCDF( texture, info ) {

	const { marginalData, conditionalData, exactConditional, exactMarginal, totalSum, compensationDelta, width, height, exactWidth, exactHeight, radianceIntegral } = info;
	const arrays = [ marginalData, conditionalData, exactConditional, exactMarginal ];
	const key = keyFor( texture );
	const target = key ? area() : null;
	if ( ! target || arrays.some( a => ! a ) ) return false;

	const writer = await target.create( key, { label: texture.name || 'environment', expectedBytes: arrays.reduce( ( n, a ) => n + a.byteLength, 0 ) } );
	if ( ! writer ) return false;

	try {

		for ( let i = 0; i < FILES.length; i ++ ) await writer.write( FILES[ i ], arrays[ i ] );
		await writer.commit( { totalSum, compensationDelta, width, height, exactWidth, exactHeight, radianceIntegral } );
		return true;

	} catch {

		await writer.abort();
		return false;

	}

}
