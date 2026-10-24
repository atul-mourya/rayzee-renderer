import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Row } from '@/components/ui/row';
import { useToast } from '@/hooks/use-toast';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useActiveApp } from '@/hooks/useActiveApp';
import { useStore, useAnimationStore, videoDuration } from '@/store';
import { useColorStatus, colorManagement, ensureDefaultConfig } from '@/lib/colorManagement';
import { exportSpaceOptions, workingSpaceLabel } from '@/lib/colorLabels';
import {
	PICTURE_FORMATS, VIDEO_FORMATS, LAYERS, DEFAULT_PICTURE, PICTURE_SETTINGS_KEY,
	holdsLight, takesGainMap, isLossy, isFrameSequence, exportPicture, exportSavedRender, canPickFolder, videoBitrate,
} from '@/lib/exporter';
import { pickFramesFolder } from '@/lib/folders';

const WORKING = '__working__';

/** HEIC and AVIF go through the browser's video encoder, which not every browser has: asked when the window opens. */
function useFormats( open ) {

	const [ still, setStill ] = useState( { heic: true, avif: true } );
	useEffect( () => {

		if ( ! open ) return;
		let live = true;
		import( 'rayzee/encoders' ).then( ( { canEncodeStill, prepareStill } ) => {

			// The first HEIC or MP4 after a browser launch waited ~5 s for the encoder to start; started now, mostly hidden.
			prepareStill( 'heic' );
			return Promise.all( [ canEncodeStill( 'heic' ), canEncodeStill( 'avif' ) ] );

		} ).then( ( [ heic, avif ] ) => live && setStill( { heic, avif } ) );
		return () => {

			live = false;

		};

	}, [ open ] );

	return PICTURE_FORMATS.map( f => ( still[ f.value ] === false ? { ...f, disabled: true, hint: 'this browser cannot write it' } : f ) );

}

const label = ( text, tip ) => <span className="opacity-50 text-xs truncate" title={tip}>{text}</span>;

const item = o => <SelectItem key={o.value} value={String( o.value )} hint={o.hint} disabled={o.disabled}>{o.label}</SelectItem>;

function Choice( { text, tip, value, options, onChange, onOpenChange } ) {

	return (
		<Row>
			{label( text, tip )}
			<Select value={String( value )} onValueChange={onChange} onOpenChange={onOpenChange}>
				<SelectTrigger className="max-w-48 h-6 rounded-full pl-3">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>{options.map( item )}</SelectContent>
			</Select>
		</Row>
	);

}

const DEPTHS = [
	{ value: 8, label: '8-bit', hint: 'standard, smaller' },
	{ value: 16, label: '16-bit', hint: 'smoother gradients for editing' },
];

const PRECISIONS = [
	{ value: 'half', label: 'Half', hint: 'smaller files, plenty for most work' },
	{ value: 'float', label: 'Full', hint: 'every value exact, twice the size' },
];

const LOOKS = [
	{ value: 'shown', label: 'As on screen', hint: 'looks like the screen in any viewer' },
	{ value: 'raw', label: 'Raw light', hint: 'for compositing; viewers show it without the look' },
];

/** EXR and HDR: the picture as the screen shows it, or the light before exposure and tone mapping. */
function Look( { settings, update } ) {

	return (
		<Choice
			text="Picture"
			tip="As on screen keeps the exposure, tone mapping and look, so the file opens looking like the screen (with its HDR highlights when the screen shows HDR). Raw light is what compositing programs expect; they apply a look of their own."
			value={settings.asShown ? 'shown' : 'raw'}
			options={LOOKS}
			onChange={v => update( { asShown: v === 'shown' } )}
		/>
	);

}

const FRAME_RATES = [ 24, 25, 30, 60 ].map( value => ( { value, label: `${value} frames a second` } ) );

const QUALITIES = [
	{ value: 'standard', label: 'Standard' },
	{ value: 'high', label: 'High' },
	{ value: 'best', label: 'Best' },
];

function Quality( { value, onChange } ) {

	return (
		<Row>
			<Slider label="Quality" tip="Higher keeps more detail and makes a larger file." min={50} max={100} step={1} unit="%" value={[ Math.round( value * 100 ) ]} onValueChange={( [ v ] ) => onChange( v / 100 )} />
		</Row>
	);

}

