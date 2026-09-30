import { useCallback } from 'react';
import { Play, Pause, SkipBack, MousePointer2 } from 'lucide-react';
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore, usePathTracerStore, useCameraStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { EngineEvents } from 'rayzee';
import { useBackendEvent } from '@/hooks/useBackendEvent';

// Reusable control button component using shadcn Button
const ControlButton = ( { icon, label, onClick, isActive, disabled } ) => (
	<Tooltip>
		<TooltipTrigger asChild>
			<Button
				variant="ghost"
				size="icon"
				className={cn(
					"w-8 h-full border-0",
					isActive && "bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary",
					! isActive && ! disabled && "text-muted-foreground hover:text-foreground hover:bg-accent/50",
					disabled && "opacity-50"
				)}
				onClick={onClick}
				disabled={disabled}
			>
				{icon}
			</Button>
		</TooltipTrigger>
		<TooltipContent side="bottom">
			<p>{label}</p>
		</TooltipContent>
	</Tooltip>
);

const RenderControls = () => {

	const isRendering = useStore( state => state.isRendering );
	const setIsRendering = useStore( state => state.setIsRendering );
	const enablePathTracer = usePathTracerStore( state => state.enablePathTracer );
	const selectMode = useCameraStore( state => state.selectMode );
	const handleToggleSelectMode = useCameraStore( state => state.handleToggleSelectMode );
	const appMode = useStore( state => state.appMode );

	// Handle toggle play/pause
	const handleTogglePlay = () => {

		const app = getApp();
		if ( ! app ) return;

		if ( isRendering ) {

			app.pauseRendering = true;
			setIsRendering( false );

		} else {

			app.pauseRendering = false;

			// Only reset if render is complete
			if ( app.isComplete() ) {

				app.reset();

			}

			setIsRendering( true );

		}

	};

	// Handle restart button click
	const handleRestart = () => {

		const app = getApp();
		if ( app ) {

			// First pause if playing
			app.pauseRendering = true;

			// Then reset and resume
			setTimeout( () => {

				app.reset();
				app.pauseRendering = false;
				setIsRendering( true );

			}, 100 );

		}

	};

	useBackendEvent( EngineEvents.RENDER_COMPLETE, useCallback( () => setIsRendering( false ), [ setIsRendering ] ) );
	useBackendEvent( EngineEvents.RENDER_RESET, useCallback( () => setIsRendering( true ), [ setIsRendering ] ) );

	// Control button definitions — play/pause/restart only when path tracer is enabled
	const controls = [
		...( enablePathTracer ? [
			{
				icon: isRendering ? <Pause size={14} /> : <Play size={14} />,
				label: isRendering ? 'Pause' : 'Play',
				onClick: handleTogglePlay,
				isActive: false,
				disabled: false
			},
			{
				icon: <SkipBack size={14} />,
				label: 'Restart',
				onClick: handleRestart,
				isActive: false,
				disabled: false
			}
		] : [] ),
		// Show select mode button in preview and results modes
		...( ( appMode === 'preview' || appMode === 'results' ) ? [ {
			icon: <MousePointer2 size={14} />,
			label: 'Click to Select',
			onClick: handleToggleSelectMode,
			isActive: selectMode,
			disabled: false
		} ] : [] )
	];

	return (
		<div className="absolute top-2 left-1/2 transform -translate-x-1/2 z-10">
			<div className="flex h-8 bg-background/90 rounded-full overflow-hidden shadow-md border border-border">
				<TooltipProvider>
					{controls.map( ( control, index ) => (
						<div key={control.label} className="flex items-center">
							{index > 0 && <div className="w-px bg-muted h-8"></div>}
							<ControlButton {...control} />
						</div>
					) )}
				</TooltipProvider>
			</div>
		</div>
	);

};

export default RenderControls;
