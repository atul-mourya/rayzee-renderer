import { useState } from "react";
import { useStore } from "@/store";
import { getApp } from "@/lib/appProxy";
import { useToast } from "@/hooks/use-toast";
import {
	Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

const formatBytes = bytes => {

	if ( bytes >= 1e9 ) return `${( bytes / 1e9 ).toFixed( 1 )} GB`;
	if ( bytes >= 1e6 ) return `${( bytes / 1e6 ).toFixed( 0 )} MB`;
	return `${( bytes / 1e3 ).toFixed( 0 )} KB`;

};

/**
 * Offered when an archive unpacks to more than the engine will hold. The parts come from
 * the streaming pass that already ran, so choosing one costs a second read of the archive
 * and nothing more.
 */
const ArchiveElementDialog = () => {

	const archivePrompt = useStore( state => state.archivePrompt );
	const setArchivePrompt = useStore( state => state.setArchivePrompt );
	const [ loading, setLoading ] = useState( null );
	const { toast } = useToast();

	if ( ! archivePrompt ) return null;

	const { file, elements, totalBytes } = archivePrompt;

	const load = async element => {

		const app = getApp();
		if ( ! app ) return;

		setLoading( element.prefix );
		try {

			app.pauseRendering = true;
			await app.loadFile( file, { element: element.prefix } );
			setArchivePrompt( null );
			toast( { title: "Loaded", description: `${element.name} from ${file.name}` } );

		} catch ( error ) {

			toast( {
				title: "Could not load that part",
				description: error?.message || String( error ),
				variant: "destructive"
			} );

		} finally {

			app.pauseRendering = false;
			useStore.getState().resetLoading();
			setLoading( null );

		}

	};

	return (
		<Dialog open onOpenChange={open => ! open && setArchivePrompt( null )}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Choose a part to load</DialogTitle>
					<DialogDescription>
						{file.name} unpacks to {formatBytes( totalBytes )}, more than fits in memory.
						Pick one of its {elements.length} parts — the scene file, materials and textures come with it.
					</DialogDescription>
				</DialogHeader>

				<ScrollArea className="h-80 pr-3">
					<div className="flex flex-col gap-1">
						{elements.map( element => (
							<Button
								key={element.prefix}
								variant="ghost"
								disabled={loading !== null}
								onClick={() => load( element )}
								className="justify-between font-normal h-auto py-2"
							>
								<span className="truncate text-left">{element.name}</span>
								<span className="text-xs text-muted-foreground shrink-0 ml-3">
									{loading === element.prefix ? "Reading…" : `${formatBytes( element.bytes )} · ${element.files} files`}
								</span>
							</Button>
						) )}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);

};

export default ArchiveElementDialog;
