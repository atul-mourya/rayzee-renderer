/**
 * Deterministic bench scene corpus.
 *
 * Every scene is built from three.js primitives and a procedural environment, so the
 * suite runs with no network access. This is deliberate: `app/public` contains only two
 * untracked .glb files, and every example model plus all 70 HDRIs are remote URLs on
 * assets.rayzee.atulmourya.com. A corpus depending on those would be slow, flaky offline,
 * and would silently change whenever the asset host does.
 *
 * Each scene pins one failure axis. Cameras are hardcoded rather than auto-framed so a
 * geometry tweak can never silently reframe a baseline.
 */

import {
	BoxGeometry,
	Color,
	CylinderGeometry,
	DataTexture,
	DirectionalLight,
	DoubleSide,
	Group,
	Matrix3,
	Mesh,
	MeshPhysicalMaterial,
	PlaneGeometry,
	RectAreaLight,
	RepeatWrapping,
	RGBAFormat,
	SphereGeometry,
	SRGBColorSpace,
	Vector3,
} from 'three';

import { generateMaterialSpheres } from '@/core/Processor/generateMaterialSpheres.js';

/** Shared render size. Small keeps goldens cheap and the suite fast. */
export const RENDER_SIZE = { width: 256, height: 256 };

// ── Builders ────────────────────────────────────────────────────

function makeRoom( { size = 6, emissiveCeiling = false } = {} ) {

	const room = new Group();
	const half = size / 2;

	// Cornell-ish box: white floor/ceiling/back, red left, green right.
	const walls = [
		{ color: 0xcccccc, pos: [ 0, - half, 0 ], rot: [ - Math.PI / 2, 0, 0 ] }, // floor
		{ color: 0xcccccc, pos: [ 0, half, 0 ], rot: [ Math.PI / 2, 0, 0 ] }, // ceiling
		{ color: 0xcccccc, pos: [ 0, 0, - half ], rot: [ 0, 0, 0 ] }, // back
		{ color: 0xcc2222, pos: [ - half, 0, 0 ], rot: [ 0, Math.PI / 2, 0 ] }, // left
		{ color: 0x22cc22, pos: [ half, 0, 0 ], rot: [ 0, - Math.PI / 2, 0 ] }, // right
	];

	for ( const wall of walls ) {

		const mesh = new Mesh(
			new PlaneGeometry( size, size ),
			new MeshPhysicalMaterial( { color: wall.color, roughness: 1, metalness: 0 } )
		);
		mesh.position.set( ...wall.pos );
		mesh.rotation.set( ...wall.rot );
		room.add( mesh );

	}

	if ( emissiveCeiling ) {

		const light = new Mesh(
			new PlaneGeometry( size * 0.3, size * 0.3 ),
			new MeshPhysicalMaterial( {
				color: 0x000000,
				emissive: 0xffffff,
				emissiveIntensity: 12,
				roughness: 1,
			} )
		);
		light.position.set( 0, half - 0.01, 0 );
		light.rotation.set( Math.PI / 2, 0, 0 );
		room.add( light );

	}

	return room;

}

function makeGlassRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.7, 48, 48 );

	// Varying IOR and roughness exercises TIR, the transmissive bounce cap and rough
	// refraction — the paths most likely to break when transmission code changes.
	const specs = [
		{ ior: 1.33, roughness: 0.0 },
		{ ior: 1.5, roughness: 0.0 },
		{ ior: 1.5, roughness: 0.15 },
		{ ior: 2.4, roughness: 0.0 },
	];

	specs.forEach( ( spec, index ) => {

		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0xffffff,
			transmission: 1,
			thickness: 1.4,
			ior: spec.ior,
			roughness: spec.roughness,
			metalness: 0,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.8, 0, 0 );
		group.add( mesh );

	} );

	// An opaque backdrop so refraction has something to bend.
	const backdrop = new Mesh(
		new BoxGeometry( 12, 6, 0.2 ),
		new MeshPhysicalMaterial( { color: 0x3366aa, roughness: 0.8, metalness: 0 } )
	);
	backdrop.position.set( 0, 0, - 3 );
	group.add( backdrop );

	return group;

}

function makeBackdrop( { color = 0x555555, roughness = 0.85 } = {} ) {

	const backdrop = new Mesh(
		new BoxGeometry( 14, 8, 0.2 ),
		new MeshPhysicalMaterial( { color, roughness, metalness: 0 } )
	);
	backdrop.position.set( 0, 0, - 3.2 );
	return backdrop;

}

/**
 * Random-walk subsurface scattering across the axes that select different code paths:
 * the entry lottery (weight < 1 falls through to the opaque BRDF), mean-free-path scale
 * (short = surface-like, long = deep transport that hits the step cap) and phase-function
 * anisotropy. Transmission stays 0 — SSS is deliberately independent of it.
 */
function makeSubsurfaceRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.85, 48, 48 );

	const specs = [
		{ weight: 0.4, radiusScale: 0.3, g: 0.0 },
		{ weight: 1.0, radiusScale: 1.0, g: 0.0 },
		{ weight: 1.0, radiusScale: 3.0, g: 0.4 },
	];

	specs.forEach( ( spec, index ) => {

		const material = new MeshPhysicalMaterial( {
			color: 0xf0e0d0,
			roughness: 0.35,
			metalness: 0,
		} );

		// Custom engine properties — MeshPhysicalMaterial has no notion of these, and
		// GeometryExtractor reads them straight off the material with `?? defaults`.
		material.subsurface = spec.weight;
		material.subsurfaceColor = new Color( 0xffd9c0 );
		material.subsurfaceRadius = [ 1.0, 0.35, 0.18 ]; // skin-like: red travels furthest
		material.subsurfaceRadiusScale = spec.radiusScale;
		material.subsurfaceAnisotropy = spec.g;

		const mesh = new Mesh( geometry, material );
		mesh.position.set( ( index - 1 ) * 2.1, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x303845 } ) );

	return group;

}

/**
 * Surface specular anisotropy. The first sphere is isotropic, which routes through the
 * `anisotropy > 0` guard's other branch — so one image covers both the anisotropic GGX
 * sampler/eval/PDF trio and the isotropic path it must not disturb. Rotations differ so a
 * tangent-frame regression shows as streaks pointing the wrong way rather than cancelling.
 */
function makeAnisotropyRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ anisotropy: 0.0, rotation: 0.0, roughness: 0.3 },
		{ anisotropy: 0.5, rotation: 0.0, roughness: 0.3 },
		{ anisotropy: 0.9, rotation: Math.PI / 4, roughness: 0.3 },
		{ anisotropy: 1.0, rotation: Math.PI / 2, roughness: 0.15 },
	];

	specs.forEach( ( spec, index ) => {

		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0xd8d8dd,
			metalness: 1,
			roughness: spec.roughness,
			anisotropy: spec.anisotropy,
			anisotropyRotation: spec.rotation,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.9, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x6a5540, roughness: 0.6 } ) );

	return group;

}

/**
 * Objects resting exactly on y = 0 plus a sun. The catcher plane is analytic (no geometry),
 * and its height is auto-seeded to the scene's min-Y on load — so every object's lowest
 * point sits on the plane and the shadows are contact shadows.
 */
function makeCatcherRig() {

	const group = new Group();

	const sphere = new Mesh(
		new SphereGeometry( 0.9, 48, 48 ),
		new MeshPhysicalMaterial( { color: 0xcc4444, roughness: 0.4, metalness: 0 } )
	);
	sphere.position.set( - 1.8, 0.9, 0 );
	group.add( sphere );

	const box = new Mesh(
		new BoxGeometry( 1.4, 1.8, 1.4 ),
		new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.8, metalness: 0 } )
	);
	box.position.set( 0.6, 0.9, - 0.6 );
	box.rotation.set( 0, 0.5, 0 );
	group.add( box );

	const post = new Mesh(
		new CylinderGeometry( 0.35, 0.35, 2.4, 32 ),
		new MeshPhysicalMaterial( { color: 0x4477cc, roughness: 0.25, metalness: 0.9 } )
	);
	post.position.set( 2.6, 1.2, 0.4 );
	group.add( post );

	// A hard light source: the catcher's shadow ratio is an irradiance-weighted NEE dual sum,
	// and a directional light gives it a crisp edge that env-only lighting would wash out.
	const sun = new DirectionalLight( 0xffffff, 3.5 );
	sun.position.set( 4, 6, 3 ); // default target is the origin, so this aims down-and-left
	group.add( sun );

	return group;

}

/**
 * Chromatic transmission. Dispersion enters the sampler by two different doors: at roughness
 * <= 0.05 it takes the perfect-refraction path with a spectral IOR, and above that it forces
 * the microfacet path — which a smooth surface would otherwise skip. The first sphere keeps
 * dispersion at 0, so the achromatic branch is covered by the same image.
 */
function makeDispersionRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ dispersion: 0.0, roughness: 0.0 },
		{ dispersion: 0.4, roughness: 0.0 },
		{ dispersion: 1.0, roughness: 0.0 },
		{ dispersion: 1.0, roughness: 0.12 },
	];

	specs.forEach( ( spec, index ) => {

		// IOR well above 1.5: the Cauchy term is 0.03 * dispersion / λ², so a low base IOR
		// separates the wavelengths too little to survive tone mapping at 8 bits.
		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0xffffff,
			transmission: 1,
			thickness: 1.2,
			ior: 1.62,
			dispersion: spec.dispersion,
			roughness: spec.roughness,
			metalness: 0,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.85, 0.15, 0 );
		group.add( mesh );

	} );

	// A high-contrast checkerboard directly behind the spheres. Dispersion is a wavelength-
	// dependent refraction ANGLE, so it shows as colour fringing wherever a sharp edge is seen
	// through the glass — the checker supplies those edges everywhere in the disk.
	//
	// Deliberately MONOCHROME: with a grey backdrop and a grey-blue gradient sky, any saturated
	// hue inside a sphere can only have come from wavelength separation. A coloured backdrop
	// makes the same fringing impossible to distinguish from refracted backdrop colour.
	//
	// The obvious alternative, a chromatic caustic thrown onto a floor by a bright sun, was
	// tried first and abandoned: it is an SDS path, and its variance left the 96-sample render
	// 1.4 % off its own 1024-sample reference in mean luminance, tripping the energy-bias gate
	// on a scene with nothing wrong with it. Direct refraction converges fine.
	const backdrop = new Mesh(
		new PlaneGeometry( 18, 12 ),
		new MeshPhysicalMaterial( {
			map: makeCheckerAlbedo( 128, 6, [ 236, 236, 236 ], [ 26, 26, 26 ] ),
			roughness: 0.85,
			metalness: 0,
		} )
	);
	backdrop.position.set( 0, 0, - 2.6 );
	group.add( backdrop );

	return group;

}

/**
 * Thin-film iridescence. With no thickness map the shader reads the RANGE'S MAX, so the sweep
 * is over `iridescenceThicknessRange[ 1 ]` — varying the min would change nothing. The first
 * sphere sits at iridescence 0 because `iridescence === 0` selects a separate fast path in the
 * material response, and covering only the enabled side would leave that one untested.
 */
function makeIridescenceRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ iridescence: 0.0, thickness: 400, ior: 1.3, metalness: 0 },
		{ iridescence: 1.0, thickness: 220, ior: 1.3, metalness: 0 },
		{ iridescence: 1.0, thickness: 620, ior: 1.9, metalness: 0 },
		{ iridescence: 0.6, thickness: 900, ior: 2.3, metalness: 1 },
	];

	specs.forEach( ( spec, index ) => {

		// Near-black and smooth: iridescence only modulates F0, so over a bright diffuse base
		// the hue shift is swamped by the base colour.
		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0x14141a,
			roughness: 0.1,
			metalness: spec.metalness,
			iridescence: spec.iridescence,
			iridescenceIOR: spec.ior,
			iridescenceThicknessRange: [ 100, spec.thickness ],
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.85, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x1a1a20, roughness: 0.45 } ) );

	return group;

}

/**
 * Sheen — the retroreflective fabric lobe, plus the energy-conserving attenuation it applies
 * to the base layer underneath.
 *
 * Two things are easy to get wrong. `sheenColor` defaults to BLACK, so `sheen > 0` with the
 * default colour renders identically to no sheen at all; and the shader clamps `sheenRoughness`
 * up to 0.05 (below that the sampler and PDF disagree), so 0 is not a distinct case and 0.05
 * is the real low end.
 */
function makeSheenRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ sheen: 0.0, sheenRoughness: 0.3, sheenColor: 0xffd0a0 },
		{ sheen: 1.0, sheenRoughness: 0.06, sheenColor: 0xffd0a0 },
		{ sheen: 1.0, sheenRoughness: 0.5, sheenColor: 0xa0c8ff },
		{ sheen: 0.6, sheenRoughness: 0.95, sheenColor: 0xffffff },
	];

	specs.forEach( ( spec, index ) => {

		// Dark, rough base — velvet. The sheen lobe is then most of the outgoing radiance, so
		// a regression in it cannot hide behind the diffuse term.
		const material = new MeshPhysicalMaterial( {
			color: 0x141018,
			roughness: 0.85,
			metalness: 0,
			sheen: spec.sheen,
			sheenRoughness: spec.sheenRoughness,
		} );
		material.sheenColor = new Color( spec.sheenColor );

		const mesh = new Mesh( geometry, material );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.85, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x24282e, roughness: 0.7 } ) );

	return group;

}

