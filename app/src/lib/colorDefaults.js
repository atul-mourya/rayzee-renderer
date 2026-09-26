// No imports: the bake script (`npm run color:bake`) reads this in Node.

/** The config the app starts in, and the view it opens on. */
export const DEFAULT_COLOR_IDENTITY = Object.freeze( {
	id: 'blender-5.1',
	label: 'Blender',
	description: 'Blender 5.1 — AgX, Filmic and their looks',
	view: Object.freeze( { display: 'sRGB', view: 'AgX', look: 'AgX - Medium High Contrast' } ),
	// That view pre-baked, beside the config: the first frame needs neither the runtime nor the config.
	bakedView: 'default-view.bin',
} );
