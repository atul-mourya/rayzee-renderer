import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { MODEL_FILES } from '@/Constants';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';
import { isArchiveUrl } from '@/lib/archives';
import { SketchfabService } from '@/services/SketchfabService';
import { AboService } from '@/services/AboService';
import ModelSourceBrowser from './ModelSourceBrowser';

const SKETCHFAB_NOTICE = SketchfabService.getToken() ? null : (
	<>Browse only — set <code className="text-[10px]">VITE_SKETCHFAB_TOKEN</code> to download models.</>
);

// CC BY 4.0 asks for the credit and a link to the licence.
const ABO_NOTICE = (
	<>
		Models © Amazon.com, from <a className="underline" href={AboService.SOURCE_URL} target="_blank" rel="noopener noreferrer">Amazon Berkeley Objects</a>,{' '}
		<a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.
	</>
);

const ModelsTab = () => {

	const { model, setModel, modelsSource, setModelsSource } = useAssetsStore();
	const { loadModel, loadModelUrl, addModel, appendCatalogModel } = useAssetLoader();

	// Featured catalog: each card offers Replace (swap the scene) and Add (append).
	const featuredActions = useMemo( () => [
		{
			key: 'replace',
			label: 'Replace',
			variant: 'default',
			onClick: async ( item ) => {

				const index = MODEL_FILES.indexOf( item );
				setModel( index );
				await loadModel( index.toString() );

			},
		},
		{
			key: 'add',
			label: 'Add',
			variant: 'secondary',
			icon: <Plus size={12} />,
			// Appending reads glTF only; a pbrt archive is a whole scene.
			disabled: ( item ) => isArchiveUrl( item.url ),
			onClick: async ( item ) => appendCatalogModel( MODEL_FILES.indexOf( item ).toString() ),
		},
	], [ loadModel, appendCatalogModel, setModel ] );

	// Ring highlights the replace-loaded base model (informational; Add doesn't change it).
	const modelValue = ( model !== null && model !== undefined ) ? model.toString() : null;

	return (
		<div className="flex flex-col h-full">
			<Tabs
				value={modelsSource}
				onValueChange={setModelsSource}
				className="flex flex-col h-full"
			>
				<TabsList className="grid w-full grid-cols-3 h-auto p-0 border">
					<TabsTrigger value="featured" className="text-xs rounded-full">
						Featured
					</TabsTrigger>
					<TabsTrigger value="sketchfab" className="text-xs rounded-full">
						Sketchfab
					</TabsTrigger>
					<TabsTrigger value="abo" className="text-xs rounded-full">
						Amazon
					</TabsTrigger>
				</TabsList>

				<TabsContent value="featured" className="flex-1 min-h-0 mt-2">
					<ItemsCatalog
						data={MODEL_FILES}
						value={modelValue}
						actions={featuredActions}
						catalogType="models"
					/>
				</TabsContent>

				<TabsContent value="sketchfab" className="flex-1 min-h-0 mt-2">
					<ModelSourceBrowser
						source={SketchfabService}
						notice={SKETCHFAB_NOTICE}
						onReplace={( url, name, item, options ) => loadModelUrl( url, name, options )}
						onAdd={( url, name, item, options ) => addModel( url, name, options )}
					/>
				</TabsContent>

				<TabsContent value="abo" className="flex-1 min-h-0 mt-2">
					<ModelSourceBrowser
						source={AboService}
						notice={ABO_NOTICE}
						onReplace={( url, name, item, options ) => loadModelUrl( url, name, options )}
						onAdd={( url, name, item, options ) => addModel( url, name, options )}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default ModelsTab;
