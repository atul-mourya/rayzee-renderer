import { useState, useRef, useEffect, useCallback, forwardRef } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from "@/lib/utils";

const NumberInput = forwardRef( ( {
	className = '',
	onValueChange,
	min = - Infinity,
	max = Infinity,
	step = 1,
	precision = 2,
	sensitivity = 1,
	value: propValue,
	defaultValue = 0,
	label,
	tip,
	...props
}, ref ) => {

	const [ isDragging, setIsDragging ] = useState( false );
	const [ dragOffset, setDragOffset ] = useState( 0 );
	const [ value, setValue ] = useState( propValue ?? defaultValue );
	const [ inputFocused, setInputFocused ] = useState( false );
	const [ inputValue, setInputValue ] = useState( '' );

	const containerRef = useRef( null );
	const startXRef = useRef( 0 );
	const startValueRef = useRef( 0 );
	const dragHandleRef = useRef( null );

	// Utility functions
	const clampValue = useCallback( ( val ) => {

		const clamped = Math.min( max, Math.max( min, val ) );
		return Number( Number( clamped ).toFixed( precision ) );

	}, [ min, max, precision ] );

	const formatValue = useCallback( ( val ) => {

		if ( val === undefined || val === null || isNaN( val ) ) return '';
		return Number( val ).toFixed( precision );

	}, [ precision ] );

	// Handle controlled/uncontrolled component pattern
	useEffect( () => {

		if ( propValue !== undefined ) {

			setValue( propValue );

		}

	}, [ propValue ] );

	const handleValueChange = useCallback( ( newValue ) => {

		const clampedValue = clampValue( newValue );
		if ( ! propValue ) setValue( clampedValue ); // Only set state if uncontrolled
		onValueChange?.( clampedValue );

	}, [ clampValue, onValueChange, propValue ] );

	const handlePointerDown = useCallback( ( event ) => {

		if ( inputFocused ) return; // Don't interfere with input interaction

		event.preventDefault();
		event.stopPropagation();

		setIsDragging( true );
		setDragOffset( 0 );
		startXRef.current = event.clientX;
		startValueRef.current = value;

		// Capture pointer for better drag behavior
		if ( dragHandleRef.current ) {

			dragHandleRef.current.setPointerCapture( event.pointerId );

		}

		const handlePointerMove = ( moveEvent ) => {

			const deltaX = moveEvent.clientX - startXRef.current;
			setDragOffset( deltaX );

			// Calculate new value based on movement and sensitivity
			const pixelsToValue = ( deltaX * sensitivity * step ) / 2;
			const newValue = startValueRef.current + pixelsToValue;
			handleValueChange( newValue );

		};

		const handlePointerUp = ( upEvent ) => {

			setIsDragging( false );
			setDragOffset( 0 );

			// Release pointer capture
			if ( dragHandleRef.current ) {

				dragHandleRef.current.releasePointerCapture( upEvent.pointerId );

			}

			window.removeEventListener( 'pointermove', handlePointerMove );
			window.removeEventListener( 'pointerup', handlePointerUp );

		};

		window.addEventListener( 'pointermove', handlePointerMove );
		window.addEventListener( 'pointerup', handlePointerUp );

	}, [ value, sensitivity, step, handleValueChange, inputFocused ] );

	const handleInputChange = useCallback( ( event ) => {

		const inputValue = event.target.value;
		setInputValue( inputValue );

		const newValue = parseFloat( inputValue );

		// Allow empty input or valid numbers
		if ( inputValue === '' ) {

			handleValueChange( 0 );

		} else if ( ! isNaN( newValue ) ) {

			handleValueChange( newValue );

		}

	}, [ handleValueChange ] );

	const handleInputFocus = useCallback( () => {

		setInputFocused( true );
		setInputValue( formatValue( value ) );

	}, [ formatValue, value ] );

	const handleInputBlur = useCallback( () => {

		setInputFocused( false );
		setInputValue( '' );

	}, [] );

	const handleKeyDown = useCallback( ( event ) => {

		if ( event.key === 'Enter' ) {

			event.target.blur();

		}

	}, [] );

	return (
		<>
			{label && (
				<span className="opacity-50 text-xs truncate" title={tip}>{label}</span>
			)}
			<div
				className={cn(
					"relative flex h-5 w-15 select-none items-center max-w-28",
					isDragging ? "cursor-ew-resize" : "cursor-pointer",
					className
				)}
				ref={containerRef}
			>
				{/* Drag Handle */}
				<div
					ref={dragHandleRef}
					className={cn(
						"absolute left-1 z-10 rounded-full transition-all duration-150 touch-none",
						"bg-primary hover:bg-primary/80 cursor-ew-resize",
						isDragging
							? "h-1 w-1 bg-primary/90"
							: "h-4 w-1 hover:w-1.5"
					)}
					onPointerDown={handlePointerDown}
					aria-hidden="true"
				/>

				{/* Drag Visual Feedback */}
				{isDragging && dragOffset !== 0 && (
					<svg
						className="absolute top-1/2 left-2 pointer-events-none select-none z-5"
						width={Math.abs( dragOffset ) + 10}
						height="20"
						viewBox={`0 0 ${Math.abs( dragOffset ) + 10} 20`}
						style={{
							overflow: 'visible',
							transform: dragOffset < 0 ? `translateX(${dragOffset}px) translateY(-50%)` : 'translateY(-50%)'
						}}
					>
						{/* Dotted line */}
						<line
							x1={dragOffset < 0 ? Math.abs( dragOffset ) : 0}
							y1={10}
							x2={dragOffset < 0 ? 0 : Math.abs( dragOffset )}
							y2={10}
							stroke="currentColor"
							strokeWidth="1"
							strokeDasharray="2 2"
							className="text-primary/70"
						/>
						{/* Arrow head */}
						<path
							d={dragOffset > 0
								? `M${Math.abs( dragOffset ) - 4},7 L${Math.abs( dragOffset )},10 L${Math.abs( dragOffset ) - 4},13`
								: `M4,7 L0,10 L4,13`}
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							className="text-primary"
						/>
						{/* End line */}
						<line
							x1={dragOffset < 0 ? 0 : Math.abs( dragOffset )}
							y1={6}
							x2={dragOffset < 0 ? 0 : Math.abs( dragOffset )}
							y2={14}
							stroke="currentColor"
							strokeWidth="1.5"
							className="text-primary"
						/>
					</svg>
				)}

				{/* Number Input */}
				<Input
					ref={ref}
					type="number"
					className={cn(
						"px-1 h-full rounded-10 text-xs bg-primary/20 text-right transition-colors",
						"[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
						isDragging && "bg-primary/30",
						inputFocused && "bg-background/80"
					)}
					onChange={handleInputChange}
					onFocus={handleInputFocus}
					onBlur={handleInputBlur}
					onKeyDown={handleKeyDown}
					value={inputFocused ? inputValue : formatValue( value )}
					min={min !== - Infinity ? min : undefined}
					max={max !== Infinity ? max : undefined}
					step={step}
					{...props}
				/>
			</div>
		</>
	);

} );

NumberInput.displayName = "NumberInput";

export { NumberInput };
export default NumberInput;
