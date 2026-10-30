import { create } from 'zustand';
import { DEFAULT_STATE } from '@/Constants';
import { getApp } from '@/lib/appProxy';

export const handleChange = ( setter, appUpdater, needsReset = true ) => val => {

	if ( typeof setter !== 'function' ) {

		console.error( "Invalid setter function passed to handleChange:", setter );
		return;

	}

	setter( val );
	const app = getApp();
	if ( app ) {

		appUpdater( val, app );
		needsReset && app.reset();

	}

};

const IDLE_LOADING = Object.freeze( { isLoading: false, progress: 0, title: '', status: '', loadedBytes: null, totalBytes: null, canCancel: false, failed: false } );

// Main store
export const useStore = create( set => ( {
	selectedObject: null,
	setSelectedObject: obj => set( { selectedObject: obj } ),

	// Set when an archive is too large to load whole and the user must pick one part of it.
	archivePrompt: null,
	setArchivePrompt: prompt => set( { archivePrompt: prompt } ),

	// A saved session, project or unfinished render to reopen: `{ origin: 'recent' | 'project' | 'video' | 'still', record, thumb, ... }`.
	sessionRequest: null,
	setSessionRequest: request => set( { sessionRequest: request } ),
	// The Export window: { tab: 'picture' | 'video', from: 'live' | 'result' }.
	exportRequest: null,
	setExportRequest: request => set( { exportRequest: request } ),

	// Transform controls
	transformMode: 'translate',
	transformSpace: 'world',
	isTransforming: false,
	setIsTransforming: val => set( { isTransforming: val } ),
	handleTransformModeChange: handleChange(
		val => set( { transformMode: val } ),
		( val, app ) => app.transformManager.setMode( val ),
		false
	),
	handleTransformSpaceChange: handleChange(
		val => set( { transformSpace: val } ),
		( val, app ) => app.transformManager.setSpace( val ),
		false
	),

	loading: { ...IDLE_LOADING },
	// A load ends before the shaders it built have compiled, and nothing new is drawn until they have, so the
	// loading panel stays up through that compile rather than closing on the old frame.
	loadingHeldForCompile: false,
	setLoading: state => set( s => ( { loading: { ...s.loading, ...state }, loadingHeldForCompile: false } ) ),
	stats: { samples: 0, timeElapsed: 0, memoryUsed: 0, memoryPeak: 0 },
	setStats: stats => set( { stats } ),
	isDenoising: false,
	setIsDenoising: val => set( { isDenoising: val } ),
	isLoadingDenoiser: false,
	setIsLoadingDenoiser: val => set( { isLoadingDenoiser: val } ),
	isCompilingShaders: false,
	setIsCompilingShaders: val => set( s => ( ! val && s.loadingHeldForCompile
		? { isCompilingShaders: false, loading: { ...IDLE_LOADING }, loadingHeldForCompile: false }
		: { isCompilingShaders: val } ) ),
	isUpscaling: false,
	setIsUpscaling: val => set( { isUpscaling: val } ),
	upscalingProgress: 0,
	upscalingSecondsLeft: null,
	setUpscalingProgress: ( val, secondsLeft = null ) => set( { upscalingProgress: val, upscalingSecondsLeft: secondsLeft } ),
	isRenderComplete: false,
	setIsRenderComplete: val => set( { isRenderComplete: val } ),
	// Which of the three racing stop conditions retired the frame: 'timeLimit' | 'samples' |
	// 'converged', null while rendering. The three are not mutually exclusive, so without this
	// a render that stops at 540 of 600 looks indistinguishable from one that stalled.
	completionReason: null,
	setCompletionReason: val => set( { completionReason: val } ),
	isRendering: true,
	setIsRendering: val => set( { isRendering: val } ),
	resetLoading: () => set( s => ( s.isCompilingShaders && s.loading.isLoading && ! s.loading.failed
		? { loading: { ...s.loading, status: 'Compiling shaders...', canCancel: false, loadedBytes: null, totalBytes: null }, loadingHeldForCompile: true }
		: { loading: { ...IDLE_LOADING }, loadingHeldForCompile: false } ) ),
	appMode: 'preview',
	setAppMode: mode => set( { appMode: mode } ),
	activeTab: 'pathtracer',
	setActiveTab: tab => set( { activeTab: tab } ),
	layers: [],
	setLayers: layers => set( { layers } ),
	selectedResult: null,
	setSelectedResult: imageData => set( { selectedResult: imageData } ),
	resultsViewportRef: null,
	setResultsViewportRef: ref => set( { resultsViewportRef: ref } ),
	imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 0 },
	setImageProcessingParam: ( param, val ) => set( s => ( { imageProcessing: { ...s.imageProcessing, [ param ]: val } } ) ),
	resetImageProcessing: () => set( { imageProcessing: { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 } } ),

	// Enhanced reset function that also triggers immediate update
	handleResetImageProcessing: () => {

		const resetValues = { brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, gamma: 2.2 };

		// Update store state
		useStore.setState( { imageProcessing: resetValues } );

		// Apply immediate processing if image processor is available
		const resultsViewport = useStore.getState().resultsViewportRef?.current;
		if ( resultsViewport?.getImageProcessor ) {

			const processor = resultsViewport.getImageProcessor();
			if ( processor ) {

				processor.setParameters( resetValues );
				processor.render();

			}

		}

	},

	// Real-time color correction handlers for immediate visual feedback
	handleImageProcessingParamChange: ( param ) => ( val ) => {

		const value = Array.isArray( val ) ? val[ 0 ] : val;

		// Update store state immediately
		useStore.setState( s => ( {
			imageProcessing: { ...s.imageProcessing, [ param ]: value }
		} ) );

		// Apply immediate processing if image processor is available
		const resultsViewport = useStore.getState().resultsViewportRef?.current;
		if ( resultsViewport?.getImageProcessor ) {

			const processor = resultsViewport.getImageProcessor();
			if ( processor ) {

				// Get current state to ensure we have latest values
				const currentState = useStore.getState().imageProcessing;
				const updatedState = { ...currentState, [ param ]: value };

				// Apply changes immediately without debouncing
				processor.setParameters( updatedState );
				processor.render();

			}

		}

	},
	toggleMeshVisibility: uuid => {

		const app = getApp();
		if ( ! app ) return;

		const newVisibility = app.setMeshVisibilityByUuid( uuid, prev => ! prev );
		if ( newVisibility === null ) return;

		window.dispatchEvent( new CustomEvent( 'meshVisibilityChanged', {
			detail: { uuid, visible: newVisibility }
		} ) );

	},
	setMeshVisibility: ( uuid, visible ) => {

		const app = getApp();
		if ( ! app ) return;

		if ( app.setMeshVisibilityByUuid( uuid, visible ) === null ) return;

		window.dispatchEvent( new CustomEvent( 'meshVisibilityChanged', {
			detail: { uuid, visible }
		} ) );

	},
} ) );

