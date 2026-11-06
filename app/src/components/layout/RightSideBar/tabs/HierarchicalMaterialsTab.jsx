import { useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore } from '@/store';
import { usePolyHavenMaterialApplicator } from '@/hooks/usePolyHavenMaterialApplicator';
import { PolyHavenTextures } from '@/services/PolyHavenService';
import { PhysicallyBasedMaterials } from '@/services/AssetLoaderService';
import { useToast } from '@/hooks/use-toast';
import CatalogBrowser from './CatalogBrowser';

const HierarchicalMaterialsTab = () => {

	const { toast } = useToast();
	const { applyPolyHavenMaterial } = usePolyHavenMaterialApplicator();
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );
	const [ polyHavenResolution, setPolyHavenResolution ] = useState( '1k' );

	const applyPolyHaven = useCallback( ( material ) => {

		applyPolyHavenMaterial( { ...material, targetResolution: polyHavenResolution } );

	}, [ applyPolyHavenMaterial, polyHavenResolution ] );

	const applyPhysicallyBased = useCallback( async ( materialData ) => {

		const selectedObject = useStore.getState().selectedObject;
		const setLoading = useStore.getState().setLoading;

		if ( ! selectedObject ) {

			toast( {
				title: "No Object Selected",
				description: "Please select an object to apply material to",
				variant: "destructive",
			} );
			return;

		}

		if ( ! selectedObject.material ) {

			toast( {
				title: "Invalid Object",
				description: "The selected object doesn't have a material property",
				variant: "destructive",
			} );
			return;

		}

		setLoading( {
			isLoading: true,
			title: "Apply",
			status: "Processing Material...",
			progress: 0
		} );

		try {

			const { MaterialService } = await import( '@/services/MaterialService' );
			MaterialService.applyMaterialToObject( materialData, selectedObject.material );
			MaterialService.updatePathTracerMaterial( selectedObject );

			setLoading( { isLoading: false } );

			toast( {
				title: "Material Applied",
				description: materialData.name,
			} );

		} catch ( error ) {

			console.error( "Error applying current source material:", error );
			setLoading( { isLoading: false } );

			toast( {
				title: "Error Applying Material",
				description: error.message,
				variant: "destructive",
			} );

		}

	}, [ toast ] );

	return (
		<div className="flex flex-col h-full">
			<Tabs
				value={activeSourceTab}
				onValueChange={setActiveSourceTab}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 border">
					<TabsTrigger value="current" className="text-xs rounded-full">
						Physically Based
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="text-xs rounded-full">
						PolyHaven
					</TabsTrigger>
				</TabsList>

				<TabsContent value="current" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser source={PhysicallyBasedMaterials} onPick={applyPhysicallyBased} />
				</TabsContent>

				<TabsContent value="polyhaven" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={PolyHavenTextures}
						variant={polyHavenResolution}
						onVariantChange={setPolyHavenResolution}
						onPick={applyPolyHaven}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default HierarchicalMaterialsTab;
