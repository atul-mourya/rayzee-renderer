import debugModelsData from './data/DebugModels.json';

import {
	ENGINE_DEFAULTS, SKY_DEFAULTS, DENOISER_DEFAULTS, AUTO_EXPOSURE_DEFAULTS, LOCAL_EXPOSURE_DEFAULTS, AUTO_FOCUS_DEFAULTS, NRD_DEFAULTS,
	DEFAULT_SUN_PATH, DEFAULT_VIEW,
} from 'rayzee';
export { DENOISER_STRATEGIES, NRD_QUALITY_PRESETS, NRD_DEFAULTS } from 'rayzee';

// CDN base URL for static assets (models, hdri, noise)
export const ASSETS_BASE_URL = 'https://assets.rayzee.atulmourya.com';

// Khronos glTF-Sample-Assets served via jsDelivr's GitHub mirror — proper CORS and no
// aggressive per-client rate limiting (raw.githubusercontent.com returns 429 under load).
export const GLTF_SAMPLE_ASSETS_BASE = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models';

// DEFAULT_STATE = the engine's defaults, those of the viewer pieces the app drives, and the app's own keys
export const DEFAULT_STATE = {
	...ENGINE_DEFAULTS,
	...SKY_DEFAULTS,
	...DENOISER_DEFAULTS,
	...AUTO_EXPOSURE_DEFAULTS,
	...LOCAL_EXPOSURE_DEFAULTS,
	...AUTO_FOCUS_DEFAULTS,
	// The app turns the final denoise on out of the box — see INTERACTIVE_RENDER_CONFIG. The engine
	// default stays off so an embedder is not made to fetch OIDN's weights it never asked for.
	enableOIDN: true,
	// OIDN owns the live view too: the cleanest of the live denoisers, still and moving.
	denoiserStrategy: 'oidn',
	// Local exposure too: it changes the look, so the engine — and a farm pinned to its look — keeps it off.
	localExposure: true,
	// Fog: off; when on, its thickness (the share of light crossing the models' longest side it stops), a forward glow,
	// and where it sits: 'everywhere', 'low' or 'ground'.
	fog: false,
	fogThickness: 0.3,
	fogAnisotropy: 0.4,
	fogHeight: 'everywhere',
	// The app's names for engine values
	bounces: ENGINE_DEFAULTS.maxBounces,
	debugMode: ENGINE_DEFAULTS.visMode,
	toneMapping: DEFAULT_VIEW,
	// UI-only keys (not needed by the engine)
	resolution: 512,
	enableAccumulation: true,
	canvasWidth: 512,
	canvasHeight: 512,
	fov: 55,
	environmentMode: 'hdri', // 'hdri' | 'procedural' | 'color'
	skyPreset: 'clearDay',
	enablePathTracer: true,
	pauseRendering: false,
	tilesHelper: true, // show OIDN denoise / AI upscale tile progress overlay
	showLightHelper: false,
	debugThreshold: 100,
	debugModel: 0,
	model: 6,
	environment: 'aristea_wreck_puresky',
	aspectRatioPreset: '1:1',
	orientation: 'landscape',
	finalRenderResolution: 2048,
	originalPixelRatio: window.devicePixelRatio / 2,
	zoomToCursor: true,
	// Physical sky's sun path; SKY_DEFAULTS' sun angles are this position.
	skySunMode: 'time', // 'time' | 'angles'
	skyTime: DEFAULT_SUN_PATH.time,
	skyMonth: DEFAULT_SUN_PATH.month,
	skyLatitude: DEFAULT_SUN_PATH.latitude,
	skyNorthOffset: 0,
	// NRD sliders mirror the engine's ReblurSettings defaults (preset 'medium').
	nrdMaxAccumulatedFrameNum: NRD_DEFAULTS.maxAccumulatedFrameNum,
	nrdMaxBlurRadius: NRD_DEFAULTS.maxBlurRadius,
	nrdPrepassBlurRadius: NRD_DEFAULTS.prepassBlurRadius,
	nrdAntiFirefly: NRD_DEFAULTS.enableAntiFirefly,
};

export const CAMERA_RANGES = {
	fov: {
		min: 10,
		max: 90,
		default: DEFAULT_STATE.fov
	},
	focusDistance: {
		min: 0.3,
		max: 100.0,
		default: DEFAULT_STATE.focusDistance
	},
	aperture: {
		options: [ 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0 ],
		default: DEFAULT_STATE.aperture
	},
	focalLength: {
		min: 0,
		max: 200,
		default: DEFAULT_STATE.focalLength
	}
};

