import { DataArrayTexture, RGBAFormat, LinearFilter, UnsignedByteType, SRGBColorSpace, RepeatWrapping } from "three";
import { TEXTURE_CONSTANTS, MEMORY_CONSTANTS, DEFAULT_TEXTURE_MATRIX, MATERIAL_DATA_LAYOUT, normalizeAttenuationDistance } from '../EngineDefaults.js';
import TexturesWorker from './Workers/TexturesWorker.js?worker&inline';
import { ISSUE_CODES } from '../EngineIssues.js';

// Canvas pooling for efficient reuse of canvas elements
class CanvasPool {

	constructor() {

		this.canvasContextPairs = []; // Pool canvas+context pairs together
		this.maxPoolSize = TEXTURE_CONSTANTS.CANVAS_POOL_SIZE;

	}

	getCanvasWithContext( width, height, useOffscreen = false, options = {} ) {

		const defaultOptions = {
			willReadFrequently: true,
			alpha: true,
			desynchronized: true
		};
		const contextOptions = { ...defaultOptions, ...options };

		// Try to get from pool first
		let pair = this.canvasContextPairs.pop();

		if ( ! pair ) {

			// Create new pair
			let canvas;
			if ( useOffscreen && typeof OffscreenCanvas !== 'undefined' ) {

				canvas = new OffscreenCanvas( width, height );

			} else {

				canvas = document.createElement( 'canvas' );

			}

			const context = canvas.getContext( '2d', contextOptions );
			pair = { canvas, context };

		}

		// Set dimensions (this is fast even if unchanged)
		pair.canvas.width = width;
		pair.canvas.height = height;

		return pair;

	}

	releaseCanvasWithContext( pair ) {

		if ( this.canvasContextPairs.length < this.maxPoolSize ) {

			// Reset context state
			pair.context.globalAlpha = 1;
			pair.context.globalCompositeOperation = 'source-over';
			pair.context.imageSmoothingEnabled = true;

			// Clear the canvas
			pair.context.clearRect( 0, 0, pair.canvas.width, pair.canvas.height );

			// Reset to minimal size to save memory
			pair.canvas.width = 1;
			pair.canvas.height = 1;

			this.canvasContextPairs.push( pair );

		}

		// If pool is full, let it be garbage collected

	}

	// Legacy method for backward compatibility
	getCanvas( width, height, useOffscreen = false ) {

		return this.getCanvasWithContext( width, height, useOffscreen ).canvas;

	}

	getContext( canvas, options = {} ) {

		// Find existing context or create new one
		const pair = this.canvasContextPairs.find( p => p.canvas === canvas );
		if ( pair ) return pair.context;

		const defaultOptions = {
			willReadFrequently: true,
			alpha: true,
			desynchronized: true
		};
		return canvas.getContext( '2d', { ...defaultOptions, ...options } );

	}

	dispose() {

		this.canvasContextPairs = [];

	}

}

// Fixed smart buffer pool with proper memory accounting
class SmartBufferPool {

	constructor( options = {} ) {

		this.pools = new Map();
		this.memoryUsage = 0;
		this.maxMemoryUsage = options.maxMemory || MEMORY_CONSTANTS.MAX_BUFFER_MEMORY;
		this.allocatedBuffers = new WeakMap(); // Track which buffers we allocated
		this.sizeStrategy = options.sizeStrategy || 'adaptive'; // 'power2', 'exact', 'adaptive'

	}

	getOptimalSize( requestedSize ) {

		switch ( this.sizeStrategy ) {

			case 'exact':
				return requestedSize;

			case 'power2':
				return Math.pow( 2, Math.ceil( Math.log2( requestedSize ) ) );

			case 'adaptive':
			default:
				// Use exact size for small buffers, power of 2 for large ones
				if ( requestedSize < 1024 ) {

					return requestedSize;

				} else if ( requestedSize < 1024 * 1024 ) {

					// Round to nearest 1KB boundary
					return Math.ceil( requestedSize / 1024 ) * 1024;

				} else {

					// Use power of 2 for very large buffers
					return Math.pow( 2, Math.ceil( Math.log2( requestedSize ) ) );

				}

		}

	}

	getBuffer( size, Type = Float32Array ) {

		const optimalSize = this.getOptimalSize( size );
		const key = `${Type.name}-${optimalSize}`;
		const pool = this.pools.get( key ) || [];

		let buffer = pool.pop();
		if ( ! buffer ) {

			try {

				buffer = new Type( optimalSize );
				this.memoryUsage += buffer.byteLength;
				this.allocatedBuffers.set( buffer, true );

			} catch {

				// Memory allocation failed - cleanup and try again with smaller strategy
				this.cleanup();

				try {

					buffer = new Type( optimalSize );
					this.memoryUsage += buffer.byteLength;
					this.allocatedBuffers.set( buffer, true );

				} catch ( retryError ) {

					// Still failed - throw with helpful context
					const requestedMB = ( optimalSize * Type.BYTES_PER_ELEMENT ) / ( 1024 * 1024 );
					const currentUsageMB = this.memoryUsage / ( 1024 * 1024 );
					throw new Error( `Buffer allocation failed: requested ${ requestedMB.toFixed( 1 ) }MB, current usage: ${ currentUsageMB.toFixed( 1 ) }MB, max: ${ ( this.maxMemoryUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB. Original error: ${ retryError.message }` );

				}

			}

		}

		// Auto cleanup if memory usage is high
		if ( this.memoryUsage > this.maxMemoryUsage * MEMORY_CONSTANTS.CLEANUP_THRESHOLD ) {

			this.cleanup();

		}

		// Check memory health and warn if needed
		this.checkMemoryHealth();

		// Safety check: verify the underlying ArrayBuffer is large enough for the requested view.
		// A recycled buffer may have an undersized ArrayBuffer if it was released with a wrong Type.
		const requiredBytes = buffer.byteOffset + size * Type.BYTES_PER_ELEMENT;
		if ( requiredBytes > buffer.buffer.byteLength ) {

			// Discard the undersized buffer and allocate a fresh one
			buffer = new Type( size );
			this.memoryUsage += buffer.byteLength;

		}

		// Create a fresh view over the full underlying ArrayBuffer to avoid
		// subarray length clamping when the pool recycles a smaller view.
		return new Type( buffer.buffer, buffer.byteOffset, size );

	}

