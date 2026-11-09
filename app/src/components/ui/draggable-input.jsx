import * as React from "react";
import { cn } from "@/lib/utils";

const DraggableInput = React.forwardRef( ( {
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
	step = 1,
	precision = 2,
	disabled = false,
	label,
	dragSensitivity = 1,
	...props
}, ref ) => {

	// Extract non-DOM props
	const { onValueChange: _, ...domProps } = props;

	// DOM refs
	const containerRef = React.useRef( null );
	const valueDisplayRef = React.useRef( null );

	// State
	const [ isEditing, setIsEditing ] = React.useState( false );
	const [ currentValue, setCurrentValue ] = React.useState( Number( value ) || 0 );

	// Internal refs for tracking
	const internalValueRef = React.useRef( currentValue );

	// Helper to update display without re-rendering
	const updateValueDisplay = ( val ) => {

		if ( valueDisplayRef.current && ! isEditing ) {

			valueDisplayRef.current.textContent = isNaN( val ) ?
				"-" :
				Number( val.toFixed( precision ) );

		}

	};

	// Sync with external value changes
	React.useEffect( () => {

		const newValue = Array.isArray( value ) ? value[ 0 ] : value;
		const parsedValue = Number( newValue ) || 0;
		setCurrentValue( parsedValue );
		internalValueRef.current = parsedValue;
		updateValueDisplay( parsedValue );

	}, [ value ] );

	// Clamp value
	const clampValue = ( val ) => {

		const numVal = Number( val ) || 0;
		const bounded = Math.min( Math.max( numVal, min ), max );
		const snapped = Math.round( bounded / step ) * step;
		return Number( snapped.toFixed( precision ) );

	};

	// Notify parent
	const notifyValueChange = ( val ) => {

		if ( onChange ) onChange( val );
		if ( onValueChange ) onValueChange( [ val ] );

	};

	// Direct DOM event handlers
	const setupDrag = ( e ) => {

		if ( disabled || isEditing ) return;
		e.preventDefault();

		// Start values
		const startX = e.clientX;
		const startValue = internalValueRef.current;

		// Visual feedback
		document.body.style.cursor = 'ew-resize';
		if ( onDragStart ) onDragStart();

		// Track current drag value
		let currentDragValue = startValue;

		// Move handler
		const handleMove = ( moveEvent ) => {

			const deltaX = moveEvent.clientX - startX;
			const valueChange = deltaX * step * dragSensitivity / 10;
			const newRawValue = startValue + valueChange;
			const newValue = clampValue( newRawValue );

			// Only update if changed
			if ( newValue !== currentDragValue ) {

				currentDragValue = newValue;
				internalValueRef.current = newValue;
				updateValueDisplay( newValue );
				notifyValueChange( newValue );

			}

		};

		// End handler
		const handleUp = () => {

			// Clean up
			document.removeEventListener( 'mousemove', handleMove );
			document.removeEventListener( 'mouseup', handleUp );
			document.body.style.cursor = '';

			// Finalize
			setCurrentValue( currentDragValue );
			if ( onDragEnd ) onDragEnd();
			if ( onFinishChange ) onFinishChange( currentDragValue );

		};

		// Set up listeners
		document.addEventListener( 'mousemove', handleMove );
		document.addEventListener( 'mouseup', handleUp );

	};

	// Input handlers
	const handleInputChange = ( e ) => {

		setCurrentValue( parseFloat( e.target.value ) || 0 );

	};

	const commitInputValue = () => {

		const finalValue = clampValue( currentValue );
		setIsEditing( false );
		setCurrentValue( finalValue );
		internalValueRef.current = finalValue;
		notifyValueChange( finalValue );
		onFinishChange?.( finalValue );

	};

	// Handle reference forwarding
	const setRefs = ( element ) => {

		containerRef.current = element;
		if ( typeof ref === 'function' ) ref( element );
		else if ( ref ) ref.current = element;

	};

	return (
		<>
			{label && <span className="opacity-50 text-xs truncate">{label}</span>}
			<div
				ref={setRefs}
				className={cn(
					"relative flex h-5 items-center rounded-full bg-input px-2 touch-none select-none",
					disabled ? "cursor-not-allowed opacity-50" : "cursor-ew-resize",
					className
				)}
				onMouseDown={setupDrag}
				onFocus={() => ! disabled && setIsEditing( true )}
				tabIndex={disabled ? - 1 : 0}
				{...domProps}
			>
				{/* Icon */}
				{Icon && ! ( hideIconOnEditing && isEditing ) && (
					<div className="mr-1 inline-flex justify-start items-center">
						{iconTooltip ? (
							<div>
								<Icon size={12} />
							</div>
						) : (
							<Icon size={12} />
						)}
					</div>
				)}

				{/* Value display/editor */}
				{isEditing && ! disabled ? (
					<input
						className="w-full bg-transparent text-foreground outline-none text-xs text-right"
						type="number"
						value={isNaN( currentValue ) ? "" : currentValue}
						step={step}
						min={min}
						max={max}
						onChange={handleInputChange}
						onBlur={commitInputValue}
						onKeyDown={( e ) => {

							if ( e.key === "Enter" ) {

								e.preventDefault();
								commitInputValue();

							}

						}}
						onFocus={e => e.target.select()}
						autoFocus
					/>
				) : (
					<span
						ref={valueDisplayRef}
						className="text-xs cursor-text select-none text-foreground w-full text-right"
						onClick={() => ! disabled && setIsEditing( true )}
					>
						{isNaN( currentValue ) ? "-" : + ( currentValue || 0 ).toFixed( precision )}
					</span>
				)}
			</div>
		</>
	);

} );

DraggableInput.displayName = "DraggableInput";

export { DraggableInput };
