import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border text-xs font-semibold focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
          "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/80",
				secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/80",
				outline: "text-foreground",
			},
			size: {
				default: "px-2.5 py-0.5",
				// A tag on a catalog card.
				sm: "px-1 py-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

function Badge( {
	className,
	variant,
	size,
	...props
} ) {

	return ( <div className={cn( badgeVariants( { variant, size } ), className )} {...props} /> );

}

// A label drawn over a picture: the render's name, its AI version, what is happening to it.
const chipVariants = cva( "inline-flex items-center gap-1 whitespace-nowrap", {
	variants: {
		tone: {
			scrim: "bg-scrim/60 text-on-scrim-300",
			ai: "bg-ai-600 text-on-scrim",
		},
		size: {
			// On a thumbnail.
			sm: "h-4 rounded-full pl-1 pr-1.5 text-2xs",
			md: "rounded-md px-2 py-1 text-xs",
		},
		// Round ends, as the controls beside it over the render (a checkbox's label among Save and Ignore).
		rounded: { true: "rounded-full" },
	},
	defaultVariants: {
		tone: "scrim",
		size: "md",
	},
} );

function Chip( { className, tone, size, rounded, asChild = false, ...props } ) {

	const Comp = asChild ? Slot : "span";
	return <Comp className={cn( chipVariants( { tone, size, rounded } ), className )} {...props} />;

}

export { Badge, badgeVariants, Chip };
