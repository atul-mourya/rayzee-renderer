/**
 * The OCIO colour pipeline — `rayzee/addons/color`: colour configs, OCIO views and looks, working spaces, input
 * colour spaces and export spaces. The renderer core renders in linear Rec.709 through three.js's own view transforms
 * (BasicColor); PathTracerApp installs this itself. On the core, install it once — before or after init():
 *
 * @example
 * import { RayzeeRenderer, configureAssets } from 'rayzee/core';
 * import { ColorManagement } from 'rayzee/addons/color';
 *
 * configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );
 * renderer.setColorManagement( ColorManagement );
 * await renderer.loadColorConfig( { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } );
 */

export {
	ColorManagement, getActiveColorManagement, setActiveColorManagement,
	isColorManaged, DEFAULT_WORKING_SPACE, findNativeLinearSpace, canvasColorSpaceFor,
} from '../Color/ColorManagement.js';
export { displayCanvasFit } from '../Color/Displays.js';
export {
	buildOcioView, addOcioView, addAllOcioViews,
	DEFAULT_LUT_SIZE, DEFAULT_MIN_EV, DEFAULT_MAX_EV,
} from '../Color/OcioViews.js';
export {
	resolveInputSpace, textureInputSpace, setInputOverride, clearInputOverrides,
	listInputOverrides, listFileRules, isDataTexture,
} from '../Color/InputColorSpaces.js';
export {
	convertColor, convertPixelsF32, convertEncodedRGBA8, applyMatrixRGBA8, extractMatrix,
	hasColorSpace, isDataSpace, srgbToLinear, linearToSrgb,
} from '../Color/ColorSpaces.js';
export { measureBakeError, bakeLut, makeCpuSampler } from '../Color/LutBake.js';
