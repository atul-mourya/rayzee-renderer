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
				title: "Cannot open this link",
				description: "Enter an http(s) link to a .glb or .gltf file, or to a scene archive (.zip, .tar, .tar.gz).",
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
						title: "Model loaded",
						description: [ importUrl.split( '/' ).pop().split( '?' )[ 0 ], spillNote( app ) ].filter( Boolean ).join( '.' ),
					} );

				} )
				.catch( ( error ) => {

					setIsImporting( false );

					if ( error?.code === 'LOAD_CANCELLED' ) {

						toast( { title: "Loading cancelled", description: "The download was cancelled." } );
						return;

					}

					if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' && error.file ) {

						setImportUrl( '' );
						toggleImportModal( false );
						useStore.getState().setArchivePrompt( { file: error.file, elements: error.elements, totalBytes: error.totalBytes } );
						return;

					}

					toast( {
						title: "Could not open the link",
						description: error?.message || `${error}`,
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
