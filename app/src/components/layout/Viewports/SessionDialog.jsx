import { useEffect, useRef, useState } from "react";
import { fileIdentity, sameIdentity } from "rayzee";
import { Loader2 } from "lucide-react";
import { useStore, useAnimationStore } from "@/store";
import { getApp } from "@/lib/appProxy";
import { useToast } from "@/hooks/use-toast";
import { restoreSession, getSessionKeeper } from "@/lib/session";
import { formatBytes } from "@/lib/storage";
import {
	Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const SECTION_NAMES = {
	environment: 'the sky', color: 'the colour settings', settings: 'some settings', appended: 'an added model',
	scene: 'object and material edits', materials: 'some material edits', moved: 'some moved objects', cameras: 'some camera settings',
};

function savedAgo( time ) {

	const minutes = Math.round( ( Date.now() - time ) / 60000 );
	if ( minutes < 1 ) return 'just now';
	if ( minutes < 60 ) return `${minutes} min ago`;
	const hours = Math.round( minutes / 60 );
	if ( hours < 24 ) return `${hours} h ago`;
	return new Date( time ).toLocaleString();

}

function useObjectURL( blob ) {

	const [ url, setUrl ] = useState( null );
	useEffect( () => {

		if ( ! blob ) return undefined;
		const next = URL.createObjectURL( blob );
		setUrl( next );
		return () => {

			URL.revokeObjectURL( next );
			setUrl( null );

		};

	}, [ blob ] );
	return url;

}

/**
 * Reopens a saved session or project: asks first at startup (D1), asks for any local file the
 * browser could not keep (D2), then restores the model and every edit.
 */
const SessionDialog = () => {

	const request = useStore( state => state.sessionRequest );
	const setRequest = useStore( state => state.setSessionRequest );
	const [ step, setStep ] = useState( 'offer' );
	const [ pick, setPick ] = useState( null );
	const inputRef = useRef( null );
	const thumbUrl = useObjectURL( request?.thumb ?? null );
	const { toast } = useToast();

	const finish = () => {

		getSessionKeeper()?.setEnabled( true );
		setPick( null );
		setStep( 'offer' );
		setRequest( null );

	};

	const pickFile = ( identity, role ) => {

		if ( role === 'model' && request.embeddedFile ) return Promise.resolve( request.embeddedFile );
		return new Promise( resolve => {

			setPick( { identity, role, resolve, error: null } );
			setStep( 'pick' );

		} );

	};

	const run = async () => {

		const app = getApp();
		if ( ! app ) return;
		const keeper = getSessionKeeper();
		keeper?.setEnabled( false );
		setStep( 'working' );
		let resumeVideo = null;

		try {

			const report = await restoreSession( app, request.record, { pickFile, reuseLoaded: request.origin === 'startup' } );
			if ( report === null ) {

				toast( { title: 'Session not restored', description: 'Its model was not opened, so the scene stays as it is.' } );
				return;

			}

			if ( ( request.origin === 'startup' || request.origin === 'recent' ) && request.key ) await keeper?.adopt( request );
			const missing = [ ...new Set( report.skipped.map( s => SECTION_NAMES[ s.section ] ?? s.section ) ) ];

			if ( request.origin === 'video' ) {

				if ( missing.length ) toast( { title: 'Resuming with changes', description: `Could not bring back ${missing.join( ', ' )}.` } );
				resumeVideo = request.job;

			} else if ( request.origin === 'still' ) {

				const { resumeStill } = await import( '@/lib/stillJob' );
				const samples = await resumeStill( app, request.still );
				toast( {
					title: `Continuing ${request.record.title}`,
					description: `From ${samples} of ${request.still.job.target} samples${missing.length ? `; could not bring back ${missing.join( ', ' )}` : ''}.`,
				} );

			} else {

				toast( {
					title: `Restored ${request.record.title}`,
					description: missing.length ? `Could not bring back ${missing.join( ', ' )}.` : 'Every edit is back.',
				} );

			}

		} catch ( error ) {

			if ( error?.code !== 'LOAD_CANCELLED' ) {

				toast( { title: 'Could not restore the session', description: error?.message || String( error ), variant: 'destructive' } );

			}

		} finally {

			useStore.getState().resetLoading();
			finish();

		}

		if ( resumeVideo ) useAnimationStore.getState().handleRenderAnimation( { resume: resumeVideo } );

	};

	const discardJob = async () => {

		if ( request.origin === 'video' ) await request.job?.discard();
		if ( request.origin === 'still' ) {

			const { discardStill } = await import( '@/lib/stillJob' );
			await discardStill( getApp()?.storage, request.still.job.id );

		}

		finish();

	};

	if ( ! request ) return null;

	const onFile = async event => {

		const file = event.target.files?.[ 0 ];
		event.target.value = '';
		if ( ! file || ! pick ) return;
		if ( pick.identity.sample && ! sameIdentity( await fileIdentity( file ), pick.identity ) ) {

			setPick( { ...pick, error: `${file.name} is not the file this session used.` } );
			return;

		}

		pick.resolve( file );
		setPick( null );
		setStep( 'working' );

	};

	const skip = () => {

		pick?.resolve( null );
		setPick( null );
		setStep( 'working' );

	};

	const { record } = request;
	const busy = step === 'working';
	const startup = request.origin === 'startup';
	const video = request.origin === 'video' ? request.job : null;
	const still = request.origin === 'still' ? request.still.job : null;

	return (
		<Dialog open onOpenChange={open => {

			if ( open ) return;
			if ( step === 'offer' ) finish();
			else if ( step === 'pick' ) skip();

		}}>
			<DialogContent className="max-w-md">
				{step === 'offer' && (
					<>
						<DialogHeader>
							<DialogTitle>{video ? 'Finish the video render?' : still ? 'Finish the final render?' : startup ? 'Pick up where you left off?' : `Open ${record.title}?`}</DialogTitle>
							<DialogDescription>
								{video
									? `${record.title} · ${video.framesDone} of ${video.job.totalFrames} frames done. Resuming reopens its scene and renders the rest.`
									: still
										? `${record.title} · ${still.samples} of ${still.target} samples at ${still.width}×${still.height}. Resuming reopens its scene and carries on from there.`
										: startup
											? `${record.title} · saved ${savedAgo( record.savedAt )}`
											: `Saved ${savedAgo( record.savedAt )}. It replaces the scene you have open.`}
							</DialogDescription>
						</DialogHeader>
						{thumbUrl && <img src={thumbUrl} alt="" className="w-full rounded border object-contain max-h-56 bg-muted" />}
						<DialogFooter className="gap-2">
							{video || still
								? <Button variant="outline" onClick={discardJob}>{video ? 'Discard frames' : 'Discard render'}</Button>
								: <Button variant="outline" onClick={finish}>{startup ? 'Start fresh' : 'Cancel'}</Button>}
							<Button onClick={run}>{video || still ? 'Resume' : startup ? 'Restore' : 'Open'}</Button>
						</DialogFooter>
					</>
				)}

				{step === 'pick' && pick && (
					<>
						<DialogHeader>
							<DialogTitle>{pick.role === 'model' ? 'Open the model again' : 'Open the sky image again'}</DialogTitle>
							<DialogDescription>
								This session used <span className="font-medium text-foreground">{pick.identity.name}</span>
								{Number.isFinite( pick.identity.size ) ? ` (${formatBytes( pick.identity.size )})` : ''}.
								The browser does not keep files you open, so choose it again to bring the edits back.
							</DialogDescription>
						</DialogHeader>
						{pick.error && <p className="text-sm text-destructive">{pick.error}</p>}
						<input ref={inputRef} type="file" className="hidden" onChange={onFile} />
						<DialogFooter className="gap-2">
							<Button variant="outline" onClick={skip}>Skip</Button>
							<Button onClick={() => inputRef.current?.click()}>Choose {pick.identity.name}…</Button>
						</DialogFooter>
					</>
				)}

				{busy && (
					<div className="flex items-center gap-3 py-6 justify-center text-sm">
						<Loader2 className="h-4 w-4 animate-spin" />
						Restoring {record.title}…
					</div>
				)}
			</DialogContent>
		</Dialog>
	);

};

export default SessionDialog;
