import { useRef, useEffect, useState, forwardRef, useMemo, useCallback } from 'react';
import { Eye, Redo2, Undo2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Chip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { useStore, useAIStore, useEditStore, canUndo, canRedo } from '@/store';
import { fitArea } from '@/lib/aiEdit';
import { AreaLayer, CompareSwitch, SplitHandle } from './AIOverlay';
import { CropLayer } from './CropOverlay';
import { EditPipeline, hdrShowsPicture } from '@/lib/ImageProcessor';
import { effectiveCrop, normaliseEdits, orientedSize, outputSize } from '@/lib/edits';
import ViewportToolbar from './ViewportToolbar';
import DimensionDisplay from './DimensionDisplay';
import { StatusBarPortal } from '@/components/layout/StatusBar/StatusBar';
import { getRenderHDR } from '@/lib/database';
import { useActiveApp } from '@/hooks/useActiveApp';
import { useColorStatus, ensureDefaultConfig } from '@/lib/colorManagement';
import { useAutoFitScale } from '@/hooks/useAutoFitScale';
import { usePanZoom } from '@/hooks/usePanZoom';
import { generateViewportStyles } from '@/lib/viewport';

const NO_EDITS = normaliseEdits();
const MAX_SHOWN = 1024;

// Utility function to format render time (compact version)
const formatRenderTime = ( timeInSeconds ) => {

	if ( ! timeInSeconds || timeInSeconds <= 0 ) return null;

	const hours = Math.floor( timeInSeconds / 3600 );
	const minutes = Math.floor( ( timeInSeconds % 3600 ) / 60 );
	const seconds = Math.floor( timeInSeconds % 60 );

	// Compact format without spaces
	if ( hours > 0 ) {

		return `${hours}h${minutes}m${seconds}s`;

	} else if ( minutes > 0 ) {

		return `${minutes}m${seconds}s`;

	} else {

		return `${seconds}s`;

	}

};

/**
 * A picture view on `canvasRef`'s canvas drawn through `pipeline`, made while `enabled`. Its disposal waits a task, so
 * StrictMode's second mount keeps the view rather than making a second renderer on the same canvas.
 */
function usePictureView( app, canvasRef, pipeline, { hdr = true, enabled = true, onDraw = null } = {} ) {

	const [ view, setView ] = useState( null );
	const holder = useRef( null );
	const onDrawRef = useRef( onDraw );
	useEffect( () => {

		onDrawRef.current = onDraw;

	} );

	useEffect( () => {

		if ( ! enabled || ! app?.createPictureView || ! canvasRef.current ) return;
		let h = holder.current;
		if ( h?.app !== app ) {

			const finish = ( picture, renderer ) => {

				onDrawRef.current?.( picture );
				pipeline.draw( renderer, picture );

			};

			h = holder.current = { app, timer: null, view: app.createPictureView( canvasRef.current, { hdr } ).then( v => {

				v.setFinish( finish );
				return v;

			} ) };

		}

		clearTimeout( h.timer );
		let live = true;
		h.view.then( v => live && setView( v ), error => console.warn( 'The picture cannot be shown:', error ) );
		return () => {

			live = false;
			h.timer = setTimeout( () => {

				if ( holder.current === h ) holder.current = null;
				setView( null );
				h.view.then( v => v.dispose(), () => {} );

			} );

		};

	}, [ app, enabled, canvasRef, pipeline, hdr ] );

	return view;

}

const ResultsViewport = forwardRef( function ResultsViewport( props, ref ) {

	const imageData = useStore( state => state.selectedResult );
	const setResultsViewportRef = useStore( state => state.setResultsViewportRef );
	const app = useActiveApp();

	const edits = useEditStore( s => s.edits );
	const cropping = useEditStore( s => !! s.cropping );
	const undoable = useEditStore( canUndo );
	const redoable = useEditStore( canRedo );

	// Refs
	const viewportRef = useRef( null );
	const viewportWrapperRef = useRef( null );
	const containerRef = useRef( null );
	const originalCanvasRef = useRef( null );
	const editedCanvasRef = useRef( null );
	const aiCanvasRef = useRef( null );
	const hdrCanvasRef = useRef( null );
	const hdrPictureRef = useRef( null );

	const [ editPipeline ] = useState( () => new EditPipeline() );
	const [ hdrPipeline ] = useState( () => new EditPipeline() );
	useEffect( () => () => {

		editPipeline.dispose();
		hdrPipeline.dispose();

	}, [ editPipeline, hdrPipeline ] );

	const [ pictureSize, setPictureSize ] = useState( null );
	const [ imageLoadState, setImageLoadState ] = useState( { loaded: false, error: false } );
	const [ viewingOriginal, setViewingOriginal ] = useState( false );
	const longPressActiveRef = useRef( false );
	const longPressTimeoutRef = useRef( null );
	const [ isHovering, setIsHovering ] = useState( false );
	const [ loadedId, setLoadedId ] = useState( null );
	// The render's saved light, shown as an HDR screen showed it (`app.createPictureView`): the size it was drawn at.
	const [ hdrShown, setHdrShown ] = useState( false );
	const hdrOn = !! useColorStatus()?.hdr?.on;
	const hdrWanted = !! imageData?.hasHDR && hdrOn;

	const editView = usePictureView( app, editedCanvasRef, editPipeline, { hdr: false } );
	const hdrView = usePictureView( app, hdrCanvasRef, hdrPipeline, { enabled: hdrWanted, onDraw: picture => {

		hdrPictureRef.current = { width: picture.width, height: picture.height };

	} } );

	const renderId = imageData?.id;
	const renderImage = imageData?.image;
	const shown = useAIStore( s => s.shown[ renderId ] ?? 'render' );
	const compare = useAIStore( s => s.compare );
	const split = useAIStore( s => s.split );
	const where = useAIStore( s => s.where );
	const area = useAIStore( s => s.areas[ renderId ] );
	const job = useAIStore( s => s.jobs[ renderId ] );
	const version = imageData?.aiVersions?.find( v => v.n === shown ) ?? null;
	const [ drawnVersion, setDrawnVersion ] = useState( null );
	const showingVersion = !! version && drawnVersion === version.url && ! viewingOriginal;
	const marking = where === 'part' && !! imageData && ! job && ! cropping;
	const side = showingVersion && compare === 'side';
	const croppingShown = cropping && imageLoadState.loaded && ! showingVersion && ! viewingOriginal;

	// The edited picture's size, the whole turned frame while the crop is edited, or the picture as saved.
	const editedSize = useMemo( () => pictureSize && outputSize( edits.geometry, pictureSize.width, pictureSize.height ), [ edits.geometry, pictureSize ] );
	const shownSize = useMemo( () => {

		if ( ! pictureSize ) return { width: 512, height: 512 };
		if ( viewingOriginal || ! editView ) return pictureSize;
		return outputSize( edits.geometry, pictureSize.width, pictureSize.height, { editing: cropping } );

	}, [ pictureSize, viewingOriginal, editView, edits.geometry, cropping ] );
	const fit = Math.min( MAX_SHOWN / shownSize.width, MAX_SHOWN / shownSize.height, 1 );
	const actualCanvasWidth = Math.round( shownSize.width * fit );
	const actualCanvasHeight = Math.round( shownSize.height * fit );

	// Auto-fit scaling logic
	const {
		viewportScale,
		autoFitScale,
		isManualScale,
		handleViewportResize,
		handleResetToAutoFit
	} = useAutoFitScale( {
		viewportRef,
		canvasWidth: side ? actualCanvasWidth * 2 + 16 : actualCanvasWidth,
		canvasHeight: actualCanvasHeight,
		padding: 80,
		minScale: 5,
		maxScale: 300
	} );

	// Pan & scroll-zoom
	const {
		panOffset,
		isPanning,
		resetPan,
		handlePointerDown,
	} = usePanZoom( {
		viewportRef,
		viewportScale,
		onScaleChange: handleViewportResize,
		minScale: 5,
		maxScale: 300,
		enabled: !! imageData,
		suppressRef: longPressActiveRef,
	} );

	// Reset pan when auto-fit kicks in (viewport resize or explicit reset)
	useEffect( () => {

		if ( ! isManualScale ) resetPan();

	}, [ isManualScale, autoFitScale, resetPan ] );

	const loadedIdRef = useRef( null );
	useEffect( () => {

		loadedIdRef.current = loadedId;

	}, [ loadedId ] );

	const imageDataRef = useRef( imageData );
	useEffect( () => {

		imageDataRef.current = imageData;

	}, [ imageData ] );

	const editViewRef = useRef( null );
	useEffect( () => {

		editViewRef.current = editView;

	}, [ editView ] );

	// Expose ref functions
	useEffect( () => {

		if ( ! ref ) return;

		// In React 19, update the ref directly instead of using useImperativeHandle
		ref.current = {
			getCanvas: () => originalCanvasRef.current,
			// The edited picture, uncropped while the crop is edited, as a copy that stays when the view redraws.
			getEditedCanvas: () => {

				const view = editViewRef.current;
				if ( ! view ) return originalCanvasRef.current;
				const { edits: current, cropping: editing } = useEditStore.getState();
				editPipeline.set( current );
				view.redraw();
				const canvas = editedCanvasRef.current;
				const copy = document.createElement( 'canvas' );
				copy.width = canvas.width;
				copy.height = canvas.height;
				copy.getContext( '2d' ).drawImage( canvas, 0, 0 );
				if ( editing ) {

					editPipeline.set( current, { editing: true } );
					view.redraw();

				}

				return copy;

			},
			getLoadedId: () => loadedIdRef.current,
		};

		setResultsViewportRef( ref );

		// Cleanup store reference on unmount
		return () => {

			// Only clear if it's still our ref (avoid clearing a newer ref)
			if ( useStore.getState().resultsViewportRef === ref ) {

				setResultsViewportRef( null );

			}

		};

	}, [ ref, editPipeline ] );

	// Edits made here are written before the page closes; a crop left open is kept.
	useEffect( () => () => {

		const store = useEditStore.getState();
		store.finishCrop();
		store.flush();

	}, [] );

	// Loads when the render changes, not when its record is re-read (a new AI version): that would drop unsaved edits.
	useEffect( () => {

		const imageData = imageDataRef.current;
		useEditStore.getState().open( imageData );
		if ( ! originalCanvasRef.current || ! imageData?.image ) return;

		const originalCanvas = originalCanvasRef.current;
		const originalCtx = originalCanvas.getContext( '2d' );
		const abortController = new AbortController();

		// Clear canvases and reset state
		originalCtx.clearRect( 0, 0, originalCanvas.width, originalCanvas.height );
		setImageLoadState( { loaded: false, error: false } );
		setLoadedId( null );
		resetPan();

		const img = new Image();
		img.crossOrigin = 'anonymous';

		img.onload = () => {

			if ( abortController.signal.aborted ) return;

			try {

				originalCanvas.width = img.width;
				originalCanvas.height = img.height;
				originalCtx.drawImage( img, 0, 0 );
				const size = { width: img.width, height: img.height };
				setPictureSize( size );
				useEditStore.getState().setPicture( size );
				setImageLoadState( { loaded: true, error: false } );
				setLoadedId( imageData.id );
				setViewingOriginal( false );

			} catch ( error ) {

				if ( ! abortController.signal.aborted ) {

					console.error( 'Error processing 4K image:', error );
					setImageLoadState( { loaded: false, error: true } );

				}

			}

		};

		img.onerror = ( error ) => {

			if ( ! abortController.signal.aborted ) {

				console.error( 'Failed to load 4K image:', imageData.image, error );
				setImageLoadState( { loaded: false, error: true } );

			}

		};

		img.src = imageData.image;

		return () => {

			abortController.abort();
			img.onload = null;
			img.onerror = null;

		};

	}, [ renderId, renderImage, resetPan ] );

	// The picture into the edited view, once both are there; then every edit redraws it.
	useEffect( () => {

		if ( ! editView || ! imageLoadState.loaded ) return;
		const { edits: current, cropping: editing } = useEditStore.getState();
		editPipeline.set( current, { editing: !! editing } );
		editView.showImage( originalCanvasRef.current );

	}, [ editView, loadedId, imageLoadState.loaded, editPipeline ] );

	useEffect( () => {

		if ( ! editView || ! imageLoadState.loaded ) return;
		editPipeline.set( edits, { editing: cropping } );
		editView.redraw();

	}, [ edits, cropping, editView, imageLoadState.loaded, editPipeline ] );

	// The version shown, at the edited picture's size; a version of another shape keeps its own, centred.
	const versionUrl = version?.url;
	const versionWidth = editedSize?.width, versionHeight = editedSize?.height;
	useEffect( () => {

		const canvas = aiCanvasRef.current;
		if ( ! canvas || ! versionUrl || ! imageLoadState.loaded || ! versionWidth ) return;
		let cancelled = false;
		const img = new Image();
		img.onload = () => {

			if ( cancelled ) return;
			canvas.width = versionWidth;
			canvas.height = versionHeight;
			const scale = Math.min( versionWidth / img.width, versionHeight / img.height );
			const w = img.width * scale;
			const h = img.height * scale;
			const ctx = canvas.getContext( '2d' );
			ctx.fillStyle = 'black';
			ctx.fillRect( 0, 0, versionWidth, versionHeight );
			ctx.drawImage( img, ( versionWidth - w ) / 2, ( versionHeight - h ) / 2, w, h );
			setDrawnVersion( versionUrl );

		};

		img.onerror = () => console.error( 'Could not show the AI version:', versionUrl );
		img.src = versionUrl;
		return () => {

			cancelled = true;

		};

	}, [ versionUrl, imageLoadState.loaded, versionWidth, versionHeight ] );

	// The HDR picture: the render's EXR copy through the same view, exposure and local exposure the screen used.
	useEffect( () => {

		setHdrShown( false );
		if ( ! hdrView || ! hdrWanted || ! imageData?.id ) return;
		let cancelled = false;

		( async () => {

			const file = await getRenderHDR( imageData.id );
			if ( ! file || cancelled ) return;
			const { edits: current, cropping: editing } = useEditStore.getState();
			hdrPipeline.set( current, { editing: !! editing } );
			let result = await hdrView.show( file );
			if ( result.reason === 'needs-config' ) {

				await ensureDefaultConfig();
				if ( ! cancelled ) result = await hdrView.show( file );

			}

			if ( ! cancelled ) setHdrShown( result.shown && hdrPictureRef.current );

		} )().catch( error => console.warn( 'The render\'s HDR copy could not be shown:', error ) );

		return () => {

			cancelled = true;

		};

	}, [ imageData?.id, hdrWanted, hdrView, hdrPipeline ] );

	// The edits on the HDR picture too; the original is the picture as saved.
	useEffect( () => {

		if ( ! hdrShown || ! hdrView ) return;
		hdrPipeline.set( viewingOriginal ? NO_EDITS : edits, { editing: cropping && ! viewingOriginal } );
		hdrView.redraw();

	}, [ hdrShown, hdrView, edits, cropping, viewingOriginal, hdrPipeline ] );

	const showHDR = hdrShowsPicture( hdrShown, pictureSize ) && imageLoadState.loaded && ! showingVersion;

	// Long press handling for original/edited view toggling
	const startLongPress = useCallback( () => {

		if ( longPressTimeoutRef.current ) clearTimeout( longPressTimeoutRef.current );
		longPressTimeoutRef.current = setTimeout( () => {

			setViewingOriginal( true );
			longPressActiveRef.current = true;

		}, 200 );

	}, [] );

	const endLongPress = useCallback( () => {

		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

		// Read the ref: the state may be stale in this closure.
		if ( longPressActiveRef.current ) {

			setViewingOriginal( false );
			longPressActiveRef.current = false;

		}

	}, [] );

	// Cancel long press on mouse/touch move
	const cancelLongPress = useCallback( () => {

		if ( longPressTimeoutRef.current ) {

			clearTimeout( longPressTimeoutRef.current );
			longPressTimeoutRef.current = null;

		}

	}, [] );

	useEffect( () => () => {

		if ( longPressTimeoutRef.current ) clearTimeout( longPressTimeoutRef.current );

	}, [] );

	// Memoize style objects with pan offset
	const { wrapperStyle: baseWrapperStyle, containerStyle } = useMemo( () =>
		generateViewportStyles( side ? actualCanvasWidth * 2 + 16 : actualCanvasWidth, actualCanvasHeight, viewportScale ),
	[ side, actualCanvasWidth, actualCanvasHeight, viewportScale ]
	);

	const wrapperStyle = useMemo( () => ( {
		...baseWrapperStyle,
		transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${viewportScale / 100})`,
	} ), [ baseWrapperStyle, panOffset.x, panOffset.y, viewportScale ] );

	// Wrap auto-fit reset to also reset pan
	const handleResetToAutoFitWithPan = useCallback( () => {

		handleResetToAutoFit();
		resetPan();

	}, [ handleResetToAutoFit, resetPan ] );

	// Tells the toolbar its export button is for this saved render.
	const resultsToolbarRef = useRef( null );

	const ai = useAIStore.getState();
	const editStore = useEditStore.getState();
	const fitted = useMemo( () => {

		if ( ! area || ! editedSize ) return area ?? null;
		const { x, y, w, h } = fitArea( area, editedSize.width, editedSize.height );
		return { x: x / editedSize.width, y: y / editedSize.height, w: w / editedSize.width, h: h / editedSize.height };

	}, [ area, editedSize ] );

	const historyButton = ( label, Icon, enabled, onClick ) => (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="secondary" size="icon-sm" rounded aria-label={label} onClick={onClick} disabled={! enabled}>
					<Icon size={12} className={enabled ? 'text-foreground/70' : 'text-foreground/30'} />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				<p className="text-xs">{label}</p>
			</TooltipContent>
		</Tooltip>
	);

	const showHistory = !! imageData && ( undoable || redoable ) && ! viewingOriginal;
	const plainCanvas = { width: `${actualCanvasWidth}px`, height: `${actualCanvasHeight}px`, imageRendering: 'pixelated' };

	return (
		<div
			ref={viewportRef}
			className="flex justify-center items-center h-full z-10"
			style={{ cursor: isPanning ? 'grabbing' : ( imageData ? 'grab' : 'default' ) }}
			onPointerDown={imageData ? handlePointerDown : undefined}
		>
			{imageData && croppingShown && (
				<Chip className="absolute top-2 left-1/2 -translate-x-1/2 z-20">Drag the frame or its corners · Enter keeps it, Esc cancels</Chip>
			)}

			{imageData && ( isHovering || viewingOriginal ) && ! marking && ! croppingShown && (
				<Chip className="absolute top-2 left-1/2 -translate-x-1/2 z-20">
					<Eye size={12} className="text-on-scrim-400" />
					{viewingOriginal ? "Viewing Original" : "Press & Hold to See Original"}
				</Chip>
			)}

			{showingVersion && compare !== 'version' && (
				<div className="absolute top-2 left-2 z-20 flex gap-1.5">
					<Chip>Render</Chip>
					<Chip tone="ai">v{version.n}</Chip>
				</div>
			)}

			{showingVersion && (
				<div className="absolute top-2 right-2 z-20">
					<CompareSwitch value={compare} onChange={ai.setCompare} n={version.n} />
				</div>
			)}

			{showHistory && (
				<div className="absolute bottom-2 left-2 z-20 flex gap-1">
					<TooltipProvider>
						{historyButton( 'Undo', Undo2, undoable, editStore.undo )}
						{historyButton( 'Redo', Redo2, redoable, editStore.redo )}
					</TooltipProvider>
				</div>
			)}

			{imageData && imageData.renderTime && ! viewingOriginal && (
				<Chip className={`absolute ${showHistory ? 'bottom-2 left-20' : 'bottom-2 left-2'} z-20`}>
					⏱ {formatRenderTime( imageData.renderTime )}
				</Chip>
			)}

			{/* Viewport wrapper */}
			<div
				ref={viewportWrapperRef}
				className="relative"
				style={wrapperStyle}
				onMouseDown={imageData ? startLongPress : undefined}
				onTouchStart={imageData ? startLongPress : undefined}
				onMouseUp={imageData ? endLongPress : undefined}
				onMouseLeave={( e ) => {

					imageData && endLongPress( e );
					setIsHovering( false );

				}}
				onTouchEnd={imageData ? endLongPress : undefined}
				onMouseMove={imageData ? cancelLongPress : undefined}
				onTouchMove={imageData ? cancelLongPress : undefined}
				onMouseEnter={() => setIsHovering( true )}
			>
				{/* Container with fixed size */}
				<div
					ref={containerRef}
					data-compare
					className={side ? 'relative flex gap-4' : 'relative'}
					style={containerStyle}
				>
					{/* Loading indicator for 4K images */}
					{imageData && ! imageLoadState.loaded && ! imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-scrim/80 text-on-scrim">
							<div className="flex flex-col items-center space-y-2">
								<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
								<p className="text-sm">Loading 4K image...</p>
							</div>
						</div>
					)}

					{/* Error state for 4K image loading */}
					{imageData && imageLoadState.error && (
						<div className="absolute inset-0 flex items-center justify-center bg-scrim/80 text-on-scrim">
							<div className="text-center">
								<p className="text-sm text-on-scrim-error mb-2">Failed to load 4K image</p>
								<p className="text-xs text-on-scrim-400">The image may be corrupted or too large</p>
							</div>
						</div>
					)}

					{/* The edited picture: every edit, drawn on the GPU */}
					<canvas
						ref={editedCanvasRef}
						style={{
							...plainCanvas,
							display: ( ! editView || viewingOriginal || showHDR || ! imageLoadState.loaded || ( showingVersion && compare === 'version' ) ) ? 'none' : 'block',
						}}
					/>

					{/* The picture as saved: held to see the original, or until the edited view is ready */}
					<canvas
						ref={originalCanvasRef}
						style={{
							...plainCanvas,
							backgroundColor: 'black',
							display: ( ( viewingOriginal || ! editView ) && imageLoadState.loaded && ! showHDR ) ? 'block' : 'none',
						}}
					/>

					{/* The saved light as an HDR screen showed it, with the edits */}
					<canvas
						ref={hdrCanvasRef}
						style={{
							width: `${actualCanvasWidth}px`,
							height: `${actualCanvasHeight}px`,
							display: showHDR ? 'block' : 'none',
						}}
					/>

					{/* The AI version: over the render behind the slider, beside it, or alone */}
					<canvas
						ref={aiCanvasRef}
						style={{
							width: `${actualCanvasWidth}px`,
							height: `${actualCanvasHeight}px`,
							backgroundColor: 'black',
							display: showingVersion && imageLoadState.loaded ? 'block' : 'none',
							...( showingVersion && compare === 'slider' ? { position: 'absolute', top: 0, left: 0, clipPath: `inset(0 0 0 ${split * 100}%)` } : {} ),
						}}
					/>

					{showingVersion && compare === 'slider' && <SplitHandle split={split} onChange={ai.setSplit} label={`Compare the render with v${version.n}`} />}

					{where === 'part' && imageLoadState.loaded && ! side && ! croppingShown && (
						<AreaLayer fitted={fitted} editable={marking} onChange={next => ai.setArea( renderId, next )} />
					)}

					{croppingShown && pictureSize && (
						<CropLayer
							rect={effectiveCrop( edits.geometry, pictureSize.width, pictureSize.height )}
							aspect={edits.geometry.aspect}
							frame={orientedSize( edits.geometry, pictureSize.width, pictureSize.height )}
							angle={edits.geometry.angle}
							onChange={crop => editStore.setGeometry( { ...useEditStore.getState().edits.geometry, crop }, 'crop' )}
							onDone={editStore.finishCrop}
							onCancel={editStore.cancelCrop}
						/>
					)}

					{/* Message when no image is selected */}
					{! imageData && (
						<div className="absolute inset-0 flex items-center justify-center bg-scrim/60 text-on-scrim">
							<p>Select a render from the Results panel</p>
						</div>
					)}
				</div>
			</div>

			{editedSize && imageLoadState.loaded && (
				<StatusBarPortal slot="center">
					<DimensionDisplay dimension={editedSize} />
				</StatusBarPortal>
			)}
			<StatusBarPortal slot="right">
				<ViewportToolbar
					onResize={handleViewportResize}
					viewportWrapperRef={viewportRef}
					appRef={resultsToolbarRef}
					scale={viewportScale}
					defaultSize={100}
					minSize={5}
					maxSize={300}
					zoomStep={25}
					autoFitScale={autoFitScale}
					isManualScale={isManualScale}
					onResetToAutoFit={handleResetToAutoFitWithPan}
					controls={{
						resetZoom: true,
						zoomButtons: true,
						zoomSlider: true,
						screenshot: true,
						resetCamera: false, // Not applicable to static images
						fullscreen: true
					}}
				/>
			</StatusBarPortal>
		</div>
	);

} );

export default ResultsViewport;
