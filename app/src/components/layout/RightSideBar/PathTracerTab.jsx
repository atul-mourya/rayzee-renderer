import { Sun, RefreshCcwDot, Image, Palette, ArrowUp, CloudSun } from 'lucide-react';
// import { Zap, ArrowDown, Minus, Droplets } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ColorInput } from "@/components/ui/colorinput";
import { usePathTracerStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import NeuralPostControls from './NeuralPostControls';
import ColorManagementSection from './ColorManagementSection';
import { Row } from '@/components/ui/row';
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Separator } from '@/components/ui/separator';
import { useEffect, useState } from 'react';
import CanvasDimensionControls from './CanvasDimensionControls';
import { MAX_TEXTURE_SIZE_PRESETS } from '@/Constants';
import PhysicalSkyControls from './PhysicalSkyControls';
import { getApp } from '@/lib/appProxy';
import { memorySpillPreference, setMemorySpillPreference } from '@/lib/storage';


// Per-debug-mode control renderers. Add a new case to expose mode-specific
// parameters (e.g. thresholds, scales) when introducing a new debug mode.
const renderDebugModeControls = ( debugMode, props ) => {

	switch ( debugMode ) {

		case '7': // Triangle Tests
		case '8': // Box Tests
			return (
				<Row>
					<Slider label={"Display Threshold"} tip="How many tests show as full white. Pixels with more turn red." min={1} max={500} step={1} value={[ props.debugThreshold ]} onValueChange={props.handleDebugThresholdChange} />
				</Row>
			);
		default:
			return null;

	}

};

// The overlay bars on the per-pixel FREEZE test whenever freeze is on, and on the frame RETIRE test
// otherwise (Compositor's overlayColor). Only the second is what "converged" means, so calling the
// grey swatch that while the colours are answering the freeze question is simply wrong.
const overlayLegend = ( freezeOn ) => [
	[ 'bg-red-500', 'noisy' ],
	[ 'bg-yellow-400', 'near threshold' ],
	[ 'bg-neutral-400', freezeOn ? 'below freeze bar' : 'converged' ],
	// The overlay's frozen branch is gated on freezeOn, so this colour cannot appear otherwise.
	...( freezeOn ? [[ 'bg-blue-500', 'frozen' ]] : [] ),
];

// Counters come from a settled-view readback, so they lag a little and read zero while orbiting.
// Each figure is only shown while the feature that maintains it is on, else it reports a stale count.
const ConvergenceReadout = ( { showConverged, showTracing } ) => {

	const [ stats, setStats ] = useState( null );
	const [ bars, setBars ] = useState( null );

	useEffect( () => {

		const id = setInterval( () => {

			const app = getApp();
			setStats( app?.getConvergenceStats?.() ?? null );

			// Read live rather than from the store: pixelFreezeThreshold is engine-internal and
			// configureForMode gives each tier its own value, so a hardcoded number would lie.
			setBars( app?.settings ? {
				freezeOn: !! app.settings.get( 'usePixelFreeze' ),
				freeze: app.settings.get( 'pixelFreezeThreshold' ),
				frame: app.settings.get( 'noiseThreshold' ),
			} : null );

		}, 250 );
		return () => clearInterval( id );

	}, [] );

	if ( ! stats?.totalPixels ) return null;

	// "early-stop", not "converged": this counts the √luminance-normalized frame predicate, which is far
	// more permissive on dim pixels than the plain relative error the overlay paints. Labelling it
	// "converged" next to the colours read as a contradiction (95% converged, 30% of the frame hot).
	// Floor/ceil so neither figure overstates progress — rounding printed "100%" at 99.6%.
	const parts = [ `sample ${stats.frame}` ];
	// Both must clear the bar to retire the frame, so show both — frame first, then subject-only, which is
	// the one that keeps a mostly-background shot from stopping early. Subject is omitted when there is no
	// geometry in view (pure environment), where the frame fraction decides alone.
	if ( showConverged ) parts.push( `frame ${Math.floor( stats.converged * 100 )}%` );
	if ( showConverged && stats.geometryPixels > 0 ) parts.push( `subject ${Math.floor( stats.convergedGeometry * 100 )}%` );
	if ( showTracing && stats.activePixels ) parts.push( `tracing ${Math.ceil( 100 * stats.activePixels / stats.totalPixels )}%` );

	// Without this the two most prominent convergence signals answer different questions in silence:
	// a near-solid red frame reading "frame 90%" is not a contradiction, it is two different bars.
	const barNote = bars && ( bars.freezeOn
		? `colours: freeze bar (rel err < ${bars.freeze}) · percentages: retire bar `
			+ `(√-normalised < ${bars.frame}), looser on dim pixels`
		: `colours and percentages: retire bar (√-normalised < ${bars.frame})` );

	return (
		<>
			{barNote && <div className="px-1 text-[10px] leading-4 opacity-40">{barNote}</div>}
			<div className="px-1 text-[10px] leading-4 opacity-50">{parts.join( ' · ' )}</div>
		</>
	);

};

