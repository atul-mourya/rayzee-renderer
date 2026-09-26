/**
 * Parser + graphics-state machine for pbrt-v4 scene files.
 *
 * Consumes the token stream from PBRTTokenizer and produces a plain-data
 * intermediate representation (IR). No Three.js types — the IR is converted
 * to a scene graph later by PBRTSceneBuilder, keeping this module unit-testable.
 *
 * The graphics state mirrors pbrt's: a current transformation matrix (CTM),
 * a current material, a current area-light emission, and a reverse-orientation
 * flag, all saved/restored by AttributeBegin/AttributeEnd.
 *
 * IR shape:
 * {
 *   film:   { xresolution, yresolution, filename } | null,
 *   camera: { type, params, cameraToWorld:number[16] } | null,
 *   namedMaterials: Map<name, { type, params }>,
 *   namedTextures:  Map<name, { dataType, class, params }>,
 *   shapes: [ { type, params, ctm, ctmEnd?, material, areaLight, reverseOrientation } ],
 *   lights: [ { type, params, ctm } ],
 *   instances: Map<name, { name, count, matrices, matricesEnd? }>,
 *   objects: Map<name, shapes[]>,
 *   transformTimes: { start, end },
 *   hasMotion: boolean,
 *   warnings: string[]
 * }
 *
 * `ctm` is pbrt's start transform. `ActiveTransform` can edit a second, end-of-shutter one,
 * recorded as `ctmEnd` / `cameraToWorldEnd` / `matricesEnd` only where it differs.
 */

import { TokenStream, TokenType } from './PBRTTokenizer.js';
import * as M from './PBRTMath.js';

// Vertex streams reach tens of millions of entries and every consumer narrows them to
// float32 / uint32 anyway, so hold them at that width instead of 8 bytes a number.
// Below this a typed array costs more than it saves: an ArrayBuffer plus its view runs to
// ~100 bytes of overhead, and most parameters are one number or three.
const TYPED_ARRAY_THRESHOLD = 8;

const START = 1, END = 2, BOTH = 3;

function sameMatrix( a, b ) {

	if ( a === b ) return true;
	for ( let i = 0; i < 16; i ++ ) if ( a[ i ] !== b[ i ] ) return false;
	return true;

}

const NUMERIC_STORAGE = {
	integer: Int32Array,
	point3: Float32Array,
	point2: Float32Array,
	vector3: Float32Array,
	vector2: Float32Array,
	vector: Float32Array,
	normal: Float32Array,
	rgb: Float32Array
};

function growFloat32( array, length ) {

	const grown = new Float32Array( length );
	grown.set( array );
	return grown;

}

export class PBRTParser {

	/**
	 * @param {object} [opts]
	 * @param {(path:string)=>string} [opts.resolveInclude] - returns the text of
	 *        an Include/Import target, resolved relative to the current file.
	 */
	constructor( opts = {} ) {

		this.releaseInclude = opts.releaseInclude || null;
		this.resolveInclude = opts.resolveInclude || ( () => {

			throw new Error( 'PBRTParser: Include used but no resolveInclude provided' );

		} );

		// Placements past this are counted and dropped as they are read, not after: the peak
		// is the parse itself, so a limit applied later saves nothing.
		this.maxPlacements = opts.maxPlacements ?? Infinity;


		// IR accumulators
		this.ir = {
			film: null,
			camera: null,
			namedMaterials: new Map(),
			namedTextures: new Map(),
			shapes: [],
			lights: [],
			// name -> { name, count, matrices } with the transforms packed end to end. One object
			// and one 4x4 per placement measured 3.7 GB on isCoastline's 2.5M; this is 64 bytes
			// each and allocates nothing per placement.
			instances: new Map(),
			instanceCount: 0,
			skippedInstances: 0,
			objects: new Map(),
			transformTimes: { start: 0, end: 1 },
			hasMotion: false,
			warnings: []
		};

		// Graphics state. `ctmEnd` is null while it equals `ctm`.
		this.ctm = M.identity();
		this.ctmEnd = null;
		this.activeTransform = BOTH;
		this._ctmSource = null;
		this._ctmValue = null;
		this.state = { material: null, areaLight: null, reverseOrientation: false };
		this.attributeStack = [];
		this.transformStack = [];
		this.coordSystems = new Map();

		// Object capture (ObjectBegin/End)
		this.currentObject = null; // name being captured, or null
		this.objectBeginCTM = null; // CTM frame at ObjectBegin

		// Directory stack for resolving nested Includes
		this.dirStack = [ '' ];

		// Token cursor (swapped during Include recursion)
		this.stream = null;

		this._warnedUnknown = new Set();

	}

