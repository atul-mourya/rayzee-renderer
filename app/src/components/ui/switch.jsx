import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef( ( { className, label, tip, ...props }, ref ) => {

	const id = React.useId();
	// The label dims with the control. Without this a disabled switch reads as merely "off",
	// since the toggle's own `disabled:opacity-50` lands on an already-faint element.
	return ( <><span id={id} className={cn( "truncate", props.disabled ? "text-xs opacity-25" : "control-label" )} title={tip}>{label}</span>
		<SwitchPrimitives.Root
			aria-labelledby={label ? id : undefined}
			className={cn(
				"peer inline-flex h-4 w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
				className
			)}
			{...props}
			ref={ref}>
			<SwitchPrimitives.Thumb
				className={cn(
					"pointer-events-none block h-3 w-3 rounded-full bg-background shadow-lg ring-0 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
				)} />
		</SwitchPrimitives.Root>
	</> );

} );
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
