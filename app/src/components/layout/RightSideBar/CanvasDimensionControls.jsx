import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/ui/row";
import { usePathTracerStore } from '@/store';
import { SR_SCALE } from 'rayzee';
import { RESOLUTION_PRESETS, aspectRatioLabel, isPanorama } from '@/Constants';


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
	} = usePathTracerStore();

	const currentResolution = resolutionKey === 'finalRenderResolution' ? finalRenderResolution : resolution;
	const onResolutionChange = resolutionKey === 'finalRenderResolution' ? handleFinalRenderResolutionChange : handleResolutionChange;
	const panorama = isPanorama( cameraProjection );

	// The delivered image, not the traced one: an upscaler enlarges the result, so reporting the
	// render size here left the panel disagreeing with the picture on screen. Neural super resolution is a fixed 2x.
	const upscaleFactor = enableUpscaler ? ( upscalerBackend === 'neural' ? SR_SCALE : upscalerScale ) : 1;
	const outputWidth = canvasWidth * upscaleFactor;
	const outputHeight = canvasHeight * upscaleFactor;

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

			{/* Computed dimensions display */}
			<Row title="The shape is set by Aspect Ratio in the Camera tab, while previewing">
				<span className="opacity-50 text-xs truncate">Output</span>
				<span className="text-xs text-muted-foreground">
					{outputWidth} &times; {outputHeight} ({panorama ? '2:1, 360°' : aspectRatioLabel( aspectRatioPreset, orientation )})
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
