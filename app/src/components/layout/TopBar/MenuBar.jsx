import { useRef, useSyncExternalStore } from "react";
import { Group, Vector3 } from 'three';
import { Volume, VolumeGrid } from 'rayzee';
import { useToast } from "@/hooks/use-toast";
import { getApp } from '@/lib/appProxy';
import { useStore, useCameraStore, useLightStore } from '@/store';
import { pickFolder, loadFolder } from '@/lib/folders';
import { spillNote } from '@/lib/storage';
import { REPO_URL, docsUrl } from '@/lib/help';
import { appVersion } from '@/lib/version';
import {
	Menubar,
	MenubarContent,
	MenubarItem,
	MenubarMenu,
	MenubarSeparator,
	MenubarShortcut,
	MenubarTrigger,
} from "@/components/ui/menubar";


// Files a model comes with (buffers, materials, textures), opened together with it as a folder would be.
const MODEL_PARTS = [ '.bin', '.mtl', '.ktx2', '.tga', '.bmp', '.gif', '.tif', '.tiff', '.avif' ];

// What Open… offers: whatever the engine reads, projects, and a model's parts.
function openableTypes( app ) {

	const formats = Object.keys( app.assetLoader.getSupportedFormats() ).map( extension => `.${extension}` );
	return [ ...formats, '.rayzee', ...MODEL_PARTS ].join( ',' );

}

const REPORT_URL = `${REPO_URL}/issues/new?template=bug_report.yml&context=${encodeURIComponent( `Rayzee ${appVersion}` )}`;

const LIGHTS = [
	{ type: 'DirectionalLight', label: 'Directional Light' },
	{ type: 'PointLight', label: 'Point Light' },
	{ type: 'SpotLight', label: 'Spot Light' },
	{ type: 'RectAreaLight', label: 'Area Light' },
];

// A new light opens the Light tab, where it is selected.
function addLight( type ) {

	useLightStore.getState().addLight( type );
	useStore.getState().setActiveTab( 'light' );

}

const watchFullScreen = ( onChange ) => {

	document.addEventListener( 'fullscreenchange', onChange );
	return () => document.removeEventListener( 'fullscreenchange', onChange );

};

const isFullScreen = () => !! document.fullscreenElement;

function toggleFullScreen() {

	const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
	change?.catch( () => {} );

}

