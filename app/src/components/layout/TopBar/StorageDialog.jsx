import { useCallback, useEffect, useState } from 'react';
import { EngineEvents } from 'rayzee';
import { Loader2, Trash2 } from 'lucide-react';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useActiveApp } from '@/hooks/useActiveApp';
import { describeUsage, formatBytes } from '@/lib/storage';

const StorageDialog = ( { isOpen, onClose } ) => {

	const app = useActiveApp();
	const storage = app?.storage ?? null;
	const { toast } = useToast();
	const [ summary, setSummary ] = useState( null );
	const [ busy, setBusy ] = useState( null );
	const [ confirmArea, setConfirmArea ] = useState( null );

	const refresh = useCallback( async () => {

		if ( ! storage ) return;
		setSummary( describeUsage( await storage.usage() ) );

	}, [ storage ] );

	useEffect( () => {

		if ( ! isOpen || ! app || ! storage ) return undefined;
		refresh();
		const onChange = () => refresh();
		app.addEventListener( EngineEvents.STORAGE_CHANGED, onChange );
		return () => app.removeEventListener( EngineEvents.STORAGE_CHANGED, onChange );

	}, [ isOpen, app, storage, refresh ] );

	const clearArea = async ( name ) => {

		setBusy( name );
		try {

			const removed = await storage.area( name ).clear();
			await refresh();
			if ( removed === 0 ) toast( { title: 'Nothing cleared', description: 'Everything there is in use right now.' } );

		} finally {

			setBusy( null );

		}

	};

	const clearCaches = async () => {

		setBusy( 'caches' );
		try {

			for ( const row of summary.rows ) if ( row.kind === 'cache' ) await storage.area( row.name ).clear();
			await refresh();

		} finally {

			setBusy( null );

		}

	};

	const keepData = async () => {

		const granted = await storage.persist();
		await refresh();
		if ( ! granted ) {

			toast( { title: 'The browser said no', description: 'It decides from how often you use this site. Bookmarking or installing it usually helps.' } );

		}

	};

	const used = summary ? summary.siteBytes : 0;
	const percent = summary && Number.isFinite( summary.quota ) ? Math.min( 100, ( used / summary.quota ) * 100 ) : 0;
	const confirmRow = summary?.rows.find( ( r ) => r.name === confirmArea );

	return (
		<>
			<Dialog open={isOpen} onOpenChange={onClose}>
				<DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Storage</DialogTitle>
						<DialogDescription>
							What Rayzee keeps on this device. Caches can always be cleared; they refill as you work.
						</DialogDescription>
					</DialogHeader>

					{ ! storage && (
						<p className="text-sm opacity-70">This browser gives the site no on-disk storage here (a private window, or an older browser). Everything works, without the caches.</p>
					) }

					{ storage && ! summary && <Loader2 className="h-4 w-4 animate-spin" /> }

					{ summary && (
						<div className="space-y-4 text-sm">
							<div className="space-y-1">
								<div className="flex justify-between text-xs opacity-70">
									<span>{formatBytes( used )} used</span>
									<span>{formatBytes( summary.quota )} available to this site</span>
								</div>
								<Progress value={percent} className="h-1.5" />
								<div className="flex justify-between text-xs opacity-70">
									<span>Caches {formatBytes( summary.cacheBytes )} of {formatBytes( summary.budget )} allowed</span>
									<span>Your data {formatBytes( summary.userBytes )}</span>
								</div>
							</div>

							<div className="divide-y rounded-md border">
								{ summary.rows.map( ( row ) => (
									<div key={row.name} className="flex items-center gap-3 px-3 py-1.5">
										<div className="min-w-0 grow">
											<div className="flex items-baseline gap-2">
												<span className="font-medium">{row.label}</span>
												<span className="text-xs opacity-50">{row.kind === 'user' ? 'your data' : 'cache'}</span>
											</div>
											<div className="truncate text-xs opacity-60">{row.hint}</div>
										</div>
										<span className="shrink-0 text-xs tabular-nums opacity-70">{formatBytes( row.bytes )}</span>
										<Button
											variant="ghost"
											size="icon"
											className="h-7 w-7 shrink-0"
											title={`Clear ${row.label.toLowerCase()}`}
											disabled={row.entries === 0 || busy !== null}
											onClick={() => ( row.kind === 'user' ? setConfirmArea( row.name ) : clearArea( row.name ) )}
										>
											{ busy === row.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" /> }
										</Button>
									</div>
								) ) }
							</div>

							<div className="flex items-center justify-between gap-3">
								<div className="text-xs opacity-70">
									{ summary.persisted
										? 'Protected: the browser will not clear this data to free space.'
										: 'Not protected: the browser may clear this data when the disk runs low.' }
								</div>
								{ ! summary.persisted && <Button variant="outline" size="sm" onClick={keepData}>Keep data on this device</Button> }
							</div>
						</div>
					) }

					<DialogFooter>
						<Button variant="outline" onClick={clearCaches} disabled={! summary || summary.cacheBytes === 0 || busy !== null}>
							{ busy === 'caches' && <Loader2 className="mr-2 h-4 w-4 animate-spin" /> }
							Clear all caches
						</Button>
						<Button onClick={onClose}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={confirmArea !== null} onOpenChange={( open ) => ! open && setConfirmArea( null )}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete {confirmRow?.label.toLowerCase()}?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {formatBytes( confirmRow?.bytes ?? 0 )} of your own data from this device. It cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={() => {

							const name = confirmArea;
							setConfirmArea( null );
							clearArea( name );

						}}>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);

};

export default StorageDialog;