	releaseBuffer( buffer, Type = Float32Array ) {

		// Recover the full allocated size from the underlying ArrayBuffer
		const fullLength = ( buffer.buffer.byteLength - buffer.byteOffset ) / Type.BYTES_PER_ELEMENT;
		const optimalSize = this.getOptimalSize( fullLength );
		const key = `${Type.name}-${optimalSize}`;
		const pool = this.pools.get( key ) || [];

		if ( pool.length < TEXTURE_CONSTANTS.BUFFER_POOL_SIZE ) {

			// Store the full-extent view so future getBuffer calls can serve any size <= optimalSize
			pool.push( new Type( buffer.buffer, buffer.byteOffset, fullLength ) );
			this.pools.set( key, pool );

		} else {

			// Only subtract if this was our allocation
			if ( this.allocatedBuffers.has( buffer ) ) {

				this.memoryUsage -= buffer.byteLength;
				this.allocatedBuffers.delete( buffer );

			}

		}

	}

	cleanup() {

		// Clear half the pools, properly accounting for memory
		const entries = Array.from( this.pools.entries() );
		const toRemove = entries.slice( 0, Math.floor( entries.length / 2 ) );

		toRemove.forEach( ( [ key, pool ] ) => {

			pool.forEach( buffer => {

				if ( this.allocatedBuffers.has( buffer ) ) {

					this.memoryUsage -= buffer.byteLength;
					this.allocatedBuffers.delete( buffer );

				}

			} );
			this.pools.delete( key );

		} );

	}

	dispose() {

		// Clean up all pools and reset memory tracking
		this.pools.forEach( pool => {

			pool.forEach( buffer => {

				if ( this.allocatedBuffers.has( buffer ) ) {

					this.allocatedBuffers.delete( buffer );

				}

			} );

		} );

		this.pools.clear();
		this.memoryUsage = 0;

	}

	// Memory monitoring helper
	getMemoryStats() {

		const stats = {
			currentUsage: this.memoryUsage,
			maxUsage: this.maxMemoryUsage,
			utilizationPercentage: ( this.memoryUsage / this.maxMemoryUsage ) * 100,
			poolCount: this.pools.size,
			allocatedBufferCount: this.allocatedBuffers ? this.allocatedBuffers.size || 0 : 0
		};

		return stats;

	}

	// Warning system for memory usage
	checkMemoryHealth() {

		const stats = this.getMemoryStats();

		if ( stats.utilizationPercentage > 90 ) {

			console.warn( `Memory pool critical: ${ stats.utilizationPercentage.toFixed( 1 ) }% used (${ ( stats.currentUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB / ${ ( stats.maxUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB)` );
			return 'critical';

		} else if ( stats.utilizationPercentage > 70 ) {

			console.warn( `Memory pool high: ${ stats.utilizationPercentage.toFixed( 1 ) }% used (${ ( stats.currentUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB / ${ ( stats.maxUsage / ( 1024 * 1024 ) ).toFixed( 1 ) }MB)` );
			return 'high';

		}

		return 'normal';

	}

}

// LRU Cache for textures
class TextureCache {

	constructor( maxSize = TEXTURE_CONSTANTS.CACHE_SIZE_LIMIT ) {

		this.cache = new Map();
		this.accessOrder = [];
		this.maxSize = maxSize;

	}

	generateHash( textures ) {

		let hash = '';
		for ( const texture of textures ) {

			if ( texture?.image ) {

				const width = texture.image.width || 0;
				const height = texture.image.height || 0;
				const src = texture.image.src || texture.uuid || '';
				const flipFlag = texture.flipY === false ? 'n' : 'f';
				hash += `${width}x${height}_${src.slice( - 8 )}_${flipFlag}_`;

			}

		}

		return hash + textures.length;

	}

	get( key ) {

		if ( this.cache.has( key ) ) {

			const texture = this.cache.get( key );

			// A pool-backed texture disposed out-of-band (e.g. SceneProcessor._disposeBucketTextures
			// on a scene rebuild) has returned its backing buffer to the SmartBufferPool — a later
			// build may have already reused/overwritten it, so its pixels are now garbage. Never hand
			// it back: drop the stale entry and force a fresh rebuild. (dispose() nulls userData.buffer.)
			if ( texture?.userData && texture.userData.buffer === null ) {

				this.cache.delete( key );
				const stale = this.accessOrder.indexOf( key );
				if ( stale > - 1 ) this.accessOrder.splice( stale, 1 );
				return null;

			}

			// Move to end (most recently used)
			const index = this.accessOrder.indexOf( key );
			if ( index > - 1 ) {

				this.accessOrder.splice( index, 1 );

			}

			this.accessOrder.push( key );

			// Return cached texture directly — clone() fails on large DataArrayTextures
			// because Three.js's copy() calls JSON.stringify on the data array.
			// Each map type stores its own reference so shared instances are safe.
			return texture;

		}

		return null;

	}