/** EXR and HDR hold light in a colour space; the choice is the colour management's export space. */
function ColorSpace() {

	const status = useColorStatus();
	const config = status?.config ?? null;
	const working = status?.workingSpace ?? '';
	const spaces = exportSpaceOptions( config ).filter( o => o.value !== working );
	const options = [ { value: WORKING, label: workingSpaceLabel( working ) || 'As rendered', hint: 'the render\'s own, no conversion' }, ...spaces ];

	return (
		<Choice
			text="Colour space"
			tip="Programs that read the file expect a colour space. Keep the render's own unless yours asks for another, such as ACES2065-1."
			value={status?.exportSpace ?? WORKING}
			options={options}
			onChange={v => colorManagement()?.setExportSpace( v === WORKING ? null : v )}
			// The list comes from the colour config, which loads the first time it is needed.
			onOpenChange={open => open && ensureDefaultConfig().catch( () => {} )}
		/>
	);

}

function Layers( { value, onChange, available } ) {

	const toggle = ( layer, on ) => onChange( on ? [ ...value, layer ] : value.filter( l => l !== layer ) );

	return (
		<div className="space-y-1.5">
			{label( 'Extra layers', 'Saved in the same EXR beside the picture, for compositing programs.' )}
			{LAYERS.map( layer => {

				const missing = available && ! available[ layer.value ];
				return (
					<label key={layer.value} className="flex items-center gap-2 text-xs cursor-pointer" title={missing ? 'Needs a denoiser on while the picture renders.' : layer.tip}>
						<Checkbox checked={value.includes( layer.value ) && ! missing} disabled={missing} onCheckedChange={on => toggle( layer.value, on )} />
						<span className={missing ? 'opacity-30' : 'opacity-70'}>{layer.label}</span>
					</label>
				);

			} )}
		</div>
	);

}

function PictureOptions( { settings, update, available, hdr } ) {

	const { format } = settings;
	return (
		<>
			{format === 'png' && <Choice text="Colour depth" tip="How finely each colour is stored." value={settings.bitDepth} options={DEPTHS} onChange={v => update( { bitDepth: Number( v ) } )} />}
			{takesGainMap( format ) && hdr && (
				<Row>
					<Switch checked={settings.hdr} label="HDR" tip="Keeps the bright highlights your HDR screen shows. Preview, Photos, Chrome and Safari show them on HDR screens; other viewers show the normal picture." onCheckedChange={v => update( { hdr: v } )} />
				</Row>
			)}
			{isLossy( format ) && <Quality value={settings.quality} onChange={quality => update( { quality } )} />}
			{holdsLight( format ) && <Look settings={settings} update={update} />}
			{format === 'exr' && <Choice text="Precision" tip="How exactly each value is stored." value={settings.precision} options={PRECISIONS} onChange={precision => update( { precision } )} />}
			{holdsLight( format ) && ! settings.asShown && <ColorSpace />}
			{format === 'exr' && ! settings.asShown && <Layers value={settings.passes} onChange={passes => update( { passes } )} available={available} />}
		</>
	);

}

const summary = ( width, height, what ) => <p className="text-xs opacity-50">{width} × {height} · {what}</p>;

function describe( settings, info ) {

	const { format } = settings;
	const name = PICTURE_FORMATS.find( f => f.value === format )?.label;
	if ( holdsLight( format ) && ! settings.asShown ) return `${name}, the light itself — exposure and tone mapping are not applied`;
	if ( holdsLight( format ) ) return `${name}, as the picture looks on screen${info?.hdr ? ' — photo viewers show it in normal range; for HDR there, use JPEG, HEIC or AVIF' : ''}`;
	if ( takesGainMap( format ) && settings.hdr && info?.hdr ) return `${name}, as on screen, HDR highlights included`;
	return `${name}, as the picture looks on screen`;

}

