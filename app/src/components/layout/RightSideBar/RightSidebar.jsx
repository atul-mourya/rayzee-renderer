import { useMemo, memo, lazy, Suspense } from 'react';
import { Sliders, Camera, Box, Sun, SwatchBook, Blend, PocketKnife, Bot, Film } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from '@/store';
import FinalRenderPanel from './FinalRenderPanel';

// Lazy load tab components for better initial performance
const CameraTab = lazy( () => import( './CameraTab' ) );
const LightsTab = lazy( () => import( './LightsTab' ) );
const AssetsTab = lazy( () => import( './AssetsTab' ) );
const PathTracerTab = lazy( () => import( './PathTracerTab' ) );
const MaterialTab = lazy( () => import( './MaterialTab' ) );
const AnimationTab = lazy( () => import( './AnimationTab' ) );
const ColorCorrectionsTab = lazy( () => import( './ColorCorrectionsTab' ) );
const AITab = lazy( () => import( './AITab' ) );
const ToolTab = lazy( () => import( './ToolTab' ) );
const FiltersTab = lazy( () => import( './FiltersTab' ) );

// Loading fallback component
const TabLoadingFallback = () => (
	<div className="flex items-center justify-center h-32">
		<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
	</div>
);

// Memoized tab content components to prevent unnecessary re-renders

const InteractiveModeTabs = memo( () => {

	const activeTab = useStore( state => state.activeTab );
	const setActiveTab = useStore( state => state.setActiveTab );
	return (
		<Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full w-full">
			<TabsList variant="bar" className="grid-cols-6">
				<TabsTrigger value="pathtracer">
					<Sliders size={12} />
					<span className="text-xs mt-1">Tracer</span>
				</TabsTrigger>
				<TabsTrigger value="camera">
					<Camera size={12} />
					<span className="text-xs mt-1">Camera</span>
				</TabsTrigger>
				<TabsTrigger value="light">
					<Sun size={12} />
					<span className="text-xs mt-1">Light</span>
				</TabsTrigger>
				<TabsTrigger value="material">
					<SwatchBook size={12} />
					<span className="text-xs mt-1">Material</span>
				</TabsTrigger>
				<TabsTrigger value="animation">
					<Film size={12} />
					<span className="text-xs mt-1">Anim</span>
				</TabsTrigger>
				<TabsTrigger value="assets">
					<Box size={12} />
					<span className="text-xs mt-1">Assets</span>
				</TabsTrigger>
			</TabsList>

			<TabsContent value="camera" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<CameraTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<PathTracerTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="light" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<LightsTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="material" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<MaterialTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="animation" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<AnimationTab />
				</Suspense>
			</TabsContent>

			<TabsContent value="assets" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
				<Suspense fallback={<TabLoadingFallback />}>
					<AssetsTab />
				</Suspense>
			</TabsContent>
		</Tabs>
	);

} );

InteractiveModeTabs.displayName = 'InteractiveModeTabs';

const FinalRenderModeTabs = memo( () => (
	<div className="flex flex-col h-full w-full">
		<FinalRenderPanel />
	</div>
) );

FinalRenderModeTabs.displayName = 'FinalRenderModeTabs';

const ResultsModeTabs = memo( () => (
	<Tabs defaultValue="pathtracer" className="flex flex-col h-full w-full">
		<TabsList variant="bar" className="grid-cols-4">
			<TabsTrigger value="pathtracer">
				<Sliders size={12} />
				<span className="text-xs mt-1">Adjust</span>
			</TabsTrigger>
			<TabsTrigger value="tool">
				<PocketKnife size={12} />
				<span className="text-xs mt-1">Tool</span>
			</TabsTrigger>
			<TabsTrigger value="ai">
				<Bot size={12} />
				<span className="text-xs mt-1">AI</span>
			</TabsTrigger>
			<TabsTrigger value="filters">
				<Blend size={12} />
				<span className="text-xs mt-1">Filters</span>
			</TabsTrigger>
		</TabsList>

		<TabsContent value="pathtracer" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<ColorCorrectionsTab />
			</Suspense>
		</TabsContent>

		<TabsContent value="tool" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<ToolTab />
			</Suspense>
		</TabsContent>

		<TabsContent value="ai" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<AITab />
			</Suspense>
		</TabsContent>

		<TabsContent value="filters" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col overflow-y-auto mt-0">
			<Suspense fallback={<TabLoadingFallback />}>
				<FiltersTab />
			</Suspense>
		</TabsContent>
	</Tabs>
) );

ResultsModeTabs.displayName = 'ResultsModeTabs';

// Main RightSidebar component
const RightSidebar = () => {

	const appMode = useStore( state => state.appMode );

	// Use useMemo to determine which component to render based on appMode
	const currentModeComponent = useMemo( () => {

		switch ( appMode ) {

			case 'preview':
				return <InteractiveModeTabs />;
			case 'results':
				return <ResultsModeTabs />;
			default: // 'final-render'
				return <FinalRenderModeTabs />;

		}

	}, [ appMode ] );

	return (
		<div className="relative border-l flex flex-col overflow-hidden h-full w-full">
			{currentModeComponent}
		</div>
	);

};

// Export a memoized version of the component to prevent unnecessary re-renders
export default memo( RightSidebar );
