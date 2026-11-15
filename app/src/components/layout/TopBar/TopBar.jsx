import { useState, lazy, Suspense } from 'react';
import { useStore, usePathTracerStore } from '@/store';
import MenuBar from './MenuBar';
import ModeTabs from './ModeTabs';
import { ThemeToggle } from '@/components/theme-toggle';
import { useImportUrl } from '@/hooks/useImportUrl';

// Lazy load the ImportUrlModal since it's only used when opening import dialog
const ImportUrlModal = lazy( () => import( './ImportUrlModal' ) );
const StorageDialog = lazy( () => import( './StorageDialog' ) );
const RecentDialog = lazy( () => import( './RecentDialog' ) );
const ExportDialog = lazy( () => import( './ExportDialog' ) );

// Loading fallback for modal
const ModalLoadingFallback = () => (
	<div className="fixed inset-0 z-50 bg-scrim/80 flex items-center justify-center">
		<div className="bg-background rounded-lg p-6 shadow-lg">
			<div className="flex items-center space-x-3">
				<div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full"></div>
				<span className="text-sm">Loading...</span>
			</div>
		</div>
	</div>
);

const TopBar = () => {

	const appMode = useStore( state => state.appMode );
	const setAppMode = useStore( state => state.setAppMode );
	const handleModeChange = usePathTracerStore( state => state.handleModeChange );
	const exportRequested = useStore( state => !! state.exportRequest );

	const [ storageOpen, setStorageOpen ] = useState( false );
	const [ recentOpen, setRecentOpen ] = useState( false );

	const {
		modalState,
		openImportModal,
		closeImportModal,
		setImportUrl,
		handleImportFromUrl
	} = useImportUrl();

	const handleTabChange = ( value ) => {

		if ( value === appMode ) return;
		// First: the mode handler's reset listeners read appMode.
		setAppMode( value );
		handleModeChange( value );

	};

	return (
		<>
			{/* Three columns, so the mode switch sits in the middle of the window whatever the menus' width. */}
			<div className="grid h-10 grid-cols-[1fr_auto_1fr] items-center border-b px-2">
				<div className="flex h-full min-w-0 items-center gap-2">
					<span className="px-1 text-sm font-semibold">Rayzee</span>
					<MenuBar onOpenImportModal={openImportModal} onOpenStorage={() => setStorageOpen( true )} onOpenRecent={() => setRecentOpen( true )} />
				</div>
				<ModeTabs currentMode={appMode} onModeChange={handleTabChange} />
				<div className="flex justify-end">
					<ThemeToggle />
				</div>
			</div>

			<Suspense fallback={<ModalLoadingFallback />}>
				<ImportUrlModal
					isOpen={modalState.isImportModalOpen}
					onClose={closeImportModal}
					importUrl={modalState.importUrl}
					setImportUrl={setImportUrl}
					onImport={handleImportFromUrl}
					isImporting={modalState.isImporting}
				/>
			</Suspense>
			{ storageOpen && (
				<Suspense fallback={<ModalLoadingFallback />}>
					<StorageDialog isOpen={storageOpen} onClose={() => setStorageOpen( false )} />
				</Suspense>
			) }
			{ recentOpen && (
				<Suspense fallback={<ModalLoadingFallback />}>
					<RecentDialog isOpen={recentOpen} onClose={() => setRecentOpen( false )} />
				</Suspense>
			) }
			{ exportRequested && (
				<Suspense fallback={<ModalLoadingFallback />}>
					<ExportDialog />
				</Suspense>
			) }
		</>
	);

};

export default TopBar;
