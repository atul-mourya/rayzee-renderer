import { Vector3, Quaternion } from 'three';
import { blackbodyToLinearRGB } from './blackbody.js';

// Point & spot lights specify Power in Watts; the shader uses radiant intensity
// (W/sr) as `intensity / dist²`, so convert with I = P / 4π (isotropic emitter),
// matching Blender. Area lights are already radiant power; the Sun is irradiance.
const INV_4PI = 1 / ( 4 * Math.PI );

// Effective emission colour + intensity after per-light Exposure (EV stops) and
// optional blackbody Temperature tint (Blender-style). Both fold into the values
// already sent to the GPU — no shader or struct change needed.
function effectiveEmission( light ) {

	const ud = light.userData || {};
	const exposure = Number.isFinite( ud.exposure ) ? ud.exposure : 0;
	const intensity = light.intensity * Math.pow( 2, exposure );

	let r = light.color.r, g = light.color.g, b = light.color.b;
	if ( ud.useTemperature ) {

		const [ tr, tg, tb ] = blackbodyToLinearRGB( ud.temperature ?? 6500 );
		r *= tr; g *= tg; b *= tb;

	}

	return { r, g, b, intensity };

}

export class LightSerializer {

	constructor() {

		this.lightData = {
			directional: [],
			rectArea: [],
			point: [],
			spot: []
		};

		// Cache for preprocessed lights
		this.directionalLightCache = [];
		this.areaLightCache = [];
		this.pointLightCache = [];
		this.spotLightCache = [];

	}

	clear() {

		this.lightData.directional = [];
		this.lightData.rectArea = [];
		this.lightData.point = [];
		this.lightData.spot = [];
		this.directionalLightCache = [];
		this.areaLightCache = [];
		this.pointLightCache = [];
		this.spotLightCache = [];

	}

	calculateLightImportance( light, type = 'directional' ) {

		// Calculate luminance-weighted importance
		const luminance = 0.2126 * light.color.r + 0.7152 * light.color.g + 0.0722 * light.color.b;
		let importance = light.intensity * luminance;

		// Area lights get additional importance based on size
		if ( type === 'area' ) {

			const area = light.width * light.height;
			importance *= Math.sqrt( area ); // Larger lights are more important

		} else if ( type === 'point' ) {

			// Point lights get additional importance based on range/distance falloff
			importance *= Math.sqrt( light.distance || 100.0 ); // Consider light range

		} else if ( type === 'spot' ) {

			// Spot lights get additional importance based on cone angle and range
			const coneMultiplier = Math.sin( light.angle || Math.PI / 4 ); // Wider cones are more important
			importance *= Math.sqrt( light.distance || 100.0 ) * coneMultiplier;

		}

		return importance;

	}

	addDirectionalLight( light ) {

		if ( ! light.visible ) return; // Skip hidden lights
		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		light.updateMatrixWorld();
		const position = light.getWorldPosition( new Vector3() );

		// Compute direction toward the light source.
		// Three.js convention: light shines from position toward target.
		// For shadow rays we need the reverse: direction from target toward position.
		let direction;
		if ( light.target ) {

			light.target.updateMatrixWorld();
			const targetPos = light.target.getWorldPosition( new Vector3() );
			direction = position.sub( targetPos ).normalize();

		} else {

			direction = position.normalize();

		}

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'directional' );

		// Get angle parameter from light (default to 0 for sharp shadows)
		const angle = light.userData.angle || light.angle || 0.0; // In radians

		const em = effectiveEmission( light );

		// Optional projection mask. Sign of intensity carries the inverted flag.
		const gobo = light.userData?.gobo;
		const goboIndex = ( gobo && Number.isInteger( gobo.index ) ) ? gobo.index : - 1;
		const rawIntensity = ( gobo && typeof gobo.intensity === 'number' ) ? gobo.intensity : 1.0;
		const goboIntensity = ( gobo && gobo.inverted ) ? - Math.abs( rawIntensity ) : Math.abs( rawIntensity );
		const goboScale = ( gobo && typeof gobo.scale === 'number' ) ? gobo.scale : 5.0;

