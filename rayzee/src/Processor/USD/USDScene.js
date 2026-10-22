/**
 * A composed USD stage read into the scene description the pbrt importer's builder takes (PBRTSceneBuilder's IR), so
 * USD scenes get the same instancing, budgets, merging and curve tessellation: meshes and curves become shapes,
 * instanceable prims and point instancers become templates placed once per instance, materials MeshPhysicalMaterials.
 * Cameras, lights and the dome light are built here, as three.js objects.
 */

import {
	Matrix4, Quaternion, Vector3, Euler, Color, MeshPhysicalMaterial, DoubleSide, PerspectiveCamera, OrthographicCamera,
	RectAreaLight, DirectionalLight, PointLight, SpotLight, SRGBColorSpace, NoColorSpace, RepeatWrapping,
	ClampToEdgeWrapping, MirroredRepeatWrapping, BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry,
	CapsuleGeometry, PlaneGeometry,
} from 'three';
import { cloneMaterial } from '../PBRT/PBRTSceneBuilder.js';

const DEG = Math.PI / 180;
const GRID = 1 / 255;
const LIGHT_TYPES = new Set( [ 'RectLight', 'DiskLight', 'SphereLight', 'DistantLight', 'DomeLight', 'CylinderLight' ] );
const GPRIMS = new Set( [ 'Sphere', 'Cube', 'Cylinder', 'Cone', 'Capsule', 'Plane' ] );
const SKIPPED = new Set( [ 'Material', 'Shader', 'NodeGraph', 'GeomSubset', 'Volume', 'OpenVDBAsset', 'Field3DAsset', 'SkelAnimation', 'BlendShape' ] );
const PTEX = /\.(ptx|ptex)$/i;
const WRAP = { repeat: RepeatWrapping, mirror: MirroredRepeatWrapping, clamp: ClampToEdgeWrapping, black: ClampToEdgeWrapping };

// MaterialX nodes are `ND_<node>_<types>`; the node is what a reader dispatches on.
const MTLX_TYPES = /_(?:float|integer|boolean|string|filename|color3|color4|vector2|vector3|vector4|matrix33|matrix44|surfaceshader|BSDF|EDF)(?:FA|I|B)?(?=_|$)/;
const mtlxNode = id => {

	const name = id.slice( 3 );
	const at = name.search( MTLX_TYPES );
	return at > 0 ? name.slice( 0, at ) : name;

};

// The MaterialX surfaces read here, and the method each goes to.
const MTLX_SURFACES = { open_pbr_surface: 'openPbrSurface', standard_surface: 'standardSurface', gltf_pbr: 'gltfPbrSurface', UsdPreviewSurface: 'previewSurface', surface: 'bsdfSurface' };
const MTLX_ADDRESS = { periodic: 'repeat', mirror: 'mirror', clamp: 'clamp', constant: 'black' };
// A UV set's placement as an affine map, u' = a·u + b·v + c and v' = d·u + e·v + f.
const UV_IDENTITY = [ 1, 0, 0, 0, 1, 0 ];
const isNum = v => typeof v === 'number';
const isValue = v => isNum( v ) || Array.isArray( v );
const each = ( v, f ) => ( isNum( v ) ? f( v ) : v.map( f ) );
function zip( a, b, f ) {

	if ( isNum( a ) && isNum( b ) ) return f( a, b );
	const n = Math.max( isNum( a ) ? 1 : a.length, isNum( b ) ? 1 : b.length );
	return Array.from( { length: n }, ( _, i ) => f( isNum( a ) ? a : a[ i ] ?? a[ 0 ], isNum( b ) ? b : b[ i ] ?? b[ 0 ] ) );

}

const mean = v => ( isNum( v ) ? v : v.slice( 0, 3 ).reduce( ( s, x ) => s + x, 0 ) / Math.min( v.length, 3 ) );

// Placements composed after `m`: scale the result, move it, or turn it as MaterialX's rotate2d does (clockwise).
const uvScale = ( m, [ sx, sy ] ) => [ m[ 0 ] * sx, m[ 1 ] * sx, m[ 2 ] * sx, m[ 3 ] * sy, m[ 4 ] * sy, m[ 5 ] * sy ];
const uvTranslate = ( m, [ tx, ty ] ) => [ m[ 0 ], m[ 1 ], m[ 2 ] + tx, m[ 3 ], m[ 4 ], m[ 5 ] + ty ];
function uvRotate( m, degrees ) {

	const c = Math.cos( degrees * DEG ), s = Math.sin( degrees * DEG );
	return [
		c * m[ 0 ] + s * m[ 3 ], c * m[ 1 ] + s * m[ 4 ], c * m[ 2 ] + s * m[ 5 ],
		c * m[ 3 ] - s * m[ 0 ], c * m[ 4 ] - s * m[ 1 ], c * m[ 5 ] - s * m[ 2 ],
	];

}

function emptyIR() {

	return {
		film: null, camera: null, namedMaterials: new Map(), namedTextures: new Map(), shapes: [], lights: [],
		instances: new Map(), instanceCount: 0, skippedInstances: 0, objects: new Map(), media: new Map(),
		transformTimes: { start: 0, end: 1 }, hasMotion: false, warnings: [],
	};

}

const param = ( value, type = 'float' ) => ( { type, value } );
const word = value => ( { type: 'string', value: [ value ] } );

function opMatrix( name, value ) {

	const kind = name.split( ':' )[ 1 ];
	if ( value === undefined || value === null ) return null;
	const m = new Matrix4();
	switch ( kind ) {

		case 'translate': return m.makeTranslation( value[ 0 ], value[ 1 ], value[ 2 ] );
		case 'scale': return typeof value === 'number' ? m.makeScale( value, value, value ) : m.makeScale( value[ 0 ], value[ 1 ], value[ 2 ] );
		case 'rotateX': return m.makeRotationX( value * DEG );
		case 'rotateY': return m.makeRotationY( value * DEG );
		case 'rotateZ': return m.makeRotationZ( value * DEG );
		case 'orient': return m.makeRotationFromQuaternion( new Quaternion( value[ 0 ], value[ 1 ], value[ 2 ], value[ 3 ] ).normalize() );
		case 'transform': return m.fromArray( value );
		default: {

			// rotateXYZ turns about X first; three's Euler names its matrix product, so the order reverses.
			const axes = /^rotate([XYZ]{3})$/.exec( kind );
			if ( ! axes ) return null;
			return m.makeRotationFromEuler( new Euler( value[ 0 ] * DEG, value[ 1 ] * DEG, value[ 2 ] * DEG, [ ...axes[ 1 ] ].reverse().join( '' ) ) );

		}

	}

}

function localTransform( prim ) {

	const matrix = new Matrix4();
	let reset = false;
	for ( const raw of prim.value( 'xformOpOrder' ) ?? [] ) {

		if ( raw === '!resetXformStack!' ) {

			reset = true;
			matrix.identity();
			continue;

		}

		const invert = raw.startsWith( '!invert!' );
		const name = invert ? raw.slice( 8 ) : raw;
		const op = opMatrix( name, prim.value( name ) );
		if ( ! op ) continue;
		if ( invert ) op.invert();
		matrix.multiply( op );

	}

	return { matrix, reset };

}

function primvar( prim, name ) {

	const attr = `primvars:${name}`;
	const values = prim.value( attr );
	if ( values === undefined || values === null || values.length === 0 ) return null;
	const indices = prim.value( `${attr}:indices` );
	return { values, interpolation: prim.propertyMeta( attr, 'interpolation' ) ?? 'constant', indices: indices?.length ? indices : null };

}

function meanColor( pv ) {

	if ( ! pv ) return null;
	const { values } = pv;
	const sum = [ 0, 0, 0 ];
	const n = Math.floor( values.length / 3 );
	if ( n === 0 ) return null;
	for ( let i = 0; i < n; i ++ ) for ( let c = 0; c < 3; c ++ ) sum[ c ] += values[ i * 3 + c ];
	return sum.map( v => v / n );

}

function elementAt( pv, face, corner, point ) {

	const i = pv.interpolation === 'faceVarying' ? corner : pv.interpolation === 'uniform' ? face : pv.interpolation === 'constant' ? 0 : point;
	return pv.indices ? pv.indices[ i ] : i;

}

const perCorner = pv => pv && ( pv.indices || pv.interpolation === 'faceVarying' || pv.interpolation === 'uniform' || pv.interpolation === 'constant' );

/** Fan triangles; a primvar that varies per face corner makes each corner a vertex of its own. */
function triangulate( mesh, faces ) {

	const { points, counts, offsets, fvi, leftHanded, normals, uv } = mesh;
	const corners = perCorner( normals ) || perCorner( uv );
	let triangles = 0, cornerCount = 0;
	for ( const f of faces ) {

		if ( counts[ f ] >= 3 ) {

			triangles += counts[ f ] - 2;
			cornerCount += counts[ f ];

		}

	}

	const index = new Uint32Array( triangles * 3 );
	let t = 0;
	const fan = ( base, n, at ) => {

		for ( let k = 1; k + 1 < n; k ++ ) {

			index[ t ++ ] = at( base, 0 );
			index[ t ++ ] = at( base, leftHanded ? k + 1 : k );
			index[ t ++ ] = at( base, leftHanded ? k : k + 1 );

		}

	};

	if ( ! corners ) {

		for ( const f of faces ) if ( counts[ f ] >= 3 ) fan( offsets[ f ], counts[ f ], ( o, k ) => fvi[ o + k ] );
		const pointCount = points.length / 3;
		return {
			P: points,
			N: normals && normals.values.length === pointCount * 3 ? normals.values : null,
			uv: uv && uv.values.length === pointCount * 2 ? uv.values : null,
			index,
		};

	}

	const P = new Float32Array( cornerCount * 3 );
	const N = normals ? new Float32Array( cornerCount * 3 ) : null;
	const UV = uv ? new Float32Array( cornerCount * 2 ) : null;
	let v = 0;
	for ( const f of faces ) {

		const n = counts[ f ];
		if ( n < 3 ) continue;
		const base = v;
		for ( let k = 0; k < n; k ++ ) {

			const c = offsets[ f ] + k;
			const p = fvi[ c ];
			P[ v * 3 ] = points[ p * 3 ];
			P[ v * 3 + 1 ] = points[ p * 3 + 1 ];
			P[ v * 3 + 2 ] = points[ p * 3 + 2 ];
			if ( N ) {

				const e = elementAt( normals, f, c, p ) * 3;
				N[ v * 3 ] = normals.values[ e ];
				N[ v * 3 + 1 ] = normals.values[ e + 1 ];
				N[ v * 3 + 2 ] = normals.values[ e + 2 ];

			}

			if ( UV ) {

				const e = elementAt( uv, f, c, p ) * 2;
				UV[ v * 2 ] = uv.values[ e ];
				UV[ v * 2 + 1 ] = uv.values[ e + 1 ];

			}

			v ++;

		}

		fan( base, n, ( o, k ) => o + k );

	}

	return { P, N, uv: UV, index };

}

function geometryArrays( geometry, axis ) {

	if ( axis === 'Z' ) geometry.rotateX( Math.PI / 2 );
	else if ( axis === 'X' ) geometry.rotateZ( - Math.PI / 2 );
	const P = geometry.getAttribute( 'position' ).array;
	const N = geometry.getAttribute( 'normal' )?.array ?? null;
	const uv = geometry.getAttribute( 'uv' )?.array ?? null;
	const index = geometry.index ? Uint32Array.from( geometry.index.array ) : Uint32Array.from( { length: P.length / 3 }, ( _, i ) => i );
	return { P, N, uv, index };

}

function quantize( rgb ) {

	return rgb.map( v => Math.round( Math.min( Math.max( v, 0 ), 64 ) / GRID ) * GRID );

}