/**
 * Clearcoat over a rough coloured base — car paint. The coat reflects sharply where the base
 * does not, so a broken coat shows as a missing highlight rather than a slightly different one.
 *
 * The weights straddle 0.5 deliberately: `classifyMaterial` sets its `hasClearcoat` flag at
 * `clearcoat > 0.5`, which selects a different lobe-importance multiplier. Both sides of that
 * threshold are present, so a change to the classification cannot pass unnoticed.
 */
function makeClearcoatRow() {

	const group = new Group();
	const geometry = new SphereGeometry( 0.8, 48, 48 );

	const specs = [
		{ clearcoat: 0.0, clearcoatRoughness: 0.0 },
		{ clearcoat: 0.4, clearcoatRoughness: 0.05 },
		{ clearcoat: 1.0, clearcoatRoughness: 0.0 },
		{ clearcoat: 1.0, clearcoatRoughness: 0.4 },
	];

	specs.forEach( ( spec, index ) => {

		const mesh = new Mesh( geometry, new MeshPhysicalMaterial( {
			color: 0x8c1f22,
			roughness: 0.65,
			metalness: 0.15,
			clearcoat: spec.clearcoat,
			clearcoatRoughness: spec.clearcoatRoughness,
		} ) );
		mesh.position.set( ( index - ( specs.length - 1 ) / 2 ) * 1.85, 0, 0 );
		group.add( mesh );

	} );

	group.add( makeBackdrop( { color: 0x3a4048, roughness: 0.5 } ) );

	return group;

}

// ── Procedural textures ─────────────────────────────────────────
//
// Integer/trig arithmetic only — never Math.random. A texture whose bytes changed between
// runs would silently invalidate every baseline that depends on it.
//
// Sizes differ deliberately: material maps are packed into size-bucketed texture arrays,
// so three distinct dimensions exercise three buckets and the per-bucket index remap.

function makeCheckerAlbedo( size = 128, cells = 8, light = [ 222, 96, 48 ], dark = [ 34, 142, 204 ] ) {

	const data = new Uint8Array( size * size * 4 );
	const cell = size / cells;

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			const rgb = ( Math.floor( x / cell ) + Math.floor( y / cell ) ) % 2 === 0 ? light : dark;
			const i = ( y * size + x ) * 4;
			data[ i ] = rgb[ 0 ];
			data[ i + 1 ] = rgb[ 1 ];
			data[ i + 2 ] = rgb[ 2 ];
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;

}

/** Tangent-space normals from an analytic sinusoidal height field. */
function makeBumpNormal( size = 64, bumps = 5, amplitude = 0.35 ) {

	const data = new Uint8Array( size * size * 4 );
	const k = 2 * Math.PI * bumps;

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			const u = x / size;
			const v = y / size;

			// h = A sin(k u) sin(k v)  ⇒  N = normalize( -∂h/∂u, -∂h/∂v, 1 )
			const dhdu = amplitude * k * Math.cos( k * u ) * Math.sin( k * v );
			const dhdv = amplitude * k * Math.sin( k * u ) * Math.cos( k * v );
			const len = Math.hypot( dhdu, dhdv, 1 );

			const i = ( y * size + x ) * 4;
			data[ i ] = Math.round( ( - dhdu / len * 0.5 + 0.5 ) * 255 );
			data[ i + 1 ] = Math.round( ( - dhdv / len * 0.5 + 0.5 ) * 255 );
			data[ i + 2 ] = Math.round( ( 1 / len * 0.5 + 0.5 ) * 255 );
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.needsUpdate = true;
	return texture;

}

/** Roughness stripes. Written to G because that is the channel the sampler reads (glTF ORM). */
function makeStripeRoughness( size = 256, stripes = 12 ) {

	const data = new Uint8Array( size * size * 4 );
	const period = size / stripes;

	for ( let y = 0; y < size; y ++ ) {

		const t = Math.floor( y / period ) % 2 === 0 ? 0.12 : 0.9;
		const byte = Math.round( t * 255 );

		for ( let x = 0; x < size; x ++ ) {

			const i = ( y * size + x ) * 4;
			data[ i ] = byte;
			data[ i + 1 ] = byte;
			data[ i + 2 ] = byte;
			data[ i + 3 ] = 255;

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.needsUpdate = true;
	return texture;

}

/**
 * Alpha in the ALPHA channel only — RGB is constant across the whole texture. A regression
 * that samples the wrong channel therefore renders a solid quad, not a subtly wrong one.
 *
 * The ramp is radial per cell rather than binary, so two meshes sharing this one texture at
 * different `alphaTest` cutoffs cut holes of different sizes. A cutoff that is read but then
 * ignored looks identical on both, and that is exactly what has to be distinguishable.
 */
function makeAlphaRampAlbedo( size = 128, cells = 4 ) {

	const data = new Uint8Array( size * size * 4 );
	const cell = size / cells;

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			const cx = ( Math.floor( x / cell ) + 0.5 ) * cell;
			const cy = ( Math.floor( y / cell ) + 0.5 ) * cell;
			const d = Math.hypot( x - cx, y - cy ) / ( cell * 0.5 );

			const i = ( y * size + x ) * 4;
			data[ i ] = 214;
			data[ i + 1 ] = 176;
			data[ i + 2 ] = 74;
			data[ i + 3 ] = Math.round( Math.min( 1, d ) * 255 );

		}

	}

	const texture = new DataTexture( data, size, size, RGBAFormat );
	texture.colorSpace = SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;

}

/**
 * Textured geometry across three UV shapes. A non-identity repeat/offset is applied so a
 * texture-matrix regression (the offset.y flip is a bug this repo has already had) shows up
 * as shifted detail rather than passing unnoticed at repeat 1 / offset 0.
 */
