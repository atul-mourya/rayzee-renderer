import { useEffect, useState } from 'react';
import { Row } from '@/components/ui/row';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { useStore, useEditStore } from '@/store';
import { LOOKS } from '@/lib/edits';
import { lookThumbnails } from '@/lib/ImageProcessor';
import { ResetRow } from './ColorCorrectionsTab';

const TILES = [ { id: null, label: 'None', tip: 'The picture as it is, without a look.' }, ...LOOKS ];

// The open render through each look, small, made again a moment after its crop or Adjust edits change.
function useThumbnails() {

	const picture = useEditStore( s => s.picture );
	const geometry = useEditStore( s => s.edits.geometry );
	const adjust = useEditStore( s => s.edits.adjust );
	const [ thumbs, setThumbs ] = useState( {} );

	useEffect( () => {

		if ( ! picture ) return;
		const timer = setTimeout( () => {

			const source = useStore.getState().resultsViewportRef?.current?.getCanvas();
			if ( source?.width ) setThumbs( lookThumbnails( source, { geometry, adjust } ) );

		}, 250 );
		return () => clearTimeout( timer );

	}, [ picture, geometry, adjust ] );

	return thumbs;

}

const percent = v => [ Math.round( v * 100 ) ];

const FiltersTab = () => {

	const picture = useEditStore( s => s.picture );
	const look = useEditStore( s => s.edits.look );
	const detail = useEditStore( s => s.edits.detail );
	const vignette = useEditStore( s => s.edits.effects.vignette );
	const grain = useEditStore( s => s.edits.effects.grain );
	const thumbs = useThumbnails();
	const store = useEditStore.getState();

	if ( ! picture ) {

		return (
			<div>
				<Separator className="bg-primary" />
				<p className="py-4 text-sm text-center text-muted-foreground">Pick a render on the left to add a look or an effect.</p>
			</div>
		);

	}

	const pickLook = id => store.change( 'look', { id, amount: id && look.amount === 0 ? 1 : look.amount }, null );

	return (
		<div>
			<Separator className="bg-primary" />
			<div className="space-y-2 px-2">
				<ResetRow sections={[ 'look', 'detail', 'effects' ]} />
				<Separator className="my-2" />

				<p className="text-sm font-semibold">Looks</p>
				<div className="grid grid-cols-4 gap-1.5" aria-label="Looks">
					{TILES.map( tile => {

						const active = look.id === tile.id;
						const src = thumbs[ tile.id ?? 'none' ];
						return (
							<button key={tile.id ?? 'none'} type="button" aria-pressed={active} title={tile.tip} onClick={() => pickLook( tile.id )} className="flex flex-col gap-1 min-w-0">
								<span className={`block w-full aspect-[4/3] rounded overflow-hidden bg-well ${active ? 'ring-2 ring-primary' : 'ring-1 ring-border'}`}>
									{src && <img src={src} alt="" className="w-full h-full object-cover" />}
								</span>
								<span className={`text-xs leading-none truncate ${active ? '' : 'opacity-60'}`}>{tile.label}</span>
							</button>
						);

					} )}
				</div>
				{look.id && (
					<Row>
						<Slider label="Amount" tip="How strongly the look applies." min={0} max={100} step={1} unit="%" value={percent( look.amount )} onValueChange={v => store.change( 'look', { amount: v[ 0 ] / 100 } )} />
					</Row>
				)}

				<Separator className="my-2" />
				<p className="text-sm font-semibold">Detail</p>
				<Row>
					<Slider label="Sharpen" tip="Crisper fine detail. Zoom in to 100 % to judge it." min={0} max={100} step={1} value={percent( detail.sharpen )} onValueChange={v => store.change( 'detail', { sharpen: v[ 0 ] / 100 } )} />
				</Row>
				<Row>
					<Slider label="Clarity" tip="More punch in textures and mid-tones. Below 0 softens them." min={- 100} max={100} step={1} snapPoints={[ 0 ]} value={percent( detail.clarity )} onValueChange={v => store.change( 'detail', { clarity: v[ 0 ] / 100 } )} />
				</Row>

				<Separator className="my-2" />
				<p className="text-sm font-semibold">Effects</p>
				<Row more={vignette.amount !== 0 ? (
					<>
						<Row>
							<Slider label="Size" tip="How far in from the edges it reaches: higher keeps more of the middle clear." min={0} max={100} step={1} value={percent( vignette.size )} onValueChange={v => store.setEffect( 'vignette', { size: v[ 0 ] / 100 } )} />
						</Row>
						<Row>
							<Slider label="Softness" tip="How gently it fades in." min={0} max={100} step={1} value={percent( vignette.softness )} onValueChange={v => store.setEffect( 'vignette', { softness: v[ 0 ] / 100 } )} />
						</Row>
					</>
				) : null}>
					<Slider label="Vignette" tip="Below 0 darkens the edges, above 0 lightens them." min={- 100} max={100} step={1} snapPoints={[ 0 ]} value={percent( vignette.amount )} onValueChange={v => store.setEffect( 'vignette', { amount: v[ 0 ] / 100 } )} />
				</Row>
				<Row more={grain.amount > 0 ? (
					<Row>
						<Slider label="Size" tip="How coarse the grain is." min={0} max={100} step={1} value={percent( grain.size )} onValueChange={v => store.setEffect( 'grain', { size: v[ 0 ] / 100 } )} />
					</Row>
				) : null}>
					<Slider label="Grain" tip="Film-like grain over the picture, the same in every export." min={0} max={100} step={1} value={percent( grain.amount )} onValueChange={v => store.setEffect( 'grain', { amount: v[ 0 ] / 100 } )} />
				</Row>
			</div>
		</div>
	);

};

export default FiltersTab;
