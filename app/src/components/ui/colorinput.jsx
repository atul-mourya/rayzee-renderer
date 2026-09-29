import { useState, useRef, useEffect } from 'react';
import { Input } from "@/components/ui/input";
import { Paintbrush } from "lucide-react";
import { cn } from "@/lib/utils";

const ColorInput = ( { onChange, className, value, ...props } ) => {

	const [ color, setColor ] = useState( value || "#000000" );
	const colorInputRef = useRef( null );

	useEffect( () => {

		setColor( value );

	}, [ value ] );

	const handleChange = ( event ) => {

		const newColor = event.target.value;
		setColor( newColor );
		if ( onChange ) onChange( newColor );

	};

	const openColorPicker = () => {

		colorInputRef.current.click();

	};

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<div className={cn( "relative flex h-5 w-full touch-none select-none items-center max-w-32", className )}>
				<div className="relative h-full w-full grow overflow-hidden rounded-full bg-primary/20">
					<Input
						type="text"
						value={color}
						onChange={handleChange}
						className="absolute h-full bg-primary text-xs text-center tracking-widest rounded-full"
					/>
					<div className="h-full w-5 absolute left-0 text-center">
						<Paintbrush size={14} className="h-full w-full p-1"/>
					</div>
					<div
						className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full cursor-pointer"
						onClick={openColorPicker}
						style={{ backgroundColor: color }}
					/>
				</div>
				<input
					ref={colorInputRef}
					type="color"
					value={color}
					onChange={handleChange}
					className="sr-only bottom-0"
				/>
			</div>
		</>
	);

};

export { ColorInput };