	/**
	 * Parse a top-level pbrt source.
	 * @param {string|Uint8Array} src - bytes are preferred; a scene file can be larger
	 *        than the longest string JavaScript will build.
	 * @param {string} [baseDir] - directory of the source file, for Include paths
	 * @returns {object} IR
	 */
	async parse( src, baseDir = '' ) {

		this.dirStack = [ baseDir ];
		await this._run( new TokenStream( src ) );
		return this.ir;

	}

	// ── token helpers ──────────────────────────────────────────────

	/** Record one placement, copying the CTM straight into the template's matrix buffer. */
	_addInstance( name ) {

		if ( this.ir.instanceCount >= this.maxPlacements ) {

			this.ir.skippedInstances ++;
			return;

		}

		let list = this.ir.instances.get( name );
		if ( ! list ) this.ir.instances.set( name, list = { name, count: 0, matrices: new Float32Array( 16 * 32 ), matricesEnd: null } );

		const need = ( list.count + 1 ) * 16;
		if ( need > list.matrices.length ) {

			const length = Math.max( need, list.matrices.length * 2 );
			list.matrices = growFloat32( list.matrices, length );
			if ( list.matricesEnd ) list.matricesEnd = growFloat32( list.matricesEnd, length );

		}

		const o = list.count * 16;
		const m = this.ctm;
		for ( let i = 0; i < 16; i ++ ) list.matrices[ o + i ] = m[ i ];

		// Allocated once a placement of this template moves.
		const end = this._ctmEndSnapshot();
		if ( end && ! list.matricesEnd ) list.matricesEnd = list.matrices.slice();
		if ( list.matricesEnd ) {

			const e = end || m;
			for ( let i = 0; i < 16; i ++ ) list.matricesEnd[ o + i ] = e[ i ];

		}

		list.count ++;
		this.ir.instanceCount ++;

	}

	/**
	 * The CTM as the IR should hold it. Consumers treat it as read-only, so consecutive
	 * shapes under one transform share a single copy — Moana's ground cover emits five
	 * million shapes without touching the CTM between them.
	 */
	_ctmSnapshot() {

		if ( this._ctmSource !== this.ctm ) {

			this._ctmSource = this.ctm;
			this._ctmValue = this.ctm.slice();

		}

		return this._ctmValue;

	}

	/** The end-of-shutter CTM when it differs from the start one, else null. */
	_ctmEndSnapshot() {

		if ( this.ctmEnd === null || sameMatrix( this.ctmEnd, this.ctm ) ) return null;
		this.ir.hasMotion = true;
		return this.ctmEnd.slice();

	}

	/** Right-multiply `m` into whichever CTMs ActiveTransform selects. */
	_concat( m ) {

		if ( this.activeTransform === BOTH && this.ctmEnd === null ) {

			this.ctm = M.multiply( this.ctm, m );
			return;

		}

		const end = this.ctmEnd ?? this.ctm;
		this.ctmEnd = this.activeTransform & END ? M.multiply( end, m ) : end;
		if ( this.activeTransform & START ) this.ctm = M.multiply( this.ctm, m );

	}

	/** Replace whichever CTMs ActiveTransform selects. */
	_setCTM( m ) {

		if ( this.activeTransform === BOTH ) {

			this.ctm = m;
			this.ctmEnd = null;
			return;

		}

		const end = this.ctmEnd ?? this.ctm;
		this.ctmEnd = this.activeTransform & END ? m : end;
		if ( this.activeTransform & START ) this.ctm = m;

	}

