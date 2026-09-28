import { useStore } from '@/store';
import { createContext, useContext, useEffect, useState, useCallback, useRef, memo, useMemo } from 'react';
import { getAllRenders, deleteRender } from '@/utils/database';
import { debounce } from '@/utils/debounce';
import { Trash2, AlertTriangle, Check, Sparkles, CalendarDays, Timer, Clock } from 'lucide-react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Create Context for sharing state across components
const ResultsContext = createContext( null );

// Custom hook to use the Results context
const useResultsContext = () => {

	const context = useContext( ResultsContext );
	if ( ! context ) {

		throw new Error( 'useResultsContext must be used within a ResultsProvider' );

	}

	return context;

};

// Database cache for 4K images
const imageCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache for 4K images
let lastFetchTime = 0;

// Custom hook for handling images data and selection with caching
const useResultsData = () => {

	const isMountedRef = useRef( true );
	const isResultsTabRef = useRef( false );
	const initialFetchDoneRef = useRef( false );
	const fetchTimeoutRef = useRef( null );

	const [ imagesState, setImagesState ] = useState( {
		renderedImages: [],
		selectedImageIndex: null,
		loading: true,
		error: null,
		isFetching: false,
		lastCacheUpdate: 0
	} );

	// Access store values directly to avoid selector issues
	const appMode = useStore( state => state.appMode );
	const setSelectedResult = useStore( state => state.setSelectedResult );

	// Update isResultsTab ref when appMode changes
	useEffect( () => {

		isResultsTabRef.current = appMode === 'results';

	}, [ appMode ] );

	// Set up mount/unmount tracking
	useEffect( () => {

		isMountedRef.current = true;
		return () => {

			isMountedRef.current = false;

		};

	}, [] );

	// Optimized fetch with caching for 4K images
	const fetchImages = useCallback( async ( options = {} ) => {

		const { force = false } = options;
		const now = Date.now();

		// Check cache first for 4K images
		if ( ! force && imageCache.has( 'renders' ) && ( now - lastFetchTime < CACHE_DURATION ) ) {

			const cachedData = imageCache.get( 'renders' );
			if ( cachedData && isMountedRef.current ) {

				setImagesState( prev => {

					const newState = {
						...prev,
						renderedImages: cachedData.images,
						loading: false,
						isFetching: false,
						lastCacheUpdate: cachedData.timestamp
					};

					// Auto-select first image if none selected
					if ( cachedData.images.length > 0 && prev.selectedImageIndex === null ) {

						newState.selectedImageIndex = 0;

					}

					return newState;

				} );

				return;

			}

		}

		// Prevent duplicate fetches
		if ( ( imagesState.isFetching || ! isMountedRef.current ) && ! force ) return;

		// Clear any pending timeouts
		if ( fetchTimeoutRef.current ) {

			clearTimeout( fetchTimeoutRef.current );

		}

		try {

			setImagesState( prev => ( {
				...prev,
				isFetching: true,
				loading: prev.renderedImages.length === 0,
				error: null
			} ) );

			const images = await getAllRenders();

			if ( ! isMountedRef.current ) return;

			// Cache the results for 4K images
			lastFetchTime = now;
			imageCache.set( 'renders', {
				images,
				timestamp: now
			} );

			setImagesState( prev => {

				const newState = {
					...prev,
					renderedImages: images,
					loading: false,
					isFetching: false,
					lastCacheUpdate: now
				};

				// Auto-select the first image if available and none selected
				if ( images.length > 0 && prev.selectedImageIndex === null ) {

					newState.selectedImageIndex = 0;

				} else if ( images.length === 0 ) {

					newState.selectedImageIndex = null;

				}

				return newState;

			} );

		} catch ( err ) {

			if ( ! isMountedRef.current ) return;

			setImagesState( prev => ( {
				...prev,
				error: err.message,
				loading: false,
				isFetching: false
			} ) );

		}

	}, [] ); // Remove dependency to prevent infinite loops

	// Handle initial fetch - only run once
	useEffect( () => {

		// Only run if not already fetched
		if ( ! initialFetchDoneRef.current && isMountedRef.current ) {

			const initialFetchTimer = setTimeout( () => {

				if ( isMountedRef.current ) {

					initialFetchDoneRef.current = true; // Mark as fetched
					fetchImages();

				}

			}, 500 );

			return () => clearTimeout( initialFetchTimer );

		}

	}, [] );

	// Debounced fetch for render-saved events to prevent cache thrashing with 4K images
	const debouncedFetch = useMemo(
		() => debounce( () => {

			if ( isMountedRef.current ) {

				// Clear cache when new render is saved
				imageCache.delete( 'renders' );
				fetchImages( { force: true } );

			}

		}, 300 ), // 300ms debounce for 4K image operations
		[ fetchImages ]
	);

	// Set up event listeners for render-saved events
	useEffect( () => {

		const handleRenderSaved = () => {

			if ( isMountedRef.current ) {

				debouncedFetch();

			}

		};

		window.addEventListener( 'render-saved', handleRenderSaved );

		return () => {

			window.removeEventListener( 'render-saved', handleRenderSaved );
			debouncedFetch.cancel(); // Cancel pending debounced calls

		};

	}, [ debouncedFetch ] );

	// Handle selected image change with optimized updates
	useEffect( () => {

		if ( ! isMountedRef.current ) return;

		const { selectedImageIndex, renderedImages } = imagesState;

		if ( selectedImageIndex !== null &&
			renderedImages.length > 0 &&
			isResultsTabRef.current ) {

			setSelectedResult( renderedImages[ selectedImageIndex ] );

		}

	}, [ imagesState.selectedImageIndex, imagesState.renderedImages, setSelectedResult ] );

	// Handle image selection
	const handleImageSelect = useCallback( ( index ) => {

		if ( ! isMountedRef.current ) return;
		setImagesState( prev => ( { ...prev, selectedImageIndex: index } ) );

	}, [] );

	return {
		...imagesState,
		isMountedRef,
		isResultsTabRef,
		fetchImages,
		handleImageSelect,
		setImagesState,
		debouncedFetch
	};

};