// `exposure` (EV) makes up about two thirds of the light a lower sun loses, as a photographer
// would: a sunset still reads darker than noon.
export const SKY_PRESETS = {
	clearDay: { name: 'Clear Day', sunAzimuth: SKY_DEFAULTS.skySunAzimuth, sunElevation: SKY_DEFAULTS.skySunElevation, turbidity: 2, exposure: 0 },
	clearMorning: { name: 'Clear Morning', sunAzimuth: 90, sunElevation: 15, turbidity: 2, exposure: 1.4 },
	clearNoon: { name: 'Clear Noon', sunAzimuth: 180, sunElevation: 70, turbidity: 2, exposure: 0 },
	hazyAfternoon: { name: 'Hazy Afternoon', sunAzimuth: 225, sunElevation: 35, turbidity: 4.5, exposure: 0.4 },
	goldenHour: { name: 'Golden Hour', sunAzimuth: 270, sunElevation: 6, turbidity: 2.5, exposure: 2.7 },
	sunset: { name: 'Sunset', sunAzimuth: 270, sunElevation: 1, turbidity: 3, exposure: 4.2 },
	blueHour: { name: 'Blue Hour', sunAzimuth: 270, sunElevation: - 4, turbidity: 2, exposure: 7 },
	mountain: { name: 'Mountain Air', sunAzimuth: 135, sunElevation: 40, turbidity: 1.3, altitude: 3000, exposure: 0 },
};

export const CAMERA_PRESETS = {
	portrait: {
		name: "Portrait",
		description: "Shallow depth of field, background blur",
		dofBlur: 0.10,
		aperture: 1.4,
		focalLength: 135,
		apertureScale: 1.0
	},
	landscape: {
		name: "Landscape",
		description: "Maximum depth of field, everything in focus",
		dofBlur: 0.001,
		aperture: 16.0,
		focalLength: 24,
		apertureScale: 0.5
	},
	macro: {
		name: "Macro",
		description: "Very thin focus plane for close-ups",
		dofBlur: 0.14,
		aperture: 1.4,
		focalLength: 100,
		apertureScale: 2.0
	},
	product: {
		name: "Product",
		description: "Sharp detail with subtle background separation",
		dofBlur: 0.013,
		aperture: 2.8,
		focalLength: 85,
		apertureScale: 0.4
	},
	architectural: {
		name: "Architectural",
		description: "Deep focus for rooms and buildings",
		dofBlur: 0.001,
		aperture: 11.0,
		focalLength: 16,
		apertureScale: 0.5
	},
	cinematic: {
		name: "Cinematic",
		description: "Dramatic depth separation with anamorphic bokeh",
		dofBlur: 0.13,
		aperture: 1.4,
		focalLength: 200,
		apertureScale: 1.0,
		anamorphicRatio: 1.5
	}
};

// Benedikt Bitterli's pbrt-v4 scenes (BMW M6: mmp/pbrt-v4-scenes) repacked on the CDN; Classroom 2 has no pbrt original
const PBRT_SCENES_URL = `${ASSETS_BASE_URL}/models/pbrt-scenes`;
const RESEARCH_SCENES_URL = `${ASSETS_BASE_URL}/models/gltf-research-scenes`;
const BITTERLI_RESOURCES = 'https://benedikt-bitterli.me/resources/';
// `integrator`: the light transport the scene opens with, where the usual path tracing does it less justice.
const pbrtScene = ( name, id, label, { redirection = BITTERLI_RESOURCES, integrator } = {} ) => ( {
	name,
	url: `${PBRT_SCENES_URL}/${id}.zip`,
	preview: `${RESEARCH_SCENES_URL}/webp/${id}.webp`,
	label,
	redirection,
	...( integrator ? { integrator } : {} ),
} );

