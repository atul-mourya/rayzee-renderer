import { GoogleGenAI } from '@google/genai';

class AIImageGenerator {

	constructor() {

		this.genAI = null;
		this.initialized = false;

	}

	async initialize( apiKey ) {

		try {

			this.genAI = new GoogleGenAI( {
				apiKey: apiKey,
			} );
			this.initialized = true;
			return true;

		} catch ( error ) {

			console.error( 'Failed to initialize Gemini API:', error );
			return false;

		}

	}

	async generateImage( prompt, inputImage = null ) {

		if ( ! this.initialized ) {

			throw new Error( 'Gemini API not initialized. Please provide an API key.' );

		}

		try {

			const config = {
				responseModalities: [ 'IMAGE', 'TEXT' ],
			};
			const model = 'gemini-nano-banana-2.1';

			let parts = [];

			if ( inputImage ) {

				// For image-to-image generation
				const imageData = await this.prepareImageData( inputImage );
				parts.push( {
					inlineData: {
						data: imageData,
						mimeType: 'image/jpeg'
					}
				} );
				parts.push( {
					text: `Based on this image, ${prompt}. Generate a modified version of this image.`
				} );

			} else {

				// For text-to-image generation
				parts.push( {
					text: `Generate an image: ${prompt}`
				} );

			}

			const contents = [
				{
					role: 'user',
					parts: parts,
				},
			];

			const response = await this.genAI.models.generateContent( {
				model,
				config,
				contents,
			} );

			let generatedImageData = null;
			let textResponse = '';

			// Any part may hold the image; thought parts hold drafts
			for ( const part of response.candidates?.[ 0 ]?.content?.parts ?? [] ) {

				if ( part.thought ) continue;

				if ( part.inlineData?.data ) {

					generatedImageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;

				} else if ( part.text ) {

					textResponse += part.text;

				}

			}

			if ( ! generatedImageData ) {

				throw new Error( 'No image data received from Gemini' );

			}

			return {
				success: true,
				text: textResponse || `Generated image for: "${prompt}"`,
				imageUrl: generatedImageData
			};

		} catch ( error ) {

			console.error( 'Error generating with Gemini:', error );

			// Check if it's a quota error for better user messaging
			const isQuotaError = error.message.includes( '429' ) ||
								error.message.includes( 'quota' ) ||
								error.message.includes( 'RESOURCE_EXHAUSTED' );

			if ( isQuotaError ) {

				// Extract retry time from error message if available
				const retryMatch = error.message.match( /retry in ([\d.]+)s/ );
				const retryTime = retryMatch ? parseFloat( retryMatch[ 1 ] ) : null;

				return {
					success: false,
					error: 'Quota limit exceeded',
					quotaError: true,
					retryAfter: retryTime,
					message: 'You have reached the free tier limit for image generation. Please wait before trying again or consider upgrading your plan.'
				};

			}

			return {
				success: false,
				error: error.message
			};

		}

	}

	async prepareImageData( imageSource ) {

		// Handle different image input types
		if ( typeof imageSource === 'string' ) {

			// If it's a base64 string, extract the data part
			if ( imageSource.startsWith( 'data:image/' ) ) {

				return imageSource.split( ',' )[ 1 ];

			}

			// If it's a URL, fetch and convert
			const response = await fetch( imageSource );
			const blob = await response.blob();
			return await this.blobToBase64( blob );

		} else if ( imageSource instanceof Blob ) {

			return await this.blobToBase64( imageSource );

		}

		return imageSource;

	}

	async blobToBase64( blob ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onloadend = () => {

				const base64 = reader.result.split( ',' )[ 1 ];
				resolve( base64 );

			};

			reader.onerror = reject;
			reader.readAsDataURL( blob );

		} );

	}

}

export const geminiImageGenerator = new AIImageGenerator();
