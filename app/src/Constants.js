import debugModelsData from './DebugModels.json';

// Re-export engine constants for backward compatibility
import { ENGINE_DEFAULTS } from 'rayzee';
export {
	ASVGF_QUALITY_PRESETS,
	CAMERA_RANGES,
	SKY_PRESETS,
	CAMERA_PRESETS,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TRIANGLE_DATA_LAYOUT,
	TEXTURE_CONSTANTS,
	DEFAULT_TEXTURE_MATRIX,
	MEMORY_CONSTANTS,
} from 'rayzee';

// CDN base URL for static assets (models, hdri, noise)
export const ASSETS_BASE_URL = 'https://assets.rayzee.atulmourya.com';

// Khronos glTF-Sample-Assets served via jsDelivr's GitHub mirror — proper CORS and no
// aggressive per-client rate limiting (raw.githubusercontent.com returns 429 under load).
export const GLTF_SAMPLE_ASSETS_BASE = 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models';

// DEFAULT_STATE = engine defaults + UI-only keys
export const DEFAULT_STATE = {
	...ENGINE_DEFAULTS,
	// UI-only keys (not needed by the engine)
	model: 9,
	environment: 'aristea_wreck_puresky',
	aspectRatioPreset: '1:1',
	orientation: 'landscape',
	finalRenderResolution: 2048,
	originalPixelRatio: window.devicePixelRatio / 2,
	zoomToCursor: true,
};

