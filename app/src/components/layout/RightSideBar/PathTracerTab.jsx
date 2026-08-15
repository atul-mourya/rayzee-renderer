import { Sun, Sunrise, RefreshCcwDot, Target, Image, Blend, Palette, ArrowUp, CloudSun, Wind } from 'lucide-react';
// import { Zap, ArrowDown, Minus, Droplets } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ColorInput } from "@/components/ui/colorinput";
import { usePathTracerStore } from '@/store';
import { ControlGroup } from '@/components/ui/control-group';
import { Row } from '@/components/ui/row';
import { SliderToggle } from '@/components/ui/slider-toggle';
import { Exposure } from '@/assets/icons';
import { Separator } from '@/components/ui/separator';
import { memo, useEffect, useState } from 'react';
import CanvasDimensionControls from './CanvasDimensionControls';
import { MAX_TEXTURE_SIZE_PRESETS } from '@/Constants';
import { getApp } from '@/lib/appProxy';

/**
 * Optimized component for displaying computed auto-exposure value
 * Uses Zustand selector to subscribe only to currentAutoExposure state
 * This prevents unnecessary rerenders of the parent PathTracerTab component
 */
const AutoExposureValue = memo( () => {

	// Use Zustand selector pattern for optimal performance
	// Only subscribes to currentAutoExposure, avoiding full component rerenders
	const currentExposure = usePathTracerStore( ( state ) => state.currentAutoExposure );

	// Don't render if no value available yet
	if ( currentExposure === undefined || currentExposure === null ) {

		return <span className="text-xs opacity-50">Calculating...</span>;

	}

	return (
		<span className="text-xs opacity-70">
			{ currentExposure.toFixed( 3 ) }
		</span>
	);

} );

AutoExposureValue.displayName = 'AutoExposureValue';

// Per-debug-mode control renderers. Add a new case to expose mode-specific
// parameters (e.g. thresholds, scales) when introducing a new debug mode.
const renderDebugModeControls = ( debugMode, props ) => {

	switch ( debugMode ) {

		case '7': // Triangle Tests
		case '8': // Box Tests
			return (
				<Row>
					<Slider label={"Display Threshold"} min={1} max={500} step={1} value={[ props.debugThreshold ]} onValueChange={props.handleDebugThresholdChange} />
				</Row>
			);
		default:
			return null;

	}

};

const OVERLAY_LEGEND = [
	[ 'bg-red-500', 'noisy' ],
	[ 'bg-yellow-400', 'near threshold' ],
	[ 'bg-neutral-400', 'converged' ],
	[ 'bg-blue-500', 'frozen' ],
];

