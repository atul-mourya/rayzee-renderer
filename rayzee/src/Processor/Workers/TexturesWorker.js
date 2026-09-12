let canvas, ctx;

// Memory limits and chunking configuration
const MEMORY_LIMITS = {
	MAX_BYTES_PER_TEXTURE: 256 * 1024 * 1024, // 256MB per texture array
	MAX_TEXTURE_DIMENSION: 8192, // Hardware ceiling (WebGPU maxTextureDimension2D guaranteed min); the per-scene maxTextureSize setting is the actual knob
	CHUNK_SIZE: 8, // Optimized: Process textures in chunks of 8 for better memory locality
	ADAPTIVE_CHUNK_SIZE: true, // Enable adaptive chunk sizing based on texture dimensions
	MEMORY_SAFETY_FACTOR: 0.8 // Use only 80% of estimated available memory
};

self.onmessage = async function ( e ) {

	const { textures, maxTextureSize, method = 'direct-transfer' } = e.data;

	try {

		// Initialize on first use
		if ( ! canvas ) {

			initializeWorker( maxTextureSize );

		}

		const result = await processTextures( textures, maxTextureSize, method );

		// Transfer ownership for zero-copy
		self.postMessage( result, [ result.data ] );

	} catch ( error ) {

		console.error( 'Worker processing failed:', error );
		self.postMessage( { error: error.message } );

	}

};

function initializeWorker( maxTextureSize ) {

	// Initialize OffscreenCanvas with optimal settings
	const size = Math.min( maxTextureSize, MEMORY_LIMITS.MAX_TEXTURE_DIMENSION );
	canvas = new OffscreenCanvas( size, size );
	ctx = canvas.getContext( '2d', {
		willReadFrequently: true,
		alpha: true,
		desynchronized: true
	} );

}

async function processTextures( textures, maxTextureSize, method ) {

	// Check if we need to use chunked processing
	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const estimatedBytes = dimensions.maxWidth * dimensions.maxHeight * textures.length * 4;

	if ( estimatedBytes > MEMORY_LIMITS.MAX_BYTES_PER_TEXTURE ) {

		console.log( `Large texture array detected (${( estimatedBytes / 1024 / 1024 ).toFixed( 2 )}MB), using chunked processing` );
		return await processTexturesInChunks( textures, maxTextureSize, method );

	}

	switch ( method ) {

		case 'direct-transfer':
			return await processWithDirectTransfer( textures, maxTextureSize );
		case 'offscreen-optimized':
			return await processWithOffscreenOptimized( textures, maxTextureSize );
		case 'imageBitmap-batch':
			return await processWithImageBitmapBatch( textures, maxTextureSize );
		default:
			return await processWithDirectTransfer( textures, maxTextureSize );

	}

}

