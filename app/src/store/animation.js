import { create } from 'zustand';
import { ENGINE_DEFAULTS, VideoRenderManager } from 'rayzee';
import { getApp } from '@/lib/appProxy';
import { readVideoSettings, VIDEO_SETTINGS_KEY, isFrameSequence, videoBitrate, fileStem, openFrameSink, downloadBlob, VIDEO_CONTAINERS } from '@/lib/exporter';
import { VideoJob } from '@/lib/videoJob';
import { toast } from '@/hooks/use-toast';
import { usePathTracerStore } from './pathTracer.js';

// ═══════════════════════════════════════════════════════════════
// Animation Store
// ═══════════════════════════════════════════════════════════════

export const VIDEO_RENDER_FPS = 30;

/** The clip's loops at its speed, or the timeline's length in a still scene. */
export const videoDuration = ( { clips, selectedClip, loopCount, speed, timelineDuration } ) => {

	const clip = clips[ selectedClip ];
	return clip ? clip.duration * Math.max( 1, loopCount ) / ( speed || 1 ) : timelineDuration;

};

/** A video plays the timeline in a still scene, and alongside a clip when asked. */
export const videoUsesTimeline = ( { clips, moveCameraInVideo, timelineAnimates } ) => timelineAnimates && ( ! clips.length || moveCameraInVideo );

// Module-scoped refs — not reactive state, only used for imperative cancel
let _activeVideoManager = null;

let _videoCancelled = false;

