import { useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssetsStore, useStore } from '@/store';
import { PolyHavenService, PolyHavenHDRIs } from '@/services/PolyHavenService';
import { EnvironmentService, FeaturedEnvironments } from '@/services/EnvironmentService';
import { useToast } from '@/hooks/use-toast';
import CatalogBrowser from './CatalogBrowser';

const HierarchicalEnvironmentsTab = () => {

	const { toast } = useToast();
	const { environment, setEnvironment } = useAssetsStore();
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );
	const [ polyHavenResolution, setPolyHavenResolution ] = useState( '1k' );

	// An id at startup, the loaded environment's data after.
	const currentKey = environment?.id ?? environment;

	const loadEnvironment = useCallback( async ( environmentData, fromPolyHaven ) => {

		const setLoading = useStore.getState().setLoading;

		try {

			let resolved = environmentData;
			let resolutionNote = '';
			if ( fromPolyHaven ) {

				setLoading( { isLoading: true, title: "Load", status: "Resolving HDRI URL...", progress: 25 } );
				const hdriFileInfo = await PolyHavenService.getAssetHDRIFile( environmentData.assetId, polyHavenResolution );
				resolved = {
					...environmentData,
					url: hdriFileInfo.url,
					actualResolution: hdriFileInfo.actualResolution,
					requestedResolution: hdriFileInfo.requestedResolution
				};
				if ( hdriFileInfo.actualResolution !== polyHavenResolution ) resolutionNote = ` (${hdriFileInfo.actualResolution} resolution used)`;

			}

			setLoading( { isLoading: true, title: "Load", status: "Loading Environment...", progress: fromPolyHaven ? 75 : 0 } );
			await EnvironmentService.loadEnvironment( resolved );
			setEnvironment( resolved );
			setLoading( { isLoading: false } );

			toast( {
				title: "Environment Loaded",
				description: `${resolved.name}${resolutionNote}`,
			} );

		} catch ( error ) {

			console.error( "Error loading environment:", error );
			setLoading( { isLoading: false } );

			toast( {
				title: "Error Loading Environment",
				description: error.message,
				variant: "destructive",
			} );

		}

	}, [ polyHavenResolution, setEnvironment, toast ] );

	const loadFeatured = useCallback( ( environmentData ) => loadEnvironment( environmentData, false ), [ loadEnvironment ] );
	const loadPolyHaven = useCallback( ( environmentData ) => loadEnvironment( environmentData, true ), [ loadEnvironment ] );

	return (
		<div className="flex flex-col h-full">
			<Tabs
				value={activeSourceTab}
				onValueChange={setActiveSourceTab}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border">
					<TabsTrigger value="current" className="text-xs rounded-full">
						Featured
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="text-xs rounded-full">
						PolyHaven
					</TabsTrigger>
				</TabsList>

				<TabsContent value="current" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser source={FeaturedEnvironments} onPick={loadFeatured} selectedKey={currentKey} />
				</TabsContent>

				<TabsContent value="polyhaven" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={PolyHavenHDRIs}
						variant={polyHavenResolution}
						onVariantChange={setPolyHavenResolution}
						onPick={loadPolyHaven}
						selectedKey={currentKey}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default HierarchicalEnvironmentsTab;
