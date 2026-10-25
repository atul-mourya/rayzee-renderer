import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn( ...inputs ) {

	return twMerge( clsx( inputs ) );

}

// remap a value from one range to another
export function remap( value, fromLow, fromHigh, toLow, toHigh ) {

	return toLow + ( value - fromLow ) * ( toHigh - toLow ) / ( fromHigh - fromLow );

}

// delay fn until ms have passed since the last call; .cancel() drops a pending call
export function debounce( fn, ms ) {

	let timer;
	function debounced( ...args ) {

		clearTimeout( timer );
		timer = setTimeout( () => fn.apply( this, args ), ms );

	}

	debounced.cancel = () => clearTimeout( timer );

	return debounced;

}