async function processTexturesInChunks( textures, maxTextureSize, method ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;
	const depth = textures.length;

	// Optimize chunk size based on texture dimensions and memory constraints
	const chunkSize = calculateOptimalChunkSize( maxWidth, maxHeight, depth );
	const numChunks = Math.ceil( depth / chunkSize );

	console.log( `Processing ${depth} textures in ${numChunks} chunks of up to ${chunkSize} textures each` );
	console.log( `Texture dimensions: ${maxWidth}x${maxHeight}, Est. memory per chunk: ${( maxWidth * maxHeight * chunkSize * 4 / 1024 / 1024 ).toFixed( 2 )}MB` );

	// Allocate the full output array
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch {

		// If full allocation fails, fall back to reduced dimensions
		console.warn( 'Failed to allocate full texture array, reducing dimensions' );
		const reducedDimensions = calculateReducedDimensions( textures, maxTextureSize );
		return await processWithReducedDimensions( textures, reducedDimensions, method );

	}

	// Pre-allocate chunk buffer for reuse
	const chunkBufferSize = maxWidth * maxHeight * chunkSize * 4;
	let chunkBuffer;

	try {

		chunkBuffer = new Uint8Array( chunkBufferSize );

	} catch {

		console.warn( 'Failed to allocate chunk buffer, reducing dimensions' );
		const reducedDimensions = calculateReducedDimensions( textures, maxTextureSize );
		return await processWithReducedDimensions( textures, reducedDimensions, method );

	}

	// Process each chunk with optimized memory reuse
	for ( let chunkIndex = 0; chunkIndex < numChunks; chunkIndex ++ ) {

		const startIdx = chunkIndex * chunkSize;
		const endIdx = Math.min( startIdx + chunkSize, depth );
		const actualChunkSize = endIdx - startIdx;
		const chunkTextures = textures.slice( startIdx, endIdx );

		const chunkResult = await processTextureChunkOptimized(
			chunkTextures,
			maxWidth,
			maxHeight,
			chunkBuffer.subarray( 0, maxWidth * maxHeight * actualChunkSize * 4 )
		);

		// Copy chunk data to main array
		const offset = startIdx * maxWidth * maxHeight * 4;
		const copySize = actualChunkSize * maxWidth * maxHeight * 4;
		data.set( new Uint8Array( chunkResult.data.slice( 0, copySize ) ), offset );

		// Micro-yield to prevent blocking the thread

		if ( chunkIndex % 2 === 1 ) { // Yield every 2 chunks instead of every chunk

			await new Promise( resolve => setTimeout( resolve, 0 ) );

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

function calculateOptimalChunkSize( maxWidth, maxHeight, totalTextures ) {

	if ( ! MEMORY_LIMITS.ADAPTIVE_CHUNK_SIZE ) {

		return Math.min( MEMORY_LIMITS.CHUNK_SIZE, totalTextures );

	}

	// Calculate memory per texture in MB
	const bytesPerTexture = maxWidth * maxHeight * 4;
	const mbPerTexture = bytesPerTexture / ( 1024 * 1024 );

	// Adaptive chunk sizing based on texture size
	let optimalChunkSize;

	if ( mbPerTexture <= 1 ) { // Small textures (<=1MB)

		optimalChunkSize = 16; // Process more at once

	} else if ( mbPerTexture <= 4 ) { // Medium textures (1-4MB)

		optimalChunkSize = 8; // Balanced approach

	} else if ( mbPerTexture <= 16 ) { // Large textures (4-16MB)

		optimalChunkSize = 4; // Conservative

	} else { // Very large textures (>16MB)

		optimalChunkSize = 2; // Very conservative

	}

	// Don't exceed total texture count or configured limits
	return Math.min( optimalChunkSize, totalTextures, MEMORY_LIMITS.CHUNK_SIZE * 2 );

}

async function processTextureChunkOptimized( textures, maxWidth, maxHeight, outputBuffer ) {

	// Resize canvas for this chunk if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	// Use provided buffer to avoid allocation
	const bytesPerTexture = maxWidth * maxHeight * 4;

	// Optimize context settings once per chunk
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	// Process textures with optimized single texture processing
	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			const offset = i * bytesPerTexture;
			await processSingleTextureOptimized( textureData, outputBuffer, offset, maxWidth, maxHeight );

		} catch ( error ) {

			console.warn( `Failed to process texture ${i}:`, error );
			// Fill with transparent pixels as fallback
			const offset = i * bytesPerTexture;
			outputBuffer.fill( 0, offset, offset + bytesPerTexture );

		}

	}

	return {
		data: outputBuffer.buffer,
		width: maxWidth,
		height: maxHeight,
		depth: textures.length
	};

}

async function processSingleTextureOptimized( textureData, outputData, offset, maxWidth, maxHeight ) {

	let imageBitmap;

	if ( textureData.isDirect && textureData.bitmap ) {

		// Direct ImageBitmap transfer - no conversion needed!
		imageBitmap = textureData.bitmap;

	} else if ( textureData.isImageData && textureData.data ) {

		// Direct ImageData transfer - minimal conversion
		const imageData = new ImageData(
			new Uint8ClampedArray( textureData.data ),
			textureData.width,
			textureData.height
		);

		imageBitmap = await createImageBitmap( imageData, {
			resizeWidth: maxWidth,
			resizeHeight: maxHeight,
			resizeQuality: 'high'
		} );

	} else if ( textureData.isBlob ) {

		// Legacy blob processing (fallback)
		const blob = new Blob( [ textureData.data ] );
		imageBitmap = await createImageBitmap( blob, {
			resizeWidth: maxWidth,
			resizeHeight: maxHeight,
			resizeQuality: 'high'
		} );

	} else {

		throw new Error( 'Unknown texture data format' );

	}

	// Clear and draw to canvas
	ctx.clearRect( 0, 0, maxWidth, maxHeight );
	ctx.drawImage( imageBitmap, 0, 0, maxWidth, maxHeight );

	// Get image data efficiently
	const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );

	// Copy directly to the specified offset in output buffer
	outputData.set( imageData.data, offset );

	// Clean up ImageBitmap if we created it
	if ( textureData.isImageData || textureData.isBlob ) {

		imageBitmap.close();

	}

}