function makeTexturedRig() {

	const group = new Group();

	const map = makeCheckerAlbedo();
	const normalMap = makeBumpNormal();
	const roughnessMap = makeStripeRoughness();

	for ( const texture of [ map, normalMap, roughnessMap ] ) {

		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;
		texture.repeat.set( 3, 2 );
		texture.offset.set( 0.15, 0.35 );

	}

	const material = new MeshPhysicalMaterial( {
		map,
		normalMap,
		roughnessMap,
		roughness: 1,
		metalness: 0,
	} );
	material.normalScale.set( 0.8, 0.8 );

	const sphere = new Mesh( new SphereGeometry( 1.1, 64, 48 ), material );
	sphere.position.set( - 1.9, 0.2, 0 );
	group.add( sphere );

	const box = new Mesh( new BoxGeometry( 1.8, 1.8, 1.8 ), material );
	box.position.set( 1.3, 0.1, 0.3 );
	box.rotation.set( 0.3, 0.6, 0 );
	group.add( box );

	const floor = new Mesh( new PlaneGeometry( 12, 12 ), material );
	floor.position.set( 0, - 1.3, 0 );
	floor.rotation.set( - Math.PI / 2, 0, 0 );
	group.add( floor );

	return group;

}

/**
 * Both alpha modes the extractor can produce, lit so each is evaluated twice: once on the
 * camera ray and once on a shadow ray, which is a separate implementation with its own cutoff
 * comparison.
 *
 * MASK (`alphaTest > 0`) at two cutoffs over one shared texture, and BLEND (`transparent` with
 * `opacity < 1`), which attenuates transmittance rather than cutting it. The quads are
 * DoubleSide on purpose — whether a single-sided surface blocks shadow rays is a separate open
 * question in this repo, and mixing it in would make a failure here ambiguous.
 *
 * The sun is deliberately much brighter than the scene needs, and the environment is dimmed to
 * 0.3 in the scene settings. At equal weight the ambient fills the cutout shadows almost
 * completely: turning `enableAlphaShadows` off then moved only 0.8 % of pixels, under the 1 %
 * gate, so the shadow-ray half of this scene was barely tested at all.
 */
function makeAlphaCutoutRig() {

	const group = new Group();
	const map = makeAlphaRampAlbedo();

	[ 0.3, 0.75 ].forEach( ( alphaTest, index ) => {

		const quad = new Mesh(
			new PlaneGeometry( 2.6, 2.6 ),
			new MeshPhysicalMaterial( {
				map,
				alphaTest,
				side: DoubleSide,
				roughness: 0.6,
				metalness: 0,
			} )
		);
		quad.position.set( index === 0 ? - 1.8 : 1.8, 0.5, 0 );
		group.add( quad );

	} );

	const blend = new Mesh(
		new PlaneGeometry( 2.2, 2.2 ),
		new MeshPhysicalMaterial( {
			color: 0x66ccff,
			transparent: true,
			opacity: 0.45,
			side: DoubleSide,
			roughness: 0.25,
			metalness: 0,
		} )
	);
	blend.position.set( 0, 0.3, 1.6 );
	blend.rotation.set( 0, 0.25, 0 );
	group.add( blend );

	const floor = new Mesh(
		new PlaneGeometry( 16, 16 ),
		new MeshPhysicalMaterial( { color: 0xbfbfbf, roughness: 0.9, metalness: 0 } )
	);
	floor.position.set( 0, - 1, 0 );
	floor.rotation.set( - Math.PI / 2, 0, 0 );
	group.add( floor );

	const sun = new DirectionalLight( 0xffffff, 10 );
	sun.position.set( 3, 6, 4 );
	group.add( sun );

	return group;

}

/**
 * Deformable sphere + rigidly-moved box + static floor, built at the pose the BVH is
 * constructed from. deformToPoseB() then moves it, and the scene refits rather than
 * rebuilding — which is the whole point of the scene.
 */
function makeRefitRig() {

	const group = new Group();

	const blob = new Mesh(
		new SphereGeometry( 1.3, 64, 48 ),
		new MeshPhysicalMaterial( { color: 0xdd8844, roughness: 0.35, metalness: 0.1 } )
	);
	blob.name = 'blob';
	blob.position.set( - 1.7, 0.2, 0 );
	group.add( blob );

	const box = new Mesh(
		new BoxGeometry( 1.5, 1.5, 1.5 ),
		new MeshPhysicalMaterial( { color: 0x88aacc, roughness: 0.2, metalness: 0.8 } )
	);
	box.name = 'box';
	box.position.set( 1.9, - 0.4, - 0.3 );
	group.add( box );

	const floor = new Mesh(
		new PlaneGeometry( 14, 14 ),
		new MeshPhysicalMaterial( { color: 0xaaaaaa, roughness: 0.9, metalness: 0 } )
	);
	floor.position.set( 0, - 2, 0 );
	floor.rotation.set( - Math.PI / 2, 0, 0 );
	group.add( floor );

	return group;

}

/**
 * Pose B: a vertex deformation (grows the blob's BLAS bounds) plus a rigid transform (moves
 * the box's world AABB, so the TLAS must change too). Two different refit failure modes, one
 * render — a BLAS that keeps stale bounds and a TLAS that keeps a stale leaf AABB both
 * manifest as rays missing geometry they should hit.
 */
function deformToPoseB( group ) {

	const blob = group.getObjectByName( 'blob' );
	const position = blob.geometry.attributes.position;
	const normal = blob.geometry.attributes.normal;
	const v = new Vector3();
	const n = new Vector3();

	for ( let i = 0; i < position.count; i ++ ) {

		v.fromBufferAttribute( position, i );
		n.fromBufferAttribute( normal, i );

		const displacement = 0.42 * Math.sin( 3.1 * v.x ) * Math.cos( 2.7 * v.y ) + 0.18 * Math.sin( 4.3 * v.z );
		v.addScaledVector( n, displacement );
		position.setXYZ( i, v.x, v.y, v.z );

	}

	position.needsUpdate = true;
	blob.geometry.computeVertexNormals();

	const box = group.getObjectByName( 'box' );
	box.position.set( 2.3, 0.7, 0.6 );
	box.rotation.set( 0.4, 0.7, 0.25 );

}

/**
 * World-space triangle buffers in exactly the layout `PathTracerApp.refitBVH()` expects:
 * 9 floats per triangle, meshes in `app.sceneMeshes` order, triangles in index order,
 * positions through matrixWorld and normals through the normal matrix.
 *
 * Mirrors GeometryExtractor.extractTrianglesInBatch rather than reusing it, because that
 * runs once at load time against the pre-deformation geometry.
 *
 * Reads `app.sceneMeshes` rather than walking the rig, and that distinction is the whole
 * reason this scene is worth having: the engine also owns a hidden ground-projection disk
 * that lands FIRST in the buffer, so a rig-only walk is both 32 triangles short and offset
 * by 32 for everything after it.
 */
function extractWorldTriangles( app ) {

	// One scene-wide pass: per-mesh updateMatrixWorld() reads a possibly-stale parent matrix.
	app.meshScene.updateMatrixWorld( true );

	const meshes = app.sceneMeshes;

	const triangleCountOf = ( geometry ) => (
		geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3
	);

	let total = 0;
	for ( const mesh of meshes ) total += triangleCountOf( mesh.geometry );

	const positions = new Float32Array( total * 9 );
	const normals = new Float32Array( total * 9 );
	const v = new Vector3();
	const n = new Vector3();
	const normalMatrix = new Matrix3();
	let out = 0;

	for ( const mesh of meshes ) {

		const geometry = mesh.geometry;
		const position = geometry.attributes.position;
		const normal = geometry.attributes.normal;
		const index = geometry.index;
		const count = triangleCountOf( geometry );

		normalMatrix.getNormalMatrix( mesh.matrixWorld );

		for ( let t = 0; t < count; t ++ ) {

			for ( let corner = 0; corner < 3; corner ++ ) {

				const i = index ? index.getX( t * 3 + corner ) : t * 3 + corner;

				v.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
				positions[ out ] = v.x;
				positions[ out + 1 ] = v.y;
				positions[ out + 2 ] = v.z;

				n.fromBufferAttribute( normal, i ).applyMatrix3( normalMatrix ).normalize();
				normals[ out ] = n.x;
				normals[ out + 1 ] = n.y;
				normals[ out + 2 ] = n.z;

				out += 3;

			}

		}

	}

	return { positions, normals };

}

// ── Scene corpus ────────────────────────────────────────────────

/**
 * @typedef {Object} SceneSpec
 * @property {string} id
 * @property {string} covers        - the failure axis this scene pins
 * @property {number} spp           - samples for the regression render
 * @property {number} truthSpp      - samples for the one-time ground-truth render
 * @property {Object} settings      - engine settings applied before rendering
 * @property {function} build       - async (app) => void; loads geometry + env, sets camera
 * @property {number} [furnaceRadiance] - marks a white-furnace scene and gives the environment
 *      radiance the render must reproduce exactly. See FURNACE_MATERIALS.
 */

