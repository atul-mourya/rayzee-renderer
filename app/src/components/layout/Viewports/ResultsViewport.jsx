import { useRef, useEffect, useState, forwardRef, useMemo, useCallback } from 'react';
import { debounce } from '@/utils/debounce';
import { RotateCcw, Save, Eye, Image as ImageIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useToast } from '@/hooks/use-toast';
import { useStore } from '@/store';
import { ImageProcessorComposer } from '@/utils/ImageProcessor';
import ViewportToolbar from './ViewportToolbar';
import { updateRender, getRenderHDR } from '@/utils/database';
import { useAutoFitScale } from '@/hooks/useAutoFitScale';
import { usePanZoom } from '@/hooks/usePanZoom';
import { generateViewportStyles } from '@/utils/viewport';

// Utility function to format render time (compact version)
const formatRenderTime = ( timeInSeconds ) => {

	if ( ! timeInSeconds || timeInSeconds <= 0 ) return null;

	const hours = Math.floor( timeInSeconds / 3600 );
	const minutes = Math.floor( ( timeInSeconds % 3600 ) / 60 );
	const seconds = Math.floor( timeInSeconds % 60 );

	// Compact format without spaces
	if ( hours > 0 ) {

		return `${hours}h${minutes}m${seconds}s`;

	} else if ( minutes > 0 ) {

		return `${minutes}m${seconds}s`;

	} else {

		return `${seconds}s`;

	}

};