// export const MODEL_BASE_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/';
export const MODEL_FILES = [
	{ name: "Cornell Box 1", 		url: `${ASSETS_BASE_URL}/models/CornellBox1.glb`, preview: `${ASSETS_BASE_URL}/models/CornellBox1.png` },
	{ name: "Gameboy", 				url: `${ASSETS_BASE_URL}/models/Gameboy.glb`, preview: `${ASSETS_BASE_URL}/models/Gameboy.png` },
	{ name: "Stanford Bunny", 		url: `${ASSETS_BASE_URL}/models/StanfordBunny.glb`, preview: `${ASSETS_BASE_URL}/models/StanfordBunny.png` },
	{ name: "Table 1", 				url: `${ASSETS_BASE_URL}/models/Table1.glb`, preview: `${ASSETS_BASE_URL}/models/Table1.png` },
	{ name: "Table 2", 				url: `${ASSETS_BASE_URL}/models/Table2.glb`, preview: `${ASSETS_BASE_URL}/models/Table2.png` },
	{ name: "Ambassedor", 			url: `${ASSETS_BASE_URL}/models/ambassedor.glb`, preview: `${ASSETS_BASE_URL}/models/ambassedor.png` },
	{ name: "Antique Phone", 		url: `${ASSETS_BASE_URL}/models/antique_phone.glb`, preview: `${ASSETS_BASE_URL}/models/antique_phone.png` },
	{ name: "Bus Traveler", 		url: `${ASSETS_BASE_URL}/models/bus_traveler.glb`, preview: `${ASSETS_BASE_URL}/models/bus_traveler.png` },
	{ name: "C.W.M", 				url: `${ASSETS_BASE_URL}/models/c.w.m.glb`, preview: `${ASSETS_BASE_URL}/models/c.w.png` },
	{ name: "Camera", 				url: `${ASSETS_BASE_URL}/models/camera.glb`, preview: `${ASSETS_BASE_URL}/models/camera.png` },
	{ name: "Advanced Unit Blocks", url: `${ASSETS_BASE_URL}/models/cgt116_week_8_-_advanced_unit_blocks.glb`, preview: `${ASSETS_BASE_URL}/models/cgt116_week_8_-_advanced_unit_blocks.png` },
	{ name: "Diamond", 				url: `${ASSETS_BASE_URL}/models/diamond.glb`, preview: `${ASSETS_BASE_URL}/models/diamond.png` },
	{ name: "Diorama", 				url: `${ASSETS_BASE_URL}/models/diorama.glb`, preview: `${ASSETS_BASE_URL}/models/diorama.png` },
	{ name: "Dragon", 				url: `${ASSETS_BASE_URL}/models/dragon.glb`, preview: `${ASSETS_BASE_URL}/models/dragon.png` },
	{ name: "Ferrari", 				url: `${ASSETS_BASE_URL}/models/ferrari.glb`, preview: `${ASSETS_BASE_URL}/models/ferrari.png` },
	{ name: "Flashing Light", 		url: `${ASSETS_BASE_URL}/models/flashing_light.glb`, preview: `${ASSETS_BASE_URL}/models/flashing_light.png` },
	{ name: "Folliage", 			url: `${ASSETS_BASE_URL}/models/folliage.glb`, preview: `${ASSETS_BASE_URL}/models/folliage.png` },
	{ name: "Gelatinous Cube", 		url: `${ASSETS_BASE_URL}/models/gelatinous_cube.glb`, preview: `${ASSETS_BASE_URL}/models/gelatinous_cube.png` },
	{ name: "Helmet", 				url: `${ASSETS_BASE_URL}/models/helmet.glb`, preview: `${ASSETS_BASE_URL}/models/helmet.png` },
	{ name: "Jiotto Caspita F1", 	url: `${ASSETS_BASE_URL}/models/jiotto_caspita_f1_road_car_1989_by_alex.ka.glb`, preview: `${ASSETS_BASE_URL}/models/jiotto_caspita_f1_road_car_1989_by_alex.ka.png` },
	{ name: "Lemon", 				url: `${ASSETS_BASE_URL}/models/lemon.glb`, preview: `${ASSETS_BASE_URL}/models/lemon.png` },
	{ name: "Mercedes Mayback", 	url: `${ASSETS_BASE_URL}/models/mercedesmayback.glb`, preview: `${ASSETS_BASE_URL}/models/mercedesmayback.png` },
	{ name: "Model 3", 				url: `${ASSETS_BASE_URL}/models/model3.glb`, preview: `${ASSETS_BASE_URL}/models/model3.png` },
	{ name: "Modern Bathroom", 		url: `${ASSETS_BASE_URL}/models/modernbathroom.glb`, preview: `${ASSETS_BASE_URL}/models/modernbathroom.png` },
	{ name: "Old Stool", 			url: `${ASSETS_BASE_URL}/models/old_stool.glb`, preview: `${ASSETS_BASE_URL}/models/old_stool.png` },
	{ name: "Outdoor Sofaset", 		url: `${ASSETS_BASE_URL}/models/outdoorsofaset.glb`, preview: `${ASSETS_BASE_URL}/models/outdoorsofaset.png` },
	{ name: "Pagani Huayra Free", 	url: `${ASSETS_BASE_URL}/models/pagani_huayra_free.glb`, preview: `${ASSETS_BASE_URL}/models/pagani_huayra_free.png` },
	{ name: "Retro Telephone", 		url: `${ASSETS_BASE_URL}/models/retro_telephone_bordstelefon_tunnan.glb`, preview: `${ASSETS_BASE_URL}/models/retro_telephone_bordstelefon_tunnan.png` },
	{ name: "Road", 				url: `${ASSETS_BASE_URL}/models/road.glb`, preview: `${ASSETS_BASE_URL}/models/road.png` },
	{ name: "Rollerskates", 		url: `${ASSETS_BASE_URL}/models/rollerskates_race_-_inliner.glb`, preview: `${ASSETS_BASE_URL}/models/rollerskates_race_-_inliner.png` },
	{ name: "Scull Cup", 			url: `${ASSETS_BASE_URL}/models/scull_cup.glb`, preview: `${ASSETS_BASE_URL}/models/scull_cup.png` },
	{ name: "Mantel Clocks", 		url: `${ASSETS_BASE_URL}/models/simple_1800s_mantel_clocks.glb`, preview: `${ASSETS_BASE_URL}/models/simple_1800s_mantel_clocks.png` },
	{ name: "Skatin Jade Dragon", 	url: `${ASSETS_BASE_URL}/models/skatin_jade_dragon.glb`, preview: `${ASSETS_BASE_URL}/models/skatin_jade_dragon.png` },
	{ name: "Sony Walkman", 		url: `${ASSETS_BASE_URL}/models/sony_walkman_wm-f2078.glb`, preview: `${ASSETS_BASE_URL}/models/sony_walkman_wm-f2078.png` },
	{ name: "Spyglasscase", 		url: `${ASSETS_BASE_URL}/models/spyglasscase.glb`, preview: `${ASSETS_BASE_URL}/models/spyglasscase.png` },
	{ name: "Rolex Oyster", 		url: `${ASSETS_BASE_URL}/models/watch-rolex-oyster-perpetual.glb`, preview: `${ASSETS_BASE_URL}/models/watch-rolex-oyster-perpetual.png` },
	{ name: "Suzzane", 				url: `${ASSETS_BASE_URL}/models/suzzane.glb`, preview: `${ASSETS_BASE_URL}/models/suzzane.png` },
	{ name: "Laser Flashlight", 	url: `${ASSETS_BASE_URL}/models/zenitco_klesch-2p__laser_flashlight.glb`, preview: `${ASSETS_BASE_URL}/models/zenitco_klesch-2p__laser_flashlight.png` },
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

// Subsurface-scattering presets. `radius` is a per-channel ratio (max channel = 1) describing
// the chromatic falloff; `depth` is the max-channel mean free path as a fraction of the object's
// world-space bbox diagonal — so the absolute radius auto-scales to any model size (applied in
// store.applySubsurfacePreset). Grounded in Jensen et al. 2001 measured coefficients.
export const SSS_PRESETS = [
	{ name: 'skin_light', label: 'Skin — Light', scatter: '#e8c4b0', base: '#e8c4b0', radius: [ 1, 0.35, 0.20 ], depth: 0.022, weight: 1.0, g: 0.0, roughness: 0.35, ior: 1.4 },
	{ name: 'skin_medium', label: 'Skin — Medium', scatter: '#cf9b7a', base: '#cf9b7a', radius: [ 1, 0.30, 0.16 ], depth: 0.020, weight: 1.0, g: 0.0, roughness: 0.35, ior: 1.4 },
	{ name: 'skin_dark', label: 'Skin — Dark', scatter: '#8a5a3c', base: '#8a5a3c', radius: [ 1, 0.28, 0.14 ], depth: 0.016, weight: 1.0, g: 0.0, roughness: 0.35, ior: 1.4 },
	{ name: 'wax', label: 'Wax (candle)', scatter: '#f2e8d5', base: '#f2e8d5', radius: [ 1, 0.6, 0.35 ], depth: 0.035, weight: 0.9, g: 0.0, roughness: 0.45, ior: 1.45 },
	{ name: 'beeswax', label: 'Beeswax / Honey', scatter: '#e8b45a', base: '#e0a848', radius: [ 1, 0.43, 0.18 ], depth: 0.035, weight: 0.9, g: 0.15, roughness: 0.4, ior: 1.45 },
	{ name: 'marble', label: 'Marble', scatter: '#f0ece6', base: '#f0ece6', radius: [ 1, 0.85, 0.7 ], depth: 0.012, weight: 0.85, g: 0.0, roughness: 0.18, ior: 1.5 },
	{ name: 'jade', label: 'Jade', scatter: '#5fae7e', base: '#3f7d5a', radius: [ 0.4, 1, 0.55 ], depth: 0.07, weight: 0.9, g: 0.0, roughness: 0.12, ior: 1.5 },
	{ name: 'milk', label: 'Milk', scatter: '#f5f5ff', base: '#f5f5ff', radius: [ 1, 0.85, 0.6 ], depth: 0.015, weight: 1.0, g: 0.0, roughness: 0.6, ior: 1.35 },
	{ name: 'gummy', label: 'Gummy / Jelly', scatter: '#e0402c', base: '#e0402c', radius: [ 1, 0.65, 0.45 ], depth: 0.13, weight: 0.95, g: 0.0, roughness: 0.08, ior: 1.5 },
	{ name: 'soap', label: 'Soap / Alabaster', scatter: '#ece6dc', base: '#ece6dc', radius: [ 1, 0.9, 0.8 ], depth: 0.05, weight: 0.9, g: 0.0, roughness: 0.25, ior: 1.5 },
];

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



/*

Test models:
Khronos Group glTF-Sample-Assets: https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/Models.md

https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/MosquitoInAmber/glTF-Binary/MosquitoInAmber.glb

 */

// studio lights: https://stock.adobe.com/in/search?k=studio+hdri
