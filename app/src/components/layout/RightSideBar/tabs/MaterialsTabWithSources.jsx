import { useState, useEffect } from 'react';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAssetsStore } from '@/store';
import { useMaterialApplicator } from '@/hooks/useMaterialApplicator';
import { usePolyHavenMaterialApplicator } from '@/hooks/usePolyHavenMaterialApplicator';
import { PolyHavenService } from '@/services/PolyHavenService';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const MaterialsTabWithSources = () => {

	const { toast } = useToast();
	const { materials, selectedMaterial, setPolyHavenMaterials: setStorePolyHavenMaterials } = useAssetsStore();
	const { applyMaterial } = useMaterialApplicator();
	const { applyPolyHavenMaterial } = usePolyHavenMaterialApplicator();

	// Tab state
	const [ activeSourceTab, setActiveSourceTab ] = useState( 'current' );

	// PolyHaven state
	const [ polyHavenMaterials, setPolyHavenMaterials ] = useState( [] );
	const [ isLoadingPolyHaven, setIsLoadingPolyHaven ] = useState( false );
	const [ polyHavenError, setPolyHavenError ] = useState( null );
	const [ selectedPolyHavenMaterial, setSelectedPolyHavenMaterial ] = useState( null );
	const [ polyHavenResolution, setPolyHavenResolution ] = useState( '2k' );

	// Load PolyHaven materials when tab becomes active
	useEffect( () => {

		const loadPolyHavenMaterials = async () => {

			if ( activeSourceTab !== 'polyhaven' || polyHavenMaterials.length > 0 ) {

				return; // Don't load if not active or already loaded

			}

			setIsLoadingPolyHaven( true );
			setPolyHavenError( null );

			try {

				const materials = await PolyHavenService.fetchTextureMaterials(
					polyHavenResolution,
					null, // No category filter for now
					100 // Limit to 100 materials
				);

				setPolyHavenMaterials( materials );
				setStorePolyHavenMaterials( materials ); // Update the Zustand store as well

				toast( {
					title: "PolyHaven Materials Loaded",
					description: `Loaded ${materials.length} materials from PolyHaven`,
				} );

			} catch ( error ) {

				console.error( 'Error loading PolyHaven materials:', error );
				setPolyHavenError( error.message );

				toast( {
					title: "Error Loading PolyHaven Materials",
					description: error.message,
					variant: "destructive",
				} );

			} finally {

				setIsLoadingPolyHaven( false );

			}

		};

		loadPolyHavenMaterials();

	}, [ activeSourceTab, polyHavenResolution, polyHavenMaterials.length, toast, setStorePolyHavenMaterials ] );

	// Handle resolution change for PolyHaven
	const handlePolyHavenResolutionChange = ( newResolution ) => {

		setPolyHavenResolution( newResolution );
		setPolyHavenMaterials( [] ); // Clear materials to trigger reload
		setStorePolyHavenMaterials( [] ); // Clear store materials as well
		setSelectedPolyHavenMaterial( null );

	};

	const getMaterialValue = () => {

		return selectedMaterial !== null && selectedMaterial !== undefined ? selectedMaterial.toString() : null;

	};

	const getPolyHavenMaterialValue = () => {

		return selectedPolyHavenMaterial !== null && selectedPolyHavenMaterial !== undefined ? selectedPolyHavenMaterial.toString() : null;

	};

	const handlePolyHavenMaterialChange = ( value ) => {

		const materialIndex = parseInt( value );
		setSelectedPolyHavenMaterial( materialIndex );
		applyPolyHavenMaterial( value );

	};

	return (
		<div className="flex flex-col h-full">
			{/* Source tabs */}
			<Tabs
				value={activeSourceTab}
				onValueChange={setActiveSourceTab}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-2 h-auto p-0 mx-2 mb-2">
					<TabsTrigger value="current" className="text-xs py-2">
						Current Source
					</TabsTrigger>
					<TabsTrigger value="polyhaven" className="text-xs py-2">
						PolyHaven
					</TabsTrigger>
				</TabsList>

				{/* Current source materials */}
				<TabsContent value="current" className="flex-1 min-h-0 mx-2">
					<ItemsCatalog
						data={materials}
						value={getMaterialValue()}
						onValueChange={applyMaterial}
						catalogType="materials"
						className="h-full"
					/>
				</TabsContent>

				{/* PolyHaven materials */}
				<TabsContent value="polyhaven" className="flex-1 min-h-0 mx-2">
					<div className="flex flex-col h-full">
						{/* Resolution selector */}
						<div className="flex items-center justify-between p-2 shrink-0">
							<Select
								value={polyHavenResolution}
								onValueChange={handlePolyHavenResolutionChange}
							>
								<span className="opacity-50 text-xs truncate" title="The size of the images to download. Larger shows more detail up close but loads slower.">Resolution</span>
								<SelectTrigger className="max-w-24 h-5 rounded-full">
									<SelectValue placeholder="Select resolution" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="1k">1K</SelectItem>
									<SelectItem value="2k">2K</SelectItem>
									<SelectItem value="4k">4K</SelectItem>
									<SelectItem value="8k">8K</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{/* Materials catalog */}
						<div className="flex-1 min-h-0">
							<ItemsCatalog
								data={polyHavenMaterials}
								value={getPolyHavenMaterialValue()}
								onValueChange={handlePolyHavenMaterialChange}
								isLoading={isLoadingPolyHaven}
								error={polyHavenError}
								catalogType="materials"
								className="h-full"
							/>
						</div>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default MaterialsTabWithSources;