export const MODEL_FILES = [
	pbrtScene( "Bathroom", 				"contemporary-bathroom", "“Contemporary Bathroom” by Mareck · CC0", { redirection: 'https://github.com/mmp/pbrt-v4-scenes/tree/master/contemporary-bathroom' } ),
	pbrtScene( "Bathroom 2", 			"bathroom2", 			"“Salle de bain” by nacimus · CC BY 3.0" ),
	pbrtScene( "BMW M6", 				"bmw-m6", 				"“BMW M6 2006” by tyrant monkey · CC0", { redirection: 'https://github.com/mmp/pbrt-v4-scenes/tree/master/bmw-m6' } ),
	pbrtScene( "Breakfast Room", 		"breakfast-room", 		"“The Breakfast Room” by Wig42 · CC BY 3.0" ),
	pbrtScene( "Classroom", 			"classroom", 			"“Japanese Classroom” by NovaZeeke · CC BY 3.0" ),
	{
		// The dataset's glTF plus what Blender's export dropped: classroom.blend's sun (strength 15, blackbody 5800 K) and
		// corridor light, as KHR_lights_punctual.
		name: "Classroom 2",
		url: `${RESEARCH_SCENES_URL}/classroom2-lit.glb`,
		preview: `${RESEARCH_SCENES_URL}/webp/classroom2.webp`,
		label: "“Classroom” by Christophe Seux · CC0",
		redirection: 'https://github.com/ErfanMo77/gltf-research-scenes/tree/main/scenes/classroom2',
	},
	pbrtScene( "Coffee Maker", 			"coffee-maker", 		"“Coffee Maker” by cekuhnen · CC BY 3.0" ),
	pbrtScene( "Cornell Box", 			"cornell-box", 			"“Cornell Box” by Benedikt Bitterli · CC0" ),
	// Light through the water only reaches the walls by vertex merging.
	pbrtScene( "Cornell Caustic", 		"cornell-caustic", 		"“Water Caustic” by Benedikt Bitterli · CC0", { integrator: 'vcm' } ),
	pbrtScene( "Dragon Statue", 		"dragon", 				"“Dragon” by Delatronic · CC BY 3.0" ),
	pbrtScene( "Glass of Water", 		"glass-of-water", 		"“Glass of Water” by aXel · CC0" ),
	pbrtScene( "House", 				"house", 				"“Victorian Style House” by MrChimp2313 · CC0" ),
	pbrtScene( "Kitchen", 				"kitchen", 				"“Country Kitchen” by Jay-Artist · CC BY 3.0" ),
	pbrtScene( "Lamp", 					"lamp", 				"“Little Lamp” by UP3D · CC0" ),
	pbrtScene( "Living Room", 			"living-room", 			"“The Grey & White Room” by Wig42 · CC BY 3.0" ),
	pbrtScene( "Living Room 2", 		"living-room-2", 		"“The White Room” by Jay-Artist · CC BY 3.0" ),
	pbrtScene( "Material Testball", 	"material-testball", 	"“Material Test Ball” by Benedikt Bitterli · CC0" ),
	pbrtScene( "Modern Hall", 			"modern-hall", 			"“Modern Hall” by NewSee2l035 · CC BY 3.0" ),
	pbrtScene( "Pontiac GTO", 			"pontiac-gto", 			"“Pontiac GTO 67” by thecali · CC0" ),
	pbrtScene( "Spaceship", 			"spaceship", 			"“4060.b Spaceship” by thecali · CC0" ),
	pbrtScene( "Staircase", 			"staircase", 			"“The Wooden Staircase” by Wig42 · CC BY 3.0" ),
	pbrtScene( "Teapot", 				"teapot", 				"“Utah Teapot” by Benedikt Bitterli · CC0" ),
	pbrtScene( "Teapot Full", 			"teapot-full", 			"“Utah Teapot (full)” by Benedikt Bitterli · CC0" ),
	pbrtScene( "Veach Ajar", 			"veach-ajar", 			"“Veach, Ajar” by Benedikt Bitterli · CC0" ),
	// Lit from inside a lamp shade, with a glass egg's caustic: bidirectional, as the file asks.
	pbrtScene( "Veach Bidir", 			"veach-bidir", 			"“Veach, Bidir Room” by Benedikt Bitterli · CC0", { integrator: 'bidirectional' } ),
	pbrtScene( "Veach MIS", 			"veach-mis", 			"“Veach, MIS” by Benedikt Bitterli · CC0" ),
	pbrtScene( "Vintage Car", 			"vintage-car", 			"“Old vintage car” by piopis · CC0" ),
];

const tagPriority = {
	'pbrtest': 1,
	'testing': 2,
	'core': 3,
	'extension': 4,
	'showcase': 5,
	'video': 6,
	'written': 7,
	'issues': 8
};
const getHighestPriorityTag = ( tags ) => {

	return tags.reduce( ( highest, tag ) => {

		const currentPriority = tagPriority[ tag ] || 999;
		const highestPriority = tagPriority[ highest ] || 999;
		return currentPriority < highestPriority ? tag : highest;

	}, tags[ 0 ] );

};

export const DEBUG_MODELS = debugModelsData
	// .filter( m =>  m.tags.includes('pbrtest') )
	.map( model => {

		let variantDir, variantFile;
		if ( model.variants[ 'glTF-Binary' ] ) {

			variantDir = 'glTF-Binary';
			variantFile = model.variants[ 'glTF-Binary' ];

		} else if ( model.variants[ 'glTF' ] ) {

			variantDir = 'glTF';
			variantFile = model.variants[ 'glTF' ];

		} else {

			// Fallback to the first available variant
			const firstVariant = Object.entries( model.variants )[ 0 ];
			variantDir = firstVariant[ 0 ];
			variantFile = firstVariant[ 1 ];

		}

		return {
			name: model.name,
			label: model.label,
			url: `${GLTF_SAMPLE_ASSETS_BASE}/${model.name}/${variantDir}/${variantFile}`,
			preview: `${GLTF_SAMPLE_ASSETS_BASE}/${model.name}/${model.screenshot}`,
			redirection: `https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/${model.name}/README.md`,
			tags: model.tags
		};

	} )
	.sort( ( a, b ) => {

		const tagA = getHighestPriorityTag( a.tags );
		const tagB = getHighestPriorityTag( b.tags );
		return ( tagPriority[ tagA ] || 999 ) - ( tagPriority[ tagB ] || 999 );

	} );

// Aspect ratio presets — always landscape-native (orientation toggle handles portrait)
export const ASPECT_RATIO_PRESETS = {
	'1:1': { label: '1:1', width: 1, height: 1 },
	'16:9': { label: '16:9', width: 16, height: 9 },
	'4:3': { label: '4:3', width: 4, height: 3 },
	'3:2': { label: '3:2', width: 3, height: 2 },
	'2.39:1': { label: '2.39:1', width: 239, height: 100 },
	'21:9': { label: '21:9', width: 21, height: 9 },
};

/** The ratio as the picture has it: 16:9 turned to portrait reads 9:16. */
export const aspectRatioLabel = ( preset, orientation ) => {

	const label = ASPECT_RATIO_PRESETS[ preset ]?.label ?? preset;
	return orientation === 'portrait' ? label.split( ':' ).reverse().join( ':' ) : label;

};

// A round step `decades` powers of ten below `fitted`, up to four times it. An empty scene fits nothing: size 1.
const roundRange = ( fitted, decades ) => {

	if ( ! ( fitted > 0 && Number.isFinite( fitted ) ) ) fitted = 1;
	const exponent = Math.floor( Math.log10( fitted ) ) - decades;
	const precision = Math.max( 0, - exponent );
	const step = + ( 10 ** exponent ).toFixed( precision );
	return { min: step, max: + ( Math.ceil( fitted * 4 / step ) * step ).toFixed( precision ), step, precision };

};

/** Walk Speed slider, in m/s: a tenth to four times the fitted speed, on a round step. */
export const walkSpeedRange = fitted => roundRange( fitted, 1 );

/** View Height slider, in metres: about a hundredth to four times the model's longest side. */
export const orthoHeightRange = modelSize => roundRange( modelSize, 2 );

// Resolution presets — longest edge in pixels
export const RESOLUTION_PRESETS = [
	{ value: 256, label: '256' },
	{ value: 512, label: '512' },
	{ value: 1024, label: '1024' },
	{ value: 2048, label: '2048' },
	// 4096 (4K): the engine raises the reserved storage size on demand (device-capped) via
	// app.setReservedRenderResolution() — see _applyCanvasDimensions. On GPUs without the VRAM
	// for 4K's ~1.5 GB framebuffer the request clamps back to 2048.
	{ value: 4096, label: '4096' },
];

// Max material-texture dimension (longest edge) applied at scene load. Independent of
// render resolution above. Higher = sharper textures, ~quadratic VRAM per material array.
export const MAX_TEXTURE_SIZE_PRESETS = [
	{ value: 1024, label: '1024' },
	{ value: 2048, label: '2048' },
	{ value: 4096, label: '4096' },
	{ value: 8192, label: '8192' },
];

