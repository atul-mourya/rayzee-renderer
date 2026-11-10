import { useState, useRef, useEffect, useCallback } from 'react';

const clamp = ( val, min, max ) => Math.min( Math.max( val, min ), max );

// Pixels per wheel unit: Firefox reports lines (1) or pages (2).
const WHEEL_UNIT = [ 1, 16, 800 ];
// A gesture ends this long after its last wheel step or pointer-up.
const GESTURE_IDLE_MS = 150;

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
	zoomSensitivity = 0.002,
	enabled = true,
	suppressRef = null,
	onActiveChange = null,
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

	// Whether a pan or zoom is under way, for `onActiveChange`.
	const activeRef = useRef( false );
	const idleTimerRef = useRef( null );
	const onActiveChangeRef = useRef( onActiveChange );
	useEffect( () => {

		onActiveChangeRef.current = onActiveChange;

	}, [ onActiveChange ] );

	const setActive = useCallback( ( active ) => {

		clearTimeout( idleTimerRef.current );
		if ( activeRef.current === active ) return;
		activeRef.current = active;
		onActiveChangeRef.current?.( active );

	}, [] );

	const endSoon = useCallback( () => {

		clearTimeout( idleTimerRef.current );
		idleTimerRef.current = setTimeout( () => {

			if ( ! isPrimedRef.current ) setActive( false );

		}, GESTURE_IDLE_MS );

	}, [ setActive ] );

	useEffect( () => {

		if ( ! enabled ) setActive( false );

	}, [ enabled, setActive ] );

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
			setActive( false );

		};

	}, [ setActive ] );

	// Pointer down handler for pan — attach to the viewport div
	const handlePointerDown = useCallback( ( e ) => {

		if ( ! enabled || e.button !== 0 ) return;

		// Skip clicks on UI controls (toolbar buttons, sliders, radix items)
		if ( e.target.closest( 'button, [role="slider"], [data-radix-collection-item], [data-no-pan]' ) ) return;

		// Clean up any lingering drag session (e.g. rapid pointer-down before previous up)
		dragCleanupRef.current?.();

		dragStartRef.current = {
			x: e.clientX,
			y: e.clientY,
			panX: panRef.current.x,
			panY: panRef.current.y,
		};
		isPrimedRef.current = true;
		// From the press, not the first move: work already queued on the GPU drains meanwhile.
		setActive( true );

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

			// The click ending a drag is not one: the canvas places focus points on click.
			if ( isPanningRef.current ) {

				const swallow = ev => ev.stopPropagation();
				window.addEventListener( 'click', swallow, { capture: true, once: true } );
				setTimeout( () => window.removeEventListener( 'click', swallow, { capture: true } ) );

			}

			endSoon();

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

	}, [ enabled, suppressRef, setActive, endSoon ] );

	// Wheel handler for zoom (attached via addEventListener for passive: false)
	useEffect( () => {

		const el = viewportRef?.current;
		if ( ! el || ! enabled ) return;

		const handleWheel = ( e ) => {

			e.preventDefault();

			const px = e.deltaY * ( WHEEL_UNIT[ e.deltaMode ] ?? 1 );
			// A trackpad pinch is a ctrl wheel of −100·ln( scale ) (as Chrome's PDF viewer reads it); capped so a mouse
			// wheel with ctrl held steps like a pinch, not 2.7× a notch.
			const factor = e.ctrlKey ? Math.exp( - clamp( px, - 25, 25 ) / 100 ) : Math.pow( 2, - px * zoomSensitivity );
			// Unrounded: a trackpad's small steps would each round back to the same percent.
			const next = clamp( scaleRef.current * factor, minScale, maxScale );
			if ( next === scaleRef.current ) return;

			scaleRef.current = next;
			onScaleChangeRef.current?.( Math.round( next * 100 ) / 100 );
			setActive( true );
			endSoon();

		};

		el.addEventListener( 'wheel', handleWheel, { passive: false } );
		return () => el.removeEventListener( 'wheel', handleWheel );

	}, [ viewportRef, enabled, minScale, maxScale, zoomSensitivity, setActive, endSoon ] );

	return { panOffset, isPanning, resetPan, handlePointerDown };

};
