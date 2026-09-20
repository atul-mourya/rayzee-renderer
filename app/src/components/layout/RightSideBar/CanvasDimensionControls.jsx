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
		enableUpscaler,
		upscalerScale,
		upscalerBackend,

		handleResolutionChange,
		handleFinalRenderResolutionChange,
		handleAspectPresetChange,
		handleOrientationToggle,
	} = usePathTracerStore();

	const currentResolution = resolutionKey === 'finalRenderResolution' ? finalRenderResolution : resolution;
	const onResolutionChange = resolutionKey === 'finalRenderResolution' ? handleFinalRenderResolutionChange : handleResolutionChange;
	const panorama = isPanorama( cameraProjection );

	// The delivered image, not the traced one: an upscaler enlarges the result, so reporting the
	// render size here left the panel disagreeing with the picture on screen. DLSS is a fixed 2x.
	const upscaleFactor = enableUpscaler ? ( upscalerBackend === 'dlss' ? 2 : upscalerScale ) : 1;
	const outputWidth = canvasWidth * upscaleFactor;
	const outputHeight = canvasHeight * upscaleFactor;
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
					{outputWidth} &times; {outputHeight}{panorama && ' (2:1, 360°)'}
				</span>
			</Row>

			{upscaleFactor > 1 && (
				<Row>
					<span className="opacity-50 text-[10px] truncate">
						upscaled {upscaleFactor}&times; from {canvasWidth} &times; {canvasHeight}
					</span>
				</Row>
			)}

		</>
	);

};

export default CanvasDimensionControls;
