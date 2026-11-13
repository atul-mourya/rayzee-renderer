import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssetsStore } from '@/store';
import { lazy, Suspense } from 'react';

// Lazy load heavy catalog components for better performance
const ModelsTab = lazy( () => import( './tabs/ModelsTab' ) );
const HierarchicalMaterialsTab = lazy( () => import( './tabs/HierarchicalMaterialsTab' ) );
const HierarchicalEnvironmentsTab = lazy( () => import( './tabs/HierarchicalEnvironmentsTab' ) );
const TestsTab = lazy( () => import( './tabs/TestsTab' ) );

// Loading fallback for sub-tabs
const SubTabLoadingFallback = () => (
	<div className="flex items-center justify-center h-40">
		<div className="flex flex-col items-center space-y-3">
			<div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full"></div>
			<span className="text-xs text-muted-foreground">Loading catalog...</span>
		</div>
	</div>
);

const AssetsTab = () => {

	const { activeTab, setActiveTab } = useAssetsStore();

	return (
		<div className="absolute h-[calc(100%-48px)] w-full">
			<Separator className="bg-primary" />
			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex flex-col h-full w-full"
			>
				<TabsList variant="compact" className="relative grid w-full grid-cols-4 h-auto p-0">
					<TabsTrigger value="models">
                        Models
					</TabsTrigger>
					<TabsTrigger value="materials">
                        Materials
					</TabsTrigger>
					<TabsTrigger value="environments">
                        Env
					</TabsTrigger>
					<TabsTrigger value="tests">
                        Tests
					</TabsTrigger>
				</TabsList>
				<TabsContent value="models" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<Suspense fallback={<SubTabLoadingFallback />}>
						<ModelsTab />
					</Suspense>
				</TabsContent>
				<TabsContent value="materials" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<Suspense fallback={<SubTabLoadingFallback />}>
						<HierarchicalMaterialsTab />
					</Suspense>
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<Suspense fallback={<SubTabLoadingFallback />}>
						<HierarchicalEnvironmentsTab />
					</Suspense>
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<Suspense fallback={<SubTabLoadingFallback />}>
						<TestsTab />
					</Suspense>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
