
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Card, CardContent } from '@/components/ui/card';
import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';

import { cn } from "@/lib/utils";

const DataSelector = ( { className, data, value, onValueChange, ...props } ) => {

	const handleMoreInfo = ( redirection ) => {

		window
			.open( redirection, "_blank" )
			.focus();

	};

	return (
		<>
			<span className="opacity-50 text-xs truncate">{props.label}</span>
			<Popover>
				<PopoverTrigger asChild>
					<Button variant="outline" className={cn( "relative flex h-5 w-full rounded-full touch-none select-none items-center max-w-32", className )}>
						<span className="text-xm truncate">{data[ value ].name}</span>
						<ChevronDown size={14} className="shrink-0" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-[300px] p-0" align="start">
					<ScrollArea className="h-[600px]">
						<div className="grid grid-cols-2 gap-2 p-2">
							{data.map( ( item, index ) => (
								<Card
									key={item.name}
									className={cn(
										"cursor-pointer transition-colors",
										index.toString() === value
											? "border-1 border-primary bg-primary/10"
											: "hover:bg-accent"
									)}
									onClick={() => onValueChange( index.toString() )}
								>
									<CardContent className="p-2 relative">
										{item.redirection && <TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button variant="ghost" size="icon" className="absolute right-2 h-5 w-5" onClick={() => handleMoreInfo( item.redirection )}>
														<InfoIcon className="h-4 w-4 text-foreground opacity-50" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>Goto more info.</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
										}
										<img
											src={item.preview}
											alt={item.name}
											className="w-full aspect-square object-cover rounded-sm mb-2"
										/>
										<p className="text-xs text-center font-medium opacity-50 truncate">
											{item.name}
										</p>
										{index.toString() === value && (
											<div className="absolute inset-0 border-2 border-primary rounded-sm pointer-events-none" />
										)}
									</CardContent>
								</Card>
							) )}
						</div>
					</ScrollArea>
				</PopoverContent>
			</Popover>
		</>
	);

};

export { DataSelector };
