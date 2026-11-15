import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "@/components/ui/row";
import { useShallow } from 'zustand/react/shallow';
import { usePathTracerStore } from '@/store';
import { pick } from '@/lib/utils';
import { SR_SCALE } from 'rayzee';
import { RESOLUTION_PRESETS, aspectRatioLabel, isPanorama } from '@/Constants';


// What this reads of the store: read whole, it redrew on every change to it, an exposure step included.
const STORE_KEYS = [
	'resolution', 'finalRenderResolution', 'aspectRatioPreset', 'sceneAspect', 'orientation', 'canvasWidth',
	'canvasHeight', 'cameraProjection', 'enableUpscaler', 'upscalerScale', 'upscalerBackend', 'handleResolutionChange',
	'handleFinalRenderResolutionChange'
];

const CanvasDimensionControls = ( { disabled = false, resolutionKey = 'resolution' } ) => {

	const {
		resolution,
		finalRenderResolution,
		aspectRatioPreset,
		sceneAspect,
		orientation,
		canvasWidth,
		canvasHeight,
		cameraProjection,
		enableUpscaler,
		upscalerScale,
		upscalerBackend,

		handleResolutionChange,
		handleFinalRenderResolutionChange,
	} = usePathTracerStore( useShallow( s => pick( s, STORE_KEYS ) ) );

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
				<span className="control-label truncate" title="The length of the picture's longer side, in pixels. Larger is sharper and slower.">Resolution</span>
				<Select value={String( currentResolution )} onValueChange={onResolutionChange} disabled={disabled}>
					<SelectTrigger size="sm" className="max-w-32">
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
			<Row>
				<span className="control-label truncate" title="The size of the finished picture. Its shape comes from Aspect Ratio in the Camera tab.">Output</span>
				<span className="text-xs text-muted-foreground">
					{outputWidth} &times; {outputHeight} ({panorama ? '2:1, 360°' : aspectRatioLabel( aspectRatioPreset, orientation, sceneAspect )})
				</span>
			</Row>

			{upscaleFactor > 1 && (
				<Row>
					<span className="opacity-50 text-xxs truncate">
						upscaled {upscaleFactor}&times; from {canvasWidth} &times; {canvasHeight}
					</span>
				</Row>
			)}

		</>
	);

};

export default CanvasDimensionControls;
