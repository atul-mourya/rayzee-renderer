import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const MODES = [
	{ value: 'preview', label: 'Preview' },
	{ value: 'final-render', label: 'Render' },
	{ value: 'results', label: 'Results' },
];

// The three stages of work. One is always chosen: clicking the chosen one again keeps it.
const ModeTabs = ( { currentMode, onModeChange } ) => (
	<ToggleGroup type="single" variant="modes" aria-label="Mode" value={currentMode} onValueChange={mode => mode && onModeChange( mode )}>
		{MODES.map( ( { value, label } ) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem> )}
	</ToggleGroup>
);

export default ModeTabs;
