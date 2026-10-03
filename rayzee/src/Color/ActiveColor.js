/**
 * The colour management the engine reads — `BasicColor` in the renderer core, the OCIO `ColorManagement` once a host
 * installs it (rayzee/addons/color). A config, a working space and a set of view transforms are process-wide — there
 * is one OCIO runtime and one set of baked tables — so code far from the app (texture processing, the environment)
 * asks for the active instance rather than having one threaded through six constructors.
 */

/** What the engine renders in when no config has been adopted. */
export const DEFAULT_WORKING_SPACE = 'Linear Rec.709 (sRGB)';

let active = null;

/** The colour management the engine is currently using, or null. */
export function getActiveColorManagement() {

	return active;

}

/** Make an instance the one the engine reads. Normally the app's own, set on construction. */
export function setActiveColorManagement( cm ) {

	active = cm;
	// Whatever the previous instance published is not this one's working space.
	cm?._publishWorkingMatrix?.();

}

/** Becomes the active one only when there is none, without publishing (a constructor's claim). */
export function claimActiveColorManagement( cm ) {

	if ( active === null ) active = cm;

}