	set( key, texture ) {

		if ( this.cache.has( key ) ) {

			// Remove stale access order entry to prevent duplicates
			const index = this.accessOrder.indexOf( key );
			if ( index > - 1 ) this.accessOrder.splice( index, 1 );

		} else if ( this.cache.size >= this.maxSize ) {

			this.evictLRU();

		}

		this.cache.set( key, texture );
		this.accessOrder.push( key );

	}

	evictLRU() {

		if ( this.accessOrder.length > 0 ) {

			const lruKey = this.accessOrder.shift();
			const texture = this.cache.get( lruKey );
			if ( texture && texture.dispose ) {

				texture.dispose();

			}

			this.cache.delete( lruKey );

		}

	}

	dispose() {

		this.cache.forEach( texture => {

			if ( texture && texture.dispose ) texture.dispose();

		} );
		this.cache.clear();
		this.accessOrder = [];

	}

}

export class TextureCreator {

	constructor( options = {} ) {

		this.useWorkers = typeof Worker !== 'undefined';
		this.maxConcurrentWorkers = TEXTURE_CONSTANTS.MAX_CONCURRENT_WORKERS;
		this.activeWorkers = 0;

		this._issues = options.issues ?? null;

		// Longest-edge cap for material-texture arrays. Clamped to the hardware ceiling.
		this.maxTextureSize = this._clampTextureSize(
			options.maxTextureSize ?? TEXTURE_CONSTANTS.DEFAULT_MAX_TEXTURE_SIZE
		);

		// Initialize high-performance components
		this.canvasPool = new CanvasPool();
		this.bufferPool = new SmartBufferPool( {
			maxMemory: options.maxBufferMemory || MEMORY_CONSTANTS.MAX_BUFFER_MEMORY,
			sizeStrategy: options.bufferSizeStrategy || 'adaptive'
		} );
		this.textureCache = new TextureCache();

		// Method selection based on capabilities
		this.capabilities = this.detectCapabilities();
		this.optimalMethod = this.selectOptimalMethod();

	}

	/**
	 * A failed map array leaves every surface using it untextured — a complete-looking image
	 * that is wrong. Recorded so a batch host can refuse to publish it.
	 * @private
	 */
	_reportTextureFailure( map, error ) {

		this._issues?.record(
			ISSUE_CODES.TEXTURE_BUILD_FAILED,
			`${map} texture array failed to build — those surfaces render untextured`,
			{ map, cause: String( error?.message ?? error ) }
		);

	}

	_clampTextureSize( size ) {

		const n = Math.floor( Number( size ) || TEXTURE_CONSTANTS.DEFAULT_MAX_TEXTURE_SIZE );
		return Math.max( TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH, Math.min( n, TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE ) );

	}

	setMaxTextureSize( size ) {

		const clamped = this._clampTextureSize( size );
		if ( clamped === this.maxTextureSize ) return clamped; // unchanged — keep cache
		this.maxTextureSize = clamped;
		// Cache keys don't encode size — drop cached arrays so a new cap takes effect.
		this.textureCache?.dispose();
		this.textureCache = new TextureCache();
		return this.maxTextureSize;

	}

	detectCapabilities() {

		return {
			offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
			imageBitmap: typeof createImageBitmap !== 'undefined',
			workers: typeof Worker !== 'undefined',
			hardwareConcurrency: navigator.hardwareConcurrency || 4
		};

	}

	selectOptimalMethod() {

		if ( this.capabilities.workers && this.capabilities.offscreenCanvas ) {

			return 'worker-offscreen';

		} else if ( this.capabilities.imageBitmap ) {

			return 'imageBitmap';

		} else {

			return 'canvas';

		}

	}

	// Unified texture processing with strategy selection
	async createTexturesToDataTexture( textures ) {

		if ( ! textures || textures.length === 0 ) return null;

		// Check cache first
		const cacheKey = this.textureCache.generateHash( textures );
		const cached = this.textureCache.get( cacheKey );
		if ( cached ) return cached;

		// Normalize non-drawable images (KTX2 CompressedTexture RGBA, DataTexture)
		const { normalized, bitmapsToClose } = await this._normalizeTexturesForProcessing( textures );

		// Select optimal processing strategy
		const strategy = this.selectProcessingStrategy( normalized );
		let result;

		try {

			switch ( strategy.method ) {

				case 'worker-direct':
					result = await this.processWithWorkerDirect( normalized );
					break;
				case 'main-batch':
					result = await this.processOnMainThreadBatch( normalized, strategy.batchSize );
					break;
				case 'main-streaming':
					result = await this.processOnMainThreadStreaming( normalized );
					break;
				default:
					result = await this.processOnMainThreadSync( normalized );

			}

			// Cache successful result
			if ( result ) {

				this.textureCache.set( cacheKey, result );

			}

			return result;

		} catch ( error ) {

			this._issues?.warn(
				ISSUE_CODES.TEXTURE_PROCESSING_FALLBACK,
				'worker texture processing failed — retrying on the main thread',
				{ cause: String( error?.message ?? error ) }
			);
			return await this.processOnMainThreadSync( normalized );

		} finally {

			for ( const bmp of bitmapsToClose ) bmp.close();

		}

	}

