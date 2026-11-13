import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
				destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
				outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent",
				secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
				ghost: "hover:bg-accent hover:text-accent-foreground",
				link: "text-primary underline-offset-4 hover:underline",
				// Muted until hovered: a text action (Cancel, Select all) or a small icon in a row.
				quiet: "text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
				// The same for removing something: red on hover.
				"quiet-destructive": "text-muted-foreground hover:text-error",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3 text-xs",
				lg: "h-10 rounded-md px-8",
				icon: "h-9 w-9",
				"icon-sm": "h-8 w-8",
				// A panel's: a compact action, a round icon button, a pill.
				xs: "h-6 rounded-md px-3 text-xs",
				"icon-xs": "h-5 w-5 rounded-full",
				pill: "h-5 gap-1 rounded-full px-2 text-xs",
				// Text with no box, for `quiet`.
				text: "h-auto p-0 text-xs",
			},
			rounded: { true: "rounded-full" },
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

const Button = React.forwardRef( ( { className, variant, size, rounded, asChild = false, type = "button", ...props }, ref ) => {

	const Comp = asChild ? Slot : "button";
	return (
		( <Comp
			className={cn( buttonVariants( { variant, size, rounded, className } ) )}
			ref={ref}
			type={type}
			{...props} /> )
	);

} );
Button.displayName = "Button";

export { Button, buttonVariants };
