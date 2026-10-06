import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
	Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useStore } from '@/store';
import { useActiveApp } from '@/hooks/useActiveApp';
import { listSessions, readSession, getSessionKeeper } from '@/lib/session';
import { listRecentProjects, readRecentProject } from '@/lib/project';

function Thumb( { blob } ) {

	const [ url, setUrl ] = useState( null );
	useEffect( () => {

		if ( ! blob ) return undefined;
		const next = URL.createObjectURL( blob );
		setUrl( next );
		return () => URL.revokeObjectURL( next );

	}, [ blob ] );

	return url
		? <img src={url} alt="" className="h-12 w-16 rounded object-cover bg-muted shrink-0" />
		: <div className="h-12 w-16 rounded bg-muted shrink-0" />;

}

/** Sessions other tabs are not using, and projects saved or opened lately. */
const RecentDialog = ( { isOpen, onClose } ) => {

	const app = useActiveApp();
	const [ items, setItems ] = useState( null );

	useEffect( () => {

		if ( ! isOpen || ! app?.storage ) return undefined;
		let live = true;

		( async () => {

			const own = getSessionKeeper()?.id;
			const sessions = ( await listSessions( app.storage ) ).filter( s => ! s.locked && s.id !== own );
			const projects = await listRecentProjects( app.storage );
			const read = await Promise.all( [
				...sessions.map( async s => ( { kind: 'session', meta: s, ...( await readSession( app.storage, s.key ) ) } ) ),
				...projects.map( async p => ( { kind: 'project', meta: p, ...( await readRecentProject( app.storage, p.key ) ) } ) ),
			] );
			if ( live ) setItems( read.filter( item => item.record ) );

		} )();

		return () => {

			live = false;

		};

	}, [ isOpen, app ] );

	const open = item => {

		useStore.getState().setSessionRequest( {
			origin: item.kind === 'session' ? 'recent' : 'project',
			record: item.record,
			thumb: item.thumb,
			...( item.kind === 'session' ? { key: item.meta.key, id: item.meta.id } : {} ),
		} );
		onClose();

	};

	const render = ( kind, heading ) => {

		const list = items?.filter( item => item.kind === kind ) ?? [];
		if ( ! list.length ) return null;
		return (
			<div className="flex flex-col gap-1">
				<div className="text-xs font-medium text-muted-foreground px-1">{heading}</div>
				{list.map( item => (
					<button
						key={item.meta.key}
						type="button"
						onClick={() => open( item )}
						className="flex items-center gap-3 p-1 rounded hover:bg-accent text-left"
					>
						<Thumb blob={item.thumb} />
						<div className="min-w-0">
							<div className="text-sm truncate">{item.record.title}</div>
							<div className="text-xs text-muted-foreground">
								{new Date( item.meta.savedAt ).toLocaleString()}
								{item.record.source?.kind === 'local-file' ? ' · local file' : item.record.source?.kind === 'local-folder' ? ' · local folder' : ''}
							</div>
						</div>
					</button>
				) )}
			</div>
		);

	};

	return (
		<Dialog open={isOpen} onOpenChange={next => ! next && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Open Recent</DialogTitle>
					<DialogDescription>Scenes you worked on in this browser, with their edits.</DialogDescription>
				</DialogHeader>
				{items === null && (
					<div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin" /></div>
				)}
				{items?.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">Nothing yet.</p>}
				{items?.length > 0 && (
					<ScrollArea className="max-h-96 pr-3">
						<div className="flex flex-col gap-4">
							{render( 'session', 'Sessions' )}
							{render( 'project', 'Projects' )}
						</div>
					</ScrollArea>
				)}
			</DialogContent>
		</Dialog>
	);

};

export default RecentDialog;
