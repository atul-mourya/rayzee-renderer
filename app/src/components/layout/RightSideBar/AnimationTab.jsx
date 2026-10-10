import { Play, Pause, Square, Film, Gauge, ListMusic, X, Route, Plus, Crosshair, RefreshCw, Trash2 } from 'lucide-react';
import { Slider } from "@/components/ui/slider";
import { Row } from "@/components/ui/row";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { NumberInput } from '@/components/ui/number-input';
import { useEffect, useState } from 'react';
import { useAnimationStore, useStore, VIDEO_RENDER_FPS, videoDuration } from '@/store';
import { useActiveApp } from '@/hooks/useActiveApp';
import { VideoJob } from '@/lib/videoJob';

/** The newest video export that stopped before its last frame, re-read whenever rendering stops. */
function useUnfinishedVideo( isVideoRendering ) {

	const app = useActiveApp();
	const [ job, setJob ] = useState( null );

	useEffect( () => {

		if ( isVideoRendering || ! app?.storage ) return undefined;
		let live = true;
		VideoJob.unfinished( app.storage ).then( jobs => live && setJob( jobs[ 0 ] ?? null ), () => {} );
		return () => {

			live = false;

		};

	}, [ app, isVideoRendering ] );

	return [ job, setJob ];

}

const AnimationTab = () => {

	const clips = useAnimationStore( s => s.clips );
	const selectedClip = useAnimationStore( s => s.selectedClip );
	const isPlaying = useAnimationStore( s => s.isPlaying );
	const isPaused = useAnimationStore( s => s.isPaused );
	const speed = useAnimationStore( s => s.speed );
	const loop = useAnimationStore( s => s.loop );
	const handlePlay = useAnimationStore( s => s.handlePlay );
	const handlePause = useAnimationStore( s => s.handlePause );
	const handleStop = useAnimationStore( s => s.handleStop );
	const handleClipChange = useAnimationStore( s => s.handleClipChange );
	const handleSpeedChange = useAnimationStore( s => s.handleSpeedChange );
	const handleLoopChange = useAnimationStore( s => s.handleLoopChange );
	const isVideoRendering = useAnimationStore( s => s.isVideoRendering );
	const videoRenderProgress = useAnimationStore( s => s.videoRenderProgress );
	const videoRenderFrame = useAnimationStore( s => s.videoRenderFrame );
	const videoRenderTotalFrames = useAnimationStore( s => s.videoRenderTotalFrames );
	const loopCount = useAnimationStore( s => s.loopCount );
	const handleLoopCountChange = useAnimationStore( s => s.handleLoopCountChange );
	const handleRenderAnimation = useAnimationStore( s => s.handleRenderAnimation );
	const handleCancelVideoRender = useAnimationStore( s => s.handleCancelVideoRender );
	const cameraKeys = useAnimationStore( s => s.cameraKeys );
	const timelineAnimates = useAnimationStore( s => s.timelineAnimates );
	const isTimelinePlaying = useAnimationStore( s => s.isTimelinePlaying );
	const moveCameraInVideo = useAnimationStore( s => s.moveCameraInVideo );
	const handleMoveCameraInVideoChange = useAnimationStore( s => s.handleMoveCameraInVideoChange );
	const handleAddCameraKey = useAnimationStore( s => s.handleAddCameraKey );
	const handleUpdateCameraKey = useAnimationStore( s => s.handleUpdateCameraKey );
	const handleRemoveCameraKey = useAnimationStore( s => s.handleRemoveCameraKey );
	const handleCameraKeyTimeChange = useAnimationStore( s => s.handleCameraKeyTimeChange );
	const handleGoToCameraKey = useAnimationStore( s => s.handleGoToCameraKey );
	const handlePlayTimeline = useAnimationStore( s => s.handlePlayTimeline );
	const handleStopTimeline = useAnimationStore( s => s.handleStopTimeline );
	const duration = useAnimationStore( videoDuration );
	const [ unfinished, setUnfinished ] = useUnfinishedVideo( isVideoRendering );

	const hasClips = clips.length > 0;
	const selectedClipData = clips[ selectedClip ] || clips[ 0 ];
	const busy = isVideoRendering || isTimelinePlaying;
	const canRender = ( hasClips || timelineAnimates ) && ! isPlaying && ! isTimelinePlaying;

	const keyActions = [
		[ Crosshair, handleGoToCameraKey, "Go to this keyframe's view" ],
		[ RefreshCw, handleUpdateCameraKey, 'Replace with the current view' ],
		[ Trash2, handleRemoveCameraKey, 'Remove this keyframe' ],
	];

	return (
		<>
			<Separator className="bg-primary" />
			<div className="space-y-4 p-4">

				{hasClips ? (
					<>
						{/* Clip Selector */}
						<Row>
							<Select
								value={String( selectedClip )}
								onValueChange={( val ) => handleClipChange( Number( val ) )}
								disabled={busy}
							>
								<span className="opacity-50 text-xs truncate" title="Which of the model's own animations plays.">Animation Clip</span>
								<SelectTrigger className="max-w-40 h-5 rounded-full">
									<div className="h-full pr-1 inline-flex justify-start items-center">
										<ListMusic size={12} className="z-10" />
									</div>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{clips.map( ( clip ) => (
										<SelectItem key={clip.index} value={String( clip.index )}>
											{clip.name} ({clip.duration.toFixed( 1 )}s)
										</SelectItem>
									) )}
								</SelectContent>
							</Select>
						</Row>

						{/* Transport Controls */}
						<div className="flex items-center gap-2">
							<Button
								variant={isPlaying ? "secondary" : "default"}
								size="sm"
								className="flex-1 h-6 text-xs"
								onClick={isPlaying ? handlePause : handlePlay}
								disabled={busy}
							>
								{isPlaying ? (
									<><Pause size={12} className="mr-1" /> Pause</>
								) : (
									<><Play size={12} className="mr-1" /> {isPaused ? 'Resume' : 'Play'}</>
								)}
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-6"
								onClick={handleStop}
								disabled={busy || ( ! isPlaying && ! isPaused )}
								aria-label="Stop animation"
							>
								<Square size={12} />
							</Button>
						</div>

						{/* Duration Info */}
						{selectedClipData && (
							<div className="flex justify-between text-xs">
								<span className="opacity-50" title="How long the clip lasts, at normal speed.">Duration</span>
								<span className="opacity-70">{selectedClipData.duration.toFixed( 2 )}s</span>
							</div>
						)}

						{/* Speed */}
						<Row>
							<Slider
								label="Speed"
								tip="How fast the clip plays. 1 is normal speed."
								icon={Gauge}
								min={0.1}
								max={3.0}
								step={0.1}
								value={[ speed ]}
								onValueChange={( [ val ] ) => handleSpeedChange( val )}
							/>
						</Row>

						{/* Loop */}
						<Row>
							<Switch
								checked={loop}
								label="Loop"
								tip="Plays the clip again from the start when it ends."
								onCheckedChange={handleLoopChange}
								disabled={busy}
							/>
						</Row>
					</>
				) : (
					<p className="text-xs opacity-50 leading-relaxed">
						This model has no animation of its own. You can still make a video by moving the camera along a path of keyframes.
					</p>
				)}

				<Separator />

				{/* Camera Keyframes */}
				<Row>
					<span className="opacity-50 text-xs truncate inline-flex items-center" title="Saved views the camera glides through, in time order, for a video. Frame a view, add a keyframe, then set the times to pace the move.">
						<Route size={12} className="mr-1" />
						Camera Keyframes
					</span>
					<Button
						variant="outline"
						size="sm"
						className="h-5 text-xs px-2"
						onClick={handleAddCameraKey}
						disabled={busy}
						title="Add a keyframe of the current view"
					>
						<Plus size={12} className="mr-1" /> Keyframe
					</Button>
				</Row>

				{cameraKeys.length > 0 ? (
					<div className="space-y-1.5">
						{cameraKeys.map( ( key, i ) => (
							<div key={key.id} className="flex items-center gap-1.5">
								<span className="text-xs opacity-50 w-10 shrink-0" title="When the camera reaches this view, in seconds from the start.">Key {i + 1}</span>
								<NumberInput
									min={0}
									max={3600}
									step={0.1}
									precision={1}
									value={key.time}
									onValueChange={( seconds ) => handleCameraKeyTimeChange( key.id, seconds )}
									disabled={busy}
								/>
								<span className="text-xs opacity-40">s</span>
								<div className="flex items-center gap-1 ml-auto">
									{keyActions.map( ( [ Icon, action, title ] ) => (
										<Button key={title} variant="outline" size="icon" className="h-5 w-5 rounded-full" onClick={() => action( key.id )} disabled={busy} title={title}>
											<Icon size={11} />
										</Button>
									) )}
								</div>
							</div>
						) )}
					</div>
				) : (
					<p className="text-xs opacity-50 leading-relaxed">
						Frame a view and add a keyframe for each place the camera should pass through. Two or more make a move.
					</p>
				)}

				{timelineAnimates && (
					<>
						{hasClips && (
							<Row>
								<Switch
									checked={moveCameraInVideo}
									label="Move Camera in Video"
									tip="Moves the camera along the keyframes while the clip plays in the video. Off keeps the camera still."
									onCheckedChange={handleMoveCameraInVideoChange}
									disabled={busy}
								/>
							</Row>
						)}

						<Button
							variant="outline"
							size="sm"
							className="w-full h-6 text-xs"
							onClick={isTimelinePlaying ? handleStopTimeline : handlePlayTimeline}
							disabled={isVideoRendering || isPlaying}
						>
							{isTimelinePlaying ? (
								<><Square size={12} className="mr-1" /> Stop Preview</>
							) : (
								<><Play size={12} className="mr-1" /> Preview Move</>
							)}
						</Button>
					</>
				)}

				<Separator />

				{/* Video Render Settings */}
				{! isVideoRendering && (
					<>
						{hasClips && (
							<Row>
								<NumberInput
									label="Render Loops"
									tip="How many times the clip plays in the video."
									min={1}
									max={100}
									step={1}
									precision={0}
									value={loopCount}
									onValueChange={handleLoopCountChange}
								/>
							</Row>
						)}
						{canRender && duration > 0 && (
							<div className="flex justify-between text-xs">
								<span className="opacity-50" title="How long the video will be, and how many frames will be rendered.">Video Duration</span>
								<span className="opacity-70">{duration.toFixed( 1 )}s ({Math.ceil( duration * VIDEO_RENDER_FPS )} frames)</span>
							</div>
						)}
					</>
				)}
				{isVideoRendering ? (
					<div className="space-y-2">
						<Row className="text-xs">
							<span className="opacity-50">Rendering frame {videoRenderFrame}/{videoRenderTotalFrames}</span>
							<span className="opacity-70">{Math.round( videoRenderProgress )}%</span>
						</Row>
						<Progress value={videoRenderProgress} className="h-1.5" />
						<Button
							variant="destructive"
							size="sm"
							className="w-full h-6 text-xs"
							onClick={handleCancelVideoRender}
						>
							<X size={12} className="mr-1" /> Cancel Render
						</Button>
					</div>
				) : (
					<Button
						variant="default"
						size="sm"
						className="w-full h-6 text-xs"
						onClick={() => handleRenderAnimation()}
						disabled={! canRender}
					>
						<Film size={12} className="mr-1" /> Render Video
					</Button>
				)}

				{! isVideoRendering && unfinished && (
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="flex-1 h-6 text-xs"
							onClick={() => useStore.getState().setSessionRequest( { origin: 'video', job: unfinished, record: unfinished.job.session } )}
							disabled={! unfinished.job.session}
						>
							<Film size={12} className="mr-1" /> Resume video ({unfinished.framesDone}/{unfinished.job.totalFrames})
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 text-xs"
							onClick={async () => {

								await unfinished.discard();
								setUnfinished( null );

							}}
						>
							Discard
						</Button>
					</div>
				)}

			</div>
		</>
	);

};

export default AnimationTab;