// Assets store
export const useAssetsStore = create( set => ( {
	...DEFAULT_STATE,
	activeTab: "models",
	materials: [],
	selectedMaterial: null,
	selectedEnvironmentIndex: null,

	// PolyHaven-specific state
	polyHavenMaterials: [],
	polyHavenLoading: false,
	polyHavenResolution: '2k',
	materialsSource: 'current', // 'current' or 'polyhaven'
	modelsSource: 'featured', // 'featured' (built-in catalog) or 'sketchfab'

	// Traditional setters
	setMaterials: materials => set( { materials } ),
	setSelectedMaterial: idx => set( { selectedMaterial: idx } ),
	setActiveTab: tab => set( { activeTab: tab } ),
	setModel: model => set( { model } ),
	setEnvironment: env => set( () => {

		const envStore = useEnvironmentStore.getState();
		const envs = envStore.environments || [];
		const idx = envs.findIndex( e => e.id === env.id );
		return { environment: env, selectedEnvironmentIndex: idx >= 0 ? idx : null };

	} ),
	setSelectedEnvironmentIndex: idx => set( { selectedEnvironmentIndex: idx } ),
	setDebugModel: model => set( { debugModel: model } ),

	// PolyHaven setters
	setPolyHavenMaterials: materials => set( { polyHavenMaterials: materials } ),
	setPolyHavenLoading: loading => set( { polyHavenLoading: loading } ),
	setPolyHavenResolution: resolution => set( { polyHavenResolution: resolution } ),
	setMaterialsSource: source => set( { materialsSource: source } ),
	setModelsSource: source => set( { modelsSource: source } ),
} ) );

// Environment store
export const useEnvironmentStore = create( set => ( {
	apiData: null,
	environments: [],
	isLoading: true,
	error: null,
	selectedResolution: '1k',
	setApiData: data => set( { apiData: data } ),
	setEnvironments: envs => set( { environments: envs } ),
	setIsLoading: loading => set( { isLoading: loading } ),
	setError: err => set( { error: err } ),
	setSelectedResolution: res => set( { selectedResolution: res } ),
} ) );

// Favorites store
export const useFavoritesStore = create( ( set, get ) => ( {
	favorites: JSON.parse( localStorage.getItem( 'rayzee-favorites' ) || '{}' ),

	addFavorite: ( catalogType, itemId ) => set( state => {

		const newFavorites = {
			...state.favorites,
			[ catalogType ]: [ ...( state.favorites[ catalogType ] || [] ), itemId ]
		};

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} ),

	removeFavorite: ( catalogType, itemId ) => set( state => {

		const newFavorites = {
			...state.favorites,
			[ catalogType ]: ( state.favorites[ catalogType ] || [] ).filter( id => id !== itemId )
		};

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} ),

	toggleFavorite: ( catalogType, itemId ) => {

		const currentFavorites = get().favorites[ catalogType ] || [];
		const isFavorite = currentFavorites.includes( itemId );

		if ( isFavorite ) {

			get().removeFavorite( catalogType, itemId );

		} else {

			get().addFavorite( catalogType, itemId );

		}

	},

	isFavorite: ( catalogType, itemId ) => {

		const favorites = get().favorites[ catalogType ] || [];
		return favorites.includes( itemId );

	},

	getFavorites: ( catalogType ) => {

		return get().favorites[ catalogType ] || [];

	},

	clearFavorites: ( catalogType ) => set( state => {

		const newFavorites = { ...state.favorites };
		delete newFavorites[ catalogType ];

		localStorage.setItem( 'rayzee-favorites', JSON.stringify( newFavorites ) );
		return { favorites: newFavorites };

	} )
} ) );