	selectProcessingStrategy( textures ) {

		const totalPixels = textures.reduce( ( sum, tex ) => {

			const width = tex.image?.width || 0;
			const height = tex.image?.height || 0;
			return sum + width * height;

		}, 0 );

		const estimatedMemory = totalPixels * 4; // RGBA

		if ( this.capabilities.workers && estimatedMemory > MEMORY_CONSTANTS.MAX_TEXTURE_MEMORY ) {

			// Very large texture set: stream on the main thread (GC-yielding, builds the
			// full array correctly). The former 'worker-chunked' path combined its chunks
			// by returning only the first, silently dropping the rest — removed.
			return { method: 'main-streaming' };

		} else if ( this.capabilities.workers && totalPixels > 2097152 ) {

			return { method: 'worker-direct' };

		} else if ( totalPixels > 524288 ) {

			return {
				method: 'main-batch',
				batchSize: Math.min( 4, textures.length )
			};

		} else if ( textures.length > 8 ) {

			return { method: 'main-streaming' };

		} else {

			return { method: 'main-sync' };

		}

	}

	// Optimized worker processing with direct transfer
	async processWithWorkerDirect( textures ) {

		// Wait for available worker
		while ( this.activeWorkers >= this.maxConcurrentWorkers ) {

			await new Promise( resolve => setTimeout( resolve, 10 ) );

		}

		this.activeWorkers ++;

		try {

			const worker = new TexturesWorker();

			// Prepare textures for worker with direct transfer
			const texturesData = await this.prepareTexturesForWorkerDirect( textures );

			const result = await new Promise( ( resolve, reject ) => {

				worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				worker.onerror = reject;

				// Collect transferable objects for zero-copy transfer
				const transferables = [];
				texturesData.forEach( tex => {

					if ( tex.data instanceof ArrayBuffer ) {

						transferables.push( tex.data );

					} else if ( tex.bitmap ) {

						transferables.push( tex.bitmap );

					}

				} );

				worker.postMessage( {
					textures: texturesData,
					maxTextureSize: this.maxTextureSize,
					method: 'direct-transfer'
				}, transferables );

			} );

			worker.terminate();
			return this.createDataArrayTextureFromResult( result );

		} finally {

			this.activeWorkers --;

		}

	}

	// Optimized worker preparation - eliminates data copying
	async prepareTexturesForWorkerDirect( textures ) {

		const texturesData = [];

		for ( const texture of textures ) {

			if ( ! texture?.image ) continue;

			const flipY = texture.flipY !== false;

			try {

				// Option 1: Direct ImageBitmap transfer (when supported). Covers HTMLImageElement
				// AND ImageBitmap (what GLTFLoader's ImageBitmapLoader produces) and canvases — the
				// worker extracts pixels on its OffscreenCanvas, so this keeps the full-res
				// getImageData off the main thread (Option 2 blocks it per texture).
				const img = texture.image;
				const canDirect = typeof createImageBitmap !== 'undefined' && (
					img instanceof HTMLImageElement
					|| ( typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap )
					|| ( typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement )
					|| ( typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas )
				);
				if ( canDirect ) {

					const bitmap = await createImageBitmap( texture.image, {
						imageOrientation: flipY ? 'flipY' : 'none',
					} );
					texturesData.push( {
						bitmap: bitmap,
						width: texture.image.width,
						height: texture.image.height,
						isDirect: true
					} );

				} else { // Option 2: Efficient canvas-based transfer

					const w = texture.image.width;
					const h = texture.image.height;
					const bitmap = await createImageBitmap( texture.image, {
						imageOrientation: flipY ? 'flipY' : 'none',
					} );
					const pair = this.canvasPool.getCanvasWithContext( w, h );

					pair.context.drawImage( bitmap, 0, 0 );
					bitmap.close();
					const imageData = pair.context.getImageData( 0, 0, w, h );

					// Transfer the underlying ArrayBuffer directly
					texturesData.push( {
						data: imageData.data.buffer, // Direct buffer transfer
						width: w,
						height: h,
						isImageData: true
					} );

					this.canvasPool.releaseCanvasWithContext( pair );

				}

			} catch ( error ) {

				console.warn( 'Failed to prepare texture for worker:', error );

			}

		}

		return texturesData;

	}

