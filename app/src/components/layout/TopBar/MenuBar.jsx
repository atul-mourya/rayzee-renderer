import { useRef } from "react";
import { Group, Vector3 } from 'three';
import { Volume, VolumeGrid } from 'rayzee';
import { useToast } from "@/hooks/use-toast";
import { getApp } from '@/lib/appProxy';
import { useStore } from '@/store';
import { pickFolder, loadFolder } from '@/lib/folders';
import { spillNote } from '@/lib/storage';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarTrigger,
} from "@/components/ui/menubar";

let volumeSeed = 0;

// Where the camera looks, sized to the view: smoke a third of the way back toward the camera (in front of what is looked
// at), a cloud above it.
async function addVolume( kind ) {

	const app = getApp();
	if ( ! app ) return;
	const camera = app.camera.position;
	const target = app.cameraManager?.controls?.target?.clone() ?? camera.clone().add( app.camera.getWorldDirection( new Vector3() ).multiplyScalar( 4 ) );
	const distance = Math.max( camera.distanceTo( target ), 0.1 );
	const cloud = kind === 'cloud';
	const size = distance * ( cloud ? 0.8 : 0.6 );
	const volume = new Volume( VolumeGrid.procedural( kind, { resolution: 96, seed: ++ volumeSeed } ), {
		density: ( cloud ? 40 : 20 ) / size, color: cloud ? 0xffffff : 0xc0c0c0, anisotropy: cloud ? 0.5 : 0.3,
	} );
	volume.name = cloud ? 'Cloud' : 'Smoke';
	volume.scale.setScalar( size );
	if ( cloud ) volume.position.copy( target ).add( new Vector3( 0, size * 0.6, 0 ) );
	else volume.position.copy( target ).lerp( camera, 1 / 3 );
	await app.addModelFromObject3D( new Group().add( volume ), { name: volume.name } );

}

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
			const { title, embedded, tooLarge, folder } = await saveProject( app );
			const what = folder ? 'model folder' : 'model file';
			toast( {
				title: 'Project saved',
				description: tooLarge
					? `${title} is saved without its model, which is too large to include here — keep the ${what} with it.`
					: embedded ? `${title}, with its ${what} inside.` : title,
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

	const handleOpenFolder = async () => {

		try {

			const picked = await pickFolder();
			if ( picked ) await loadFolder( await picked.read(), { handle: picked.handle } );

		} catch ( error ) {

			useStore.getState().resetLoading();
			toast( { title: 'Could not open the folder', description: error.message, variant: 'destructive' } );

		}

	};

	const handleFileSelect = async ( event ) => {

		const files = [ ...( event.target.files ?? [] ) ];
		if ( files.length > 1 ) {

			event.target.value = '';
			await loadFolder( { files } );
			return;

		}

		const file = files[ 0 ];
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
				description: "Please select a supported 3D model file (.glb, .gltf, .fbx, .obj, .stl, .ply, .dae, .3mf, .usd, .usda, .usdc, .usdz) or an archive: .zip, .tar, .tar.gz, .tgz (incl. pbrt scenes). A model made of several files opens with all of them selected, or from File → Open Folder…",
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

				const note = spillNote( app );
				toast( {
					title: "Model Loaded",
					description: `Successfully loaded ${file.name}${note ? `.${note}` : ''}`,
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
					description: ( error.message || "Failed to load model" ) + ( fileName.endsWith( '.gltf' )
						? ' — a .gltf that uses separate files opens with all of them selected, or from File → Open Folder…' : '' ),
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
				accept=".glb,.gltf,.fbx,.obj,.stl,.ply,.dae,.3mf,.usd,.usda,.usdc,.usdz,.vdb,.zip,.tar,.tgz,.gz,.rayzee,.bin,.mtl,.png,.jpg,.jpeg,.webp,.avif,.ktx2,.tga,.bmp,.gif,.tif,.tiff"
				multiple
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
			<Menubar>
				<MenubarMenu>
					<MenubarTrigger>File</MenubarTrigger>
					<MenubarContent>
						<MenubarItem onSelect={handleOpenFile}>Open</MenubarItem>
						<MenubarItem onSelect={handleOpenFolder}>Open Folder…</MenubarItem>
						<MenubarItem onSelect={onOpenImportModal}>Import from URL</MenubarItem>
						<MenubarItem onSelect={onOpenRecent}>Open Recent…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={() => projectInputRef.current?.click()}>Open Project…</MenubarItem>
						<MenubarItem onSelect={handleSaveProject}>Save Project…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={() => useStore.getState().setExportRequest( { tab: 'picture', from: 'live' } )}>Export Picture…</MenubarItem>
						<MenubarItem onSelect={() => useStore.getState().setExportRequest( { tab: 'video', from: 'live' } )}>Export Video…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={handleExportRenders}>Export Renders…</MenubarItem>
						<MenubarItem onSelect={() => rendersInputRef.current?.click()}>Import Renders…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={onOpenStorage}>Storage…</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>Add</MenubarTrigger>
					<MenubarContent>
						<MenubarItem onSelect={() => addVolume( 'cloud' )}>Cloud</MenubarItem>
						<MenubarItem onSelect={() => addVolume( 'smoke' )}>Smoke</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>Edit</MenubarTrigger>
					<MenubarContent>
						<MenubarItem disabled>Undo</MenubarItem>
						<MenubarItem disabled>Redo</MenubarItem>
						<MenubarSeparator />
						<MenubarItem disabled>Copy</MenubarItem>
						<MenubarItem disabled>Paste</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>View</MenubarTrigger>
					<MenubarContent>
						<MenubarItem disabled>Zoom In</MenubarItem>
						<MenubarItem disabled>Zoom Out</MenubarItem>
						<MenubarItem disabled>Reset View</MenubarItem>
					</MenubarContent>
				</MenubarMenu>
			</Menubar>
		</>
	);

};

export default MenuBar;
