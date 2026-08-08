import { RectangleHorizontal, RectangleVertical } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/ui/row";
import { usePathTracerStore } from '@/store';
import { ASPECT_RATIO_PRESETS, RESOLUTION_PRESETS, isPanorama } from '@/Constants';


const CanvasDimensionControls = ( { disabled = false, resolutionKey = 'resolution' } ) => {

	const {
		resolution,
		finalRenderResolution,
		aspectRatioPreset,
		orientation,
		canvasWidth,
		canvasHeight,
		cameraProjection,

		handleResolutionChange,
		handleFinalRenderResolutionChange,
		handleAspectPresetChange,
		handleOrientationToggle,
	} = usePathTracerStore();

	const currentResolution = resolutionKey === 'finalRenderResolution' ? finalRenderResolution : resolution;
	const onResolutionChange = resolutionKey === 'finalRenderResolution' ? handleFinalRenderResolutionChange : handleResolutionChange;
	const panorama = isPanorama( cameraProjection );
	const showOrientation = aspectRatioPreset !== '1:1';

	return (
		<>

			{/* Resolution */}
			<Row>
				<span className="opacity-50 text-xs truncate">Resolution</span>
				<Select value={String( currentResolution )} onValueChange={onResolutionChange} disabled={disabled}>
					<SelectTrigger className="max-w-32 h-5 rounded-full">
						<SelectValue placeholder="Select resolution" />
					</SelectTrigger>
					<SelectContent>
						{RESOLUTION_PRESETS.map( ( option ) => (
							<SelectItem key={option.value} value={option.value.toString()}>{option.label}</SelectItem>
						) )}
					</SelectContent>
				</Select>
			</Row>

			{/* Aspect Ratio + Orientation */}
			{! panorama && (
				<Row>
					<span className="opacity-50 text-xs truncate">Aspect Ratio</span>
					<div className="flex items-center gap-1">
						{showOrientation && (
							<button
								onClick={handleOrientationToggle}
								className="p-1 rounded hover:bg-primary/20 transition-colors opacity-40 hover:opacity-100 disabled:opacity-20 disabled:pointer-events-none"
								title={orientation === 'landscape' ? 'Switch to portrait' : 'Switch to landscape'}
								disabled={disabled}
							>
								{orientation === 'landscape'
									? <RectangleHorizontal size={10} />
									: <RectangleVertical size={10} />
								}
							</button>
						)}
						<Select value={aspectRatioPreset} onValueChange={handleAspectPresetChange} disabled={disabled}>
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
			)}

			{/* Computed dimensions display */}
			<Row>
				<span className="opacity-50 text-xs truncate">Output</span>
				<span className="text-xs text-muted-foreground">
					{canvasWidth} &times; {canvasHeight}{panorama && ' (2:1, 360°)'}
				</span>
			</Row>

		</>
	);

};

export default CanvasDimensionControls;