	async processOnMainThreadBatch( textures, batchSize ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		// Process in batches for memory efficiency
		for ( let batchStart = 0; batchStart < validTextures.length; batchStart += batchSize ) {

			const batchEnd = Math.min( batchStart + batchSize, validTextures.length );
			const batchPromises = [];

			// Create all ImageBitmaps for this batch in parallel
			for ( let i = batchStart; i < batchEnd; i ++ ) {

				const texture = validTextures[ i ];
				const flipY = texture.flipY !== false;

				const bitmapPromise = createImageBitmap( texture.image, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high',
					imageOrientation: flipY ? 'flipY' : 'none',
				} );

				batchPromises.push(
					bitmapPromise.then( bitmap => ( { bitmap, index: i } ) )
				);

			}

			const bitmaps = await Promise.all( batchPromises );

			// Process each bitmap
			const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
			pair.context.imageSmoothingEnabled = false; // Fast processing for batches

			for ( const { bitmap, index } of bitmaps ) {

				pair.context.clearRect( 0, 0, maxWidth, maxHeight );
				pair.context.drawImage( bitmap, 0, 0 );

				const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
				const offset = maxWidth * maxHeight * 4 * index;
				data.set( imageData.data, offset );

				bitmap.close();

			}

			this.canvasPool.releaseCanvasWithContext( pair );

		}

		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	async processOnMainThreadStreaming( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
		pair.context.imageSmoothingEnabled = true;
		pair.context.imageSmoothingQuality = 'high';

		for ( let i = 0; i < validTextures.length; i ++ ) {

			const texture = validTextures[ i ];
			const bitmap = await createImageBitmap( texture.image, {
				resizeWidth: maxWidth,
				resizeHeight: maxHeight,
				resizeQuality: 'high',
				imageOrientation: texture.flipY !== false ? 'flipY' : 'none',
			} );

			pair.context.clearRect( 0, 0, maxWidth, maxHeight );
			pair.context.drawImage( bitmap, 0, 0 );
			bitmap.close();

			const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

			// Allow GC between frames
			if ( i % MEMORY_CONSTANTS.STREAM_BATCH_SIZE === 0 ) {

				await new Promise( resolve => setTimeout( resolve, 0 ) );

			}

		}

		this.canvasPool.releaseCanvasWithContext( pair );
		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	async processOnMainThreadSync( textures ) {

		const validTextures = textures.filter( tex => tex?.image );
		if ( validTextures.length === 0 ) return this.createFallbackTexture();

		const { maxWidth, maxHeight } = this.calculateOptimalDimensions( validTextures );
		const depth = validTextures.length;
		const data = this.bufferPool.getBuffer( maxWidth * maxHeight * depth * 4, Uint8Array );

		const pair = this.canvasPool.getCanvasWithContext( maxWidth, maxHeight );
		pair.context.imageSmoothingEnabled = true;
		pair.context.imageSmoothingQuality = 'high';

		for ( let i = 0; i < validTextures.length; i ++ ) {

			const texture = validTextures[ i ];
			const bitmap = await createImageBitmap( texture.image, {
				resizeWidth: maxWidth,
				resizeHeight: maxHeight,
				resizeQuality: 'high',
				imageOrientation: texture.flipY !== false ? 'flipY' : 'none',
			} );

			pair.context.clearRect( 0, 0, maxWidth, maxHeight );
			pair.context.drawImage( bitmap, 0, 0 );
			bitmap.close();

			const imageData = pair.context.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

		}

		this.canvasPool.releaseCanvasWithContext( pair );
		return this.createDataArrayTextureFromBuffer( data, maxWidth, maxHeight, depth );

	}

	/**
	 * Build raw material Float32Array without DataTexture wrapping.
	 * Used by WebGPU backend which feeds data into storage buffers.
	 */
	createMaterialRawData( materials ) {

		// Layout is defined by MATERIAL_DATA_LAYOUT in EngineDefaults.js.
		// The inline array below must match that layout exactly (positional order = canonical layout).
		const dataLengthPerMaterial = MATERIAL_DATA_LAYOUT.FLOATS_PER_MATERIAL;
		const totalMaterials = materials.length;

		const size = totalMaterials * dataLengthPerMaterial;
		const data = new Float32Array( size );

		for ( let i = 0; i < totalMaterials; i ++ ) {

			const mat = materials[ i ];
			const stride = i * dataLengthPerMaterial;

			const mapMatrix = mat.mapMatrix ?? DEFAULT_TEXTURE_MATRIX;
			const normalMapMatrices = mat.normalMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const roughnessMapMatrices = mat.roughnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const metalnessMapMatrices = mat.metalnessMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const emissiveMapMatrices = mat.emissiveMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const bumpMapMatrices = mat.bumpMapMatrices ?? DEFAULT_TEXTURE_MATRIX;
			const displacementMapMatrices = mat.displacementMapMatrices ?? DEFAULT_TEXTURE_MATRIX;

			// Slot order: shadow/culling → BxDF core → maps → extended → displacement → transforms
			// Must match MATERIAL_DATA_LAYOUT in EngineDefaults.js exactly.
			const materialData = [
				// Slot 0: shadow core (ior, transmission, thickness, emissiveIntensity)
				mat.ior, 					mat.transmission, 			mat.thickness, 				mat.emissiveIntensity,
				// Slot 1: shadow (attenuationColor, attenuationDistance)
				mat.attenuationColor.r, 	mat.attenuationColor.g, 	mat.attenuationColor.b, 	normalizeAttenuationDistance( mat.attenuationDistance ),
				// Slot 2: shadow + culling (opacity, side, transparent, alphaTest)
				mat.opacity, 				mat.side, 					mat.transparent, 			mat.alphaTest,
				// Slot 3: shadow (alphaMode, depthWrite, normalScale)
				mat.alphaMode, 				mat.depthWrite, 			mat.normalScale?.x ?? 1, 	mat.normalScale?.y ?? 1,
				// Slot 4: BxDF core (color, metalness)
				mat.color.r, 				mat.color.g, 				mat.color.b, 				mat.metalness,
				// Slot 5: BxDF core (emissive, roughness)
				mat.emissive.r, 			mat.emissive.g, 			mat.emissive.b, 			mat.roughness,
				// Slot 6: map indices A (albedo, normal, roughness, metalness)
				mat.map, 					mat.normalMap, 				mat.roughnessMap, 			mat.metalnessMap,
				// Slot 7: map indices B (emissive, bump, clearcoat, clearcoatRoughness)
				mat.emissiveMap, 			mat.bumpMap, 				mat.clearcoat, 				mat.clearcoatRoughness,
				// Slot 8: extended BxDF (dispersion, visible, sheen, sheenRoughness)
				mat.dispersion, 			mat.visible, 				mat.sheen, 					mat.sheenRoughness,
				// Slot 9: extended BxDF (sheenColor, reserved)
				mat.sheenColor.r, 			mat.sheenColor.g, 			mat.sheenColor.b, 			1,
				// Slot 10: extended BxDF (specularIntensity, specularColor)
				mat.specularIntensity, 		mat.specularColor.r, 		mat.specularColor.g, 		mat.specularColor.b,
				// Slot 11: extended BxDF (iridescence)
				mat.iridescence, 			mat.iridescenceIOR, 		mat.iridescenceThicknessRange[ 0 ], mat.iridescenceThicknessRange[ 1 ],
				// Slot 12: displacement
				mat.bumpScale,				mat.displacementScale,		mat.displacementMap,		0,
				mapMatrix[ 0 ], 			mapMatrix[ 1 ], 			mapMatrix[ 2 ], 			mapMatrix[ 3 ],
				mapMatrix[ 4 ], 			mapMatrix[ 5 ], 			mapMatrix[ 6 ], 			mapMatrix[ 7 ],
				normalMapMatrices[ 0 ], 	normalMapMatrices[ 1 ], 	normalMapMatrices[ 2 ], 	normalMapMatrices[ 3 ],
				normalMapMatrices[ 4 ], 	normalMapMatrices[ 5 ], 	normalMapMatrices[ 6 ], 	normalMapMatrices[ 7 ],
				roughnessMapMatrices[ 0 ], 	roughnessMapMatrices[ 1 ], 	roughnessMapMatrices[ 2 ], 	roughnessMapMatrices[ 3 ],
				roughnessMapMatrices[ 4 ], 	roughnessMapMatrices[ 5 ], 	roughnessMapMatrices[ 6 ], 	roughnessMapMatrices[ 7 ],
				metalnessMapMatrices[ 0 ], 	metalnessMapMatrices[ 1 ], 	metalnessMapMatrices[ 2 ], 	metalnessMapMatrices[ 3 ],
				metalnessMapMatrices[ 4 ], 	metalnessMapMatrices[ 5 ], 	metalnessMapMatrices[ 6 ], 	metalnessMapMatrices[ 7 ],
				emissiveMapMatrices[ 0 ], 	emissiveMapMatrices[ 1 ], 	emissiveMapMatrices[ 2 ], 	emissiveMapMatrices[ 3 ],
				emissiveMapMatrices[ 4 ], 	emissiveMapMatrices[ 5 ], 	emissiveMapMatrices[ 6 ], 	emissiveMapMatrices[ 7 ],
				bumpMapMatrices[ 0 ], 		bumpMapMatrices[ 1 ], 		bumpMapMatrices[ 2 ], 		bumpMapMatrices[ 3 ],
				bumpMapMatrices[ 4 ], 		bumpMapMatrices[ 5 ],	 	bumpMapMatrices[ 6 ], 		bumpMapMatrices[ 7 ],
				displacementMapMatrices[ 0 ], displacementMapMatrices[ 1 ], displacementMapMatrices[ 2 ], displacementMapMatrices[ 3 ],
				displacementMapMatrices[ 4 ], displacementMapMatrices[ 5 ], displacementMapMatrices[ 6 ], displacementMapMatrices[ 7 ],
				// Slot 27: subsurface (subsurfaceColor.rgb, subsurface weight)
				mat.subsurfaceColor?.r ?? 1,	mat.subsurfaceColor?.g ?? 1,	mat.subsurfaceColor?.b ?? 1,	mat.subsurface ?? 0,
				// Slot 28: subsurface (subsurfaceRadius.rgb, subsurfaceRadiusScale)
				mat.subsurfaceRadius?.[ 0 ] ?? 1, mat.subsurfaceRadius?.[ 1 ] ?? 0.2, mat.subsurfaceRadius?.[ 2 ] ?? 0.1, mat.subsurfaceRadiusScale ?? 1,
				// Slot 29: subsurfaceAnisotropy g + surface anisotropy (strength, rotation, map index)
				mat.subsurfaceAnisotropy ?? 0,	mat.anisotropy ?? 0,	mat.anisotropyRotation ?? 0,	mat.anisotropyMap ?? - 1,
				// Slot 30: extension map indices A (transmission, clearcoat, clearcoatRoughness, sheenColor)
				mat.transmissionMap ?? - 1,	mat.clearcoatMap ?? - 1,	mat.clearcoatRoughnessMap ?? - 1,	mat.sheenColorMap ?? - 1,
				// Slot 31: extension map indices B (sheenRoughness, iridescence, iridescenceThickness, specularIntensity)
				mat.sheenRoughnessMap ?? - 1,	mat.iridescenceMap ?? - 1,	mat.iridescenceThicknessMap ?? - 1,	mat.specularIntensityMap ?? - 1,
				// Slot 32: extension map indices C (specularColor + 3 reserved)
				mat.specularColorMap ?? - 1,	0,	0,	0,
			];

			data.set( materialData, stride );

		}

		return data;

	}

	/**
	 * Build raw BVH Float32Array without DataTexture wrapping.
	 * Used by WebGPU backend which feeds data into storage buffers.
	 */
	createBVHRawData( bvhRoot ) {

		const nodes = [];
		const flattenBVH = ( node ) => {

			const nodeIndex = nodes.length;
			nodes.push( node );
			if ( node.leftChild ) {

				const leftIndex = flattenBVH( node.leftChild );
				const rightIndex = flattenBVH( node.rightChild );
				node.leftChild = leftIndex;
				node.rightChild = rightIndex;

			}

			return nodeIndex;

		};

		flattenBVH( bvhRoot );

		// Layout: 4 vec4 per node (16 floats)
		// Inner: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		// Leaf:  [triOffset, triCount, 0, -1] [0,0,0,0] [0,0,0,0] [0,0,0,0]
		const floatsPerNode = TEXTURE_CONSTANTS.VEC4_PER_BVH_NODE * TEXTURE_CONSTANTS.FLOATS_PER_VEC4;
		const size = nodes.length * floatsPerNode;
		const data = new Float32Array( size );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const stride = i * floatsPerNode;
			const node = nodes[ i ];

			if ( node.leftChild !== null ) {

				// Inner node: leftChild/rightChild are now flat indices after recursive pass
				const leftIdx = node.leftChild;
				const rightIdx = node.rightChild;
				const left = nodes[ leftIdx ];
				const right = nodes[ rightIdx ];

				data[ stride ] = left.boundsMin.x;
				data[ stride + 1 ] = left.boundsMin.y;
				data[ stride + 2 ] = left.boundsMin.z;
				data[ stride + 3 ] = leftIdx;

				data[ stride + 4 ] = left.boundsMax.x;
				data[ stride + 5 ] = left.boundsMax.y;
				data[ stride + 6 ] = left.boundsMax.z;
				data[ stride + 7 ] = rightIdx;

				data[ stride + 8 ] = right.boundsMin.x;
				data[ stride + 9 ] = right.boundsMin.y;
				data[ stride + 10 ] = right.boundsMin.z;

				data[ stride + 12 ] = right.boundsMax.x;
				data[ stride + 13 ] = right.boundsMax.y;
				data[ stride + 14 ] = right.boundsMax.z;

			} else {

				// Leaf node
				data[ stride ] = node.triangleOffset;
				data[ stride + 1 ] = node.triangleCount;
				data[ stride + 3 ] = - 1; // Leaf marker

			}

		}

		return data;

	}

