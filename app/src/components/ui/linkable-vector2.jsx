import { useState, useCallback } from 'react';
import { NumberInput } from '@/components/ui/number-input';
import { CustomLinkIcon, CustomUnlinkIcon } from '@/assets/icons';

const LinkableVector2 = ( { label, value, onChange, step = 0.1, min, max } ) => {

	const [ isLinked, setIsLinked ] = useState( false );

	const handleXChange = useCallback( ( x ) => {

		if ( isLinked ) {

			// When linked, both X and Y change together
			onChange( { x, y: x } );

		} else {

			// When not linked, only X changes
			onChange( { ...value, x } );

		}

	}, [ isLinked, value, onChange ] );

	const handleYChange = useCallback( ( y ) => {

		if ( isLinked ) {

			// When linked, both X and Y change together
			onChange( { x: y, y } );

		} else {

			// When not linked, only Y changes
			onChange( { ...value, y } );

		}

	}, [ isLinked, value, onChange ] );

	const toggleLink = useCallback( () => {

		if ( ! isLinked ) {

			// When linking, make Y equal to X
			onChange( { x: value.x, y: value.x } );

		}

		setIsLinked( ! isLinked );

	}, [ isLinked, value, onChange ] );

	return (
		<>
			<div className="opacity-50 text-xs mb-1">{label}</div>
			<div className="flex items-center gap-1">
				<div
					onClick={toggleLink}
					className="h-8 w-6 flex-shrink-0 flex items-center justify-center cursor-pointer hover:opacity-70 transition-opacity"
					title={isLinked ? "Unlink X and Y" : "Link X and Y"}
				>
					{isLinked ? (
						<CustomLinkIcon size={12} className="opacity-50" />
					) : (
						<CustomUnlinkIcon size={12} className="opacity-50" />
					)}
				</div>
				<div className="grid grid-cols-[20px_1fr] gap-1 flex-1 items-center">
					<NumberInput
						label="X"
						value={value.x}
						step={step}
						min={min}
						max={max}
						onValueChange={handleXChange}
					/>
					<NumberInput
						label="Y"
						value={value.y}
						step={step}
						min={min}
						max={max}
						onValueChange={handleYChange}
					/>
				</div>
			</div>
		</>
	);

};

export { LinkableVector2 };
