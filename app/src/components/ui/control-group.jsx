import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

export function ControlGroup( { name, icon: Icon, children, className, defaultOpen = false } ) {

	const [ isOpen, setIsOpen ] = useState( defaultOpen );

	return (
		<>
			<button
				onClick={() => setIsOpen( ! isOpen )}
				className={cn(
					"flex w-full items-center justify-between py-2 px-2 text-xs bg-muted opacity-60",
					! isOpen ? "border-b-[0.5px] border-current" : "",
					className )}
			>
				<div className="flex items-center">
					{Icon && <Icon className={cn(
						"h-4 w-4 mr-2",
						isOpen ? "rotate-180" : ""
					)} />}
					{name}
				</div>
				<ChevronDown
					className={cn(
						"h-4 w-4",
						isOpen ? "rotate-180" : ""
					)}
				/>
			</button>
			{isOpen && (
				<div className="space-y-4 py-4 px-2">
					{children}
				</div>
			)}
		</>
	);

}
