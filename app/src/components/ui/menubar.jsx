import * as React from "react";
import {
	CheckIcon,
	ChevronRightIcon,
} from "lucide-react";
import * as MenubarPrimitive from "@radix-ui/react-menubar";

import { cn } from "@/lib/utils";

const MenubarMenu = MenubarPrimitive.Menu;

const MenubarGroup = MenubarPrimitive.Group;

const MenubarPortal = MenubarPrimitive.Portal;

const MenubarSub = MenubarPrimitive.Sub;

const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

const Menubar = React.forwardRef( ( { className, ...props }, ref ) => (
	<MenubarPrimitive.Root
		ref={ref}
		className={cn(
			// The top bar's: no box of its own, its menus' names quiet until hovered.
			"flex h-full items-center space-x-1 rounded-md bg-background p-0",
			className
		)}
		{...props} />
) );
Menubar.displayName = MenubarPrimitive.Root.displayName;

const MenubarTrigger = React.forwardRef( ( { className, ...props }, ref ) => (
	<MenubarPrimitive.Trigger
		ref={ref}
		className={cn(
			"flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground outline-hidden focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
			className
		)}
		{...props} />
) );
MenubarTrigger.displayName = MenubarPrimitive.Trigger.displayName;

const MenubarSubTrigger = React.forwardRef( ( { className, inset, children, ...props }, ref ) => (
	<MenubarPrimitive.SubTrigger
		ref={ref}
		className={cn(
			"flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs outline-hidden focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
			inset && "pl-7",
			className
		)}
		{...props}>
		{children}
		<ChevronRightIcon className="ml-auto h-3 w-3" />
	</MenubarPrimitive.SubTrigger>
) );
MenubarSubTrigger.displayName = MenubarPrimitive.SubTrigger.displayName;

const MenubarSubContent = React.forwardRef( ( { className, ...props }, ref ) => (
	<MenubarPrimitive.SubContent
		ref={ref}
		className={cn(
			"z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
			className
		)}
		{...props} />
) );
MenubarSubContent.displayName = MenubarPrimitive.SubContent.displayName;

const MenubarContent = React.forwardRef( (
	{ className, align = "start", alignOffset = - 4, sideOffset = 8, ...props },
	ref
) => (
	<MenubarPrimitive.Portal>
		<MenubarPrimitive.Content
			ref={ref}
			align={align}
			alignOffset={alignOffset}
			sideOffset={sideOffset}
			className={cn(
				"z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
				className
			)}
			{...props} />
	</MenubarPrimitive.Portal>
) );
MenubarContent.displayName = MenubarPrimitive.Content.displayName;

const MenubarItem = React.forwardRef( ( { className, inset, ...props }, ref ) => (
	<MenubarPrimitive.Item
		ref={ref}
		className={cn(
			"relative flex cursor-default select-none items-center rounded-sm px-2 py-1 text-xs outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
			inset && "pl-7",
			className
		)}
		{...props} />
) );
MenubarItem.displayName = MenubarPrimitive.Item.displayName;

const MenubarCheckboxItem = React.forwardRef( ( { className, children, checked, ...props }, ref ) => (
	<MenubarPrimitive.CheckboxItem
		ref={ref}
		className={cn(
			"relative flex cursor-default select-none items-center rounded-sm py-1 pl-7 pr-2 text-xs outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
			className
		)}
		checked={checked}
		{...props}>
		<span className="absolute left-2 flex h-3 w-3 items-center justify-center">
			<MenubarPrimitive.ItemIndicator>
				<CheckIcon className="h-3 w-3" />
			</MenubarPrimitive.ItemIndicator>
		</span>
		{children}
	</MenubarPrimitive.CheckboxItem>
) );
MenubarCheckboxItem.displayName = MenubarPrimitive.CheckboxItem.displayName;

const MenubarRadioItem = React.forwardRef( ( { className, children, ...props }, ref ) => (
	<MenubarPrimitive.RadioItem
		ref={ref}
		className={cn(
			"relative flex cursor-default select-none items-center rounded-sm py-1 pl-7 pr-2 text-xs outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
			className
		)}
		{...props}>
		<span className="absolute left-2 flex h-3 w-3 items-center justify-center">
			<MenubarPrimitive.ItemIndicator>
				<CheckIcon className="h-3 w-3" />
			</MenubarPrimitive.ItemIndicator>
		</span>
		{children}
	</MenubarPrimitive.RadioItem>
) );
MenubarRadioItem.displayName = MenubarPrimitive.RadioItem.displayName;

const MenubarLabel = React.forwardRef( ( { className, inset, ...props }, ref ) => (
	<MenubarPrimitive.Label
		ref={ref}
		className={cn( "px-2 py-1 text-xs font-semibold", inset && "pl-7", className )}
		{...props} />
) );
MenubarLabel.displayName = MenubarPrimitive.Label.displayName;

const MenubarSeparator = React.forwardRef( ( { className, ...props }, ref ) => (
	<MenubarPrimitive.Separator
		ref={ref}
		className={cn( "-mx-1 my-1 h-px bg-muted", className )}
		{...props} />
) );
MenubarSeparator.displayName = MenubarPrimitive.Separator.displayName;

const MenubarShortcut = ( {
	className,
	...props
} ) => {

	return (
		( <span
			className={cn( "ml-auto pl-4 text-2xs tracking-widest text-muted-foreground", className )}
			{...props} /> )
	);

};

MenubarShortcut.displayname = "MenubarShortcut";

export {
	Menubar,
	MenubarMenu,
	MenubarTrigger,
	MenubarContent,
	MenubarItem,
	MenubarSeparator,
	MenubarLabel,
	MenubarCheckboxItem,
	MenubarRadioGroup,
	MenubarRadioItem,
	MenubarPortal,
	MenubarSubContent,
	MenubarSubTrigger,
	MenubarGroup,
	MenubarSub,
	MenubarShortcut,
};