	_pushGraphicsState() {

		this.attributeStack.push( {
			ctm: this.ctm,
			ctmEnd: this.ctmEnd,
			activeTransform: this.activeTransform,
			material: this.state.material,
			areaLight: this.state.areaLight,
			reverseOrientation: this.state.reverseOrientation
		} );

	}

	_popGraphicsState() {

		const s = this.attributeStack.pop();
		if ( ! s ) return;
		this.ctm = s.ctm;
		this.ctmEnd = s.ctmEnd;
		this.activeTransform = s.activeTransform;
		this.state = { material: s.material, areaLight: s.areaLight, reverseOrientation: s.reverseOrientation };

	}

	_peek() {

		return this.stream.peek();

	}

	_next() {

		return this.stream.next();

	}

	_expectNumber( what ) {

		const t = this._next();
		if ( ! t || t.type !== TokenType.NUMBER ) {

			throw new Error( `PBRT parser: expected number for ${what}, got ${t ? t.value : 'EOF'}` );

		}

		return t.value;

	}

	_expectString( what ) {

		const t = this._next();
		if ( ! t || t.type !== TokenType.STRING ) {

			throw new Error( `PBRT parser: expected string for ${what}, got ${t ? t.value : 'EOF'}` );

		}

		return t.value;

	}

	_readNumbers( count ) {

		const out = [];
		for ( let i = 0; i < count; i ++ ) out.push( this._expectNumber( 'matrix/transform' ) );
		return out;

	}

	/**
	 * Reads a `[ ... ]` bracketed list of numbers (transforms use this form,
	 * but pbrt also accepts the 16 bare numbers without brackets).
	 */
	_readBracketedOrBareNumbers( count ) {

		if ( this._peek() && this._peek().type === TokenType.LBRACKET ) {

			this._next(); // [
			const out = [];
			while ( this._peek() && this._peek().type !== TokenType.RBRACKET ) {

				out.push( this._expectNumber( 'transform element' ) );

			}

			this._next(); // ]
			return out;

		}

		return this._readNumbers( count );

	}

	/**
	 * Parse a pbrt parameter list: a run of `"type name" value(s)` pairs.
	 * Stops when the next token is not a declarator string.
	 * @returns {Object<string, {type:string, value:Array}>}
	 */
	_parseParams() {

		const params = {};

		while ( this._peek() && this._peek().type === TokenType.STRING ) {

			const decl = this._next().value.trim().split( /\s+/ );
			const type = decl[ 0 ];
			const name = decl[ 1 ] !== undefined ? decl[ 1 ] : decl[ 0 ];

			const value = this._parseParamValue( type );
			params[ name ] = { type, value };

		}

		return params;

	}

	/** Read a single parameter value: a bracketed array or one bare token. */
	_parseParamValue( declaredType ) {

		const bracketed = this._peek() && this._peek().type === TokenType.LBRACKET;
		if ( bracketed ) this._next();

		const more = () => {

			const t = this._peek();
			return bracketed ? t && t.type !== TokenType.RBRACKET : false;

		};

		if ( ! bracketed ) return [ this._coerceValueToken( this._next() ) ];

		// A long all-number list goes typed; a short one does not. See TYPED_ARRAY_THRESHOLD.
		if ( this._peek() && this._peek().type === TokenType.NUMBER ) {

			const small = [];
			while ( more() && small.length < TYPED_ARRAY_THRESHOLD ) {

				const t = this._next();
				if ( t.type !== TokenType.NUMBER ) return this._finishMixedValue( small, small.length, t );
				small.push( t.value );

			}

			if ( ! more() ) {

				this._next(); // ]
				return small;

			}

			const Storage = NUMERIC_STORAGE[ declaredType ] || Float64Array;
			let buf = new Storage( TYPED_ARRAY_THRESHOLD * 4 );
			buf.set( small );
			let n = small.length;

			while ( more() ) {

				const t = this._next();
				if ( t.type !== TokenType.NUMBER ) return this._finishMixedValue( buf, n, t );
				if ( n === buf.length ) {

					const grown = new Storage( buf.length * 2 );
					grown.set( buf );
					buf = grown;

				}

				buf[ n ++ ] = t.value;

			}

			this._next(); // ]
			return n === buf.length ? buf : buf.slice( 0, n );

		}

		const out = [];
		while ( more() ) out.push( this._coerceValueToken( this._next() ) );
		this._next(); // ]
		return out;

	}