/** A fixed pseudo-random number in [0, 1) for item `i` of the set `salt`: what thinning keeps is the same every load. */
function hash01( i, salt ) {

	let h = Math.imul( i ^ salt, 0x9E3779B1 );
	h = Math.imul( h ^ ( h >>> 15 ), 0x85EBCA6B );
	h = Math.imul( h ^ ( h >>> 13 ), 0xC2B2AE35 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

}

function saltOf( text ) {

	let h = 0x811C9DC5;
	for ( let i = 0; i < text.length; i ++ ) h = Math.imul( h ^ text.charCodeAt( i ), 0x01000193 );
	return h;

}

/** Spans of one curve as tessellateCurves draws it. */
function curveSpans( n, type, basis, wrap ) {

	if ( type === 'linear' ) return wrap === 'periodic' ? n : n - 1;
	if ( basis === 'bezier' ) return wrap === 'periodic' ? n / 3 : ( n - 1 ) / 3;
	if ( wrap === 'periodic' ) return n;
	if ( wrap === 'pinned' ) return n + 1;
	return n - 3;

}

// Adaptive tessellation keeps about this share of the uniform strip's triangles on Moana's curves.
const ADAPTIVE_SHARE = 0.65;

/**
 * Rates that fit `demands` (key → cost) into `room`, smallest first: what fits under an even share is kept whole, and
 * what is left is shared evenly among the rest — fronds and flowers stay, grass and ground cover thin.
 */
function fill( demands, room ) {

	const rates = new Map();
	const sorted = [ ...demands ].sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
	let left = Math.max( 0, room );
	for ( let i = 0; i < sorted.length; i ++ ) {

		const demand = sorted[ i ][ 1 ];
		const share = left / ( sorted.length - i );
		if ( demand <= share ) {

			left -= demand;
			continue;

		}

		for ( let k = i; k < sorted.length; k ++ ) rates.set( sorted[ k ][ 0 ], share / sorted[ k ][ 1 ] );
		break;

	}

	return rates;

}

/** Primvar elements per curve under each interpolation, as tessellateCurves reads them. */
function curveElements( n, mode, type, basis ) {

	if ( mode === 'vertex' ) return n;
	if ( mode === 'varying' ) return Math.max( 1, Math.round( type === 'linear' ? n - 1 : basis === 'bezier' ? ( n - 1 ) / 3 : n - 3 ) + 1 );
	return 1;

}

/** Keeps each curve with chance `rate`, with its points and primvars; null when none is kept. */
function thinCurves( curve, rate, salt ) {

	const { counts, type, basis } = curve;
	const kept = [];
	const quota = Math.floor( counts.length * rate );
	for ( let c = 0; c < counts.length && kept.length < quota; c ++ ) if ( hash01( c, salt ) < rate ) kept.push( c );
	if ( kept.length === 0 ) return null;
	if ( kept.length === counts.length ) return curve;

	const pick = ( values, size, mode ) => {

		if ( ! values?.length || ! mode || mode === 'constant' ) return values;
		const starts = new Int32Array( counts.length + 1 );
		for ( let c = 0; c < counts.length; c ++ ) starts[ c + 1 ] = starts[ c ] + curveElements( counts[ c ], mode, type, basis );
		let total = 0;
		for ( const c of kept ) total += starts[ c + 1 ] - starts[ c ];
		const out = new values.constructor( total * size );
		let o = 0;
		for ( const c of kept ) {

			const chunk = values.subarray( starts[ c ] * size, starts[ c + 1 ] * size );
			out.set( chunk, o );
			o += chunk.length;

		}

		return out;

	};

	return {
		...curve,
		points: pick( curve.points, 3, 'vertex' ),
		counts: Int32Array.from( kept, c => counts[ c ] ),
		widths: pick( curve.widths, 1, curve.widthMode ),
		normals: pick( curve.normals, 3, curve.normalMode ),
	};

}

export class USDSceneReader {

	/** `pause( prims, counting )` is awaited every 256 prims, `counting` during the counting pass. */
	constructor( stage, { maxTriangles = Infinity, maxPlacements = Infinity, curveSteps = 2, resolveImage = async () => null, warn = () => {}, pause = null } = {} ) {

		this.stage = stage;
		this.pause = pause;
		this._visited = 0;
		this.maxTriangles = maxTriangles;
		this.maxPlacements = maxPlacements;
		this.curveSteps = curveSteps;
		this.resolveImage = resolveImage;
		this.warn = warn;
		this.ir = emptyIR();
		this.cameras = [];
		this.lights = [];
		this.domes = [];
		this.prototypes = new Map();
		this._surfaces = new Map();
		this._colored = new Map();
		this._wrappers = new Map();
		this._images = new Map();
		this._handed = new WeakSet();
		this._warned = new Set();
		this._protoCount = 0;
		this._geometries = new Map();
		this._specIds = new WeakMap();
		this._nextSpecId = 0;
		this.dry = false;
		this.cost = null;
		this.placementRates = new Map();
		this.curveRates = new Map();
		this.fitNote = null;

	}

	warnOnce( key, message ) {

		if ( this._warned.has( key ) ) return;
		this._warned.add( key );
		this.warn( message );

	}

	async read() {

		if ( Number.isFinite( this.maxTriangles ) || Number.isFinite( this.maxPlacements ) ) await this.fit();
		await this.walk();
		this.shareGeometry();
		return { ir: this.ir, cameras: this.cameras, lights: this.lights, dome: this.pickDome(), cost: this.cost };

	}

	async walk() {

		this._visited = 0;
		const root = this.stage.pseudoRoot;
		const top = this.stage.upAxis === 'Z' ? new Matrix4().makeRotationX( - Math.PI / 2 ) : new Matrix4();
		for ( const name of root.childNames() ) {

			const prim = await this.stage.child( root, name );
			if ( prim ) await this.visit( prim, top, this.world(), { binding: null, depth: 0 } );
			this.stage.release();

		}

	}

	/**
	 * Counts what the whole scene costs first, so that one too large for the budgets is thinned evenly — curves, then
	 * point instancers' copies — rather than losing whatever is read last. Meshes are never thinned.
	 */
	async fit() {

		this.dry = true;
		this.cost = { mesh: 0, curves: 0, placements: 0, scatter: 0, counted: new Set(), curveSets: new Map(), instancers: new Map() };
		await this.walk();
		this.dry = false;
		this.prototypes.clear();

		const { mesh, curves, placements, scatter, curveSets, instancers } = this.cost;
		delete this.cost.counted;
		delete this.cost.curveSets;
		delete this.cost.instancers;
		if ( placements > this.maxPlacements ) this.placementRates = fill( instancers, ( this.maxPlacements - ( placements - scatter ) ) * 0.98 );
		if ( mesh + curves > this.maxTriangles ) this.curveRates = fill( curveSets, ( this.maxTriangles - mesh ) * 0.95 );

		const m = v => `${( v / 1e6 ).toFixed( 1 )}M`;
		const kept = ( rates, demands ) => {

			let all = 0, left = 0;
			for ( const [ key, demand ] of demands ) {

				all += demand;
				left += demand * ( rates.get( key ) ?? 1 );

			}

			return `${Math.round( left / all * 100 )} %`;

		};

		const notes = [];
		if ( this.placementRates.size || this.curveRates.size ) notes.push(
			`USD scene is ${m( mesh + curves )} triangles (${m( curves )} of curves) and ${m( placements )} placed copies, past the budgets ` +
			`(${m( this.maxTriangles )}, ${m( this.maxPlacements )}): ${kept( this.curveRates, curveSets )} of the curves and ` +
			`${kept( this.placementRates, instancers )} of the scattered copies kept, the largest sets thinned most`
		);
		if ( mesh > this.maxTriangles ) notes.push(
			`its meshes alone are ${m( mesh )} triangles, past the ${m( this.maxTriangles )} budget: what is read last is cut. ` +
			'Load fewer parts, or raise maxTriangles (memory spill raises it)'
		);
		this.fitNote = notes.join( '; ' ) || null;
		if ( this.fitNote ) this.warn( this.fitNote );

	}

	world() {

		if ( this.dry ) return { isWorld: true, shape: () => this.cost.placements ++, place: proto => this.countPrototype( proto, 1, false ), instancer: spec => this.countInstancer( spec, 1 ) };
		return {
			isWorld: true,
			shape: ( shape, matrix ) => {

				shape.ctm = Array.from( matrix.elements );
				this.ir.shapes.push( shape );

			},
			place: ( proto, matrix ) => this.placePrototype( proto, matrix ),
			instancer: ( spec, matrix ) => this.placeInstancer( spec, matrix ),
		};

	}

	collector( proto ) {

		if ( this.dry ) return { isWorld: false, shape: ( _, matrix ) => proto.shapes.push( matrix ? matrix.elements.join( ',' ) : '' ), place: inner => proto.nested.push( { proto: inner } ), instancer: spec => proto.nested.push( { instancer: spec } ) };
		return {
			isWorld: false,
			shape: ( shape, matrix ) => {

				shape.ctm = Array.from( matrix.elements );
				proto.shapes.push( shape );

			},
			place: ( inner, matrix ) => proto.nested.push( { proto: inner, matrix: matrix.clone() } ),
			instancer: ( spec, matrix ) => proto.nested.push( { instancer: spec, matrix: matrix.clone() } ),
		};

	}

	async visit( prim, parent, out, ctx ) {

		if ( this.pause && ( ++ this._visited & 255 ) === 0 ) await this.pause( this._visited, this.dry );
		if ( ! prim.isDefined || prim.meta( 'active' ) === false ) return;
		if ( prim.value( 'visibility' ) === 'invisible' ) return;
		const purpose = prim.value( 'purpose' );
		if ( purpose === 'guide' || purpose === 'proxy' ) return;

		const type = prim.typeName;
		if ( SKIPPED.has( type ) ) {

			if ( type === 'Volume' ) this.warnOnce( 'volume', 'USD volumes are not rendered — skipped' );
			return;

		}

		const { matrix: local, reset } = localTransform( prim );
		const matrix = reset ? local : new Matrix4().multiplyMatrices( parent, local );
		const binding = this.bindingOf( prim ) ?? ctx.binding;

		if ( prim.meta( 'instanceable' ) === true && prim.childNames().length ) {

			const proto = await this.instancePrototype( prim, binding );
			if ( proto ) out.place( proto, matrix );
			return;

		}

		if ( type === 'Mesh' ) await this.mesh( prim, matrix, out, binding );
		else if ( type === 'BasisCurves' ) await this.curves( prim, matrix, out, binding );
		else if ( GPRIMS.has( type ) ) await this.gprim( prim, matrix, out, binding );
		else if ( type === 'PointInstancer' ) {

			await this.pointInstancer( prim, matrix, out, binding );
			return;

		} else if ( type === 'Camera' ) {

			if ( out.isWorld && ! this.dry ) this.camera( prim, matrix );

		} else if ( LIGHT_TYPES.has( type ) ) {

			if ( this.dry ) return;
			if ( out.isWorld ) this.light( prim, type, matrix );
			else this.warnOnce( 'protoLight', 'USD lights inside instanced prims are not placed — skipped' );

		} else if ( type === 'NurbsPatch' || type === 'NurbsCurves' || type === 'Points' || type === 'HermiteCurves' ) {

			this.warnOnce( `type:${type}`, `USD ${type} prims are not supported — skipped` );

		}

		for ( const name of prim.childNames() ) {

			const child = await this.stage.child( prim, name );
			if ( child ) await this.visit( child, matrix, out, { binding, depth: ctx.depth + 1 } );
			// A top prim's children are usually whole assets (Moana's elements): what one read is let go before the next.
			if ( ctx.depth === 0 && out.isWorld ) this.stage.release();

		}

	}

	bindingOf( prim ) {

		for ( const name of [ 'material:binding:full', 'material:binding' ] ) {

			const [ target ] = prim.targets( name );
			if ( target ) return target;

		}

		return null;

	}

	// ── instancing ───────────────────────────────────────────────

	newPrototype() {

		return { name: `usd_proto_${this._protoCount ++}`, shapes: [], nested: [], registered: false };

	}

	register( proto ) {

		if ( proto.shapes.length && ! proto.registered && ! this.dry ) {

			this.ir.objects.set( proto.name, proto.shapes );
			proto.registered = true;

		}

		return proto.shapes.length || proto.nested.length ? proto : null;

	}

	async instancePrototype( prim, binding ) {

		const key = `instance|${prim.instanceKey()}|${binding ?? ''}`;
		if ( this.prototypes.has( key ) ) return this.prototypes.get( key );
		const proto = this.newPrototype();
		this.prototypes.set( key, proto );
		const out = this.collector( proto );
		for ( const name of prim.childNames() ) {

			const child = await this.stage.child( prim, name );
			if ( child ) await this.visit( child, new Matrix4(), out, { binding, depth: Infinity } );

		}

		const result = this.register( proto );
		this.prototypes.set( key, result );
		return result;

	}

	/** A point instancer prototype: its root prim and everything under it, the root's own transform included. */
	async instancerPrototype( prim, binding ) {

		const key = `proto|${prim.path}`;
		if ( this.prototypes.has( key ) ) return this.prototypes.get( key );
		const proto = this.newPrototype();
		this.prototypes.set( key, proto );
		await this.visit( prim, new Matrix4(), this.collector( proto ), { binding, depth: Infinity } );
		const result = this.register( proto );
		this.prototypes.set( key, result );
		return result;

	}

	addInstance( name, matrix ) {

		const ir = this.ir;
		if ( ir.instanceCount >= this.maxPlacements ) {

			ir.skippedInstances ++;
			return;

		}

		let list = ir.instances.get( name );
		if ( ! list ) ir.instances.set( name, list = { name, count: 0, matrices: new Float32Array( 16 * 32 ), matricesEnd: null } );
		const need = ( list.count + 1 ) * 16;
		if ( need > list.matrices.length ) {

			const grown = new Float32Array( Math.max( need, list.matrices.length * 2 ) );
			grown.set( list.matrices );
			list.matrices = grown;

		}

		list.matrices.set( matrix.elements, list.count * 16 );
		list.count ++;
		ir.instanceCount ++;

	}

	// The builder places a template's shapes at one relative transform as one object, so a copy costs one placement
	// per distinct transform among its shapes.
	countPrototype( proto, n, scatter ) {

		if ( proto.shapes.length ) {

			proto.placeKeys ??= new Set( proto.shapes ).size;
			this.cost.placements += n * proto.placeKeys;
			if ( scatter ) this.cost.scatter += n * proto.placeKeys;

		}

		for ( const nested of proto.nested ) {

			if ( nested.proto ) this.countPrototype( nested.proto, n, scatter );
			else this.countInstancer( nested.instancer, n );

		}

	}

	countInstancer( spec, n ) {

		const before = this.cost.scatter;
		spec.histogram.forEach( ( count, p ) => {

			if ( spec.protos[ p ] && count ) this.countPrototype( spec.protos[ p ], n * count, true );

		} );
		this.cost.instancers.set( spec.path, ( this.cost.instancers.get( spec.path ) ?? 0 ) + this.cost.scatter - before );

	}

	placePrototype( proto, matrix ) {

		if ( proto.shapes.length ) this.addInstance( proto.name, matrix );
		for ( const nested of proto.nested ) {

			const m = new Matrix4().multiplyMatrices( matrix, nested.matrix );
			if ( nested.proto ) this.placePrototype( nested.proto, m );
			else this.placeInstancer( nested.instancer, m );

		}

	}

	placeInstancer( spec, world ) {

		const { protos, protoIndices, positions, orientations, scales, hidden, salt } = spec;
		const rate = spec.rate;
		let quota = rate < 1 ? Math.floor( protoIndices.length * rate ) : Infinity;
		const instance = new Matrix4(), m = new Matrix4();
		const q = new Quaternion(), p = new Vector3(), s = new Vector3();
		for ( let i = 0; i < protoIndices.length; i ++ ) {

			if ( this.ir.instanceCount >= this.maxPlacements ) {

				this.ir.skippedInstances += protoIndices.length - i;
				return;

			}

			const proto = protos[ protoIndices[ i ] ];
			if ( ! proto || hidden?.has( i ) || ( rate < 1 && ( quota <= 0 || hash01( i, salt ) >= rate ) ) ) continue;
			quota --;
			p.set( positions[ i * 3 ], positions[ i * 3 + 1 ], positions[ i * 3 + 2 ] );
			if ( orientations ) q.set( orientations[ i * 4 ], orientations[ i * 4 + 1 ], orientations[ i * 4 + 2 ], orientations[ i * 4 + 3 ] ).normalize();
			else q.identity();
			if ( scales ) s.set( scales[ i * 3 ], scales[ i * 3 + 1 ], scales[ i * 3 + 2 ] );
			else s.set( 1, 1, 1 );
			instance.compose( p, q, s );
			this.placePrototype( proto, m.multiplyMatrices( world, instance ) );

		}

	}

	async pointInstancer( prim, matrix, out, binding ) {

		const protoIndices = prim.value( 'protoIndices' );
		if ( ! protoIndices?.length ) return;
		const positions = this.dry ? null : prim.value( 'positions' );
		if ( ! this.dry && ! positions?.length ) return;
		const protos = [];
		for ( const path of prim.targets( 'prototypes' ) ) {

			const target = await this.stage.primAt( path );
			protos.push( target ? await this.instancerPrototype( target, binding ) : null );

		}

		const invisible = prim.value( 'invisibleIds' );
		let hidden = null;
		if ( invisible?.length ) {

			const ids = prim.value( 'ids' );
			const byId = new Map();
			if ( ids?.length ) for ( let i = 0; i < ids.length; i ++ ) byId.set( Number( ids[ i ] ), i );
			hidden = new Set( Array.from( invisible, id => ( ids?.length ? byId.get( Number( id ) ) : Number( id ) ) ) );

		}

		if ( this.dry ) {

			const histogram = new Float64Array( protos.length );
			for ( let i = 0; i < protoIndices.length; i ++ ) if ( ! hidden?.has( i ) ) histogram[ protoIndices[ i ] ] ++;
			out.instancer( { protos, histogram, path: prim.path } );
			return;

		}

		const orientations = prim.value( 'orientations' );
		const scales = prim.value( 'scales' );
		out.instancer( {
			protos, protoIndices, positions, salt: saltOf( prim.path ), rate: this.placementRates.get( prim.path ) ?? 1,
			orientations: orientations?.length === protoIndices.length * 4 ? orientations : null,
			scales: scales?.length === protoIndices.length * 3 ? scales : null,
			hidden,
		}, matrix );

	}

	// ── geometry ─────────────────────────────────────────────────

	/** An array handed to the builder is its alone: it frees each one once the shape is merged. */
	own( array ) {

		if ( ! array ) return array;
		if ( this._handed.has( array ) ) return array.slice();
		this._handed.add( array );
		return array;

	}

	shape( prim, type, params, material ) {

		return { type, params, ctm: null, material, areaLight: null, reverseOrientation: false, interior: null, name: prim.path };

	}

	specId( prop ) {

		if ( ! prop ) return 0;
		let id = this._specIds.get( prop );
		if ( ! id ) this._specIds.set( prop, id = ++ this._nextSpecId );
		return id;

	}

	/** The same specs give the same triangles: a mesh read again under another prim shares its geometry. */
	geometryKey( prim, uvSet ) {

		const id = name => this.specId( prim.property( name ) );
		const uv = uvSet ?? 'st';
		return [ id( 'points' ), id( 'faceVertexIndices' ), id( 'faceVertexCounts' ), id( 'holeIndices' ), id( 'primvars:normals' ),
			id( 'normals' ), uv, id( `primvars:${uv}` ), id( `primvars:${uv}:indices` ), prim.value( 'orientation' ) ?? '' ].join( '|' );

	}

	countGeometry( key, kind, triangles ) {

		if ( this.cost.counted.has( key ) ) return;
		this.cost.counted.add( key );
		this.cost[ kind ] += triangles;

	}

	meshParams( prim, faces, uvSet ) {

		const points = prim.value( 'points' );
		const counts = prim.value( 'faceVertexCounts' );
		const fvi = prim.value( 'faceVertexIndices' );
		if ( ! points?.length || ! counts?.length || ! fvi?.length ) return null;

		const offsets = new Int32Array( counts.length );
		for ( let f = 1; f < counts.length; f ++ ) offsets[ f ] = offsets[ f - 1 ] + counts[ f - 1 ];
		if ( ! faces ) {

			const holes = new Set( prim.value( 'holeIndices' ) ?? [] );
			faces = [];
			for ( let f = 0; f < counts.length; f ++ ) if ( ! holes.has( f ) ) faces.push( f );

		}

		const normals = primvar( prim, 'normals' ) ?? ( prim.value( 'normals' )?.length ? { values: prim.value( 'normals' ), interpolation: prim.propertyMeta( 'normals', 'interpolation' ) ?? 'vertex', indices: null } : null );
		const uv = primvar( prim, uvSet ) ?? ( uvSet === 'st' ? primvar( prim, 'uv' ) ?? primvar( prim, 'st0' ) ?? primvar( prim, 'UVMap' ) : null );
		const built = triangulate( { points, counts, offsets, fvi, leftHanded: prim.value( 'orientation' ) === 'leftHanded', normals, uv }, faces );
		if ( built.index.length === 0 ) return null;
		const params = { P: param( this.own( built.P ), 'point3' ), indices: param( built.index, 'integer' ) };
		if ( built.N ) params.N = param( this.own( built.N ), 'normal' );
		if ( built.uv ) params.uv = param( this.own( built.uv ), 'point2' );
		return params;

	}

	async mesh( prim, matrix, out, binding ) {

		const subsets = [];
		for ( const name of prim.childNames() ) {

			const subset = await this.stage.child( prim, name );
			if ( subset?.typeName !== 'GeomSubset' || ( subset.value( 'elementType' ) ?? 'face' ) !== 'face' ) continue;
			const family = subset.value( 'familyName' );
			const target = this.bindingOf( subset );
			if ( target && ( ! family || family === 'materialBind' ) ) subsets.push( { subset, target } );

		}

		if ( this.dry ) {

			const counts = prim.value( 'faceVertexCounts' );
			if ( ! prim.property( 'points' ) || ! counts?.length ) return;
			const holes = new Set( prim.value( 'holeIndices' ) ?? [] );
			let triangles = 0;
			for ( let f = 0; f < counts.length; f ++ ) if ( counts[ f ] > 2 && ! holes.has( f ) ) triangles += counts[ f ] - 2;
			this.countGeometry( this.geometryKey( prim, null ), 'mesh', triangles );
			out.shape( null, matrix );
			return;

		}

		if ( subsets.length === 0 ) {

			const { material, uvSet } = await this.materialFor( binding, prim );
			const key = this.geometryKey( prim, uvSet );
			const known = this._geometries.get( key );
			if ( known ) {

				const shape = this.shape( prim, 'trianglemesh', known.params, material );
				known.shapes.push( shape );
				out.shape( shape, matrix );
				return;

			}

			const params = this.meshParams( prim, null, uvSet );
			if ( ! params ) return;
			const shape = this.shape( prim, 'trianglemesh', params, material );
			this._geometries.set( key, { params, shapes: [ shape ] } );
			out.shape( shape, matrix );
			return;

		}

		const counts = prim.value( 'faceVertexCounts' );
		if ( ! counts?.length ) return;
		const holes = new Set( prim.value( 'holeIndices' ) ?? [] );
		const groups = [];
		const claimed = new Set();
		for ( const { subset, target } of subsets ) {

			const faces = Array.from( subset.value( 'indices' ) ?? [] ).filter( f => f < counts.length && ! holes.has( f ) && ! claimed.has( f ) );
			for ( const f of faces ) claimed.add( f );
			if ( faces.length ) groups.push( { faces, binding: target } );

		}

		const rest = [];
		for ( let f = 0; f < counts.length; f ++ ) if ( ! holes.has( f ) && ! claimed.has( f ) ) rest.push( f );
		if ( rest.length ) groups.unshift( { faces: rest, binding } );

		for ( const group of groups ) {

			const { material, uvSet } = await this.materialFor( group.binding, prim );
			const params = this.meshParams( prim, group.faces, uvSet );
			if ( params ) out.shape( this.shape( prim, 'trianglemesh', params, material ), matrix );

		}

	}

	async curves( prim, matrix, out, binding ) {

		const counts = prim.value( 'curveVertexCounts' );
		if ( ! counts?.length || ! prim.property( 'points' ) ) return;
		const type = prim.value( 'type' ) ?? 'cubic';
		const basis = prim.value( 'basis' ) ?? 'bezier';
		const wrap = prim.value( 'wrap' ) ?? 'nonperiodic';

		if ( this.dry ) {

			let segments = 0;
			for ( let c = 0; c < counts.length; c ++ ) segments += Math.max( 1, Math.round( curveSpans( counts[ c ], type, basis, wrap ) * this.curveSteps ) * ADAPTIVE_SHARE );
			const key = `curves|${this.specId( prim.property( 'points' ) )}|${this.specId( prim.property( 'curveVertexCounts' ) )}`;
			if ( ! this.cost.counted.has( key ) ) this.cost.curveSets.set( prim.path, segments * 2 );
			this.countGeometry( key, 'curves', segments * 2 );
			out.shape( null, matrix );
			return;

		}

		const widthName = prim.property( 'widths' ) ? 'widths' : 'primvars:widths';
		const normalName = prim.property( 'normals' ) ? 'normals' : 'primvars:normals';
		let curve = {
			points: prim.value( 'points' ), counts, type, basis, wrap,
			widths: prim.value( widthName ) ?? null,
			widthMode: prim.propertyMeta( widthName, 'interpolation' ) ?? null,
			normals: prim.value( normalName ) ?? null,
			normalMode: prim.propertyMeta( normalName, 'interpolation' ) ?? 'vertex',
		};
		if ( curve.widths?.length ) curve.widthMode ??= curve.widths.length === 1 ? 'constant' : 'vertex';
		const rate = this.curveRates.get( prim.path ) ?? 1;
		if ( rate < 1 ) curve = thinCurves( curve, rate, saltOf( prim.path ) );
		if ( ! curve ) return;

		const params = {
			P: param( this.own( curve.points ), 'point3' ),
			counts: param( this.own( curve.counts ), 'integer' ),
			type: word( type ), basis: word( basis ), wrap: word( wrap ),
		};

		if ( curve.widths?.length ) {

			params.widths = param( this.own( curve.widths ) );
			params.widthMode = word( curve.widthMode );

		}

		if ( curve.normals?.length ) {

			params.N = param( this.own( curve.normals ), 'normal' );
			params.normalMode = word( curve.normalMode );

		}

		const { material } = await this.materialFor( binding, prim );
		out.shape( this.shape( prim, 'curves', params, material ), matrix );

	}

	/** Shapes that read one mesh share its geometry; the builder keeps such a shape whole rather than merging it. */
	shareGeometry() {

		for ( const [ key, { shapes } ] of this._geometries ) {

			if ( shapes.length < 2 ) continue;
			for ( const shape of shapes ) {

				shape.shared = true;
				shape.geometryKey = key;

			}

		}

		this._geometries.clear();

	}

	async gprim( prim, matrix, out, binding ) {

		const axis = prim.value( 'axis' ) ?? 'Z';
		const radius = prim.value( 'radius' ) ?? 1;
		const height = prim.value( 'height' ) ?? 2;
		let geometry;
		switch ( prim.typeName ) {

			case 'Sphere': geometry = new SphereGeometry( radius, 48, 24 ); break;
			case 'Cube': {

				const size = prim.value( 'size' ) ?? 2;
				geometry = new BoxGeometry( size, size, size );
				break;

			}

			case 'Cylinder': geometry = new CylinderGeometry( radius, radius, height, 48 ); break;
			case 'Cone': geometry = new ConeGeometry( radius, height, 48 ); break;
			case 'Capsule': geometry = new CapsuleGeometry( radius, height, 8, 32 ); break;
			default: geometry = new PlaneGeometry( prim.value( 'width' ) ?? 2, prim.value( 'length' ) ?? 2 );

		}

		const arrays = geometryArrays( geometry, prim.typeName === 'Plane' ? ( axis === 'Z' ? 'none' : axis ) : axis );
		geometry.dispose();
		if ( this.dry ) {

			this.countGeometry( `gprim|${prim.path}`, 'mesh', arrays.index.length / 3 );
			out.shape( null, matrix );
			return;

		}

		const params = { P: param( arrays.P, 'point3' ), indices: param( arrays.index, 'integer' ) };
		if ( arrays.N ) params.N = param( arrays.N, 'normal' );
		if ( arrays.uv ) params.uv = param( arrays.uv, 'point2' );
		const { material } = await this.materialFor( binding, prim );
		out.shape( this.shape( prim, 'trianglemesh', params, material ), matrix );

	}

	// ── materials ────────────────────────────────────────────────

	async materialFor( path, prim ) {

		const surface = path ? await this.surface( path ) : null;
		let material = surface?.material ?? null;
		const display = primvar( prim, 'displayColor' );

		if ( ! material ) {

			const rgb = meanColor( display ) ?? [ 0.18, 0.18, 0.18 ];
			material = this.colored( null, rgb );

		} else if ( surface.perMesh ) {

			const mean = meanColor( primvar( prim, surface.perMesh.primvar ) );
			if ( mean ) material = this.colored( material, mean.map( ( v, c ) => Math.max( v, 0 ) ** ( surface.perMesh.exponent?.[ c ] ?? 1 ) ) );
			else this.warnOnce( 'nodisplay', `USD material "${path}" takes its colour from "${surface.perMesh.primvar}", which a mesh lacks — its fallback used` );

		}

		let wrapper = this._wrappers.get( material );
		if ( ! wrapper ) this._wrappers.set( material, wrapper = { type: 'usd', material } );
		return { material: wrapper, uvSet: surface?.uvSet ?? 'st' };

	}

	/** One material per colour, on an 8-bit grid so near-identical meshes share it. */
	colored( base, rgb ) {

		const color = quantize( rgb );
		const key = `${base?.uuid ?? 'plain'}|${color.join( ',' )}`;
		let material = this._colored.get( key );
		if ( ! material ) {

			material = base ? cloneMaterial( base ) : new MeshPhysicalMaterial( { side: DoubleSide, roughness: 0.5, metalness: 0 } );
			material.color.setRGB( color[ 0 ], color[ 1 ], color[ 2 ] );
			if ( base?.userData.diffuseTransmissionFromBase ) material.diffuseTransmissionColor = material.color.clone();
			this._colored.set( key, material );

		}

		return material;

	}

	async surface( path ) {

		if ( this._surfaces.has( path ) ) return this._surfaces.get( path );
		const pending = this.buildSurface( path );
		this._surfaces.set( path, pending );
		return pending;

	}

	async buildSurface( path ) {

		const prim = await this.stage.primAt( path );
		if ( ! prim ) {

			this.warnOnce( `nomat:${path}`, `USD material "${path}" not found` );
			return null;

		}

		// MaterialX first: where a material carries both, its preview surface is the simpler stand-in for viewers.
		const mtlx = await this.stage.connectionSource( prim, 'outputs:mtlx:surface' );
		const read = MTLX_SURFACES[ mtlxNode( mtlx?.prim.value( 'info:id' ) ?? 'ND_' ) ];
		if ( read ) return this[ read ]( mtlx.prim );

		for ( const output of [ 'outputs:ri:surface', 'outputs:surface', 'outputs:glslfx:surface' ] ) {

			const source = await this.stage.connectionSource( prim, output );
			const id = source?.prim.value( 'info:id' );
			if ( id === 'PxrDisneyBsdf' ) return this.disney( source.prim );
			if ( id === 'PxrSurface' ) return this.pxrSurface( source.prim );
			if ( id === 'UsdPreviewSurface' ) return this.previewSurface( source.prim );

		}

		this.warnOnce( `nosurface:${path}`, `USD material "${path}" has no surface shader read here — shaded grey` );
		return null;

	}

	async term( prim, name, hops = 0 ) {

		const attr = `inputs:${name}`;
		const [ source ] = prim.connections( attr );
		if ( source && hops < 32 ) {

			const dot = source.lastIndexOf( '.' );
			const from = await this.stage.primAt( source.slice( 0, dot ) );
			const prop = source.slice( dot + 1 );
			if ( from ) {

				const found = prop.startsWith( 'inputs:' ) ? await this.term( from, prop.slice( 7 ), hops + 1 )
					: prop.startsWith( 'outputs:' ) ? await this.output( from, prop.slice( 8 ), hops + 1 ) : null;
				if ( found ) return found;

			}

		}

		const value = prim.value( attr );
		return value === undefined ? null : { value };

	}

	async output( prim, name, hops ) {

		const id = prim.value( 'info:id' );
		switch ( id ) {

			case 'PxrColorCorrect': {

				const input = await this.term( prim, 'inputRGB', hops + 1 );
				const gamma = ( await this.term( prim, 'gamma', hops + 1 ) )?.value;
				if ( ! input || ! Array.isArray( gamma ) ) return input;
				const exponent = gamma.map( g => ( g > 0 ? 1 / g : 1 ) );
				if ( Array.isArray( input.value ) ) return { value: input.value.map( ( v, c ) => Math.max( v, 0 ) ** exponent[ c ] ) };
				return { ...input, exponent };

			}

			case 'PxrBlend':
				return await this.term( prim, 'bottomRGB', hops + 1 ) ?? this.term( prim, 'topRGB', hops + 1 );
			case 'PxrPtexture':
			case 'HwPtexTexture_1':
				// Ptex is not read here; scenes that ship it bake its colours into displayColor (Moana does).
				return { primvar: 'displayColor' };
			case 'UsdUVTexture': return this.texture( prim, name, hops );
			case 'UsdPrimvarReader_float':
			case 'UsdPrimvarReader_float2':
			case 'UsdPrimvarReader_float3':
			case 'UsdPrimvarReader_float4':
			case 'UsdPrimvarReader_normal':
			case 'UsdPrimvarReader_point':
			case 'UsdPrimvarReader_vector': {

				const varname = ( await this.term( prim, 'varname', hops + 1 ) )?.value;
				return varname ? { primvar: varname } : await this.term( prim, 'fallback', hops + 1 );

			}

			case 'UsdTransform2d': {

				const input = await this.term( prim, 'in', hops + 1 );
				if ( ! input?.texture ) return input;
				return { ...input, transform: { scale: prim.value( 'inputs:scale' ), translation: prim.value( 'inputs:translation' ), rotation: prim.value( 'inputs:rotation' ) } };

			}

			case undefined: {

				// A node graph's output, wired to whatever inside produces it.
				const [ next ] = prim.connections( `outputs:${name}` );
				if ( ! next ) return null;
				const dot = next.lastIndexOf( '.' );
				const from = await this.stage.primAt( next.slice( 0, dot ) );
				const prop = next.slice( dot + 1 );
				if ( ! from ) return null;
				return prop.startsWith( 'outputs:' ) ? this.output( from, prop.slice( 8 ), hops + 1 ) : this.term( from, prop.slice( 7 ), hops + 1 );

			}

			default:
				if ( id?.startsWith( 'ND_' ) ) return this.mtlxOutput( prim, id, name, hops );
				this.warnOnce( `shader:${id}`, `USD shader "${id}" is not read — its input left at its default` );
				return null;

		}

	}

	async texture( prim, channel, hops ) {

		const file = prim.assetPath( 'inputs:file' );
		const fallback = prim.value( 'inputs:fallback' );
		if ( ! file?.path ) {

			if ( file?.asset ) this.warnOnce( `tex:${file.asset}`, `USD texture "${file.asset}" not found` );
			return fallback ? { value: fallback } : null;

		}

		if ( PTEX.test( file.path ) ) return { primvar: 'displayColor' };
		if ( /<udim>/i.test( file.asset ) ) {

			this.warnOnce( 'udim', 'USD UDIM textures are not supported — skipped' );
			return null;

		}

		const st = await this.term( prim, 'st', hops + 1 );
		return {
			texture: {
				path: file.path,
				uvSet: st?.primvar ?? 'st',
				wrapS: prim.value( 'inputs:wrapS' ) ?? 'repeat',
				wrapT: prim.value( 'inputs:wrapT' ) ?? 'repeat',
				colorSpace: prim.value( 'inputs:sourceColorSpace' ) ?? 'auto',
				scale: prim.value( 'inputs:scale' ) ?? null,
			},
			channel,
		};

	}

	async image( spec, srgb ) {

		const key = `${spec.path}|${srgb}|${spec.wrapS}|${spec.wrapT}`;
		if ( ! this._images.has( key ) ) this._images.set( key, ( async () => {

			const texture = await this.resolveImage( spec.path );
			if ( ! texture ) {

				this.warnOnce( `img:${spec.path}`, `USD texture "${spec.path}" could not be read` );
				return null;

			}

			const out = texture.clone();
			out.userData.usdPath = spec.path;
			out.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
			out.wrapS = WRAP[ spec.wrapS ] ?? RepeatWrapping;
			out.wrapT = WRAP[ spec.wrapT ] ?? RepeatWrapping;
			out.needsUpdate = true;
			return out;

		} )() );
		return this._images.get( key );

	}

	async applyColor( mat, slot, term, surface, mapSlot ) {

		if ( ! term ) return;
		if ( Array.isArray( term.value ) ) mat[ slot ].setRGB( term.value[ 0 ], term.value[ 1 ], term.value[ 2 ] );
		else if ( typeof term.value === 'number' ) mat[ slot ].setRGB( term.value, term.value, term.value );
		else if ( term.primvar && slot === 'color' ) surface.perMesh = { primvar: term.primvar, exponent: term.exponent ?? null };
		else if ( term.texture && mapSlot ) {

			const map = await this.image( term.texture, term.texture.colorSpace !== 'raw' );
			if ( map ) {

				mat[ mapSlot ] = this.transformTexture( map, term.transform );
				const scale = term.texture.scale;
				mat[ slot ].setRGB( scale?.[ 0 ] ?? 1, scale?.[ 1 ] ?? 1, scale?.[ 2 ] ?? 1 );
				surface.uvSet = term.texture.uvSet;

			}

		}

	}

	/** A scalar slot from a term; a texture lands in `mapSlot` only from the channel the engine reads there. */
	async applyScalar( mat, slot, term, surface, mapSlot = null, channel = null ) {

		if ( ! term ) return;
		if ( typeof term.value === 'number' ) mat[ slot ] = term.value;
		else if ( term.texture && mapSlot ) {

			// A MaterialX float image of a grey map reads the same from any channel.
			if ( term.channel !== channel && ! term.mono ) {

				this.warnOnce( `chan:${mapSlot}:${term.channel}`, `USD ${slot} from a texture's "${term.channel}" channel is not supported (the engine reads "${channel}") — constant used` );
				return;

			}

			const map = await this.image( term.texture, false );
			if ( map ) {

				mat[ mapSlot ] = this.transformTexture( map, term.transform );
				mat[ slot ] = term.texture.scale?.[ 0 ] ?? 1;
				surface.uvSet = term.texture.uvSet;

			}

		}

	}

	/** The map placed by `transform`: a copy, since the image cache shares one texture between every material using it. */
	transformTexture( map, transform ) {

		if ( ! transform ) return map;
		const placed = map.clone();
		if ( transform.matrix ) {

			const [ a, b, c, d, e, f ] = transform.matrix;
			placed.matrixAutoUpdate = false;
			placed.matrix.set( a, b, c, d, e, f, 0, 0, 1 );
			return placed;

		}

		if ( transform.scale ) placed.repeat.set( transform.scale[ 0 ], transform.scale[ 1 ] );
		if ( transform.translation ) placed.offset.set( transform.translation[ 0 ], transform.translation[ 1 ] );
		if ( transform.rotation ) placed.rotation = transform.rotation * DEG;
		return placed;

	}

	/** RenderMan's PxrDisneyBsdf (Burley 2015), as pbrt-v3's Disney material reads the same parameters. */
	async disney( shader ) {

		const t = name => this.term( shader, name );
		const num = async ( name, fallback ) => {

			const term = await t( name );
			return typeof term?.value === 'number' ? term.value : fallback;

		};

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = { material: mat, perMesh: null, uvSet: 'st' };
		mat.color.setRGB( 0.2, 0.5, 0.8 );
		await this.applyColor( mat, 'color', await t( 'baseColor' ), surface, 'map' );
		mat.metalness = await num( 'metallic', 0 );
		mat.roughness = await num( 'roughness', 0.5 );
		mat.ior = await num( 'ior', 1.5 );

		const tint = surface.perMesh ? null : mat.color.clone();
		const hue = c => {

			const l = 0.3 * c.r + 0.6 * c.g + 0.1 * c.b;
			return l > 0 ? c.clone().multiplyScalar( 1 / l ) : new Color( 1, 1, 1 );

		};

		const specularTint = await num( 'specularTint', 0 );
		if ( specularTint > 0 && tint ) mat.specularColor.lerp( hue( tint ), specularTint );

		const sheen = await num( 'sheen', 0 );
		if ( sheen > 0 ) {

			const sheenTint = await num( 'sheenTint', 0.5 );
			mat.sheen = Math.min( 1, sheen );
			mat.sheenColor.set( 1, 1, 1 );
			if ( tint ) mat.sheenColor.lerp( hue( tint ), sheenTint );
			mat.sheenRoughness = 0.5;

		}

		// Burley's clear coat is a fixed-IOR GTR1 lobe at a quarter weight, its gloss blending α from 0.1 to 0.001.
		const clearcoat = await num( 'clearcoat', 0 );
		if ( clearcoat > 0 ) {

			mat.clearcoat = 0.25 * clearcoat;
			mat.clearcoatRoughness = Math.sqrt( 0.1 + ( 0.001 - 0.1 ) * await num( 'clearcoatGloss', 1 ) );

		}

		const specTrans = await num( 'specTrans', 0 );
		if ( specTrans > 0 ) {

			mat.transmission = specTrans;
			const transColor = ( await t( 'transColor' ) )?.value;
			const distance = await num( 'transDistance', 0 );
			if ( Array.isArray( transColor ) && distance > 0 ) {

				mat.attenuationColor.setRGB( transColor[ 0 ], transColor[ 1 ], transColor[ 2 ] );
				mat.attenuationDistance = distance;

			}

		}

		// A thin surface passes half its diffuse at diffTrans 1 (pbrt-v3 divides it by two).
		const thin = await num( 'isThin', 0 );
		const diffTrans = await num( 'diffTrans', 0 );
		if ( thin && diffTrans > 0 ) {

			mat.diffuseTransmission = Math.min( 1, diffTrans / 2 );
			mat.diffuseTransmissionColor = mat.color.clone();
			mat.userData.diffuseTransmissionFromBase = true;

		}

		const opacity = await num( 'opacity', 1 );
		if ( opacity < 1 ) {

			mat.opacity = opacity;
			mat.transparent = true;

		}

		await this.applyColor( mat, 'emissive', await t( 'emitColor' ), surface, 'emissiveMap' );
		return surface;

	}

	/** RenderMan's PxrSurface, its main lobes only: diffuse, primary specular, glass and diffuse transmission. */
	async pxrSurface( shader ) {

		const t = name => this.term( shader, name );
		const num = async ( name, fallback ) => {

			const term = await t( name );
			return typeof term?.value === 'number' ? term.value : fallback;

		};

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = { material: mat, perMesh: null, uvSet: 'st' };
		await this.applyColor( mat, 'color', await t( 'diffuseColor' ), surface, 'map' );
		mat.color.multiplyScalar( await num( 'diffuseGain', 1 ) );
		mat.roughness = await num( 'specularRoughness', 0.2 );
		mat.metalness = 0;

		const refraction = await num( 'refractionGain', 0 );
		if ( refraction > 0 ) {

			mat.transmission = Math.min( 1, refraction );
			mat.ior = await num( 'glassIor', 1.5 );
			mat.roughness = await num( 'glassRoughness', 0.1 );
			mat.color.setRGB( 1, 1, 1 );

		} else {

			const transmit = await num( 'diffuseTransmitGain', 0 );
			if ( transmit > 0 ) {

				const color = ( await t( 'diffuseTransmitColor' ) )?.value;
				mat.diffuseTransmission = Math.min( 1, transmit );
				mat.diffuseTransmissionColor = Array.isArray( color ) ? new Color().setRGB( color[ 0 ], color[ 1 ], color[ 2 ] ) : new Color( 1, 1, 1 );

			}

		}

		const presence = await num( 'presence', 1 );
		if ( presence < 1 ) {

			mat.opacity = presence;
			mat.transparent = true;

		}

		return surface;

	}

	async previewSurface( shader ) {

		const t = name => this.term( shader, name );
		const mat = new MeshPhysicalMaterial( { side: DoubleSide, roughness: 0.5, metalness: 0 } );
		const surface = { material: mat, perMesh: null, uvSet: 'st' };
		mat.color.setRGB( 0.18, 0.18, 0.18 );
		await this.applyColor( mat, 'color', await t( 'diffuseColor' ), surface, 'map' );
		await this.applyColor( mat, 'emissive', await t( 'emissiveColor' ), surface, 'emissiveMap' );
		if ( mat.emissiveMap || mat.emissive.r + mat.emissive.g + mat.emissive.b > 0 ) mat.emissiveIntensity = 1;
		await this.applyScalar( mat, 'roughness', await t( 'roughness' ), surface, 'roughnessMap', 'g' );
		await this.applyScalar( mat, 'clearcoat', await t( 'clearcoat' ), surface );
		await this.applyScalar( mat, 'clearcoatRoughness', await t( 'clearcoatRoughness' ), surface );
		await this.applyScalar( mat, 'ior', await t( 'ior' ), surface );

		if ( ( await t( 'useSpecularWorkflow' ) )?.value === 1 ) {

			mat.metalness = 0;
			const specular = ( await t( 'specularColor' ) )?.value;
			if ( Array.isArray( specular ) ) mat.specularColor.setRGB( specular[ 0 ], specular[ 1 ], specular[ 2 ] );

		} else {

			await this.applyScalar( mat, 'metalness', await t( 'metallic' ), surface, 'metalnessMap', 'b' );

		}

		const opacity = await t( 'opacity' );
		const threshold = ( await t( 'opacityThreshold' ) )?.value ?? 0;
		if ( typeof opacity?.value === 'number' && opacity.value < 1 ) {

			if ( threshold > 0 ) mat.alphaTest = threshold;
			else mat.transmission = 1 - opacity.value;

		} else if ( opacity?.texture ) {

			if ( opacity.texture.path === mat.map?.userData.usdPath && opacity.channel === 'a' ) {

				mat.transparent = true;
				if ( threshold > 0 ) mat.alphaTest = threshold;

			} else {

				this.warnOnce( 'opacitymap', 'USD opacity from a texture other than the colour map\'s alpha is not supported' );

			}

		}

		const normal = await t( 'normal' );
		if ( normal?.texture ) {

			const map = await this.image( normal.texture, false );
			if ( map ) {

				mat.normalMap = map;
				surface.uvSet = normal.texture.uvSet;

			}

		}

		return surface;

	}

	// ── MaterialX ────────────────────────────────────────────────
	// UsdShade networks of ND_* nodes (MaterialX 1.38/1.39 in USD). A node becomes what an input can hold: a constant,
	// a texture with the placement and gain the engine carries, or a UV set and its placement. What the engine cannot
	// carry (a blend of a texture with a colour, a hue shift of one, procedural patterns) keeps its main texture or
	// falls back to the default, and says so once.

	async mtlxOutput( prim, id, name, hops ) {

		const node = mtlxNode( id );
		const input = n => this.term( prim, n, hops + 1 );
		const value = async ( n, fallback ) => {

			const v = ( await input( n ) )?.value;
			return v === undefined ? fallback : v;

		};

		switch ( node ) {

			case 'image':
			case 'tiledimage':
				return this.mtlxImage( prim, id, node, hops );
			case 'texcoord':
				if ( ( await value( 'index', 0 ) ) > 0 ) this.warnOnce( 'mtlx:texcoord', 'MaterialX texture coordinates past the first set are read as the first' );
				return { uv: { set: 'st', m: UV_IDENTITY } };
			case 'geompropvalue': {

				const prop = await value( 'geomprop', null );
				return prop ? ( /vector2/.test( id ) ? { uv: { set: prop, m: UV_IDENTITY } } : { primvar: prop } ) : input( 'default' );

			}

			case 'constant':
				return input( 'value' );
			case 'dot':
				return input( 'in' );
			case 'convert':
				return this.mtlxConvert( await input( 'in' ), id );
			case 'extract':
				return this.mtlxChannel( await input( 'in' ), await value( 'index', 0 ) );
			case 'separate2':
			case 'separate3':
			case 'separate4':
				return this.mtlxChannel( await input( 'in' ), { outx: 0, outy: 1, outz: 2, outw: 3, outr: 0, outg: 1, outb: 2, outa: 3 }[ name ] ?? 0 );
			case 'combine2':
			case 'combine3':
			case 'combine4': {

				const parts = await Promise.all( [ 'in1', 'in2', 'in3', 'in4' ].slice( 0, Number( node.slice( - 1 ) ) ).map( input ) );
				return parts.every( p => isNum( p?.value ) ) ? { value: parts.map( p => p.value ) } : parts.find( p => p?.texture ) ?? null;

			}

			case 'mix': {

				const [ fg, bg, mix ] = await Promise.all( [ input( 'fg' ), input( 'bg' ), input( 'mix' ) ] );
				if ( isValue( fg?.value ) && isValue( bg?.value ) && isNum( mix?.value ) ) return { value: zip( bg.value, fg.value, ( b, f ) => b + ( f - b ) * mix.value ) };
				this.warnOnce( 'mtlx:mix', 'MaterialX mixes of a texture are read as their larger part' );
				const front = ! isNum( mix?.value ) || mix.value >= 0.5;
				return ( front ? fg : bg ) ?? ( front ? bg : fg );

			}

			case 'multiply':
			case 'divide':
			case 'add':
			case 'subtract':
			case 'min':
			case 'max':
			case 'power':
			case 'modulo':
				return this.mtlxArithmetic( node, await input( 'in1' ), await input( 'in2' ) );
			case 'invert': {

				const t = await input( 'in' );
				const amount = await value( 'amount', 1 );
				return isValue( t?.value ) ? { value: zip( amount, t.value, ( a, v ) => a - v ) } : t;

			}

			case 'clamp': {

				const t = await input( 'in' );
				if ( ! isValue( t?.value ) ) return t;
				const [ low, high ] = [ await value( 'low', 0 ), await value( 'high', 1 ) ];
				return { value: zip( zip( t.value, low, Math.max ), high, Math.min ) };

			}

			case 'hsvadjust':
				return this.mtlxHsv( await input( 'in' ), await value( 'amount', [ 0, 1, 1 ] ) );
			case 'rotate2d':
			case 'rotate3d': {

				const t = await input( 'in' );
				const amount = await value( 'amount', 0 );
				const axis = node === 'rotate3d' ? await value( 'axis', [ 0, 1, 0 ] ) : [ 0, 0, 1 ];
				if ( ! t?.uv || ! amount ) return t;
				if ( Math.abs( axis[ 0 ] ) > 1e-6 || Math.abs( axis[ 1 ] ) > 1e-6 ) {

					this.warnOnce( 'mtlx:rotate', 'MaterialX texture coordinates turned about an axis other than z are left unturned' );
					return t;

				}

				return { uv: { ...t.uv, m: uvRotate( t.uv.m, Math.sign( axis[ 2 ] ) * amount ) } };

			}

			case 'place2d': {

				const t = await input( 'texcoord' );
				if ( ! t?.uv ) return t;
				const [ pivot, scale, rotate, offset ] = [ await value( 'pivot', [ 0, 0 ] ), await value( 'scale', [ 1, 1 ] ), await value( 'rotate', 0 ), await value( 'offset', [ 0, 0 ] ) ];
				const trs = ( await value( 'operationorder', 0 ) ) !== 0;
				let m = uvTranslate( t.uv.m, [ - pivot[ 0 ], - pivot[ 1 ] ] );
				const inverse = scale.map( s => ( s ? 1 / s : 1 ) );
				if ( trs ) m = uvScale( uvRotate( uvTranslate( m, [ - offset[ 0 ], - offset[ 1 ] ] ), rotate ), inverse );
				else m = uvTranslate( uvRotate( uvScale( m, inverse ), rotate ), [ - offset[ 0 ], - offset[ 1 ] ] );
				return { uv: { ...t.uv, m: uvTranslate( m, pivot ) } };

			}

			case 'normalmap': {

				const t = await input( 'in' );
				return t?.texture ? { ...t, normalScale: await value( 'scale', 1 ) } : null;

			}

			case 'heighttonormal': {

				const t = await input( 'in' );
				return t?.texture ? { ...t, bump: await value( 'scale', 1 ) } : null;

			}

			case 'artistic_ior':
				// Gulbrandsen's reflectivity is the conductor's colour at normal incidence.
				return { artistic: { reflectivity: await input( 'reflectivity' ), edge: await input( 'edge_color' ) } };
			case 'normal':
			case 'tangent':
			case 'bitangent':
			case 'position':
			case 'viewdirection':
				return null;

		}

		this.warnOnce( `mtlx:${node}`, `MaterialX node "${node}" is not read — its input left at its default` );
		return null;

	}

	async mtlxImage( prim, id, node, hops ) {

		const file = prim.assetPath( 'inputs:file' );
		if ( ! file?.path ) {

			if ( file?.asset ) this.warnOnce( `tex:${file.asset}`, `USD texture "${file.asset}" not found` );
			return this.term( prim, 'default', hops + 1 );

		}

		if ( /<udim>/i.test( file.asset ) ) {

			this.warnOnce( 'udim', 'USD UDIM textures are not supported — skipped' );
			return null;

		}

		const st = await this.term( prim, 'texcoord', hops + 1 );
		let m = st?.uv?.m ?? UV_IDENTITY;
		if ( node === 'tiledimage' ) {

			const tiling = prim.value( 'inputs:uvtiling' ) ?? [ 1, 1 ];
			const offset = prim.value( 'inputs:uvoffset' ) ?? [ 0, 0 ];
			m = uvTranslate( uvScale( m, tiling ), [ - offset[ 0 ], - offset[ 1 ] ] );

		}

		const space = prim.propertyMeta( 'inputs:file', 'colorSpace' ) ?? prim.value( 'inputs:file:colorSpace' );
		const mono = /_float$/.test( id );
		return {
			texture: {
				path: file.path,
				uvSet: st?.uv?.set ?? st?.primvar ?? 'st',
				wrapS: MTLX_ADDRESS[ prim.value( 'inputs:uaddressmode' ) ] ?? 'repeat',
				wrapT: MTLX_ADDRESS[ prim.value( 'inputs:vaddressmode' ) ] ?? 'repeat',
				colorSpace: ! space ? 'auto' : /srgb/i.test( space ) ? 'sRGB' : 'raw',
				scale: null,
			},
			channel: mono ? 'r' : 'rgb',
			mono,
			transform: m.every( ( v, i ) => Math.abs( v - UV_IDENTITY[ i ] ) < 1e-9 ) ? null : { matrix: m },
		};

	}

	mtlxConvert( term, id ) {

		if ( ! isValue( term?.value ) ) return term;
		const to = id.slice( id.lastIndexOf( '_' ) + 1 );
		const size = { float: 1, color3: 3, vector3: 3, color4: 4, vector4: 4, vector2: 2 }[ to ] ?? 3;
		const v = term.value;
		if ( size === 1 ) return { value: isNum( v ) ? v : v[ 0 ] };
		if ( isNum( v ) ) return { value: Array( size ).fill( v ) };
		return { value: Array.from( { length: size }, ( _, i ) => v[ i ] ?? ( i === 3 ? 1 : 0 ) ) };

	}

	mtlxChannel( term, index ) {

		if ( isValue( term?.value ) ) return { value: isNum( term.value ) ? term.value : term.value[ index ] ?? 0 };
		if ( term?.texture ) return { ...term, channel: 'rgba'[ index ] ?? 'r', mono: false };
		return term;

	}

	mtlxArithmetic( node, a, b ) {

		const ops = {
			multiply: ( x, y ) => x * y, divide: ( x, y ) => ( y ? x / y : 0 ), add: ( x, y ) => x + y, subtract: ( x, y ) => x - y,
			min: Math.min, max: Math.max, power: ( x, y ) => Math.max( x, 0 ) ** y, modulo: ( x, y ) => ( y ? x - y * Math.floor( x / y ) : 0 ),
		};

		if ( isValue( a?.value ) && isValue( b?.value ) ) return { value: zip( a.value, b.value, ops[ node ] ) };

		// A UV set scaled or moved by constants: Blender's Mapping node is a chain of these.
		const uv = a?.uv ?? b?.uv;
		const other = a?.uv ? b?.value : a?.value;
		if ( uv && isValue( other ) && ( node === 'multiply' || node === 'add' || ( a?.uv && ( node === 'divide' || node === 'subtract' ) ) ) ) {

			const v = isNum( other ) ? [ other, other ] : other;
			if ( node === 'multiply' ) return { uv: { ...uv, m: uvScale( uv.m, v ) } };
			if ( node === 'divide' ) return { uv: { ...uv, m: uvScale( uv.m, v.map( x => ( x ? 1 / x : 1 ) ) ) } };
			return { uv: { ...uv, m: uvTranslate( uv.m, node === 'add' ? v : v.map( x => - x ) ) } };

		}

		// A texture times a constant is a texture with a gain, which the engine carries.
		const texture = a?.texture ? a : b?.texture ? b : null;
		const gain = a?.texture ? b?.value : a?.value;
		if ( texture && isValue( gain ) && ( node === 'multiply' || ( a?.texture && node === 'divide' ) ) ) {

			const by = node === 'divide' ? each( gain, x => ( x ? 1 / x : 1 ) ) : gain;
			const scale = zip( texture.texture.scale ?? [ 1, 1, 1 ], by, ( s, x ) => s * x );
			return { ...texture, texture: { ...texture.texture, scale: isNum( scale ) ? [ scale, scale, scale ] : scale } };

		}

		if ( texture ) this.warnOnce( `mtlx:${node}`, `MaterialX ${node} of a texture is read as the texture alone` );
		return texture ?? a ?? b;

	}

	mtlxHsv( term, amount ) {

		if ( ! Array.isArray( term?.value ) ) {

			if ( term?.texture && ( amount[ 0 ] || amount[ 1 ] !== 1 || amount[ 2 ] !== 1 ) ) this.warnOnce( 'mtlx:hsv', 'MaterialX hue, saturation and value changes to a texture are not applied' );
			return term;

		}

		const c = new Color().setRGB( term.value[ 0 ], term.value[ 1 ], term.value[ 2 ] );
		const hsl = c.getHSL( {} );
		// three's HSL stands in for HSV: a hue turn is exact, saturation and value scale about it.
		c.setHSL( ( hsl.h + amount[ 0 ] + 1 ) % 1, Math.min( 1, hsl.s * amount[ 1 ] ), hsl.l );
		return { value: [ c.r * amount[ 2 ], c.g * amount[ 2 ], c.b * amount[ 2 ] ] };

	}

	/** A normal or height map from a MaterialX normal input. */
	async mtlxNormal( mat, term, surface ) {

		if ( ! term?.texture ) return;
		const map = this.transformTexture( await this.image( term.texture, false ), term.transform );
		if ( ! map ) return;
		if ( term.bump !== undefined ) {

			mat.bumpMap = map;
			mat.bumpScale = term.bump;

		} else {

			mat.normalMap = map;
			mat.normalScale.set( term.normalScale ?? 1, term.normalScale ?? 1 );

		}

		surface.uvSet = term.texture.uvSet;

	}

	/** Coverage: a constant below 1, or the colour map's own alpha. */
	mtlxOpacity( mat, term ) {

		if ( isValue( term?.value ) && mean( term.value ) < 1 ) {

			mat.opacity = mean( term.value );
			mat.transparent = true;

		} else if ( term?.texture ) {

			if ( term.texture.path === mat.map?.userData.usdPath && term.channel === 'a' ) mat.transparent = true;
			else this.warnOnce( 'opacitymap', 'USD opacity from a texture other than the colour map\'s alpha is not supported' );

		}

	}

	/** A weight × colour pair onto a colour slot: the weight scales the colour, or the texture's gain. */
	async mtlxWeighted( mat, slot, colorTerm, weight, surface, mapSlot ) {

		await this.applyColor( mat, slot, colorTerm, surface, mapSlot );
		if ( isNum( weight ) ) mat[ slot ].multiplyScalar( weight );

	}

	mtlxSurfaceOf( mat ) {

		return { material: mat, perMesh: null, uvSet: 'st' };

	}

	/** A diffuse roughness input as a constant; one a texture drives is not read. */
	mtlxDiffuseRoughness( term ) {

		if ( term?.texture ) this.warnOnce( 'mtlx:diffuseroughness', 'MaterialX diffuse roughness from a texture is not read' );
		return isNum( term?.value ) ? term.value : 0;

	}

	/** OpenPBR Surface 1.1, which Blender writes for its Principled BSDF. */
	async openPbrSurface( shader ) {

		const t = name => this.term( shader, name );
		const num = async ( name, fallback ) => {

			const v = ( await t( name ) )?.value;
			return isNum( v ) ? v : fallback;

		};

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = this.mtlxSurfaceOf( mat );
		mat.color.setRGB( 0.8, 0.8, 0.8 );
		await this.mtlxWeighted( mat, 'color', await t( 'base_color' ), await num( 'base_weight', 1 ), surface, 'map' );
		mat.metalness = 0;
		await this.applyScalar( mat, 'metalness', await t( 'base_metalness' ), surface, 'metalnessMap', 'b' );
		mat.roughness = 0.3;
		await this.applyScalar( mat, 'roughness', await t( 'specular_roughness' ), surface, 'roughnessMap', 'g' );
		mat.specularIntensity = Math.min( 1, await num( 'specular_weight', 1 ) );
		const specularColor = ( await t( 'specular_color' ) )?.value;
		if ( Array.isArray( specularColor ) ) mat.specularColor.setRGB( specularColor[ 0 ], specularColor[ 1 ], specularColor[ 2 ] );
		mat.ior = await num( 'specular_ior', 1.5 );
		mat.anisotropy = await num( 'specular_roughness_anisotropy', 0 );
		mat.diffuseRoughness = this.mtlxDiffuseRoughness( await t( 'base_diffuse_roughness' ) );

		const transmission = await num( 'transmission_weight', 0 );
		if ( transmission > 0 ) {

			mat.transmission = transmission;
			const color = ( await t( 'transmission_color' ) )?.value;
			const depth = await num( 'transmission_depth', 0 );
			if ( Array.isArray( color ) && depth > 0 ) {

				mat.attenuationColor.setRGB( color[ 0 ], color[ 1 ], color[ 2 ] );
				mat.attenuationDistance = depth;

			} else if ( Array.isArray( color ) ) {

				// Without a depth the colour tints at the surface, which the engine takes from the base colour.
				mat.color.lerp( new Color().setRGB( color[ 0 ], color[ 1 ], color[ 2 ] ), transmission );

			}

			const abbe = await num( 'transmission_dispersion_abbe_number', 20 );
			const scale = await num( 'transmission_dispersion_scale', 0 );
			if ( scale > 0 && abbe > 0 ) mat.dispersion = scale * 20 / abbe;

		}

		const subsurface = await num( 'subsurface_weight', 0 );
		if ( subsurface > 0 ) {

			const color = ( await t( 'subsurface_color' ) )?.value;
			const radius = await num( 'subsurface_radius', 1 );
			const scale = ( await t( 'subsurface_radius_scale' ) )?.value;
			mat.subsurface = subsurface;
			mat.subsurfaceColor = Array.isArray( color ) ? new Color().setRGB( color[ 0 ], color[ 1 ], color[ 2 ] ) : mat.color.clone();
			mat.subsurfaceRadius = Array.isArray( scale ) ? [ ...scale ] : [ 1, 1, 1 ];
			mat.subsurfaceRadiusScale = radius;
			mat.subsurfaceAnisotropy = await num( 'subsurface_scatter_anisotropy', 0 );

		}

		mat.clearcoat = await num( 'coat_weight', 0 );
		mat.clearcoatRoughness = await num( 'coat_roughness', 0 );

		const fuzz = await num( 'fuzz_weight', 0 );
		if ( fuzz > 0 ) {

			const color = ( await t( 'fuzz_color' ) )?.value ?? [ 1, 1, 1 ];
			mat.sheen = Math.min( 1, fuzz );
			mat.sheenColor.setRGB( color[ 0 ], color[ 1 ], color[ 2 ] );
			mat.sheenRoughness = await num( 'fuzz_roughness', 0.5 );

		}

		const film = await num( 'thin_film_weight', 0 );
		if ( film > 0 ) {

			// OpenPBR states the film in micrometres, the engine in nanometres.
			const thickness = await num( 'thin_film_thickness', 0.5 ) * 1000;
			mat.iridescence = Math.min( 1, film );
			mat.iridescenceIOR = await num( 'thin_film_ior', 1.4 );
			mat.iridescenceThicknessRange = [ thickness, thickness ];

		}

		const luminance = await num( 'emission_luminance', 0 );
		if ( luminance > 0 ) {

			mat.emissive.setRGB( 1, 1, 1 );
			await this.applyColor( mat, 'emissive', await t( 'emission_color' ), surface, 'emissiveMap' );
			mat.emissiveIntensity = luminance;

		}

		this.mtlxOpacity( mat, await t( 'geometry_opacity' ) );
		await this.mtlxNormal( mat, await t( 'geometry_normal' ), surface );
		return surface;

	}

	/** Autodesk Standard Surface, which Maya, Houdini and Omniverse write. */
	async standardSurface( shader ) {

		const t = name => this.term( shader, name );
		const num = async ( name, fallback ) => {

			const v = ( await t( name ) )?.value;
			return isNum( v ) ? v : fallback;

		};

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = this.mtlxSurfaceOf( mat );
		mat.color.setRGB( 0.8, 0.8, 0.8 );
		await this.mtlxWeighted( mat, 'color', await t( 'base_color' ), await num( 'base', 1 ), surface, 'map' );
		mat.metalness = 0;
		await this.applyScalar( mat, 'metalness', await t( 'metalness' ), surface, 'metalnessMap', 'b' );
		mat.roughness = 0.2;
		await this.applyScalar( mat, 'roughness', await t( 'specular_roughness' ), surface, 'roughnessMap', 'g' );
		mat.specularIntensity = Math.min( 1, await num( 'specular', 1 ) );
		const specularColor = ( await t( 'specular_color' ) )?.value;
		if ( Array.isArray( specularColor ) ) mat.specularColor.setRGB( specularColor[ 0 ], specularColor[ 1 ], specularColor[ 2 ] );
		mat.ior = await num( 'specular_IOR', 1.5 );
		mat.anisotropy = await num( 'specular_anisotropy', 0 );
		mat.anisotropyRotation = await num( 'specular_rotation', 0 ) * Math.PI * 2;
		// MaterialX renders this one without energy compensation; EON returns what that loses.
		mat.diffuseRoughness = this.mtlxDiffuseRoughness( await t( 'diffuse_roughness' ) );

		const transmission = await num( 'transmission', 0 );
		if ( transmission > 0 ) {

			mat.transmission = transmission;
			const color = ( await t( 'transmission_color' ) )?.value;
			const depth = await num( 'transmission_depth', 0 );
			if ( Array.isArray( color ) && depth > 0 ) {

				mat.attenuationColor.setRGB( color[ 0 ], color[ 1 ], color[ 2 ] );
				mat.attenuationDistance = depth;

			} else if ( Array.isArray( color ) ) {

				mat.color.lerp( new Color().setRGB( color[ 0 ], color[ 1 ], color[ 2 ] ), transmission );

			}

			const abbe = await num( 'transmission_dispersion', 0 );
			if ( abbe > 0 ) mat.dispersion = 20 / abbe;

		}

		const subsurface = await num( 'subsurface', 0 );
		if ( subsurface > 0 ) {

			const color = ( await t( 'subsurface_color' ) )?.value;
			const radius = ( await t( 'subsurface_radius' ) )?.value;
			mat.subsurface = subsurface;
			mat.subsurfaceColor = Array.isArray( color ) ? new Color().setRGB( color[ 0 ], color[ 1 ], color[ 2 ] ) : mat.color.clone();
			mat.subsurfaceRadius = Array.isArray( radius ) ? [ ...radius ] : [ 1, 1, 1 ];
			mat.subsurfaceRadiusScale = await num( 'subsurface_scale', 1 );
			mat.subsurfaceAnisotropy = await num( 'subsurface_anisotropy', 0 );

		}

		const sheen = await num( 'sheen', 0 );
		if ( sheen > 0 ) {

			const color = ( await t( 'sheen_color' ) )?.value ?? [ 1, 1, 1 ];
			mat.sheen = Math.min( 1, sheen );
			mat.sheenColor.setRGB( color[ 0 ], color[ 1 ], color[ 2 ] );
			mat.sheenRoughness = await num( 'sheen_roughness', 0.3 );

		}

		mat.clearcoat = await num( 'coat', 0 );
		mat.clearcoatRoughness = await num( 'coat_roughness', 0.1 );

		const film = await num( 'thin_film_thickness', 0 );
		if ( film > 0 ) {

			mat.iridescence = 1;
			mat.iridescenceIOR = await num( 'thin_film_IOR', 1.5 );
			mat.iridescenceThicknessRange = [ film, film ];

		}

		const emission = await num( 'emission', 0 );
		if ( emission > 0 ) {

			mat.emissive.setRGB( 1, 1, 1 );
			await this.applyColor( mat, 'emissive', await t( 'emission_color' ), surface, 'emissiveMap' );
			mat.emissiveIntensity = emission;

		}

		this.mtlxOpacity( mat, await t( 'opacity' ) );
		await this.mtlxNormal( mat, await t( 'normal' ), surface );
		return surface;

	}

	/** MaterialX's glTF PBR surface: glTF's own parameters, one to one. */
	async gltfPbrSurface( shader ) {

		const t = name => this.term( shader, name );
		const num = async ( name, fallback ) => {

			const v = ( await t( name ) )?.value;
			return isNum( v ) ? v : fallback;

		};

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = this.mtlxSurfaceOf( mat );
		await this.applyColor( mat, 'color', await t( 'base_color' ), surface, 'map' );
		mat.metalness = 1;
		await this.applyScalar( mat, 'metalness', await t( 'metallic' ), surface, 'metalnessMap', 'b' );
		mat.roughness = 1;
		await this.applyScalar( mat, 'roughness', await t( 'roughness' ), surface, 'roughnessMap', 'g' );
		mat.ior = await num( 'ior', 1.5 );
		mat.specularIntensity = await num( 'specular', 1 );
		const specularColor = ( await t( 'specular_color' ) )?.value;
		if ( Array.isArray( specularColor ) ) mat.specularColor.setRGB( specularColor[ 0 ], specularColor[ 1 ], specularColor[ 2 ] );
		mat.transmission = await num( 'transmission', 0 );
		mat.thickness = await num( 'thickness', 0 );
		const attenuation = ( await t( 'attenuation_color' ) )?.value;
		if ( Array.isArray( attenuation ) ) mat.attenuationColor.setRGB( attenuation[ 0 ], attenuation[ 1 ], attenuation[ 2 ] );
		const distance = await num( 'attenuation_distance', 0 );
		if ( distance > 0 ) mat.attenuationDistance = distance;
		mat.dispersion = await num( 'dispersion', 0 );
		mat.clearcoat = await num( 'clearcoat', 0 );
		mat.clearcoatRoughness = await num( 'clearcoat_roughness', 0 );
		const sheen = ( await t( 'sheen_color' ) )?.value;
		if ( Array.isArray( sheen ) && mean( sheen ) > 0 ) {

			mat.sheen = 1;
			mat.sheenColor.setRGB( sheen[ 0 ], sheen[ 1 ], sheen[ 2 ] );
			mat.sheenRoughness = await num( 'sheen_roughness', 0 );

		}

		const iridescence = await num( 'iridescence', 0 );
		if ( iridescence > 0 ) {

			const thickness = await num( 'iridescence_thickness', 100 );
			mat.iridescence = iridescence;
			mat.iridescenceIOR = await num( 'iridescence_ior', 1.3 );
			mat.iridescenceThicknessRange = [ thickness, thickness ];

		}

		await this.applyColor( mat, 'emissive', await t( 'emissive' ), surface, 'emissiveMap' );
		mat.emissiveIntensity = await num( 'emissive_strength', 1 );

		// alpha_mode: 0 opaque, 1 mask, 2 blend.
		const mode = await num( 'alpha_mode', 0 );
		if ( mode > 0 ) {

			this.mtlxOpacity( mat, await t( 'alpha' ) );
			if ( mode === 1 ) mat.alphaTest = await num( 'alpha_cutoff', 0.5 );

		}

		await this.mtlxNormal( mat, await t( 'normal' ), surface );
		return surface;

	}

	/**
	 * MaterialX's `surface` over a BSDF graph (pbrlib), as Blender writes its node shaders: the graph's lobes with their
	 * weights, made into the engine's one material. Read as the graph says; where the weights cannot be met (a lobe mix
	 * driven by a texture), the even split stands in.
	 */
	async bsdfSurface( shader ) {

		const lobes = [];
		const emission = [];
		await this.mtlxLobes( shader, 'inputs:bsdf', 1, lobes, 0 );
		await this.mtlxEmission( shader, 'inputs:edf', 1, emission, 0 );

		const mat = new MeshPhysicalMaterial( { side: DoubleSide } );
		const surface = this.mtlxSurfaceOf( mat );
		const sum = kinds => lobes.filter( l => kinds.includes( l.kind ) ).reduce( ( s, l ) => s + l.w, 0 );
		const base = sum( [ 'diffuse', 'conductor', 'transmission' ] );

		// The base colour: each base lobe's colour by its share; one texture, the largest share's, is kept.
		if ( base > 0 ) {

			const shares = lobes.filter( l => [ 'diffuse', 'conductor', 'transmission' ].includes( l.kind ) && l.w > 0 );
			const textured = shares.filter( l => l.color?.texture ).sort( ( a, b ) => b.w - a.w )[ 0 ];
			const rgb = [ 0, 0, 0 ];
			for ( const l of shares ) {

				const c = isValue( l.color?.value ) ? l.color.value : l.color?.texture ? ( l.color.texture.scale ?? [ 1, 1, 1 ] ) : [ 0.8, 0.8, 0.8 ];
				for ( let i = 0; i < 3; i ++ ) rgb[ i ] += ( isNum( c ) ? c : c[ i ] ) * l.w / base;

			}

			if ( textured && textured.w / base >= 0.5 ) {

				await this.applyColor( mat, 'color', textured.color, surface, 'map' );
				if ( shares.some( l => l !== textured && l.w > 0 ) ) this.warnOnce( 'mtlx:lobecolor', 'MaterialX lobes of different colours over a texture are read as the texture' );

			} else {

				mat.color.setRGB( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );

			}

			mat.metalness = sum( [ 'conductor' ] ) / base;
			mat.transmission = sum( [ 'transmission' ] ) / base;
			const diffuse = lobes.filter( l => l.kind === 'diffuse' && l.w > 0 );
			const diffuseWeight = sum( [ 'diffuse' ] );
			if ( diffuseWeight > 0 ) mat.diffuseRoughness = diffuse.reduce( ( s, l ) => s + l.roughness * l.w, 0 ) / diffuseWeight;

		} else {

			mat.color.setRGB( 0, 0, 0 );

		}

		// Roughness from the specular lobes by weight; a surface with no specular lobe reflects nothing specular.
		const specular = lobes.filter( l => [ 'conductor', 'transmission', 'reflection' ].includes( l.kind ) && l.w > 0 );
		const specularWeight = specular.reduce( ( s, l ) => s + l.w, 0 );
		mat.roughness = specularWeight > 0 ? specular.reduce( ( s, l ) => s + l.roughness * l.w, 0 ) / specularWeight : 1;
		const glossy = lobes.filter( l => [ 'transmission', 'reflection' ].includes( l.kind ) && l.w > 0 );
		mat.ior = glossy.length ? glossy.reduce( ( s, l ) => s + l.ior * l.w, 0 ) / glossy.reduce( ( s, l ) => s + l.w, 0 ) : 1.5;
		const reflection = lobes.filter( l => l.kind === 'reflection' && l.w > 0 );
		if ( reflection.length ) {

			const tint = reflection.find( l => isValue( l.tint ) )?.tint;
			if ( Array.isArray( tint ) ) mat.specularColor.setRGB( tint[ 0 ], tint[ 1 ], tint[ 2 ] );
			mat.specularIntensity = Math.min( 1, sum( [ 'reflection' ] ) );

		} else if ( mat.transmission === 0 ) {

			mat.specularIntensity = 0;

		}

		const sheen = lobes.find( l => l.kind === 'sheen' );
		if ( sheen ) {

			mat.sheen = Math.min( 1, sum( [ 'sheen' ] ) );
			if ( Array.isArray( sheen.color ) ) mat.sheenColor.setRGB( sheen.color[ 0 ], sheen.color[ 1 ], sheen.color[ 2 ] );
			mat.sheenRoughness = sheen.roughness;

		}

		const subsurface = lobes.find( l => l.kind === 'subsurface' );
		if ( subsurface && base + subsurface.w > 0 ) {

			mat.subsurface = Math.min( 1, sum( [ 'subsurface' ] ) / ( base + sum( [ 'subsurface' ] ) ) );
			mat.subsurfaceColor = Array.isArray( subsurface.color ) ? new Color().setRGB( subsurface.color[ 0 ], subsurface.color[ 1 ], subsurface.color[ 2 ] ) : mat.color.clone();
			mat.subsurfaceRadius = Array.isArray( subsurface.radius ) ? [ ...subsurface.radius ] : [ 1, 1, 1 ];
			mat.subsurfaceAnisotropy = subsurface.anisotropy;

		}

		const translucent = lobes.find( l => l.kind === 'translucent' );
		if ( translucent ) {

			const share = sum( [ 'translucent' ] ) / ( sum( [ 'diffuse' ] ) + sum( [ 'translucent' ] ) );
			mat.diffuseTransmission = Math.min( 1, share );
			mat.diffuseTransmissionColor = Array.isArray( translucent.color ) ? new Color().setRGB( translucent.color[ 0 ], translucent.color[ 1 ], translucent.color[ 2 ] ) : new Color( 1, 1, 1 );

		}

		if ( emission.length ) {

			const textured = emission.find( e => e.color?.texture );
			if ( textured ) {

				mat.emissive.setRGB( 1, 1, 1 );
				await this.applyColor( mat, 'emissive', textured.color, surface, 'emissiveMap' );
				mat.emissiveIntensity = textured.w;

			} else {

				const rgb = [ 0, 0, 0 ];
				for ( const e of emission ) {

					const c = isValue( e.color?.value ) ? e.color.value : [ 1, 1, 1 ];
					for ( let i = 0; i < 3; i ++ ) rgb[ i ] += ( isNum( c ) ? c : c[ i ] ) * e.w;

				}

				const peak = Math.max( ...rgb );
				if ( peak > 0 ) {

					mat.emissive.setRGB( rgb[ 0 ] / peak, rgb[ 1 ] / peak, rgb[ 2 ] / peak );
					mat.emissiveIntensity = peak;

				}

			}

		}

		await this.mtlxNormal( mat, lobes.find( l => l.normal?.texture )?.normal, surface );
		this.mtlxOpacity( mat, await this.term( shader, 'opacity' ) );
		return surface;

	}

	/** The BSDF lobes below `attribute`, each with its weight in the whole. */
	async mtlxLobes( prim, attribute, w, lobes, hops ) {

		const source = hops < 32 ? await this.stage.connectionSource( prim, attribute ) : null;
		const id = source?.prim.value( 'info:id' );
		if ( ! id || w <= 0 ) return;
		const node = source.prim;
		const t = name => this.term( node, name, hops + 1 );
		const num = async ( name, fallback ) => {

			const v = ( await t( name ) )?.value;
			return isNum( v ) ? v : Array.isArray( v ) ? mean( v ) : fallback;

		};

		const weight = w * await num( 'weight', 1 );
		switch ( mtlxNode( id ) ) {

			case 'oren_nayar_diffuse_bsdf':
				lobes.push( { kind: 'diffuse', w: weight, color: await t( 'color' ), normal: await t( 'normal' ), roughness: this.mtlxDiffuseRoughness( await t( 'roughness' ) ) } );
				return;
			case 'burley_diffuse_bsdf':
				lobes.push( { kind: 'diffuse', w: weight, color: await t( 'color' ), normal: await t( 'normal' ), roughness: 0 } );
				return;
			case 'conductor_bsdf': {

				const ior = await t( 'ior' );
				let color = ior?.artistic?.reflectivity ?? null;
				if ( ! color ) {

					// F0 from a complex index: ((n − 1)² + k²) / ((n + 1)² + k²) per channel.
					const n = isValue( ior?.value ) ? ior.value : [ 0.18, 0.42, 1.37 ];
					const k = ( await t( 'extinction' ) )?.value ?? [ 3.42, 2.35, 1.77 ];
					color = { value: zip( n, k, ( a, b ) => ( ( a - 1 ) ** 2 + b * b ) / ( ( a + 1 ) ** 2 + b * b ) ) };

				}

				lobes.push( { kind: 'conductor', w: weight, color, roughness: await num( 'roughness', 0.2 ), normal: await t( 'normal' ) } );
				return;

			}

			case 'dielectric_bsdf':
			case 'generalized_schlick_bsdf': {

				const mode = ( await t( 'scatter_mode' ) )?.value ?? 'R';
				const roughness = await num( 'roughness', 0.05 );
				const normal = await t( 'normal' );
				if ( mtlxNode( id ) === 'generalized_schlick_bsdf' ) {

					// A Schlick lobe as bright as a metal's is one; a dim one is a dielectric's specular.
					const color0 = ( await t( 'color0' ) )?.value ?? [ 1, 1, 1 ];
					if ( mean( color0 ) > 0.2 && mode === 'R' ) lobes.push( { kind: 'conductor', w: weight, color: { value: color0 }, roughness, normal } );
					else lobes.push( { kind: mode === 'R' ? 'reflection' : 'transmission', w: weight, tint: [ 1, 1, 1 ], color: { value: [ 1, 1, 1 ] }, ior: 1.5, roughness, normal } );
					return;

				}

				const tint = ( await t( 'tint' ) )?.value ?? [ 1, 1, 1 ];
				const ior = await num( 'ior', 1.5 );
				lobes.push( { kind: mode === 'R' ? 'reflection' : 'transmission', w: weight, tint, color: { value: tint }, ior, roughness, normal } );
				return;

			}

			case 'sheen_bsdf':
				lobes.push( { kind: 'sheen', w: weight, color: ( await t( 'color' ) )?.value ?? [ 1, 1, 1 ], roughness: await num( 'roughness', 0.3 ) } );
				return;
			case 'subsurface_bsdf':
				lobes.push( { kind: 'subsurface', w: weight, color: ( await t( 'color' ) )?.value, radius: ( await t( 'radius' ) )?.value, anisotropy: await num( 'anisotropy', 0 ) } );
				return;
			case 'translucent_bsdf':
				lobes.push( { kind: 'translucent', w: weight, color: ( await t( 'color' ) )?.value } );
				return;
			case 'mix_bsdf': {

				const mix = ( await t( 'mix' ) )?.value;
				if ( ! isNum( mix ) ) this.warnOnce( 'mtlx:mixbsdf', 'MaterialX BSDF mixes driven by a texture are read as an even split' );
				const m = isNum( mix ) ? Math.min( 1, Math.max( 0, mix ) ) : 0.5;
				await this.mtlxLobes( node, 'inputs:fg', w * m, lobes, hops + 1 );
				await this.mtlxLobes( node, 'inputs:bg', w * ( 1 - m ), lobes, hops + 1 );
				return;

			}

			case 'add_bsdf':
				await this.mtlxLobes( node, 'inputs:in1', w, lobes, hops + 1 );
				await this.mtlxLobes( node, 'inputs:in2', w, lobes, hops + 1 );
				return;
			case 'layer':
			case 'layer_bsdf':
				await this.mtlxLobes( node, 'inputs:top', w, lobes, hops + 1 );
				await this.mtlxLobes( node, 'inputs:base', w, lobes, hops + 1 );
				return;
			case 'multiply_bsdfC':
			case 'multiply_bsdfF': {

				const by = ( await t( 'in2' ) )?.value;
				const start = lobes.length;
				await this.mtlxLobes( node, 'inputs:in1', w * ( isNum( by ) ? by : 1 ), lobes, hops + 1 );
				if ( Array.isArray( by ) ) for ( const l of lobes.slice( start ) ) if ( isValue( l.color?.value ) ) l.color = { value: zip( l.color.value, by, ( a, b ) => a * b ) };
				return;

			}

			case 'thin_film_bsdf':
				return;

		}

		this.warnOnce( `mtlx:${mtlxNode( id )}`, `MaterialX node "${mtlxNode( id )}" is not read — its lobe left out` );

	}

	/** The emission below `attribute`: uniform EDFs, added, mixed and scaled. */
	async mtlxEmission( prim, attribute, w, out, hops ) {

		const source = hops < 32 ? await this.stage.connectionSource( prim, attribute ) : null;
		const id = source?.prim.value( 'info:id' );
		if ( ! id || w <= 0 ) return;
		const node = source.prim;
		const t = name => this.term( node, name, hops + 1 );
		switch ( mtlxNode( id ) ) {

			case 'uniform_edf':
			case 'conical_edf':
			case 'measured_edf':
				out.push( { w, color: await t( 'color' ) } );
				return;
			case 'add_edf':
				await this.mtlxEmission( node, 'inputs:in1', w, out, hops + 1 );
				await this.mtlxEmission( node, 'inputs:in2', w, out, hops + 1 );
				return;
			case 'mix_edf': {

				const mix = ( await t( 'mix' ) )?.value;
				const m = isNum( mix ) ? mix : 0.5;
				await this.mtlxEmission( node, 'inputs:fg', w * m, out, hops + 1 );
				await this.mtlxEmission( node, 'inputs:bg', w * ( 1 - m ), out, hops + 1 );
				return;

			}

			case 'multiply_edfC':
			case 'multiply_edfF': {

				const by = ( await t( 'in2' ) )?.value;
				await this.mtlxEmission( node, 'inputs:in1', w * ( isValue( by ) ? mean( by ) : 1 ), out, hops + 1 );
				return;

			}

		}

		this.warnOnce( `mtlx:${mtlxNode( id )}`, `MaterialX node "${mtlxNode( id )}" is not read — its emission left out` );

	}

	// ── cameras and lights ───────────────────────────────────────

	camera( prim, matrix ) {

		const hAperture = prim.value( 'horizontalAperture' ) ?? 20.955;
		const vAperture = prim.value( 'verticalAperture' ) ?? 15.2908;
		const focal = prim.value( 'focalLength' ) ?? 50;
		const clipping = prim.value( 'clippingRange' );
		const [ near, far ] = clipping ?? [ 1, 1000000 ];
		const camera = prim.value( 'projection' ) === 'orthographic'
			// Apertures are in tenths of a scene unit.
			? new OrthographicCamera( - hAperture / 20, hAperture / 20, vAperture / 20, - vAperture / 20, near, far )
			: new PerspectiveCamera( 2 * Math.atan( vAperture / ( 2 * focal ) ) / DEG, hAperture / vAperture, near, far );
		camera.name = prim.name;
		// An authored near clip is a clip plane the path tracer honours (UsdGeom's fallback of 1 would clip every camera).
		if ( clipping && near > 0 ) camera.userData.clipStart = near;
		const scale = new Vector3();
		matrix.decompose( camera.position, camera.quaternion, scale );
		camera.updateMatrixWorld( true );
		this.cameras.push( camera );

	}

	light( prim, type, matrix ) {

		const read = ( name, fallback ) => prim.value( `inputs:${name}` ) ?? prim.value( name ) ?? fallback;
		const color = read( 'color', [ 1, 1, 1 ] );
		const radiance = read( 'intensity', type === 'DistantLight' ? 50000 : 1 ) * 2 ** read( 'exposure', 0 );
		if ( read( 'enableColorTemperature', false ) ) this.warnOnce( 'temperature', 'USD light colour temperature is not applied' );
		if ( prim.propertyNames().some( name => name.startsWith( 'collection:lightLink' ) || name.startsWith( 'collection:shadowLink' ) ) && type !== 'DomeLight' ) {

			this.warnOnce( 'linking', 'USD light linking is not supported — every light lights everything' );

		}

		if ( type === 'DomeLight' ) {

			const file = prim.assetPath( 'inputs:texture:file' ) ?? prim.assetPath( 'texture:file' );
			const excludes = prim.targets( 'collection:lightLink:excludes' );
			const top = this.stage.pseudoRoot.childNames().map( name => `/${name}` );
			this.domes.push( {
				name: prim.name, file: file?.path ?? null, asset: file?.asset ?? null, intensity: radiance, matrix: matrix.clone(), color,
				lightsScene: ! excludes.some( path => top.includes( path ) ),
			} );
			return;

		}

		// UsdLux: `normalize` divides the radiance by the light's size (its surface area; a distant light's disc).
		const normalize = !! read( 'normalize', false );
		let light;
		if ( type === 'RectLight' || type === 'DiskLight' ) {

			const disk = type === 'DiskLight';
			const radius = read( 'radius', 0.5 );
			light = new RectAreaLight( new Color(), radiance, disk ? radius * 2 : read( 'width', 1 ), disk ? radius * 2 : read( 'height', 1 ) );
			light.userData.normalize = normalize;
			if ( disk ) light.userData.shape = 'disk';
			// Normalized, the radiance is intensity ÷ world area, so the power is π × intensity whatever the size.
			if ( normalize ) {

				light.intensity = Math.PI * radiance;
				light.userData.__radianceConverted = true;

			}

		} else if ( type === 'SphereLight' || type === 'CylinderLight' ) {

			const radius = read( 'radius', 0.5 );
			const cone = read( 'shaping:cone:angle', 180 );
			const area = type === 'SphereLight' ? 4 * Math.PI * radius * radius : 2 * Math.PI * radius * read( 'length', 1 );
			// The engine's point and spot lights take their power, π × radiance × area for a surface of radiance L.
			const intensity = Math.PI * radiance * ( normalize ? 1 : area );
			if ( cone < 90 ) {

				light = new SpotLight( new Color(), intensity );
				light.angle = cone * DEG;
				light.penumbra = Math.min( 1, Math.max( 0, read( 'shaping:cone:softness', 0 ) ) );

			} else {

				light = new PointLight( new Color(), intensity );

			}

			light.decay = 2;
			light.distance = 0;
			// Its size softens its shadows (a disc facing the lit point, LightSerializer); treatAsPoint says it has none.
			if ( ! read( 'treatAsPoint', false ) && radius > 0 ) light.userData.radius = radius;
			light.userData.__candelaConverted = true;
			if ( type === 'CylinderLight' ) this.warnOnce( 'cylinder', 'USD cylinder lights are placed as point lights' );

		} else {

			// The irradiance on a surface facing the light: a disc of half-angle θ and radiance L gives π·sin²θ·L
			// (UsdLux's sizeFactor), so a normalized light's intensity is that irradiance.
			const angle = Math.max( read( 'angle', 0.53 ), 0 ) * DEG;
			const half = Math.min( angle / 2, Math.PI );
			const sin2 = Math.sin( half ) ** 2;
			const sizeFactor = half === 0 ? 1 : half <= Math.PI / 2 ? Math.PI * sin2 : Math.PI * ( 2 - sin2 );
			light = new DirectionalLight( new Color(), radiance * ( normalize ? 1 : sizeFactor ) );
			// The disc's angular diameter, which softens its shadows. Blender writes half its sun angle here.
			light.userData.angle = angle;
			light.userData.__luxConverted = true;

		}

		const peak = Math.max( color[ 0 ], color[ 1 ], color[ 2 ] );
		if ( ! ( peak > 0 ) || ! ( radiance > 0 ) ) return;
		light.color.setRGB( color[ 0 ] / peak, color[ 1 ] / peak, color[ 2 ] / peak );
		light.intensity *= peak;
		light.name = prim.name;
		matrix.decompose( light.position, light.quaternion, light.scale );
		if ( light.target ) {

			// A child of the light, so the light's own rotation aims it down its −Z.
			light.target.position.set( 0, 0, - 1 );
			light.add( light.target );

		}

		this.lights.push( light );

	}

	/**
	 * The dome light to install as the environment: the first that lights the scene. Its texture is a lat-long with +Y up
	 * and its centre facing +Z (OpenEXR's convention); the engine's equirect centre faces +X, a quarter turn about Y.
	 */
	pickDome() {

		const dome = this.domes.find( d => d.lightsScene && d.file ) ?? null;
		if ( this.domes.length > 1 ) this.warnOnce( 'domes', `${this.domes.length} USD dome lights; "${dome?.name ?? this.domes[ 0 ].name}" lights the scene` );
		if ( ! dome ) {

			const named = this.domes.find( d => d.asset );
			if ( named ) this.warnOnce( 'domefile', `USD dome light texture "${named.asset}" not found` );
			return null;

		}

		const pole = new Vector3( 0, 1, 0 ).transformDirection( dome.matrix );
		if ( pole.y < 0.999 ) this.warnOnce( 'domepole', 'USD dome light is tilted; only its turn about the up axis is applied' );
		const front = new Vector3( 0, 0, 1 ).transformDirection( dome.matrix );
		const yaw = Math.atan2( front.x, front.z ) / DEG;
		return { file: dome.file, intensity: dome.intensity * Math.max( ...dome.color ), rotation: 90 - yaw };

	}

}
