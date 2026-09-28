import { useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { getApp } from '@/lib/appProxy';
import { useStore } from '@/store';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";

const MenuBar = ( { onOpenImportModal, onOpenStorage, onOpenRecent } ) => {

	const fileInputRef = useRef( null );
	const rendersInputRef = useRef( null );
	const projectInputRef = useRef( null );
	const { toast } = useToast();

	const handleSaveProject = async () => {

		const app = getApp();
		if ( ! app?.sceneSource ) return;

		try {

			const { saveProject } = await import( '@/lib/project' );
			const { title, embedded, tooLarge } = await saveProject( app );
			toast( {
				title: 'Project saved',
				description: tooLarge
					? `${title} is saved without its model, which is too large to include here — keep the model file with it.`
					: embedded ? `${title}, with its model file inside.` : title,
			} );

		} catch ( error ) {

			if ( error?.name === 'AbortError' ) return;
			toast( { title: 'Could not save the project', description: error.message, variant: 'destructive' } );

		}

	};

	const openProject = async ( file ) => {

		try {

			const { requestProjectOpen } = await import( '@/lib/project' );
			await requestProjectOpen( file );

		} catch ( error ) {

			toast( { title: 'Could not open the project', description: error.message, variant: 'destructive' } );

		}

	};

	const handleProjectSelect = async ( event ) => {

		const file = event.target.files?.[ 0 ];
		event.target.value = '';
		if ( file ) await openProject( file );

	};

	const handleExportRenders = async () => {

		try {

			const { exportRenders } = await import( '@/lib/renderArchive' );
			const count = await exportRenders();
			toast( { title: 'Renders exported', description: `${count} render${count === 1 ? '' : 's'} written to the zip.` } );

		} catch ( error ) {

			if ( error?.name === 'AbortError' ) return;
			toast( { title: 'Export failed', description: error.message, variant: 'destructive' } );

		}

	};

	const handleImportRenders = async ( event ) => {

		const file = event.target.files?.[ 0 ];
		event.target.value = '';
		if ( ! file ) return;

		try {

			const { importRenders } = await import( '@/lib/renderArchive' );
			const { added, skipped } = await importRenders( file );
			toast( { title: 'Renders imported', description: `${added} added${skipped ? `, ${skipped} already here` : ''}.` } );

		} catch ( error ) {

			toast( { title: 'Import failed', description: error.message, variant: 'destructive' } );

		}

	};

	const handleOpenFile = () => {

		fileInputRef.current?.click();

	};

	const handleFileSelect = async ( event ) => {

		const file = event.target.files?.[ 0 ];
		if ( ! file ) return;

		if ( file.name.toLowerCase().endsWith( '.rayzee' ) ) {

			event.target.value = '';
			await openProject( file );
			return;

		}

		// Validate file type
		const supportedFormats = [ '.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply', '.dae', '.3mf', '.usd', '.usda', '.usdc', '.usdz', '.zip', '.tar', '.tgz', '.tar.gz', '.gz' ];
		const fileName = file.name.toLowerCase();
		const isSupported = supportedFormats.some( format => fileName.endsWith( format ) );

		if ( ! isSupported ) {

			toast( {
				title: "Invalid File Type",
				description: "Please select a supported 3D model file (.glb, .gltf, .fbx, .obj, .stl, .ply, .dae, .3mf, .usd, .usda, .usdc, .usdz) or an archive: .zip, .tar, .tar.gz, .tgz (incl. pbrt scenes)",
				variant: "destructive",
			} );
			return;

		}

		try {

			// loadFile dispatches by format (model / archive / environment), so the UI
			// doesn't branch on extension — .zip (OBJ/MTL, pbrt) and direct models all
			// route from one entry point, guarded against a concurrent load.
			const app = getApp();
			if ( app ) {

				await app.loadFile( file );

				toast( {
					title: "Model Loaded",
					description: `Successfully loaded ${file.name}`,
				} );

			} else {

				throw new Error( "PathTracer app not initialized" );

			}

		} catch ( error ) {

			if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' ) {

				useStore.getState().setArchivePrompt( {
					file, elements: error.elements, totalBytes: error.totalBytes
				} );

			} else toast( error?.code === 'LOAD_IN_PROGRESS'
				? {
					title: "Still Loading",
					description: "Wait for the current load to finish, then open the file again.",
				}
				: {
					title: "Error Loading Model",
					description: error.message || "Failed to load model",
					variant: "destructive",
				} );

		} finally {

			// Reset the input so the same file can be selected again
			event.target.value = '';

		}

	};

	return (
		<>
			<input
				ref={fileInputRef}
				type="file"
				accept=".glb,.gltf,.fbx,.obj,.stl,.ply,.dae,.3mf,.usd,.usda,.usdc,.usdz,.zip,.tar,.tgz,.gz,.rayzee"
				onChange={handleFileSelect}
				style={{ display: 'none' }}
			/>
			<input
				ref={projectInputRef}
				type="file"
				accept=".rayzee"
				onChange={handleProjectSelect}
				style={{ display: 'none' }}
			/>
			<input
				ref={rendersInputRef}
				type="file"
				accept=".zip"
				onChange={handleImportRenders}
				style={{ display: 'none' }}
			/>
			<Menubar className="h-full border-none bg-none p-0 shadow-none">
				<MenubarMenu>
					<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">File</MenubarTrigger>
					<MenubarContent>
						<MenubarItem onSelect={handleOpenFile} className="flex items-center">Open</MenubarItem>
						<MenubarItem onSelect={onOpenImportModal} className="flex items-center">Import from URL</MenubarItem>
						<MenubarItem onSelect={onOpenRecent} className="flex items-center">Open Recent…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={() => projectInputRef.current?.click()} className="flex items-center">Open Project…</MenubarItem>
						<MenubarItem onSelect={handleSaveProject} className="flex items-center">Save Project…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={handleExportRenders} className="flex items-center">Export Renders…</MenubarItem>
						<MenubarItem onSelect={() => rendersInputRef.current?.click()} className="flex items-center">Import Renders…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={onOpenStorage} className="flex items-center">Storage…</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">Edit</MenubarTrigger>
					<MenubarContent>
						<MenubarItem disabled className="flex items-center">Undo</MenubarItem>
						<MenubarItem disabled className="flex items-center">Redo</MenubarItem>
						<MenubarSeparator />
						<MenubarItem disabled className="flex items-center">Copy</MenubarItem>
						<MenubarItem disabled className="flex items-center">Paste</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">View</MenubarTrigger>
					<MenubarContent>
						<MenubarItem disabled className="flex items-center">Zoom In</MenubarItem>
						<MenubarItem disabled className="flex items-center">Zoom Out</MenubarItem>
						<MenubarItem disabled className="flex items-center">Reset View</MenubarItem>
					</MenubarContent>
				</MenubarMenu>
			</Menubar>
		</>
	);

};

export default MenuBar;