// A menu item that is a link, so it opens in a new tab and can be copied.
const HelpLink = ( { href, children } ) => (
	<MenubarItem asChild>
		<a href={href} target="_blank" rel="noopener">{children}</a>
	</MenubarItem>
);

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
	const volume = new Volume( VolumeGrid.procedural( kind, { resolution: 96, seed: Math.floor( Math.random() * 2 ** 31 ) } ), {
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
	const { toast } = useToast();
	const onResults = useStore( state => state.appMode === 'results' );
	const fullScreen = useSyncExternalStore( watchFullScreen, isFullScreen );

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

	const handleExportRenders = async () => {

		try {

			const { exportRenders } = await import( '@/lib/renderArchive' );
			const count = await exportRenders();
			toast( { title: 'Saved renders exported', description: `${count} render${count === 1 ? '' : 's'} written to the zip.` } );

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
			toast( { title: 'Saved renders imported', description: `${added} added${skipped ? `, ${skipped} already here` : ''}.` } );

		} catch ( error ) {

			toast( { title: 'Import failed', description: error.message, variant: 'destructive' } );

		}

	};

	const handleOpenFile = () => {

		const app = getApp();
		if ( ! app ) return;
		fileInputRef.current.accept = openableTypes( app );
		fileInputRef.current.click();

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

		const app = getApp();
		const format = app?.assetLoader.getFileFormat( file.name );
		if ( ! format ) {

			event.target.value = '';
			toast( {
				title: 'Cannot open this file',
				description: `Rayzee opens 3D models, scene archives (.zip, .tar), skies (.hdr, .exr, .pfm) and .rayzee projects. A model made of several files opens with all of them selected, or with Open Folder…`,
				variant: 'destructive',
			} );
			return;

		}

		try {

			// loadFile dispatches by format (model, archive, sky) and guards against a concurrent load.
			await app.loadFile( file );
			const note = spillNote( app );
			toast( {
				title: format.type === 'environment' || format.type === 'image' ? 'Sky loaded' : 'Model loaded',
				description: note ? `${file.name}.${note}` : file.name,
			} );

		} catch ( error ) {

			if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' ) {

				useStore.getState().setArchivePrompt( {
					file, elements: error.elements, totalBytes: error.totalBytes
				} );

			} else toast( error?.code === 'LOAD_IN_PROGRESS'
				? {
					title: 'Still loading',
					description: 'Wait for the current load to finish, then open the file again.',
				}
				: {
					title: 'Could not open the file',
					description: ( error.message || 'The file did not load.' ) + ( file.name.toLowerCase().endsWith( '.gltf' )
						? ' — a .gltf that uses separate files opens with all of them selected, or with Open Folder…' : '' ),
					variant: 'destructive',
				} );

		} finally {

			// A sky's load reports progress but no end: cleared here, as a drop does.
			useStore.getState().resetLoading();
			// The same file can be picked again.
			event.target.value = '';

		}

	};

	return (
		<>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				onChange={handleFileSelect}
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
						<MenubarItem onSelect={handleOpenFile}>Open…</MenubarItem>
						<MenubarItem onSelect={handleOpenFolder}>Open Folder…</MenubarItem>
						<MenubarItem onSelect={onOpenImportModal}>Open from URL…</MenubarItem>
						<MenubarItem onSelect={onOpenRecent}>Open Recent…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={handleSaveProject}>Save Project…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={() => useStore.getState().setExportRequest( { tab: 'picture', from: 'live' } )}>Export Picture…</MenubarItem>
						<MenubarItem onSelect={() => useStore.getState().setExportRequest( { tab: 'video', from: 'live' } )}>Export Video…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={handleExportRenders}>Export Saved Renders…</MenubarItem>
						<MenubarItem onSelect={() => rendersInputRef.current?.click()}>Import Saved Renders…</MenubarItem>
						<MenubarSeparator />
						<MenubarItem onSelect={onOpenStorage}>Storage…</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>Add</MenubarTrigger>
					<MenubarContent>
						{LIGHTS.map( ( { type, label } ) => (
							<MenubarItem key={type} disabled={onResults} onSelect={() => addLight( type )}>{label}</MenubarItem>
						) )}
						<MenubarSeparator />
						<MenubarItem disabled={onResults} onSelect={() => addVolume( 'cloud' )}>Cloud</MenubarItem>
						<MenubarItem disabled={onResults} onSelect={() => addVolume( 'smoke' )}>Smoke</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>View</MenubarTrigger>
					<MenubarContent>
						<MenubarItem disabled={onResults} onSelect={() => useCameraStore.getState().handleResetCamera()}>
							Reset Camera<MenubarShortcut>R</MenubarShortcut>
						</MenubarItem>
						<MenubarItem onSelect={toggleFullScreen}>{fullScreen ? 'Exit Full Screen' : 'Enter Full Screen'}</MenubarItem>
					</MenubarContent>
				</MenubarMenu>

				<MenubarMenu>
					<MenubarTrigger>Help</MenubarTrigger>
					<MenubarContent>
						<HelpLink href={docsUrl( 'app/' )}>User Guide</HelpLink>
						<HelpLink href={docsUrl( 'app/controls' )}>Keyboard and Mouse</HelpLink>
						<HelpLink href={docsUrl( 'app/troubleshooting' )}>Troubleshooting</HelpLink>
						<MenubarSeparator />
						<HelpLink href={docsUrl( 'guide/getting-started' )}>Developer Guide</HelpLink>
						<HelpLink href={REPO_URL}>Source Code</HelpLink>
						<MenubarSeparator />
						<HelpLink href={`${REPO_URL}/releases`}>Release Notes</HelpLink>
						<HelpLink href={REPORT_URL}>Report a Problem</HelpLink>
						<MenubarSeparator />
						<p className="control-hint px-2 py-1">Rayzee {appVersion}</p>
					</MenubarContent>
				</MenubarMenu>
			</Menubar>
		</>
	);

};

export default MenuBar;