// Custom hook for handling image deletion
const useDeleteRender = ( imagesState, setImagesState, isMountedRef, isResultsTabRef ) => {

	const [ deleteState, setDeleteState ] = useState( {
		deleteDialogOpen: false,
		renderToDelete: null,
		isDeleting: false
	} );

	// Access store value directly
	const storeSetSelectedResult = useStore( state => state.setSelectedResult );

	// Handle opening the delete confirmation dialog
	const handleDeleteClick = useCallback( ( e, image, index ) => {

		e.stopPropagation(); // Prevent selecting the image when clicking delete

		if ( ! isMountedRef.current ) return;

		setDeleteState( {
			deleteDialogOpen: true,
			renderToDelete: { image, index },
			isDeleting: false
		} );

	}, [ isMountedRef ] );

	// Handle confirming deletion
	const handleConfirmDelete = useCallback( async () => {

		const { renderToDelete } = deleteState;
		const { selectedImageIndex } = imagesState;

		if ( ! renderToDelete || ! renderToDelete.image || ! isMountedRef.current ) return;

		try {

			setDeleteState( prev => ( { ...prev, isDeleting: true } ) );

			// Call the database function to delete the render
			await deleteRender( renderToDelete.image.id );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			// Force a refresh from the database to ensure consistency
			const freshImages = await getAllRenders();

			if ( ! isMountedRef.current ) return;

			// Calculate the new selected index
			let newSelectedIndex = selectedImageIndex;

			if ( freshImages.length === 0 ) {

				newSelectedIndex = null;

			} else if ( selectedImageIndex === renderToDelete.index ) {

				// If the deleted image was selected, select the next one or the last one
				newSelectedIndex = Math.min( selectedImageIndex, freshImages.length - 1 );

				// Update the selected result if we're in results tab
				if ( isResultsTabRef.current && freshImages[ newSelectedIndex ] ) {

					storeSetSelectedResult( freshImages[ newSelectedIndex ] );

				} else if ( freshImages.length === 0 ) {

					storeSetSelectedResult( null );

				}

			} else if ( selectedImageIndex > renderToDelete.index ) {

				// If the selected index is after the deleted one, decrement it
				newSelectedIndex = selectedImageIndex - 1;

			}

			// Update image state
			setImagesState( prev => ( {
				...prev,
				renderedImages: freshImages,
				selectedImageIndex: newSelectedIndex
			} ) );

			// Reset delete state
			setDeleteState( {
				deleteDialogOpen: false,
				renderToDelete: null,
				isDeleting: false
			} );

		} catch ( error ) {

			console.error( 'Error deleting render:', error );

			// Check if component is still mounted before updating state
			if ( ! isMountedRef.current ) return;

			setImagesState( prev => ( {
				...prev,
				error: `Failed to delete: ${error.message}`
			} ) );

			setDeleteState( {
				deleteDialogOpen: false,
				renderToDelete: null,
				isDeleting: false
			} );

		}

	}, [ deleteState, imagesState.selectedImageIndex, isMountedRef, isResultsTabRef, setImagesState ] );

	// Handle canceling deletion
	const handleCancelDelete = useCallback( () => {

		if ( ! isMountedRef.current ) return;

		setDeleteState( {
			deleteDialogOpen: false,
			renderToDelete: null,
			isDeleting: false
		} );

	}, [ isMountedRef ] );

	return {
		...deleteState,
		handleDeleteClick,
		handleConfirmDelete,
		handleCancelDelete
	};

};

