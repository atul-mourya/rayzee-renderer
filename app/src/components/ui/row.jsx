import { MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const Row = ( { className, children, more, ...props } ) => {

	if ( more == null || more === false ) {

		return (
			<div className={cn( "flex items-center justify-between", className )} {...props}>
				{children}
			</div>
		);

	}

	return (
		<div className={cn( "flex items-center", className )} {...props}>
			<div className="flex-1 flex items-center justify-between min-w-0">
				{children}
			</div>
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label="More options"
						className="ml-1 inline-flex items-center justify-center h-5 w-4 shrink-0 text-muted-foreground hover:text-foreground focus:outline-none"
					>
						<MoreVertical size={12} />
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					sideOffset={8}
					className="w-64 p-3 rounded-lg bg-surface-float text-foreground border border-float-border/30 space-y-3 shadow-float [&_.bg-input]:bg-float-input"
				>
					{more}
				</PopoverContent>
			</Popover>
		</div>
	);

};

export { Row };
