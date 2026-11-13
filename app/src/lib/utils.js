import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design system's sizes and shadow (app/src/index.css): unknown to tailwind-merge, `text-xxs` read as a colour and
// was dropped beside one, and `shadow-float` left the default shadow in place.
const twMerge = extendTailwindMerge( {
	extend: {
		classGroups: {
			"font-size": [ { text: [ "3xs", "xxs", "2xs" ] } ],
			shadow: [ { shadow: [ "float" ] } ],
		},
	},
} );

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
