import { Github } from 'lucide-react';
import { ThemeToggle } from '../../theme-toggle';
import { appVersion } from '@/utils/version';
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";

const ActionBar = ( { onGithubClick } ) => {

	return (
		<div className="flex items-center px-2 space-x-2">
			<ThemeToggle />
			<div className="text-xs">v{appVersion}</div>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Github className="cursor-pointer" onClick={onGithubClick} />
					</TooltipTrigger>
					<TooltipContent>View on GitHub</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);

};

export default ActionBar;
