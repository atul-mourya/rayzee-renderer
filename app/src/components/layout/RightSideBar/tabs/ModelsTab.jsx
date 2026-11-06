import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ItemsCatalog } from '@/components/ui/items-catalog';
import { MODEL_FILES } from '@/Constants';
import { useAssetsStore } from '@/store';
import { useAssetLoader } from '@/hooks/useAssetLoader';
import { useToast } from '@/hooks/use-toast';
import { getApp } from '@/lib/appProxy';
import { isArchiveUrl } from '@/lib/archives';
import { SketchfabService } from '@/services/SketchfabService';
import { AboService } from '@/services/AboService';
import CatalogBrowser from './CatalogBrowser';

const SKETCHFAB_NOTICE = SketchfabService.getToken() ? null : (
	<>Browse only — set <code className="text-[10px]">VITE_SKETCHFAB_TOKEN</code> to download models.</>
);

// CC BY 4.0 asks for the credit, a link to the licence and to say what was changed.
const ABO_NOTICE = (
	<>
		Models © Amazon.com, from <a className="underline" href={AboService.SOURCE_URL} target="_blank" rel="noopener noreferrer">Amazon Berkeley Objects</a>;
		compressed copies by <a className="underline" href={AboService.CODEPAWL_URL} target="_blank" rel="noopener noreferrer">CodePawl</a>.{' '}
		<a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.
	</>
);

/** Replace / Add on an online source's model card: resolve its file, then swap the scene for it or append it. */
function useOnlineModelActions( source, variant, replace, add ) {

	const { toast } = useToast();

	return useMemo( () => {

		const run = async ( item, replacing ) => {

			try {

				const picked = await source.resolveDownload( item, { variant } );
				if ( ! picked.url ) {

					toast( { title: 'No download', description: `${source.NAME} offers no downloadable file for this model.`, variant: 'destructive' } );

				} else if ( picked.format === 'zip' ) {

					if ( ! replacing ) {

						toast( { title: 'Replace only', description: 'This model comes as a glTF archive, which can replace the scene but not be added to it.' } );
						return;

					}

					await getApp()?.loadFile( picked.url, { filename: `${item.id}.zip`, cacheKey: picked.cacheKey } );

				} else {

					await ( replacing ? replace : add )( picked.url, item.name, { cacheKey: picked.cacheKey } );

				}

			} catch ( e ) {

				toast( { title: 'Error loading model', description: e.message, variant: 'destructive' } );

			}

		};

		const disabled = ( item ) => ! source.canDownload( item );
		return [
			{ key: 'replace', label: 'Replace', variant: 'default', disabled, onClick: ( item ) => run( item, true ) },
			{ key: 'add', label: 'Add', variant: 'secondary', icon: <Plus size={12} />, disabled, onClick: ( item ) => run( item, false ) },
		];

	}, [ source, variant, replace, add, toast ] );

}

const ModelsTab = () => {

	const { model, setModel, modelsSource, setModelsSource, aboVariant, setAboVariant } = useAssetsStore();
	const { loadModel, loadModelUrl, addModel, appendCatalogModel } = useAssetLoader();
	const sketchfabActions = useOnlineModelActions( SketchfabService, undefined, loadModelUrl, addModel );
	const aboActions = useOnlineModelActions( AboService, aboVariant, loadModelUrl, addModel );

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
					<CatalogBrowser source={SketchfabService} notice={SKETCHFAB_NOTICE} actions={sketchfabActions} />
				</TabsContent>

				<TabsContent value="abo" className="flex-1 min-h-0 mt-2">
					<CatalogBrowser
						source={AboService}
						notice={ABO_NOTICE}
						variant={aboVariant}
						onVariantChange={setAboVariant}
						actions={aboActions}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default ModelsTab;
