import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Download, X, Loader2, Target, ChevronDown } from 'lucide-react';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Exposure } from '@/assets/icons';
import { getApp } from '@/lib/appProxy';
import { cn } from '@/lib/utils';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePathTracerStore } from '@/store';
import {
	colorManagement, builtinConfigs, loadBuiltinConfig, loadConfigFromFiles, loadDefaultConfig, unloadConfig,
	useColorStatus, useViewTransforms, saveEXR, DEFAULT_COLOR_CONFIG,
} from '@/lib/colorManagement';
import {
	builtinConfigOptions, configLabel, viewLabels, looksForView, workingSpaceOptions, workingSpaceLabel,
	exportSpaceOptions, displaySections, toneMappingHint,
} from '@/lib/colorLabels';
import { displayCanvasFit } from 'rayzee';

const NONE = '__none__';
const LOAD = '__load__';
const DEFAULT_OPTION = {
	value: DEFAULT_COLOR_CONFIG.id, label: DEFAULT_COLOR_CONFIG.label, description: DEFAULT_COLOR_CONFIG.description,
	hint: 'AgX, Filmic and their styles (default)',
};

/** Exposure is shown in stops, as every OCIO client shows it; the engine stores the multiplier. */
const EV_MIN = - 6;
const EV_MAX = 6;
const toEV = multiplier => Math.min( EV_MAX, Math.max( EV_MIN, Math.log2( Math.max( multiplier, 1e-6 ) ) ) );

const label = text => <span className="opacity-50 text-xs truncate">{text}</span>;

const AutoExposureValue = memo( () => {

	const current = usePathTracerStore( state => state.currentAutoExposure );
	if ( current === undefined || current === null ) return <span className="text-xs opacity-50">Calculating...</span>;
	return <span className="text-xs opacity-70">{`${Math.log2( Math.max( current, 1e-6 ) ).toFixed( 2 )} EV`}</span>;

} );

AutoExposureValue.displayName = 'AutoExposureValue';

/**
 * Color Management, laid out the way OCIO applications lay it out.
 *
 * Blender, Maya, Nuke and Substance Painter all separate two kinds of setting:
 *   - **the project**: which config, and what the render happens in. Set once, and changing either
 *     rebuilds the scene.
 *   - **the view**: display, view, look and exposure. Changed constantly, and free.
 * And none of them has a "tone mapping" control beside a "view" control — the view *is* the tone
 * mapping. So there is one menu for it: three.js's curves when no config is loaded, the config's
 * views when one is. OCIO's words are jargon to an artist, so the controls are labelled Tone Mapping
 * (view), Style (look) and Screen (display), in the order they are reached for, each item with a hint.
 * The project settings are folded under Advanced: most scenes never change them.
 */
