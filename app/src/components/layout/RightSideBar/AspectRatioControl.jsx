import { RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/ui/row";
import { usePathTracerStore } from '@/store';
import { ASPECT_RATIO_PRESETS, aspectRatioLabel, isPanorama } from '@/Constants';

// Narrow selectors: this store takes a per-frame auto-exposure write.
const AspectRatioControl = () => {

	const aspectRatioPreset = usePathTracerStore( s => s.aspectRatioPreset );
	const orientation = usePathTracerStore( s => s.orientation );
	const sceneAspect = usePathTracerStore( s => s.sceneAspect );
	const panorama = usePathTracerStore( s => isPanorama( s.cameraProjection ) );
	const handleAspectPresetChange = usePathTracerStore( s => s.handleAspectPresetChange );
	const handleOrientationToggle = usePathTracerStore( s => s.handleOrientationToggle );

	// A panorama is always 2:1.
	if ( panorama ) return null;

	return (
		<Row>
			<span className="control-label truncate" title="The picture's shape. The small button beside it swaps wide and tall.">Aspect Ratio</span>
			<div className="flex items-center gap-1">
				{aspectRatioPreset !== '1:1' && (
					<Button
						variant="quiet" size="icon-xs"
						onClick={handleOrientationToggle}
						title={orientation === 'landscape' ? 'Switch to portrait' : 'Switch to landscape'}
					>
						{orientation === 'landscape'
							? <RectangleHorizontal size={10} />
							: <RectangleVertical size={10} />
						}
					</Button>
				)}
				<Select value={aspectRatioPreset} onValueChange={handleAspectPresetChange}>
					<SelectTrigger size="sm" className="max-w-28">
						<SelectValue placeholder="Select ratio" />
					</SelectTrigger>
					<SelectContent>
						{Object.entries( ASPECT_RATIO_PRESETS ).map( ( [ key, preset ] ) => (
							<SelectItem key={key} value={key}>{preset.label}</SelectItem>
						) )}
						{/* The shape the loaded scene's file asked for, where no preset is it. */}
						{sceneAspect && <SelectItem value="scene">Scene {aspectRatioLabel( 'scene', 'landscape', sceneAspect )}</SelectItem>}
					</SelectContent>
				</Select>
			</div>
		</Row>
	);

};

export default AspectRatioControl;
