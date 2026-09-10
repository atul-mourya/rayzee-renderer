import { useState, useCallback, useEffect } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useStore, usePathTracerStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { StatusLabel } from '@/components/ui/status-label';
import { cn } from "@/lib/utils";

// Marks the stop condition that actually retired the frame.
const DoneTick = ( { show } ) => show && <Check className="size-3 text-emerald-400" strokeWidth={3} />;

// One of the three stop-condition chips: active is the armed/binding look. Omit onClick for a
// read-only chip — it then drops the clickable affordance rather than only the handler.
const StatChip = ( { active, onClick, title, children } ) => (
	<span
		onClick={onClick}
		title={title}
		className={cn(
			"inline-flex items-center gap-1",
			onClick && "cursor-pointer hover:text-white transition-colors",
			active && "font-bold text-blue-400"
		)}
	>
		{children}
	</span>
);

const formatBytes = ( bytes ) => {

	if ( ! bytes ) return '0 MB';
	const mb = bytes / 1048576;
	return mb >= 1024 ? `${( mb / 1024 ).toFixed( 2 )} GB` : `${mb.toFixed( 0 )} MB`;

};

const EditableValue = ( { value, onCommit } ) => {

	const [ isEditing, setIsEditing ] = useState( false );
	const [ tempValue, setTempValue ] = useState( String( value ) );

	useEffect( () => {

		if ( ! isEditing ) setTempValue( String( value ) );

	}, [ value, isEditing ] );

	const commit = () => {

		setIsEditing( false );
		const num = Number( tempValue );
		if ( ! isNaN( num ) && num !== value ) {

			onCommit( num );

		} else {

			setTempValue( String( value ) );

		}

	};

	if ( isEditing ) {

		return (
			<input
				className="bg-transparent border-b border-white text-white w-12"
				type="number"
				value={tempValue}
				onChange={e => setTempValue( e.target.value )}
				onBlur={commit}
				onKeyDown={e => e.key === 'Enter' && commit()}
				autoFocus
			/>
		);

	}

	return (
		<span
			onClick={() => setIsEditing( true )}
			className="cursor-pointer border-b border-dotted border-white hover:border-blue-400 transition-colors duration-300"
		>
			{value}
		</span>
	);

};

