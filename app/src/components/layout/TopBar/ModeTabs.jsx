import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Tab button component based on the control button pattern
const TabButton = ( { label, value, currentValue, onClick } ) => {

	const isActive = value === currentValue;

	return (
		<Button
			variant="ghost"
			className={cn(
				"h-8 px-3 rounded-md",
				isActive && "bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary",
				! isActive && "text-muted-foreground hover:text-foreground hover:bg-accent/50"
			)}
			onClick={() => onClick( value )}
		>
			{label}
		</Button>
	);

};

const ModeTabs = ( { currentMode, onModeChange } ) => {

	// Tab definitions
	const tabs = [
		{
			label: 'Preview',
			value: 'preview',
		},
		{
			label: 'Render',
			value: 'final-render',
		},
		{
			label: 'Results',
			value: 'results',
		}
	];

	return (
		<div className="flex h-8 bg-background/90 rounded-full overflow-hidden shadow-md border border-border">
			{tabs.map( ( tab, index ) => (
				<div key={tab.value} className="flex items-center">
					{index > 0 && <div className="w-px bg-muted h-8"></div>}
					<TabButton
						label={tab.label}
						value={tab.value}
						currentValue={currentMode}
						onClick={onModeChange}
					/>
				</div>
			) )}
		</div>
	);

};

export default ModeTabs;
