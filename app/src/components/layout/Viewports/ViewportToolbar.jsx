import React, { useState, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize, Orbit, Camera, Download, Minimize, Move, RotateCw, Maximize2, Globe, Box } from "lucide-react";
import { useStore, useCameraStore } from '@/store';
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipProvider
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getApp } from '@/lib/appProxy';

/**
 * ViewportToolbar - A customizable toolbar component for viewport controls
 *
 * @param {Object} props - Component props
 * @param {Function} props.onResize - Callback fired when viewport size changes
 * @param {React.RefObject} props.viewportWrapperRef - Ref to the viewport wrapper element
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.position - Position of the toolbar (top-left, top-right, bottom-left, bottom-right)
 * @param {string} props.buttonVariant - Button variant from UI library
 * @param {string} props.buttonSize - Button size from UI library
 * @param {number} props.iconSize - Size of icons in pixels
 * @param {number} props.minSize - Minimum zoom percentage
 * @param {number} props.maxSize - Maximum zoom percentage
 * @param {number} props.step - Step size for zoom slider
 * @param {number} props.zoomStep - Step size for zoom buttons
 * @param {number} props.defaultSize - Default zoom percentage
 * @param {Object} props.controls - Configuration object for which controls to show
 * @param {boolean} props.controls.resetZoom - Show reset zoom button
 * @param {boolean} props.controls.zoomButtons - Show zoom in/out buttons
 * @param {boolean} props.controls.zoomSlider - Show zoom slider
 * @param {boolean} props.controls.screenshot - Show screenshot button
 * @param {boolean} props.controls.resetCamera - Show reset camera button
 * @param {boolean} props.controls.fullscreen - Show fullscreen button
 */
