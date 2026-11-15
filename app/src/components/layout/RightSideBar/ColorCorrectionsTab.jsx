
import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { useEditStore } from '@/store';
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from '@/components/ui/separator';

/** A tab's Reset row: `sections` of the edit stack back to their defaults. */
export function ResetRow( { sections } ) {

	return (
		<Row className="my-2">
			<Button variant="outline" className={cn( "relative flex h-5 w-full rounded-full touch-none select-none items-center cursor-pointer" )} onClick={() => useEditStore.getState().reset( sections )}>
				<span className="text-xm truncate">{"Reset"}</span>
				<RotateCcw size={14} className="shrink-0 pl-1" />
			</Button>
		</Row>
	);

}

const ColorCorrectionsTab = () => {

	const adjust = useEditStore( s => s.edits.adjust );
	const set = key => value => useEditStore.getState().change( 'adjust', { [ key ]: Array.isArray( value ) ? value[ 0 ] : value } );

	return (
		<div className="">
			<Separator className="bg-primary" />
			<div className="space-y-2 px-2">
				<ResetRow sections={[ 'adjust' ]} />
				<Separator className="my-2" />
				<Row>
					<Slider label={"Brightness"} tip="Makes the whole picture brighter or darker, black areas included." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ adjust.brightness ]} onValueChange={set( 'brightness' )} />
				</Row>
				<Row>
					<Slider label={"Contrast"} tip="Makes darks darker and lights lighter. Below 0 makes everything greyer." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ adjust.contrast ]} onValueChange={set( 'contrast' )} />
				</Row>
				<Row>
					<Slider label={"Saturation"} tip="How strong the colours are. −100 is black and white." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ adjust.saturation ]} onValueChange={set( 'saturation' )} />
				</Row>
				<Row>
					<Slider label={"Hue"} tip="Shifts every colour around the colour wheel." min={- 180} max={180} step={1} value={[ adjust.hue ]} onValueChange={set( 'hue' )} />
				</Row>
				<Row>
					<Slider label={"Exposure"} tip="Like a camera's exposure: 100 doubles the light, −100 halves it. Black stays black." min={- 100} max={100} step={1} snapPoints={[ - 100, - 50, 0, 50, 100 ]} value={[ adjust.exposure ]} onValueChange={set( 'exposure' )} />
				</Row>
				<Row>
					<Slider label={"Gamma"} tip="Brightens or darkens the mid-tones, leaving black and white alone. 2.2 leaves the picture as it was." min={0.1} max={4} step={0.1} snapPoints={[ 0.1, 1, 2.2, 3, 4 ]} value={[ adjust.gamma ]} onValueChange={set( 'gamma' )} />
				</Row>
			</div>
		</div>
	);

};

export default ColorCorrectionsTab;
