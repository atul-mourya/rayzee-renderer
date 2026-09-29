import { useState, useRef, useEffect, useCallback } from 'react';

const clamp = ( val, min, max ) => Math.min( Math.max( val, min ), max );

/**
 * Hook for pan (left-click + drag) and scroll-zoom interactions.
 * Designed to work alongside useAutoFitScale without modifying it.
 */
export const usePanZoom = ( {
	viewportRef,
	viewportScale,
	onScaleChange,
	minScale = 5,
	maxScale = 300,
	zoomSensitivity = 0.001,
	enabled = true,
	suppressRef = null,
} ) => {

	// State for rendering
	const [ panOffset, setPanOffset ] = useState( { x: 0, y: 0 } );
	const [ isPanning, setIsPanning ] = useState( false );

	// Refs for event handlers (avoid stale closures)
	const panRef = useRef( { x: 0, y: 0 } );
	const isPanningRef = useRef( false );
	const isPrimedRef = useRef( false );
	const dragStartRef = useRef( { x: 0, y: 0, panX: 0, panY: 0 } );
	const dragCleanupRef = useRef( null );

	// Refs to track latest values without re-attaching listeners
	const scaleRef = useRef( viewportScale );
	useEffect( () => {

		scaleRef.current = viewportScale;

	}, [ viewportScale ] );

	const onScaleChangeRef = useRef( onScaleChange );
	useEffect( () => {

		onScaleChangeRef.current = onScaleChange;

	}, [ onScaleChange ] );

	// Reset pan to origin (guarded to avoid no-op re-renders)
	const resetPan = useCallback( () => {

		if ( panRef.current.x === 0 && panRef.current.y === 0 ) return;
		panRef.current = { x: 0, y: 0 };
		setPanOffset( { x: 0, y: 0 } );

	}, [] );

	// Cleanup drag listeners on unmount
	useEffect( () => {

		return () => {

			dragCleanupRef.current?.();

		};

	}, [] );

	// Pointer down handler for pan — attach to the viewport div
	const handlePointerDown = useCallback( ( e ) => {

		if ( ! enabled || e.button !== 0 ) return;

		// Skip clicks on UI controls (toolbar buttons, sliders, radix items)
		if ( e.target.closest( 'button, [role="slider"], [data-radix-collection-item]' ) ) return;

		// Clean up any lingering drag session (e.g. rapid pointer-down before previous up)
		dragCleanupRef.current?.();

		dragStartRef.current = {
			x: e.clientX,
			y: e.clientY,
			panX: panRef.current.x,
			panY: panRef.current.y,
		};
		isPrimedRef.current = true;

		const onMove = ( ev ) => {

			if ( ! isPrimedRef.current ) return;

			const dx = ev.clientX - dragStartRef.current.x;
			const dy = ev.clientY - dragStartRef.current.y;

			// Dead zone: distinguish click from drag
			if ( ! isPanningRef.current && Math.hypot( dx, dy ) < 3 ) return;

			// If long press is active, don't start panning
			if ( suppressRef?.current ) {

				cleanup();
				return;

			}

			// Prevent text selection during drag
			ev.preventDefault();

			if ( ! isPanningRef.current ) {

				isPanningRef.current = true;
				setIsPanning( true );

			}

			const newPan = {
				x: dragStartRef.current.panX + dx,
				y: dragStartRef.current.panY + dy,
			};
			panRef.current = newPan;
			setPanOffset( { ...newPan } );

		};

		const cleanup = () => {

			isPrimedRef.current = false;
			isPanningRef.current = false;
			setIsPanning( false );
			dragCleanupRef.current = null;
			window.removeEventListener( 'pointermove', onMove );
			window.removeEventListener( 'pointerup', onUp );

		};

		const onUp = () => cleanup();

		dragCleanupRef.current = cleanup;
		window.addEventListener( 'pointermove', onMove );
		window.addEventListener( 'pointerup', onUp );

	}, [ enabled, suppressRef ] );

	// Wheel handler for zoom (attached via addEventListener for passive: false)
	useEffect( () => {

		const el = viewportRef?.current;
		if ( ! el || ! enabled ) return;

		const handleWheel = ( e ) => {

			e.preventDefault();

			const oldScalePercent = scaleRef.current;
			const delta = - e.deltaY * zoomSensitivity;
			const factor = Math.pow( 2, delta );
			const newScalePercent = Math.round( clamp( oldScalePercent * factor, minScale, maxScale ) );

			if ( newScalePercent === oldScalePercent ) return;

			scaleRef.current = newScalePercent;
			onScaleChangeRef.current?.( newScalePercent );

		};

		el.addEventListener( 'wheel', handleWheel, { passive: false } );
		return () => el.removeEventListener( 'wheel', handleWheel );

	}, [ viewportRef, enabled, minScale, maxScale, zoomSensitivity ] );

	return { panOffset, isPanning, resetPan, handlePointerDown };

};