async function processTextureChunk( textures, maxWidth, maxHeight ) {

	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * textures.length * 4 );

	} catch ( error ) {

		console.warn( 'Failed to allocate texture array in processTextureChunk, reducing dimensions' );
		const nextWidth = Math.max( 1, Math.floor( maxWidth / 2 ) );
		const nextHeight = Math.max( 1, Math.floor( maxHeight / 2 ) );

		if ( nextWidth === maxWidth && nextHeight === maxHeight ) {

			throw error;

		}

		return await processTextureChunk( textures, nextWidth, nextHeight );

	}

	return await processTextureChunkOptimized( textures, maxWidth, maxHeight, data );

}

async function processSingleTexture( textureData, index, outputData, maxWidth, maxHeight ) {

	const offset = maxWidth * maxHeight * 4 * index;
	await processSingleTextureOptimized( textureData, outputData, offset, maxWidth, maxHeight );

}

async function processWithDirectTransfer( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	// Resize canvas if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	const depth = textures.length;

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'direct-transfer' );

	}

	// Optimize context settings for batch processing
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			await processSingleTexture( textureData, i, data, maxWidth, maxHeight );

		} catch ( error ) {

			console.warn( `Failed to process texture ${i}:`, error );
			// Fill with transparent pixels as fallback
			const offset = maxWidth * maxHeight * 4 * i;
			data.fill( 0, offset, offset + maxWidth * maxHeight * 4 );

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

async function processWithReducedDimensions( textures, dimensions, method ) {

	const { maxWidth, maxHeight } = dimensions;
	console.log( `Using reduced dimensions: ${maxWidth}x${maxHeight}` );

	// Process with reduced dimensions
	return await processTextureChunk( textures, maxWidth, maxHeight, method );

}

async function processWithOffscreenOptimized( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	// Resize canvas if needed
	if ( canvas.width !== maxWidth || canvas.height !== maxHeight ) {

		canvas.width = maxWidth;
		canvas.height = maxHeight;

	}

	const depth = textures.length;

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'offscreen-optimized' );

	}

	// Optimize context settings for batch processing
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';

	for ( let i = 0; i < textures.length; i ++ ) {

		const textureData = textures[ i ];

		try {

			let imageBitmap;

			if ( textureData.isBlob ) {

				// Create ImageBitmap from blob data
				const blob = new Blob( [ textureData.data ] );
				imageBitmap = await createImageBitmap( blob, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			} else {

				// Handle direct image data
				const imageData = new ImageData(
					new Uint8ClampedArray( textureData.data ),
					textureData.width,
					textureData.height
				);
				imageBitmap = await createImageBitmap( imageData, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			}

			// Clear and draw to canvas
			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( imageBitmap, 0, 0 );

			// Get image data efficiently
			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );

			// Copy to output array
			const offset = maxWidth * maxHeight * 4 * i;
			data.set( imageData.data, offset );

			// Clean up ImageBitmap
			imageBitmap.close();

		} catch ( error ) {

			console.warn( `Failed to process texture ${i}:`, error );
			// Fill with transparent pixels as fallback
			const offset = maxWidth * maxHeight * 4 * i;
			data.fill( 0, offset, offset + maxWidth * maxHeight * 4 );

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

async function processWithImageBitmapBatch( textures, maxTextureSize ) {

	const dimensions = calculateOptimalDimensions( textures, maxTextureSize );
	const { maxWidth, maxHeight } = dimensions;

	const depth = textures.length;

	// Try to allocate memory with fallback
	let data;
	try {

		data = new Uint8Array( maxWidth * maxHeight * depth * 4 );

	} catch ( error ) {

		console.error( 'Failed to allocate texture array:', error );
		// Fall back to chunked processing
		return await processTexturesInChunks( textures, maxTextureSize, 'imageBitmap-batch' );

	}

	// Process in batches for memory efficiency - optimized batch size
	const batchSize = Math.min( calculateOptimalChunkSize( maxWidth, maxHeight, textures.length ), textures.length );

	for ( let batchStart = 0; batchStart < textures.length; batchStart += batchSize ) {

		const batchEnd = Math.min( batchStart + batchSize, textures.length );
		const batchPromises = [];

		// Create all ImageBitmaps for this batch in parallel
		for ( let i = batchStart; i < batchEnd; i ++ ) {

			const textureData = textures[ i ];

			let bitmapPromise;
			if ( textureData.isBlob ) {

				const blob = new Blob( [ textureData.data ] );
				bitmapPromise = createImageBitmap( blob, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			} else {

				const imageData = new ImageData(
					new Uint8ClampedArray( textureData.data ),
					textureData.width,
					textureData.height
				);
				bitmapPromise = createImageBitmap( imageData, {
					resizeWidth: maxWidth,
					resizeHeight: maxHeight,
					resizeQuality: 'high'
				} );

			}

			batchPromises.push(
				bitmapPromise.then( bitmap => ( { bitmap, index: i } ) )
			);

		}

		// Wait for all bitmaps in this batch
		const bitmaps = await Promise.all( batchPromises );

		// Process each bitmap
		canvas.width = maxWidth;
		canvas.height = maxHeight;
		ctx.imageSmoothingEnabled = false; // Fast processing for batches

		for ( const { bitmap, index } of bitmaps ) {

			ctx.clearRect( 0, 0, maxWidth, maxHeight );
			ctx.drawImage( bitmap, 0, 0 );

			const imageData = ctx.getImageData( 0, 0, maxWidth, maxHeight );
			const offset = maxWidth * maxHeight * 4 * index;
			data.set( imageData.data, offset );

			bitmap.close();

		}

	}

	return {
		data: data.buffer,
		width: maxWidth,
		height: maxHeight,
		depth
	};

}

function calculateOptimalDimensions( textures, maxTextureSize ) {

	let maxWidth = 0;
	let maxHeight = 0;

	for ( let texture of textures ) {

		maxWidth = Math.max( maxWidth, texture.width || 0 );
		maxHeight = Math.max( maxHeight, texture.height || 0 );

	}

	// Scale down proportionally only when the cap is exceeded; native res is kept below it.
	const cap = Math.min( maxTextureSize, MEMORY_LIMITS.MAX_TEXTURE_DIMENSION );
	const longest = Math.max( maxWidth, maxHeight );
	if ( longest > cap ) {

		const scale = cap / longest;
		maxWidth = Math.round( maxWidth * scale );
		maxHeight = Math.round( maxHeight * scale );

	}

	// An RGBA8 row upload must be a multiple of 256 bytes, so widths land on 64 texels.
	// Mirrors alignBucketWidth in EngineDefaults (not importable from worker context).
	maxWidth = Math.min( cap, Math.max( 4, Math.ceil( Math.max( 1, maxWidth ) / 64 ) * 64 ) );

	return { maxWidth, maxHeight: Math.max( 1, maxHeight ) };

}

function calculateReducedDimensions( textures, maxTextureSize ) {

	// Calculate dimensions but reduce by factor of 2 for memory safety
	const original = calculateOptimalDimensions( textures, maxTextureSize );

	return {
		maxWidth: Math.max( 64, Math.ceil( original.maxWidth / 128 ) * 64 ),
		maxHeight: Math.max( 1, Math.floor( original.maxHeight / 2 ) )
	};

}

