
import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { useStore } from '@/store';
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from '@/components/ui/separator';


const ColorCorrectionsTab = () => {

	const imageProcessing = useStore( state => state.imageProcessing );
	const handleImageProcessingParamChange = useStore( state => state.handleImageProcessingParamChange );
	const handleResetImageProcessing = useStore( state => state.handleResetImageProcessing || state.resetImageProcessing );

	return (
		<div className="">
			<Separator className="bg-primary" />
			<div className="space-y-2 px-2">
				<Row className="my-2">
					<Button variant="outline" className={cn( "relative flex h-5 w-full rounded-full touch-none select-none items-center cursor-pointer" )} onClick={handleResetImageProcessing}>
						<span className="text-xm truncate">{"Reset"}</span>
						<RotateCcw size={14} className="shrink-0 pl-1" />
					</Button>
				</Row>
				<Separator className="my-2" />
				<Row>
					<Slider label={"Brightness"} tip="Makes the whole picture brighter or darker, black areas included." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.brightness ]} onValueChange={handleImageProcessingParamChange( 'brightness' )} />
				</Row>
				<Row>
					<Slider label={"Contrast"} tip="Makes darks darker and lights lighter. Below 0 makes everything greyer." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.contrast ]} onValueChange={handleImageProcessingParamChange( 'contrast' )} />
				</Row>
				<Row>
					<Slider label={"Saturation"} tip="How strong the colours are. −100 is black and white." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.saturation ]} onValueChange={handleImageProcessingParamChange( 'saturation' )} />
				</Row>
				<Row>
					<Slider label={"Hue"} tip="Shifts every colour around the colour wheel." min={- 180} max={180} step={1} value={[ imageProcessing.hue ]} onValueChange={handleImageProcessingParamChange( 'hue' )} />
				</Row>
				<Row>
					<Slider label={"Exposure"} tip="Like a camera's exposure: 100 doubles the light, −100 halves it. Black stays black." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ imageProcessing.exposure ]} onValueChange={handleImageProcessingParamChange( 'exposure' )} />
				</Row>
				<Row>
					<Slider label={"Gamma"} tip="Brightens or darkens the mid-tones, leaving black and white alone. 2.2 leaves the picture as it was." min={0.1} max={4} step={0.1} snapPoints={[ 0.1, 1, 2.2, 3, 4 ]} value={[ imageProcessing.gamma ]} onValueChange={handleImageProcessingParamChange( 'gamma' )} />
				</Row>
			</div>
		</div>
	);

};

export default ColorCorrectionsTab;
