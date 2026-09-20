import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A hover-for-help mark beside a control's label.
 *
 * Goes inside the label so it sits with the name rather than taking a row of its own:
 * `label={<>Exposure<InfoTip text="…" /></>}`. Panel space is the scarce thing here — a sentence
 * of explanation under every control pushes the controls themselves off screen.
 *
 * ⚠️ `whitespace-normal` is load-bearing. Radix puts `white-space: nowrap` on its popper wrapper as
 * an inline style and the content inherits it, so without this a sentence renders as one long line
 * that `overflow-hidden` then clips at `max-w-56` — the tooltip reads as a truncated fragment.
 */
const InfoTip = ( { text } ) => (
	<TooltipProvider delayDuration={150}>
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="ml-1 inline-flex shrink-0 cursor-help opacity-40 hover:opacity-90"><Info size={11} /></span>
			</TooltipTrigger>
			<TooltipContent side="left" className="max-w-56 leading-snug whitespace-normal">{text}</TooltipContent>
		</Tooltip>
	</TooltipProvider>
);

export { InfoTip };