const PathTracerTab = () => {

	const pathTracerStore = usePathTracerStore();


	// Destructure all state and handlers from the store
	const {
		// State
		enablePathTracer,
		enableAccumulation,
		bounces,
		transmissiveBounces,
		maxSubsurfaceSteps,
		maxTransparentBounces,
		maxTextureSize,
		fireflyThreshold,
		shadowTerminatorOffset,
		integrator,
		debugMode,
		debugThreshold,
		showInspector,
		oidnQuality,
		enableOIDN,
		enableEnvironment,
		showBackground,
		transparentBackground,
		backgroundIntensity,
		backgroundColor,
		backgroundBlurriness,
		backgroundBlurSamples,
		environmentIntensity,
		environmentRotation,
		groundProjectionEnabled,
		groundProjectionRadius,
		groundProjectionHeight,
		enableGroundCatcher,
		groundCatcherHeight,
		// Environment Mode
		environmentMode,
		solidSkyColor,
		enableAlphaShadows,
		useAdaptiveSampling,
		noiseThreshold,
		adaptiveMinSamples,
		convergenceOverlay,
		interactionModeEnabled,
		asvgfQualityPreset,
		asvgfDebugMode,
		showAsvgfHeatmap,
		nrdQualityPreset,
		nrdDebugMode,
		nrdMaxAccumulatedFrameNum,
		nrdMaxBlurRadius,
		nrdPrepassBlurRadius,
		nrdAntiFirefly,
		denoiserStrategy,
		filterStrength,
		edgeAtrousIterations,
		edgePhiLuminance,
		edgePhiNormal,
		edgePhiDepth,
		// Auto-exposure state

		// Handlers - now from store
		handlePathTracerChange,
		handleAccumulationChange,
		handleBouncesChange,
		handleTransmissiveBouncesChange,
		handleMaxSubsurfaceStepsChange,
		handleMaxTransparentBouncesChange,
		handleMaxTextureSizeChange,
		handleFireflyThresholdChange,
		handleShadowTerminatorOffsetChange,
		handleIntegratorChange,
		handleEnableAlphaShadowsChange,
		handleUseAdaptiveSamplingChange,
		handleNoiseThresholdChange,
		handleAdaptiveMinSamplesChange,
		handleConvergenceOverlayChange,
		handleOidnQualityChange,
		handleEnableOIDNChange,
		handleDebugThresholdChange,
		handleDebugModeChange,
		handleInspectorToggle,
		handleEnableEnvironmentChange,
		handleBackgroundTypeChange,
		handleBackgroundIntensityChange,
		handleBackgroundColorChange,
		handleBackgroundBlurrinessChange,
		handleBackgroundBlurSamplesChange,
		handleEnvironmentIntensityChange,
		handleEnvironmentRotationChange,
		handleGroundProjectionEnabledChange,
		handleGroundProjectionRadiusChange,
		handleGroundProjectionHeightChange,
		handleEnableGroundCatcherChange,
		handleGroundCatcherHeightChange,
		// Environment Mode Handlers
		handleEnvironmentModeChange,
		handleSolidSkyColorChange,
		handleInteractionModeEnabledChange,
		handleAsvgfQualityPresetChange,
		handleAsvgfDebugModeChange,
		handleShowAsvgfHeatmapChange,
		handleNrdQualityPresetChange,
		handleNrdDebugModeChange,
		handleNrdMaxAccumulatedFrameNumChange,
		handleNrdMaxBlurRadiusChange,
		handleNrdPrepassBlurRadiusChange,
		handleNrdAntiFireflyChange,
		handleDenoiserStrategyChange,
		handleFilterStrengthChange,
		handleEdgeAtrousIterationsChange,
		handleEdgePhiLuminanceChange,
		handleEdgePhiNormalChange,
		handleEdgePhiDepthChange,
		// Auto-exposure handlers
	} = pathTracerStore;

	// Backdrop mode derived from the two engine flags (single mutually-exclusive choice).
	const backgroundType = transparentBackground ? 'transparent' : showBackground ? 'environment' : 'color';

	const [ memorySpill, setMemorySpill ] = useState( memorySpillPreference );
	const handleMemorySpillChange = value => {

		const mode = value === 'auto' ? 'auto' : value === 'true';
		setMemorySpill( mode );
		setMemorySpillPreference( mode );

	};

	return (
		<div className="">
			<Separator className="bg-primary" />

			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<Row>
					<Switch label={"Enable"} tip="Turns realistic rendering on. Off shows a quick, plainly lit preview instead." checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
				</Row>
				<Row>
					<Switch label={"Fast Navigation"} tip="Lowers the detail while the camera moves, so it moves smoothly. Full detail returns when it stops." checked={interactionModeEnabled} onCheckedChange={handleInteractionModeEnabledChange} />
				</Row>
				<Row more={(
					<>
						<Row>
							<Slider label={"Transmissive Bounces"} tip="How many times light may pass through glass, water and other clear materials. Raise it when stacked glass looks dark." min={0} max={64} step={1} value={[ transmissiveBounces ]} onFinishChange={handleTransmissiveBouncesChange} />
						</Row>
						<Row>
							<Slider label={"Transparent Bounces"} tip="How many see-through layers, such as cut-out leaves, light may pass before it stops. Raise it when dense foliage looks dark." min={0} max={32} step={1} value={[ maxTransparentBounces ]} onValueChange={handleMaxTransparentBouncesChange} />
						</Row>
						<Row>
							<Slider label={"Subsurface Steps"} tip="How far light may wander inside skin, wax and other soft materials. More is more accurate and slower." min={1} max={256} step={1} value={[ maxSubsurfaceSteps ]} onFinishChange={handleMaxSubsurfaceStepsChange} />
						</Row>
					</>
				)}>
					<Slider label={"Bounces"} tip="How many times light may bounce between surfaces. More fills corners and rooms with light, but renders slower." min={0} max={20} step={1} value={[ bounces ]} onFinishChange={handleBouncesChange} />
				</Row>
				<Row>
					<Select value={integrator} onValueChange={handleIntegratorChange}>
						<span className="opacity-50 text-xs truncate" title="Path Tracing suits most scenes. Bidirectional is twice as slow, but better for lamp-lit rooms and the bright patterns light makes through glass. Photons also catches those patterns in mirrors and water. Experimental.">Light Transport</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="path">Path Tracing</SelectItem>
							<SelectItem value="bidirectional">Bidirectional</SelectItem>
							<SelectItem value="vcm">Bidirectional + Photons</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				<CanvasDimensionControls />
			</ControlGroup>

			<ControlGroup name="Color Management">
				<ColorManagementSection />
			</ControlGroup>

			<ControlGroup name="Environment">
				{/* <Row>
					<Slider icon={Exposure} label={"Saturation"} min={0} max={2} step={0.01} value={[ saturation ]} snapPoints={[ 1 ]} onValueChange={handleSaturationChange} />
				</Row> */}
				{/* <Row>
					<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} snapPoints={[ 1 ]} onValueChange={handleGIIntensityChange} />
				</Row> */}

				{/* Environment Mode Selector */}
				<Row>
					<Select value={environmentMode} onValueChange={handleEnvironmentModeChange}>
						<span className="opacity-50 text-xs truncate" title="What lights the scene from around it: a photo of a real place (HDRI), a sky with a sun, or one flat colour.">Mode</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hdri">
								<div className="flex items-center gap-1.5">
									<Image size={12} />
									<span>HDRI</span>
								</div>
							</SelectItem>
							<SelectItem value="procedural">
								<div className="flex items-center gap-1.5">
									<CloudSun size={12} />
									<span>Physical Sky</span>
								</div>
							</SelectItem>
							<SelectItem value="color">
								<div className="flex items-center gap-1.5">
									<Palette size={12} />
									<span>Solid Color</span>
								</div>
							</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{/* Solid Color Mode Controls */}
				{environmentMode === 'color' && (
					<Row>
						<ColorInput label="Sky Color" tip="The colour of the light that surrounds the scene." value={solidSkyColor} onChange={handleSolidSkyColorChange} />
					</Row>
				)}

				{environmentMode === 'procedural' && <PhysicalSkyControls />}

				<Separator className="my-1 opacity-30" />

				{/* Common Environment Controls */}
				<Row>
					<SliderToggle label={"Intensity"} tip="How strongly the surroundings light the scene. Off leaves only the scene's own lights." enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
				</Row>
				{/* Background backdrop — a single mutually-exclusive mode (env image / solid color /
				    transparent). Independent of Intensity above, which controls lighting only. */}
				<Row>
					<span className="opacity-50 text-xs truncate" title="What shows behind the model: the surroundings, a flat colour, or nothing (see-through). It does not change the lighting.">Background</span>
					<Select value={backgroundType} onValueChange={handleBackgroundTypeChange}>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="environment">Environment</SelectItem>
							<SelectItem value="color">Color</SelectItem>
							<SelectItem value="transparent">Transparent</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				{backgroundType === 'environment' && (
					<>
						<Row>
							<Slider label={"Background Intensity"} tip="How bright the background looks, without changing how it lights the scene." icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ backgroundIntensity ]} onValueChange={handleBackgroundIntensityChange} />
						</Row>
						<Row>
							<Slider label={"Background Blur"} tip="Softens the background behind the model. The lighting stays sharp." min={0} max={1} step={0.01} value={[ backgroundBlurriness ]} onValueChange={handleBackgroundBlurrinessChange} />
						</Row>
						{backgroundBlurriness > 0 && (
							<Row>
								<Slider label={"Blur Samples"} tip="How smooth the blurred background is. More is smoother and slower." min={1} max={32} step={1} value={[ backgroundBlurSamples ]} onValueChange={handleBackgroundBlurSamplesChange} />
							</Row>
						)}
					</>
				)}
				{backgroundType === 'color' && (
					<Row>
						<ColorInput label="Background Color" tip="The flat colour shown behind the model." value={backgroundColor} onChange={handleBackgroundColorChange} />
					</Row>
				)}

				{/* Analytic ground-plane shadow catcher (no geometry; primary-ray holdout into alpha) */}
				<Row>
					<Switch label={"Shadow Catcher"} tip="An invisible floor that shows only the shadows the model casts on it, for placing the model into a photo." checked={enableGroundCatcher} onCheckedChange={handleEnableGroundCatcherChange} />
				</Row>
				{enableGroundCatcher && (
					<Row className="w-full">
						<div className="opacity-50 text-xs truncate" title="How high the invisible shadow floor sits.">Catcher Height</div>
						<NumberInput min={- 1000} max={1000} step={0.1} value={groundCatcherHeight} onValueChange={handleGroundCatcherHeightChange} />
					</Row>
				)}

				{/* HDRI Mode Controls */}
				{environmentMode === 'hdri' && (
					<>
						<Row>
							<Slider label={"Rotation"} tip="Turns the surroundings around the scene, which moves where the light comes from." icon={RefreshCcwDot} min={0} max={360} step={1} value={[ environmentRotation ]} snapPoints={[ 90, 180, 270 ]} onValueChange={handleEnvironmentRotationChange} />
						</Row>
						<Row>
							<SliderToggle label={"Ground Projection"} tip="Turns the bottom of the photo into a floor, so the model stands on it instead of floating. The number sets its size." enabled={groundProjectionEnabled} icon={RefreshCcwDot} min={10} max={500} step={1} value={[ groundProjectionRadius ]} onValueChange={handleGroundProjectionRadiusChange} onToggleChange={handleGroundProjectionEnabledChange} />
						</Row>
						{groundProjectionEnabled && (
							<Row>
								<Slider label={"Projection Height"} tip="How high above the floor the photo was taken. Change it until the floor looks the right size." icon={ArrowUp} min={0} max={50} step={0.1} value={[ groundProjectionHeight ]} onValueChange={handleGroundProjectionHeightChange} />
							</Row>
						)}
					</>
				)}
			</ControlGroup>

			<ControlGroup name="Denoising">
				<Row>
					<Select value={denoiserStrategy} onValueChange={handleDenoiserStrategyChange}>
						<span className="opacity-50 text-xs truncate" title="Removes grain while you work. OIDN (AI) is the cleanest; the others are faster and steadier while the camera moves.">Real-Time Denoiser</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select strategy" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							<SelectItem value="edgeaware">EdgeAware</SelectItem>
							<SelectItem value="asvgf">ASVGF</SelectItem>
							<SelectItem value="nrd">NRD (ReBLUR)</SelectItem>
							<SelectItem value="oidn">OIDN (AI)</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{denoiserStrategy === 'nrd' && ( <>
					<Row>
						<Select value={nrdQualityPreset} onValueChange={handleNrdQualityPresetChange}>
							<span className="opacity-50 text-xs truncate" title="A ready-made balance between speed and how clean the picture gets.">Quality Preset</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="low">Low</SelectItem>
								<SelectItem value="medium">Medium</SelectItem>
								<SelectItem value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row>
						<Slider label={"Max History"} tip="How many past frames are blended in. More is smoother when still, but smears more when things move." min={1} max={63} step={1} value={[ nrdMaxAccumulatedFrameNum ]} onValueChange={handleNrdMaxAccumulatedFrameNumChange} />
					</Row>
					<Row>
						<Slider label={"Blur Radius"} tip="How wide an area is smoothed together. Larger removes more grain but blurs detail." min={0} max={60} step={1} value={[ nrdMaxBlurRadius ]} onValueChange={handleNrdMaxBlurRadiusChange} />
					</Row>
					<Row>
						<Slider label={"Pre-pass Radius"} tip="A first, light blur before the main clean-up. Helps very grainy pictures." min={0} max={60} step={1} value={[ nrdPrepassBlurRadius ]} onValueChange={handleNrdPrepassBlurRadiusChange} />
					</Row>
					<Row>
						<Switch label={"Anti-Firefly"} tip="Removes stray bright dots before they spread into blotches." checked={nrdAntiFirefly} onCheckedChange={handleNrdAntiFireflyChange}/>
					</Row>
					<Row>
						<Select value={nrdDebugMode.toString()} onValueChange={handleNrdDebugModeChange}>
							<span className="opacity-50 text-xs truncate" title="Shows what the denoiser sees instead of the picture, for finding problems. Beauty is the normal picture.">Debug View</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select view" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">Beauty</SelectItem>
								<SelectItem value="1">History Length</SelectItem>
								<SelectItem value="2">Hit Distance</SelectItem>
								<SelectItem value="3">Roughness</SelectItem>
								<SelectItem value="4">Fast History</SelectItem>
								<SelectItem value="5">Disocclusion</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</> )}

				{denoiserStrategy === 'edgeaware' && ( <>
					<Row>
						<Slider label={"Filter Strength"} tip="How much of the clean-up reaches the picture. 0 leaves it untouched." min={0} max={1} step={0.01} value={[ filterStrength ]} onValueChange={handleFilterStrengthChange} />
					</Row>
					<Row>
						<Slider label={"Iterations"} tip="How many passes the clean-up makes. Each pass reaches further and smooths more." min={1} max={6} step={1} value={[ edgeAtrousIterations ]} onValueChange={handleEdgeAtrousIterationsChange} />
					</Row>
					<Row>
						<Slider label={"Luminance φ"} tip="How much brightness differences are smoothed over. Higher is smoother but loses light detail." min={0} max={16} step={0.1} value={[ edgePhiLuminance ]} onValueChange={handleEdgePhiLuminanceChange} />
					</Row>
					<Row>
						<Slider label={"Normal φ"} tip="How sharply edges between surfaces are kept. Higher keeps creases sharper." min={1} max={256} step={1} value={[ edgePhiNormal ]} onValueChange={handleEdgePhiNormalChange} />
					</Row>
					<Row>
						<Slider label={"Depth φ"} tip="How much distance differences are smoothed over. Lower keeps outlines sharper." min={0.01} max={1} step={0.01} value={[ edgePhiDepth ]} onValueChange={handleEdgePhiDepthChange} />
					</Row>
				</> )}

				{denoiserStrategy === 'asvgf' && ( <>
					<Row>
						<Select value={asvgfQualityPreset} onValueChange={handleAsvgfQualityPresetChange}>
							<span className="opacity-50 text-xs truncate" title="A ready-made balance between speed and how clean the picture gets.">Quality Preset</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select preset" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="low">Low</SelectItem>
								<SelectItem value="medium">Medium</SelectItem>
								<SelectItem value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row>
						<Switch label={"Show Heatmap"} tip="Paints what the denoiser is working with over the picture, for finding problems." checked={showAsvgfHeatmap} onCheckedChange={handleShowAsvgfHeatmapChange}/>
					</Row>
					{showAsvgfHeatmap && (
						<Row>
							<Select value={asvgfDebugMode.toString()} onValueChange={handleAsvgfDebugModeChange}>
								<span className="opacity-50 text-xs truncate" title="Shows what the denoiser sees instead of the picture, for finding problems. Beauty is the normal picture.">Debug View</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full" >
									<SelectValue placeholder="Select view" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="0">Beauty</SelectItem>
									<SelectItem value="1">Variance</SelectItem>
									<SelectItem value="2">History Length</SelectItem>
									<SelectItem value="3">Motion Vectors</SelectItem>
									<SelectItem value="4">Normals</SelectItem>
									<SelectItem value="5">Temporal Gradient</SelectItem>
								</SelectContent>
							</Select>
						</Row>
					)}
				</> )}

				{/* Separator before AI Denoising section */}
				<Separator />

				{/* Independent OIDN Control - Placed after real-time denoiser controls */}
				<Row>
					<Switch label={"Final Denoise (OIDN)"} tip="Removes the grain from the finished render with AI, once it is done." checked={enableOIDN} onCheckedChange={handleEnableOIDNChange} />
				</Row>

				{/* Quality applies to both jobs: the final pass, and which cheap model the live
				    refreshes use — so it shows whenever OIDN is in use either way. */}
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
				</> )}

				<Separator />

				<NeuralPostControls />
			</ControlGroup>

			<ControlGroup name="Advanced">
				<Row>
					<Select value={maxTextureSize?.toString()} onValueChange={handleMaxTextureSizeChange}>
						<span className="opacity-50 text-xs truncate" title="The largest size a material image is kept at. Smaller saves memory and loads faster, but looks less sharp up close.">Max Texture Size</span>
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue placeholder="Select size" />
						</SelectTrigger>
						<SelectContent>
							{MAX_TEXTURE_SIZE_PRESETS.map( ( { value, label } ) => (
								<SelectItem key={value} value={value.toString()}>{label}</SelectItem>
							) )}
						</SelectContent>
					</Select>
				</Row>
				<Row>
					<Select value={String( memorySpill )} onValueChange={handleMemorySpillChange}>
						<span className="opacity-50 text-xs truncate" title="Stores scenes too big for memory on your disk. Auto does this only when needed. Takes effect on the next load.">Memory Saver</span>
						<SelectTrigger className="max-w-24 h-5 rounded-full" >
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">Auto</SelectItem>
							<SelectItem value="true">Always</SelectItem>
							<SelectItem value="false">Never</SelectItem>
						</SelectContent>
					</Select>
				</Row>
				{enablePathTracer && (
					<Row>
						<Switch label={"Accumulation"} tip="Builds the picture up over time, so it gets cleaner the longer the camera is still. Off shows a fresh, grainy picture every frame." checked={enableAccumulation} onCheckedChange={handleAccumulationChange} />
					</Row>
				)}
				<Row>
					<Slider label={"Firefly Threshold"} tip="Hides stray bright dots in the picture. Lower hides more, but can also dim real highlights." min={0} max={10} step={0.1} value={[ fireflyThreshold ]} onValueChange={handleFireflyThresholdChange} />
				</Row>
				<Row>
					<Slider
						label={"Shadow Terminator"}
						tip="Smooths the jagged line between light and shadow on rounded objects made of flat pieces. 0 turns it off; 0.1 suits most scenes."
						min={0} max={1} step={0.01} value={[ shadowTerminatorOffset ]} snapPoints={[ 0.1 ]}
						onValueChange={handleShadowTerminatorOffsetChange}
					/>
				</Row>
				<Row>
					<Switch label={"Alpha Shadows"} tip="Lets cut-out parts, such as leaves or lace, cast shadows of their real shape instead of solid ones. Slower." checked={enableAlphaShadows} onCheckedChange={handleEnableAlphaShadowsChange} />
				</Row>
				<Row more={useAdaptiveSampling ? (
					<>
						<Row>
							<Slider label={"Noise Threshold"} tip="How clean each part of the picture must get before work on it stops. Lower is cleaner and slower." min={0.005} max={0.2} step={0.005} precision={3} value={[ noiseThreshold ]} onValueChange={handleNoiseThresholdChange} />
						</Row>
						<Row>
							<Slider label={"Min Samples"} tip="Each part of the picture is worked on at least this many times before it may stop." min={1} max={64} step={1} value={[ adaptiveMinSamples ]} onValueChange={handleAdaptiveMinSamplesChange} />
						</Row>
					</>
				) : null}>
					<Switch label={"Adaptive Sampling"} tip="Keeps working on the grainy parts of the picture and stops on the clean ones, so renders finish sooner." checked={useAdaptiveSampling} onCheckedChange={handleUseAdaptiveSamplingChange} />
				</Row>
				{enablePathTracer && ( <>
					<Separator />
					<Row>
						<Select value={debugMode.toString()} onValueChange={handleDebugModeChange}>
							<span className="opacity-50 text-xs truncate" title="Shows one part of what makes the picture, such as surface direction, distance or colour, to help find problems.">Debug Mode</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select mode" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">None</SelectItem>
								<SelectItem value="1">Normals</SelectItem>
								<SelectItem value="2">Depth</SelectItem>
								<SelectItem value="3">Albedo</SelectItem>
								<SelectItem value="4">Emissive</SelectItem>
								<SelectItem value="5">Indirect (GI)</SelectItem>
								<SelectItem value="6">Env Reflection</SelectItem>
								<SelectItem value="7">Triangle Tests</SelectItem>
								<SelectItem value="8">Box Tests</SelectItem>
								<SelectItem value="9">Stratified Samples</SelectItem>
								<SelectItem value="10">Env Luminance</SelectItem>
								<SelectItem value="11">NaN / Inf</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					{renderDebugModeControls( debugMode.toString(), { debugThreshold, handleDebugThresholdChange } )}
					<Row>
						<Switch label={"Convergence Overlay"} tip="Colours the picture by how clean each part is: red still grainy, yellow nearly done, grey finished." checked={convergenceOverlay} onCheckedChange={handleConvergenceOverlayChange} />
					</Row>
					{convergenceOverlay && ( <>
						<div className="flex flex-wrap gap-x-2 gap-y-0.5 px-1 text-[10px] opacity-60">
							{overlayLegend( useAdaptiveSampling ).map( ( [ dot, label ] ) => (
								<span key={label} className="flex items-center gap-1">
									<i className={`inline-block size-2 rounded-full ${dot}`} />{label}
								</span>
							) )}
						</div>
						<ConvergenceReadout showConverged={useAdaptiveSampling} showTracing={useAdaptiveSampling} />
					</> )}
					{import.meta.env.DEV && (
						<Row>
							<Switch label={"Inspector"} tip="Opens the developer inspector for the renderer." checked={showInspector} onCheckedChange={handleInspectorToggle} />
						</Row>
					)}
				</> )}
			</ControlGroup>
		</div>
	);

};

export default PathTracerTab;
