import { useState } from "react";
import { useStore } from "@/store";
import { getApp } from "@/lib/appProxy";
import { useToast } from "@/hooks/use-toast";
import {
	Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle } from "lucide-react";

const formatBytes = bytes => {

	if ( bytes >= 1e9 ) return `${( bytes / 1e9 ).toFixed( 1 )} GB`;
	if ( bytes >= 1e6 ) return `${( bytes / 1e6 ).toFixed( 0 )} MB`;
	return `${( bytes / 1e3 ).toFixed( 0 )} KB`;

};

/**
 * Archive bytes past which a selection is likely to run the tab out of memory. Measured on
 * Moana: 7.5 GB of archive parses to 40M triangles and ~7.3 GB of CPU memory, which loads on a
 * freshly started browser and fails on one that has been open a while. The warning is honest
 * about that rather than pretending there is a fixed limit.
 */
const RISKY_BYTES = 6e9;

/**
 * Offered when a scene archive holds several parts and is big enough that loading all of them
 * may not fit. The sizes come from the pass that already indexed the archive, so choosing costs
 * a second read and nothing more.
 */
const ArchiveElementDialog = () => {

	const archivePrompt = useStore( state => state.archivePrompt );
	const setArchivePrompt = useStore( state => state.setArchivePrompt );
	const [ picked, setPicked ] = useState( () => new Set() );
	const [ loading, setLoading ] = useState( false );
	const { toast } = useToast();

	if ( ! archivePrompt ) return null;

	const { file, elements, totalBytes } = archivePrompt;
	const selectedBytes = elements.reduce( ( n, e ) => n + ( picked.has( e.prefix ) ? e.bytes : 0 ), 0 );
	const risky = selectedBytes >= RISKY_BYTES;

	const toggle = prefix => setPicked( prev => {

		const next = new Set( prev );
		if ( next.has( prefix ) ) next.delete( prefix );
		else next.add( prefix );
		return next;

	} );

	const close = () => {

		setPicked( new Set() );
		setArchivePrompt( null );

	};

	const load = async prefixes => {

		const app = getApp();
		if ( ! app || prefixes.length === 0 ) return;

		setLoading( true );
		try {

			app.pauseRendering = true;
			await app.loadFile( file, { element: prefixes } );
			close();
			toast( {
				title: "Loaded",
				description: `${prefixes.length} of ${elements.length} parts from ${file.name}`
			} );

		} catch ( error ) {

			toast( {
				title: "Could not load that selection",
				description: error?.message || String( error ),
				variant: "destructive"
			} );

		} finally {

			app.pauseRendering = false;
			useStore.getState().resetLoading();
			setLoading( false );

		}

	};

	return (
		<Dialog open onOpenChange={open => ! open && ! loading && close()}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Choose what to load</DialogTitle>
					<DialogDescription>
						{file.name} holds {formatBytes( totalBytes )} across {elements.length} parts.
						Pick as many as you want — the scene file, materials and textures come with them,
						and references to the parts you leave out are skipped.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between text-xs text-muted-foreground px-1">
					<button
						type="button"
						className="underline underline-offset-2 hover:text-foreground"
						onClick={() => setPicked( new Set( elements.map( e => e.prefix ) ) )}
					>
						Select all
					</button>
					<button
						type="button"
						className="underline underline-offset-2 hover:text-foreground"
						onClick={() => setPicked( new Set() )}
					>
						Clear
					</button>
				</div>

				<ScrollArea className="h-80 pr-3">
					<div className="flex flex-col">
						{elements.map( element => (
							<label
								key={element.prefix}
								className="flex items-center gap-3 py-2 px-1 rounded hover:bg-accent cursor-pointer"
							>
								<Checkbox
									checked={picked.has( element.prefix )}
									onCheckedChange={() => toggle( element.prefix )}
									disabled={loading}
								/>
								<span className="truncate text-left text-sm flex-1">{element.name}</span>
								<span className="text-xs text-muted-foreground shrink-0">
									{formatBytes( element.bytes )} · {element.files} files
								</span>
							</label>
						) )}
					</div>
				</ScrollArea>

				{risky && (
					<div className="flex items-start gap-2 text-xs text-amber-500 px-1">
						<AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
						<span>
							This much at once may run the tab out of memory. It is most likely to fit
							in a browser that was started recently.
						</span>
					</div>
				)}

				<DialogFooter className="sm:justify-between items-center gap-2">
					<span className="text-xs text-muted-foreground">
						{picked.size === 0
							? "Nothing selected"
							: `${picked.size} of ${elements.length} selected · ${formatBytes( selectedBytes )}`}
					</span>
					<Button onClick={() => load( [ ...picked ] )} disabled={loading || picked.size === 0}>
						{loading ? "Loading…" : "Load selection"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

};

export default ArchiveElementDialog;
