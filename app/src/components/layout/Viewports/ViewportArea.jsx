import { useRef, lazy, Suspense } from 'react';
import MainViewport from './MainViewport';
import RenderControls from './RenderControls';
import { useStore } from '@/store';

// Lazy load ResultsViewport as it's only needed when in results mode
const ResultsViewport = lazy( () => import( './ResultsViewport' ) );

// Loading fallback for viewport
const ViewportLoadingFallback = () => (
	<div className="w-full h-full flex items-center justify-center bg-background">
		<div className="flex flex-col items-center space-y-4">
			<div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full"></div>
			<span className="text-sm text-muted-foreground">Loading viewport...</span>
		</div>
	</div>
);

const ViewportArea = () => {

	const appMode = useStore( state => state.appMode );
	const mainViewportRef = useRef( null );
	const resultsViewportRef = useRef( null );

	// Show controls only in preview and final render modes
	const showControls = appMode === "preview" || appMode === "final-render";

	return (
		<div className="w-full h-full relative">
			{/* Keep MainViewport always in the DOM but hide it when on Results tab */}
			<div style={{ display: appMode !== "results" ? 'block' : 'none', width: '100%', height: '100%' }}>
				<MainViewport mode={appMode} ref={mainViewportRef} />
			</div>

			{/* Results viewport - only show when results tab is active */}
			{appMode === "results" && (
				<div style={{ width: '100%', height: '100%' }}>
					<Suspense fallback={<ViewportLoadingFallback />}>
						<ResultsViewport ref={resultsViewportRef} />
					</Suspense>
				</div>
			)}

			{/* Unity-style controls overlay - only shown in preview and final render modes */}
			{showControls && (
				<RenderControls />
			)}
		</div>
	);

};

export default ViewportArea;
