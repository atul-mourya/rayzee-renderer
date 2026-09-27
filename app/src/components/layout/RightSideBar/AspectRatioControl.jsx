import { RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/ui/row";
import { usePathTracerStore } from '@/store';
import { ASPECT_RATIO_PRESETS, isPanorama } from '@/Constants';

// Narrow selectors: this store takes a per-frame auto-exposure write.
const AspectRatioControl = () => {

	const aspectRatioPreset = usePathTracerStore( s => s.aspectRatioPreset );
	const orientation = usePathTracerStore( s => s.orientation );
	const panorama = usePathTracerStore( s => isPanorama( s.cameraProjection ) );
	const handleAspectPresetChange = usePathTracerStore( s => s.handleAspectPresetChange );
	const handleOrientationToggle = usePathTracerStore( s => s.handleOrientationToggle );

	// A panorama is always 2:1.
	if ( panorama ) return null;

	return (
		<Row>
			<span className="opacity-50 text-xs truncate">Aspect Ratio</span>
			<div className="flex items-center gap-1">
				{aspectRatioPreset !== '1:1' && (
					<button
						onClick={handleOrientationToggle}
						className="p-1 rounded hover:bg-primary/20 transition-colors opacity-40 hover:opacity-100"
						title={orientation === 'landscape' ? 'Switch to portrait' : 'Switch to landscape'}
					>
						{orientation === 'landscape'
							? <RectangleHorizontal size={10} />
							: <RectangleVertical size={10} />
						}
					</button>
				)}
				<Select value={aspectRatioPreset} onValueChange={handleAspectPresetChange}>
					<SelectTrigger className="max-w-28 h-5 rounded-full">
						<SelectValue placeholder="Select ratio" />
					</SelectTrigger>
					<SelectContent>
						{Object.entries( ASPECT_RATIO_PRESETS ).map( ( [ key, preset ] ) => (
							<SelectItem key={key} value={key}>{preset.label}</SelectItem>
						) )}
					</SelectContent>
				</Select>
			</div>
		</Row>
	);

};

export default AspectRatioControl;