function LivePicture( { settings, update, info, formats } ) {

	const { format } = settings;
	const upscalable = info?.upscaled && ( format === 'webp' || ( format === 'png' && settings.bitDepth !== 16 ) || ( format === 'jpeg' && ! ( settings.hdr && info.hdr ) ) );
	const size = upscalable && settings.upscaled ? info.upscaled : info;

	return (
		<div className="space-y-3">
			<Choice text="Format" value={format} options={formats} onChange={f => update( { format: f } )} />
			<PictureOptions settings={settings} update={update} available={info?.layers} hdr={info?.hdr} />
			{upscalable && (
				<Row>
					<Switch checked={settings.upscaled} label="Upscaled picture" tip="Save the larger picture the AI upscaler made, instead of the render itself." onCheckedChange={upscaled => update( { upscaled } )} />
				</Row>
			)}
			{info && summary( size.width, size.height, describe( settings, info ) )}
		</div>
	);

}

function SavedPicture( { settings, update, result, source, setSource, formats: available } ) {

	const sources = [
		{ value: 'edited', label: 'With your edits' },
		{ value: 'original', label: 'As rendered' },
		...( result.aiGeneratedImage ? [ { value: 'ai', label: 'AI version' } ] : [] ),
	];
	const formats = available.map( f => ( holdsLight( f.value ) && ! result.hasHDR ? { ...f, disabled: true, hint: 'this render kept no full-range copy' } : f ) );
	const format = holdsLight( settings.format ) && ! result.hasHDR ? 'png' : settings.format;

	return (
		<div className="space-y-3">
			<Choice text="Format" value={format} options={formats} onChange={f => update( { format: f } )} />
			{! holdsLight( format ) && <Choice text="Picture" value={source} options={sources} onChange={setSource} />}
			{isLossy( format ) && <Quality value={settings.quality} onChange={quality => update( { quality } )} />}
			{holdsLight( format ) && <p className="text-xs opacity-50">{format === 'exr' ? 'The full-range copy, as it was saved.' : 'The full-range copy, converted to Radiance HDR.'}</p>}
		</div>
	);

}

function VideoOptions( { settings, update, info, duration, animates } ) {

	const { format, fps } = settings;
	const frames = isFrameSequence( format );
	const count = Math.ceil( duration * fps );
	const perMinute = quality => videoBitrate( info?.width ?? 0, info?.height ?? 0, fps, quality ) * 60 / 8 / 1e6;
	const qualities = QUALITIES.map( q => ( { ...q, hint: info ? `about ${Math.round( perMinute( q.value ) )} MB a minute` : undefined } ) );

	if ( ! animates ) {

		return <p className="text-xs opacity-60 leading-relaxed">Nothing moves yet. Load an animated model, or add camera keyframes in the Animation tab, then export the video.</p>;

	}

	return (
		<div className="space-y-3">
			<Choice text="Format" value={format} options={VIDEO_FORMATS} onChange={f => update( { format: f } )} />
			{! frames && <Choice text="Quality" tip="Higher keeps more detail and makes a larger file." value={settings.quality} options={qualities} onChange={quality => update( { quality } )} />}
			{format === 'png' && <Choice text="Colour depth" tip="How finely each colour is stored." value={settings.bitDepth} options={DEPTHS} onChange={v => update( { bitDepth: Number( v ) } )} />}
			{format === 'exr' && (
				<>
					<Look settings={settings} update={update} />
					<Choice text="Precision" tip="How exactly each value is stored." value={settings.precision} options={PRECISIONS} onChange={precision => update( { precision } )} />
					{! settings.asShown && <ColorSpace />}
					{! settings.asShown && <Layers value={settings.passes} onChange={passes => update( { passes } )} />}
				</>
			)}
			<Choice text="Frame rate" value={fps} options={FRAME_RATES} onChange={v => update( { fps: Number( v ) } )} />
			{info && summary( info.width, info.height, `${duration.toFixed( 1 )} s, ${count} frames` )}
			{frames && <p className="text-xs opacity-50">{canPickFolder() ? 'Each frame is saved into a folder you choose.' : 'The frames are saved together as one zip file.'}</p>}
		</div>
	);

}

/**
 * Export: the live render as a picture or a video, or a render from the Results library as a picture. The
 * choices are remembered on this device; the EXR colour space is the colour management's export space.
 */