export const useAnimationStore = create( ( set, get ) => ( {

	clips: [],
	selectedClip: 0,
	isPlaying: false,
	isPaused: false,
	speed: 1.0,
	loop: true,

	setClips: ( clips ) => set( { clips, selectedClip: 0, isPlaying: false, isPaused: false, speed: 1.0, loop: true, loopCount: 1 } ),
	setIsPlaying: ( isPlaying ) => set( { isPlaying } ),
	setIsPaused: ( isPaused ) => set( { isPaused } ),

	handlePlay: () => {

		const app = getApp();
		if ( ! app ) return;
		const { selectedClip, isPaused } = get();
		if ( isPaused ) {

			app.animationManager.resume();
			set( { isPlaying: true, isPaused: false } );

		} else {

			app.animationManager.play( selectedClip );
			set( { isPlaying: true, isPaused: false } );

		}

	},

	handlePause: () => {

		const app = getApp();
		if ( app ) app.animationManager.pause();
		set( { isPlaying: false, isPaused: true } );

	},

	handleStop: () => {

		const app = getApp();
		if ( app ) app.animationManager.stop();
		set( { isPlaying: false, isPaused: false } );

	},

	handleClipChange: ( index ) => {

		const app = getApp();
		const { isPlaying } = get();
		set( { selectedClip: index } );
		if ( isPlaying && app ) {

			app.animationManager.play( index );

		}

	},

	handleSpeedChange: ( speed ) => {

		const app = getApp();
		if ( app ) app.animationManager.setSpeed( speed );
		set( { speed } );

	},

	handleLoopChange: ( loop ) => {

		const app = getApp();
		if ( app ) app.animationManager.setLoop( loop );
		set( { loop } );

	},

	// ── Timeline (camera keyframes) ──────────────────────────

	// Mirrored from app.timeline on every TIMELINE_CHANGED: { id, time } per key, sorted by time.
	cameraKeys: [],
	timelineDuration: 0,
	timelineAnimates: false,
	isTimelinePlaying: false,
	moveCameraInVideo: false,

	syncTimeline: timeline => set( {
		cameraKeys: timeline.camera.keys.map( ( { id, time } ) => ( { id, time } ) ),
		timelineDuration: timeline.duration,
		timelineAnimates: timeline.animates,
		isTimelinePlaying: timeline.isPlaying,
	} ),

	handleMoveCameraInVideoChange: moveCameraInVideo => set( { moveCameraInVideo } ),
	handleAddCameraKey: () => getApp()?.timeline.camera.addKey(),
	handleUpdateCameraKey: id => getApp()?.timeline.camera.updateKey( id ),
	handleRemoveCameraKey: id => getApp()?.timeline.camera.remove( id ),
	handleCameraKeyTimeChange: ( id, seconds ) => getApp()?.timeline.camera.setTime( id, seconds ),

	handleGoToCameraKey: id => {

		const app = getApp();
		const key = app?.timeline.camera.get( id );
		if ( ! key ) return;
		app.cameraManager.applyPose( key );
		app.reset();

	},

	handlePlayTimeline: () => getApp()?.timeline.play(),
	handleStopTimeline: () => getApp()?.timeline.stop(),

	// ── Video Rendering ──────────────────────────────────────

	loopCount: 1,
	// The Export window's video choices, remembered on this device.
	videoExport: readVideoSettings(),
	setVideoExport: patch => set( state => {

		const videoExport = { ...state.videoExport, ...patch };
		try {

			localStorage.setItem( VIDEO_SETTINGS_KEY, JSON.stringify( videoExport ) );

		} catch { /* storage disabled: kept for this visit */ }

		return { videoExport };

	} ),
	isVideoRendering: false,
	videoRenderProgress: 0,
	videoRenderFrame: 0,
	videoRenderTotalFrames: 0,

	handleLoopCountChange: ( val ) => set( { loopCount: val } ),

	/**
	 * Renders the video, journalling each frame to disk. `output` is the Export window's video choice (its saved
	 * one when omitted); frames go to `folder`, or a zip without one. With `resume` (an unfinished VideoJob, its
	 * scene already restored) it carries on from the first frame the job does not have.
	 */
	handleRenderAnimation: async ( { totalDuration, resume = null, output = null, folder = null } = {} ) => {

		const app = getApp();
		if ( ! app ) return;

		const { selectedClip, clips } = get();
		const saved = resume?.job.options ?? null;
		const timeline = ( saved ? saved.useTimeline : videoUsesTimeline( get() ) ) ? app.timeline : null;
		if ( ! clips.length && ! timeline ) return;

		app.timeline.stop();

		// A job from before the Export window holds no output: it is a WebM.
		const settings = resume ? resume.job.output ?? { format: 'webm' } : output ?? get().videoExport;
		const container = resume ? resume.container : isFrameSequence( settings.format ) ? 'frames' : settings.format;
		const fps = resume?.job.fps ?? settings.fps ?? VIDEO_RENDER_FPS;
		const totalFrames = resume?.job.totalFrames ?? Math.ceil( ( totalDuration || videoDuration( get() ) ) * fps );
		const startFrame = resume?.framesDone ?? 0;

		// The output size, not the canvas's: a camera move just before leaves it at the moving-camera drop.
		const { canvasWidth: width, canvasHeight: height } = usePathTracerStore.getState();
		if ( ! ( width > 0 && height > 0 ) ) return;

		if ( resume && ( width !== resume.job.width || height !== resume.job.height ) ) {

			toast( { title: 'Cannot resume the video', description: `It was rendering at ${resume.job.width}×${resume.job.height}; the output is ${width}×${height} now.`, variant: 'destructive' } );
			return;

		}

		const frames = container === 'frames';
		const { VideoEncoderPipeline, pickVideoCodec } = await import( '@/lib/VideoEncoder' );
		const bitrate = frames ? null : resume?.job.bitrate ?? videoBitrate( width, height, fps, settings.quality );
		const codec = frames ? null : resume?.job.codec ?? await pickVideoCodec( container, width, height, fps, bitrate );
		if ( ! frames && ! codec ) {

			toast( { title: 'Video export unavailable', description: container === 'mp4' ? 'This browser cannot write MP4 (H.264) video. WebM may work.' : 'This browser cannot encode VP9 or VP8 video.', variant: 'destructive' } );
			return;

		}

		if ( frames && resume && ! folder ) {

			toast( { title: 'Cannot resume the frames', description: 'The folder they were going into was not chosen.', variant: 'destructive' } );
			return;

		}

		const options = saved ?? {
			clipIndex: selectedClip,
			speed: get().speed || 1,
			useTimeline: !! timeline,
			samplesPerFrame: ENGINE_DEFAULTS.maxSamples,
			enableOIDN: true,
		};

		set( { isVideoRendering: true, videoRenderProgress: ( startFrame / totalFrames ) * 100, videoRenderFrame: startFrame, videoRenderTotalFrames: totalFrames } );

		// Frames going into a zip cannot be added to later, so they keep no job to resume.
		const job = resume ?? ( frames && ! folder ? null : await ( async () => {

			const { captureSession } = await import( '@/lib/session' );
			const { record } = await captureSession( app, { thumbnail: false } );
			const kind = frames ? `${settings.format.toUpperCase()} frames` : `Video ${container.toUpperCase()}`;
			return VideoJob.start( app.storage, {
				width, height, fps, codec, bitrate, container, totalFrames, options, output: settings, session: record,
				label: `${kind} ${width}×${height}, ${totalFrames} frames`,
			} );

		} )().catch( ( err ) => {

			console.warn( 'Video export: rendering without a job on disk:', err );
			return null;

		} ) );
		if ( job && folder && ! resume ) await ( await import( '@/lib/folders' ) ).rememberFramesFolder( job.key, folder );

		// A long export should not be cut short by the screen going to sleep.
		const wakeLock = await navigator.wakeLock?.request( 'screen' ).catch( () => null );
		// Every frame moves the scene; the session is the scene as it was before the export.
		const { getSessionKeeper } = await import( '@/lib/session' );
		getSessionKeeper()?.setEnabled( false );

		const extension = settings.format === 'exr' ? 'exr' : 'png';
		const stem = fileStem( 'animation' );
		let sink = null;
		let frameChunks = [];
		let decoderConfig = null;
		let encoder = null;
		try {

			if ( frames ) sink = await openFrameSink( { folder, total: totalFrames, extension, zipName: `${stem}-frames.zip` } );
			else encoder = new VideoEncoderPipeline( width, height, {
				fps, codec, container, bitrate, totalFrames,
				onChunk: job ? ( chunk, meta ) => {

					frameChunks.push( chunk );
					decoderConfig ??= meta?.decoderConfig ?? null;

				} : null,
			} );

		} catch ( err ) {

			toast( { title: 'Video export failed', description: err.message, variant: 'destructive' } );
			wakeLock?.release().catch( () => {} );
			getSessionKeeper()?.setEnabled( true );
			set( { isVideoRendering: false, videoRenderProgress: 0, videoRenderFrame: 0, videoRenderTotalFrames: 0 } );
			return;

		}

		const videoManager = new VideoRenderManager( app );

		_activeVideoManager = videoManager;
		_videoCancelled = false;
		let failure = null;

		await videoManager.renderAnimation( {
			clipIndex: options.clipIndex,
			fps,
			speed: options.speed,
			timeline,
			samplesPerFrame: options.samplesPerFrame,
			enableOIDN: options.enableOIDN,
			totalFrames,
			startFrame,
			captureFrame: ! frames,
			onFrame: async ( bitmap, index ) => {

				try {

					if ( frames ) {

						const { format, bitDepth, precision, passes } = settings;
						const asShown = settings.asShown ?? true;
						const { blob } = await app.exportImage( { format, bitDepth, precision, asShown, passes: format === 'exr' && ! asShown ? passes : [], upscaled: false } );
						await sink.write( index, blob );
						if ( job ) await job.appendFrame( index, [] );
						return;

					}

					if ( ! job ) {

						await encoder.addFrame( bitmap, index );
						return;

					}

					// A resumed encoder knows nothing of the frames before: it starts on a keyframe.
					await encoder.addFrame( bitmap, index, { flush: true, keyFrame: index === startFrame } );
					const chunks = frameChunks;
					frameChunks = [];
					await job.appendFrame( index, chunks, decoderConfig );

				} catch ( err ) {

					failure = err;
					videoManager.cancel();

				}

			},
			onProgress: ( { frame, totalFrames: total, percent } ) => {

				set( { videoRenderProgress: percent, videoRenderFrame: frame, videoRenderTotalFrames: total } );

			},
			onComplete: async ( success ) => {

				try {

					if ( success && ! failure ) {

						if ( frames ) {

							await sink.close();
							toast( { title: 'Frames saved', description: folder ? `${totalFrames} ${extension.toUpperCase()} frames in the folder ${folder.name}.` : `${totalFrames} frames in ${stem}-frames.zip.` } );
							await job?.discard();

						} else {

							const blob = await encoder.finalize();
							const file = job ? await job.finalize() : blob;
							downloadBlob( file, `${stem}.${VIDEO_CONTAINERS[ container ].extension}` );
							if ( job ) setTimeout( () => job.discard(), 60_000 );

						}

					} else {

						encoder?.close();
						await sink?.abort();
						if ( _videoCancelled && ! failure ) await job?.discard();

					}

					if ( failure ) {

						console.error( 'Video export failed:', failure );
						toast( {
							title: 'Video export failed',
							description: job ? `${failure.message} — the ${job.framesDone} finished frames are kept and can be resumed.` : failure.message,
							variant: 'destructive',
						} );

					}

				} catch ( err ) {

					console.error( 'Video export: finalize failed:', err );
					toast( { title: 'Video export failed', description: err.message, variant: 'destructive' } );

				}

				_activeVideoManager = null;
				wakeLock?.release().catch( () => {} );
				getSessionKeeper()?.setEnabled( true );
				set( { isVideoRendering: false, videoRenderProgress: 0, videoRenderFrame: 0, videoRenderTotalFrames: 0 } );

			},
		} );

	},

	handleCancelVideoRender: () => {

		_videoCancelled = true;
		if ( _activeVideoManager ) _activeVideoManager.cancel();

	},

} ) );
