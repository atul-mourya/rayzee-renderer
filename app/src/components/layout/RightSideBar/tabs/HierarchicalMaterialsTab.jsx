import { useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStore, useCameraStore, modelSizeMetres } from '@/store';
import { usePolyHavenMaterialApplicator } from '@/hooks/usePolyHavenMaterialApplicator';
import { PolyHavenTextures } from '@/services/PolyHavenService';
import { PhysicallyBasedMaterials } from '@/services/AssetLoaderService';
import { MaterialXMaterials, applyLibraryMaterial } from '@/services/MaterialXLibrary';
import { useToast } from '@/hooks/use-toast';
import { startMaterialDrag, endMaterialDrag, SEVERAL_MATERIALS } from '@/lib/materialDrop';
import CatalogBrowser from './CatalogBrowser';

const MATERIALX_NOTICE = (
	<>
		Materials from <a className="underline" href="https://matlib.gpuopen.com" target="_blank" rel="noopener noreferrer">AMD&apos;s MaterialX Library</a>, MIT licence.
	</>
);

const HierarchicalMaterialsTab = () => {

	const { toast } = useToast();
	const { applyPolyHavenMaterial } = usePolyHavenMaterialApplicator();
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );
	const [ polyHavenResolution, setPolyHavenResolution ] = useState( '1k' );
	const [ materialXSize, setMaterialXSize ] = useState( '1k' );

	const applyPolyHaven = useCallback( ( material, target ) => {

		return applyPolyHavenMaterial( { ...material, targetResolution: polyHavenResolution }, target );

	}, [ applyPolyHavenMaterial, polyHavenResolution ] );

	// Onto `target`, the selected object unless given (a material dropped on the view).
	const applyPhysicallyBased = useCallback( async ( materialData, target = useStore.getState().selectedObject ) => {

		const setLoading = useStore.getState().setLoading;

		if ( ! target ) {

			toast( {
				title: "No Object Selected",
				description: "Please select an object to apply material to",
				variant: "destructive",
			} );
			return;

		}

		if ( ! target.material ) {

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
			MaterialService.applyMaterialToObject( materialData, target.material, MaterialService.diagonalOf( target ) );
			MaterialService.updatePathTracerMaterial( target );
			window.dispatchEvent( new Event( 'MaterialUpdate' ) );

			setLoading( { isLoading: false } );

			// Light goes as far into a translucent one as into the real thing, so how it looks depends on the model's size.
			const size = Array.isArray( materialData.subsurfaceRadius ) ? modelSizeMetres( useCameraStore.getState() ) : null;
			toast( {
				title: "Material Applied",
				description: size
					? `${materialData.name}: light goes as far in as in the real thing, for a model of ${size} m. If that size is wrong, set the real one in Camera → Depth of Field → Pro → Subject Size.`
					: materialData.name,
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

	// A MaterialX document and its textures, downloaded and read as a dropped file is.
	const applyMaterialX = useCallback( async ( item, target = useStore.getState().selectedObject ) => {

		const setLoading = useStore.getState().setLoading;
		if ( ! target?.material ) {

			toast( { title: "No Object Selected", description: "Please select an object to apply material to", variant: "destructive" } );
			return;

		}

		if ( Array.isArray( target.material ) ) {

			toast( { title: "Not Applied", description: SEVERAL_MATERIALS, variant: "destructive" } );
			return;

		}

		setLoading( { isLoading: true, title: "Apply", status: `Downloading ${item.name}...`, progress: 0 } );
		try {

			await applyLibraryMaterial( item, materialXSize, target );
			setLoading( { isLoading: false } );
			toast( { title: "Material Applied", description: item.name } );

		} catch ( error ) {

			console.error( "Error applying MaterialX material:", error );
			setLoading( { isLoading: false } );
			toast( { title: "Error Applying Material", description: error.message, variant: "destructive" } );

		}

	}, [ toast, materialXSize ] );

	return (
		<div className="flex flex-col h-full">
			<Tabs
				value={activeSourceTab}
				onValueChange={setActiveSourceTab}
				className="flex flex-col h-full"
			>
				{/* Three labels share a narrow panel: each pill as wide as its label, with less padding. */}
				<TabsList variant="pills" className="grid-cols-[auto_auto_auto]">
					<TabsTrigger value="current" className="px-1.5">
						Physically Based
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="px-1.5">
						PolyHaven
					</TabsTrigger>
					<TabsTrigger value="materialx" className="px-1.5">
						MaterialX
					</TabsTrigger>
				</TabsList>

				<TabsContent value="current" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={PhysicallyBasedMaterials}
						onPick={applyPhysicallyBased}
						onItemDragStart={( e, item ) => startMaterialDrag( e, item, applyPhysicallyBased )}
						onItemDragEnd={endMaterialDrag}
					/>
				</TabsContent>

				<TabsContent value="polyhaven" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={PolyHavenTextures}
						variant={polyHavenResolution}
						onVariantChange={setPolyHavenResolution}
						onPick={applyPolyHaven}
						onItemDragStart={( e, item ) => startMaterialDrag( e, item, applyPolyHaven )}
						onItemDragEnd={endMaterialDrag}
					/>
				</TabsContent>

				<TabsContent value="materialx" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={MaterialXMaterials}
						notice={MATERIALX_NOTICE}
						variant={materialXSize}
						onVariantChange={setMaterialXSize}
						onPick={applyMaterialX}
						onItemDragStart={( e, item ) => startMaterialDrag( e, item, applyMaterialX )}
						onItemDragEnd={endMaterialDrag}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default HierarchicalMaterialsTab;
