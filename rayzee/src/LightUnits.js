/**
 * The engine's light-unit rule, stated once.
 *
 * Every light in the scene graph is a **valid three.js light**: it carries the quantity three.js
 * expects for its type, measured in radiometric (watt-based) units rather than photometric ones.
 *
 *   point / spot  → radiant intensity   W/sr
 *   directional   → irradiance          W/m²
 *   rect area     → radiance            W/(sr·m²), `width`/`height` in world metres, unit scale
 *
 * three.js' shading maths is unit-agnostic — it divides by distance² and integrates a form factor,
 * never caring whether the number it was handed is candela or W/sr. Feeding it radiometric values
 * therefore makes the raster fallback, the light helpers and any host reading `sceneModel` correct
 * without one of them knowing anything about the path tracer.
 *
 * Blender-style **Power in Watts** — what the Lights panel edits — is a view of that, converted
 * here and nowhere else. `LightSerializer` converts the other way when it fills the GPU buffer.
 */

/** Luminous efficacy that glTF, three.js and Blender's exporter all assume (lm/W). */
export const LUMENS_PER_WATT = 683;

/** Emitting area in m², including the ellipse/disk shape factor. Assumes unit world scale. */
export function areaLightArea( light ) {

	const shape = light.userData?.shape;
	const shapeFactor = shape === 'ellipse' || shape === 'disk' ? Math.PI / 4 : 1;
	const area = Math.abs( light.width * light.height ) * shapeFactor;
	return Number.isFinite( area ) && area > 0 ? area : 0;

}

/**
 * Blender-style Power for the Lights panel: radiant power in W for point, spot and area lights,
 * and the Sun's strength in W/m² unchanged.
 */
export function lightPower( light ) {

	if ( light.isRectAreaLight ) {

		const normalize = light.userData?.normalize ?? true;
		return light.intensity * Math.PI * ( normalize ? areaLightArea( light ) : 1 );

	}

	if ( light.isPointLight || light.isSpotLight ) return light.intensity * 4 * Math.PI;

	return light.intensity;

}

/** Inverse of {@link lightPower} — what the panel writes back. */
export function setLightPower( light, watts ) {

	if ( light.isRectAreaLight ) {

		const normalize = light.userData?.normalize ?? true;
		const denominator = Math.PI * ( normalize ? areaLightArea( light ) : 1 );
		light.intensity = denominator > 0 ? watts / denominator : 0;
		return;

	}

	if ( light.isPointLight || light.isSpotLight ) {

		light.intensity = watts / ( 4 * Math.PI );
		return;

	}

	light.intensity = watts;

}

/**
 * Runs `mutate` with the light's Power held constant.
 *
 * Resizing a normalized area light is meant to keep its total power and change its radiance —
 * Blender's Normalize toggle. Since the stored quantity is radiance, that only happens if the
 * edit puts the Power back afterwards. With Normalize off, Power does not depend on the area,
 * so this is a no-op and the same call is still correct.
 */
export function preserveLightPower( light, mutate ) {

	const watts = lightPower( light );
	mutate();
	setLightPower( light, watts );

}

/**
 * Puts an area light's rectangle in world metres with unit scale, leaving its world size and
 * placement untouched.
 *
 * ⚠️ three.js' rasteriser reads `width`/`height` as WORLD dimensions and drops any scale inherited
 * from parent nodes — `RectAreaLightNode` builds the light's basis with `extractRotation`, which
 * normalises the scale away. A light authored as 70 units under a 0.01 node scale therefore rasters
 * as a **70 metre** panel while the path tracer, which uses the world matrix, renders the 0.7 m one
 * it should. Measured on 24001884.glb: 58.7x too bright in the raster view. Baking the scale in and
 * cancelling it on the light itself makes every reader agree.
 *
 * Idempotent: a light already at unit scale is left alone, so re-processing a tree is safe.
 */
export function bakeAreaLightScale( light ) {

	light.updateWorldMatrix( true, false );

	// Column lengths of the world matrix, read directly so this module needs no three.js import.
	const e = light.matrixWorld.elements;
	const sx = Math.hypot( e[ 0 ], e[ 1 ], e[ 2 ] );
	const sy = Math.hypot( e[ 4 ], e[ 5 ], e[ 6 ] );
	const sz = Math.hypot( e[ 8 ], e[ 9 ], e[ 10 ] );

	if ( ! Number.isFinite( sx ) || ! Number.isFinite( sy ) || sx === 0 || sy === 0 ) return;
	if ( Math.abs( sx - 1 ) < 1e-9 && Math.abs( sy - 1 ) < 1e-9 ) return;

	light.width = Math.abs( light.width * sx );
	light.height = Math.abs( light.height * sy );
	light.scale.set( light.scale.x / sx, light.scale.y / sy, sz === 0 ? light.scale.z : light.scale.z / sz );
	light.updateMatrixWorld( true );

}
