import { Ruler, Aperture, Camera, Crosshair, RotateCcw, Ellipsis, Plus, Trash2, Globe, Footprints, MoveVertical } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Row } from "@/components/ui/row";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Trackpad } from "@/components/ui/trackpad";
import { NumberInput } from "@/components/ui/number-input";
import { InfoTip } from "@/components/ui/info-tip";
import AspectRatioControl from './AspectRatioControl';
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CAMERA_RANGES, CAMERA_PRESETS, isOrthographic, isPanorama, orthoHeightRange, walkSpeedRange } from '@/Constants';
import { useCameraStore, usePathTracerStore } from '@/store';
import { useEffect } from 'react';
import { getApp } from '@/lib/appProxy';
import { useActiveApp } from '@/hooks/useActiveApp';
import { FieldOfView } from "@/assets/icons";
import { Separator } from "@/components/ui/separator";

/** Min/Max pair for a symmetric ±limit range — the Slider is single-thumb, so it takes two rows. */
const RangeRows = ( { label, limit, value, onChange } ) => [ 0, 1 ].map( i => (
	<Row key={i}>
		<Slider
			label={`${label} ${i ? 'Max' : 'Min'}`}
			min={- limit}
			max={limit}
			step={1}
			value={[ value[ i ] ]}
			onValueChange={( [ v ] ) => onChange( i ? [ value[ 0 ], v ] : [ v, value[ 1 ] ] )}
		/>
	</Row>
) );

const AXIS_NAMES = [ 'width', 'height', 'depth' ];
const threeDigits = v => Number( v.toPrecision( 3 ) );