	/**
	 * Create only material and texture-related textures (excludes triangle and BVH textures)
	 * @param {Object} params - Parameters object
	 * @returns {Promise<Object>} - Object containing created textures
	 */
	async createMaterialTextures( params ) {

		const { materials, maps, normalMaps, bumpMaps, roughnessMaps, metalnessMaps, emissiveMaps, displacementMaps } = params;

		console.log( '[TextureCreator] Creating material textures only' );
		const startTime = performance.now();

		try {

			// Validate inputs
			if ( ! materials || materials.length === 0 ) {

				throw new Error( 'No materials provided for texture creation' );

			}

			// Clear any cached textures that might interfere
			this.textureCache.dispose();
			this.textureCache = new TextureCache();

			// Create texture arrays
			const texturePromises = [];

			if ( maps && maps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( maps )
						.then( tex => ( { type: 'albedo', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'albedo', error );
							return { type: 'albedo', texture: null };

						} )
				);

			}

			if ( normalMaps && normalMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( normalMaps )
						.then( tex => ( { type: 'normal', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'normal', error );
							return { type: 'normal', texture: null };

						} )
				);

			}

			if ( bumpMaps && bumpMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( bumpMaps )
						.then( tex => ( { type: 'bump', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'bump', error );
							return { type: 'bump', texture: null };

						} )
				);

			}

			if ( roughnessMaps && roughnessMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( roughnessMaps )
						.then( tex => ( { type: 'roughness', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'roughness', error );
							return { type: 'roughness', texture: null };

						} )
				);

			}

			if ( metalnessMaps && metalnessMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( metalnessMaps )
						.then( tex => ( { type: 'metalness', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'metalness', error );
							return { type: 'metalness', texture: null };

						} )
				);

			}

			if ( emissiveMaps && emissiveMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( emissiveMaps )
						.then( tex => ( { type: 'emissive', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'emissive', error );
							return { type: 'emissive', texture: null };

						} )
				);

			}

			if ( displacementMaps && displacementMaps.length > 0 ) {

				texturePromises.push(
					this.createTexturesToDataTexture( displacementMaps )
						.then( tex => ( { type: 'displacement', texture: tex } ) )
						.catch( error => {

							this._reportTextureFailure( 'displacement', error );
							return { type: 'displacement', texture: null };

						} )
				);

			}

			// Wait for all texture arrays to complete
			const textureResults = await Promise.allSettled( texturePromises );

			// allSettled swallows rejections by design, which would silently absorb a strict
			// host's EngineIssueError and let the load finish with missing maps anyway.
			const refused = textureResults.find( ( r ) => r.status === 'rejected' );
			if ( refused ) throw refused.reason;

			// Organize results
			const textures = {};

			// Process texture results (successful or failed)
			textureResults.forEach( ( result ) => {

				if ( result.status === 'fulfilled' && result.value ) {

					const { type, texture } = result.value;

					if ( texture ) {

						switch ( type ) {

							case 'albedo': texture.colorSpace = SRGBColorSpace; textures.albedoTexture = texture; break;
							case 'normal': textures.normalTexture = texture; break;
							case 'bump': textures.bumpTexture = texture; break;
							case 'roughness': textures.roughnessTexture = texture; break;
							case 'metalness': textures.metalnessTexture = texture; break;
							case 'emissive': texture.colorSpace = SRGBColorSpace; textures.emissiveTexture = texture; break;
							case 'displacement': textures.displacementTexture = texture; break;

						}

					}

				}

			} );

			const duration = performance.now() - startTime;
			console.log( `[TextureCreator] Material texture creation complete (${duration.toFixed( 2 )}ms)` );

			return textures;

		} catch ( error ) {

			console.error( '[TextureCreator] Material texture creation error:', error );
			throw new Error( `Material texture creation failed: ${error.message}` );

		}

	}

	// Helper methods
	calculateOptimalDimensions( textures ) {

		let maxWidth = 0;
		let maxHeight = 0;

		for ( const texture of textures ) {

			maxWidth = Math.max( maxWidth, texture.image.width );
			maxHeight = Math.max( maxHeight, texture.image.height );

		}

		maxWidth = Math.pow( 2, Math.ceil( Math.log2( maxWidth ) ) );
		maxHeight = Math.pow( 2, Math.ceil( Math.log2( maxHeight ) ) );

		// Halve only while a dimension exceeds the cap (preserves native res up to the cap).
		while ( maxWidth > this.maxTextureSize || maxHeight > this.maxTextureSize ) {

			maxWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
			maxHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

		}

		return { maxWidth, maxHeight };

	}

	createDataArrayTextureFromResult( result ) {

		const textureData = result.data instanceof ArrayBuffer ?
			new Uint8Array( result.data ) : new Uint8Array( result.data );

		return this.createDataArrayTextureFromBuffer( textureData, result.width, result.height, result.depth );

	}

	createDataArrayTextureFromBuffer( data, width, height, depth ) {

		const texture = new DataArrayTexture( data, width, height, depth );

		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		// glTF's default sampler wrap is REPEAT; array layers are independent (not an atlas),
		// so per-layer repeat is safe and lets tiling UVs (outside [0,1]) tile instead of
		// clamping. MIRRORED_REPEAT / per-texture wrap is a follow-up (not stored per-slot yet).
		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

		// Enhanced disposal
		texture.userData = { buffer: data, bufferType: Uint8Array };
		const originalDispose = texture.dispose.bind( texture );
		texture.dispose = () => {

			if ( texture.userData.buffer ) {

				this.bufferPool.releaseBuffer( texture.userData.buffer, texture.userData.bufferType );
				texture.userData.buffer = null;

			}

			originalDispose();

		};

		return texture;

	}

	// ── KTX2 / DataTexture normalization ────────────────────────────────

	/**
	 * Normalize textures so every entry has a drawable `.image`.
	 * - RGBA CompressedTexture (KTX2 Basis → RGBA): pixel data from mipmaps[0]
	 * - GPU-compressed texture (BC7/ASTC/ETC2): warning (should be pre-decompressed)
	 * - DataTexture (raw RGBA pixels): pixel data from image.data
	 * - Regular texture: passed through as-is
	 *
	 * Bitmap creation is parallelized via Promise.all.
	 */
	async _normalizeTexturesForProcessing( textures ) {

		const normalized = [];
		const bitmapsToClose = [];
		const bitmapJobs = []; // { index, promise }

		for ( const tex of textures ) {

			if ( ! tex?.image ) continue;

			// RGBA CompressedTexture (KTX2 Basis transcode wraps output as CompressedTexture)
			if ( tex.isCompressedTexture && tex.format === RGBAFormat && tex.mipmaps?.[ 0 ]?.data ) {

				const mip = tex.mipmaps[ 0 ];
				const idx = normalized.length;
				normalized.push( null ); // placeholder — filled after Promise.all
				bitmapJobs.push( { index: idx, flipY: tex.flipY, promise: _rawPixelsToBitmap( mip.data, mip.width, mip.height ) } );
				continue;

			}

			// True GPU-compressed texture in a mixed group — can't extract pixels on CPU.
			// All-compressed groups are handled by the CompressedArrayTexture path upstream.
			if ( tex.isCompressedTexture ) {

				console.warn( '[TextureCreator] GPU-compressed texture in mixed group — using placeholder' );
				normalized.push( null );
				continue;

			}

			// DataTexture with raw pixel array
			if ( tex.image.data && ! ( tex.image instanceof HTMLImageElement ) &&
				! ( tex.image instanceof HTMLCanvasElement ) &&
				! ( typeof ImageBitmap !== 'undefined' && tex.image instanceof ImageBitmap ) ) {

				const idx = normalized.length;
				normalized.push( null );
				bitmapJobs.push( { index: idx, flipY: tex.flipY, promise: _rawPixelsToBitmap( tex.image.data, tex.image.width, tex.image.height ) } );
				continue;

			}

			normalized.push( tex );

		}

		// Resolve all bitmap conversions in parallel
		if ( bitmapJobs.length > 0 ) {

			const results = await Promise.allSettled( bitmapJobs.map( j => j.promise ) );

			for ( let i = 0; i < bitmapJobs.length; i ++ ) {

				const { index, flipY } = bitmapJobs[ i ];
				const result = results[ i ];

				if ( result.status === 'fulfilled' ) {

					const bitmap = result.value;
					bitmapsToClose.push( bitmap );
					normalized[ index ] = { image: bitmap, flipY };

				} else {

					console.warn( '[TextureCreator] Failed to create ImageBitmap:', result.reason );

				}

			}

		}

		// Replace any remaining nulls (failed conversions) with a 1x1 white placeholder
		// to preserve array indexing alignment with material texture indices.
		for ( let i = 0; i < normalized.length; i ++ ) {

			if ( normalized[ i ] === null ) {

				const placeholder = new Uint8ClampedArray( [ 255, 255, 255, 255 ] );
				const bitmap = await createImageBitmap( new ImageData( placeholder, 1, 1 ) );
				bitmapsToClose.push( bitmap );
				normalized[ i ] = { image: bitmap, flipY: false };

			}

		}

		return { normalized, bitmapsToClose };

	}

	createFallbackTexture() {

		const data = new Uint8Array( [ 255, 255, 255, 255 ] );
		const texture = new DataArrayTexture( data, 1, 1, 1 );

		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		texture.format = RGBAFormat;
		texture.type = UnsignedByteType;
		texture.needsUpdate = true;
		texture.generateMipmaps = false;

		return texture;

	}

	dispose() {

		this.canvasPool.dispose();
		this.bufferPool.dispose();
		this.textureCache.dispose();

	}

}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert raw RGBA pixel data to an ImageBitmap (zero-copy Uint8ClampedArray view). */
function _rawPixelsToBitmap( data, width, height ) {

	const clamped = new Uint8ClampedArray( data.buffer, data.byteOffset, data.byteLength );
	return createImageBitmap( new ImageData( clamped, width, height ) );

}