// Memoized utility function for date formatting
const useFormatDate = () => {

	return useCallback( ( dateString ) => {

		const date = new Date( dateString );

		// Get short year (e.g., "26" from "2026")
		const year = date.getFullYear().toString().slice( - 2 );
		const month = date.getMonth() + 1;
		const day = date.getDate();
		const hours = date.getHours().toString().padStart( 2, '0' );
		const minutes = date.getMinutes().toString().padStart( 2, '0' );

		return {
			// Compact format: "10/1/26"
			date: `${month}/${day}/${year}`,
			// Time only: "21:56"
			time: `${hours}:${minutes}`,
			// Full format for tooltip: "10/01/2026, 21:56"
			fullDate: date.toLocaleDateString( undefined, {
				day: '2-digit',
				month: '2-digit',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			} ),
		};

	}, [] );

};

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

// Full render time format for tooltips
const formatRenderTimeFull = ( timeInSeconds ) => {

	if ( ! timeInSeconds || timeInSeconds <= 0 ) return null;

	const hours = Math.floor( timeInSeconds / 3600 );
	const minutes = Math.floor( ( timeInSeconds % 3600 ) / 60 );
	const seconds = Math.floor( timeInSeconds % 60 );

	if ( hours > 0 ) {

		return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;

	} else if ( minutes > 0 ) {

		return `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;

	} else {

		return `${seconds} second${seconds !== 1 ? 's' : ''}`;

	}

};

// Lazy-loaded image component optimized for 4K thumbnails
const LazyImage = memo( ( { src, alt, className, onError, onLoad } ) => {

	const [ imageLoaded, setImageLoaded ] = useState( false );
	const [ imageError, setImageError ] = useState( false );
	const imgRef = useRef();

	useEffect( () => {

		const img = imgRef.current;
		if ( ! img ) return;

		const observer = new IntersectionObserver(
			( [ entry ] ) => {

				if ( entry.isIntersecting ) {

					img.src = src;
					observer.unobserve( img );

				}

			},
			{ rootMargin: '50px' } // Preload 50px before visible
		);

		observer.observe( img );

		return () => {

			if ( img ) observer.unobserve( img );

		};

	}, [ src ] );

	const handleLoad = useCallback( () => {

		setImageLoaded( true );
		onLoad?.();

	}, [ onLoad ] );

	const handleError = useCallback( ( e ) => {

		setImageError( true );
		onError?.( e );

	}, [ onError ] );

	return (
		<div className="relative w-full h-full">
			{! imageLoaded && ! imageError && (
				<div className="absolute inset-0 flex items-center justify-center bg-gray-800">
					<div className="animate-pulse bg-gray-700 w-8 h-8 rounded"></div>
				</div>
			)}

			{imageError && (
				<div className="absolute inset-0 flex items-center justify-center bg-gray-800 text-gray-400 text-xs">
					Image Error
				</div>
			)}

			<img
				ref={imgRef}
				alt={alt}
				className={`${className} transition-opacity duration-300 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
				onLoad={handleLoad}
				onError={handleError}
				decoding="async"
				loading="lazy"
			/>
		</div>
	);

} );

LazyImage.displayName = 'LazyImage';