const ColorManagementSection = () => {

	const status = useColorStatus();
	const transforms = useViewTransforms();
	const {
		toneMapping, exposure, autoExposure, autoExposureKeyValue,
		handleToneMappingChange, handleExposureChange, handleAutoExposureChange, handleAutoExposureKeyValueChange,
	} = usePathTracerStore();

	const [ builtins, setBuiltins ] = useState( [] );
	const [ busy, setBusy ] = useState( null );
	const [ error, setError ] = useState( null );
	// Kept here, not read off the active transform: choosing a built-in curve clears the active OCIO
	// view, and a Display menu that emptied itself at that moment would be a trap.
	const [ display, setDisplay ] = useState( null );
	// Pipeline settings (colour system, render space, config variables) stay folded away unless opened.
	const [ advancedOpen, setAdvancedOpen ] = useLocalStorage( 'rayzee-color-advanced-open', false );
	const fileInput = useRef( null );

	const syncToneMapping = useCallback( id => usePathTracerStore.getState().setToneMapping( id ), [] );

	const run = useCallback( async ( text, fn ) => {

		setBusy( text );
		setError( null );
		try {

			await fn();

		} catch ( err ) {

			setError( err.message );

		} finally {

			setBusy( null );

		}

	}, [] );

	const config = status?.config ?? null;
	const activeDisplay = status?.activeView?.display ?? display ?? config?.defaultDisplay ?? null;
	const activeView = status?.activeView?.view ?? ( activeDisplay ? config?.defaultViews?.[ activeDisplay ] : null ) ?? null;

	// Starting the OCIO runtime is ~6 MB of WebAssembly, so the list is fetched when the menu is
	// first opened — never because the sidebar rendered.
	const onOpenConfigs = useCallback( open => {

		if ( ! open || builtins.length > 0 || busy ) return;
		run( 'Starting color runtime', async () => setBuiltins( await builtinConfigs() ) );

	}, [ builtins, busy, run ] );

	const selectDefaultView = useCallback( loaded => {

		setDisplay( loaded.defaultDisplay );
		const entry = colorManagement().setView( {
			display: loaded.defaultDisplay,
			view: loaded.defaultViews[ loaded.defaultDisplay ],
		} );
		syncToneMapping( entry.id );

	}, [ syncToneMapping ] );

	const onPickConfig = useCallback( value => {

		// A menu entry rather than an unlabelled icon beside it — the icon was easy to miss, and
		// the menu listing only ACES made the feature look limited to it.
		if ( value === LOAD ) {

			fileInput.current?.click();
			return;

		}

		if ( value === NONE ) {

			run( 'Unloading config', async () => {

				await unloadConfig();
				setDisplay( null );
				syncToneMapping( getApp()?.renderer?.toneMapping ?? 0 );

			} );
			return;

		}

		if ( value === DEFAULT_OPTION.value ) {

			run( 'Loading config', async () => {

				const { view } = await loadDefaultConfig();
				setDisplay( DEFAULT_COLOR_CONFIG.view.display );
				syncToneMapping( view.id );

			} );
			return;

		}

		run( 'Loading config', async () => {

			selectDefaultView( await loadBuiltinConfig( value, { registerViews: false } ) );

		} );

	}, [ run, syncToneMapping, selectDefaultView ] );

	// The menu's names come from the runtime's list; a config loaded any other way still needs it.
	useEffect( () => {

		if ( ! status?.config || builtins.length > 0 ) return;
		builtinConfigs().then( setBuiltins ).catch( () => {} );

	}, [ status?.config, builtins.length ] );

	const onPickFiles = useCallback( event => {

		const files = event.target.files;
		if ( ! files?.length ) return;

		run( 'Loading config', async () => {

			selectDefaultView( await loadConfigFromFiles( files, { registerViews: false } ) );

		} );

		event.target.value = '';

	}, [ run, selectDefaultView ] );

	const applyView = useCallback( ( next, text ) => {

		run( text, async () => {

			syncToneMapping( colorManagement().setView( next ).id );
			getApp()?.reset();

		} );

	}, [ run, syncToneMapping ] );

	const onDisplay = useCallback( picked => {

		setDisplay( picked );
		const view = config.defaultViews[ picked ] ?? config.views[ picked ]?.[ 0 ]?.name;
		if ( ! view ) return;
		const names = ( config.views[ picked ] ?? [] ).map( v => v.name );
		const { creative, technical } = looksForView( config.looks, view, names );
		const look = status.activeView?.look ?? null;
		const kept = look && [ ...creative, ...technical ].some( l => l.value === look ) ? look : null;
		applyView( { display: picked, view, look: kept }, 'Baking view' );

	}, [ applyView, config, status ] );

	const onView = useCallback( value => {

		// Without a config the menu lists three.js's curves, which are selected by id.
		if ( ! config ) {

			handleToneMappingChange( value );
			return;

		}

		// A look belongs to a view; keep it only if the new view offers it too.
		const names = ( config.views?.[ activeDisplay ] ?? [] ).map( v => v.name );
		const { creative: keepable, technical: alsoKeepable } = looksForView( config.looks, value, names );
		const look = status.activeView?.look ?? null;
		const kept = look && [ ...keepable, ...alsoKeepable ].some( l => l.value === look ) ? look : null;

		applyView( { display: activeDisplay, view: value, look: kept }, 'Baking view' );

	}, [ config, handleToneMappingChange, applyView, activeDisplay, status ] );

	const onLook = useCallback( look => {

		applyView( { display: activeDisplay, view: activeView, look: look === NONE ? null : look }, 'Baking look' );

	}, [ applyView, activeDisplay, activeView ] );

	const onWorkingSpace = useCallback( value => {

		run( 'Rebuilding scene', async () => {

			const cm = colorManagement();
			cm.setWorkingSpace( value === cm.nativeLinearSpace ? null : value );
			// Textures, tints, lights and the environment were converted on their way in; they
			// have to be rebuilt before they mean anything in the new space.
			await getApp()?.applyColorWorkingSpace();

		} );

	}, [ run ] );

	// Committed on blur or Enter: every change rebakes every registered view.
	const onContextVar = useCallback( ( name, raw ) => {

		const cm = colorManagement();
		const value = raw.trim();
		const next = { ...( cm.context ?? {} ) };
		if ( value ) next[ name ] = value;
		else delete next[ name ];
		if ( JSON.stringify( next ) === JSON.stringify( cm.context ?? {} ) ) return;

		run( 'Applying context', async () => {

			cm.setContext( next );
			getApp()?.reset();

		} );

	}, [ run ] );

	const onExportSpace = useCallback( value => {

		colorManagement().setExportSpace( value === NONE ? null : value );

	}, [] );

	const onSaveEXR = useCallback( () => {

		run( 'Saving EXR', async () => {

			await saveEXR( colorManagement()?.exportSpace ?? null );

		} );

	}, [ run ] );

	const onExposure = useCallback( value => {

		const ev = Array.isArray( value ) ? value[ 0 ] : value;
		handleExposureChange( Math.pow( 2, ev ) );

	}, [ handleExposureChange ] );

	const isBusy = busy !== null;
	const nativeSpace = config ? colorManagement()?.nativeLinearSpace ?? null : null;
	const { presets } = builtinConfigOptions( builtins );
	const configOptions = [ DEFAULT_OPTION, ...presets ];
	const knownConfig = config && configOptions.some( o => o.value === config.id );

	const displayViews = config && activeDisplay ? config.views?.[ activeDisplay ] ?? [] : [];
	const labels = viewLabels( displayViews );
	const views = config
		? displayViews.map( v => ( { value: v.name, label: labels.get( v.name ), hint: toneMappingHint( v.name ), description: v.description || v.name } ) )
		: transforms.filter( t => t.source === 'builtin' ).map( t => ( { value: String( t.id ), label: t.name, hint: toneMappingHint( t.name ), description: t.name } ) );
	const viewValue = config ? activeView ?? '' : String( toneMapping );

	const { creative, technical } = config && activeView
		? looksForView( config.looks, activeView, displayViews.map( v => v.name ) )
		: { creative: [], technical: [] };

	const { sdr: sdrDisplays, hdr: hdrDisplays } = config
		? displaySections( config, displayCanvasFit, { p3: matchMedia?.( '(color-gamut: p3)' )?.matches ?? false } )
		: { sdr: [], hdr: [] };
	const displayColumns = [ { title: 'SDR', list: sdrDisplays }, { title: 'HDR', list: hdrDisplays } ].filter( c => c.list.length > 0 );

	const workingSpaces = workingSpaceOptions( config, nativeSpace );
	const exportSpaces = exportSpaceOptions( config );

	const trigger = ( title, placeholder ) => (
		<SelectTrigger className="max-w-32 h-5 rounded-full pl-2" title={title}>
			<SelectValue placeholder={placeholder} />
		</SelectTrigger>
	);
	const item = o => <SelectItem key={o.value} value={o.value} title={o.description} hint={o.hint}>{o.label}</SelectItem>;
	const find = ( list, value ) => list.find( o => o.value === value );

	const systemSummary = [
		config ? ( find( configOptions, config.id )?.label ?? configLabel( config, presets ) ) : 'None',
		config ? workingSpaceLabel( status.workingSpaceAdopted ? status.workingSpace : nativeSpace ?? '' ) : null,
	].filter( Boolean ).join( ' · ' );

	return (
		<>
			{/* `webkitdirectory` is not a React prop. It makes this a folder picker, which a real
			    config needs — the .ocio file alone almost never resolves its own LUTs. */}
			<input
				ref={node => {

					fileInput.current = node;
					if ( node ) node.setAttribute( 'webkitdirectory', '' );

				}}
				type="file"
				className="hidden"
				multiple
				onChange={onPickFiles}
			/>

			{error && (
				<div className="px-1 text-[10px] leading-4 text-red-400 flex items-start gap-1">
					<X size={10} className="mt-0.5 shrink-0" /> {error}
				</div>
			)}

			<Row>
				<span className="opacity-50 text-xs shrink-0 flex items-center gap-1">
					Tone Mapping
					<InfoTip text="How the light in the scene becomes a picture: how bright highlights roll off and how deep shadows hold. It changes how the render looks, never the render itself. (OCIO: view)" />
				</span>
				<div className="flex flex-1 items-center justify-end gap-1 min-w-0">
					{isBusy && <Loader2 size={12} className="animate-spin opacity-60 shrink-0" />}
					<Select value={viewValue} onValueChange={onView} disabled={isBusy}>
						{trigger( find( views, viewValue )?.description, 'Select tone mapping' )}
						<SelectContent>{views.map( item )}</SelectContent>
					</Select>
				</div>
			</Row>

			{config && ( creative.length > 0 || technical.length > 0 ) && (
				<Row>
					<span className="opacity-50 text-xs truncate flex items-center gap-1">
						Style
						<InfoTip text="A finishing grade on top of the tone mapping, such as more contrast or black and white. The styles offered depend on the tone mapping. (OCIO: look)" />
					</span>
					<Select value={status.activeView?.look ?? NONE} onValueChange={onLook} disabled={isBusy}>
						{trigger( find( [ ...creative, ...technical ], status.activeView?.look )?.description ?? 'Default' )}
						<SelectContent>
							<SelectItem value={NONE} title="The tone mapping as it is, with no extra grade" hint="the tone mapping as it is">Default</SelectItem>
							{creative.map( item )}
							{technical.length > 0 && (
								<SelectGroup>
									<SelectLabel className="text-[10px] opacity-50">Technical — for camera footage</SelectLabel>
									{technical.map( item )}
								</SelectGroup>
							)}
						</SelectContent>
					</Select>
				</Row>
			)}

			{config && (
				<Row>
					<span className="opacity-50 text-xs truncate flex items-center gap-1">
						Screen
						<InfoTip text="What the picture will be seen on. sRGB suits almost every computer screen. HDR screens are for HDR TVs and deliverables; on a regular screen they are shown converted. (OCIO: display)" />
					</span>
					<Select value={activeDisplay ?? ''} onValueChange={onDisplay} disabled={isBusy}>
						{trigger( activeDisplay, 'Select screen' )}
						<SelectContent className={hdrDisplays.length > 0 ? 'min-w-[20rem]' : undefined}>
							<div className={hdrDisplays.length > 0 ? 'grid grid-cols-2 gap-x-1' : undefined}>
								{displayColumns.map( ( { title, list } ) => (
									<SelectGroup key={title}>
										<SelectLabel className="text-[10px] opacity-50 border-b border-border/50 mb-1">{title}</SelectLabel>
										{list.map( item )}
									</SelectGroup>
								) )}
							</div>
						</SelectContent>
					</Select>
				</Row>
			)}

			<Row more={autoExposure ? (
				<Row>
					<Slider icon={Target} label={'Target Brightness'} min={0.05} max={0.5} step={0.01} value={[ autoExposureKeyValue ]} snapPoints={[ 0.18 ]} onValueChange={handleAutoExposureKeyValueChange} />
				</Row>
			) : null}>
				{label( 'Auto Exposure' )}
				<div className="flex items-center gap-2">
					{autoExposure && <AutoExposureValue />}
					<Switch checked={autoExposure} onCheckedChange={handleAutoExposureChange} />
				</div>
			</Row>

			{! autoExposure && (
				<Row>
					<Slider icon={Exposure} label={'Exposure (EV)'} min={EV_MIN} max={EV_MAX} step={0.05} value={[ toEV( exposure ) ]} snapPoints={[ 0 ]} onValueChange={onExposure} />
				</Row>
			)}

			<Separator className="my-1 opacity-30" />

			<Row>
				<span className="opacity-50 text-xs truncate flex items-center gap-1">
					Save EXR
					<InfoTip text="Saves the render as an OpenEXR file for compositing or grading: the light itself, denoised, without bloom or exposure. Choose the colour space the next person in the pipeline expects." />
				</span>
				<div className="flex items-center gap-1">
					{config ? (
						<Select value={status.exportSpace ?? NONE} onValueChange={onExportSpace} disabled={isBusy}>
							{trigger( status.exportSpace ?? `${status.workingSpace} — the space the render is in` )}
							<SelectContent>
								<SelectItem value={NONE} title={status.workingSpace} hint="as rendered, no conversion">{workingSpaceLabel( status.workingSpace )}</SelectItem>
								{exportSpaces.filter( o => o.value !== status.workingSpace ).map( item )}
							</SelectContent>
						</Select>
					) : (
						<span className="text-xs opacity-50">Rec.709</span>
					)}
					<button
						type="button"
						title="Save the render as EXR"
						className="h-5 w-5 flex items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40"
						disabled={isBusy}
						onClick={onSaveEXR}
					>
						<Download size={12} />
					</button>
				</div>
			</Row>

			<Separator className="my-1 opacity-30" />

			<button
				type="button"
				aria-expanded={advancedOpen}
				onClick={() => setAdvancedOpen( ! advancedOpen )}
				className="flex w-full items-center justify-between gap-2 text-xs opacity-50 hover:opacity-80 transition-opacity"
				title="Colour system, render space and config variables — pipeline settings most scenes never change"
			>
				<span>Advanced</span>
				<span className="flex items-center gap-1 min-w-0">
					<span className="truncate text-[10px]">{systemSummary}</span>
					<ChevronDown size={12} className={cn( 'shrink-0 transition-transform duration-200', advancedOpen && 'rotate-180' )} />
				</span>
			</button>

			{advancedOpen && (
				<>
					<Row>
						<span className="opacity-50 text-xs shrink-0 flex items-center gap-1">
							Color System
							<InfoTip text="Which colour system supplies the tone mappings, styles and screens. Blender is the default and covers almost everything; ACES is the film and VFX standard; None uses the engine's own curves. A studio's own OpenColorIO config can be loaded as a folder. Changing it reloads the colour settings and can rebuild the scene." />
						</span>
						<Select value={config?.id ?? NONE} onValueChange={onPickConfig} onOpenChange={onOpenConfigs} disabled={isBusy}>
							{trigger( config ? ( find( configOptions, config.id )?.description ?? config.id ) : 'No colour management' )}
							<SelectContent>
								{item( DEFAULT_OPTION )}
								<SelectItem value={NONE} title="The engine's own curves, in linear Rec.709" hint="the engine's own curves">None</SelectItem>
								{presets.map( item )}
								{config && ! knownConfig && (
									<SelectItem value={config.id} title={config.id}>{configLabel( config, presets )}</SelectItem>
								)}
								<SelectSeparator />
								<SelectItem value={LOAD} title="An OpenColorIO config folder: the .ocio file and the LUTs beside it" hint="a studio's own OpenColorIO folder">Load config folder…</SelectItem>
							</SelectContent>
						</Select>
					</Row>

					{config && workingSpaces.length > 0 && (
						<Row>
							<span className="opacity-50 text-xs shrink-0 flex items-center gap-1">
								Render In
								<InfoTip text="The colour space the render is calculated in. Leave it on Rec.709 unless the project calls for another — ACEScg is the usual choice in an ACES pipeline. Changing it rebuilds the scene and changes how every existing render looks." />
							</span>
							<Select value={status.workingSpaceAdopted ? status.workingSpace : nativeSpace ?? ''} onValueChange={onWorkingSpace} disabled={isBusy}>
								{trigger( find( workingSpaces, status.workingSpace )?.description )}
								<SelectContent>{workingSpaces.map( item )}</SelectContent>
							</Select>
						</Row>
					)}

					{( config?.contextVariables ?? [] ).map( v => (
						<Row key={v.name}>
							<span className="opacity-50 text-xs truncate flex items-center gap-1">
								{`$${v.name}`}
								<InfoTip text={`A variable the config uses to pick a per-shot grade or LUT. Leave empty for the config's own default${ v.default ? ` (${v.default})` : '' }.`} />
							</span>
							<Input
								key={`${config.id}:${v.name}`}
								className="max-w-32 h-5 rounded-full text-xs px-2"
								defaultValue={status.context?.[ v.name ] ?? ''}
								placeholder={v.default ?? ''}
								disabled={isBusy}
								onBlur={e => onContextVar( v.name, e.target.value )}
								onKeyDown={e => {

									if ( e.key === 'Enter' ) e.currentTarget.blur();

								}}
							/>
						</Row>
					) )}
				</>
			)}
		</>
	);

};

export default ColorManagementSection;