		// Store in cache with importance
		this.directionalLightCache.push( {
			data: [
				direction.x, direction.y, direction.z, // direction toward light (3)
				em.r, em.g, em.b, // color (3) — incl. temperature tint
				em.intensity, // intensity (1) — incl. exposure
				angle, // angular diameter in radians (1)
				goboIndex, // gobo layer index, -1 = none (1)
				goboIntensity, // signed gobo strength (1)
				goboScale, // world units per gobo tile (1)
				0.0, // reserved (1) — padding to keep stride at 12
			],
			importance: importance,
			light: light
		} );

	}

	addRectAreaLight( light ) {

		if ( ! light.visible ) return; // Skip hidden lights
		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		light.updateMatrixWorld();

		const position = light.getWorldPosition( new Vector3() );
		const worldQuaternion = light.getWorldQuaternion( new Quaternion() );
		const worldScale = light.getWorldScale( new Vector3() );
		const width = light.width * worldScale.x * 0.5;
		const height = light.height * worldScale.y * 0.5;

		let u = new Vector3( width, 0, 0 ).applyQuaternion( worldQuaternion );
		let v = new Vector3( 0, - height, 0 ).applyQuaternion( worldQuaternion );

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'area' );

		// Blender-style emission controls (stored on userData; sensible defaults).
		// normalize ON → radiance ∝ 1/area (resizing keeps total power constant).
		const normalize = ( light.userData?.normalize ?? true ) ? 1.0 : 0.0;
		const spread = Number.isFinite( light.userData?.spread ) ? light.userData.spread : Math.PI;
		const shape = ( light.userData?.shape === 'ellipse' || light.userData?.shape === 'disk' || light.userData?.shape === 1 ) ? 1.0 : 0.0;

		const em = effectiveEmission( light );

		// Store in cache with importance (16 floats, vec4-aligned)
		this.areaLightCache.push( {
			data: [
				position.x, position.y, position.z, // position (3)
				u.x, u.y, u.z, // u half-vector (3)
				v.x, v.y, v.z, // v half-vector (3)
				em.r, em.g, em.b, // color (3) — incl. temperature tint
				em.intensity, // radiant power in Watts (1) — incl. exposure
				normalize, // power-normalize flag (1)
				spread, // emission spread in radians (1)
				shape, // 0 = rect, 1 = disk/ellipse (1)
			],
			importance: importance,
			light: light
		} );

	}

	addPointLight( light ) {

		if ( ! light.visible ) return; // Skip hidden lights
		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		light.updateMatrixWorld();

		const position = light.getWorldPosition( new Vector3() );

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'point' );

		const em = effectiveEmission( light );

		// Store in cache with importance
		this.pointLightCache.push( {
			data: [
				position.x, position.y, position.z, // position (3)
				em.r, em.g, em.b, // color (3) — incl. temperature tint
				em.intensity * INV_4PI, // radiant intensity W/sr = power(W)/4π, incl. exposure (1)
				light.distance || 0.0, // cutoff distance (0 = infinite) (1)
				light.decay !== undefined ? light.decay : 2.0 // decay exponent (1)
			],
			importance: importance,
			light: light
		} );

	}

	addSpotLight( light ) {

		if ( ! light.visible ) return; // Skip hidden lights
		if ( light.intensity <= 0.0 ) return; // Skip zero intensity lights

		light.updateMatrixWorld();

		const position = light.getWorldPosition( new Vector3() );
		const target = light.target ? light.target.getWorldPosition( new Vector3() ) : new Vector3( 0, 0, - 1 );
		const direction = target.sub( position ).normalize();

		// Calculate importance for sorting
		const importance = this.calculateLightImportance( light, 'spot' );

		// Optional projection mask ("gobo"). Sign of goboIntensity carries inverted flag.
		const gobo = light.userData?.gobo;
		const goboIndex = ( gobo && Number.isInteger( gobo.index ) ) ? gobo.index : - 1;
		const rawGoboIntensity = ( gobo && typeof gobo.intensity === 'number' ) ? gobo.intensity : 1.0;
		const goboIntensity = ( gobo && gobo.inverted ) ? - Math.abs( rawGoboIntensity ) : Math.abs( rawGoboIntensity );

		// Optional IES photometric profile. Stored on light.userData.ies by IESManager.
		const ies = light.userData?.ies;
		const iesIndex = ( ies && Number.isInteger( ies.index ) ) ? ies.index : - 1;
		const iesIntensity = ( ies && typeof ies.intensity === 'number' ) ? ies.intensity : 1.0;

		const em = effectiveEmission( light );

		// Store in cache with importance
		this.spotLightCache.push( {
			data: [
				position.x, position.y, position.z, // position (3)
				direction.x, direction.y, direction.z, // direction (3)
				em.r, em.g, em.b, // color (3) — incl. temperature tint
				em.intensity * INV_4PI, // radiant intensity W/sr = power(W)/4π, incl. exposure (1)
				light.angle || Math.PI / 4, // cone half-angle in radians (1)
				light.penumbra || 0.0, // penumbra [0,1] (1)
				light.distance || 0.0, // cutoff distance (0 = infinite) (1)
				light.decay !== undefined ? light.decay : 2.0, // decay exponent (1)
				goboIndex, // gobo layer index, -1 = none (1)
				goboIntensity, // signed gobo strength (1)
				iesIndex, // IES profile index, -1 = none (1)
				iesIntensity, // IES blend [0,1] (1)
				0.0, // reserved (1)
				0.0, // reserved (1) — keeps stride at 20 (vec4 aligned)
			],
			importance: importance,
			light: light
		} );

	}

	preprocessLights() {

		// Sort directional lights by importance (highest first)
		this.directionalLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Sort area lights by importance (highest first)
		this.areaLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Sort point lights by importance (highest first)
		this.pointLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Sort spot lights by importance (highest first)
		this.spotLightCache.sort( ( a, b ) => b.importance - a.importance );

		// Flatten sorted data arrays
		this.lightData.directional = [];
		this.lightData.rectArea = [];
		this.lightData.point = [];
		this.lightData.spot = [];

		this.directionalLightCache.forEach( lightCache => {

			this.lightData.directional.push( ...lightCache.data );

		} );

		this.areaLightCache.forEach( lightCache => {

			this.lightData.rectArea.push( ...lightCache.data );

		} );

		this.pointLightCache.forEach( lightCache => {

			this.lightData.point.push( ...lightCache.data );

		} );

		this.spotLightCache.forEach( lightCache => {

			this.lightData.spot.push( ...lightCache.data );

		} );

		if ( this.areaLightCache.length > 0 ) {

			console.log( `Preprocessed ${this.areaLightCache.length} area lights by importance` );

		}

		if ( this.pointLightCache.length > 0 ) {

			console.log( `Preprocessed ${this.pointLightCache.length} point lights by importance` );

		}

		if ( this.spotLightCache.length > 0 ) {

			console.log( `Preprocessed ${this.spotLightCache.length} spot lights by importance` );

		}

	}

	updateShaderUniforms( material ) {

		// Divide flat array lengths by per-light stride to get actual light counts
		const directionalCount = Math.floor( this.lightData.directional.length / 12 );
		const areaCount = Math.floor( this.lightData.rectArea.length / 16 );
		const pointCount = Math.floor( this.lightData.point.length / 9 );
		const spotCount = Math.floor( this.lightData.spot.length / 20 );

		// Update light counts in shader defines
		material.defines.MAX_DIRECTIONAL_LIGHTS = directionalCount;
		material.defines.MAX_AREA_LIGHTS = areaCount;
		material.defines.MAX_POINT_LIGHTS = pointCount;
		material.defines.MAX_SPOT_LIGHTS = spotCount;

		// Update uniforms with type arrays
		material.uniforms.directionalLights.value = new Float32Array( this.lightData.directional );
		material.uniforms.areaLights.value = new Float32Array( this.lightData.rectArea );
		material.uniforms.pointLights.value = new Float32Array( this.lightData.point );
		material.uniforms.spotLights.value = new Float32Array( this.lightData.spot );

		material.needsUpdate = true;

	}

	processSceneLights( scene, material ) {

		this.clear();

		// Collect all lights first
		scene.traverse( ( object ) => {

			if ( object.isDirectionalLight ) {

				this.addDirectionalLight( object );

			} else if ( object.isRectAreaLight ) {

				this.addRectAreaLight( object );

			} else if ( object.isPointLight ) {

				this.addPointLight( object );

			} else if ( object.isSpotLight ) {

				this.addSpotLight( object );

			}

		} );

		// Preprocess lights by importance
		this.preprocessLights();

		// Update shader uniforms
		this.updateShaderUniforms( material );

	}

	// Method to get light importance data for debugging
	getLightStatistics() {

		return {
			directionalLights: this.directionalLightCache.map( cache => ( {
				intensity: cache.light.intensity,
				importance: cache.importance,
				color: cache.light.color
			} ) ),
			areaLights: this.areaLightCache.map( cache => ( {
				intensity: cache.light.intensity,
				importance: cache.importance,
				color: cache.light.color,
				size: cache.light.width * cache.light.height
			} ) )
		};

	}

}