// Memoized render item component optimized for 4K images
const RenderItem = memo( ( {
	image,
	index,
	isSelected,
	formattedDate,
	onSelect,
	onDelete,
	handleImageError
} ) => {

	const handleClick = useCallback( () => onSelect( index ), [ onSelect, index ] );
	const handleDeleteClick = useCallback( ( e ) => {

		e.stopPropagation();
		onDelete( e, image, index );

	}, [ onDelete, image, index ] );

	const hasAIVariant = image.aiGeneratedImage && image.aiPrompt;

	return (
		<div
			key={`render-${image.id || image.timestamp || index}`}
			className={`overflow-hidden rounded-md transition-all ${isSelected
				? 'ring-2 ring-primary shadow-sm shadow-primary/20'
				: 'ring-1 ring-border hover:ring-border/90'
			}`}
			onClick={handleClick}
		>
			<div className="relative rounded-t-md overflow-hidden bg-black cursor-pointer group">
				<div className="aspect-w-16 aspect-h-9 w-full">
					<LazyImage
						src={image.thumb ?? image.image}
						alt={`4K Render ${index + 1}`}
						className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
						onError={handleImageError}
					/>
				</div>

				{/* Icon badges for selected and AI */}
				<div className="absolute top-2 right-2 flex gap-1">
					{isSelected && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="bg-primary/90 p-0.5 rounded-full cursor-default">
										<Check size={12} className="text-primary-foreground" />
									</div>
								</TooltipTrigger>
								<TooltipContent side="left" className="text-xs">
									<p>Selected</p>
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
					{hasAIVariant && (
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="bg-purple-600/90 p-0.5 rounded-full cursor-default">
										<Sparkles size={12} className="text-white" />
									</div>
								</TooltipTrigger>
								<TooltipContent side="left" className="text-xs max-w-xs">
									{image.aiPrompt && (
										<div className="space-y-1">
											<p className="font-medium">AI Prompt</p>
											<p className="italic">{image.aiPrompt}</p>
										</div>
									)}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
				</div>
			</div>

			<div className="bg-card p-2">
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="space-y-1 cursor-default">
								{/* First line: Date and time justified */}
								<div className="flex justify-between items-center text-xs text-muted-foreground">
									<span className="flex items-center gap-1">
										<CalendarDays size={12} />
										{formattedDate.date}
									</span>
									<span className="flex items-center gap-1">
										<Clock size={12} />
										{formattedDate.time}
									</span>
								</div>

								{/* Second line: Render time + Delete button */}
								<div className="flex justify-between items-center">
									<span className="flex items-center gap-1 text-xs text-muted-foreground">
										<Timer size={12} />
										{image.renderTime ? formatRenderTime( image.renderTime ) : 'NA'}
									</span>

									{/* Delete button */}
									<div
										className="flex items-center justify-center p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
										onClick={handleDeleteClick}
										aria-label="Delete render"
									>
										<Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
									</div>
								</div>
							</div>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="text-xs">
							<div className="space-y-1">
								<p><span className="font-medium">Date:</span> <span className="italic text-secondary">{formattedDate.date}</span></p>
								<p><span className="font-medium">Time:</span> <span className="italic text-secondary">{formattedDate.time}</span></p>
								{image.renderTime ? (
									<p><span className="font-medium">Duration:</span> <span className="italic text-secondary">{formatRenderTimeFull( image.renderTime )}</span></p>
								) : (
									<p><span className="font-medium">Duration:</span> <span className="italic text-secondary">N/A</span></p>
								)}
							</div>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
		</div>
	);

} );

RenderItem.displayName = 'RenderItem';

// Memoized delete confirmation dialog
const DeleteConfirmationDialog = memo( ( {
	open,
	onCancel,
	onConfirm,
	isDeleting
} ) => {

	if ( ! open ) return null;

	return (
		<AlertDialog open={open} onOpenChange={onCancel}>
			<AlertDialogContent className="border border-border">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<AlertTriangle size={18} className="text-destructive" />
						Confirm Deletion
					</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to delete this render? This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						className="bg-transparent border border-border hover:bg-muted"
						disabled={isDeleting}
					>
						Cancel
					</AlertDialogCancel>
					<AlertDialogAction
						className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
						onClick={onConfirm}
						disabled={isDeleting}
					>
						{isDeleting ? (
							<>
								<div className="animate-spin h-4 w-4 border-2 border-background border-t-transparent rounded-full mr-2"></div>
								Deleting...
							</>
						) : (
							'Delete'
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);

} );

DeleteConfirmationDialog.displayName = 'DeleteConfirmationDialog';

// Component for header section
const ResultsHeader = memo( ( { loading, error, renderedImages } ) => {

	return (
		<div className="p-4 border-b border-border bg-card">
			<h2 className="text-lg font-semibold">Saved Renders</h2>
			{! loading && ! error && renderedImages.length > 0 && (
				<p className="text-xs text-muted-foreground mt-1">
					Showing {renderedImages.length} render{renderedImages.length !== 1 ? 's' : ''}
				</p>
			)}
		</div>
	);

} );

ResultsHeader.displayName = 'ResultsHeader';

// Component for loading state
const LoadingState = memo( () => (
	<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
		<div className="flex flex-col items-center space-y-2">
			<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
			<span>Loading saved renders...</span>
		</div>
	</div>
) );

LoadingState.displayName = 'LoadingState';

// Component for error state
const ErrorState = memo( ( { error } ) => (
	<div className="p-4 m-3 text-sm text-destructive-foreground bg-destructive/10 rounded-md border border-destructive/20">
		<div className="font-medium mb-1">Error loading renders</div>
		{error}
	</div>
) );

ErrorState.displayName = 'ErrorState';

// Component for empty state
const EmptyState = memo( () => (
	<div className="flex-1 flex items-center justify-center p-4 text-sm text-muted-foreground">
		<div className="text-center">
			<div className="text-4xl mb-3">📷</div>
			<div className="font-medium">No rendered images available</div>
			<p className="text-xs mt-2 max-w-xs">Complete a render in the &quot;Render&quot; tab to see results here</p>
		</div>
	</div>
) );

EmptyState.displayName = 'EmptyState';

// Virtual scrolling component for efficient 4K image gallery rendering
const VirtualizedGallery = memo( () => {

	const { renderedImages, selectedImageIndex, handleImageSelect, handleDeleteClick } = useResultsContext();
	const formatDate = useFormatDate();
	const containerRef = useRef();
	const [ visibleRange, setVisibleRange ] = useState( { start: 0, end: 20 } ); // Show 20 items initially
	const [ containerHeight, setContainerHeight ] = useState( 600 );

	// Item dimensions for 4K thumbnails
	const ITEM_HEIGHT = 180; // Height per grid item
	const ITEMS_PER_ROW = 2;
	const BUFFER_SIZE = 4; // Extra items to render outside viewport

	const handleImageError = useCallback( ( e ) => {

		e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23374151"/%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23F9FAFB"%3E4K Error%3C/text%3E%3C/svg%3E';

	}, [] );

	// Calculate total rows and visible range
	const totalRows = Math.ceil( renderedImages.length / ITEMS_PER_ROW );
	const totalHeight = totalRows * ITEM_HEIGHT;

	// Optimize scroll handling for 4K images
	const handleScroll = useMemo(
		() => debounce( ( e ) => {

			const scrollTop = e.target.scrollTop;
			const viewportHeight = e.target.clientHeight;

			const startRow = Math.floor( scrollTop / ITEM_HEIGHT );
			const endRow = Math.ceil( ( scrollTop + viewportHeight ) / ITEM_HEIGHT );

			// Fixed: prevent excessive item creation
			const start = Math.max( 0, startRow * ITEMS_PER_ROW - 2 );
			const end = Math.min( renderedImages.length, endRow * ITEMS_PER_ROW + 2 );

			// Only update if range actually changed
			setVisibleRange( prev => {

				if ( prev.start !== start || prev.end !== end ) {

					return { start, end };

				}

				return prev;

			} );

		}, 16 ), // 60fps scrolling
		[ renderedImages.length ]
	);

	// Update container height on mount
	useEffect( () => {

		if ( containerRef.current ) {

			setContainerHeight( containerRef.current.clientHeight );

		}

	}, [] );

	// Reset visible range when images change
	useEffect( () => {

		setVisibleRange( { start: 0, end: Math.min( 20, renderedImages.length ) } );

	}, [ renderedImages.length ] );

	const visibleImages = renderedImages.slice( visibleRange.start, visibleRange.end );
	const offsetY = Math.floor( visibleRange.start / ITEMS_PER_ROW ) * ITEM_HEIGHT;

	return (
		<div
			ref={containerRef}
			className="flex-1 overflow-y-auto custom-scrollbar"
			onScroll={handleScroll}
			style={{ position: 'relative' }}
		>
			{/* Virtual container with total height */}
			<div style={{ height: totalHeight, position: 'relative' }}>
				{/* Visible items container */}
				<div
					className="grid grid-cols-2 gap-3 p-3"
					style={{
						position: 'absolute',
						top: offsetY,
						width: '100%',
						// transform removed - using top positioning instead
					}}
				>
					{visibleImages.map( ( image, virtualIndex ) => {

						const actualIndex = visibleRange.start + virtualIndex;
						const formattedDate = formatDate( image.timestamp );
						return (
							<RenderItem
								key={`render-${image.id || image.timestamp || actualIndex}`}
								image={image}
								index={actualIndex}
								isSelected={selectedImageIndex === actualIndex}
								formattedDate={formattedDate}
								onSelect={handleImageSelect}
								onDelete={handleDeleteClick}
								handleImageError={handleImageError}
							/>
						);

					} )}
				</div>
			</div>
		</div>
	);

} );

VirtualizedGallery.displayName = 'VirtualizedGallery';

// Fallback component for smaller lists (< 50 items)
const SimpleGallery = memo( () => {

	const { renderedImages, selectedImageIndex, handleImageSelect, handleDeleteClick } = useResultsContext();
	const formatDate = useFormatDate();

	const handleImageError = useCallback( ( e ) => {

		e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23374151"/%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23F9FAFB"%3E4K Error%3C/text%3E%3C/svg%3E';

	}, [] );

	return (
		<div className="flex-1 overflow-y-auto custom-scrollbar">
			<div className="grid grid-cols-2 gap-3 p-3">
				{renderedImages.map( ( image, index ) => {

					const formattedDate = formatDate( image.timestamp );
					return (
						<RenderItem
							key={`render-${image.id || image.timestamp || index}`}
							image={image}
							index={index}
							isSelected={selectedImageIndex === index}
							formattedDate={formattedDate}
							onSelect={handleImageSelect}
							onDelete={handleDeleteClick}
							handleImageError={handleImageError}
						/>
					);

				} )}
			</div>
		</div>
	);

} );

SimpleGallery.displayName = 'SimpleGallery';

// Smart gallery component that chooses between virtual and simple rendering
const RenderGallery = memo( () => {

	const { renderedImages } = useResultsContext();

	// Use virtual scrolling only for very large collections to avoid issues
	const shouldUseVirtualScrolling = renderedImages.length > 100;

	return shouldUseVirtualScrolling ? <VirtualizedGallery /> : <SimpleGallery />;

} );

RenderGallery.displayName = 'RenderGallery';

// Results provider component for context
const ResultsProvider = ( { children } ) => {

	const resultsData = useResultsData();
	const {
		renderedImages,
		selectedImageIndex,
		loading,
		error,
		isMountedRef,
		isResultsTabRef,
		setImagesState
	} = resultsData;

	const deleteHandler = useDeleteRender(
		{ renderedImages, selectedImageIndex },
		setImagesState,
		isMountedRef,
		isResultsTabRef
	);

	const contextValue = useMemo( () => ( {
		...resultsData,
		...deleteHandler
	} ), [ resultsData, deleteHandler ] );

	return (
		<ResultsContext.Provider value={contextValue}>
			{children}
		</ResultsContext.Provider>
	);

};

// Main Results component
const Results = memo( () => {

	return (
		<ResultsProvider>
			<ResultsContent />
		</ResultsProvider>
	);

} );

// Content component using the provided context
const ResultsContent = memo( () => {

	const {
		renderedImages,
		loading,
		error,
		deleteDialogOpen,
		handleCancelDelete,
		handleConfirmDelete,
		isDeleting
	} = useResultsContext();

	return (
		<div className="h-full flex flex-col bg-background text-foreground">
			{/* Delete Confirmation Dialog */}
			<DeleteConfirmationDialog
				open={deleteDialogOpen}
				onCancel={handleCancelDelete}
				onConfirm={handleConfirmDelete}
				isDeleting={isDeleting}
			/>

			<ResultsHeader loading={loading} error={error} renderedImages={renderedImages} />

			{loading && <LoadingState />}
			{error && <ErrorState error={error} />}
			{! loading && ! error && renderedImages.length === 0 && <EmptyState />}
			{! loading && ! error && renderedImages.length > 0 && <RenderGallery />}
		</div>
	);

} );

ResultsContent.displayName = 'ResultsContent';

// Add display name for debugging
Results.displayName = 'Results';

export default Results;
