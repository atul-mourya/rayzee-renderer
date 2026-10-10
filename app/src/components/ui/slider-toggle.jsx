import { forwardRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Power, PowerOff } from "lucide-react";
import { Slider } from "./slider"; // Import the Slider component

const SliderToggle = forwardRef( ( {
	className,
	enabled = false,
	icon: Icon,
	onToggleChange,
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
	tip,
	...props
}, ref ) => {

	// State for power toggle
	const [ isPowerOn, setIsPowerOn ] = useState( enabled );

	// Sync with external props
	useEffect( () => {

		setIsPowerOn( enabled );

	}, [ enabled ] );

	// Power toggle handler
	const togglePower = () => {

		const newPowerState = ! isPowerOn;
		setIsPowerOn( newPowerState );
		onToggleChange?.( newPowerState );

	};

	return (
		<>
			<span className="opacity-50 text-xs truncate" title={tip}>{label}</span>
			<span className="flex items-center max-w-32 w-full justify-end">
				<div className="relative flex h-5 w-full overflow-hidden">
					<div
						className={cn(
							"absolute inset-0 transition-transform duration-300 ease-in-out",
							isPowerOn ? "translate-x-0" : "translate-x-full"
						)}
					>
						{/* Use the Slider component */}
						<Slider
							ref={ref}
							className={className}
							icon={Icon}
							value={value}
							onChange={onChange}
							onValueChange={onValueChange}
							onFinishChange={onFinishChange}
							onDragStart={onDragStart}
							onDragEnd={onDragEnd}
							min={min}
							max={max}
							sliderMin={sliderMin}
							sliderMax={sliderMax}
							step={step}
							precision={precision}
							disabled={disabled || ! isPowerOn}
							label={null} // Label is handled by parent
							{...props}
						/>
					</div>
				</div>

				{/* Power toggle button */}
				<Button
					className="h-full px-1 py-1 text-xs rounded-full ml-2"
					onClick={togglePower}
					disabled={disabled}
				>
					{isPowerOn ? (
						<Power size={12} className="text-foreground" />
					) : (
						<PowerOff size={12} className="text-secondary" />
					)}
				</Button>
			</span>
		</>
	);

} );

SliderToggle.displayName = "SliderToggle";

export { SliderToggle };