const ViewportToolbar = ( {
	// Core functionality
	onResize,
	viewportWrapperRef,
	appRef,

	// Auto-fit functionality
	autoFitScale = 100,
	isManualScale = false,
	onResetToAutoFit,

	// Appearance
	className,
	position = "bottom-right",

	// Button and icon styling
	buttonVariant = "ghost",
	buttonSize = "icon",
	iconSize = 14,

	// Zoom settings
	minSize = 5,
	maxSize = 200,
	step = 5,
	zoomStep = 25,
	defaultSize = 100,

	// Control configuration
	controls = {
		resetZoom: true,
		zoomButtons: true,
		zoomSlider: true,
		screenshot: true,
		resetCamera: true,
		fullscreen: true
	}

} ) => {

	// Transform controls state
	const selectedObject = useStore( s => s.selectedObject );
	const transformMode = useStore( s => s.transformMode );
	const transformSpace = useStore( s => s.transformSpace );
	const handleTransformModeChange = useStore( s => s.handleTransformModeChange );
	const handleTransformSpaceChange = useStore( s => s.handleTransformSpaceChange );

	// Not every gizmo mode does something for every light type: point lights are
	// omnidirectional (no rotate/scale effect), spot/directional lights aim via a
	// separate target point (rotate steers it, but scale has no effect). Meshes
	// and area lights (which read scale/rotation directly) keep all three modes.
	const canRotate = ! selectedObject?.isLight || ! selectedObject?.isPointLight;
	const canScale = ! selectedObject?.isLight || !! selectedObject?.isRectAreaLight;

	// Size state for resizer
	const [ size, setSize ] = useState( defaultSize );

	// Sync slider value with auto-fit scale when it changes and not in manual mode
	useEffect( () => {

		if ( ! isManualScale && onResetToAutoFit ) {

			setSize( autoFitScale );

		}

	}, [ autoFitScale, isManualScale, onResetToAutoFit ] );

	// Define position classes based on position prop
	const positionClasses = {
		"top-left": "top-2 left-2",
		"top-right": "top-2 right-2",
		"bottom-left": "bottom-2 left-2",
		"bottom-right": "bottom-2 right-2"
	};

	// Resizer handlers
	const handleSizeChange = ( newSize ) => {

		setSize( newSize[ 0 ] );
		onResize?.( newSize[ 0 ] );

	};

	const handleZoomIn = () => {

		const newSize = Math.min( size + zoomStep, maxSize );
		setSize( newSize );
		onResize?.( newSize );

	};

	const handleZoomOut = () => {

		const newSize = Math.max( size - zoomStep, minSize );
		setSize( newSize );
		onResize?.( newSize );

	};

	const handleResetZoom = () => {

		if ( onResetToAutoFit ) {

			// Reset to auto-fit scale
			onResetToAutoFit();
			setSize( autoFitScale );

		} else {

			// Fallback to default behavior
			setSize( defaultSize );
			onResize?.( defaultSize );

		}

	};

	// Control handlers
	const handleFullscreen = useCallback( () => {

		if ( ! viewportWrapperRef?.current ) return;
		document.fullscreenElement
			? document.exitFullscreen()
			: viewportWrapperRef.current.requestFullscreen();

	}, [ viewportWrapperRef ] );

	const handleResetCamera = useCameraStore( state => state.handleResetCamera );

	const handleScreenshot = useCallback( async () => {

		// If a custom screenshot handler is provided (e.g. Results view downloading
		// the active result image), use it instead of the live rendering canvas.
		if ( appRef?.current?.takeScreenshot ) {

			appRef.current.takeScreenshot();
			return;

		}

		const blob = await getApp()?.screenshot();
		if ( ! blob ) return;

		const url = URL.createObjectURL( blob );
		const link = document.createElement( 'a' );
		link.href = url;
		link.download = 'screenshot.png';
		link.click();
		URL.revokeObjectURL( url );

	}, [ appRef ] );

	// Enhanced Control button with active state indicator
	const ControlButton = ( { onClick, tooltip, icon, disabled = false, isAutoFit = false, isActive = false } ) => (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					onClick={onClick}
					variant={buttonVariant}
					size={buttonSize}
					disabled={disabled}
					className={cn(
						"h-6 w-6 p-1 hover:bg-primary/20 hover:scale-105 mx-1 rounded-full disabled:opacity-50 disabled:cursor-not-allowed",
						( ( isAutoFit && ! isManualScale ) || isActive ) && "bg-primary/30 text-primary"
					)}
				>
					{React.cloneElement( icon, {
						size: iconSize,
						className: cn(
							"text-foreground/70",
							( ( isAutoFit && ! isManualScale ) || isActive ) && "text-primary"
						)
					} )}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p className="text-xs">
					{tooltip}
					{isAutoFit && ! isManualScale && " (Auto-fit active)"}
				</p>
			</TooltipContent>
		</Tooltip>
	);

	// Determine if we need a separator between zoom and other controls
	const hasZoomControls = controls.resetZoom || controls.zoomButtons || controls.zoomSlider;
	const hasOtherControls = controls.screenshot || controls.resetCamera || controls.fullscreen;
	const needsSeparator = hasZoomControls && hasOtherControls;

	return (
		<div className={cn(
			"flex absolute h-8 text-xs text-foreground rounded-full bg-secondary backdrop-blur items-center",
			positionClasses[ position ],
			className
		)}>
			<TooltipProvider>
				{/* Transform Controls — visible when object selected */}
				{selectedObject && (
					<>
						<ControlButton
							onClick={() => handleTransformModeChange( 'translate' )}
							tooltip="Translate"
							icon={<Move />}
							isActive={transformMode === 'translate'}
						/>
						{canRotate && (
							<ControlButton
								onClick={() => handleTransformModeChange( 'rotate' )}
								tooltip="Rotate"
								icon={<RotateCw />}
								isActive={transformMode === 'rotate'}
							/>
						)}
						{canScale && (
							<ControlButton
								onClick={() => handleTransformModeChange( 'scale' )}
								tooltip="Scale"
								icon={<Maximize2 />}
								isActive={transformMode === 'scale'}
							/>
						)}
						<ControlButton
							onClick={() => handleTransformSpaceChange( transformSpace === 'world' ? 'local' : 'world' )}
							tooltip={`${transformSpace === 'world' ? 'World' : 'Local'} Space`}
							icon={transformSpace === 'world' ? <Globe /> : <Box />}
						/>
						<Separator orientation="vertical" className="h-5 mx-1 my-1 bg-foreground/10" />
					</>
				)}

				{/* Zoom Controls Group */}
				{controls.resetZoom && (
					<ControlButton
						onClick={handleResetZoom}
						tooltip={onResetToAutoFit ? "Auto-fit" : "Reset Zoom"}
						icon={onResetToAutoFit ? <Minimize /> : <RotateCcw />}
						isAutoFit={!! onResetToAutoFit}
					/>
				)}

				{controls.zoomButtons && (
					<ControlButton onClick={handleZoomOut} tooltip="Zoom Out" icon={<ZoomOut />}/>
				)}

				{controls.zoomSlider && (
					<Slider
						value={[ size ]}
						min={minSize}
						max={maxSize}
						step={step}
						onValueChange={handleSizeChange}
						className="w-30"
						snapPoints={onResetToAutoFit ? [ autoFitScale ] : undefined}
						snapThreshold={5}
					/>
				)}

				{controls.zoomButtons && (
					<ControlButton onClick={handleZoomIn} tooltip="Zoom In" icon={<ZoomIn />}/>
				)}

				{/* Separator between zoom and other controls */}
				{needsSeparator && (
					<Separator orientation="vertical" className="h-5 mx-1 my-1 bg-foreground/10" />
				)}

				{/* Other Controls Group */}
				{controls.screenshot && (
					<ControlButton
						onClick={handleScreenshot}
						tooltip={appRef ? "Download Image" : "Take Screenshot"}
						icon={appRef ? <Download /> : <Camera />}
						disabled={false}
					/>
				)}

				{controls.resetCamera && (
					<ControlButton onClick={handleResetCamera} tooltip="Reset Camera" icon={<Orbit />}/>
				)}

				{controls.fullscreen && (
					<ControlButton onClick={handleFullscreen} tooltip="Fullscreen" icon={<Maximize />}/>
				)}
			</TooltipProvider>
		</div>
	);

};

export default React.memo( ViewportToolbar );