	/** A list that started numeric but turned out to be mixed — finish it as a plain array. */
	_finishMixedValue( buf, n, pending ) {

		const out = [];
		for ( let i = 0; i < n; i ++ ) out.push( buf[ i ] );
		out.push( this._coerceValueToken( pending ) );
		while ( this._peek() && this._peek().type !== TokenType.RBRACKET ) {

			out.push( this._coerceValueToken( this._next() ) );

		}

		this._next(); // ]
		return out;

	}

	_coerceValueToken( t ) {

		if ( ! t ) throw new Error( 'PBRT parser: unexpected EOF in parameter value' );
		if ( t.type === TokenType.NUMBER ) return t.value;
		if ( t.type === TokenType.STRING ) return t.value;
		if ( t.type === TokenType.WORD ) {

			if ( t.value === 'true' ) return true;
			if ( t.value === 'false' ) return false;
			return t.value;

		}

		throw new Error( `PBRT parser: unexpected token in parameter value: ${t.type}` );

	}

	// ── main directive loop ────────────────────────────────────────

	async _run( stream ) {

		// Save/restore so Include can recurse on a fresh stream.
		const saved = this.stream;
		this.stream = stream;

		for ( let t = this._next(); t !== null; t = this._next() ) {

			if ( t.type !== TokenType.WORD ) {

				throw new Error( `PBRT parser: expected directive, got ${t.type} ${t.value ?? ''}` );

			}

			// Only Include suspends; every other directive returns undefined and the loop
			// stays synchronous, so an await per token is not paid.
			const pending = this._directive( t.value );
			if ( pending !== undefined ) await pending;

		}

		this.stream = saved;

	}

