import * as React from "react";

import { cn } from "@/lib/utils";

// `filled`: a panel's blue-tinted field, seen by its fill; plain fields show their edge.
const Input = React.forwardRef( ( { className, type, variant, ...props }, ref ) => {

	return (
		( <input
			type={type}
			className={cn(
				"flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
				variant === "filled" ? "border-input bg-primary/20" : "border-field bg-transparent",
				className
			)}
			ref={ref}
			{...props} /> )
	);

} );
Input.displayName = "Input";

export { Input };
