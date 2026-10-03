import { DataUtils, HalfFloatType, FloatType, SRGBColorSpace } from 'three';
import CDFWorker from './Workers/CDFWorker.js?worker&inline';
import { createWorker } from '../Platform.js';
import { buildExactEnvironmentTable } from './EnvironmentExactTable.js';

/**
 * sRGB to linear conversion (IEC 61966-2-1 transfer function)
 */
function sRGBToLinear( c ) {

	return c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4;

}

/**
 * Extract Float32 RGBA pixel data from an environment map.
 * Handles HalfFloat/integer type conversion, canvas extraction for
 * non-DataTexture images (JPG/PNG), sRGB-to-linear conversion, and Y-flip.
 * @returns {{ floatData: Float32Array, width: number, height: number }}
 */
export function extractFloatData( envMap ) {

	const { width, height } = envMap.image;
	let data = envMap.image.data;
	let needsSRGBToLinear = false;

	// No CPU-accessible data — extract from HTMLImageElement / ImageBitmap via canvas
	if ( ! data ) {

		const canvas = new OffscreenCanvas( width, height );
		const ctx = canvas.getContext( '2d' );
		ctx.drawImage( envMap.image, 0, 0, width, height );
		data = ctx.getImageData( 0, 0, width, height ).data;
		needsSRGBToLinear = true;

	}

	// Convert to Float32 regardless of source type
	let floatData;

	if ( envMap.type === FloatType && data instanceof Float32Array ) {

		// Copy so the original texture buffer is not detached by worker transfer
		floatData = new Float32Array( data );

	} else if ( envMap.type === HalfFloatType ) {

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = DataUtils.fromHalfFloat( data[ i ] );

		}

	} else {

		// Integer types (Uint8, Uint8Clamped, Int16, etc.)
		let maxIntValue;
		if ( data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array ) {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT - 1 ) - 1;

		} else {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT ) - 1;

		}

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = data[ i ] / maxIntValue;

		}

	}

	// Also flag sRGB conversion for DataTextures explicitly marked as sRGB
	if ( ! needsSRGBToLinear && envMap.colorSpace === SRGBColorSpace ) {

		needsSRGBToLinear = true;

	}

	// Convert sRGB to linear so CDF luminance matches GPU-sampled linear values
	if ( needsSRGBToLinear ) {

		for ( let i = 0, l = floatData.length; i < l; i += 4 ) {

			floatData[ i ] = sRGBToLinear( floatData[ i ] );
			floatData[ i + 1 ] = sRGBToLinear( floatData[ i + 1 ] );
			floatData[ i + 2 ] = sRGBToLinear( floatData[ i + 2 ] );

		}

	}

	// Remove Y-flip for CDF computation
	if ( envMap.flipY ) {

		const flipped = new Float32Array( floatData.length );
		for ( let y = 0; y < height; y ++ ) {

			const newY = height - y - 1;
			const srcOffset = y * width * 4;
			const dstOffset = newY * width * 4;
			flipped.set( floatData.subarray( srcOffset, srcOffset + width * 4 ), dstOffset );

		}

		floatData = flipped;

	}

	return { floatData, width, height };

}

/**
 * EquirectHDRInfo - an equirectangular environment's sampling table (EnvironmentExactTable.js), built on the
 * main thread (`updateFrom`) or in CDFWorker (`updateFromAsync`). `totalSum` is the map's ∫ luminance dω, 0
 * when there is nothing to sample.
 */
export class EquirectHDRInfo {

	constructor() {

		this.totalSum = 0;
		this.width = 0;
		this.height = 0;
		this.exactConditional = null;
		this.exactMarginal = null;
		this.exactRowGuide = null;
		this.exactMarginalGuide = null;
		this.exactWidth = 0;
		this.exactHeight = 0;
		this.radianceIntegral = 0;

		this._worker = null;

	}

	dispose() {

		this.exactConditional = null;
		this.exactMarginal = null;
		this.exactRowGuide = null;
		this.exactMarginalGuide = null;

		if ( this._worker ) {

			this._worker.terminate();
			this._worker = null;

		}

	}

	_adopt( table, width, height ) {

		Object.assign( this, table );
		this.width = width;
		this.height = height;
		this.totalSum = table.radianceIntegral;

	}

	/**
	 * Synchronous build on the main thread (fallback path).
	 */
	updateFrom( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );
		this._adopt( buildExactEnvironmentTable( floatData, width, height ), width, height );

	}

	/**
	 * The build offloaded to a Web Worker. Float extraction (HalfFloat → Float32) runs on the main thread
	 * (it needs three's DataUtils); the table's math runs off it.
	 * @returns {Promise<void>}
	 */
	async updateFromAsync( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );

		// Fresh worker per call — terminated in finally to avoid ~30 MB residency.
		this._worker = createWorker( CDFWorker );

		try {

			const result = await new Promise( ( resolve, reject ) => {

				this._worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				this._worker.onerror = reject;

				// Transfer floatData to worker (zero-copy)
				this._worker.postMessage(
					{ floatData, width, height },
					[ floatData.buffer ]
				);

			} );

			const { width: w, height: h, ...table } = result;
			this._adopt( table, w, h );

		} finally {

			if ( this._worker ) {

				this._worker.terminate();
				this._worker = null;

			}

		}

	}

}
