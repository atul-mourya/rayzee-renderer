import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

import { cn } from "@/lib/utils";
import { toggleVariants } from "@/components/ui/toggle";
import { useRowLabel } from "@/components/ui/row";

const ToggleGroupContext = React.createContext( {
	size: "default",
	variant: "default",
} );

const ToggleGroup = React.forwardRef( ( { className, variant, size, children, ...props }, ref ) => (
	<ToggleGroupPrimitive.Root
		ref={ref}
		aria-labelledby={useRowLabel()}
		className={cn( "flex items-center justify-between gap-0 max-w-32 h-5 rounded-full", className )}
		{...props}>
		<ToggleGroupContext.Provider value={{ variant, size }}>
			{children}
		</ToggleGroupContext.Provider>
	</ToggleGroupPrimitive.Root>
) );

ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

const ToggleGroupItem = React.forwardRef( ( { className, children, variant, size, ...props }, ref ) => {

	const context = React.useContext( ToggleGroupContext );

	return (
		( <ToggleGroupPrimitive.Item
			ref={ref}
			className={cn( toggleVariants( {
				variant: context.variant || variant,
				size: context.size || size,
			} ), className )}
			{...props}>
			{children}
		</ToggleGroupPrimitive.Item> )
	);

} );

ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem };
