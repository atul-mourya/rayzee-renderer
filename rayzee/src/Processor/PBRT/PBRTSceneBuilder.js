/**
 * Convert a parsed pbrt IR into a THREE scene graph the engine can ingest.
 *
 * Output: { group, camera, environment, animations, warnings }
 *   - group:       THREE.Group of meshes (fed to PathTracerApp.loadObject3D)
 *   - camera:      Perspective- or OrthographicCamera matching the pbrt Camera/LookAt, parented
 *                  into the group so AssetLoader.extractCamerasFromModel finds it
 *   - environment: { texture } | null — set by the caller as scene.environment
 *   - animations:  [ AnimationClip ] when the IR carries motion (see PBRTAnimation.js), else []
 *
 * Handedness: pbrt scenes import correctly as-is. A `diag(1,1,-1)` mirror is
 * available behind `convertHandedness` (default OFF) — three's `lookAt` builds
 * a correct camera basis regardless of source handedness, so no mirror is
 * needed. Enable only if a scene comes out z-mirrored against a known reference.
 */

import { freeNow, resized } from './buffers.js';
import {
	Group, Mesh, InstancedMesh, PerspectiveCamera, OrthographicCamera, Matrix4, Vector3, Quaternion,
	BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute,
	DataTexture, FloatType, RGBAFormat, LinearFilter, EquirectangularReflectionMapping,
	SRGBColorSpace, NoColorSpace, AnimationClip, VectorKeyframeTrack, QuaternionKeyframeTrack,
	NumberKeyframeTrack, BooleanKeyframeTrack, DirectionalLight, PointLight, SpotLight, FrontSide, DoubleSide,
	RepeatWrapping
} from 'three';
import { buildMaterial, pBool, pFloat, pString, resolveSpectrum } from './PBRTMaterials.js';
import { makeLayer, layerMean, bake, mixOf, srgbToLinear, linearToSRGB, hasAlpha } from './PBRTTextureBake.js';
import { loopSubdivide } from './LoopSubdivision.js';
import { octahedralToEquirect } from './EqualAreaOctahedral.js';
import { tessellateCurve } from './PBRTCurves.js';
import * as M from './PBRTMath.js';

const LAMP_TYPES = new Set( [ 'distant', 'point', 'spot' ] );

// pbrt scales a light's spectrum to luminance 1 unless it is RGB, so a blackbody of any temperature is equally bright.
async function lightRGB( params, name, ctx ) {

	const p = params[ name ];
	if ( p?.type === 'spectrum' && typeof p.value[ 0 ] === 'string' && p.value[ 0 ].startsWith( 'stdillum' ) ) return [ 1, 1, 1 ];
	const rgb = ( await resolveSpectrum( params, name, ctx, [ 1, 1, 1 ] ) ).rgb || [ 1, 1, 1 ];
	if ( ! p || p.type === 'rgb' || p.type === 'color' || p.type === 'float' ) return rgb;
	const y = 0.2126 * rgb[ 0 ] + 0.7152 * rgb[ 1 ] + 0.0722 * rgb[ 2 ];
	return y > 0 ? rgb.map( v => v / y ) : rgb;

}

const FLIP_Z = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, - 1, 0, 0, 0, 0, 1 ];
const MAX_SKY_READBACK = 4096;

// setIndex() only wraps a plain Array; hand it a typed one and it lands on the geometry
// raw, with no .count, and every consumer downstream reads NaN.
function indexAttribute( indices ) {

	if ( indices instanceof Uint32Array ) return new Uint32BufferAttribute( indices, 1 );
	if ( ArrayBuffer.isView( indices ) && indices.BYTES_PER_ELEMENT === 4 ) {

		return new Uint32BufferAttribute( new Uint32Array( indices.buffer, indices.byteOffset, indices.length ), 1 );

	}

	return new Uint32BufferAttribute( Uint32Array.from( indices ), 1 );

}

function grow( array, needed ) {

	if ( needed <= array.length ) return array;
	let length = array.length || 1;
	while ( length < needed ) length *= 2;
	return resized( array, length );

}

/** Reuse a Float32Array parameter as-is; the IR is discarded once the scene is built. */
function float32( values ) {

	return values instanceof Float32Array ? values : Float32Array.from( values );

}

// The per-mesh table is a debug aid; an instanced scene reaches tens of millions of rows.
const MAX_REPORT_ROWS = 1000;
// Triangles are chunked across several arrays now, so the 2 GB V8 cap no longer bounds them at
// 26.8M, and the GPU ceiling is higher still: one storage buffer of 4,096 MB at 80 B a triangle
// is 53.7M. What actually binds is CPU address space, measured on Moana: 40M (7.3 GB) and 45M
// (8.5 GB) load and render, 50M dies at 9.4 GB resident with nothing thrown and nothing logged.
// So the budget sits on the highest rung that survived — past it placements are skipped and the
// scene is reported as truncated, which beats taking the tab down. Raise `maxTriangles` per load
// to go further, on a freshly started browser.
const DEFAULT_TRIANGLE_BUDGET = 45_000_000;
// Placements are their own budget: geometry is shared, but each costs a TLAS leaf and an
// instance record. isCoastline's 5.09M loaded and rendered at 23 fps.
const DEFAULT_PLACEMENT_BUDGET = 6_000_000;
export { SPILL_TRIANGLE_BUDGET, SPILL_PLACEMENT_BUDGET } from '../HostMemory.js';
// Non-instanced shapes merge into a few large meshes: isPalmRig declares 173,338 of them,
// and one BufferGeometry + Mesh each measured 3.3 GB — the loader OOM'd before tracing.
const DEFAULT_MERGE_MIN_SHAPES = 256;
const MERGE_VERTEX_LIMIT = 4096;
const MERGE_BATCH_TRIANGLES = 500_000;
// Curve tessellation defaults. pbrt sweeps a spline analytically; a triangle tracer has to
// pick a resolution, and isMountainB alone declares 5.18M curves — two samples per span and
// a crossed pair of ribbons is 16 triangles a curve.
const DEFAULT_CURVE_STEPS = 2;
const DEFAULT_CURVE_SIDES = { flat: 1, ribbon: 1, cylinder: 2 };
// A strip segment may stray 5 % of the half-width from the curve: 37 % of Moana's curve
// triangles go, at 3 % frame time in a view full of them. 0.1 took 48 % for 6 %.
const DEFAULT_CURVE_TOLERANCE = 0.05;

/** Bumped whenever the same scene files build a different graph, so a stored graph is not reused. */
export const PBRT_BUILD_REVISION = 9;

function samePlacements( a, b ) {

	if ( a.count !== b.count ) return false;
	for ( let i = 0, n = a.count * 16; i < n; i ++ ) if ( a.matrices[ i ] !== b.matrices[ i ] ) return false;
	return true;

}

/** Pixels out of an HTMLImageElement / ImageBitmap, which expose none of their own. */
function pixelsFromDrawable( image, srgb ) {

	const size = Math.min( image.width, MAX_SKY_READBACK );
	let canvas = null;

	if ( typeof OffscreenCanvas !== 'undefined' ) canvas = new OffscreenCanvas( size, size );
	else if ( typeof document !== 'undefined' ) {

		canvas = document.createElement( 'canvas' );
		canvas.width = canvas.height = size;

	} else return null;

	try {

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0, size, size );
		const { data } = ctx.getImageData( 0, 0, size, size );
		return { data, width: size, height: size, channels: 4, bottomUp: false, srgb };

	} catch {

		return null;

	}

}

/**
 * A texture's pixels, for baking: `{ data, width, height, channels: 4, topDown, float }`, or null where this runtime
 * cannot read them. A DataTexture's rows run bottom up unless it says flipY; a drawable's top down.
 */
function texturePixels( texture ) {

	const image = texture?.image;
	if ( ! image ) return null;

	if ( ArrayBuffer.isView( image.data ) ) {

		return { data: image.data, width: image.width, height: image.height, channels: 4, topDown: texture.flipY === true, float: ! ( image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray ) };

	}

	const { width, height } = image;
	if ( ! width || ! height ) return null;
	let canvas = null;
	if ( typeof OffscreenCanvas !== 'undefined' ) canvas = new OffscreenCanvas( width, height );
	else if ( typeof document !== 'undefined' ) {

		canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;

	} else return null;

	try {

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		if ( ! ctx ) return null;
		ctx.drawImage( image, 0, 0 );
		return { data: ctx.getImageData( 0, 0, width, height ).data, width, height, channels: 4, topDown: true, float: false };

	} catch {

		return null;

	}

}

// pbrt's `encoding`: an 8-bit image is sRGB unless it says "linear" (or "gamma g").
function decoderFor( params ) {

	const encoding = pString( params, 'encoding', 'sRGB' );
	if ( encoding === 'linear' ) return ( v ) => v;
	const gamma = /^gamma\s+([\d.]+)$/.exec( encoding );
	return gamma ? ( v ) => v ** Number( gamma[ 1 ] ) : srgbToLinear;

}

function uvMapping( params ) {

	return {
		su: pFloat( params, 'uscale', 1 ), sv: pFloat( params, 'vscale', 1 ),
		du: pFloat( params, 'udelta', 0 ), dv: pFloat( params, 'vdelta', 0 )
	};

}

function setMapping( texture, { su, sv, du, dv } ) {

	texture.repeat.set( su, sv );
	texture.offset.set( du, dv );

}

/**
 * A float image (EXR, HDR, PFM) as 8-bit, the only texel a material map takes here: sRGB-encoded for a colour,
 * linear for data. Any other texture comes back as it is.
 */
function eightBit( texture, { srgb } ) {

	const data = texture?.image?.data;
	if ( ! ArrayBuffer.isView( data ) || data instanceof Uint8Array || data instanceof Uint8ClampedArray ) return texture;

	const { width, height } = texture.image;
	const bytes = new Uint8Array( width * height * 4 );
	const channels = data.length / ( width * height );
	for ( let i = 0; i < width * height; i ++ ) for ( let c = 0; c < 4; c ++ ) {

		const v = c < channels ? Math.min( 1, Math.max( 0, data[ i * channels + c ] ) ) : 1;
		bytes[ i * 4 + c ] = Math.round( 255 * ( srgb && c < 3 ? linearToSRGB( v ) : v ) );

	}

	const out = new DataTexture( bytes, width, height, RGBAFormat );
	out.flipY = texture.flipY;
	out.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
	out.wrapS = out.wrapT = RepeatWrapping;
	// No archive path: a stored scene keeps these bytes rather than decoding the float file again.
	out.needsUpdate = true;
	return out;

}

// A baked image as a texture: bytes bottom row first, sRGB unless a data map, in the uv mapping it was baked in.
function bakedTexture( { data, width, height, mapping }, { srgb = true } = {} ) {

	const texture = new DataTexture( data, width, height, RGBAFormat );
	texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
	texture.wrapS = texture.wrapT = RepeatWrapping;
	setMapping( texture, mapping );
	texture.needsUpdate = true;
	return texture;

}

/**
 * pbrt's thin lens as the camera's own effects (CameraManager applies them when the camera is chosen): the same
 * aperture radius in either DOF mode — `dofBlur` for 'look', a full-frame lens and its f-number for 'physical' at one
 * scene unit a metre — focused by hand at pbrt's distance.
 */
function lensEffects( camera, radius, focusDistance ) {

	const ortho = camera.isOrthographicCamera === true;
	const tanHalf = ortho ? 1 : Math.tan( camera.fov * Math.PI / 360 );
	const focalLength = ortho ? 50 : 12 / tanHalf;
	return {
		enableDOF: true,
		focusDistance,
		aperture: focalLength * 0.001 / ( 2 * radius ),
		focalLength,
		apertureScale: 1,
		anamorphicRatio: 1,
		dofBlur: radius / ( focusDistance * tanHalf ),
		autoFocusMode: 'manual',
		afScreenPoint: { x: 0.5, y: 0.5 },
		orthoHeight: ortho ? ( camera.top - camera.bottom ) / camera.zoom : null,
	};

}

// What the scene asks the renderer for, where it says: the Integrator's maxdepth, the Sampler's pixelsamples, the Film's
// resolution — scene metadata's `render`.
function renderRequest( ir ) {

	const render = {};
	if ( ir.integrator?.maxdepth > 0 ) render.maxBounces = Math.round( ir.integrator.maxdepth );
	if ( ir.sampler?.pixelsamples > 0 ) render.samples = Math.round( ir.sampler.pixelsamples );
	if ( ir.film?.resolutionGiven ) {

		render.width = ir.film.xresolution;
		render.height = ir.film.yresolution;

	}

	return Object.keys( render ).length ? render : null;

}

const QUADRIC_SEGMENTS = 48; // around a whole turn

// pbrt's quadric parameters, clamped as pbrt clamps them (shapes.h).
function sphereParams( params ) {

	const radius = pFloat( params, 'radius', 1 );
	const z0 = pFloat( params, 'zmin', - radius ), z1 = pFloat( params, 'zmax', radius );
	const clamp = ( z ) => Math.min( radius, Math.max( - radius, z ) );
	return { radius, zMin: clamp( Math.min( z0, z1 ) ), zMax: clamp( Math.max( z0, z1 ) ), phiMax: phiMaxOf( params ) };

}

function cylinderParams( params ) {

	const z0 = pFloat( params, 'zmin', - 1 ), z1 = pFloat( params, 'zmax', 1 );
	return { radius: pFloat( params, 'radius', 1 ), zMin: Math.min( z0, z1 ), zMax: Math.max( z0, z1 ), phiMax: phiMaxOf( params ) };

}

function diskParams( params ) {

	return {
		radius: pFloat( params, 'radius', 1 ), inner: pFloat( params, 'innerradius', 0 ),
		height: pFloat( params, 'height', 0 ), phiMax: phiMaxOf( params )
	};

}

const phiMaxOf = ( params ) => Math.min( 360, Math.max( 0, pFloat( params, 'phimax', 360 ) ) ) * Math.PI / 180;

/**
 * A quadric as pbrt parameterises it: `at( u, v, p, n )` over [0, 1]², u around the z axis to `phiMax`; the uv is
 * pbrt's own. Triangles face ∂p/∂u × ∂p/∂v, pbrt's normal; a cell edge of no length (a pole, a centre) drops its
 * triangle.
 */
function quadric( phiMax, vSegments, at ) {

	const uSegments = Math.max( 3, Math.ceil( QUADRIC_SEGMENTS * phiMax / ( 2 * Math.PI ) ) );
	const row = uSegments + 1;
	const position = new Float32Array( row * ( vSegments + 1 ) * 3 );
	const normal = new Float32Array( position.length );
	const uv = new Float32Array( row * ( vSegments + 1 ) * 2 );
	const p = new Vector3(), n = new Vector3();

	for ( let j = 0; j <= vSegments; j ++ ) for ( let i = 0; i <= uSegments; i ++ ) {

		const k = j * row + i;
		at( i / uSegments, j / vSegments, p, n );
		p.toArray( position, k * 3 );
		n.toArray( normal, k * 3 );
		uv[ k * 2 ] = i / uSegments;
		uv[ k * 2 + 1 ] = j / vSegments;

	}

	let extent = 0;
	for ( let k = 0; k < position.length; k ++ ) extent = Math.max( extent, Math.abs( position[ k ] ) );
	const apart = ( a, b ) => Math.hypot( position[ a * 3 ] - position[ b * 3 ], position[ a * 3 + 1 ] - position[ b * 3 + 1 ], position[ a * 3 + 2 ] - position[ b * 3 + 2 ] ) > extent * 1e-6;
	const index = [];
	for ( let j = 0; j < vSegments; j ++ ) for ( let i = 0; i < uSegments; i ++ ) {

		const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
		if ( apart( a, b ) ) index.push( a, b, d );
		if ( apart( c, d ) ) index.push( a, d, c );

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'normal', new Float32BufferAttribute( normal, 3 ) );
	geometry.setAttribute( 'uv', new Float32BufferAttribute( uv, 2 ) );
	geometry.setIndex( new Uint32BufferAttribute( new Uint32Array( index ), 1 ) );
	return geometry;

}

// What pbrt calls a shape's area when it scales an area light's `power`: a quadric's in its own space, a mesh's in the
// scene's (pbrt keeps triangles transformed).
function shapeArea( shape, geometry ) {

	const params = shape.params;
	switch ( shape.type ) {

		case 'sphere': {

			const { radius, zMin, zMax, phiMax } = sphereParams( params );
			return phiMax * radius * ( zMax - zMin );

		}

		case 'cylinder': {

			const { radius, zMin, zMax, phiMax } = cylinderParams( params );
			return phiMax * radius * ( zMax - zMin );

		}

		case 'disk': {

			const { radius, inner, phiMax } = diskParams( params );
			return phiMax * 0.5 * ( radius * radius - inner * inner );

		}

	}

	const world = new Matrix4().fromArray( shape.ctm );
	const position = geometry.getAttribute( 'position' );
	const index = geometry.index;
	const count = index ? index.count : position.count;
	const a = new Vector3(), b = new Vector3(), c = new Vector3();
	let area = 0;
	for ( let t = 0; t + 2 < count; t += 3 ) {

		a.fromBufferAttribute( position, index ? index.getX( t ) : t ).applyMatrix4( world );
		b.fromBufferAttribute( position, index ? index.getX( t + 1 ) : t + 1 ).applyMatrix4( world );
		c.fromBufferAttribute( position, index ? index.getX( t + 2 ) : t + 2 ).applyMatrix4( world );
		area += b.sub( a ).cross( c.sub( a ) ).length() / 2;

	}

	return area;

}

const CHECK_TEXELS = 64; // a baked checkerboard's texels along one check
const BILERP_TEXELS = 64;

// `colorAt( s, t )` (linear RGB) over a w × h grid as sRGB bytes, bottom row first, clamped as pbrt clamps an albedo.
function rasterize( width, height, colorAt ) {

	const data = new Uint8Array( width * height * 4 );
	for ( let j = 0; j < height; j ++ ) for ( let i = 0; i < width; i ++ ) {

		const rgb = colorAt( ( i + 0.5 ) / width, ( j + 0.5 ) / height );
		const o = ( j * width + i ) * 4;
		for ( let c = 0; c < 3; c ++ ) data[ o + c ] = Math.round( 255 * linearToSRGB( Math.min( 1, Math.max( 0, rgb[ c ] ) ) ) );
		data[ o + 3 ] = 255;

	}

	return data;

}

// A clone that keeps the engine's own material properties, which three.js's copy() does not know.
function cloneMaterial( material ) {

	const out = material.clone();
	for ( const key of Object.keys( material ) ) if ( ! ( key in out ) ) out[ key ] = material[ key ];
	return out;

}

// pbrt's shape alpha as the engine's blend mode: a ray passes with chance 1 − α, shadow rays too.
function translucent( material, alpha ) {

	const out = cloneMaterial( material );
	out.transparent = true;
	out.opacity = material.opacity * alpha;
	return out;

}

const sameMapping = ( texture, { su, sv, du, dv } ) =>
	texture.repeat.x === su && texture.repeat.y === sv && texture.offset.x === du && texture.offset.y === dv;

// An 8-bit image's colour with its alpha decoded as pbrt reads it; null when its alpha is opaque throughout.
function withDecodedAlpha( pixels, decode ) {

	if ( pixels.float || ! hasAlpha( pixels ) ) return null;
	const { data, width, height } = pixels;
	const lut = new Uint8Array( 256 );
	for ( let v = 0; v < 256; v ++ ) lut[ v ] = Math.round( 255 * Math.min( 1, Math.max( 0, decode( v / 255 ) ) ) );

	const out = new Uint8Array( width * height * 4 );
	const rowBytes = width * 4;
	for ( let y = 0; y < height; y ++ ) {

		const src = ( pixels.topDown ? height - 1 - y : y ) * rowBytes, dst = y * rowBytes;
		for ( let x = 0; x < rowBytes; x += 4 ) {

			out[ dst + x ] = data[ src + x ];
			out[ dst + x + 1 ] = data[ src + x + 1 ];
			out[ dst + x + 2 ] = data[ src + x + 2 ];
			out[ dst + x + 3 ] = lut[ data[ src + x + 3 ] ];

		}

	}

	const texture = new DataTexture( out, width, height, RGBAFormat );
	texture.colorSpace = SRGBColorSpace;
	texture.wrapS = texture.wrapT = RepeatWrapping;
	texture.needsUpdate = true;
	return texture;

}

/**
 * Names an unreadable texture may have been derived from. Moana binds colour as
 * `"texture reflectance" "el:part_Color"` and leaves `MakeNamedMaterial "el:part"` in the
 * shared library, so the colour survives the .ptx files being a separate download.
 */
function materialNameCandidates( texName ) {

	const out = [ texName ];
	let n = texName;
	const strips = [
		v => v.replace( /-renamed-\d+$/, '' ),
		v => v.replace( /\d+$/, '' ),
		v => v.replace( /_Color$/i, '' ),
		v => v.replace( /\d+$/, '' )
	];

	for ( const strip of strips ) {

		const next = strip( n );
		if ( next !== n && next ) out.push( n = next );

	}

	return out;

}

export class PBRTSceneBuilder {

	/**
	 * @param {object} resolvers
	 * @param {(filename:string)=>Promise<BufferGeometry>} [resolvers.resolvePLY]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveImage]
	 * @param {(filename:string)=>Promise<import('three').Texture>} [resolvers.resolveEnvironment]
	 * @param {boolean} [resolvers.convertHandedness=false]
	 */
	constructor( resolvers = {} ) {

		this.maxTriangles = resolvers.maxTriangles ?? DEFAULT_TRIANGLE_BUDGET;
		this.maxPlacements = resolvers.maxPlacements ?? DEFAULT_PLACEMENT_BUDGET;
		this.mergeShapesAbove = resolvers.mergeShapesAbove ?? DEFAULT_MERGE_MIN_SHAPES;
		this.curveSteps = resolvers.curveSteps ?? DEFAULT_CURVE_STEPS;
		this.curveSides = resolvers.curveSides ?? null;
		this.curveTolerance = resolvers.curveTolerance ?? DEFAULT_CURVE_TOLERANCE;
		this.resolvePLY = resolvers.resolvePLY || ( async () => null );
		this.resolveImage = resolvers.resolveImage || ( async () => null );
		this.resolveEnvironment = resolvers.resolveEnvironment || resolvers.resolveImage || ( async () => null );
		this.convertHandedness = resolvers.convertHandedness === true;

		this.warnings = [];
		this.report = []; // per-mesh diagnostics for debugging imports
		this._materialCache = new Map(); // material obj -> Map(areaLight obj -> MeshPhysicalMaterial)
		this._textureCache = new Map(); // texName -> { texture } | { constant }
		this._geometryCache = new Map(); // shape object -> Promise<BufferGeometry|null>
		this._materialBySignature = new Map(); // visual signature -> shared MeshPhysicalMaterial
		this._noUVMaterials = new Map(); // textured material -> its map-less clone
		this._plyCache = new Map(); // filename -> Promise<BufferGeometry|null>
		this._imageCache = new Map(); // filename -> Promise<Texture|null>, decoded once for every named texture
		this._termCache = new Map(); // texture name + channels -> Promise<{rgb}|{layer, tint?}|null>
		this._mediumMaterials = new Map(); // material -> Map(medium name -> material with its attenuation)
		this._alphaMaterials = new Map(); // material -> Map(alpha texture name or #value -> Promise<material>)

	}

	warn( msg ) {

		this.warnings.push( msg );

	}

	/**
	 * @param {object} ir - output of PBRTParser
	 * @returns {Promise<{group:Group, camera:PerspectiveCamera|OrthographicCamera|null, environment:object|null, warnings:string[]}>}
	 */
	async build( ir ) {

		this.ir = ir;
		// Built again for their moving placements after the static ones, so never freed early.
		this._keepShapes = new Set();
		for ( const { name } of ir.animatedInstances ?? [] ) for ( const shape of ir.objects.get( name ) ?? [] ) this._keepShapes.add( shape );
		// One decoded .ply serves every shape naming it: a merge frees it only as its last direct
		// user, and never while a template or an unmerged shape holds its geometry.
		this._plyUsers = new Map();
		this._plyHeld = new Set();
		for ( const shape of ir.shapes ) if ( shape?.type === 'plymesh' ) {

			const file = pString( shape.params, 'filename', null );
			this._plyUsers.set( file, ( this._plyUsers.get( file ) ?? 0 ) + 1 );

		}

		for ( const template of ir.objects.values() ) for ( const shape of template ) if ( shape.type === 'plymesh' ) this._plyHeld.add( pString( shape.params, 'filename', null ) );
		this._recoveredColors = 0;
		this.reportedMeshes = 0;
		this.triangleCount = 0; // stored triangles — a shared geometry counts once
		this.placementCount = 0;
		this.skippedForBudget = 0;
		this._countedGeometries = new WeakSet();
		const group = new Group();
		group.name = 'PBRTScene';

		this._batches = ir.shapes.length >= this.mergeShapesAbove ? new Map() : null;
		this._mergedBatches = 0;
		this.mergedShapes = 0;
		this.droppedNoTemplate = 0;
		this._animated = []; // { node, motion }

		// Shapes (direct + instanced)
		for ( let i = 0; i < ir.shapes.length; i ++ ) {

			if ( this._overBudget() ) {

				this.skippedForBudget += ir.shapes.length - i;
				break;

			}

			const shape = ir.shapes[ i ];
			const [ geometry, surface ] = await Promise.all( [
				this._batches ? this._createGeometry( shape ) : this._buildGeometry( shape ),
				this._getMaterial( shape )
			] );
			if ( ! geometry ) continue;
			const sharedMaterial = shape.areaLight ? this._poweredMaterial( shape, geometry, surface ) : surface;

			// A moving shape needs a node of its own to move.
			if ( this._batches && ! shape.motion && geometry.getAttribute( 'position' ).count <= MERGE_VERTEX_LIMIT ) {

				this._mergeShape( shape, geometry, sharedMaterial, group );
				ir.shapes[ i ] = null; // its parsed arrays are copied out; let them go
				continue;

			}

			if ( shape.type === 'plymesh' ) this._plyHeld.add( pString( shape.params, 'filename', null ) );

			const mesh = this._meshFromGeometry( shape, geometry, sharedMaterial, shape.ctm, `shape_${i}` );
			if ( ! mesh ) continue;
			group.add( mesh );
			if ( shape.motion ) this._animate( mesh, shape.motion );

		}

		if ( this._batches ) {

			for ( const slot of this._batches.values() ) {

				this._flushBatch( slot[ 0 ], group );
				this._flushBatch( slot[ 1 ], group );

			}

			this._batches = null;

		}

		await this._buildInstances( ir, group );
		await this._buildAnimatedPlacements( ir, group );

		if ( this.skippedForBudget > 0 ) this.warn(
			`stopped at ${this.triangleCount.toLocaleString()} stored triangles ` +
			`(budget ${this.maxTriangles.toLocaleString()}) and ${this.placementCount.toLocaleString()} placements ` +
			`(budget ${this.maxPlacements.toLocaleString()}); ${this.skippedForBudget.toLocaleString()} placement(s) skipped`
		);

		// Camera
		let camera = null;
		if ( ir.camera ) {

			camera = this._buildCamera( ir.camera, ir.film );
			if ( camera ) group.add( camera );

		}

		const animations = ir.animation ? this._buildClip( ir, camera ) : [];

		// Infinite light → environment
		const environment = await this._buildEnvironment( ir.lights );
		await this._buildLamps( ir.lights, group );

		this._reportUnsupportedLights( ir.lights );

		if ( this._recoveredColors > 0 ) this.warn(
			`${this._recoveredColors} unreadable texture(s) fell back to the like-named material's colour`
		);

		return {
			group, camera, environment, animations,
			render: renderRequest( ir ),
			report: this.report,
			meshCount: this.reportedMeshes,
			triangleCount: this.triangleCount,
			placementCount: this.placementCount,
			mergedShapes: this.mergedShapes,
			droppedNoTemplate: this.droppedNoTemplate,
			skippedForBudget: this.skippedForBudget,
			warnings: this.warnings.concat( ir.warnings || [] )
		};

	}

	// ── shapes ─────────────────────────────────────────────────────

	_overBudget() {

		return this.triangleCount >= this.maxTriangles || this.placementCount >= this.maxPlacements;

	}

	/**
	 * Charge a geometry's triangles to the storage budget once, however many placements use
	 * it. Returns its triangle count either way.
	 * @private
	 */
	_accountGeometry( geometry ) {

		const tris = geometry.index ? geometry.index.count / 3 : geometry.getAttribute( 'position' ).count / 3;
		if ( ! this._countedGeometries.has( geometry ) ) {

			this._countedGeometries.add( geometry );
			this.triangleCount += tris;

		}

		return tris;

	}

	/**
	 * Placements become InstancedMesh batches: one object per template shape, carrying a
	 * matrix per placement. Moana's beach ground cover alone is 21 million placements, and a
	 * Three.js object each would be the whole budget before a triangle is traced.
	 */
	async _buildInstances( ir, group ) {

		let n = 0;
		if ( ir.skippedInstances > 0 ) this.skippedForBudget += ir.skippedInstances;

		const scratch = new Float64Array( 16 );
		const matrix = new Matrix4();

		const place = ( list, geometry, material, rel, shapeType, materialType, tris ) => {

			const affordable = Math.max( 0, this.maxPlacements - this.placementCount );
			const count = Math.min( list.count, affordable );
			if ( count < list.count ) this.skippedForBudget += list.count - count;
			if ( count === 0 ) return;

			const mesh = new InstancedMesh( geometry, material, count );
			mesh.name = `instance_${n ++}`;
			mesh.frustumCulled = false;

			for ( let i = 0; i < count; i ++ ) {

				if ( rel ) M.multiplyInto( scratch, list.matrices, i * 16, rel );
				else for ( let e = 0; e < 16; e ++ ) scratch[ e ] = list.matrices[ i * 16 + e ];
				mesh.setMatrixAt( i, matrix.fromArray( this.convertHandedness ? M.multiply( FLIP_Z, scratch ) : scratch ) );

			}

			mesh.instanceMatrix.needsUpdate = true;
			group.add( mesh );

			this.placementCount += count;
			this.reportedMeshes += count;
			if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
				mesh: `${mesh.name} ×${count}`,
				shape: shapeType,
				material: materialType,
				color: '#' + material.color.getHexString(),
				map: material.map ? 'yes' : '-',
				uv: geometry.getAttribute( 'uv' ) ? 'yes' : 'NO',
				normals: geometry.getAttribute( 'normal' ) ? 'yes' : 'NO',
				emissive: material.emissiveIntensity > 0 ? `#${material.emissive.getHexString()}×${material.emissiveIntensity}` : '-',
				size: `instanced`,
				tris,
			} );

		};

		const placeBatch = ( list, batch ) => {

			if ( batch && batch.triangles > 0 ) place( list, this._batchGeometry( batch ), batch.material, null, 'merged', '-', batch.triangles );

		};

		for ( const { name, list, template } of this._samePlacementGroups( ir ) ) {

			if ( ! template ) {

				// Counted, not just warned: these are placements that silently leave the scene,
				// and a caller reading skippedForBudget would otherwise be told nothing was lost.
				this.droppedNoTemplate += list.count;
				this.warn( `ObjectInstance "${name}" has no template — ${list.count.toLocaleString()} placement(s) dropped` );
				continue;

			}

			// A template's own small shapes share its placements, so they merge in its space: the
			// eight Pandanus trees in Moana hold 22,965 leaves each. A .ply may be shared with
			// other templates and stays whole.
			let inline = 0;
			for ( const shape of template ) if ( shape.type !== 'plymesh' ) inline ++;
			const batches = inline >= 2 ? new Map() : null;

			for ( const shape of template ) {

				if ( this._overBudget() ) {

					this.skippedForBudget += list.count;
					continue;

				}

				const [ geometry, sharedMaterial ] = await Promise.all( [
					this._buildGeometry( shape ),
					this._getMaterial( shape )
				] );
				if ( ! geometry ) continue;

				if ( batches && shape.type !== 'plymesh' && geometry.getAttribute( 'position' ).count <= MERGE_VERTEX_LIMIT ) {

					this._geometryCache.delete( shape );
					const full = this._appendToBatch( batches, shape, geometry, sharedMaterial, shape.relativeCTM || shape.ctm );
					this._releaseMerged( shape, geometry );
					placeBatch( list, full );
					continue;

				}

				const tris = this._accountGeometry( geometry );
				const material = this._materialForGeometry( shape, geometry, sharedMaterial, `instances_${name}` );
				place( list, geometry, material, shape.relativeCTM || shape.ctm, shape.type, shape.material?.type || 'diffuse', tris );

			}

			if ( batches ) for ( const slot of batches.values() ) {

				placeBatch( list, slot[ 0 ] );
				placeBatch( list, slot[ 1 ] );

			}

			// Copied into each InstancedMesh: 576 MB at 9M placements, held to the end otherwise.
			freeNow( list.matrices );
			freeNow( list.matricesEnd );

		}

	}

	/**
	 * Templates placed at exactly the same transforms, as one template. Each Pandanus tree
	 * includes ten leaf files; kept apart they were ten overlapping instances a ray entered
	 * one after another, and the tree rendered 60 % slower than with its leaves world-baked.
	 * @private
	 */
	_samePlacementGroups( ir ) {

		const groups = [];
		const buckets = new Map();

		for ( const [ name, list ] of ir.instances ) {

			const template = ir.objects.get( name );
			if ( ! template || list.matricesEnd ) {

				groups.push( { name, list, template } );
				continue;

			}

			const key = `${list.count}:${Array.prototype.join.call( list.matrices.subarray( 0, 16 ), ',' )}`;
			let bucket = buckets.get( key );
			if ( ! bucket ) buckets.set( key, bucket = [] );

			const same = bucket.find( g => samePlacements( g.list, list ) );
			if ( same ) {

				if ( same.template === ir.objects.get( same.name ) ) same.template = same.template.slice();
				for ( const shape of template ) same.template.push( shape );
				freeNow( list.matrices );
				continue;

			}

			const group = { name, list, template };
			bucket.push( group );
			groups.push( group );

		}

		return groups;

	}

	/** Moving placements, one Group each: an InstancedMesh cannot move a single instance. */
	async _buildAnimatedPlacements( ir, group ) {

		const placements = ir.animatedInstances ?? [];
		for ( let k = 0; k < placements.length; k ++ ) {

			const { name, motion } = placements[ k ];
			const template = ir.objects.get( name );
			if ( ! template ) {

				this.droppedNoTemplate ++;
				continue;

			}

			if ( this._overBudget() ) {

				this.skippedForBudget += placements.length - k;
				break;

			}

			const node = new Group();
			node.name = `placement_${k}`;
			const start = Array.from( motion.matrices.subarray( 0, 16 ) );
			new Matrix4().fromArray( this.convertHandedness ? M.multiply( FLIP_Z, start ) : start ).decompose( node.position, node.quaternion, node.scale );

			for ( let s = 0; s < template.length; s ++ ) {

				const shape = template[ s ];
				const [ geometry, sharedMaterial ] = await Promise.all( [ this._buildGeometry( shape ), this._getMaterial( shape ) ] );
				if ( ! geometry ) continue;
				const mesh = this._meshFromGeometry( shape, geometry, sharedMaterial, shape.relativeCTM || shape.ctm, `${node.name}_${s}`, true );
				if ( mesh ) node.add( mesh );

			}

			if ( node.children.length === 0 ) continue;
			group.add( node );
			this._animate( node, motion );

		}

	}

	/** Remember a node's keyframes and put it in its first-frame visibility. @private */
	_animate( node, motion ) {

		if ( motion.visible ) node.visible = motion.visible[ 0 ] === 1;
		this._animated.push( { node, motion } );

	}

	/** One clip for the scene, with tracks only for what changes. @private */
	_buildClip( ir, camera ) {

		const tracks = [];

		for ( const { node, motion } of this._animated ) {

			this._transformTracks( tracks, node.name, motion, ( m, o ) => {

				const key = Array.from( m.subarray( o, o + 16 ) );
				return this.convertHandedness ? M.multiply( FLIP_Z, key ) : key;

			} );

			if ( motion.visible ) {

				// Nearest frame wins: switching on the key itself lost to float32 rounding of the times.
				const t = motion.times;
				const times = t.map( ( time, k ) => k === 0 ? 0 : ( t[ k - 1 ] + time ) / 2 );
				tracks.push( new BooleanKeyframeTrack( `${node.name}.visible`, times, Array.from( motion.visible, v => v === 1 ) ) );

			}

		}

		const camMotion = ir.camera?.motion;
		if ( camera && camMotion ) {

			const pose = new PerspectiveCamera();
			this._transformTracks( tracks, camera.name, camMotion, ( m, o ) => {

				this._poseCamera( pose, m.subarray( o, o + 16 ) );
				pose.updateMatrix();
				return pose.matrix.elements;

			} );

			if ( camMotion.fov && camera.isPerspectiveCamera ) {

				const fovs = Array.from( camMotion.fov, f => this._verticalFov( { fov: { type: 'float', value: [ f ] } }, camera.aspect ) );
				tracks.push( new NumberKeyframeTrack( `${camera.name}.fov`, camMotion.times.slice(), fovs ) );

			}

		}

		// optimize() compacts in place, so no two tracks may share a times array.
		for ( const track of tracks ) track.optimize();
		if ( tracks.length === 0 ) return [];
		return [ new AnimationClip( ir.animation.name, ir.animation.duration, tracks ) ];

	}

	/** Decompose each key and emit tracks for the components that vary. @private */
	_transformTracks( tracks, name, motion, matrixAt ) {

		const n = motion.times.length;
		const pos = new Float32Array( n * 3 ), rot = new Float32Array( n * 4 ), scl = new Float32Array( n * 3 );
		const m = new Matrix4(), p = new Vector3(), q = new Quaternion(), sc = new Vector3();

		for ( let k = 0; k < n; k ++ ) {

			m.fromArray( matrixAt( motion.matrices, k * 16 ) ).decompose( p, q, sc );
			// Same hemisphere as the previous key, so the blend takes the short way.
			if ( k > 0 && q.x * rot[ k * 4 - 4 ] + q.y * rot[ k * 4 - 3 ] + q.z * rot[ k * 4 - 2 ] + q.w * rot[ k * 4 - 1 ] < 0 ) {

				q.set( - q.x, - q.y, - q.z, - q.w );

			}

			p.toArray( pos, k * 3 );
			q.toArray( rot, k * 4 );
			sc.toArray( scl, k * 3 );

		}

		const varies = ( values, stride ) => {

			for ( let i = stride; i < values.length; i ++ ) if ( values[ i ] !== values[ i % stride ] ) return true;
			return false;

		};

		if ( varies( pos, 3 ) ) tracks.push( new VectorKeyframeTrack( `${name}.position`, motion.times.slice(), pos ) );
		if ( varies( rot, 4 ) ) tracks.push( new QuaternionKeyframeTrack( `${name}.quaternion`, motion.times.slice(), rot ) );
		if ( varies( scl, 3 ) ) tracks.push( new VectorKeyframeTrack( `${name}.scale`, motion.times.slice(), scl ) );

	}

	async _buildShapeMesh( shape, ctm, name ) {

		// Geometry parse and material/texture resolution are independent — overlap them.
		const [ geometry, sharedMaterial ] = await Promise.all( [
			this._buildGeometry( shape ),
			this._getMaterial( shape )
		] );
		if ( ! geometry ) return null;
		return this._meshFromGeometry( shape, geometry, sharedMaterial, ctm, name );

	}

	/** @param {boolean} [local=false] - `ctm` is parent-relative; the parent carries the handedness mirror */
	_meshFromGeometry( shape, geometry, sharedMaterial, ctm, name, local = false ) {

		const hasUV = !! geometry.getAttribute( 'uv' );
		const material = this._materialForGeometry( shape, geometry, sharedMaterial, name );

		const mesh = new Mesh( geometry, material );
		mesh.name = name;

		// Apply the world transform via TRS, NOT a direct mesh.matrix assignment:
		// GeometryExtractor calls mesh.updateMatrix(), which recomposes the matrix
		// from position/quaternion/scale. A directly-set matrix gets overwritten
		// with identity there — silently dropping every per-shape Transform.
		// decompose() round-trips the handedness mirror (det<0) via a negative scale axis.
		const world = this.convertHandedness && ! local ? M.multiply( FLIP_Z, ctm ) : ctm;
		new Matrix4().fromArray( world ).decompose( mesh.position, mesh.quaternion, mesh.scale );
		mesh.updateMatrix();

		// World-space dimensions (object bbox transformed by the baked matrix) —
		// surfaces an oversized/under-scaled mesh at a glance.
		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
		const worldSize = geometry.boundingBox
			? geometry.boundingBox.clone().applyMatrix4( mesh.matrix ).getSize( new Vector3() )
			: new Vector3();

		const tris = this._accountGeometry( geometry );
		this.placementCount ++;
		this.reportedMeshes ++;
		if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
			mesh: name,
			shape: shape.type,
			material: shape.material?.type || 'diffuse',
			color: '#' + material.color.getHexString(),
			map: material.map ? 'yes' : '-',
			uv: hasUV ? 'yes' : 'NO',
			normals: geometry.getAttribute( 'normal' ) ? 'yes' : 'NO',
			emissive: material.emissiveIntensity > 0 ? `#${material.emissive.getHexString()}×${material.emissiveIntensity}` : '-',
			size: `${worldSize.x.toFixed( 2 )}×${worldSize.y.toFixed( 2 )}×${worldSize.z.toFixed( 2 )}`,
			tris
		} );

		return mesh;

	}

	/**
	 * A textured material on geometry with no UVs samples a single texel — the usual cause of
	 * "black"/wrong meshes on import. Drop the map, but on a CLONE: _getMaterial shares one
	 * instance across every shape using the same NamedMaterial, so mutating it would strip
	 * the texture from siblings that DO have UVs.
	 * @private
	 */
	_materialForGeometry( shape, geometry, sharedMaterial, name ) {

		if ( ! sharedMaterial.map || geometry.getAttribute( 'uv' ) ) return sharedMaterial;

		// One clone per source material, not per shape — else 173,000 warnings and 173,000
		// materials, defeating every downstream cache that keys on material identity.
		let material = this._noUVMaterials.get( sharedMaterial );
		if ( ! material ) {

			this.warn( `${name} (${shape.type}, "${shape.material?.type || 'diffuse'}") has a texture map but no UVs — dropping map, using base color` );
			material = cloneMaterial( sharedMaterial );
			material.map = null;
			this._noUVMaterials.set( sharedMaterial, material );

		}

		return material;

	}

	/**
	 * Copy one shape's triangles into a world-space batch, keyed by material and UV presence.
	 * Nothing references the source geometry afterwards, so it is collectable on return.
	 * @private
	 */
	_mergeShape( shape, geometry, sharedMaterial, group ) {

		this.reportedMeshes ++;
		const world = this.convertHandedness ? M.multiply( FLIP_Z, shape.ctm ) : shape.ctm;
		const full = this._appendToBatch( this._batches, shape, geometry, sharedMaterial, world );
		this._releaseMerged( shape, geometry );
		if ( full ) this._flushBatch( full, group );

	}

	/**
	 * A merged shape's arrays are in its batch now and nothing reads it again: freed at once, not at
	 * a GC the build reaches with every one still held — isIronwoodA1's leaves were 3.9 GB twice over.
	 * @private
	 */
	_releaseMerged( shape, geometry ) {

		if ( this._keepShapes?.has( shape ) ) return;
		if ( shape.type === 'plymesh' && ! this._lastPlyUse( pString( shape.params, 'filename', null ) ) ) return;
		for ( const name in geometry.attributes ) freeNow( geometry.attributes[ name ].array );
		freeNow( geometry.index?.array );
		for ( const name in shape.params ) if ( ArrayBuffer.isView( shape.params[ name ]?.value ) ) freeNow( shape.params[ name ].value );

	}

	/** Whether this merge was the last use of a .ply, which then leaves the cache. @private */
	_lastPlyUse( file ) {

		const left = ( this._plyUsers.get( file ) ?? 1 ) - 1;
		this._plyUsers.set( file, left );
		if ( left > 0 || this._plyHeld.has( file ) ) return false;
		this._plyCache.delete( file );
		return true;

	}

	/**
	 * Copy one shape's triangles, moved by `transform`, into the batch for its material.
	 * @returns {object|null} the batch, taken out of `batches`, once it is full
	 * @private
	 */
	_appendToBatch( batches, shape, geometry, sharedMaterial, transform ) {

		const material = this._materialForGeometry( shape, geometry, sharedMaterial, 'merged shape' );
		const position = geometry.getAttribute( 'position' );
		const normal = geometry.getAttribute( 'normal' );
		const uv = geometry.getAttribute( 'uv' );
		const index = geometry.index;
		const vertices = position.count;

		// Charged directly: a merged shape stores its own copy even when two share one .ply.
		this.triangleCount += ( index ? index.count : vertices ) / 3;
		this.mergedShapes ++;

		let slot = batches.get( material );
		if ( ! slot ) batches.set( material, slot = [ null, null ] );
		const k = uv ? 1 : 0;
		let batch = slot[ k ];
		if ( ! batch ) slot[ k ] = batch = {
			material,
			positions: new Float32Array( 3072 ),
			normals: new Float32Array( 3072 ),
			uvs: uv ? new Float32Array( 2048 ) : null,
			indices: new Uint32Array( 3072 ),
			vertexCount: 0, indexCount: 0, triangles: 0
		};

		const world = transform;
		const inv = M.invert( world );
		const base = batch.vertexCount;

		batch.positions = grow( batch.positions, ( base + vertices ) * 3 );
		batch.normals = grow( batch.normals, ( base + vertices ) * 3 );
		if ( uv ) batch.uvs = grow( batch.uvs, ( base + vertices ) * 2 );

		const src = position.array, dst = batch.positions;
		const nsrc = normal ? normal.array : null, ndst = batch.normals;
		for ( let i = 0; i < vertices; i ++ ) {

			const s = i * 3, d = ( base + i ) * 3;
			const x = src[ s ], y = src[ s + 1 ], z = src[ s + 2 ];
			dst[ d ] = world[ 0 ] * x + world[ 4 ] * y + world[ 8 ] * z + world[ 12 ];
			dst[ d + 1 ] = world[ 1 ] * x + world[ 5 ] * y + world[ 9 ] * z + world[ 13 ];
			dst[ d + 2 ] = world[ 2 ] * x + world[ 6 ] * y + world[ 10 ] * z + world[ 14 ];

			if ( ! nsrc ) continue;
			// Inverse transpose, which in column-major order is the inverse read by rows.
			const nx = nsrc[ s ], ny = nsrc[ s + 1 ], nz = nsrc[ s + 2 ];
			let a = inv[ 0 ] * nx + inv[ 1 ] * ny + inv[ 2 ] * nz;
			let b = inv[ 4 ] * nx + inv[ 5 ] * ny + inv[ 6 ] * nz;
			let c = inv[ 8 ] * nx + inv[ 9 ] * ny + inv[ 10 ] * nz;
			const len = Math.hypot( a, b, c );
			if ( len > 0 ) {

				a /= len; b /= len; c /= len;

			}

			ndst[ d ] = a; ndst[ d + 1 ] = b; ndst[ d + 2 ] = c;

		}

		if ( uv ) batch.uvs.set( uv.array.subarray( 0, vertices * 2 ), base * 2 );

		const count = index ? index.count : vertices;
		batch.indices = grow( batch.indices, batch.indexCount + count );
		const idst = batch.indices;
		const isrc = index ? index.array : null;
		for ( let i = 0; i < count; i ++ ) idst[ batch.indexCount + i ] = base + ( isrc ? isrc[ i ] : i );

		batch.vertexCount += vertices;
		batch.indexCount += count;
		batch.triangles += count / 3;

		if ( batch.triangles >= MERGE_BATCH_TRIANGLES ) {

			slot[ k ] = null;
			return batch;

		}

		return null;

	}

	/** A batch's triangles as one geometry; the batch's own arrays are released. @private */
	_batchGeometry( batch ) {

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new Float32BufferAttribute( resized( batch.positions, batch.vertexCount * 3 ), 3 ) );
		geometry.setAttribute( 'normal', new Float32BufferAttribute( resized( batch.normals, batch.vertexCount * 3 ), 3 ) );
		if ( batch.uvs ) geometry.setAttribute( 'uv', new Float32BufferAttribute( resized( batch.uvs, batch.vertexCount * 2 ), 2 ) );
		geometry.setIndex( new Uint32BufferAttribute( resized( batch.indices, batch.indexCount ), 1 ) );
		batch.positions = batch.normals = batch.uvs = batch.indices = null;
		return geometry;

	}

	/** Turn one accumulated batch into a single Mesh at the scene origin. @private */
	_flushBatch( batch, group ) {

		if ( ! batch || batch.triangles === 0 ) return;

		const geometry = this._batchGeometry( batch );
		const mesh = new Mesh( geometry, batch.material );
		mesh.name = `merged_${this._mergedBatches ++}`;
		mesh.frustumCulled = false;
		group.add( mesh );

		this.placementCount ++;
		if ( this.report.length < MAX_REPORT_ROWS ) this.report.push( {
			mesh: mesh.name,
			shape: 'merged',
			material: '-',
			color: '#' + batch.material.color.getHexString(),
			map: batch.material.map ? 'yes' : '-',
			uv: batch.uvs ? 'yes' : 'NO',
			normals: 'yes',
			emissive: batch.material.emissiveIntensity > 0 ? `#${batch.material.emissive.getHexString()}×${batch.material.emissiveIntensity}` : '-',
			size: 'merged',
			tris: batch.triangles
		} );

	}

	_buildGeometry( shape ) {

		// An ObjectInstance template is built once per placement, and the Moana palm debris
		// alone places one 208-triangle leaf 2.25 million times. three.js is happy to share
		// one BufferGeometry across meshes; only the per-mesh matrix differs.
		let pending = this._geometryCache.get( shape );
		if ( ! pending ) this._geometryCache.set( shape, pending = this._createGeometry( shape ) );
		return pending;

	}

	async _createGeometry( shape ) {

		const geometry = await this._shapeGeometry( shape );
		return geometry && shape.areaLight && ! pBool( shape.areaLight.params, 'twosided', false ) ? this._facingEmission( shape, geometry ) : geometry;

	}

	/**
	 * A one-sided area light emits on the side pbrt's surface normal faces: towards the vertex normals where the shape
	 * has them, else its winding's side, turned over by ReverseOrientation. The engine emits from a triangle's front,
	 * so a triangle facing the other way is rewound, on an index of its own: the geometry may be shared.
	 * @private
	 */
	_facingEmission( shape, geometry ) {

		const normal = geometry.userData.pbrtNormals ? geometry.getAttribute( 'normal' ) : null;
		if ( ! normal && ! shape.reverseOrientation ) return geometry;

		const p = geometry.getAttribute( 'position' ).array, n = normal?.array;
		const src = geometry.index?.array ?? null;
		const count = src ? src.length : geometry.getAttribute( 'position' ).count;
		const index = new Uint32Array( count );
		let flipped = 0;

		for ( let t = 0; t + 2 < count; t += 3 ) {

			const a = src ? src[ t ] : t, b = src ? src[ t + 1 ] : t + 1, c = src ? src[ t + 2 ] : t + 2;
			let flip = shape.reverseOrientation;
			if ( n ) {

				const ux = p[ b * 3 ] - p[ a * 3 ], uy = p[ b * 3 + 1 ] - p[ a * 3 + 1 ], uz = p[ b * 3 + 2 ] - p[ a * 3 + 2 ];
				const vx = p[ c * 3 ] - p[ a * 3 ], vy = p[ c * 3 + 1 ] - p[ a * 3 + 1 ], vz = p[ c * 3 + 2 ] - p[ a * 3 + 2 ];
				const sx = n[ a * 3 ] + n[ b * 3 ] + n[ c * 3 ], sy = n[ a * 3 + 1 ] + n[ b * 3 + 1 ] + n[ c * 3 + 1 ], sz = n[ a * 3 + 2 ] + n[ b * 3 + 2 ] + n[ c * 3 + 2 ];
				flip = ( uy * vz - uz * vy ) * sx + ( uz * vx - ux * vz ) * sy + ( ux * vy - uy * vx ) * sz < 0;

			}

			index[ t ] = a;
			index[ t + 1 ] = flip ? c : b;
			index[ t + 2 ] = flip ? b : c;
			if ( flip ) flipped ++;

		}

		if ( flipped === 0 ) return geometry;
		const oriented = new BufferGeometry();
		for ( const name in geometry.attributes ) oriented.setAttribute( name, geometry.getAttribute( name ) );
		oriented.setIndex( new Uint32BufferAttribute( index, 1 ) );
		return oriented;

	}

	_shapeGeometry( shape ) {

		switch ( shape.type ) {

			case 'trianglemesh': return this._triangleMesh( shape.params );
			case 'bilinearmesh': return this._bilinearMesh( shape.params );
			case 'loopsubdiv': return this._loopSubdiv( shape.params );
			case 'curve': return this._curve( shape.params );
			case 'plymesh': return this._plyMesh( shape.params );
			case 'sphere': return this._sphere( shape.params );
			case 'disk': return this._disk( shape.params );
			case 'cylinder': return this._cylinder( shape.params );
			default:
				this.warn( `shape "${shape.type}" not supported — skipped` );
				return null;

		}

	}

	_triangleMesh( params ) {

		const P = params.P?.value;
		if ( ! P || P.length < 9 ) {

			this.warn( 'trianglemesh missing P' ); return null;

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( float32( P ), 3 ) );

		const N = params.N?.value;
		if ( N && N.length === P.length ) {

			geo.setAttribute( 'normal', new Float32BufferAttribute( float32( N ), 3 ) );
			geo.userData.pbrtNormals = true;

		}

		const uv = ( params.uv || params.st )?.value;
		if ( uv && uv.length === ( P.length / 3 ) * 2 ) geo.setAttribute( 'uv', new Float32BufferAttribute( float32( uv ), 2 ) );

		const indices = params.indices?.value;
		if ( indices && indices.length ) geo.setIndex( indexAttribute( indices ) );

		if ( ! N ) geo.computeVertexNormals();
		return geo;

	}

	_curve( params ) {

		const P = params.P?.value;
		if ( ! P || P.length < 12 ) {

			this.warn( 'curve needs at least 4 control points' ); return null;

		}

		const degree = Math.round( pFloat( params, 'degree', 3 ) );
		if ( degree !== 3 ) {

			this.warn( `curve degree ${degree} not supported — only cubic` ); return null;

		}

		const type = pString( params, 'type', 'flat' );
		const width = pFloat( params, 'width', 1 );
		const built = tessellateCurve( {
			P,
			basis: pString( params, 'basis', 'bezier' ),
			width0: pFloat( params, 'width0', width ),
			width1: pFloat( params, 'width1', width ),
			N: params.N?.value || null,
			steps: this.curveSteps,
			sides: this.curveSides ?? DEFAULT_CURVE_SIDES[ type ] ?? 1,
			tolerance: this.curveTolerance
		} );

		if ( ! built ) {

			this.warn( 'curve could not be tessellated' ); return null;

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( built.positions, 3 ) );
		geo.setIndex( new Uint32BufferAttribute( built.indices, 1 ) );
		geo.computeVertexNormals();
		return geo;

	}

	_loopSubdiv( params ) {

		const P = params.P?.value;
		const indices = params.indices?.value;
		if ( ! P || P.length < 9 || ! indices || indices.length < 3 ) {

			this.warn( 'loopsubdiv missing P/indices' ); return null;

		}

		// pbrt's default is 3; each level quadruples the face count, so a deep level on
		// a dense cage is worth refusing rather than stalling the import.
		const requested = Math.max( 0, Math.min( 6, Math.round( pFloat( params, 'levels', 3 ) ) ) );
		const { positions, indices: faces, levels } = loopSubdivide( P, indices, requested );

		if ( levels < requested ) this.warn(
			`loopsubdiv refined ${levels}/${requested} levels — the control mesh is too dense for the triangle budget`
		);

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
		geo.setIndex( new Uint32BufferAttribute( faces, 1 ) );
		geo.computeVertexNormals();
		return geo;

	}

	// Bilinear patch mesh → triangulate each quad (P + indices in quads of 4).
	/**
	 * pbrt's bilinear patches as two triangles each: corners p00, p10, p01, p11 (not a ring), facing ∂p/∂u × ∂p/∂v. One
	 * patch of four points needs no indices. Without uvs a patch takes its own (u, v), so its corners are not shared.
	 */
	_bilinearMesh( params ) {

		const P = params.P?.value;
		const quad = params.indices?.value ?? ( P?.length === 12 ? [ 0, 1, 2, 3 ] : null );
		if ( ! P || ! quad ) {

			this.warn( 'bilinearmesh missing P/indices' ); return null;

		}

		const count = P.length / 3;
		const uv = params.uv?.value?.length === count * 2 ? params.uv.value : null;
		const N = params.N?.value?.length === count * 3 ? params.N.value : null;
		const geo = new BufferGeometry();

		if ( uv ) {

			const index = [];
			for ( let i = 0; i + 3 < quad.length; i += 4 ) {

				const [ a, b, c, d ] = [ quad[ i ], quad[ i + 1 ], quad[ i + 2 ], quad[ i + 3 ] ];
				index.push( a, b, d, a, d, c );

			}

			geo.setAttribute( 'position', new Float32BufferAttribute( Float32Array.from( P ), 3 ) );
			geo.setAttribute( 'uv', new Float32BufferAttribute( Float32Array.from( uv ), 2 ) );
			if ( N ) geo.setAttribute( 'normal', new Float32BufferAttribute( Float32Array.from( N ), 3 ) );
			geo.setIndex( new Uint32BufferAttribute( new Uint32Array( index ), 1 ) );

		} else {

			const patches = Math.floor( quad.length / 4 );
			const position = new Float32Array( patches * 12 ), normal = N ? new Float32Array( patches * 12 ) : null;
			const corners = new Float32Array( patches * 8 ), index = new Uint32Array( patches * 6 );
			for ( let i = 0; i < patches; i ++ ) {

				for ( let k = 0; k < 4; k ++ ) {

					const v = quad[ i * 4 + k ];
					for ( let c = 0; c < 3; c ++ ) {

						position[ i * 12 + k * 3 + c ] = P[ v * 3 + c ];
						if ( normal ) normal[ i * 12 + k * 3 + c ] = N[ v * 3 + c ];

					}

					corners[ i * 8 + k * 2 ] = k & 1;
					corners[ i * 8 + k * 2 + 1 ] = k >> 1;

				}

				index.set( [ 0, 1, 3, 0, 3, 2 ].map( ( k ) => i * 4 + k ), i * 6 );

			}

			geo.setAttribute( 'position', new Float32BufferAttribute( position, 3 ) );
			geo.setAttribute( 'uv', new Float32BufferAttribute( corners, 2 ) );
			if ( normal ) geo.setAttribute( 'normal', new Float32BufferAttribute( normal, 3 ) );
			geo.setIndex( new Uint32BufferAttribute( index, 1 ) );

		}

		if ( N ) geo.userData.pbrtNormals = true;
		else geo.computeVertexNormals();
		return geo;

	}

	_plyMesh( params ) {

		const filename = pString( params, 'filename', null );
		if ( ! filename ) {

			this.warn( 'plymesh missing filename' ); return null;

		}

		// Two shapes can name the same .ply, and decoding it twice costs the full parse.
		let pending = this._plyCache.get( filename );
		if ( ! pending ) this._plyCache.set( filename, pending = this._decodePly( filename ) );
		return pending;

	}

	async _decodePly( filename ) {

		try {

			const geo = await this.resolvePLY( filename );
			if ( ! geo ) {

				this.warn( `plymesh file not found: ${filename}` ); return null;

			}

			if ( geo.getAttribute( 'normal' ) ) geo.userData.pbrtNormals = true;
			else geo.computeVertexNormals();
			return geo;

		} catch ( e ) {

			this.warn( `failed to load plymesh ${filename}: ${e.message}` );
			return null;

		}

	}

	_sphere( params ) {

		const { radius, zMin, zMax, phiMax } = sphereParams( params );
		const thetaMin = Math.acos( zMin / radius ), thetaMax = Math.acos( zMax / radius );
		return quadric( phiMax, Math.max( 1, Math.ceil( 32 * ( thetaMin - thetaMax ) / Math.PI ) ), ( u, v, p, n ) => {

			const phi = u * phiMax, theta = thetaMin + v * ( thetaMax - thetaMin );
			n.set( Math.sin( theta ) * Math.cos( phi ), Math.sin( theta ) * Math.sin( phi ), Math.cos( theta ) );
			p.copy( n ).multiplyScalar( radius );

		} );

	}

	_cylinder( params ) {

		const { radius, zMin, zMax, phiMax } = cylinderParams( params );
		return quadric( phiMax, 1, ( u, v, p, n ) => {

			const phi = u * phiMax;
			n.set( Math.cos( phi ), Math.sin( phi ), 0 );
			p.set( radius * n.x, radius * n.y, zMin + v * ( zMax - zMin ) );

		} );

	}

	_disk( params ) {

		const { radius, inner, height, phiMax } = diskParams( params );
		return quadric( phiMax, 1, ( u, v, p, n ) => {

			const phi = u * phiMax, r = radius - v * ( radius - inner );
			p.set( r * Math.cos( phi ), r * Math.sin( phi ), height );
			n.set( 0, 0, 1 );

		} );

	}

	// ── materials (with area-light emission) ───────────────────────

	async _getMaterial( shape ) {

		let material = await this._surfaceMaterial( shape );
		if ( shape.interior ) material = await this._inMedium( material, shape.interior );
		return shape.params.alpha ? this._withAlpha( material, shape.params.alpha ) : material;

	}

	/** The material under a shape's `alpha`, one per material and alpha. @private */
	_withAlpha( material, alpha ) {

		const key = alpha.type === 'texture' ? alpha.value[ 0 ] : `#${alpha.value[ 0 ]}`;
		let byAlpha = this._alphaMaterials.get( material );
		if ( ! byAlpha ) this._alphaMaterials.set( material, byAlpha = new Map() );
		if ( ! byAlpha.has( key ) ) byAlpha.set( key, this._createAlphaMaterial( material, alpha ) );
		return byAlpha.get( key );

	}

	async _createAlphaMaterial( material, alpha ) {

		if ( alpha.type !== 'texture' ) return alpha.value[ 0 ] < 1 ? translucent( material, alpha.value[ 0 ] ) : material;

		const name = alpha.value[ 0 ];
		const map = await this._alphaMap( material.map, name );
		if ( ! map ) {

			this.warn( `shape alpha "${name}" could not be read here — drawn opaque` );
			return material;

		}

		if ( map.constant !== undefined ) return map.constant < 1 ? translucent( material, map.constant ) : material;
		const out = cloneMaterial( material );
		out.map = map;
		out.transparent = true;
		return out;

	}

	/**
	 * The colour map with the float texture `name` in its alpha channel, `{ constant }` when that texture is one value,
	 * or null when it cannot be read here.
	 * @private
	 */
	async _alphaMap( colorMap, name ) {

		const def = this.ir.namedTextures.get( name );
		const filename = def?.class === 'imagemap' ? pString( def.params, 'filename', null ) : null;
		// Most often the alpha is the colour map's own image: its colour stays as it is.
		if ( filename && colorMap?.userData.pbrtImage === filename && pString( def.params, 'mapping', 'uv' ) === 'uv'
			&& pFloat( def.params, 'scale', 1 ) === 1 && ! pBool( def.params, 'invert', false ) && sameMapping( colorMap, uvMapping( def.params ) ) ) {

			const pixels = texturePixels( colorMap );
			const own = pixels && withDecodedAlpha( pixels, decoderFor( def.params ) );
			if ( own ) {

				setMapping( own, uvMapping( def.params ) );
				return own;

			}

		}

		const alpha = await this._bakeTerm( name, 1 );
		if ( ! alpha ) return null;
		if ( ! alpha.layer ) return { constant: alpha.rgb[ 0 ] };
		const color = colorMap ? this._textureLayer( colorMap, 3 ) : null;
		if ( colorMap && ! color ) return null;
		const baked = bake( [ color ? { layer: color } : { rgb: [ 1, 1, 1 ] }, alpha ], ( [ c ] ) => c, { alphaOf: ( [ , a ] ) => a[ 0 ] } );
		return baked && bakedTexture( baked );

	}

	async _surfaceMaterial( shape ) {

		// Cache by (material, areaLight) object identity — many shapes share a
		// NamedMaterial, so this dedupes the build + texture-decode work. Nested
		// Map keys on the object refs directly (null is a valid key).
		let byLight = this._materialCache.get( shape.material );
		if ( ! byLight ) {

			byLight = new Map();
			this._materialCache.set( shape.material, byLight );

		}

		if ( byLight.has( shape.areaLight ) ) return byLight.get( shape.areaLight );

		const ctx = this._materialContext();
		const material = await buildMaterial( shape.material, ctx );

		if ( shape.areaLight ) await this._applyAreaLight( material, shape.areaLight, ctx );

		const shared = this._dedupeMaterial( material );
		byLight.set( shape.areaLight, shared );
		return shared;

	}

	_materialContext() {

		return this._ctx ??= {
			resolveNamedTexture: ( n ) => this._resolveNamedTexture( n ),
			namedMaterials: this.ir.namedMaterials,
			warn: ( m ) => this.warn( m ),
			floatTextureMean: async ( n ) => {

				const term = await this._bakeTerm( n, 1 );
				return term ? ( term.layer ? layerMean( term.layer ) : term.rgb[ 0 ] ) : null;

			},
			bakeMaterialMix: ( a, b, amountName ) => this._bakeMaterialMix( a, b, amountName ),
			bakeFloatMap: ( params, keys, combine ) => this._floatMap( params, keys, combine ),
			textureMeanRGB: async ( n ) => {

				const term = await this._bakeTerm( n, 3 );
				if ( ! term?.layer ) return term?.rgb ?? null;
				const { data } = term.layer;
				const sum = [ 0, 0, 0 ];
				for ( let i = 0; i < data.length; i ++ ) sum[ i % 3 ] += data[ i ];
				return sum.map( ( v, c ) => v / ( data.length / 3 ) * ( term.tint?.[ c ] ?? 1 ) );

			},
			resolveNormalMap: async ( filename ) => {

				const image = await this._image( filename );
				if ( ! image ) return null;
				const texture = eightBit( image, { srgb: false } );
				const normalMap = texture === image ? image.clone() : texture;
				normalMap.colorSpace = NoColorSpace;
				return normalMap;

			}
		};

	}

	/**
	 * Glass filled with a homogeneous medium: what passes straight through it (σt = σa + σs) becomes Beer–Lambert
	 * attenuation, since the engine traces no scattering inside a solid. A medium in an opaque shape changes nothing.
	 * @private
	 */
	async _inMedium( material, name ) {

		if ( ! ( material.transmission > 0 ) ) return material;
		let byName = this._mediumMaterials.get( material );
		if ( ! byName ) this._mediumMaterials.set( material, byName = new Map() );
		if ( ! byName.has( name ) ) byName.set( name, this._attenuated( material, name ) );
		return byName.get( name );

	}

	async _attenuated( material, name ) {

		const params = this.ir.media?.get( name );
		const type = params && pString( params, 'type', '' );
		if ( type !== 'homogeneous' ) {

			this.warn( params ? `medium "${name}" (${type}) is not supported — "${name}" glass left clear` : `medium "${name}" not defined` );
			return material;

		}

		if ( params.preset ) this.warn( `medium preset "${pString( params, 'preset', '' )}" is not supported — using sigma_a / sigma_s` );
		const ctx = this._materialContext();
		const a = ( await resolveSpectrum( params, 'sigma_a', ctx, [ 1, 1, 1 ] ) ).rgb;
		const s = ( await resolveSpectrum( params, 'sigma_s', ctx, [ 1, 1, 1 ] ) ).rgb;
		const scale = pFloat( params, 'scale', 1 );
		const sigma = [ 0, 1, 2 ].map( ( c ) => ( a[ c ] + s[ c ] ) * scale );
		const max = Math.max( ...sigma );
		if ( ! ( max > 0 ) ) return material;

		const variant = cloneMaterial( material );
		variant.attenuationDistance = 1 / max;
		variant.attenuationColor.setRGB( ...sigma.map( ( v ) => Math.exp( - v / max ) ) );
		return this._dedupeMaterial( variant );

	}

	/**
	 * Collapse materials that render identically onto one instance — an inline `Material` per
	 * shape is a distinct object every time, so every batch would hold exactly one shape.
	 * @private
	 */
	_dedupeMaterial( material ) {

		const c = material.color, e = material.emissive;
		const key = `${c.r},${c.g},${c.b}|${e.r},${e.g},${e.b}|${material.emissiveIntensity}|` +
			`${material.map ? material.map.uuid : '-'}|${material.roughness}|${material.roughnessMap?.uuid ?? '-'}|${material.metalness}|` +
			`${material.transmission}|${material.ior}|${material.thickness}|` +
			`${material.clearcoat}|${material.clearcoatRoughness}|${material.clearcoatRoughnessMap?.uuid ?? '-'}|${material.opacity}|${material.side}|` +
			`${material.normalMap ? material.normalMap.uuid : '-'}|${material.attenuationDistance}|${material.attenuationColor.toArray()}|` +
			`${material.specularIntensity}|${material.diffuseTransmission ?? 0}|${material.diffuseTransmissionColor?.toArray() ?? '-'}|` +
			`${material.subsurface ?? 0}|${material.subsurfaceColor?.toArray() ?? '-'}|${material.subsurfaceRadius ?? '-'}|${material.subsurfaceAnisotropy ?? 0}`;

		const existing = this._materialBySignature.get( key );
		if ( existing ) return existing;
		this._materialBySignature.set( key, material );
		return material;

	}

	/**
	 * An area light given as `power`: pbrt scales its radiance to that power over this shape's area (both sides of a
	 * twosided one); an image's mean is not in it, as an emitting image is not supported.
	 * @private
	 */
	_poweredMaterial( shape, geometry, material ) {

		const power = pFloat( shape.areaLight.params, 'power', - 1 );
		if ( ! ( power > 0 ) ) return material;
		const area = shapeArea( shape, geometry ) * ( pBool( shape.areaLight.params, 'twosided', false ) ? 2 : 1 );
		if ( ! ( area > 0 ) ) return material;
		const out = cloneMaterial( material );
		out.emissiveIntensity = material.emissiveIntensity * power / ( Math.PI * area );
		return out;

	}

	async _applyAreaLight( material, areaLight, ctx ) {

		const rgb = await lightRGB( areaLight.params, 'L', ctx );
		const scale = pFloat( areaLight.params, 'scale', 1 );
		material.emissive.setRGB( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );
		material.emissiveIntensity = scale;
		// pbrt's diffuse area light is one-sided unless "twosided" (_facingEmission turns the triangles).
		material.side = pBool( areaLight.params, 'twosided', false ) ? DoubleSide : FrontSide;

	}

	async _resolveNamedTexture( name ) {

		if ( this._textureCache.has( name ) ) return this._textureCache.get( name );

		const def = this.ir.namedTextures.get( name );
		let result = null;

		if ( ! def ) {

			this.warn( `named texture "${name}" not defined` );

		} else if ( def.class === 'imagemap' ) {

			result = await this._imageMapTexture( name, def );

		} else if ( def.class === 'mix' ) {

			result = await this._mixTexture( name, def );

		} else if ( def.class === 'constant' ) {

			const v = def.params.value;
			if ( v && v.type === 'rgb' ) result = { constant: [ v.value[ 0 ], v.value[ 1 ], v.value[ 2 ] ] };
			else if ( v ) result = { constant: [ v.value[ 0 ], v.value[ 0 ], v.value[ 0 ] ] };

		} else if ( def.class === 'checkerboard' || def.class === 'bilerp' ) {

			result = await this._proceduralTexture( name, def );

		} else if ( def.class === 'scale' ) {

			// Scale = inner_texture * scale_factor. Resolve the inner (recursively if
			// it's a named ref) and the scale factor (rgb/float/spectrum), then propagate
			// both: the inner texture passes through as the `map`, and the scale becomes
			// the material's color tint (three.js multiplies map.rgb × color.rgb).
			result = await this._resolveScaleTexture( name, def );

		} else {

			const recovered = this._colorFromLikeNamedMaterial( name );
			if ( recovered ) {

				result = { constant: recovered.rgb };
				this._recoveredColors ++;

			} else {

				this.warn( `texture class "${def.class}" not supported (texture "${name}")` );

			}

		}

		this._textureCache.set( name, result );
		return result;

	}

	/**
	 * pbrt's 2D `checkerboard` and `bilerp`, baked: one period of the checks (two each way), or the bilerp over the unit
	 * square, in the texture's uv mapping. A textured input counts as its mean.
	 * @private
	 */
	async _proceduralTexture( name, def ) {

		const params = def.params;
		const ctx = this._materialContext();
		const value = async ( key, dflt ) => {

			const p = params[ key ];
			if ( p?.type === 'texture' ) return ( await ctx.textureMeanRGB( p.value[ 0 ] ) ) ?? dflt;
			return ( await resolveSpectrum( params, key, ctx, dflt ) ).rgb ?? dflt;

		};

		const mapping = pString( params, 'mapping', 'uv' );
		if ( mapping !== 'uv' ) this.warn( `texture "${name}": "${mapping}" mapping is not supported — using the mesh's uv` );
		const { su, sv, du, dv } = uvMapping( params );

		if ( def.class === 'checkerboard' ) {

			if ( pFloat( params, 'dimension', 2 ) !== 2 ) {

				this.warn( `texture "${name}": a 3D checkerboard is not supported` );
				return null;

			}

			const [ a, b ] = await Promise.all( [ value( 'tex1', [ 1, 1, 1 ] ), value( 'tex2', [ 0, 0, 0 ] ) ] );
			const n = 2 * CHECK_TEXELS;
			const data = rasterize( n, n, ( s, t ) => ( ( Math.floor( 2 * s ) + Math.floor( 2 * t ) ) % 2 ? b : a ) );
			return { texture: bakedTexture( { data, width: n, height: n, mapping: { su: su / 2, sv: sv / 2, du: du / 2, dv: dv / 2 } } ) };

		}

		const [ v00, v01, v10, v11 ] = await Promise.all( [
			value( 'v00', [ 0, 0, 0 ] ), value( 'v01', [ 1, 1, 1 ] ), value( 'v10', [ 0, 0, 0 ] ), value( 'v11', [ 1, 1, 1 ] )
		] );
		const data = rasterize( BILERP_TEXELS, BILERP_TEXELS, ( s, t ) => [ 0, 1, 2 ].map( ( c ) =>
			( 1 - s ) * ( 1 - t ) * v00[ c ] + s * ( 1 - t ) * v10[ c ] + ( 1 - s ) * t * v01[ c ] + s * t * v11[ c ] ) );
		return { texture: bakedTexture( { data, width: BILERP_TEXELS, height: BILERP_TEXELS, mapping: { su, sv, du, dv } } ) };

	}

	/** A file's image, decoded once however many named textures read it. @private */
	_image( filename ) {

		let pending = this._imageCache.get( filename );
		if ( ! pending ) {

			pending = Promise.resolve().then( () => this.resolveImage( filename ) ).catch( ( e ) => {

				this.warn( `failed to load image ${filename}: ${e.message}` );
				return null;

			} );
			this._imageCache.set( filename, pending );

		}

		return pending;

	}

	/**
	 * An image texture with pbrt's uv mapping; its `scale` becomes the material's tint, except that a scale above 1 or
	 * `invert` is baked (pbrt clamps an albedo per texel, which a tint cannot).
	 * @private
	 */
	async _imageMapTexture( name, def ) {

		const filename = pString( def.params, 'filename', null );
		if ( ! filename ) return null;
		const image = await this._image( filename );
		if ( ! image ) {

			this.warn( `image not found for texture "${name}": ${filename}` );
			return null;

		}

		const mapping = pString( def.params, 'mapping', 'uv' );
		if ( mapping !== 'uv' ) this.warn( `texture "${name}": "${mapping}" mapping is not supported — using the mesh's uv` );

		const scale = pFloat( def.params, 'scale', 1 );
		if ( scale > 1 || pBool( def.params, 'invert', false ) ) {

			const term = await this._bakeTerm( name, 3 );
			const baked = term?.layer && bake( [ { ...term, clamp: true } ], ( [ v ] ) => v );
			if ( baked ) return { texture: bakedTexture( baked ) };
			this.warn( `texture "${name}": its scale or invert could not be baked here — ignored` );

		}

		const color = eightBit( image, { srgb: true } );
		const texture = color === image ? image.clone() : color;
		texture.userData.pbrtImage = filename;
		setMapping( texture, uvMapping( def.params ) );
		texture.needsUpdate = true;
		return scale < 1 ? { texture, constant: [ scale, scale, scale ] } : { texture };

	}

	/**
	 * A data map (linear, in every channel) of `combine` over float parameters `keys`, constants or textures; null when
	 * one cannot be read here or all are constants.
	 * @private
	 */
	async _floatMap( params, keys, combine ) {

		const terms = await Promise.all( keys.map( ( key ) => this._paramTerm( params, key, 1, [ 0, 0, 0 ] ) ) );
		if ( terms.some( ( term ) => ! term ) ) return null;
		const baked = bake( terms, ( values ) => {

			const v = combine( values.map( ( value ) => value[ 0 ] ) );
			return [ v, v, v ];

		}, { linear: true } );
		return baked && bakedTexture( baked, { srgb: false } );

	}

	/** pbrt's `mix` texture, ( 1 − amount ) · tex1 + amount · tex2, baked when any of the three is an image. @private */
	async _mixTexture( name, def ) {

		const [ a, b, amount ] = await Promise.all( [
			this._paramTerm( def.params, 'tex1', 3, [ 0, 0, 0 ] ),
			this._paramTerm( def.params, 'tex2', 3, [ 1, 1, 1 ] ),
			this._paramTerm( def.params, 'amount', 1, [ 0.5, 0.5, 0.5 ] )
		] );
		if ( ! a || ! b || ! amount ) {

			this.warn( `texture "${name}": a "mix" input could not be read here` );
			return null;

		}

		const unit = ( rgb ) => rgb.map( ( v ) => Math.min( 1, Math.max( 0, v ) ) );
		const baked = bake( [ { ...a, clamp: true }, { ...b, clamp: true }, amount ], mixOf );
		return baked ? { texture: bakedTexture( baked ) } : { constant: mixOf( [ unit( a.rgb ), unit( b.rgb ), amount.rgb ] ) };

	}

	/** A texture parameter as a bake term: a constant, or the texture it names. @private */
	async _paramTerm( params, key, channels, dflt ) {

		const p = params[ key ];
		if ( ! p ) return { rgb: dflt };
		if ( p.type === 'texture' ) return this._bakeTerm( p.value[ 0 ], channels );
		const rgb = ( await resolveSpectrum( params, key, this._materialContext(), dflt ) ).rgb;
		return rgb ? { rgb } : null;

	}

	/**
	 * A named texture as pbrt evaluates it, for baking: `{ rgb }` for a constant, `{ layer, tint? }` for an image;
	 * null when it cannot be read in this runtime.
	 * @param {string} name
	 * @param {number} channels - 1 where it is read as a float texture, 3 as a spectrum
	 * @private
	 */
	_bakeTerm( name, channels ) {

		const key = `${name}\0${channels}`;
		let pending = this._termCache.get( key );
		if ( ! pending ) this._termCache.set( key, pending = this._createBakeTerm( name, channels ) );
		return pending;

	}

	async _createBakeTerm( name, channels ) {

		const def = this.ir.namedTextures.get( name );
		if ( def?.class === 'imagemap' ) {

			if ( pString( def.params, 'mapping', 'uv' ) !== 'uv' ) return null;
			const filename = pString( def.params, 'filename', null );
			const pixels = texturePixels( filename && await this._image( filename ) );
			if ( ! pixels ) return null;
			return { layer: makeLayer( pixels, {
				channels, decode: pixels.float ? null : decoderFor( def.params ),
				scale: pFloat( def.params, 'scale', 1 ), invert: pBool( def.params, 'invert', false ), mapping: uvMapping( def.params )
			} ) };

		}

		const resolved = await this._resolveNamedTexture( name );
		if ( ! resolved ) return null;
		if ( ! resolved.texture ) return resolved.constant ? { rgb: resolved.constant } : null;
		const layer = this._textureLayer( resolved.texture, channels );
		return layer ? { layer, tint: resolved.constant ?? null } : null;

	}

	// A texture already built for a material (an image or a bake) as a layer, in the mapping it carries.
	_textureLayer( texture, channels ) {

		const pixels = texturePixels( texture );
		if ( ! pixels ) return null;
		const srgb = ! pixels.float && texture.colorSpace === SRGBColorSpace;
		return makeLayer( pixels, {
			channels, decode: pixels.float ? null : ( srgb ? srgbToLinear : ( v ) => v ),
			mapping: { su: texture.repeat.x, sv: texture.repeat.y, du: texture.offset.x, dv: texture.offset.y }
		} );

	}

	/**
	 * A mix material whose amount is a texture: its two materials' colours (map × colour) baked by that texture, and
	 * the texture's mean to weigh everything else. Null when nothing here can read it.
	 * @private
	 */
	async _bakeMaterialMix( matA, matB, amountName ) {

		const amount = await this._bakeTerm( amountName, 1 );
		if ( ! amount ) return null;
		if ( ! amount.layer ) return { mean: amount.rgb[ 0 ], texture: null };

		const mean = layerMean( amount.layer );
		const term = ( m ) => {

			if ( ! m.map ) return { rgb: m.color.toArray(), clamp: true };
			const layer = this._textureLayer( m.map, 3 );
			return layer && { layer, tint: m.color.toArray(), clamp: true };

		};

		const a = term( matA ), b = term( matB );
		if ( ! a || ! b ) return { mean, texture: null };
		const baked = bake( [ a, b, amount ], mixOf );
		return { mean, texture: baked ? bakedTexture( baked ) : null };

	}

	_colorFromLikeNamedMaterial( texName ) {

		for ( const candidate of materialNameCandidates( texName ) ) {

			const mat = this.ir?.namedMaterials?.get( candidate );
			const p = mat?.params?.reflectance;
			if ( p && ( p.type === 'rgb' || p.type === 'color' ) ) {

				return { name: candidate, rgb: [ p.value[ 0 ], p.value[ 1 ], p.value[ 2 ] ] };

			}

		}

		return null;

	}

	async _resolveScaleTexture( name, def ) {

		// pbrt-v4 uses "tex" (the inner texture or constant) and "scale" (the multiplier).
		if ( def.params.scale?.type === 'texture' ) {

			// A texture multiplier (kroken's bricks: colour × dirt) is baked.
			const [ inner, factor ] = await Promise.all( [
				this._paramTerm( def.params, 'tex', 3, [ 1, 1, 1 ] ),
				this._paramTerm( def.params, 'scale', 1, [ 1, 1, 1 ] )
			] );
			const product = ( [ a, f ] ) => [ a[ 0 ] * f[ 0 ], a[ 1 ] * f[ 0 ], a[ 2 ] * f[ 0 ] ];
			if ( inner && factor ) {

				const baked = bake( [ { ...inner, clamp: true }, factor ], product );
				return baked ? { texture: bakedTexture( baked ) } : { constant: product( [ inner.rgb, factor.rgb ] ) };

			}

			this.warn( `texture "${name}": its "scale" texture could not be read here — ignored` );

		}

		const innerP = def.params.tex;
		let inner = null;

		if ( innerP?.type === 'texture' && typeof innerP.value[ 0 ] === 'string' ) {

			inner = await this._resolveNamedTexture( innerP.value[ 0 ] );

		} else if ( innerP?.type === 'rgb' || innerP?.type === 'color' ) {

			inner = { constant: [ innerP.value[ 0 ], innerP.value[ 1 ], innerP.value[ 2 ] ] };

		} else if ( innerP?.type === 'float' ) {

			const v = innerP.value[ 0 ];
			inner = { constant: [ v, v, v ] };

		}

		const sP = def.params.scale;
		let scale = [ 1, 1, 1 ];
		if ( sP?.type === 'rgb' || sP?.type === 'color' ) scale = [ sP.value[ 0 ], sP.value[ 1 ], sP.value[ 2 ] ];
		else if ( sP?.type === 'float' ) {

			const v = sP.value[ 0 ]; scale = [ v, v, v ];

		}

		if ( inner?.texture ) {

			const c = inner.constant || [ 1, 1, 1 ];
			return {
				texture: inner.texture,
				constant: [ c[ 0 ] * scale[ 0 ], c[ 1 ] * scale[ 1 ], c[ 2 ] * scale[ 2 ] ]
			};

		}

		const c = inner?.constant || [ 1, 1, 1 ];
		return { constant: [ c[ 0 ] * scale[ 0 ], c[ 1 ] * scale[ 1 ], c[ 2 ] * scale[ 2 ] ] };

	}

	// ── camera ─────────────────────────────────────────────────────

	_buildCamera( cam, film ) {

		const aspect = film && film.yresolution ? film.xresolution / film.yresolution : 16 / 9;

		let camera;
		if ( cam.type === 'orthographic' ) {

			// pbrt's default screen window spans [-1, 1] along the shorter image axis.
			const window = cam.params?.screenwindow?.value;
			const half = window?.length === 4 ? ( window[ 3 ] - window[ 2 ] ) / 2 : Math.max( 1, 1 / aspect );
			camera = new OrthographicCamera( - half * aspect, half * aspect, half, - half, 0.01, 10000 );

		} else {

			camera = new PerspectiveCamera( this._verticalFov( cam.params, aspect ), aspect, 0.01, 10000 );

		}

		camera.name = 'PBRT Camera';
		this._poseCamera( camera, cam.cameraToWorld );
		camera.updateMatrixWorld( true );
		const lensRadius = pFloat( cam.params, 'lensradius', 0 );
		if ( lensRadius > 0 ) camera.userData.__rayzeeEffects = lensEffects( camera, lensRadius, pFloat( cam.params, 'focaldistance', 1e6 ) );
		return camera;

	}

	/** Place a camera at a pbrt camera-to-world transform. @private */
	_poseCamera( camera, cameraToWorld ) {

		const e = cameraToWorld;

		// Columns of cameraToWorld: right(0), up(1), dir(2), eye(3).
		const eye = new Vector3( e[ 12 ], e[ 13 ], e[ 14 ] );
		const dir = new Vector3( e[ 8 ], e[ 9 ], e[ 10 ] );
		const up = new Vector3( e[ 4 ], e[ 5 ], e[ 6 ] );

		if ( this.convertHandedness ) {

			eye.z *= - 1; dir.z *= - 1; up.z *= - 1;

		}

		camera.up.copy( up.normalize() );
		camera.position.copy( eye );
		camera.scale.set( 1, 1, 1 );
		camera.lookAt( eye.clone().add( dir ) );

		// pbrt's camera space is left-handed: image-right is cameraToWorld's first column,
		// = cross(up, dir). three's lookAt() builds cross(up, -dir) — the opposite — so a
		// plain pbrt scene imports left-right flipped against pbrt's own render. An
		// exported scene's `Scale -1 1 1` already negates that column (det < 0), and then
		// lookAt() happens to agree and no correction is wanted. Hence: mirror exactly when
		// the scene does NOT. Verified against the reference images for contemporary-bathroom
		// (has the Scale) and killeroos/killeroo-simple (does not).
		if ( ( M.determinant3( cameraToWorld ) > 0 ) !== this.convertHandedness ) camera.scale.x = - 1;

	}

	// pbrt `fov` is the angle along the SHORTER image axis. THREE uses vertical fov.
	_verticalFov( params, aspect ) {

		const pbrtFov = pFloat( params, 'fov', 90 );
		if ( aspect >= 1 ) return pbrtFov; // landscape: shorter axis is vertical
		// portrait: pbrt fov is horizontal → convert to vertical
		const h = pbrtFov * Math.PI / 180;
		const v = 2 * Math.atan( Math.tan( h / 2 ) / aspect );
		return v * 180 / Math.PI;

	}

	// ── lights / environment ───────────────────────────────────────

	/**
	 * A square infinite-light image is pbrt's equal-area octahedral layout, not a
	 * lat-long panorama — resample it, folding in the light's transform and `scale`.
	 * Returns null when the image is not square (nothing to convert) or its pixels are
	 * not readable, leaving the caller's equirectangular path in place.
	 */
	_equirectFromInfiniteLight( tex, inf, scale, filename ) {

		const image = tex.image;
		if ( ! image?.width || image.width !== image.height ) {

			if ( image?.width !== image?.height ) this.warn(
				`infinite-light image "${filename}" is ${image?.width}x${image?.height}, not square — ` +
				'read as equirectangular, but pbrt would read it as equal-area octahedral'
			);
			return null;

		}

		let src = null;

		if ( image.data ) {

			const channels = image.data.length / ( image.width * image.height );
			if ( ! Number.isInteger( channels ) || channels < 3 ) return null;
			// three's EXR/HDR loaders fill DataTexture rows bottom-up; pbrt reads the square top-down.
			src = { data: image.data, width: image.width, height: image.height, channels, bottomUp: true };

		} else {

			// A PNG sky has no readable pixels of its own; without these the octahedral map
			// used to fall through and be sampled as a lat-long panorama.
			src = pixelsFromDrawable( image, tex.colorSpace === SRGBColorSpace );
			if ( ! src ) {

				this.warn( `infinite-light image "${filename}" could not be read back for octahedral conversion` );
				return null;

			}

		}

		const { data: pixels, width, height } = octahedralToEquirect( src, inf.ctm, scale );

		const out = new DataTexture( pixels, width, height, RGBAFormat, FloatType );
		out.mapping = EquirectangularReflectionMapping;
		out.minFilter = LinearFilter;
		out.magFilter = LinearFilter;
		out.needsUpdate = true;
		return out;

	}

	async _buildEnvironment( lights ) {

		const inf = lights.find( l => l.type === 'infinite' );
		if ( ! inf ) return null;

		const scale = pFloat( inf.params, 'scale', 1 );
		const filename = pString( inf.params, 'filename', null );

		if ( filename ) {

			try {

				const tex = await this.resolveEnvironment( filename );
				if ( tex ) {

					const converted = this._equirectFromInfiniteLight( tex, inf, scale, filename );
					if ( converted ) return { texture: converted };

					tex.mapping = EquirectangularReflectionMapping;
					return { texture: tex };

				}

				this.warn( `infinite-light image not found: ${filename}` );

			} catch ( e ) {

				this.warn( `failed to load infinite-light image ${filename}: ${e.message}` );

			}

		}

		// Constant-radiance infinite light → tiny float texture (CDF-buildable).
		const ctx = { resolveNamedTexture: async () => null, warn: ( m ) => this.warn( m ) };
		const rgb = ( await lightRGB( inf.params, 'L', ctx ) ).map( v => v * scale );

		const w = 2, h = 1;
		const data = new Float32Array( w * h * 4 );
		for ( let i = 0; i < w * h; i ++ ) {

			data[ i * 4 + 0 ] = rgb[ 0 ];
			data[ i * 4 + 1 ] = rgb[ 1 ];
			data[ i * 4 + 2 ] = rgb[ 2 ];
			data[ i * 4 + 3 ] = 1;

		}

		const tex = new DataTexture( data, w, h, RGBAFormat, FloatType );
		tex.mapping = EquirectangularReflectionMapping;
		tex.minFilter = LinearFilter;
		tex.magFilter = LinearFilter;
		tex.needsUpdate = true;
		return { texture: tex };

	}

	/**
	 * `distant`, `point` and `spot` lights as three.js lamps, in the engine's units: a directional lamp's
	 * intensity is the irradiance it gives (pbrt's L), a point or spot lamp's is 4π × its radiant intensity.
	 */
	async _buildLamps( lights, group ) {

		const ctx = { resolveNamedTexture: async () => null, warn: ( m ) => this.warn( m ) };
		for ( const l of lights ) {

			if ( ! LAMP_TYPES.has( l.type ) ) continue;

			const world = new Matrix4().fromArray( this.convertHandedness ? M.multiply( FLIP_Z, l.ctm ) : l.ctm );
			const point = ( name, dflt ) => {

				const v = l.params[ name ]?.value;
				return new Vector3().fromArray( v?.length >= 3 ? v : dflt ).applyMatrix4( world );

			};

			const rgb = await lightRGB( l.params, l.type === 'distant' ? 'L' : 'I', ctx );
			let scale = pFloat( l.params, 'scale', 1 );
			const from = point( 'from', [ 0, 0, 0 ] );
			const to = point( 'to', [ 0, 0, 1 ] );
			let light;
			if ( l.type === 'distant' ) {

				const illuminance = pFloat( l.params, 'illuminance', - 1 );
				if ( illuminance > 0 ) scale *= illuminance;
				light = new DirectionalLight();
				light.userData.__luxConverted = true;

			} else if ( l.type === 'point' ) {

				// `power` sets the radiant intensity to power / 4π.
				const power = pFloat( l.params, 'power', - 1 );
				scale *= power > 0 ? power : 4 * Math.PI;
				light = new PointLight();
				light.userData.__candelaConverted = true;

			} else {

				// pbrt's falloff is smoothstep( cos cone, cos( cone − delta ), cos θ ); the engine's blend is that width over 1 − cos cone.
				const cone = Math.min( Math.max( pFloat( l.params, 'coneangle', 30 ), 0 ), 90 ) * Math.PI / 180;
				const delta = Math.min( Math.max( pFloat( l.params, 'conedeltaangle', 5 ) * Math.PI / 180, 0 ), cone );
				const cosEnd = Math.cos( cone ), cosStart = Math.cos( cone - delta );
				const power = pFloat( l.params, 'power', - 1 );
				if ( power > 0 ) scale *= power / ( 2 * Math.PI * ( ( 1 - cosStart ) + ( cosStart - cosEnd ) / 2 ) );
				scale *= 4 * Math.PI;
				light = new SpotLight();
				light.angle = cone;
				light.penumbra = cosEnd < 1 ? Math.min( ( cosStart - cosEnd ) / ( 1 - cosEnd ), 1 ) : 0;
				light.userData.__candelaConverted = true;

			}

			const peak = Math.max( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );
			if ( ! ( peak > 0 ) || ! ( scale > 0 ) ) continue;
			light.color.setRGB( rgb[ 0 ] / peak, rgb[ 1 ] / peak, rgb[ 2 ] / peak );
			light.intensity = peak * scale;
			light.name = `pbrt ${l.type}`;
			light.position.copy( from );
			light.decay = 2;
			light.distance = 0;
			if ( light.target ) {

				light.target.position.subVectors( to, from );
				light.add( light.target );

			}

			group.add( light );

		}

	}

	_reportUnsupportedLights( lights ) {

		for ( const l of lights ) {

			if ( l.type !== 'infinite' && ! LAMP_TYPES.has( l.type ) ) {

				this.warn( `light "${l.type}" not supported (only infinite, distant, point and spot lights and emissive area lights are mapped)` );

			}

		}

	}

}