	_directive( name ) {

		switch ( name ) {

			// ── transforms ──
			case 'Identity': this._setCTM( M.identity() ); break;
			case 'Translate': {

				const [ x, y, z ] = this._readNumbers( 3 );
				this._concat( M.translate( x, y, z ) );
				break;

			}

			case 'Scale': {

				const [ x, y, z ] = this._readNumbers( 3 );
				this._concat( M.scale( x, y, z ) );
				break;

			}

			case 'Rotate': {

				const [ angle, x, y, z ] = this._readNumbers( 4 );
				this._concat( M.rotate( angle, x, y, z ) );
				break;

			}

			case 'LookAt': {

				const v = this._readNumbers( 9 );
				const camToWorld = M.lookAtCameraToWorld(
					[ v[ 0 ], v[ 1 ], v[ 2 ] ], [ v[ 3 ], v[ 4 ], v[ 5 ] ], [ v[ 6 ], v[ 7 ], v[ 8 ] ]
				);
				// pbrt sets CTM to world-to-camera = inverse(cameraToWorld).
				this._concat( M.invert( camToWorld ) );
				break;

			}

			case 'Transform': {

				this._setCTM( this._readBracketedOrBareNumbers( 16 ) );
				break;

			}

			case 'ConcatTransform': {

				this._concat( this._readBracketedOrBareNumbers( 16 ) );
				break;

			}

			// Both ends, whatever ActiveTransform says — as pbrt does.
			case 'CoordinateSystem': this.coordSystems.set( this._expectString( 'CoordinateSystem' ), { ctm: this.ctm, ctmEnd: this.ctmEnd } ); break;
			case 'CoordSysTransform': {

				const cs = this.coordSystems.get( this._expectString( 'CoordSysTransform' ) );
				if ( cs ) {

					this.ctm = cs.ctm;
					this.ctmEnd = cs.ctmEnd;

				}

				break;

			}

			// ── scene-wide options ──
			case 'Camera': {

				const type = this._expectString( 'Camera type' );
				const params = this._parseParams();
				// Camera-to-world is the inverse of the CTM at the Camera directive.
				this.ir.camera = { type, params, cameraToWorld: M.invert( this.ctm ) };
				const end = this._ctmEndSnapshot();
				if ( end ) this.ir.camera.cameraToWorldEnd = M.invert( end );
				break;

			}

			case 'Film': {

				this._expectString( 'Film type' );
				const params = this._parseParams();
				this.ir.film = {
					xresolution: this._num( params.xresolution, 1280 ),
					yresolution: this._num( params.yresolution, 720 ),
					filename: this._str( params.filename, null )
				};
				break;

			}

			// Consumed for completeness; not used by the engine.
			case 'Integrator':
			case 'Sampler':
			case 'PixelFilter':
			case 'Filter':
			case 'Accelerator':
			case 'ColorSpace':
			case 'Option':
				this._skipTypeAndParams();
				break;

			// ── world block ──
			case 'WorldBegin':
				this.ctm = M.identity();
				this.ctmEnd = null;
				this.activeTransform = BOTH;
				this.state = { material: null, areaLight: null, reverseOrientation: false };
				break;
			case 'WorldEnd': break; // legacy v3

			case 'AttributeBegin': this._pushGraphicsState(); break;
			case 'AttributeEnd': this._popGraphicsState(); break;

			case 'TransformBegin': this.transformStack.push( { ctm: this.ctm, ctmEnd: this.ctmEnd, activeTransform: this.activeTransform } ); break;
			case 'TransformEnd': {

				const t = this.transformStack.pop();
				if ( t ) {

					this.ctm = t.ctm;
					this.ctmEnd = t.ctmEnd;
					this.activeTransform = t.activeTransform;

				}

				break;

			}

			case 'ReverseOrientation': this.state.reverseOrientation = ! this.state.reverseOrientation; break;

			// `Attribute "target" params` — v4 default-setting; ignored for MVP.
			case 'Attribute': this._expectString( 'Attribute target' ); this._parseParams(); break;
			case 'ActiveTransform': {

				const t = this._next();
				const which = t?.value;
				if ( which === 'StartTime' ) this.activeTransform = START;
				else if ( which === 'EndTime' ) this.activeTransform = END;
				else if ( which === 'All' ) this.activeTransform = BOTH;
				else this._warn( `ActiveTransform "${which}" not recognised` );
				break;

			}

			case 'TransformTimes': {

				const [ start, end ] = this._readNumbers( 2 );
				this.ir.transformTimes = { start, end };
				break;

			}

			case 'MediumInterface': {

				// up to two strings (inside/outside)
				if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
				if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
				break;

			}

			case 'MakeNamedMedium': this._skipNamedAndParams(); break;

			// ── materials ──
			case 'Material': {

				const type = this._expectString( 'Material type' );
				const params = this._parseParams();
				this.state.material = { type, params };
				break;

			}

			case 'MakeNamedMaterial': {

				const matName = this._expectString( 'MakeNamedMaterial name' );
				const params = this._parseParams();
				const type = this._str( params.type, 'diffuse' );
				this.ir.namedMaterials.set( matName, { type, params } );
				break;

			}

			case 'NamedMaterial': {

				const ref = this._expectString( 'NamedMaterial name' );
				const def = this.ir.namedMaterials.get( ref );
				this.state.material = def || { type: 'diffuse', params: {}, _missingRef: ref };
				if ( ! def ) this._warn( `NamedMaterial "${ref}" referenced before definition` );
				break;

			}

			case 'Texture': {

				const texName = this._expectString( 'Texture name' );
				const dataType = this._expectString( 'Texture data type' ); // float | spectrum
				const texClass = this._expectString( 'Texture class' ); // imagemap | scale | ...
				const params = this._parseParams();
				this.ir.namedTextures.set( texName, { dataType, class: texClass, params } );
				break;

			}

			// ── lights ──
			case 'AreaLightSource': {

				const type = this._expectString( 'AreaLightSource type' );
				const params = this._parseParams();
				this.state.areaLight = { type, params };
				break;

			}

			case 'LightSource': {

				const type = this._expectString( 'LightSource type' );
				const params = this._parseParams();
				if ( this.ctmEnd !== null && ! sameMatrix( this.ctmEnd, this.ctm ) ) this._warnOnce( 'animated-light', 'animated LightSource transforms are not supported — using the start transform' );
				this.ir.lights.push( { type, params, ctm: this._ctmSnapshot() } );
				break;

			}

			// ── geometry ──
			case 'Shape': {

				const type = this._expectString( 'Shape type' );
				const params = this._parseParams();
				const shape = {
					type,
					params,
					ctm: this._ctmSnapshot(),
					material: this.state.material,
					areaLight: this.state.areaLight,
					reverseOrientation: this.state.reverseOrientation
				};
				const end = this.currentObject === null ? this._ctmEndSnapshot() : null;
				if ( end ) shape.ctmEnd = end;
				else if ( this.currentObject !== null && this.ctmEnd !== null && ! sameMatrix( this.ctmEnd, this.ctm ) ) {

					this._warnOnce( 'animated-template', 'animated transforms inside ObjectBegin are not supported — using the start transform' );

				}

				this._emitShape( shape );
				break;

			}

			// ── instancing ──
			case 'ObjectBegin': {

				const objName = this._expectString( 'ObjectBegin name' );
				// pbrt implicitly pushes graphics state.
				this._pushGraphicsState();
				this.currentObject = objName;
				this.objectBeginCTM = this.ctm.slice();
				if ( ! this.ir.objects.has( objName ) ) this.ir.objects.set( objName, [] );
				break;

			}

			case 'ObjectEnd': {

				this.currentObject = null;
				this.objectBeginCTM = null;
				this._popGraphicsState();
				break;

			}

			case 'ObjectInstance': {

				const objName = this._expectString( 'ObjectInstance name' );
				this._addInstance( objName );
				break;

			}

			// ── file inclusion ──
			case 'Include':
			case 'Import': {

				const path = this._expectString( name );
				return this._include( path );

			}

			default:
				this._warnUnknown( name );
				// Best effort: swallow any trailing parameter list to stay in sync.
				this._parseParams();
				break;

		}

	}