const ExportDialog = () => {

	const request = useStore( s => s.exportRequest );
	const setExportRequest = useStore( s => s.setExportRequest );
	const result = useStore( s => s.selectedResult );
	const app = useActiveApp();
	const { toast } = useToast();
	const duration = useAnimationStore( videoDuration );
	const animates = useAnimationStore( s => s.clips.length > 0 || s.timelineAnimates );
	const rendering = useAnimationStore( s => s.isVideoRendering );
	const handleRenderAnimation = useAnimationStore( s => s.handleRenderAnimation );
	const [ storedPicture, setPicture ] = useLocalStorage( PICTURE_SETTINGS_KEY, DEFAULT_PICTURE );
	const video = useAnimationStore( s => s.videoExport );
	const updateVideo = useAnimationStore( s => s.setVideoExport );
	const [ tab, setTab ] = useState( request?.tab ?? 'picture' );
	const [ busy, setBusy ] = useState( false );
	const [ savedSource, setSavedSource ] = useState( 'edited' );
	const formats = useFormats( !! request );

	const picture = { ...DEFAULT_PICTURE, ...storedPicture };
	const fromResult = request?.from === 'result' && !! result;
	const info = request && ! fromResult ? app?.exportInfo?.() ?? null : null;

	useEffect( () => {

		if ( ! request ) return;
		setTab( request.tab ?? 'picture' );

	}, [ request ] );

	const close = () => setExportRequest( null );
	const updatePicture = patch => setPicture( prev => ( { ...DEFAULT_PICTURE, ...prev, ...patch } ) );

	const run = async () => {

		setBusy( true );
		try {

			if ( tab === 'video' && ! fromResult ) {

				// Asked here, while the click still counts: the browser lets only a click open the folder picker.
				const folder = isFrameSequence( video.format ) && canPickFolder() ? await pickFramesFolder() : null;
				close();
				handleRenderAnimation( { output: video, folder } );
				return;

			}

			if ( fromResult ) {

				const viewport = useStore.getState().resultsViewportRef?.current;
				const canvas = savedSource === 'original' ? viewport?.getCanvas() : savedSource === 'ai' ? viewport?.getAICanvas?.() : viewport?.getEditedCanvas();
				const format = holdsLight( picture.format ) && ! result.hasHDR ? 'png' : picture.format;
				const name = await exportSavedRender( { id: result.id, canvas, format, quality: picture.quality } );
				toast( { title: 'Saved', description: name } );

			} else {

				const file = await exportPicture( picture );
				const missing = picture.format === 'exr' && ! picture.asShown ? picture.passes.filter( p => ! file.passes.includes( p ) ) : [];
				toast( {
					title: 'Saved',
					description: missing.length ? `${file.name}, without ${missing.map( p => LAYERS.find( l => l.value === p )?.label.toLowerCase() ).join( ' and ' )} — that needs a denoiser on while rendering.` : file.name,
				} );

			}

			close();

		} catch ( error ) {

			if ( error?.name !== 'AbortError' ) toast( { title: 'Export failed', description: error.message, variant: 'destructive' } );

		} finally {

			setBusy( false );

		}

	};

	const action = tab === 'video' ? ( isFrameSequence( video.format ) ? 'Render frames' : 'Render video' ) : 'Export';

	return (
		<Dialog open={!! request} onOpenChange={open => ! open && close()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{fromResult ? 'Export saved render' : 'Export'}</DialogTitle>
					<DialogDescription>{fromResult ? 'Save this render from your library as a file.' : 'Save the render as a picture, or the animation as a video.'}</DialogDescription>
				</DialogHeader>

				{fromResult ? (
					<SavedPicture settings={picture} update={updatePicture} result={result} source={savedSource} setSource={setSavedSource} formats={formats} />
				) : (
					<Tabs value={tab} onValueChange={setTab}>
						<TabsList className="w-full">
							<TabsTrigger value="picture" className="flex-1">Picture</TabsTrigger>
							<TabsTrigger value="video" className="flex-1">Video</TabsTrigger>
						</TabsList>
						<TabsContent value="picture" className="pt-2">
							<LivePicture settings={picture} update={updatePicture} info={info} formats={formats} />
						</TabsContent>
						<TabsContent value="video" className="pt-2">
							<VideoOptions settings={video} update={updateVideo} info={info} duration={duration} animates={animates} />
						</TabsContent>
					</Tabs>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={close}>Cancel</Button>
					<Button onClick={run} disabled={busy || ( tab === 'video' && ! fromResult && ( ! animates || rendering ) )}>
						{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{fromResult ? 'Export' : action}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

};

export default ExportDialog;
