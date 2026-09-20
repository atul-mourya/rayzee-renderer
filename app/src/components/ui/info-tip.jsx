import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipPortal, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A hover-for-help mark beside a control's label.
 *
 * Goes inside the label so it sits with the name rather than taking a row of its own:
 * `label={<>Exposure<InfoTip text="…" /></>}`. Panel space is the scarce thing here — a sentence
 * of explanation under every control pushes the controls themselves off screen.
 *
 * ⚠️ Two things here are load-bearing, both because the panel's label span is a hostile parent.
 *
 * The portal: `Slider` and `Switch` wrap their label in `opacity-50`, and the tip lives inside that
 * label. Radix renders its content in place unless portalled, so the tooltip inherited the 0.5 and
 * came out half transparent over the render — unreadable. Portalling puts it under `<body>`, where
 * it inherits nothing.
 *
 * `whitespace-normal`: Radix puts `white-space: nowrap` on its popper wrapper as an inline style and
 * the content inherits that too, so without this a sentence renders as one long line that
 * `overflow-hidden` then clips at `max-w-56` — the tooltip reads as a truncated fragment.
 */
const InfoTip = ( { text } ) => (
	<TooltipProvider delayDuration={150}>
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="ml-1 inline-flex shrink-0 cursor-help opacity-40 hover:opacity-90"><Info size={11} /></span>
			</TooltipTrigger>
			<TooltipPortal>
				<TooltipContent side="left" className="max-w-56 leading-snug whitespace-normal">{text}</TooltipContent>
			</TooltipPortal>
		</Tooltip>
	</TooltipProvider>
);

export { InfoTip };
