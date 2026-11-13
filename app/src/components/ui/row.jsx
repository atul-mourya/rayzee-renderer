import * as React from "react";
import { MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A row's control is named by the row's label (its first `control-label` child): SelectTrigger and ToggleGroup read it.
const RowLabel = React.createContext( undefined );
const useRowLabel = () => React.useContext( RowLabel );

function useLabelled( children ) {

	const id = React.useId();
	const items = React.Children.toArray( children );
	const at = items.findIndex( child => React.isValidElement( child ) && /\bcontrol-label\b/.test( child.props.className ?? "" ) );
	if ( at < 0 ) return [ children, undefined ];
	if ( items[ at ].props.id ) return [ children, items[ at ].props.id ];
	return [ items.map( ( child, i ) => i === at ? React.cloneElement( child, { id } ) : child ), id ];

}

const Row = ( { className, children, more, ...props } ) => {

	const [ named, labelId ] = useLabelled( children );

	if ( more == null || more === false ) {

		return (
			<RowLabel.Provider value={labelId}>
				<div className={cn( "flex items-center justify-between", className )} {...props}>
					{named}
				</div>
			</RowLabel.Provider>
		);

	}

	return (
		<RowLabel.Provider value={labelId}>
			<div className={cn( "flex items-center", className )} {...props}>
				<div className="flex-1 flex items-center justify-between min-w-0">
					{named}
				</div>
				<Popover>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label="More options"
							className="ml-1 inline-flex items-center justify-center h-5 w-4 shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
						>
							<MoreVertical size={12} />
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						sideOffset={8}
						className="w-64 p-3 rounded-lg bg-surface-float text-foreground border border-float-border/30 space-y-3 shadow-float [&_.bg-input]:bg-float-input"
					>
						<RowLabel.Provider value={undefined}>{more}</RowLabel.Provider>
					</PopoverContent>
				</Popover>
			</div>
		</RowLabel.Provider>
	);

};

export { Row, useRowLabel };
