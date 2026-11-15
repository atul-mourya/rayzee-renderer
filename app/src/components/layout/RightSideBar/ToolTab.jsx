import { Check, Crop, FlipHorizontal2, FlipVertical2, RotateCcwSquare, RotateCwSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { useEditStore } from '@/store';
import { CROP_SHAPES, DEFAULT_OVERLAY, cropForAspect, flipGeometry, shapeAspect, shapeOf, turnQuarter } from '@/lib/edits';
import { ResetRow } from './ColorCorrectionsTab';

const label = ( text, tip ) => <span className="control-label truncate" title={tip}>{text}</span>;

const CORNERS = [
	{ value: 'bottom-right', label: 'Bottom right' },
	{ value: 'bottom-left', label: 'Bottom left' },
	{ value: 'top-right', label: 'Top right' },
	{ value: 'top-left', label: 'Top left' },
];

const ToolTab = () => {

	const picture = useEditStore( s => s.picture );
	const geometry = useEditStore( s => s.edits.geometry );
	const overlay = useEditStore( s => s.edits.overlay ) ?? DEFAULT_OVERLAY;
	const cropping = useEditStore( s => !! s.cropping );
	const store = useEditStore.getState();

	if ( ! picture ) {

		return (
			<div>
				<Separator className="bg-primary" />
				<p className="py-4 text-sm text-center text-muted-foreground">Pick a render on the left to crop or turn it.</p>
			</div>
		);

	}

	const { width, height } = picture;
	const shape = shapeOf( geometry, width, height );
	const current = () => useEditStore.getState().edits.geometry;

	// Choosing a shape or straightening shows the crop's frame on the picture.
	const pickShape = id => {

		store.startCrop();
		store.setGeometry( cropForAspect( current(), shapeAspect( id, current(), width, height ), width, height ) );

	};

	const straighten = value => {

		store.startCrop();
		store.setGeometry( { ...current(), angle: value[ 0 ] }, 'angle' );

	};

	const setOverlay = ( patch, key ) => store.setOverlay( { ...overlay, ...patch }, key );
	const turnButton = ( name, Icon, onClick ) => (
		<Button variant="outline" size="sm" aria-label={name} title={name} onClick={onClick}>
			<Icon size={14} />
		</Button>
	);

	return (
		<div>
			<Separator className="bg-primary" />
			<div className="space-y-2 px-2">
				<ResetRow sections={[ 'geometry', 'overlay' ]} />
				<Separator className="my-2" />

				<p className="text-sm font-semibold">Crop & Straighten</p>
				<div className="space-y-1.5">
					{label( 'Shape', 'The crop\'s shape, width to height. Original keeps the render\'s own; Free lets you drag any shape.' )}
					<div className="flex flex-wrap gap-1" aria-label="Shape">
						{CROP_SHAPES.map( s => (
							<Button key={s.id} variant="outline" aria-pressed={shape === s.id} onClick={() => pickShape( s.id )}
								className="h-6 rounded-md px-2 text-xs font-normal">
								{s.label}
							</Button>
						) )}
					</div>
				</div>
				<Row>
					<Slider label="Straighten" tip="Turns the picture to level a tilted horizon. The crop shrinks to keep the corners filled." min={- 45} max={45} step={0.1} precision={1} unit="°" snapPoints={[ 0 ]} value={[ geometry.angle ]} onValueChange={straighten} />
				</Row>
				{cropping ? (
					<div className="flex gap-2">
						<Button size="sm" className="flex-1" onClick={store.finishCrop}>
							<Check size={14} className="mr-1" />Done
						</Button>
						<Button size="sm" variant="outline" onClick={store.cancelCrop}>Cancel</Button>
					</div>
				) : (
					<Button size="sm" variant="outline" className="w-full" onClick={store.startCrop}>
						<Crop size={14} className="mr-1" />Crop
					</Button>
				)}

				<Separator className="my-2" />
				<p className="text-sm font-semibold">Turn & Flip</p>
				<div className="grid grid-cols-4 gap-1">
					{turnButton( 'Turn left', RotateCcwSquare, () => store.setGeometry( turnQuarter( current(), - 1 ) ) )}
					{turnButton( 'Turn right', RotateCwSquare, () => store.setGeometry( turnQuarter( current(), 1 ) ) )}
					{turnButton( 'Flip left to right', FlipHorizontal2, () => store.setGeometry( flipGeometry( current(), 'x' ) ) )}
					{turnButton( 'Flip upside down', FlipVertical2, () => store.setGeometry( flipGeometry( current(), 'y' ) ) )}
				</div>

				<Separator className="my-2" />
				<p className="text-sm font-semibold">Watermark</p>
				<Row>
					{label( 'Text', 'A name or note in a corner of the picture, on screen and in exported files.' )}
					<Input className="max-w-40 h-5 rounded-full text-xs px-2" value={overlay.text} placeholder="Your name or studio"
						onChange={e => setOverlay( { text: e.target.value }, 'overlay:text' )} />
				</Row>
				{overlay.text.trim() && (
					<>
						<Row>
							{label( 'Corner' )}
							<Select value={overlay.corner} onValueChange={corner => setOverlay( { corner } )}>
								<SelectTrigger size="sm" className="max-w-36"><SelectValue /></SelectTrigger>
								<SelectContent>
									{CORNERS.map( c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem> )}
								</SelectContent>
							</Select>
						</Row>
						<Row>
							<Slider label="Size" tip="How large the text is, against the picture's shorter side." min={0} max={100} step={1} unit="%" value={[ Math.round( overlay.size * 100 ) ]} onValueChange={v => setOverlay( { size: v[ 0 ] / 100 }, 'overlay:size' )} />
						</Row>
						<Row>
							<Slider label="Opacity" tip="How solid the text is: 100 % hides what is under it." min={0} max={100} step={1} unit="%" value={[ Math.round( overlay.opacity * 100 ) ]} onValueChange={v => setOverlay( { opacity: v[ 0 ] / 100 }, 'overlay:opacity' )} />
						</Row>
					</>
				)}
			</div>
		</div>
	);

};

export default ToolTab;
