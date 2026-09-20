import * as React from "react";
import { cn } from "@/lib/utils";

const Slider = React.forwardRef( ( {
	className,
	icon: Icon,
	iconTooltip,
	hideIconOnEditing,
	value = 0,
	onChange,
	onValueChange,
	onFinishChange,
	onDragStart,
	onDragEnd,
	min = 0,
	max = 100,
	sliderMin,
	sliderMax,
	step = 1,
	precision = 2,
	disabled = false,
	label,
	unit = "",
	snapPoints,
	snapThreshold = 3, // Percentage of range to consider snapping
	...props
}, ref ) => {

	// Use actual slider range if provided, otherwise use min/max
	const actualSliderMin = sliderMin !== undefined ? sliderMin : min;
	const actualSliderMax = sliderMax !== undefined ? sliderMax : max;

	// Extract non-DOM props
	const { onValueChange: _, ...domProps } = props;

	// Unified change handler
	const handleChange = React.useCallback( newValue => {

		if ( onChange ) onChange( newValue );
		if ( onValueChange ) onValueChange( [ newValue ] );

	}, [ onChange, onValueChange ] );

	// Refs and state
	const sliderRef = React.useRef( null );
	const [ isEditing, setIsEditing ] = React.useState( false );
	const [ currentValue, setCurrentValue ] = React.useState( Number( value ) || 0 );
	const lastValueRef = React.useRef( currentValue );

	// Dragging state refs
	const dragDistanceRef = React.useRef( 0 );
	const lastPointerXRef = React.useRef( 0 );
	const pointerDownOnValueRef = React.useRef( false );

	// Get slider width for calculations
	const [ sliderWidth, setSliderWidth ] = React.useState( 0 );
	React.useEffect( () => {

		if ( sliderRef.current ) {

			const resizeObserver = new ResizeObserver( entries => {

				setSliderWidth( entries[ 0 ].contentRect.width );

			} );
			resizeObserver.observe( sliderRef.current );
			return () => resizeObserver.disconnect();

		}

	}, [] );

	// Sync with external value changes
	React.useEffect( () => {

		const newValue = Array.isArray( value ) ? value[ 0 ] : value;
		setCurrentValue( Number( newValue ) || 0 );

	}, [ value ] );

	// Snap to nearest snap point if within threshold
	const snapToNearestPoint = React.useCallback( val => {

		if ( ! snapPoints || snapPoints.length === 0 ) {

			return val;

		}

		// Calculate threshold in actual value units
		const range = actualSliderMax - actualSliderMin;
		const thresholdValue = ( snapThreshold / 100 ) * range;

		// Find the closest snap point
		let closestPoint = snapPoints[ 0 ];
		let minDistance = Math.abs( val - closestPoint );

		for ( let i = 1; i < snapPoints.length; i ++ ) {

			const distance = Math.abs( val - snapPoints[ i ] );
			if ( distance < minDistance ) {

				minDistance = distance;
				closestPoint = snapPoints[ i ];

			}

		}

		// Only snap if within threshold
		if ( minDistance <= thresholdValue ) {

			return closestPoint;

		}

		// Otherwise return the original value
		return val;

	}, [ snapPoints, snapThreshold, actualSliderMin, actualSliderMax ] );

	// Clamp and format value
	const clampValue = React.useCallback( val => {

		const numVal = Number( val ) || 0;
		const bounded = Math.min( Math.max( numVal, min ), max );

		// Try snapping first if snap points are provided
		if ( snapPoints && snapPoints.length > 0 ) {

			const snappedValue = snapToNearestPoint( bounded );
			// If snapping occurred, return the snapped value
			if ( snappedValue !== bounded ) {

				return + snappedValue.toFixed( precision );

			}

		}

		// Otherwise use regular step-based snapping
		const steppedValue = Math.round( bounded / step ) * step;
		return + steppedValue.toFixed( precision );

	}, [ min, max, step, precision, snapPoints, snapToNearestPoint ] );

	// Pointer event handlers
	const handlePointerMove = React.useCallback( e => {

		if ( ! sliderRef.current ) return;

		// Get slider element bounds
		const sliderRect = sliderRef.current.getBoundingClientRect();

		// Calculate position relative to slider (clamped between 0 and slider width)
		const relativeX = Math.max( 0, Math.min( e.clientX - sliderRect.left, sliderWidth ) );

		// Convert position to value based on slider range
		const positionPercentage = relativeX / sliderWidth;
		const newValue = actualSliderMin + positionPercentage * ( actualSliderMax - actualSliderMin );
		const clampedValue = clampValue( newValue );

		// Update value
		setIsEditing( false );
		setCurrentValue( clampedValue );
		lastValueRef.current = clampedValue;
		handleChange( clampedValue );

		// Still track total distance for other behaviors if needed
		dragDistanceRef.current += Math.abs( e.clientX - lastPointerXRef.current );
		lastPointerXRef.current = e.clientX;

	}, [ sliderWidth, actualSliderMin, actualSliderMax, clampValue, handleChange ] );

	const handlePointerDown = React.useCallback( e => {

		if ( disabled ) return;

		// Track whether pointerdown was on the value display area
		const isOnValue = !! e.target.closest( '[data-value-display]' );
		pointerDownOnValueRef.current = isOnValue;

		// Initialize drag tracking
		dragDistanceRef.current = 0;
		lastPointerXRef.current = e.clientX;

		// Only jump value immediately when clicking the track, not the value display
		if ( ! isOnValue && sliderRef.current ) {

			const sliderRect = sliderRef.current.getBoundingClientRect();
			const relativeX = Math.max( 0, Math.min( e.clientX - sliderRect.left, sliderWidth ) );
			const positionPercentage = relativeX / sliderWidth;
			const newValue = actualSliderMin + positionPercentage * ( actualSliderMax - actualSliderMin );
			const clampedValue = clampValue( newValue );

			setCurrentValue( clampedValue );
			lastValueRef.current = clampedValue;
			handleChange( clampedValue );

		}

		// Always set up pointer capture for dragging
		const target = e.currentTarget;
		target.onpointermove = handlePointerMove;
		target.setPointerCapture( e.pointerId );
		onDragStart?.();

	}, [ disabled, handlePointerMove, onDragStart, sliderWidth, actualSliderMin, actualSliderMax, clampValue, handleChange ] );

	const handlePointerUp = React.useCallback( e => {

		const target = e.currentTarget;
		target.releasePointerCapture( e.pointerId );
		target.onpointermove = null;

		// If clicked on value display with minimal drag, enter editing mode
		if ( pointerDownOnValueRef.current && dragDistanceRef.current < 3 ) {

			pointerDownOnValueRef.current = false;
			if ( ! disabled ) setIsEditing( true );
			return;

		}

		pointerDownOnValueRef.current = false;
		onDragEnd?.();

		if ( ! disabled ) {

			onFinishChange?.( currentValue );

		}

	}, [ currentValue, disabled, onDragEnd, onFinishChange ] );

	// Input handlers
	const handleInputChange = e => {

		const newValue = Number.parseFloat( e.target.value ) || 0;
		setCurrentValue( newValue );

		// Trigger change handlers immediately for stepper arrows
		const clampedValue = clampValue( newValue );
		if ( clampedValue !== lastValueRef.current ) {

			lastValueRef.current = clampedValue;
			handleChange( clampedValue );

		}

	};

	const handleEnterKey = e => {

		if ( e.key === "Enter" ) {

			e.preventDefault();
			commitValue();

		}

	};

	const commitValue = () => {

		const clampedValue = clampValue( currentValue );
		setIsEditing( false );

		// Ensure final value is set (may have already been set by handleInputChange)
		if ( clampedValue !== lastValueRef.current ) {

			lastValueRef.current = clampedValue;
			handleChange( clampedValue );

		}

		// Always call onFinishChange when committing
		onFinishChange?.( clampedValue );

	};


	// Calculate percentage for progress bar (using slider min/max if available)
	const progressPercentage = actualSliderMax !== actualSliderMin
		? Math.max( Math.min( ( currentValue - actualSliderMin ) / ( actualSliderMax - actualSliderMin ), 1 ), 0 ) * 100
		: 0;

	return (
		<>
			<span className="opacity-50 text-xs truncate">{label}</span>
			<div
				ref={elem => {

					sliderRef.current = elem;
					if ( typeof ref === 'function' ) ref( elem );
					else if ( ref ) ref.current = elem;

				}}
				tabIndex={0}
				className={cn(
					"relative flex h-5 w-full touch-none select-none items-center max-w-32 cursor-ew-resize",
					disabled ? "cursor-not-allowed opacity-50" : "",
					className
				)}
				onPointerDown={handlePointerDown}
				onPointerUp={handlePointerUp}
				onLostPointerCapture={handlePointerUp}
				{...domProps}
			>
				{/* Base track */}
				<div className="pl-3 rounded-full absolute w-full h-full bg-input" />

				{/* Progress track */}
				{actualSliderMax != null && actualSliderMin != null && (
					<div className="absolute rounded-full w-full h-full overflow-hidden">
						<div
							className={cn( "absolute h-full outline-none", disabled ? "bg-gray-400" : "bg-primary" )}
							style={{ width: `${progressPercentage}%` }}
						/>
					</div>
				)}

				{/* Snap point indicators */}
				{snapPoints && snapPoints.length > 0 && (
					<div className="absolute w-full h-full pointer-events-none">
						{snapPoints.map( ( point, index ) => {

							const pointPercentage =
				actualSliderMax !== actualSliderMin
					? Math.max( Math.min( ( point - actualSliderMin ) / ( actualSliderMax - actualSliderMin ), 1 ), 0 ) * 100
					: 0;

							return (
								<div
									key={index}
									className="absolute w-0.5 h-0.5 bg-muted-foreground/30 rounded-full top-1/2 transform -translate-y-1/2 -translate-x-0.5"
									style={{ left: `${pointPercentage}%` }}
								/>
							);

						} )}
					</div>
				)}

				{/* Value display/editor */}
				{isEditing && ! disabled ? (
					<input
						className="absolute right-2 h-full bg-transparent text-foreground outline-none text-xs text-right max-w-full"
						type="number"
						value={isNaN( currentValue ) ? "" : currentValue}
						step={step}
						min={min}
						max={max}
						style={{
							width: Math.max( ( currentValue || 0 ).toString().length * 9 + 10, 40 ) + "px"
						}}
						onChange={handleInputChange}
						onBlur={commitValue}
						onKeyDown={handleEnterKey}
						onFocus={( e ) => e.target.select()}
						onPointerDown={( e ) => e.stopPropagation()}
						autoFocus
					/>
				) : (
					<span
						data-value-display
						className="text-xs absolute h-full right-2 cursor-text select-none text-foreground inline-flex items-center"
					>
						{isNaN( currentValue ) ? "-" : `${+ ( currentValue || 0 ).toFixed( precision )}${unit}`}
					</span>
				)}

				{/* Icon - Fixed to use JSX element syntax */}
				{Icon && ! ( hideIconOnEditing && isEditing ) && (
					<div className="absolute h-full left-1 inline-flex justify-start items-center">
						{iconTooltip ? (
							<div>
								<Icon size={12} />
							</div>
						) : (
							<Icon size={12} />
						)}
					</div>
				)}
			</div>
		</>
	);

} );

Slider.displayName = "Slider";

export { Slider };
