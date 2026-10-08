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

	constructor( stage, { maxTriangles = Infinity, maxPlacements = Infinity, curveSteps = 2, resolveImage = async () => null, warn = () => {} } = {} ) {

		this.stage = stage;
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

				this.transformTexture( map, term.transform );
				mat[ mapSlot ] = map;
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

			if ( term.channel !== channel ) {

				this.warnOnce( `chan:${mapSlot}:${term.channel}`, `USD ${slot} from a texture's "${term.channel}" channel is not supported (the engine reads "${channel}") — constant used` );
				return;

			}

			const map = await this.image( term.texture, false );
			if ( map ) {

				this.transformTexture( map, term.transform );
				mat[ mapSlot ] = map;
				mat[ slot ] = term.texture.scale?.[ 0 ] ?? 1;
				surface.uvSet = term.texture.uvSet;

			}

		}

	}

	transformTexture( map, transform ) {

		if ( ! transform ) return;
		if ( transform.scale ) map.repeat.set( transform.scale[ 0 ], transform.scale[ 1 ] );
		if ( transform.translation ) map.offset.set( transform.translation[ 0 ], transform.translation[ 1 ] );
		if ( transform.rotation ) map.rotation = transform.rotation * DEG;

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

	// ── cameras and lights ───────────────────────────────────────

	camera( prim, matrix ) {

		const hAperture = prim.value( 'horizontalAperture' ) ?? 20.955;
		const vAperture = prim.value( 'verticalAperture' ) ?? 15.2908;
		const focal = prim.value( 'focalLength' ) ?? 50;
		const [ near, far ] = prim.value( 'clippingRange' ) ?? [ 1, 1000000 ];
		const camera = prim.value( 'projection' ) === 'orthographic'
			// Apertures are in tenths of a scene unit.
			? new OrthographicCamera( - hAperture / 20, hAperture / 20, vAperture / 20, - vAperture / 20, near, far )
			: new PerspectiveCamera( 2 * Math.atan( vAperture / ( 2 * focal ) ) / DEG, hAperture / vAperture, near, far );
		camera.name = prim.name;
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

		let light;
		if ( type === 'RectLight' || type === 'DiskLight' ) {

			const disk = type === 'DiskLight';
			const radius = read( 'radius', 0.5 );
			light = new RectAreaLight( new Color(), radiance, disk ? radius * 2 : read( 'width', 1 ), disk ? radius * 2 : read( 'height', 1 ) );
			light.userData.normalize = read( 'normalize', false );
			if ( disk ) light.userData.shape = 'disk';

		} else if ( type === 'SphereLight' || type === 'CylinderLight' ) {

			const radius = read( 'radius', 0.5 );
			const cone = read( 'shaping:cone:angle', 180 );
			// The engine's lamps take 4π × the radiant intensity, which a sphere of radiance L shows as L·πr².
			const intensity = 4 * Math.PI * radiance * Math.PI * radius * radius;
			if ( cone < 90 ) {

				light = new SpotLight( new Color(), intensity );
				light.angle = cone * DEG;
				light.penumbra = Math.min( 1, Math.max( 0, read( 'shaping:cone:softness', 0 ) ) );

			} else {

				light = new PointLight( new Color(), intensity );

			}

			light.decay = 2;
			light.distance = 0;
			light.userData.__candelaConverted = true;
			if ( type === 'CylinderLight' ) this.warnOnce( 'cylinder', 'USD cylinder lights are placed as point lights' );

		} else {

			// Lux, as glTF's and three.js's are: the loader takes the luminous efficacy out.
			light = new DirectionalLight( new Color(), radiance );

		}

		const peak = Math.max( color[ 0 ], color[ 1 ], color[ 2 ] );
		if ( ! ( peak > 0 ) || ! ( radiance > 0 ) ) return;
		light.color.setRGB( color[ 0 ] / peak, color[ 1 ] / peak, color[ 2 ] / peak );
		light.intensity *= peak;
		light.name = prim.name;
		matrix.decompose( light.position, light.quaternion, light.scale );
		if ( light.target ) {

			const forward = new Vector3( 0, 0, - 1 ).transformDirection( matrix );
			light.target.position.copy( forward );
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
