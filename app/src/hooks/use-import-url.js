import { useState, useCallback } from 'react';
import { useToggle } from '@/hooks/useToggle';
import { useToast } from '@/hooks/use-toast';
import { getApp } from '@/lib/appProxy';
import { useStore } from '@/store';
import { isArchiveUrl, isImportableUrl } from '@/lib/archives';
import { spillNote } from '@/lib/storage';

export function useImportUrl() {

	const { toast } = useToast();
	const [ isImportModalOpen, toggleImportModal ] = useToggle( false );
	const [ importUrl, setImportUrl ] = useState( '' );
	const [ isImporting, setIsImporting ] = useState( false );

	const openImportModal = useCallback( () => {

		toggleImportModal( true );

	}, [ toggleImportModal ] );

	const closeImportModal = useCallback( () => {

		toggleImportModal( false );

	}, [ toggleImportModal ] );

	const setImportUrlValue = useCallback( ( url ) => {

		setImportUrl( url );

	}, [] );

	// Handle import from URL
	const handleImportFromUrl = useCallback( () => {

		if ( ! isImportableUrl( importUrl ) ) {

			toast( {
				title: "Invalid URL",
				description: "Enter an http(s) link to a .glb / .gltf file or a scene archive (.zip, .tar, .tar.gz).",
				variant: "destructive",
			} );
			return;

		}

		setIsImporting( true );

		const app = getApp();
		if ( app ) {

			( isArchiveUrl( importUrl ) ? app.loadFile( importUrl ) : app.loadModel( importUrl ) )
				.then( () => {

					setIsImporting( false );
					setImportUrl( '' );
					toggleImportModal( false );

					toast( {
						title: "Model Loaded",
						description: `Successfully loaded model.${spillNote( app )}`,
					} );

				} )
				.catch( ( error ) => {

					setIsImporting( false );

					if ( error?.code === 'LOAD_CANCELLED' ) {

						toast( { title: "Loading Cancelled", description: "The download was cancelled." } );
						return;

					}

					if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' && error.file ) {

						setImportUrl( '' );
						toggleImportModal( false );
						useStore.getState().setArchivePrompt( { file: error.file, elements: error.elements, totalBytes: error.totalBytes } );
						return;

					}

					toast( {
						title: "Error Loading Model",
						description: `${error}`,
						variant: "destructive",
					} );

				} );

		} else {

			setIsImporting( false );

		}

	}, [ importUrl, toast, toggleImportModal ] );

	return {
		modalState: {
			isImportModalOpen,
			importUrl,
			isImporting
		},
		openImportModal,
		closeImportModal,
		setImportUrl: setImportUrlValue,
		handleImportFromUrl
	};

}