// Translucent looks the material catalogue (Assets → Materials) offers beside its measured entries, sized to the object
// rather than measured: `radius` is a per-channel ratio (max channel = 1), `depth` the max-channel mean free path as a
// share of the object's world-space diagonal, so a candle and a statue look alike. Colours sRGB. Turning subsurface on
// in the Material tab gives the first one (store.applySubsurfacePreset).
export const SSS_PRESETS = [
	{ name: 'wax', label: 'Candle wax', category: 'Manmade', tags: [ 'candle', 'paraffin' ], scatter: '#f2e8d5', base: '#f2e8d5', radius: [ 1, 0.6, 0.35 ], depth: 0.035, weight: 0.9, g: 0.0, roughness: 0.45, ior: 1.45 },
	{ name: 'beeswax', label: 'Beeswax', category: 'Organic', tags: [ 'honeycomb', 'wax' ], scatter: '#e8b45a', base: '#e0a848', radius: [ 1, 0.43, 0.18 ], depth: 0.035, weight: 0.9, g: 0.15, roughness: 0.4, ior: 1.45 },
	{ name: 'jade', label: 'Jade', category: 'Crystal', tags: [ 'stone', 'gem' ], scatter: '#5fae7e', base: '#3f7d5a', radius: [ 0.4, 1, 0.55 ], depth: 0.07, weight: 0.9, g: 0.0, roughness: 0.12, ior: 1.5 },
	{ name: 'gummy', label: 'Gummy sweet', category: 'Manmade', tags: [ 'jelly', 'candy' ], scatter: '#e0402c', base: '#e0402c', radius: [ 1, 0.65, 0.45 ], depth: 0.13, weight: 0.95, g: 0.0, roughness: 0.08, ior: 1.5 },
	{ name: 'soap', label: 'Soap', category: 'Manmade', tags: [ 'alabaster' ], scatter: '#ece6dc', base: '#ece6dc', radius: [ 1, 0.9, 0.8 ], depth: 0.05, weight: 0.9, g: 0.0, roughness: 0.25, ior: 1.5 },
];

/** A preset's mean free path per channel on an object whose world-space diagonal is `diagonal`. */
export const presetRadius = ( preset, diagonal ) => preset.radius.map( ( c ) => c * preset.depth * diagonal );

// Artist-facing "Translucency" (0..1) ↔ engine subsurfaceRadiusScale. Log curve so the useful
// range is centered: t=0 → 0.25 (dense/opaque), t=0.5 → 1.0 (preset default), t=1 → 4.0 (glassy).
export const translucencyToScale = t => 0.25 * Math.pow( 16, Math.max( 0, Math.min( 1, t ) ) );
export const scaleToTranslucency = s => Math.max( 0, Math.min( 1, Math.log( Math.max( s, 1e-4 ) / 0.25 ) / Math.log( 16 ) ) );

/**
 * Compute canvas width/height from resolution + aspect ratio + orientation.
 * Resolution = longest edge. Aspect ratio defines the shape. Orientation flips it.
 */
export function computeCanvasDimensions( resolution, aspectPreset, orientation ) {

	const preset = ASPECT_RATIO_PRESETS[ aspectPreset ];
	if ( ! preset ) return { width: resolution, height: resolution };

	const maxRatio = Math.max( preset.width, preset.height );
	const minRatio = Math.min( preset.width, preset.height );
	const longSide = resolution;
	const shortSide = Math.round( resolution * minRatio / maxRatio );

	if ( orientation === 'portrait' && longSide !== shortSide ) {

		return { width: shortSide, height: longSide };

	}

	return { width: longSide, height: shortSide };

}

export const isPanorama = projection => projection === 'equirectangular';
export const isOrthographic = projection => projection === 'orthographic';

/**
 * Output dimensions for a render. Equirectangular panoramas are locked to 2:1 with the
 * resolution as the width; everything else follows the aspect-ratio + orientation presets.
 */
export function computeOutputDimensions( state, resolution ) {

	if ( isPanorama( state?.cameraProjection ) ) {

		return { width: resolution, height: Math.round( resolution / 2 ) };

	}

	return computeCanvasDimensions( resolution, state?.aspectRatioPreset, state?.orientation );

}



/*

Test models:
Khronos Group glTF-Sample-Assets: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Models.md

https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MosquitoInAmber/glTF-Binary/MosquitoInAmber.glb

 */

// studio lights: https://stock.adobe.com/in/search?k=studio+hdri