	// ── directive support ──────────────────────────────────────────

	_emitShape( shape ) {

		if ( this.currentObject !== null ) {

			// Store relative to the ObjectBegin frame so instances can re-place it.
			shape.relativeCTM = M.multiply( M.invert( this.objectBeginCTM ), shape.ctm );
			this.ir.objects.get( this.currentObject ).push( shape );

		} else {

			this.ir.shapes.push( shape );

		}

	}

	async _include( path ) {

		const dir = this.dirStack[ this.dirStack.length - 1 ];
		const source = await this.resolveInclude( path, dir );
		if ( source == null ) {

			this._warn( `Include target not found: ${path}` );
			return;

		}

		const childDir = path.includes( '/' ) ? path.slice( 0, path.lastIndexOf( '/' ) ) : '';
		this.dirStack.push( childDir );
		try {

			await this._run( new TokenStream( source ) );

		} finally {

			this.dirStack.pop();
			// Depth-first, so only the open chain is live. Releasing here is what keeps a
			// multi-gigabyte scene's text from all being resident at once; a file included
			// again is simply resolved again.
			this.releaseInclude?.( path, dir );

		}

	}

	_skipTypeAndParams() {

		// "type" then params
		if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
		this._parseParams();

	}

	_skipNamedAndParams() {

		if ( this._peek() && this._peek().type === TokenType.STRING ) this._next();
		this._parseParams();

	}

	// ── param coercion helpers ─────────────────────────────────────

	_num( p, dflt ) {

		return p && p.value.length ? p.value[ 0 ] : dflt;

	}

	_str( p, dflt ) {

		return p && p.value.length ? p.value[ 0 ] : dflt;

	}

	// ── diagnostics ────────────────────────────────────────────────

	_warn( msg ) {

		this.ir.warnings.push( msg );

	}

	_warnOnce( key, msg ) {

		if ( this._warnedUnknown.has( key ) ) return;
		this._warnedUnknown.add( key );
		this._warn( msg );

	}

	_warnUnknown( name ) {

		if ( this._warnedUnknown.has( name ) ) return;
		this._warnedUnknown.add( name );
		this._warn( `Unsupported directive ignored: ${name}` );

	}

}

/** Convenience: parse a string into IR with no Include support. */
export function parsePBRT( src, opts ) {

	return new PBRTParser( opts ).parse( src );

}