const CameraTab = () => {

	const {
		// State
		fov,
		focusDistance,
		aperture,
		focalLength,
		enableDOF,
		zoomToCursor,
		navigationMode,
		walkSpeed,
		walkSpeedFitted,
		orthoHeight,
		activePreset,
		apertureScale,
		anamorphicRatio,
		modelDimensions,
		unitsPerMetre,
		dofMode,
		dofBlur,
		cameraNames,
		selectedCameraIndex,

		// Auto-focus state
		afScreenPoint,
		afPlacingPoint,

		// Basic setters
		setCameraNames,
		setSelectedCameraIndex,

		// Handlers
		handlePresetChange,
		handleFovChange,
		handleApertureChange,
		handleFocalLengthChange,
		handleEnableDOFChange,
		handleZoomToCursorChange,
		handleNavigationModeChange,
		handleWalkSpeedChange,
		handleOrthoHeightChange,
		handleCameraMove,
		handleCameraChange,
		handleAddCamera,
		handleRemoveCamera,
		handleApertureScaleChange,
		handleAnamorphicRatioChange,
		handleSubjectSizeChange,
		handleDofModeChange,
		handleDofBlurChange,

		// Auto-focus handlers
		handleToggleAFPointPlacement,
		handleAFResetToCenter,
	} = useCameraStore();

	// Projection lives in usePathTracerStore — switching it re-derives the output dimensions.
	// Narrow selectors: that store takes a per-frame auto-exposure write, so a bare
	// usePathTracerStore() here would re-render this whole panel every frame.
	const cameraProjection = usePathTracerStore( s => s.cameraProjection );
	const panoramaLonRange = usePathTracerStore( s => s.panoramaLonRange );
	const panoramaLatRange = usePathTracerStore( s => s.panoramaLatRange );
	const panoramaLevelHorizon = usePathTracerStore( s => s.panoramaLevelHorizon );
	const handleCameraProjectionChange = usePathTracerStore( s => s.handleCameraProjectionChange );
	const handlePanoramaLonRangeChange = usePathTracerStore( s => s.handlePanoramaLonRangeChange );
	const handlePanoramaLatRangeChange = usePathTracerStore( s => s.handlePanoramaLatRangeChange );
	const handlePanoramaLevelHorizonChange = usePathTracerStore( s => s.handlePanoramaLevelHorizonChange );

	const panorama = isPanorama( cameraProjection );
	const orthographic = isOrthographic( cameraProjection );

	const modelSize = Math.max( ...modelDimensions );
	const longestAxis = AXIS_NAMES[ modelDimensions.indexOf( modelSize ) ];
	const realDimensions = modelDimensions.map( d => threeDigits( d / unitsPerMetre ) ).join( ' × ' );

	const activeApp = useActiveApp();

	// Camera names/selection are kept in sync centrally by EngineAdapter
	// (CameraSwitched / CamerasUpdated). This only seeds the initial values on mount
	// and when the app instance swaps.
	useEffect( () => {

		const app = getApp();
		if ( app ) {

			setCameraNames( app.cameraManager.getNames() );
			setSelectedCameraIndex( app.currentCameraIndex ?? 0 );

		}

	}, [ activeApp, setCameraNames, setSelectedCameraIndex ] );

	const cameraPoints = [
		{ x: 0, y: 50 }, // left view
		{ x: 50, y: 50 }, // front view
		{ x: 100, y: 50 }, // right view
		{ x: 50, y: 0 }, // top view
		{ x: 50, y: 100 }, // bottom view
		{ x: 25, y: 50 }, // front-left view
		{ x: 75, y: 50 }, // front-right view
		{ x: 25, y: 25 }, // top left view
		{ x: 75, y: 25 }, // top right view
		{ x: 25, y: 75 }, // bottom left view
		{ x: 75, y: 75 }, // bottom right view
	];

	const walking = navigationMode === 'walk';
	const walkRange = walkSpeedRange( walkSpeedFitted / unitsPerMetre );
	const heightRange = orthoHeightRange( modelSize / unitsPerMetre );
	const isAFPointCustom = afScreenPoint.x !== 0.5 || afScreenPoint.y !== 0.5;
	const simple = dofMode === 'look';
	const focusMetres = threeDigits( focusDistance / unitsPerMetre );

	// Only user-added cameras (not the default or model-embedded ones) can be removed.
	const canRemoveCamera = selectedCameraIndex > 0
		&& !! getApp()?.cameraManager?.cameras?.[ selectedCameraIndex ]?.userData?.__rayzeeUserCamera;

	return (
		<>
			<Separator className="bg-primary" />
			<div className="space-y-4 p-4">
				<Row>
					<span className="opacity-50 text-xs truncate">Select Camera</span>
					<div className="flex items-center gap-1">
						<Select value={selectedCameraIndex.toString()} onValueChange={handleCameraChange}>
							<SelectTrigger className="w-28 h-5 rounded-full">
								<div className="h-full pr-1 inline-flex justify-start items-center">
									<Camera size={12} className="z-10" />
								</div>
								<SelectValue placeholder="Select camera" />
							</SelectTrigger>
							<SelectContent>
								{cameraNames.map( ( name, index ) => (
									<SelectItem key={index} value={index.toString()}>{name}</SelectItem>
								) )}
							</SelectContent>
						</Select>
						<Button
							variant="outline"
							size="icon"
							onClick={handleAddCamera}
							className="h-5 w-5 rounded-full shrink-0"
							title="Add camera from current view"
						>
							<Plus size={12} />
						</Button>
						<Button
							variant="outline"
							size="icon"
							onClick={() => handleRemoveCamera( selectedCameraIndex )}
							disabled={! canRemoveCamera}
							className="h-5 w-5 rounded-full shrink-0"
							title={canRemoveCamera ? "Remove this camera" : "Only user-added cameras can be removed"}
						>
							<Trash2 size={12} />
						</Button>
					</div>
				</Row>

				<Row>
					<span className="opacity-50 text-xs truncate">Projection</span>
					<Select value={cameraProjection} onValueChange={handleCameraProjectionChange}>
						<SelectTrigger className="max-w-36 h-5 rounded-full">
							<div className="h-full pr-1 inline-flex justify-start items-center">
								<Globe size={12} className="z-10" />
							</div>
							<SelectValue placeholder="Select projection" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="perspective">Perspective</SelectItem>
							<SelectItem value="orthographic">Orthographic</SelectItem>
							<SelectItem value="equirectangular">360° Panorama</SelectItem>
						</SelectContent>
					</Select>
				</Row>

				<AspectRatioControl />

				{panorama && (
					<>
						<Row>
							<Switch
								checked={panoramaLevelHorizon}
								label="Level Horizon"
								onCheckedChange={handlePanoramaLevelHorizonChange}
							/>
						</Row>

						<RangeRows label="Longitude" limit={180} value={panoramaLonRange} onChange={handlePanoramaLonRangeChange} />
						<RangeRows label="Latitude" limit={90} value={panoramaLatRange} onChange={handlePanoramaLatRangeChange} />
					</>
				)}

				<Row>
					{orthographic ? (
						<Slider
							label={<>View Height<InfoTip text="How tall a slice of the scene the picture shows, in metres. Nothing shrinks with distance, so it is the same at every depth. Scrolling in the view zooms it too." /></>}
							icon={MoveVertical}
							min={heightRange.min}
							max={heightRange.max}
							step={heightRange.step}
							precision={heightRange.precision}
							unit=" m"
							value={[ orthoHeight / unitsPerMetre ]}
							onValueChange={( values ) => handleOrthoHeightChange( values[ 0 ] )}
						/>
					) : (
						<Slider
							label={"FOV"}
							icon={FieldOfView}
							min={CAMERA_RANGES.fov.min}
							max={CAMERA_RANGES.fov.max}
							step={1}
							value={[ fov ]}
							onValueChange={handleFovChange}
							disabled={panorama}
						/>
					)}
				</Row>

				<Row>
					<span className="opacity-50 text-xs truncate inline-flex items-center">
						Navigation
						<InfoTip text="Orbit circles the camera around a point. Walk moves it through the scene on foot: drag to look around, and use the keys to move. Back in Orbit, the camera circles whatever it is looking at." />
					</span>
					<ToggleGroup
						type="single"
						value={navigationMode}
						onValueChange={( val ) => val && handleNavigationModeChange( val )}
						className="max-w-40"
					>
						<ToggleGroupItem value="orbit" className="text-xs px-3 h-5">Orbit</ToggleGroupItem>
						<ToggleGroupItem value="walk" className="text-xs px-3 h-5">Walk</ToggleGroupItem>
					</ToggleGroup>
				</Row>

				{walking ? (
					<>
						<Row>
							<Slider
								label={<>Walk Speed<InfoTip text="How fast the keys move the camera. It starts at a speed that crosses the model in about eight seconds, and counts the file's units as metres unless a Subject Size says otherwise." /></>}
								icon={Footprints}
								min={walkRange.min}
								max={walkRange.max}
								step={walkRange.step}
								precision={walkRange.precision}
								unit=" m/s"
								value={[ walkSpeed / unitsPerMetre ]}
								onValueChange={( values ) => handleWalkSpeedChange( values[ 0 ] )}
							/>
						</Row>
						<p className="text-[10px] opacity-50 leading-relaxed">
							Drag to look · W A S D or arrows to walk · E / Q up and down<br />
							Hold Shift to go faster, Alt/Option to go slower
						</p>
					</>
				) : (
					<Row>
						<Switch
							checked={zoomToCursor}
							label="Zoom to Cursor"
							onCheckedChange={handleZoomToCursorChange}
						/>
					</Row>
				)}

				<Separator />

				<Row>
					<Switch
						checked={enableDOF}
						label="Depth of Field"
						onCheckedChange={handleEnableDOFChange}
					/>
				</Row>

				{enableDOF && (
					<>
						<Row>
							<span className="opacity-50 text-xs truncate inline-flex items-center">
								Mode
								<InfoTip text="Simple: pick a look and how blurry the background gets. It works the same on any model. Pro: a real camera, where the f-stop, the focal length and the subject's real size decide the blur, as in a photo or in Blender." />
							</span>
							<ToggleGroup
								type="single"
								value={dofMode}
								onValueChange={( val ) => val && handleDofModeChange( val )}
								className="max-w-40"
							>
								<ToggleGroupItem value="look" className="text-xs px-3 h-5">Simple</ToggleGroupItem>
								<ToggleGroupItem value="physical" className="text-xs px-3 h-5">Pro</ToggleGroupItem>
							</ToggleGroup>
						</Row>

						<Row>
							<Select value={activePreset} onValueChange={handlePresetChange}>
								<span className="opacity-50 text-xs truncate">Look</span>
								<SelectTrigger className="max-w-32 h-5 rounded-full">
									<div className="h-full pr-1 inline-flex justify-start items-center">
										<Camera size={12} className="z-10" />
									</div>
									<SelectValue placeholder="Select look" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="custom">Custom</SelectItem>
									{Object.entries( CAMERA_PRESETS ).map( ( [ key, preset ] ) => (
										<SelectItem key={key} value={key}>
											<div>
												<div className="font-medium">{preset.name}</div>
												<div className="text-xs opacity-50">{preset.description}</div>
											</div>
										</SelectItem>
									) )}
								</SelectContent>
							</Select>
						</Row>

						{simple && (
							<Row>
								<Slider
									label={<>Background Blur<InfoTip text="How blurry the far background gets, as a share of the picture's height. It looks the same on any model, at any size." /></>}
									icon={Aperture}
									min={0}
									max={20}
									step={0.5}
									precision={1}
									unit="%"
									value={[ dofBlur * 100 ]}
									onValueChange={( values ) => handleDofBlurChange( values[ 0 ] )}
								/>
							</Row>
						)}

						{! simple && (
							<>
								<Row>
									<span className="opacity-50 text-xs truncate inline-flex items-center">
										Subject Size (m)
										<InfoTip text={`The length of the model's longest side, its ${longestAxis}. The whole model is ${realDimensions} m (width × height × depth). If the file's units are off, type the real length: a real camera blurs by real size.`} />
									</span>
									<div className="flex items-center gap-1.5">
										<span className="text-[10px] opacity-40 whitespace-nowrap">longest: {longestAxis}</span>
										<NumberInput
											min={0.001}
											step={0.001}
											sensitivity={10}
											precision={3}
											value={modelSize / unitsPerMetre}
											onValueChange={handleSubjectSizeChange}
										/>
										{unitsPerMetre !== 1 && (
											<Button
												variant="outline"
												size="icon"
												onClick={() => handleSubjectSizeChange( modelSize )}
												className="h-5 w-5 rounded-full"
												title="Back to the size in the file"
											>
												<RotateCcw size={10} />
											</Button>
										)}
									</div>
								</Row>

								<Row>
									<Select value={aperture.toString()} onValueChange={handleApertureChange}>
										<span className="opacity-50 text-xs truncate">Aperture (f)</span>
										<SelectTrigger className="max-w-32 h-5 rounded-full">
											<div className="h-full pr-1 inline-flex justify-start items-center">
												<Aperture size={12} className="z-10" />
											</div>
											<SelectValue placeholder="Select aperture" />
										</SelectTrigger>
										<SelectContent>
											{CAMERA_RANGES.aperture.options.map( f => (
												<SelectItem key={f} value={f.toString()}>{f}</SelectItem>
											) )}
										</SelectContent>
									</Select>
								</Row>

								<Row>
									<Slider
										label={"Focal Length (mm)"}
										icon={Ruler}
										min={CAMERA_RANGES.focalLength.min}
										max={CAMERA_RANGES.focalLength.max}
										step={1}
										value={[ focalLength ]}
										onValueChange={handleFocalLengthChange}
									/>
								</Row>

								<Row>
									<Slider
										label={"DOF Intensity"}
										icon={Aperture}
										min={0.1}
										max={2.0}
										step={0.1}
										value={[ apertureScale ?? 1.0 ]}
										onValueChange={( values ) => handleApertureScaleChange( values[ 0 ] )}
									/>
								</Row>
							</>
						)}

						<Row>
							<span className="opacity-50 text-xs truncate inline-flex items-center">
								Focus
								<InfoTip text="Click the part of the picture that should be sharp. Focus follows that spot as the camera moves." />
							</span>
							<div className="flex items-center gap-1.5">
								<Button
									variant={afPlacingPoint ? "default" : "outline"}
									size="sm"
									onClick={handleToggleAFPointPlacement}
									disabled={panorama}
									title={panorama ? "A panorama holds its focus distance: picking a point needs a perspective camera" : undefined}
									className="h-5 rounded-full text-xs px-2"
								>
									<Crosshair size={12} className="mr-1" />
									{afPlacingPoint ? "Click viewport..." : "Pick Point"}
								</Button>
								{! panorama && isAFPointCustom && (
									<Button
										variant="outline"
										size="icon"
										onClick={handleAFResetToCenter}
										className="h-5 w-5 rounded-full"
										title="Focus on the centre again"
									>
										<RotateCcw size={10} />
									</Button>
								)}
							</div>
						</Row>

						{! simple && (
							<>
								<Row>
									<span className="opacity-50 text-xs truncate inline-flex items-center">
									Focus Distance
										<InfoTip text="How far the focused spot is from the camera, as auto-focus measures it. It counts the file's units as metres unless a Subject Size says otherwise." />
									</span>
									<span className="text-xs tabular-nums opacity-80">{focusMetres} m</span>
								</Row>

								<Row>
									<Slider
										label={"Bokeh Stretch"}
										icon={Ellipsis}
										min={1.0}
										max={2.0}
										step={0.05}
										value={[ anamorphicRatio ?? 1.0 ]}
										onValueChange={( values ) => handleAnamorphicRatioChange( values[ 0 ] )}
									/>
								</Row>
							</>
						)}
					</>
				)}

				<Separator />

				{selectedCameraIndex == 0 && ! walking && (
					<div className="flex items-center">
						<Trackpad
							label={"Camera Position"}
							points={cameraPoints}
							onMove={handleCameraMove}
							className="w-[110px] h-[110px]"
						/>
					</div>
				)}
			</div>
		</>
	);

};

export default CameraTab;
