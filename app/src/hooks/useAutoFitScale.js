import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';

/**
 * Custom hook for auto-fit scaling functionality in viewports
 * @param {Object} options - Configuration options
 * @param {React.RefObject} options.viewportRef - Reference to the viewport container
 * @param {number} options.canvasWidth - Width of the canvas to fit
 * @param {number} options.canvasHeight - Height of the canvas to fit
 * @param {number} options.padding - Padding around the canvas (default: 40)
 * @param {number} options.minScale - Minimum scale percentage (default: 5)
 * @param {number} options.maxScale - Maximum scale percentage (default: 300)
 * @param {number} options.manualThreshold - Threshold for detecting manual scale changes (default: 5)
 * @param {boolean} options.enabled - Flag to enable or disable the hook (default: true)
 * @returns {Object} Auto-fit scale state and handlers
 */
export const useAutoFitScale = ( {
	viewportRef,
	canvasWidth,
	canvasHeight,
	padding = 40,
	minScale = 5,
	maxScale = 300,
	manualThreshold = 5,
	enabled = true
} ) => {

	const [ viewportScale, setViewportScale ] = useState( 100 );
	const [ autoFitScale, setAutoFitScale ] = useState( 100 );
	const [ isManualScale, setIsManualScale ] = useState( false );

	// Use ref to track manual scale synchronously to avoid race conditions with ResizeObserver
	const isManualScaleRef = useRef( false );

	// Calculate best fit scale based on available space
	const calculateBestFitScale = useCallback( () => {

		if ( ! viewportRef.current || ! enabled ) return 100;

		const viewport = viewportRef.current;
		const viewportRect = viewport.getBoundingClientRect();

		// Leave padding on each side
		const availableWidth = viewportRect.width - padding;
		const availableHeight = viewportRect.height - padding;

		// Calculate scale to fit both width and height
		const scaleX = ( availableWidth / canvasWidth ) * 100;
		const scaleY = ( availableHeight / canvasHeight ) * 100;

		// Use the smaller scale to ensure it fits in both dimensions
		const bestFitScale = Math.min( scaleX, scaleY, maxScale );

		return Math.max( Math.ceil( bestFitScale ), minScale );

	}, [ viewportRef, canvasWidth, canvasHeight, padding, minScale, maxScale, enabled ] );

	// Mirror the latest calculator into a ref so the ResizeObserver callback
	// always sees the current canvas dimensions without re-attaching.
	const calculateBestFitScaleRef = useRef( calculateBestFitScale );
	calculateBestFitScaleRef.current = calculateBestFitScale;

	const applyScale = useCallback( ( scale ) => {

		setAutoFitScale( scale );
		if ( ! isManualScaleRef.current ) setViewportScale( scale );

	}, [] );

	// Recompute synchronously when canvas dimensions change. useLayoutEffect
	// runs after DOM mutations but before paint, so the new wrapper W/H and
	// the corrective transform: scale() are committed in a single paint —
	// eliminates the oversized-then-snap-back glitch on resolution change.
	useLayoutEffect( () => {

		if ( ! viewportRef.current || ! enabled ) return;
		applyScale( calculateBestFitScale() );

	}, [ calculateBestFitScale, enabled, viewportRef, applyScale ] );

	// Observe the outer viewport for window/container resizes. Mounted once
	// per enable cycle; canvas-dim changes are handled by the layout effect
	// above, so we don't re-attach the observer when they change.
	useEffect( () => {

		if ( ! viewportRef.current || ! enabled ) return;

		const observer = new ResizeObserver( () => {

			applyScale( calculateBestFitScaleRef.current() );

		} );

		observer.observe( viewportRef.current );

		return () => observer.disconnect();

	}, [ enabled, viewportRef, applyScale ] );

	// Handle viewport resize with manual scale detection
	const handleViewportResize = useCallback( ( scale ) => {

		// Set ref synchronously BEFORE updating state to prevent race conditions
		const isManual = Math.abs( scale - autoFitScale ) > manualThreshold;
		isManualScaleRef.current = isManual;

		// Update state
		setViewportScale( scale );
		setIsManualScale( isManual );

	}, [ autoFitScale, manualThreshold ] );

	// Reset to auto-fit function
	const handleResetToAutoFit = useCallback( () => {

		// Reset ref synchronously
		isManualScaleRef.current = false;

		// Update state
		setViewportScale( autoFitScale );
		setIsManualScale( false );

	}, [ autoFitScale ] );

	return {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit,
		setViewportScale,
		setIsManualScale
	};

};