/** @type {SceneSpec[]} */
export const SCENES = [
	{
		id: 'spheres-gradient',
		covers: 'diffuse GI, GGX metal/rough response, gradient environment importance sampling',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( generateMaterialSpheres(), 'spheres' );
			setCamera( app, [ 0, 0, 9 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'cornell-emissive',
		covers: 'emissive-triangle NEE, MIS weighting, colour bleeding across bounces',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 6, enableEmissiveTriangleSampling: true, enableEnvironment: false },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'color' );

			const scene = makeRoom( { emissiveCeiling: true } );
			const ball = new Mesh(
				new SphereGeometry( 1, 48, 48 ),
				new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.25, metalness: 0 } )
			);
			ball.position.set( - 1.1, - 2, 0.4 );
			scene.add( ball );

			const box = new Mesh(
				new BoxGeometry( 1.6, 3, 1.6 ),
				new MeshPhysicalMaterial( { color: 0xdddddd, roughness: 0.9, metalness: 0 } )
			);
			box.position.set( 1.3, - 1.5, - 0.8 );
			box.rotation.set( 0, 0.4, 0 );
			scene.add( box );

			await app.loadObject3D( scene, 'cornell' );
			setCamera( app, [ 0, 0, 8.5 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'glass-transmission',
		covers: 'transmission, TIR, IOR sweep, transmissive bounce cap, rough refraction',
		spp: 96,
		truthSpp: 2048,
		settings: { maxBounces: 6, transmissiveBounces: 8 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeGlassRow(), 'glass' );
			setCamera( app, [ 0, 0.6, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'spheres-procedural-sky',
		covers: 'procedural sky evaluation and environment CDF importance sampling',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( generateMaterialSpheres( 3, 3, 1.6 ), 'spheres-sky' );
			setCamera( app, [ 0, 0, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'subsurface-marble',
		covers: 'random-walk subsurface scattering — chromatic collision sampling, Henyey-Greenstein phase, medium stack push/pop, step cap',
		spp: 96,
		// Lower than the rest of the corpus: SSS paths walk many steps inside the medium, so
		// each sample costs several times a diffuse one. 1024 still leaves the truth reference
		// far more converged than the 96-sample render it is measured against.
		truthSpp: 1024,
		settings: { maxBounces: 6, maxSubsurfaceSteps: 32 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeSubsurfaceRow(), 'subsurface' );
			setCamera( app, [ 0, 0.3, 6.5 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'anisotropy-brushed',
		covers: 'surface specular anisotropy — anisotropic GGX sampler/eval/PDF agreement across tangent rotations, plus the isotropic path',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			// Procedural sky rather than a smooth gradient: anisotropic highlights need
			// structure in the environment to smear into a streak.
			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( makeAnisotropyRow(), 'anisotropy' );
			setCamera( app, [ 0, 0.4, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'shadow-catcher-ground',
		covers: 'analytic ground-plane shadow catcher — NEE dual-sum shadow ratio, coverage gate, directional-light occlusion',
		spp: 64,
		truthSpp: 2048,
		// groundCatcherHeight is listed even though the engine overwrites it on load
		// (auto-seeded to the scene's min-Y): every settings key any scene touches has to
		// appear here, or sceneSettingsFloor() will not reset it for the scenes that follow.
		settings: { maxBounces: 4, enableGroundCatcher: true, groundCatcherHeight: 0 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeCatcherRig(), 'catcher' );
			setCamera( app, [ 0, 2.4, 9 ], [ 0, 0.6, 0 ] );

		},
	},
	{
		id: 'textured-normalmap',
		covers: 'material texture arrays — albedo/normal/roughness sampling, size buckets, RepeatWrapping, non-identity UV transform, normalScale',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeTexturedRig(), 'textured' );
			setCamera( app, [ 0, 0.8, 7.5 ], [ 0, - 0.2, 0 ] );

		},
	},
	{
		id: 'refit-deform',
		covers: 'BVH refit — BLAS bound recomputation after vertex deformation and TLAS update after a rigid move',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );

			await app.loadObject3D( makeRefitRig(), 'refit' );

			// Move to pose B and refit, rather than building at pose B. Building there would
			// exercise a fresh SAH build — the one path this scene exists NOT to test.
			// Poses `app.sceneModel`, not the rig: loadObject3D() renders a copy of what it is given.
			deformToPoseB( app.sceneModel );
			const { positions, normals } = extractWorldTriangles( app );
			await app.refitBVH( positions, normals );

			setCamera( app, [ 0, 1.2, 8 ], [ 0, - 0.2, 0 ] );

		},
	},
	{
		id: 'dispersion-glass',
		covers: 'chromatic dispersion — Cauchy spectral IOR, per-path wavelength locking, spectral vs microfacet refraction entry, achromatic branch',
		spp: 96,
		// Halved like subsurface-marble: every dispersive path re-samples a wavelength and
		// refracts through several transmissive bounces, so a sample costs multiples of a
		// diffuse one. 1024 still leaves the reference far ahead of the 96-sample render.
		truthSpp: 1024,
		settings: { maxBounces: 6, transmissiveBounces: 8 },
		async build( app ) {

			// Gradient, not the procedural sky: the sky's sun is what turned this scene into a
			// caustic-variance problem. The contrast dispersion needs comes from the checkered
			// backdrop instead, which costs no variance at all.
			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeDispersionRow(), 'dispersion' );
			setCamera( app, [ 0, 0.7, 6.8 ], [ 0, - 0.1, 0 ] );

		},
	},
	{
		id: 'iridescence-thinfilm',
		covers: 'thin-film iridescence — Airy-term F0 modulation across film thickness and film IOR, over dielectric and metal bases',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( makeIridescenceRow(), 'iridescence' );
			setCamera( app, [ 0, 0.4, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'sheen-velvet',
		covers: 'sheen lobe — sheen distribution across roughness, coloured sheen, energy-conserving base-layer attenuation',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( makeSheenRow(), 'sheen' );
			setCamera( app, [ 0, 0.4, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'clearcoat-carpaint',
		covers: 'clearcoat layer — coat Fresnel and coat roughness over a rough base, plus the clearcoat > 0.5 lobe-importance threshold',
		spp: 64,
		truthSpp: 2048,
		settings: { maxBounces: 4 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'procedural' );
			await app.loadObject3D( makeClearcoatRow(), 'clearcoat' );
			setCamera( app, [ 0, 0.4, 7 ], [ 0, 0, 0 ] );

		},
	},
	{
		id: 'alpha-cutout',
		covers: 'alpha MASK and BLEND — texture-alpha cutoff on camera and shadow rays, transmittance attenuation, opaque-blocker fast path',
		spp: 64,
		truthSpp: 2048,
		// enableAlphaShadows defaults OFF and only the production config turns it on, so
		// without it here the shadow-ray half of this scene silently does not run. The dimmed
		// environment is what makes that half a strong signal rather than a marginal one — see
		// makeAlphaCutoutRig.
		settings: { maxBounces: 4, enableAlphaShadows: true, environmentIntensity: 0.3 },
		async build( app ) {

			await app.stages.pathTracer.environment.setMode( 'gradient' );
			await app.loadObject3D( makeAlphaCutoutRig(), 'alpha-cutout' );
			setCamera( app, [ 0, 1.6, 7.5 ], [ 0, 0.1, 0 ] );

		},
	},
];

// -----------------------------------------------------------------------------
// White furnace scenes
// -----------------------------------------------------------------------------
// An albedo-1 sphere in a uniform environment of radiance L must render EXACTLY L — the
// object becomes invisible. Any deviation is energy the BSDF created or destroyed.
//
// These exist because the ENERGY BIAS gate structurally cannot catch this class of bug.
// That gate compares mean luminance against a blessed high-spp render of the same build, so
// a systematic energy error appears in both the reference and the render and cancels: the
// ratio reads ~1.0 and the gate passes forever. The furnace reference is analytic — a
// constant this file declares — so no amount of blessing can move it.
//
// The sphere is convex and fills the frame, which makes the measurement clean in two ways:
// every pixel is object (no background diluting the mean toward 1.0), and a scattered ray
// always escapes to the environment rather than re-hitting the sphere, so the result is the
// BSDF's own directional albedo and not a multi-bounce sum. 4 bounces is ample.
//
// NOTE: solidSkyColor is NOT a routed setting, so it does not participate in
// sceneSettingsFloor() and stays white for any scene loaded afterwards. These scenes are
// last in the corpus for that reason. The only other 'color'-mode scene is cornell-emissive,
// which renders with enableEnvironment: false, so the leak cannot reach its output.

const FURNACE_RADIANCE = 1.0;

/** Each entry pins one energy-conservation axis. */
const FURNACE_MATERIALS = {
	// Control. Lambert is exactly energy conserving, so this must stay at 1.0 — it fails only
	// if the harness itself breaks (environment not uniform, albedo not 1, camera clipping).
	'furnace-diffuse': { roughness: 1.0, metalness: 0 },

	// Dielectric specular. Any mismatch between the sampler's density and the density MIS
	// evaluates shows up here and scales inversely with roughness, so a low roughness is the
	// sensitive probe.
	'furnace-dielectric-glossy': { roughness: 0.15, metalness: 0 },

	// Metal, two points that fail in opposite directions when the multiscatter compensation is
	// miscalibrated: it overshoots around mid roughness while r = 1 shows the single-scattering
	// GGX deficit. One point alone would let a bad refit trade one for the other.
	'furnace-metal-mid': { roughness: 0.5, metalness: 1 },
	'furnace-metal-rough': { roughness: 1.0, metalness: 1 },

	// Layered lobes, each with its own energy term on top of the base.
	'furnace-clearcoat': { roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.3 },
	'furnace-sheen': { roughness: 0.6, metalness: 0, sheen: 1, sheenRoughness: 0.4, sheenColor: 0xffffff },
	'furnace-iridescence': {
		roughness: 0.3, metalness: 0,
		iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [ 100, 400 ],
	},
};

for ( const [ id, params ] of Object.entries( FURNACE_MATERIALS ) ) {

	SCENES.push( {
		id,
		covers: `white furnace — energy conservation of ${id.slice( 8 )}`,
		// The gated quantity is a mean over 65k pixels of a flat image, which converges far
		// faster than the image itself; the reference is analytic, so truthSpp only feeds the
		// (redundant here) golden and bias gates.
		spp: 128,
		truthSpp: 512,
		// environmentIntensity is pinned because the analytic reference below assumes it.
		settings: { maxBounces: 4, enableEnvironment: true, environmentIntensity: 1 },
		furnaceRadiance: FURNACE_RADIANCE,
		async build( app ) {

			const env = app.stages.pathTracer.environment;
			env.envParams.solidSkyColor = new Color( 0xffffff );
			await env.setMode( 'color' );

			const group = new Group();
			group.add( new Mesh(
				new SphereGeometry( 2, 96, 96 ),
				new MeshPhysicalMaterial( { color: 0xffffff, ...params } )
			) );
			await app.loadObject3D( group, id );

			// Close enough that the sphere covers the full frame — see the note above.
			setCamera( app, [ 0, 0, 2.6 ], [ 0, 0, 0 ] );

		},
	} );

}

// Every furnace scene above is a CONVEX sphere: a scattered ray escapes to the environment
// immediately, so those gates only ever measure single-scatter directional albedo. This one is
// concave, so radiance has to survive many inter-reflections — equilibrium radiance in a uniform
// env of radiance L over albedo-1 surfaces is exactly L for ANY geometry. It is the only scene in
// the corpus that can see a multi-bounce transport leak (Russian-roulette compensation, NEE/MIS
// under occlusion); shipping RR read 0.955 here while every convex furnace read 0.998+.
SCENES.push( {
	id: 'furnace-multibounce',
	covers: 'white furnace — multi-bounce transport (RR compensation, NEE/MIS under occlusion)',
	spp: 128,
	truthSpp: 512,
	// High enough that truncation of the albedo-1 Neumann series is below the gate's resolution:
	// the deficit is flat from 32 bounces on, so anything left is transport error.
	settings: { maxBounces: 32, enableEnvironment: true, environmentIntensity: 1 },
	furnaceRadiance: 1.0,
	async build( app ) {

		const env = app.stages.pathTracer.environment;
		env.envParams.solidSkyColor = new Color( 0xffffff );
		await env.setMode( 'color' );

		const size = 6, half = size / 2;
		const room = new Group();
		const walls = [
			{ pos: [ 0, - half, 0 ], rot: [ - Math.PI / 2, 0, 0 ] },
			{ pos: [ 0, half, 0 ], rot: [ Math.PI / 2, 0, 0 ] },
			{ pos: [ 0, 0, - half ], rot: [ 0, 0, 0 ] },
			{ pos: [ - half, 0, 0 ], rot: [ 0, Math.PI / 2, 0 ] },
			{ pos: [ half, 0, 0 ], rot: [ 0, - Math.PI / 2, 0 ] },
		];

		for ( const wall of walls ) {

			const mesh = new Mesh(
				new PlaneGeometry( size, size ),
				new MeshPhysicalMaterial( { color: 0xffffff, roughness: 1, metalness: 0 } )
			);
			mesh.position.set( ...wall.pos );
			mesh.rotation.set( ...wall.rot );
			room.add( mesh );

		}

		await app.loadObject3D( room, 'furnace-multibounce' );
		setCamera( app, [ 0, 0, 2.4 ], [ 0, 0, - 1 ] );

	},
} );

// Same analytic reference, coarse tessellation: the interpolated shading normal disagrees with the
// triangle's geometric normal by up to the facet angle, so this bounds what the shading-normal leak
// guard costs in energy. A convex body has nothing to leak through, so any deficit that grows as the
// mesh coarsens is energy the shading-normal handling destroys rather than a leak it prevents.
for ( const [ id, seg ] of Object.entries( { 'furnace-lowpoly-16': 16, 'furnace-lowpoly-32': 32 } ) ) {

	SCENES.push( {
		id,
		covers: `white furnace — shading-normal energy loss at ${seg}-segment tessellation`,
		spp: 128,
		truthSpp: 512,
		settings: { maxBounces: 4, enableEnvironment: true, environmentIntensity: 1 },
		furnaceRadiance: 1.0,
		async build( app ) {

			const env = app.stages.pathTracer.environment;
			env.envParams.solidSkyColor = new Color( 0xffffff );
			await env.setMode( 'color' );

			const group = new Group();
			group.add( new Mesh(
				new SphereGeometry( 2, seg, Math.round( seg * 0.75 ) ),
				new MeshPhysicalMaterial( { color: 0xffffff, roughness: 1.0, metalness: 0 } )
			) );
			await app.loadObject3D( group, id );
			setCamera( app, [ 0, 0, 2.6 ], [ 0, 0, 0 ] );

		},
	} );

}

// ── Analytic area light ──────────────────────────────────────────
// Irradiance on a plane from a parallel Lambertian rectangle of uniform radiance L is E = π·L·F,
// F the configuration factor. rectCornerFactor is the textbook differential-element-under-a-corner
// form; rectConfigFactor assembles it with signed sub-rectangles so the point may sit anywhere.
function rectCornerFactor( a, b, h ) {

	const A = a / h, B = b / h;
	const ra = Math.sqrt( 1 + A * A ), rb = Math.sqrt( 1 + B * B );
	return ( A / ra * Math.atan( B / ra ) + B / rb * Math.atan( A / rb ) ) / ( 2 * Math.PI );

}

function rectConfigFactor( px, py, x0, x1, y0, y1, h ) {

	const f = ( dx, dy ) => Math.sign( dx ) * Math.sign( dy ) * rectCornerFactor( Math.abs( dx ), Math.abs( dy ), h );
	return f( x1 - px, y1 - py ) - f( x0 - px, y1 - py ) - f( x1 - px, y0 - py ) + f( x0 - px, y0 - py );

}

// Rigs are authored in radiant power; an adopted light carries three.js nits. Call after shape is set.
function setAreaLightPower( light, watts ) {

	const shapeFactor = light.userData.shape === 'ellipse' || light.userData.shape === 'disk' ? Math.PI / 4 : 1;
	light.intensity = watts / ( Math.PI * shapeFactor * light.width * light.height );

}

const AREALIGHT = {
	size: 1.0, // m, square emitter
	height: 1.0, // m above the plane
	power: 8.0, // W; Normalize on → L = P / (π·size²)
	albedo: 0.8,
	camDist: 0.03, // m; frames ±camDist·tan(fov/2) of the plane, over which E moves < 1e-4
	fov: 60, // CameraManager's construction default — asserted in build()
};

// Mean outgoing radiance over the framed patch = albedo·L·mean(F), averaged over the frame so the
// constant is exact for the pixels actually measured rather than for the centre pixel alone.
function areaLightPatchRadiance( { size, height, power, albedo, camDist, fov }, n = 64 ) {

	const L = power / ( Math.PI * size * size );
	const half = camDist * Math.tan( fov * Math.PI / 360 ); // RENDER_SIZE is square
	let sum = 0;
	for ( let i = 0; i < n; i ++ ) {

		for ( let j = 0; j < n; j ++ ) {

			const px = - half + ( i + 0.5 ) / n * 2 * half;
			const py = - half + ( j + 0.5 ) / n * 2 * half;
			sum += rectConfigFactor( px, py, - size / 2, size / 2, - size / 2, size / 2, height );

		}

	}

	return albedo * L * ( sum / ( n * n ) );

}

// No furnace can see the analytic-light path (a furnace has no lights), so this is its analytic
// gate: it pins the power→radiance convention, spherical-rectangle NEE, the NEE/BSDF-hit MIS
// weights and the shadow-ray origin together. Environment off, so the light is the only source.
// Its first catch: sampling the light from the lifted shadow-ray origin instead of the hit point read
// 1.00152 — exactly F(h = 0.999)/F(h = 1) = 1.00151. Sampling from the hit point reads 1.00001.
SCENES.push( {
	id: 'arealight-analytic',
	covers: 'analytic area light — Lambertian plane under a square emitter vs closed-form irradiance: power→radiance convention, spherical-rectangle NEE, NEE/BSDF-hit MIS, shadow-ray origin',
	spp: 64,
	truthSpp: 512,
	settings: { maxBounces: 4, enableEnvironment: false },
	furnaceRadiance: areaLightPatchRadiance( AREALIGHT ),
	async build( app ) {

		await app.stages.pathTracer.environment.setMode( 'color' );

		const { size, height, power, albedo, camDist, fov } = AREALIGHT;
		const group = new Group();
		group.add( new Mesh(
			new PlaneGeometry( 40, 40 ),
			new MeshPhysicalMaterial( { color: new Color( albedo, albedo, albedo ), roughness: 1, metalness: 0 } )
		) );
		const light = new RectAreaLight( 0xffffff, 1, size, size );
		light.position.set( 0, 0, height ); // emits along −z onto the +z-facing plane at z = 0
		light.userData.normalize = true;
		light.userData.spread = Math.PI;
		light.userData.shape = 'rectangle';
		setAreaLightPower( light, power );
		group.add( light );
		await app.loadObject3D( group, 'arealight-analytic' );

		const camera = app.cameraManager.camera;
		if ( Math.abs( camera.fov - fov ) > 1e-6 ) {

			throw new Error( `arealight-analytic: reference assumes fov ${fov}, camera has ${camera.fov}` );

		}

		setCamera( app, [ 0, 0, camDist ], [ 0, 0, 0 ] );

	},
} );

// Two lights of unequal size, power, shape and spread: the light-selection heuristic only has a
// measurable effect when there is a choice to make. Noise vs truth is the gate; the mirror ball
// exercises the BSDF-hit strategy against a small emitter, the floor the NEE strategy against a
// large one.
function makeTwoLightRig() {

	const group = new Group();

	const floor = new Mesh(
		new PlaneGeometry( 14, 14 ),
		new MeshPhysicalMaterial( { color: 0xb8b0a4, roughness: 1, metalness: 0 } )
	);
	floor.rotation.x = - Math.PI / 2;
	group.add( floor );

	const wall = new Mesh(
		new PlaneGeometry( 14, 6 ),
		new MeshPhysicalMaterial( { color: 0xd8d2c8, roughness: 0.9, metalness: 0 } )
	);
	wall.position.set( 0, 3, - 3 );
	group.add( wall );

	// Coplanar with the panel: authored fixtures sit ON their ceiling, so a shadow ray that reaches
	// the emitter's plane blacks the light out. Nothing lifts the light off it any more.
	const ceiling = new Mesh(
		new PlaneGeometry( 14, 8 ),
		new MeshPhysicalMaterial( { color: 0xd8d2c8, roughness: 0.9, metalness: 0 } )
	);
	ceiling.position.set( 0, 3.2, 0.5 );
	ceiling.rotation.x = Math.PI / 2;
	group.add( ceiling );

	const box = new Mesh(
		new BoxGeometry( 1.6, 1.6, 1.6 ),
		new MeshPhysicalMaterial( { color: 0xc44a3a, roughness: 0.7, metalness: 0 } )
	);
	box.position.set( - 1.6, 0.8, 0.2 );
	box.rotation.y = 0.5;
	group.add( box );

	// Glossy, not mirror: a near-mirror ball reflects the small light onto the floor as a caustic
	// whose rare bright samples swing a 128-spp mean by ~1 % on their own, hiding the selection
	// heuristic this scene exists to measure.
	const ball = new Mesh(
		new SphereGeometry( 0.8, 64, 48 ),
		new MeshPhysicalMaterial( { color: 0xffffff, roughness: 0.35, metalness: 1 } )
	);
	ball.position.set( 1.5, 0.8, 0.6 );
	group.add( ball );

	const panel = new RectAreaLight( 0xfff1dc, 1, 2.0, 2.0 );
	panel.position.set( - 1.0, 3.2, 0.5 );
	panel.lookAt( - 1.0, 0, 0.5 );
	panel.userData.normalize = true;
	panel.userData.spread = Math.PI;
	panel.userData.shape = 'rectangle';
	setAreaLightPower( panel, 40 );
	group.add( panel );

	const spot = new RectAreaLight( 0xd8e4ff, 1, 0.4, 0.4 );
	spot.position.set( 2.4, 2.4, 2.2 );
	spot.lookAt( 1.5, 0.8, 0.6 );
	spot.userData.normalize = true;
	spot.userData.spread = 1.6;
	spot.userData.shape = 'disk';
	setAreaLightPower( spot, 40 );
	group.add( spot );

	return group;

}

SCENES.push( {
	id: 'arealights-two',
	covers: 'two area lights of unequal size, power, shape and spread — reservoir light selection, per-light MIS, disk sampling, spread attenuation; noise gate for the selection heuristic',
	spp: 128,
	truthSpp: 2048,
	settings: { maxBounces: 4, enableEnvironment: false },
	async build( app ) {

		await app.stages.pathTracer.environment.setMode( 'color' );
		await app.loadObject3D( makeTwoLightRig(), 'arealights-two' );
		setCamera( app, [ 0, 2.6, 7 ], [ 0, 0.8, 0 ] );

	},
} );

/**
 * Pins the camera explicitly. Must run AFTER loadObject3D, which rebuilds the scene and
 * selects camera index 0 (potentially reframing).
 */
function setCamera( app, position, target ) {

	const camera = app.cameraManager.camera;
	camera.position.set( ...position );
	camera.lookAt( ...target );
	camera.updateMatrixWorld( true );

	const controls = app.cameraManager.controls;
	if ( controls ) {

		controls.target.set( ...target );
		controls.update();

	}

}

export function getScene( id ) {

	const scene = SCENES.find( ( s ) => s.id === id );
	if ( ! scene ) throw new Error( `Unknown bench scene "${id}" (have: ${SCENES.map( ( s ) => s.id ).join( ', ' )})` );
	return scene;

}