const ResultsViewport = forwardRef( function ResultsViewport( props, ref ) {

	// Access store values directly to avoid selector issues
	const imageData = useStore( state => state.selectedResult );
	const imageProcessing = useStore( state => state.imageProcessing );
	const setImageProcessingParam = useStore( state => state.setImageProcessingParam );
	const setResultsViewportRef = useStore( state => state.setResultsViewportRef );

	// Hooks
	const { toast } = useToast();

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const aiCanvasRef = useRef( null );
	const imageProcessorRef = useRef( null );

	// Dynamic canvas size based on loaded image dimensions
	const [ actualCanvasWidth, setActualCanvasWidth ] = useState( 512 );
	const [ actualCanvasHeight, setActualCanvasHeight ] = useState( 512 );
	const [ imageLoadState, setImageLoadState ] = useState( { loaded: false, error: false } );
	const [ isImageDrawn, setIsImageDrawn ] = useState( false );
	const [ viewingOriginal, setViewingOriginal ] = useState( false );
	const [ selectedImageId, setSelectedImageId ] = useState( null );
	const [ originalSettings, setOriginalSettings ] = useState( null );
	const longPressActiveRef = useRef( false );
	const longPressTimeoutRef = useRef( null );
	const [ isHovering, setIsHovering ] = useState( false );
	const [ viewingAIVariant, setViewingAIVariant ] = useState( false );

	// Auto-fit scaling logic
	const {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit
	} = useAutoFitScale( {
		viewportRef,
		canvasWidth: actualCanvasWidth,
		canvasHeight: actualCanvasHeight,
		padding: 80,
		minScale: 5,
		maxScale: 300
	} );

	// Pan & scroll-zoom
	const {
		panOffset,
		isPanning,
		resetPan,
		handlePointerDown,
	} = usePanZoom( {
		viewportRef,
		viewportScale,
		onScaleChange: handleViewportResize,
		minScale: 5,
		maxScale: 300,
		enabled: !! imageData,
		suppressRef: longPressActiveRef,
	} );

	// Reset pan when auto-fit kicks in (viewport resize or explicit reset)
	useEffect( () => {

		if ( ! isManualScale ) resetPan();

	}, [ isManualScale, autoFitScale, resetPan ] );

	// Calculate if changes have been made using useMemo for efficiency
	const hasChanges = useMemo( () => {

		if ( ! originalSettings || ! imageProcessing ) return false;

		// Check if any property is different from original
		return Object.keys( originalSettings ).some( key =>
			originalSettings[ key ] !== imageProcessing[ key ]
		);

	}, [ originalSettings, imageProcessing ] );

	// Screenshot handler - defined early to avoid reference issues
	const handleScreenshot = useCallback( async () => {

		console.log( "Screenshot called in ResultsViewport" );

		// Check if we have image data
		if ( ! imageData ) {

			console.log( "No image data" );
			toast( {
				title: "No Image",
				description: "Please select an image first.",
				variant: "destructive",
			} );
			return;

		}

		// Determine which canvas to download
		const canvasToDownload = viewingOriginal ? originalCanvasRef.current : editedCanvasRef.current;

		console.log( "Canvas to download:", canvasToDownload, "viewingOriginal:", viewingOriginal );

		if ( ! canvasToDownload ) {

			console.log( "No canvas available" );
			toast( {
				title: "Error",
				description: "Canvas not available for screenshot.",
				variant: "destructive",
			} );
			return;

		}

		try {

			const blob = await new Promise( ( resolve, reject ) => canvasToDownload.toBlob( b => ( b ? resolve( b ) : reject( new Error( 'the canvas gave no image' ) ) ), 'image/png' ) );
			const url = URL.createObjectURL( blob );
			const link = document.createElement( 'a' );
			link.href = url;
			link.download = `raycanvas-${viewingOriginal ? 'original' : 'edited'}-${new Date().getTime()}.png`;
			link.click();
			URL.revokeObjectURL( url );

			console.log( "Screenshot download triggered" );

			toast( {
				title: "Screenshot Saved",
				description: `${viewingOriginal ? 'Original' : 'Edited'} image has been downloaded.`,
			} );

		} catch ( error ) {

			console.error( "Screenshot error:", error );
			toast( {
				title: "Screenshot Failed",
				description: "There was an error taking the screenshot.",
				variant: "destructive",
			} );

		}

	}, [ imageData, viewingOriginal, toast ] );

	// Expose ref functions
	useEffect( () => {

		if ( ! ref ) return;

		// In React 19, update the ref directly instead of using useImperativeHandle
		ref.current = {
			getCanvas: () => originalCanvasRef.current,
			getEditedCanvas: () => editedCanvasRef.current,
			getImageProcessor: () => imageProcessorRef.current,
			takeScreenshot: handleScreenshot
		};

		// Expose via store for real-time color correction (replaces window global)
		setResultsViewportRef( ref );

		// Cleanup store reference on unmount
		return () => {

			// Only clear if it's still our ref (avoid clearing a newer ref)
			if ( useStore.getState().resultsViewportRef === ref ) {

				setResultsViewportRef( null );

			}

		};

	}, [ ref, handleScreenshot ] );

	// Initialize image processor when canvases are ready
	useEffect( () => {

		if ( originalCanvasRef.current && editedCanvasRef.current && ! imageProcessorRef.current ) {

			imageProcessorRef.current = new ImageProcessorComposer(
				originalCanvasRef.current,
				editedCanvasRef.current
			);

		}

		return () => {

			if ( imageProcessorRef.current ) {

				imageProcessorRef.current.dispose();
				imageProcessorRef.current = null;

			}

		};

	}, [] );

	// Apply current image processing settings
	const applyImageProcessing = useCallback( () => {

		if ( ! imageProcessorRef.current ) return;

		const { brightness, contrast, saturation, hue, exposure, gamma } = imageProcessing;

		// Update all parameters at once for better performance
		imageProcessorRef.current.setParameters( {
			brightness,
			contrast,
			saturation,
			hue,
			exposure,
			gamma
		} );

		// Render the result
		imageProcessorRef.current.render();

	}, [ imageProcessing ] );

	// Create debounced version using useEffect
	const debouncedApplyRef = useRef();
	useEffect( () => {

		debouncedApplyRef.current = debounce( () => {

			if ( ! imageProcessorRef.current ) return;

			const { brightness, contrast, saturation, hue, exposure, gamma } = useStore.getState().imageProcessing;
			imageProcessorRef.current.setParameters( {
				brightness,
				contrast,
				saturation,
				hue,
				exposure,
				gamma
			} );
			imageProcessorRef.current.render();

		}, 50 );

		return () => {

			debouncedApplyRef.current?.cancel();

		};

	}, [] );

	// Optimized image loading for 4K images
	useEffect( () => {

		if ( ! originalCanvasRef.current || ! editedCanvasRef.current || ! aiCanvasRef.current || ! imageData || ! imageData.image ) {

			console.log( 'Missing required data for image loading:', {
				originalCanvas: !! originalCanvasRef.current,
				editedCanvas: !! editedCanvasRef.current,
				aiCanvas: !! aiCanvasRef.current,
				imageData: !! imageData,
				imageDataImage: !! imageData?.image
			} );
			return;

		}

		const originalCanvas = originalCanvasRef.current;
		const aiCanvas = aiCanvasRef.current;
		const originalCtx = originalCanvas.getContext( '2d' );
		const aiCtx = aiCanvas.getContext( '2d' );
		const abortController = new AbortController();

		// Clear canvases and reset state
		originalCtx.clearRect( 0, 0, originalCanvas.width, originalCanvas.height );
		aiCtx.clearRect( 0, 0, aiCanvas.width, aiCanvas.height );
		setIsImageDrawn( false );
		setImageLoadState( { loaded: false, error: false } );
		setViewingAIVariant( false );
		resetPan();

		// Create image with optimized loading
		const img = new Image();
		img.crossOrigin = 'anonymous'; // Enable CORS for 4K images

		// Direct image loading without complex async wrapper
		img.onload = () => {

			if ( abortController.signal.aborted ) return;

			try {

				// Set canvas buffer to match image dimensions (preserves aspect ratio and full resolution)
				// Note: editedCanvas dimensions are handled by ImageProcessor.resize()
				// to avoid disrupting its WebGL context
				originalCanvas.width = img.width;
				originalCanvas.height = img.height;
				aiCanvas.width = img.width;
				aiCanvas.height = img.height;

				// Calculate display dimensions (capped for on-screen display)
				const maxDim = 1024;
				const scale = Math.min( maxDim / img.width, maxDim / img.height, 1 );
				setActualCanvasWidth( Math.round( img.width * scale ) );
				setActualCanvasHeight( Math.round( img.height * scale ) );

				// Draw image at full size (canvas matches image, no letterboxing needed)
				originalCtx.drawImage( img, 0, 0 );

				// Load AI variant if it exists
				if ( imageData.aiGeneratedImage ) {

					const aiImg = new Image();
					aiImg.crossOrigin = 'anonymous';

					aiImg.onload = () => {

						if ( ! abortController.signal.aborted ) {

							aiCtx.drawImage( aiImg, 0, 0, aiCanvas.width, aiCanvas.height );

						}

					};

					aiImg.onerror = ( error ) => {

						console.error( 'Failed to load AI variant image:', error );

					};

					aiImg.src = imageData.aiGeneratedImage;

				}

				setIsImageDrawn( true );
				setImageLoadState( { loaded: true, error: false } );

				// Resize and update image processor for new dimensions
				if ( imageProcessorRef.current && ! abortController.signal.aborted ) {

					imageProcessorRef.current.resize( img.width, img.height );
					imageProcessorRef.current.quad.material.map.needsUpdate = true;

				}

				// Save the ID of the selected image for later use
				setSelectedImageId( imageData.id );

				// Store the original color correction settings
				const settings = { ...imageData.colorCorrection, gamma: imageData.colorCorrection.gamma ?? 2.2 };
				setOriginalSettings( settings );

				// Update color correction parameters in the store
				Object.keys( settings ).forEach( param => {

					setImageProcessingParam( param, settings[ param ] );

				} );

				// Default to edited view
				setViewingOriginal( false );

			} catch ( error ) {

				if ( ! abortController.signal.aborted ) {

					console.error( 'Error processing 4K image:', error );
					setImageLoadState( { loaded: false, error: true } );

				}

			}

		};

		img.onerror = ( error ) => {

			if ( ! abortController.signal.aborted ) {

				console.error( 'Failed to load 4K image:', imageData.image, error );
				setImageLoadState( { loaded: false, error: true } );

			}

		};

		img.src = imageData.image;

		return () => {

			abortController.abort();
			img.onload = null;
			img.onerror = null;

		};

	}, [ imageData, setImageProcessingParam, resetPan ] );

	// Apply image processing when parameters change (debounced for 4K performance)
	useEffect( () => {

		if ( isImageDrawn && imageProcessorRef.current ) {

			// Use direct application for immediate updates (real-time handlers will bypass this)
			applyImageProcessing();

		}

		// Cleanup debounce on unmount
		return () => {

			debouncedApplyRef.current?.cancel();

		};

	}, [ imageProcessing, isImageDrawn, applyImageProcessing ] );

	// Long press handling for original/edited view toggling
	const startLongPress = useCallback( () => {

		// Clear any existing timeout
		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );

		}

		// Start a timeout to activate long press
		longPressTimeoutRef.current = setTimeout( () => {

			setViewingOriginal( true );
			longPressActiveRef.current = true;

		}, 200 ); // 200ms delay for long press to activate

	}, [] );

	const endLongPress = useCallback( () => {

		// Clear the timeout
		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

		// If long press was active, switch back to edited view (read ref to avoid stale closure)
		if ( longPressActiveRef.current ) {

			setViewingOriginal( false );
			longPressActiveRef.current = false;

		}

	}, [] );

	// Cancel long press on mouse/touch move
	const cancelLongPress = useCallback( () => {

		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

	}, [] );

	// Cleanup timeout on unmount
	useEffect( () => {

		return () => {

			if ( longPressTimeoutRef.current ) {

				clearTimeout( longPressTimeoutRef.current );

			}

		};

	}, [] );

	// Memoize style objects with pan offset
	const { wrapperStyle: baseWrapperStyle, containerStyle } = useMemo( () =>
		generateViewportStyles( actualCanvasWidth, actualCanvasHeight, viewportScale ),
	[ actualCanvasWidth, actualCanvasHeight, viewportScale ]
	);

	const wrapperStyle = useMemo( () => ( {
		...baseWrapperStyle,
		transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${viewportScale / 100})`,
	} ), [ baseWrapperStyle, panOffset.x, panOffset.y, viewportScale ] );

	// UI handlers
	const resetImageProcessing = () => {

		// Check if we have original settings to reset to
		if ( originalSettings ) {

			// Reset each parameter to its original value
			Object.keys( originalSettings ).forEach( param => {

				useStore.getState().setImageProcessingParam( param, originalSettings[ param ] );

			} );

			toast( {
				title: "Processing Reset",
				description: "Image processing parameters have been reset to original values.",
			} );

		} else {

			// If no original settings, use the default reset
			useStore.getState().resetImageProcessing();

			toast( {
				title: "Processing Reset",
				description: "Image processing parameters have been reset to defaults.",
			} );

		}

	};

	const downloadHDR = async () => {

		const file = await getRenderHDR( selectedImageId );
		if ( ! file ) {

			toast( { title: 'No HDR copy', description: 'This render was saved without one.', variant: 'destructive' } );
			return;

		}

		const url = URL.createObjectURL( file );
		const link = document.createElement( 'a' );
		link.href = url;
		link.download = `render-${selectedImageId}.exr`;
		link.click();
		setTimeout( () => URL.revokeObjectURL( url ), 1000 );

	};

	// Save edited image with color correction settings
	const saveEditedImage = async () => {

		if ( ! imageData || ! editedCanvasRef.current ) return;

		try {

			const colorCorrectionSettings = { ...imageProcessing };
			await updateRender( selectedImageId, { colorCorrection: colorCorrectionSettings, isEdited: true } );

			// Update originalSettings to match the newly saved settings
			setOriginalSettings( { ...colorCorrectionSettings } );

			toast( {
				title: "Edited Image Saved",
				description: "Image with color correction settings has been saved.",
			} );

			// Dispatch event to refresh the results panel
			window.dispatchEvent( new Event( 'render-saved' ) );

		} catch ( error ) {

			console.error( "Error saving edited image:", error );
			toast( {
				title: "Error Saving Image",
				description: "There was a problem saving your edited image.",
				variant: "destructive",
			} );

		}

	};

	// Wrap auto-fit reset to also reset pan
	const handleResetToAutoFitWithPan = useCallback( () => {

		handleResetToAutoFit();
		resetPan();

	}, [ handleResetToAutoFit, resetPan ] );

	// Create a mock app ref for ViewportToolbar compatibility
	const mockAppRef = useRef( null );

	// Update mockAppRef when handleScreenshot changes
	useEffect( () => {

		mockAppRef.current = {
			takeScreenshot: handleScreenshot
		};

	}, [ handleScreenshot ] );

	return (
		<div
			ref={viewportRef}
			className="flex justify-center items-center h-full z-10"
			style={{ cursor: isPanning ? 'grabbing' : ( imageData ? 'grab' : 'default' ) }}
			onPointerDown={imageData ? handlePointerDown : undefined}
		>
			{/* Long press hint - only shows when hovering over the canvas or actively viewing original */}
			{imageData && ( isHovering || viewingOriginal ) && (
				<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-20">
					<div className="px-2 py-1 bg-black/80 rounded-md text-xs text-gray-300 flex items-center gap-1 shadow-md">
						<Eye size={12} className="text-gray-400" />
						{viewingOriginal ? "Viewing Original" : "Press & Hold to See Original"}
					</div>
				</div>
			)}

			{/* AI/Render toggle button - appears when AI variant exists */}
			{imageData && imageData.aiGeneratedImage && ! viewingOriginal && (
				<div className="absolute top-2 right-2 z-20 flex space-x-2">
					<button
						onClick={() => setViewingAIVariant( ! viewingAIVariant )}
						className="flex items-center justify-center bg-purple-600 hover:bg-purple-700 text-white px-3 py-1 rounded-md text-xs"
					>
						<ImageIcon size={12} className="mr-1" />
						{viewingAIVariant ? 'Show Render' : 'Show AI'}
					</button>
				</div>
			)}

			{imageData?.hasHDR && ! viewingOriginal && (
				<div className="absolute bottom-16 right-2 z-20">
					<button
						onClick={downloadHDR}
						title="Download the full-range image this render kept"
						className="flex items-center justify-center bg-secondary hover:bg-secondary/90 text-foreground px-3 py-1 rounded-full text-xs"
					>
						Download EXR
					</button>
				</div>
			)}

			{/* Save button only appears when changes have been made */}
			{imageData && hasChanges && ! viewingOriginal && ! viewingAIVariant && (
				<div className="absolute top-2 right-20 z-20 flex space-x-2">
					<button
						onClick={saveEditedImage}
						className="flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1 rounded-md text-xs"
					>
						<Save size={12} className="mr-1" />
						Save
					</button>
				</div>
			)}

			{/* Reset Processing button - specific to image editing */}
			{imageData && hasChanges && ! viewingOriginal && (
				<div className="absolute bottom-2 left-2 z-20">
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									onClick={resetImageProcessing}
									className="flex items-center justify-center bg-secondary hover:bg-secondary/90 text-foreground px-2 py-1 rounded-full text-xs h-8"
									disabled={! imageData || viewingOriginal || ! hasChanges}
								>
									<RotateCcw size={12} className={`${( ! imageData || viewingOriginal || ! hasChanges ) ? 'text-foreground/30' : 'text-foreground/70'}`} />
								</button>
							</TooltipTrigger>
							<TooltipContent>
								<p className="text-xs">Reset Processing</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			)}

			{/* Render time display */}
			{imageData && imageData.renderTime && ! viewingOriginal && (
				<div className={`absolute ${hasChanges ? 'bottom-2 left-12' : 'bottom-2 left-2'} z-20`}>
					<div className="px-2 py-1 bg-black/60 rounded-md text-xs text-gray-300 flex items-center gap-1">
						⏱ {formatRenderTime( imageData.renderTime )}
					</div>
				</div>
			)}

			{/* Viewport wrapper */}
			<div
				ref={viewportWrapperRef}
				className="relative"
				style={wrapperStyle}
				onMouseDown={imageData ? startLongPress : undefined}
				onTouchStart={imageData ? startLongPress : undefined}
				onMouseUp={imageData ? endLongPress : undefined}
				onMouseLeave={( e ) => {

					imageData && endLongPress( e );
					setIsHovering( false );

				}}
				onTouchEnd={imageData ? endLongPress : undefined}
				onMouseMove={imageData ? cancelLongPress : undefined}
				onTouchMove={imageData ? cancelLongPress : undefined}
				onMouseEnter={() => setIsHovering( true )}
			>
				{/* Container with fixed size */}
				<div
					ref={containerRef}
					className="relative"
					style={containerStyle}
				>
					{/* Loading indicator for 4K images */}
					{imageData && ! imageLoadState.loaded && ! imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
							<div className="flex flex-col items-center space-y-2">
								<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
								<p className="text-sm">Loading 4K image...</p>
							</div>
						</div>
					)}

					{/* Error state for 4K image loading */}
					{imageData && imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white">
							<div className="text-center">
								<p className="text-sm text-red-400 mb-2">Failed to load 4K image</p>
								<p className="text-xs text-gray-400">The image may be corrupted or too large</p>
							</div>
						</div>
					)}

					{/* Canvas for edited image - optimized for 4K */}
					<canvas
						ref={editedCanvasRef}
						style={{
							width: `${actualCanvasWidth}px`,
							height: `${actualCanvasHeight}px`,
							backgroundColor: 'black',
							display: ( viewingOriginal || viewingAIVariant || ! imageLoadState.loaded ) ? 'none' : 'block',
							imageRendering: 'pixelated' // Better for 4K images
						}}
					/>

					{/* Canvas for original image - optimized for 4K */}
					<canvas
						ref={originalCanvasRef}
						style={{
							width: `${actualCanvasWidth}px`,
							height: `${actualCanvasHeight}px`,
							backgroundColor: 'black',
							display: ( viewingOriginal && imageLoadState.loaded && ! viewingAIVariant ) ? 'block' : 'none',
							imageRendering: 'pixelated' // Better for 4K images
						}}
					/>

					{/* Canvas for AI variant - optimized for 4K */}
					<canvas
						ref={aiCanvasRef}
						style={{
							width: `${actualCanvasWidth}px`,
							height: `${actualCanvasHeight}px`,
							backgroundColor: 'black',
							display: ( viewingAIVariant && imageLoadState.loaded && ! viewingOriginal ) ? 'block' : 'none',
							imageRendering: 'pixelated' // Better for 4K images
						}}
					/>

					{/* Message when no image is selected */}
					{! imageData && (
						<div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white">
							<p>Select a render from the Results panel</p>
						</div>
					)}
				</div>
			</div>

			{/* ViewportToolbar - replaces the old custom controls */}
			<ViewportToolbar
				onResize={handleViewportResize}
				viewportWrapperRef={viewportRef}
				appRef={mockAppRef}
				position="bottom-right"
				defaultSize={100}
				minSize={5}
				maxSize={300}
				zoomStep={25}
				autoFitScale={autoFitScale}
				isManualScale={isManualScale}
				onResetToAutoFit={handleResetToAutoFitWithPan}
				controls={{
					resetZoom: true,
					zoomButtons: true,
					zoomSlider: true,
					screenshot: true,
					resetCamera: false, // Not applicable to static images
					fullscreen: true
				}}
			/>
		</div>
	);

} );

export default ResultsViewport;
