import { useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { getApp } from '@/lib/appProxy';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";

const MenuBar = ( { onOpenImportModal } ) => {

	const fileInputRef = useRef( null );
	const { toast } = useToast();

	const handleOpenFile = () => {

		fileInputRef.current?.click();

	};

	const handleFileSelect = async ( event ) => {

		const file = event.target.files?.[ 0 ];
		if ( ! file ) return;

		// Validate file type
		const supportedFormats = [ '.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply', '.dae', '.3mf', '.usd', '.usda', '.usdc', '.usdz', '.zip' ];
		const fileName = file.name.toLowerCase();
		const isSupported = supportedFormats.some( format => fileName.endsWith( format ) );

		if ( ! isSupported ) {

			toast( {
				title: "Invalid File Type",
				description: "Please select a supported 3D model file (.glb, .gltf, .fbx, .obj, .stl, .ply, .dae, .3mf, .usd, .usda, .usdc, .usdz) or a .zip (incl. pbrt scenes)",
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

			toast( error?.code === 'LOAD_IN_PROGRESS'
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
				accept=".glb,.gltf,.fbx,.obj,.stl,.ply,.dae,.3mf,.usd,.usda,.usdc,.usdz,.zip"
				onChange={handleFileSelect}
				style={{ display: 'none' }}
			/>
			<Menubar className="h-full border-none bg-none p-0 shadow-none">
				<MenubarMenu>
					<MenubarTrigger className="text-muted-foreground text-sm font-medium hover:text-foreground">File</MenubarTrigger>
					<MenubarContent>
						<MenubarItem onSelect={handleOpenFile} className="flex items-center">Open</MenubarItem>
						<MenubarItem onSelect={onOpenImportModal} className="flex items-center">Import from URL</MenubarItem>
						<MenubarItem disabled className="flex items-center">Save</MenubarItem>
						<MenubarSeparator />
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
