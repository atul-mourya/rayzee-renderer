import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePathTracerStore as useStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Separator } from '@/components/ui/separator';
import CanvasDimensionControls from './CanvasDimensionControls';
import NeuralPostControls from './NeuralPostControls';


const FinalRenderPanel = () => {

	const {
		bounces,
		tilesHelper,
		enableOIDN,
		denoiserStrategy,
		oidnQuality,

		handleBouncesChange,
		handleTileHelperToggle,
		handleEnableOIDNChange,
		handleOidnQualityChange,
	} = useStore();


	return (
		<div className="">
			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<Row>
					<Slider label={"Bounces"} tip="How many times light may bounce between surfaces. More fills corners and rooms with light, but renders slower." min={0} max={20} step={1} value={[ bounces ]} onFinishChange={handleBouncesChange} />
				</Row>
				<CanvasDimensionControls resolutionKey="finalRenderResolution" />
			</ControlGroup>
			{/* Same ControlGroup the Preview panel uses. Its open body supplies the padding and the
			    vertical rhythm every Row here relies on — without it the sliders ran under the panel
			    edge and the switches were clipped. */}
			<ControlGroup name="Denoising" defaultOpen={true}>
				<Row>
					<Switch label={"Final Denoise (OIDN)"} tip="Removes the grain from the finished render with AI, once it is done." checked={enableOIDN} onCheckedChange={handleEnableOIDNChange}/>
				</Row>
				{( enableOIDN || denoiserStrategy === 'oidn' ) && ( <>
					<Row>
						<Select value={oidnQuality} onValueChange={handleOidnQualityChange}>
							<span className="opacity-50 text-xs truncate" title="How hard the AI clean-up works. High keeps the most detail but is slowest. Fast (clean aux) is as quick as Fast: a bit better on finished renders, worse on grainy ones.">OIDN Quality</span>
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
					<Row>
						<Switch label={"Tile Helper"} tip="Outlines each piece of the picture as the AI clean-up works through it." checked={tilesHelper} onCheckedChange={handleTileHelperToggle} />
					</Row>
				</> )}

				<Separator />

				<NeuralPostControls />
			</ControlGroup>
		</div>
	);

};

export default FinalRenderPanel;
