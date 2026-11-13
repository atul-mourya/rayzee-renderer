import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

// A list's variant styles its triggers too. `bar`: a sidebar's icon tabs (the column count stays the caller's);
// `pills`: two or three choices as pills (with the caller's column count); `compact`: small text tabs.
const LIST_VARIANTS = { default: "", bar: "relative grid w-full h-12 p-0", pills: "grid w-full h-auto p-0 border", compact: "relative grid w-full h-auto p-0" };
const TRIGGER_VARIANTS = { default: "", bar: "flex flex-col items-center py-2", pills: "text-xs rounded-full", compact: "text-xs truncate py-2" };
const TabsVariant = React.createContext( "default" );

const TabsList = React.forwardRef( ( { className, variant = "default", ...props }, ref ) => (
	<TabsVariant.Provider value={variant}>
		<TabsPrimitive.List
			ref={ref}
			className={cn(
				"inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
				LIST_VARIANTS[ variant ],
				className
			)}
			{...props} />
	</TabsVariant.Provider>
) );
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef( ( { className, ...props }, ref ) => (
	<TabsPrimitive.Trigger
		ref={ref}
		className={cn(
			"inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
			TRIGGER_VARIANTS[ React.useContext( TabsVariant ) ],
			className
		)}
		{...props} />
) );
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef( ( { className, ...props }, ref ) => (
	<TabsPrimitive.Content
		ref={ref}
		className={cn(
			"mt-2 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
			className
		)}
		{...props} />
) );
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