// Counters come from a settled-view readback, so they lag a little and read zero while orbiting.
// Each figure is only shown while the feature that maintains it is on, else it reports a stale count.
const ConvergenceReadout = ( { showConverged, showTracing } ) => {

	const [ stats, setStats ] = useState( null );

	useEffect( () => {

		const id = setInterval( () => setStats( getApp()?.getConvergenceStats?.() ?? null ), 250 );
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

	return <div className="px-1 text-[10px] leading-4 opacity-50">{parts.join( ' · ' )}</div>;

};

const toneMappingOptions = [
	{ label: 'None', value: 0 },
	{ label: 'Linear', value: 1 },
	{ label: 'Reinhard', value: 2 },
	{ label: 'Cineon', value: 3 },
	{ label: 'ACESFilmic', value: 4 },
	{ label: 'AgXToneMapping', value: 6 },
	{ label: 'NeutralToneMapping', value: 7 }
];

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
		debugMode,
		debugThreshold,
		showInspector,
		oidnQuality,
		enableOIDN,
		enableUpscaler,
		upscalerScale,
		upscalerQuality,
		exposure,
		saturation,
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
		GIIntensity,
		toneMapping,
		// Environment Mode
		environmentMode,
		gradientZenithColor,
		gradientHorizonColor,
		gradientGroundColor,
		solidSkyColor,
		// Procedural Sky (Preetham Model)
		skySunAzimuth,
		skySunElevation,
		skySunIntensity,
		skyRayleighDensity,
		skyTurbidity,
		skyMieAnisotropy,
		skyPreset,
		enableAlphaShadows,
		useAdaptiveSampling,
		noiseThreshold,
		adaptiveMinSamples,
		convergenceOverlay,
		interactionModeEnabled,
		asvgfQualityPreset,
		asvgfDebugMode,
		showAsvgfHeatmap,
		denoiserStrategy,
		filterStrength,
		edgeAtrousIterations,
		edgePhiLuminance,
		edgePhiNormal,
		edgePhiDepth,
		// Auto-exposure state
		autoExposure,
		autoExposureKeyValue,
		autoExposureMinExposure,
		autoExposureMaxExposure,
		autoExposureAdaptSpeedBright,

		// Handlers - now from store
		handlePathTracerChange,
		handleAccumulationChange,
		handleBouncesChange,
		handleTransmissiveBouncesChange,
		handleMaxSubsurfaceStepsChange,
		handleMaxTransparentBouncesChange,
		handleMaxTextureSizeChange,
		handleFireflyThresholdChange,
		handleEnableAlphaShadowsChange,
		handleUseAdaptiveSamplingChange,
		handleNoiseThresholdChange,
		handleAdaptiveMinSamplesChange,
		handleConvergenceOverlayChange,
		handleOidnQualityChange,
		handleEnableOIDNChange,
		handleEnableUpscalerChange,
		handleUpscalerScaleChange,
		handleUpscalerQualityChange,
		handleDebugThresholdChange,
		handleDebugModeChange,
		handleInspectorToggle,
		handleExposureChange,
		handleSaturationChange,
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
		handleGIIntensityChange,
		handleToneMappingChange,
		// Environment Mode Handlers
		handleEnvironmentModeChange,
		handleGradientZenithColorChange,
		handleGradientHorizonColorChange,
		handleGradientGroundColorChange,
		handleSolidSkyColorChange,
		// Procedural Sky (Preetham Model) Handlers
		handleSkySunAzimuthChange,
		handleSkySunElevationChange,
		handleSkySunIntensityChange,
		handleSkyRayleighDensityChange,
		handleSkyTurbidityChange,
		handleSkyMieAnisotropyChange,
		handleSkyPresetChange,
		handleInteractionModeEnabledChange,
		handleAsvgfQualityPresetChange,
		handleAsvgfDebugModeChange,
		handleShowAsvgfHeatmapChange,
		handleDenoiserStrategyChange,
		handleFilterStrengthChange,
		handleEdgeAtrousIterationsChange,
		handleEdgePhiLuminanceChange,
		handleEdgePhiNormalChange,
		handleEdgePhiDepthChange,
		// Auto-exposure handlers
		handleAutoExposureChange,
		handleAutoExposureKeyValueChange,
		handleAutoExposureMinExposureChange,
		handleAutoExposureMaxExposureChange,
		handleAutoExposureAdaptSpeedChange,
	} = pathTracerStore;

	// Backdrop mode derived from the two engine flags (single mutually-exclusive choice).
	const backgroundType = transparentBackground ? 'transparent' : showBackground ? 'environment' : 'color';

	return (
		<div className="">
			<Separator className="bg-primary" />

			<ControlGroup name="Path Tracer" defaultOpen={true}>
				<Row>
					<Switch label={"Enable"} checked={enablePathTracer} onCheckedChange={handlePathTracerChange} />
				</Row>
				<Row>
					<Switch label={"Interaction Mode"} checked={interactionModeEnabled} onCheckedChange={handleInteractionModeEnabledChange} />
				</Row>
				<Row more={(
					<>
						<Row>
							<Slider label={"Transmissive Bounces"} min={0} max={10} step={1} value={[ transmissiveBounces ]} onValueChange={handleTransmissiveBouncesChange} />
						</Row>
						<Row>
							<Slider label={"Transparent Bounces"} min={0} max={32} step={1} value={[ maxTransparentBounces ]} onValueChange={handleMaxTransparentBouncesChange} />
						</Row>
						<Row>
							<Slider label={"Subsurface Steps"} min={1} max={256} step={1} value={[ maxSubsurfaceSteps ]} onValueChange={handleMaxSubsurfaceStepsChange} />
						</Row>
					</>
				)}>
					<Slider label={"Bounces"} min={0} max={20} step={1} value={[ bounces ]} onValueChange={handleBouncesChange} />
				</Row>
				<CanvasDimensionControls />
			</ControlGroup>

			<ControlGroup name="Scene">
				<Row>
					<Select value={toneMapping.toString()} onValueChange={handleToneMappingChange}>
						<span className="opacity-50 text-xs truncate">ToneMapping</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select ToneMapping" />
						</SelectTrigger>
						<SelectContent>
							{toneMappingOptions.map( ( { label, value } ) => (
								<SelectItem key={value} value={value.toString()}>{label}</SelectItem>
							) )}
						</SelectContent>
					</Select>
				</Row>
				<Row more={autoExposure ? (
					<>
						<Row>
							<Slider icon={Target} label={"Target Brightness"} min={0.05} max={0.5} step={0.01} value={[ autoExposureKeyValue ]} snapPoints={[ 0.18 ]} onValueChange={handleAutoExposureKeyValueChange} />
						</Row>
						{/* <Row>
							<Slider icon={ArrowDown} label={"Min Exposure"} min={0.01} max={1.0} step={0.01} value={[ autoExposureMinExposure ]} onValueChange={handleAutoExposureMinExposureChange} />
						</Row>
						<Row>
							<Slider icon={ArrowUp} label={"Max Exposure"} min={1.0} max={20.0} step={0.1} value={[ autoExposureMaxExposure ]} onValueChange={handleAutoExposureMaxExposureChange} />
						</Row>
						<Row>
							<Slider icon={Zap} label={"Adaptation Speed"} min={0.5} max={10.0} step={0.1} value={[ autoExposureAdaptSpeedBright ]} snapPoints={[ 3.0 ]} onValueChange={handleAutoExposureAdaptSpeedChange} />
						</Row> */}
					</>
				) : null}>
					<span className="opacity-50 text-xs truncate">Auto Exposure</span>
					<div className="flex items-center gap-2">
						{autoExposure && <AutoExposureValue />}
						<Switch checked={autoExposure} onCheckedChange={handleAutoExposureChange} />
					</div>
				</Row>
				{! autoExposure && (
					<Row>
						<Slider icon={Exposure} label={"Exposure"} min={0} max={10} step={0.01} value={[ exposure ]} snapPoints={[ 1 ]} onValueChange={handleExposureChange} />
					</Row>
				)}
				{/* <Row>
					<Slider icon={Exposure} label={"Saturation"} min={0} max={2} step={0.01} value={[ saturation ]} snapPoints={[ 1 ]} onValueChange={handleSaturationChange} />
				</Row> */}
				{/* <Row>
					<Slider label={"Global Illumination Intensity"} icon={Sunrise} min={0} max={5} step={0.01} value={[ GIIntensity ]} snapPoints={[ 1 ]} onValueChange={handleGIIntensityChange} />
				</Row> */}
				<Separator className="my-1 opacity-30" />

				{/* Environment Mode Selector */}
				<Row>
					<Select value={environmentMode} onValueChange={handleEnvironmentModeChange}>
						<span className="opacity-50 text-xs truncate">Environment Mode</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hdri">
								<div className="flex items-center">
									<Image size={14} className="mr-1" />
									<span>HDRI</span>
								</div>
							</SelectItem>
							<SelectItem value="procedural">
								<div className="flex items-center">
									<CloudSun size={14} className="mr-1" />
									<span>Procedural Sky</span>
								</div>
							</SelectItem>
							<SelectItem value="gradient">
								<div className="flex items-center">
									<Blend size={14} className="mr-1" />
									<span>Gradient</span>
								</div>
							</SelectItem>
							<SelectItem value="color">
								<div className="flex items-center">
									<Palette size={14} className="mr-1" />
									<span>Solid Color</span>
								</div>
							</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{/* Gradient Mode Controls */}
				{environmentMode === 'gradient' && (
					<>
						<Row>
							<ColorInput label="Zenith" value={gradientZenithColor} onChange={handleGradientZenithColorChange} />
						</Row>
						<Row>
							<ColorInput label="Horizon" value={gradientHorizonColor} onChange={handleGradientHorizonColorChange} />
						</Row>
						<Row>
							<ColorInput label="Ground" value={gradientGroundColor} onChange={handleGradientGroundColorChange} />
						</Row>
					</>
				)}

				{/* Solid Color Mode Controls */}
				{environmentMode === 'color' && (
					<Row>
						<ColorInput label="Sky Color" value={solidSkyColor} onChange={handleSolidSkyColorChange} />
					</Row>
				)}

				{/* Procedural Sky Mode Controls */}
				{environmentMode === 'procedural' && (
					<>
						{/* Preset Selector */}
						<Row>
							<Select value={skyPreset} onValueChange={handleSkyPresetChange}>
								<span className="opacity-50 text-xs truncate">Preset</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full">
									<SelectValue placeholder="Select Preset" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="clearMorning">Clear Morning</SelectItem>
									<SelectItem value="clearNoon">Clear Noon</SelectItem>
									<SelectItem value="overcast">Overcast</SelectItem>
									<SelectItem value="goldenHour">Golden Hour</SelectItem>
									<SelectItem value="sunset">Sunset</SelectItem>
									<SelectItem value="dusk">Dusk</SelectItem>
								</SelectContent>
							</Select>
						</Row>

						{/* Sun Position */}
						<Row>
							<Slider label="Sun Rotation" icon={RefreshCcwDot} min={0} max={360} step={1} value={[ skySunAzimuth ]} snapPoints={[ 0, 90, 180, 270 ]} onValueChange={handleSkySunAzimuthChange} />
						</Row>
						<Row>
							<Slider label="Sun Height" icon={ArrowUp} min={- 10} max={90} step={1} value={[ skySunElevation ]} snapPoints={[ 0, 45, 90 ]} onValueChange={handleSkySunElevationChange} />
						</Row>
						<Row>
							<Slider label="Sun Brightness" icon={Sun} min={0} max={50} step={0.5} value={[ skySunIntensity ]} snapPoints={[ 20 ]} onValueChange={handleSkySunIntensityChange} />
						</Row>

						{/* Atmospheric Properties */}
						<Row>
							<Slider label="Sky Clarity" icon={CloudSun} min={0} max={2} step={0.1} value={[ skyRayleighDensity ]} snapPoints={[ 1 ]} onValueChange={handleSkyRayleighDensityChange} />
						</Row>
						<Row>
							<Slider label="Atmospheric Haze" icon={Wind} min={0} max={5} step={0.1} value={[ skyTurbidity ]} snapPoints={[ 1 ]} onValueChange={handleSkyTurbidityChange} />
						</Row>
					</>
				)}

				<Separator className="my-1 opacity-30" />

				{/* Common Environment Controls */}
				<Row>
					<SliderToggle label={"Environment Intensity"} enabled={enableEnvironment} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ environmentIntensity ]} onValueChange={handleEnvironmentIntensityChange} onToggleChange={handleEnableEnvironmentChange} />
				</Row>
				{/* Background backdrop — a single mutually-exclusive mode (env image / solid color /
				    transparent). Independent of Environment Intensity above, which controls lighting only. */}
				<Row>
					<span className="opacity-50 text-xs truncate">Background</span>
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
							<Slider label={"Background Intensity"} icon={Sun} min={0} max={2} step={0.01} snapPoints={[ 1 ]} value={[ backgroundIntensity ]} onValueChange={handleBackgroundIntensityChange} />
						</Row>
						<Row>
							<Slider label={"Background Blur"} min={0} max={1} step={0.01} value={[ backgroundBlurriness ]} onValueChange={handleBackgroundBlurrinessChange} />
						</Row>
						{backgroundBlurriness > 0 && (
							<Row>
								<Slider label={"Blur Samples"} min={1} max={32} step={1} value={[ backgroundBlurSamples ]} onValueChange={handleBackgroundBlurSamplesChange} />
							</Row>
						)}
					</>
				)}
				{backgroundType === 'color' && (
					<Row>
						<ColorInput label="Background Color" value={backgroundColor} onChange={handleBackgroundColorChange} />
					</Row>
				)}

				{/* Analytic ground-plane shadow catcher (no geometry; primary-ray holdout into alpha) */}
				<Row>
					<Switch label={"Shadow Catcher"} checked={enableGroundCatcher} onCheckedChange={handleEnableGroundCatcherChange} />
				</Row>
				{enableGroundCatcher && (
					<Row className="w-full">
						<div className="opacity-50 text-xs truncate">Catcher Height</div>
						<NumberInput min={- 1000} max={1000} step={0.1} value={groundCatcherHeight} onValueChange={handleGroundCatcherHeightChange} />
					</Row>
				)}

				{/* HDRI Mode Controls */}
				{environmentMode === 'hdri' && (
					<>
						<Row>
							<Slider label={"Environment Rotation"} icon={RefreshCcwDot} min={0} max={360} step={1} value={[ environmentRotation ]} snapPoints={[ 90, 180, 270 ]} onValueChange={handleEnvironmentRotationChange} />
						</Row>
						<Row>
							<SliderToggle label={"Ground Projection"} enabled={groundProjectionEnabled} icon={RefreshCcwDot} min={10} max={500} step={1} value={[ groundProjectionRadius ]} onValueChange={handleGroundProjectionRadiusChange} onToggleChange={handleGroundProjectionEnabledChange} />
						</Row>
						{groundProjectionEnabled && (
							<Row>
								<Slider label={"Projection Height"} icon={ArrowUp} min={0} max={50} step={0.1} value={[ groundProjectionHeight ]} onValueChange={handleGroundProjectionHeightChange} />
							</Row>
						)}
					</>
				)}
			</ControlGroup>

			<ControlGroup name="Denoising">
				<Row>
					<Select value={denoiserStrategy} onValueChange={handleDenoiserStrategyChange}>
						<span className="opacity-50 text-xs truncate">Real-Time Denoiser</span>
						<SelectTrigger className="max-w-32 h-5 rounded-full" >
							<SelectValue placeholder="Select strategy" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">None</SelectItem>
							<SelectItem value="edgeaware">EdgeAware</SelectItem>
							<SelectItem value="asvgf">ASVGF</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				{denoiserStrategy === 'edgeaware' && ( <>
					<Row>
						<Slider label={"Filter Strength"} min={0} max={1} step={0.01} value={[ filterStrength ]} onValueChange={handleFilterStrengthChange} />
					</Row>
					<Row>
						<Slider label={"Iterations"} min={1} max={6} step={1} value={[ edgeAtrousIterations ]} onValueChange={handleEdgeAtrousIterationsChange} />
					</Row>
					<Row>
						<Slider label={"Luminance φ"} min={0} max={16} step={0.1} value={[ edgePhiLuminance ]} onValueChange={handleEdgePhiLuminanceChange} />
					</Row>
					<Row>
						<Slider label={"Normal φ"} min={1} max={256} step={1} value={[ edgePhiNormal ]} onValueChange={handleEdgePhiNormalChange} />
					</Row>
					<Row>
						<Slider label={"Depth φ"} min={0.01} max={1} step={0.01} value={[ edgePhiDepth ]} onValueChange={handleEdgePhiDepthChange} />
					</Row>
				</> )}

				{denoiserStrategy === 'asvgf' && ( <>
					<Row>
						<Select value={asvgfQualityPreset} onValueChange={handleAsvgfQualityPresetChange}>
							<span className="opacity-50 text-xs truncate">Quality Preset</span>
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
						<Switch label={"Show Heatmap"} checked={showAsvgfHeatmap} onCheckedChange={handleShowAsvgfHeatmapChange}/>
					</Row>
					{showAsvgfHeatmap && (
						<Row>
							<Select value={asvgfDebugMode.toString()} onValueChange={handleAsvgfDebugModeChange}>
								<span className="opacity-50 text-xs truncate">Debug View</span>
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
					<Switch label={"AI Denoising (OIDN)"} checked={enableOIDN} onCheckedChange={handleEnableOIDNChange} />
				</Row>

				{/* OIDN Quality Controls - Independent of real-time denoiser selection */}
				{enableOIDN && ( <>
					<Row>
						<Select value={oidnQuality} onValueChange={handleOidnQualityChange}>
							<span className="opacity-50 text-xs truncate">OIDN Quality</span>
							<SelectTrigger className="max-w-32 h-5 rounded-full" >
								<SelectValue placeholder="Select quality" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="fast">Fast</SelectItem>
								<SelectItem value="balance">Balance</SelectItem>
								<SelectItem value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</> )}

				<Separator />

				{/* AI Upscaler Control */}
				<Row>
					<Switch label={"AI Upscaler"} checked={enableUpscaler} onCheckedChange={handleEnableUpscalerChange} />
				</Row>

				{enableUpscaler && ( <>
					<Row>
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
					<Row>
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
			</ControlGroup>

			<ControlGroup name="Advanced">
				<Row>
					<Select value={maxTextureSize?.toString()} onValueChange={handleMaxTextureSizeChange}>
						<span className="opacity-50 text-xs truncate">Max Texture Size</span>
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
				{enablePathTracer && (
					<Row>
						<Switch label={"Accumulation"} checked={enableAccumulation} onCheckedChange={handleAccumulationChange} />
					</Row>
				)}
				<Row>
					<Slider label={"Firefly Threshold"} min={0} max={10} step={0.1} value={[ fireflyThreshold ]} onValueChange={handleFireflyThresholdChange} />
				</Row>
				<Row>
					<Switch label={"Alpha Shadows"} checked={enableAlphaShadows} onCheckedChange={handleEnableAlphaShadowsChange} />
				</Row>
				<Row more={useAdaptiveSampling ? (
					<>
						<Row>
							<Slider label={"Noise Threshold"} min={0.005} max={0.2} step={0.005} precision={3} value={[ noiseThreshold ]} onValueChange={handleNoiseThresholdChange} />
						</Row>
						<Row>
							<Slider label={"Min Samples"} min={1} max={64} step={1} value={[ adaptiveMinSamples ]} onValueChange={handleAdaptiveMinSamplesChange} />
						</Row>
					</>
				) : null}>
					<Switch label={"Adaptive Sampling"} checked={useAdaptiveSampling} onCheckedChange={handleUseAdaptiveSamplingChange} />
				</Row>
				{enablePathTracer && ( <>
					<Separator />
					<Row>
						<Select value={debugMode.toString()} onValueChange={handleDebugModeChange}>
							<span className="opacity-50 text-xs truncate">Debug Mode</span>
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
						<Switch label={"Convergence Overlay"} checked={convergenceOverlay} onCheckedChange={handleConvergenceOverlayChange} />
					</Row>
					{convergenceOverlay && ( <>
						<div className="flex flex-wrap gap-x-2 gap-y-0.5 px-1 text-[10px] opacity-60">
							{OVERLAY_LEGEND.map( ( [ dot, label ] ) => (
								<span key={label} className="flex items-center gap-1">
									<i className={`inline-block size-2 rounded-full ${dot}`} />{label}
								</span>
							) )}
						</div>
						<ConvergenceReadout showConverged={useAdaptiveSampling} showTracing={useAdaptiveSampling} />
					</> )}
					{import.meta.env.DEV && (
						<Row>
							<Switch label={"Inspector"} checked={showInspector} onCheckedChange={handleInspectorToggle} />
						</Row>
					)}
				</> )}
			</ControlGroup>
		</div>
	);

};

export default PathTracerTab;