const StatsMeter = ( { viewportMode } ) => {

	// Store subscriptions
	const storeMaxSamples = usePathTracerStore( state => state.maxSamples );
	const setStoreMaxSamples = usePathTracerStore( state => state.setMaxSamples );
	const renderLimitMode = usePathTracerStore( state => state.renderLimitMode );
	const handleRenderLimitModeChange = usePathTracerStore( state => state.handleRenderLimitModeChange );
	const renderTimeLimit = usePathTracerStore( state => state.renderTimeLimit );
	const handleRenderTimeLimitChange = usePathTracerStore( state => state.handleRenderTimeLimitChange );

	const useAdaptiveSampling = usePathTracerStore( state => state.useAdaptiveSampling );
	const handleUseAdaptiveSamplingChange = usePathTracerStore( state => state.handleUseAdaptiveSamplingChange );

	const completionReason = useStore( state => state.completionReason );
	const stats = useStore( state => state.stats );
	const isDenoising = useStore( state => state.isDenoising );
	const isUpscaling = useStore( state => state.isUpscaling );
	const upscalingProgress = useStore( state => state.upscalingProgress );

	const [ sceneStats, setSceneStats ] = useState( null );

	// Get scene statistics from the active app via app-level API
	const updateSceneStats = useCallback( () => {

		const app = getApp();
		if ( app ) {

			try {

				const statistics = app.getStatistics?.();
				setSceneStats( statistics ?? null );

			} catch ( error ) {

				console.warn( 'Could not get scene statistics:', error );
				setSceneStats( null );

			}

		}

	}, [] );

	// Update scene stats when the scene changes
	useEffect( () => {

		const handleSceneUpdate = () => updateSceneStats();

		// Listen for scene rebuild events
		window.addEventListener( 'SceneRebuild', handleSceneUpdate );

		// Initial update
		updateSceneStats();

		return () => {

			window.removeEventListener( 'SceneRebuild', handleSceneUpdate );

		};

	}, [ updateSceneStats ] );

	// Handle editing max samples
	const handleMaxSamplesEdit = useCallback( ( value ) => {

		if ( value === storeMaxSamples ) return;

		setStoreMaxSamples( value );

		// Update app — setMaxSamples handles completion state internally, never resets
		const app = getApp();
		if ( app ) app.settings.set( 'maxSamples', value );

	}, [ storeMaxSamples, setStoreMaxSamples ] );

	// Update based on viewport mode
	useEffect( () => {

		const app = getApp();
		if ( ! app ) return;

		const newMaxSamples = viewportMode === "preview" ? 60 : 30;

		app.settings.set( 'maxSamples', newMaxSamples );
		setStoreMaxSamples( newMaxSamples );

	}, [ viewportMode, setStoreMaxSamples ] );


	const adaptiveLocked = viewportMode === 'final-render';
	const autoTitle = ( useAdaptiveSampling
		? 'Adaptive sampling: stops the render early once the image stops changing.'
		: 'Adaptive sampling is off — the render always spends its full budget.' )
		+ ( adaptiveLocked
			? ' Change it in the Path Tracer tab; toggling restarts the render.'
			: ' Click to toggle.' );

	return (
		<div className="absolute top-2 left-2 text-xs text-foreground bg-background opacity-50 p-1 rounded flex flex-col gap-1">
			<div className="flex items-center gap-1">
				{sceneStats?.triangleCount > 0 && (
					<span className="mr-1">Triangles: <span className="text-white">{sceneStats.triangleCount.toLocaleString()}</span> |</span>
				)}

				{/* Time Control */}
				<StatChip active={renderLimitMode === 'time'} onClick={() => handleRenderLimitModeChange( 'time' )}>
					Time:
				</StatChip>
				<span className="text-white">{stats.timeElapsed.toFixed( 2 )}</span>s
				{renderLimitMode === 'time' && (
					<> / <EditableValue value={renderTimeLimit} onCommit={handleRenderTimeLimitChange} />s </>
				)}
				<DoneTick show={completionReason === 'timeLimit'} />

				<span className="mx-1">|</span>

				{/* Frames Control */}
				<StatChip active={renderLimitMode === 'frames'} onClick={() => handleRenderLimitModeChange( 'frames' )}>
					Frames:
				</StatChip>
				<span className="text-white">{stats.samples}</span>
				{renderLimitMode === 'frames' && (
					<> / <EditableValue value={storeMaxSamples} onCommit={handleMaxSamplesEdit} /> </>
				)}
				<DoneTick show={completionReason === 'samples'} />

				<span className="mx-1">|</span>

				{/* Adaptive sampling stops the render whatever the Time/Frames toggle says, so it
				    belongs beside them rather than only in the Path Tracer tab. Read-only in final
				    render: unlike those two it carries reset:true, so a stray click here would throw
				    away minutes of accumulation. */}
				<StatChip
					active={useAdaptiveSampling}
					onClick={adaptiveLocked ? undefined : () => handleUseAdaptiveSamplingChange( ! useAdaptiveSampling )}
					title={autoTitle}
				>
					<Sparkles className="size-3" />Auto
				</StatChip>
				<DoneTick show={completionReason === 'converged'} />
			</div>

			<div className="flex items-center gap-1">
				<span>Memory: <span className="text-white">{formatBytes( stats.memoryUsed )}</span></span>
				<span className="mx-1">|</span>
				<span>Peak: <span className="text-white">{formatBytes( stats.memoryPeak )}</span></span>
			</div>

			{isDenoising && (
				<StatusLabel label="Denoising" />
			)}

			{isUpscaling && (
				<StatusLabel
					label="Upscaling"
					percent={upscalingProgress * 100}
					onCancel={() => getApp()?.upscaler?.abort()}
				/>
			)}
		</div>
	);

};

export default StatsMeter;
