import { Loader2 } from 'lucide-react';
import { useCallback } from 'react';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const ImportUrlModal = ( {
	isOpen,
	onClose,
	importUrl,
	setImportUrl,
	onImport,
	isImporting
} ) => {

	// Memoized URL input change handler
	const handleUrlChange = useCallback( ( e ) => {

		setImportUrl( e.target.value );

	}, [ setImportUrl ] );

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Open from URL</DialogTitle>
					<DialogDescription>
	                    A link to a .glb or .gltf file, or to a scene archive (.zip, .tar, .tar.gz).
					</DialogDescription>
				</DialogHeader>
				<Input
					value={importUrl}
					onChange={handleUrlChange}
					placeholder="https://…"
				/>
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={isImporting}>
	                    Cancel
					</Button>
					<Button onClick={onImport} disabled={isImporting}>
						{isImporting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
	                            Opening…
							</>
						) : (
							'Open'
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

};

export default ImportUrlModal;
