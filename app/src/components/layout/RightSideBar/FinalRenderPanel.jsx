import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore as useStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Separator } from '@/components/ui/separator';
import CanvasDimensionControls from './CanvasDimensionControls';


const FinalRenderPanel = () => {

	const {
		bounces,
		tilesHelper,
		enableOIDN,
		oidnQuality,
		enableUpscaler,
		upscalerScale,
		upscalerQuality,

		handleBouncesChange,
		handleTileHelperToggle,
		handleEnableOIDNChange,
		handleOidnQualityChange,
		handleEnableUpscalerChange,
		handleUpscalerScaleChange,
		handleUpscalerQualityChange,
	} = useStore();


	return (
		<div className="">
			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<Row>
					<Slider label={"Bounces"} min={0} max={20} step={1} value={[ bounces ]} onFinishChange={handleBouncesChange} />
				</Row>
				<CanvasDimensionControls resolutionKey="finalRenderResolution" />
			</ControlGroup>
			<Separator className="bg-primary/20 mt-3.5 mb-3.5" />
			<Row className="py-2 px-2">
				<Switch label={"Enable AI Denoising"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange}/>
			</Row>
			{enableOIDN && ( <>
				<Row className="py-2 px-2">
					<Select value={oidnQuality} onValueChange={handleOidnQualityChange}>
						<span className="opacity-50 text-xs truncate">OIDN Quality</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select quality" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="fast">Fast</SelectItem>
							<SelectItem value="fast-clean">Fast (clean aux)</SelectItem>
							<SelectItem value="balance">Balance</SelectItem>
							<SelectItem value="high">High</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				<Row className="py-2 px-2">
					<Switch label={"Tile Helper"} checked={tilesHelper} onCheckedChange={handleTileHelperToggle} />
				</Row>
			</> )}
			<Separator className="bg-primary/20 mt-3.5 mb-3.5" />
			<Row className="py-2 px-2">
				<Switch label={"AI Upscaler"} checked={enableUpscaler} onCheckedChange={handleEnableUpscalerChange} />
			</Row>
			{enableUpscaler && ( <>
				<Row className="py-2 px-2">
					<Select value={upscalerScale.toString()} onValueChange={handleUpscalerScaleChange}>
						<span className="opacity-50 text-xs truncate">Scale Factor</span>
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue placeholder="Select scale" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="2">2x</SelectItem>
							<SelectItem value="4">4x</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				<Row className="py-2 px-2">
					<Select value={upscalerQuality} onValueChange={handleUpscalerQualityChange}>
						<span className="opacity-50 text-xs truncate">Quality</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select quality" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="fast">Fast</SelectItem>
							<SelectItem value="balanced">Balanced</SelectItem>
							<SelectItem value="quality">Quality</SelectItem>
						</SelectContent>
					</Select>
				</Row>
			</> )}
			<Separator className="bg-primary/20 mt-3.5 mb-3.5" />
		</div>
	);

};

export default FinalRenderPanel;
