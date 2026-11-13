import { useEffect, useCallback, useRef } from 'react';
import { initDatabase } from '@/lib/database';
import TopBar from './components/layout/TopBar/TopBar';
import LeftSidebar from '@/components/layout/LeftSideBar/LeftSidebar';
import ViewportArea from './components/layout/Viewports/ViewportArea';
import RightSidebar from './components/layout/RightSideBar/RightSidebar';
import { ThemeProvider } from "@/components/theme-provider";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useStore, useCameraStore } from '@/store';
import { getApp } from '@/lib/appProxy';
import { createLogger } from 'rayzee';
import { shortcutFor } from '@/lib/keyboardShortcuts';

const log = createLogger( 'app' );

const App = () => {

	// Memoized debounced resize handler to prevent recreation on every render
	const timeoutRef = useRef( null );
	const handleResize = useCallback( () => {

		if ( timeoutRef.current ) {

			clearTimeout( timeoutRef.current );

		}

		timeoutRef.current = setTimeout( () => {

			window.dispatchEvent( new Event( 'resize' ) );

		}, 500 );

	}, [] );

	useEffect( () => {

		const init = async () => {

		  try {

				await initDatabase();
				log.debug( 'database initialized' );

			} catch ( error ) {

				log.error( 'database initialization failed:', error );

			}

		};

		init();

	}, [] );

	// Global keyboard shortcuts
	useEffect( () => {

		const handleKeyDown = ( event ) => {

			// The gizmo mode has no keys: letters belong to walk mode.
			const action = shortcutFor( event, { appMode: useStore.getState().appMode } );
			if ( ! action ) return;
			event.preventDefault();
			if ( action === 'deselect' ) handleDeselect();
			else if ( action === 'resetCamera' ) useCameraStore.getState().handleResetCamera();
			else if ( action === 'playPause' ) handleTogglePlayPause();

		};

		// Keyboard shortcut handlers
		const handleDeselect = () => {

			const app = getApp();
			if ( app ) {

				// Deselect any selected object
				app.interactionManager.deselect();
				app.refreshFrame?.();

				// Update the store to reflect deselection
				const { setSelectedObject } = useStore.getState();
				setSelectedObject( null );

			}

		};

		const handleTogglePlayPause = () => {

			const app = getApp();
			if ( ! app || ! app.pathTracerEnabled ) return;

			const { setIsRendering } = useStore.getState();
			const renderComplete = app.isComplete();

			if ( renderComplete ) {

				// If rendering is complete, always restart
				app.pauseRendering = false;
				setIsRendering( true );
				app.reset();

			} else {

				// If rendering is in progress, toggle pause/resume
				const isCurrentlyPaused = app.pauseRendering;

				if ( isCurrentlyPaused ) {

					// Resume rendering from where it left off
					app.pauseRendering = false;
					setIsRendering( true );

				} else {

					// Pause rendering
					app.pauseRendering = true;
					setIsRendering( false );

				}

			}

		};

		// Add event listener
		window.addEventListener( 'keydown', handleKeyDown );

		// Cleanup
		return () => {

			window.removeEventListener( 'keydown', handleKeyDown );

		};

	}, [] );

	return (
		<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
			<div className="flex flex-col w-screen h-screen">
				<TopBar />
				<ResizablePanelGroup direction="horizontal" className="flex flex-1 overflow-hidden h-full">
					<ResizablePanel onResize={handleResize} className="min-w-50" defaultSize={20}>
						<LeftSidebar />
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel className="min-w-50" defaultSize={60}>
						<ViewportArea />
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel onResize={handleResize} className="min-w-50 h-full" defaultSize={20}>
						<RightSidebar />
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</ThemeProvider>
	);

};

export default App;
