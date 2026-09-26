/**
 * pbrt motion as per-object keyframes, for PBRTSceneBuilder to turn into one AnimationClip:
 *  - a frame sequence (`frame25.pbrt`, `frame35.pbrt`, …), each frame aligned with the previous
 *    so a moved object keeps one mesh, and one that comes or goes is shown only where it exists;
 *  - `ActiveTransform` / `TransformTimes` inside one file, as two keys.
 *
 * `motion = { times, matrices, visible }`: seconds, 16 floats per key, 0/1 per key or null.
 */

/** pbrt has no frame rate; 30 makes a 30 fps video export land on the scene's own frame numbers. */
export const SEQUENCE_FPS = 30;

// Frames past this are left out; each one is a full parse.
const MAX_SEQUENCE_FRAMES = 1000;

// Past this edit distance alignment matches by order instead; its memory grows with the square.
const MAX_ALIGN_EDITS = 2048;

// Placements animated past this stay where the first frame put them.
const MAX_ANIMATED_PLACEMENTS = 100_000;

/**
 * The sequence the best-ranked scene belongs to — files in one directory whose names differ
 * only by a number — or null.
 * @param {string[]} candidates - scene files, best first (see listEntryPathsFrom)
 * @returns {{ path: string, number: number }[] | null} frames in number order
 */
export function findFrameSequence( candidates ) {

	const lead = candidates[ 0 ];
	const parse = path => {

		const slash = path.lastIndexOf( '/' );
		const match = /^(.*?)(\d+)\.pbrt$/i.exec( path.slice( slash + 1 ) );
		return match ? { group: path.slice( 0, slash + 1 ) + '\0' + match[ 1 ].toLowerCase(), number: parseInt( match[ 2 ], 10 ) } : null;

	};

	const head = lead ? parse( lead ) : null;
	if ( ! head ) return null;

	const byNumber = new Map();
	for ( const path of candidates ) {

		const p = parse( path );
		if ( p && p.group === head.group && ! byNumber.has( p.number ) ) byNumber.set( p.number, path );

	}

	if ( byNumber.size < 2 ) return null;

	return [ ...byNumber ]
		.sort( ( a, b ) => a[ 0 ] - b[ 0 ] )
		.slice( 0, MAX_SEQUENCE_FRAMES )
		.map( ( [ number, path ] ) => ( { path, number } ) );

}

// ── keys ────────────────────────────────────────────────────────────

/** A 32-bit hash of a numeric array's bit patterns, with its length. */
function hashNumbers( values ) {

	let bits = values instanceof Float32Array || values instanceof Int32Array || values instanceof Uint32Array
		? new Uint32Array( values.buffer, values.byteOffset, values.length )
		: null;
	if ( ! bits ) bits = new Uint32Array( Float32Array.from( values ).buffer );

	let h = 0x811c9dc5;
	for ( let i = 0; i < bits.length; i ++ ) {

		h = Math.imul( h ^ bits[ i ], 0x01000193 );
		h ^= h >>> 15;

	}

	return ( h >>> 0 ).toString( 36 ) + ':' + values.length;

}

/** Equal exactly when the parameters are; long lists are hashed. */
function paramsKey( params ) {

	let key = '';
	for ( const name of Object.keys( params ).sort() ) {

		const { type, value } = params[ name ];
		const numeric = ArrayBuffer.isView( value ) || ( value.length > 16 && typeof value[ 0 ] === 'number' );
		key += `${type} ${name}=${numeric ? '#' + hashNumbers( value ) : value.join( ',' )};`;

	}

	return key;

}

/** A shape's identity across frames: everything but its transform. */
class ShapeKeys {

	constructor( ir ) {

		this.materialNames = new Map();
		for ( const [ name, def ] of ir.namedMaterials ) this.materialNames.set( def, name );
		this.cache = new Map();

	}

	of( shape ) {

		return `${shape.type}|${shape.reverseOrientation ? 1 : 0}|${paramsKey( shape.params )}|` +
			`${this._material( shape.material )}|${this._light( shape.areaLight )}`;

	}

	_material( material ) {

		if ( ! material ) return '-';
		let key = this.cache.get( material );
		if ( key === undefined ) {

			const name = this.materialNames.get( material ) ?? material._missingRef;
			key = name !== undefined ? 'N:' + name : 'I:' + material.type + ':' + paramsKey( material.params );
			this.cache.set( material, key );

		}

		return key;

	}

	_light( light ) {

		if ( ! light ) return '-';
		let key = this.cache.get( light );
		if ( key === undefined ) this.cache.set( light, key = 'L:' + light.type + ':' + paramsKey( light.params ) );
		return key;

	}

}

// ── alignment ───────────────────────────────────────────────────────

/**
 * Longest common subsequence. Exporters emit a scene in the same order every frame, so this
 * follows repeated parts through insertions, where pairing n-th copies shifts them onto neighbours.
 * @param {Int32Array} a
 * @param {Int32Array} b
 * @returns {Int32Array} index into `a` for each entry of `b`, or -1
 */
export function alignSequences( a, b ) {

	const matchOfB = new Int32Array( b.length ).fill( - 1 );

	let lo = 0;
	while ( lo < a.length && lo < b.length && a[ lo ] === b[ lo ] ) {

		matchOfB[ lo ] = lo;
		lo ++;

	}

	let aHi = a.length, bHi = b.length;
	while ( aHi > lo && bHi > lo && a[ aHi - 1 ] === b[ bHi - 1 ] ) {

		matchOfB[ -- bHi ] = -- aHi;

	}

	if ( lo < aHi && lo < bHi && ! myers( a, lo, aHi, b, lo, bHi, matchOfB ) ) {

		matchByOrder( a, lo, aHi, b, lo, bHi, matchOfB );

	}

	return matchOfB;

}

/** Myers' O(ND) diff on a[aLo..aHi) × b[bLo..bHi). False when it needs more than MAX_ALIGN_EDITS. */
function myers( a, aLo, aHi, b, bLo, bHi, matchOfB ) {

	const N = aHi - aLo, M = bHi - bLo;
	const max = Math.min( N + M, MAX_ALIGN_EDITS );
	const off = max + 1;
	const V = new Int32Array( 2 * max + 3 );
	const trace = [];

	for ( let d = 0; d <= max; d ++ ) {

		for ( let k = - d; k <= d; k += 2 ) {

			let x = k === - d || ( k !== d && V[ off + k - 1 ] < V[ off + k + 1 ] ) ? V[ off + k + 1 ] : V[ off + k - 1 ] + 1;
			let y = x - k;
			while ( x < N && y < M && a[ aLo + x ] === b[ bLo + y ] ) {

				x ++;
				y ++;

			}

			V[ off + k ] = x;

			if ( x >= N && y >= M ) {

				trace.push( V.slice( off - d, off + d + 1 ) );
				backtrack( trace, N, M, aLo, bLo, matchOfB );
				return true;

			}

		}

		trace.push( V.slice( off - d, off + d + 1 ) );

	}

	return false;

}

function backtrack( trace, N, M, aLo, bLo, matchOfB ) {

	let x = N, y = M;
	for ( let d = trace.length - 1; d > 0; d -- ) {

		const prev = trace[ d - 1 ];
		const at = kk => prev[ kk + d - 1 ];
		const k = x - y;
		const prevK = k === - d || ( k !== d && at( k - 1 ) < at( k + 1 ) ) ? k + 1 : k - 1;
		const prevX = at( prevK ), prevY = prevX - prevK;

		while ( x > prevX && y > prevY ) matchOfB[ bLo + ( -- y ) ] = aLo + ( -- x );

		x = prevX;
		y = prevY;

	}

	while ( x > 0 && y > 0 ) matchOfB[ bLo + ( -- y ) ] = aLo + ( -- x );

}

/** Pair the n-th occurrence of each key in `b` with the n-th in `a`. */
function matchByOrder( a, aLo, aHi, b, bLo, bHi, matchOfB ) {

	const queues = new Map();
	for ( let i = aLo; i < aHi; i ++ ) {

		const q = queues.get( a[ i ] );
		if ( q ) q.push( i );
		else queues.set( a[ i ], [ i ] );

	}

	const heads = new Map();
	for ( let j = bLo; j < bHi; j ++ ) {

		const q = queues.get( b[ j ] );
		if ( ! q ) continue;
		const h = heads.get( b[ j ] ) ?? 0;
		if ( h < q.length ) {

			matchOfB[ j ] = q[ h ];
			heads.set( b[ j ], h + 1 );

		}

	}

}

// ── motion ──────────────────────────────────────────────────────────

function sameMatrix( a, ao, b, bo ) {

	for ( let i = 0; i < 16; i ++ ) if ( a[ ao + i ] !== b[ bo + i ] ) return false;
	return true;

}

/** One key per frame; absent frames hold the nearest present pose. */
function motionFromFrames( times, present, matrixAt ) {

	const F = times.length;
	const matrices = new Float32Array( 16 * F );
	let visible = null;
	let last = - 1;

	for ( let f = 0; f < F; f ++ ) {

		if ( present( f ) ) {

			matrices.set( matrixAt( f ), f * 16 );
			if ( last < 0 ) for ( let g = 0; g < f; g ++ ) matrices.copyWithin( g * 16, f * 16, f * 16 + 16 );
			last = f;

		} else {

			visible ??= new Uint8Array( F ).fill( 1 );
			visible[ f ] = 0;
			if ( last >= 0 ) matrices.copyWithin( f * 16, last * 16, last * 16 + 16 );

		}

	}

	return { times, matrices, visible };

}

function motionIsStatic( motion ) {

	if ( motion.visible ) return false;
	const m = motion.matrices;
	for ( let o = 16; o < m.length; o += 16 ) if ( ! sameMatrix( m, 0, m, o ) ) return false;
	return true;

}

/** Folds a sequence's frames, added in order, into the first frame's IR. */
export class FrameSequenceMerger {

	/**
	 * @param {number[]} times - seconds, one per frame
	 * @param {string} name - clip name
	 */
	constructor( times, name ) {

		this.times = Float32Array.from( times );
		this.name = name;
		this.base = null;
		this.frame = - 1;
		this.keyIds = new Map();
		this.tracks = [];
		this.prev = null; // { keys: Int32Array, tracks: [] }
		// template -> { counts: per frame, diffs: placement -> frame -> matrix unlike frame 0's }
		this.placements = new Map();
		// template name + content -> name merged under
		this.templates = new Map();
		this.cameras = [];
		this.warnings = new Set();

	}

	/** @param {object} ir - a parsed frame; the first one becomes the merged scene */
	addFrame( ir ) {

		const f = ++ this.frame;
		if ( f === 0 ) this.base = ir;
		else this._adoptDefinitions( ir );

		for ( const w of ir.warnings ) this.warnings.add( w );

		const keys = new ShapeKeys( ir );
		const ids = new Int32Array( ir.shapes.length );
		for ( let i = 0; i < ids.length; i ++ ) {

			const key = keys.of( ir.shapes[ i ] );
			let id = this.keyIds.get( key );
			if ( id === undefined ) this.keyIds.set( key, id = this.keyIds.size );
			ids[ i ] = id;

		}

		const match = this.prev ? alignSequences( this.prev.keys, ids ) : null;
		const tracks = new Array( ids.length );
		for ( let j = 0; j < ids.length; j ++ ) {

			const shape = ir.shapes[ j ];
			let track = match && match[ j ] >= 0 ? this.prev.tracks[ match[ j ] ] : null;
			if ( track ) {

				track.last = f;
				if ( track.ctms ) track.ctms.push( shape.ctm );
				else if ( shape.ctm !== track.shape.ctm && ! sameMatrix( shape.ctm, 0, track.shape.ctm, 0 ) ) {

					track.ctms = new Array( f - track.first ).fill( track.shape.ctm );
					track.ctms.push( shape.ctm );

				}

			} else {

				track = { shape, first: f, last: f, ctms: null };
				if ( f > 0 ) this._adoptMaterial( shape, keys.materialNames );
				this.tracks.push( track );

			}

			tracks[ j ] = track;

		}

		this.prev = { keys: ids, tracks };
		this._addPlacements( ir, f, this._resolveTemplates( ir, f, keys ) );
		this.cameras.push( ir.camera ? { cameraToWorld: ir.camera.cameraToWorld, fov: ir.camera.params?.fov?.value?.[ 0 ] } : null );

	}

	/** Named materials and textures a later frame defines that the first did not. */
	_adoptDefinitions( ir ) {

		for ( const [ name, def ] of ir.namedMaterials ) if ( ! this.base.namedMaterials.has( name ) ) this.base.namedMaterials.set( name, def );
		for ( const [ name, def ] of ir.namedTextures ) if ( ! this.base.namedTextures.has( name ) ) this.base.namedTextures.set( name, def );

	}

	/**
	 * The name each template merges under; one a frame redefines becomes a variant `name @frame`.
	 * @returns {Map<string, string>}
	 */
	_resolveTemplates( ir, f, keys ) {

		const resolved = new Map();
		for ( const [ name, shapes ] of ir.objects ) {

			let signature = '';
			for ( const shape of shapes ) signature += keys.of( shape ) + '@' + Array.prototype.join.call( shape.relativeCTM || shape.ctm, ',' ) + ';';

			const key = name + '\0' + signature;
			let as = this.templates.get( key );
			if ( as === undefined ) {

				as = f === 0 || ! this.base.objects.has( name ) ? name : `${name} @${f}`;
				this.templates.set( key, as );
				if ( f > 0 ) {

					for ( const shape of shapes ) this._adoptMaterial( shape, keys.materialNames );
					this.base.objects.set( as, shapes );

				}

			}

			resolved.set( name, as );

		}

		return resolved;

	}

	/** Share the first frame's material of the same name. */
	_adoptMaterial( shape, materialNames ) {

		const name = shape.material && materialNames.get( shape.material );
		if ( name !== undefined ) shape.material = this.base.namedMaterials.get( name ) ?? shape.material;

	}

	/** Placements are paired by position in their template's list. */
	_addPlacements( ir, f, templateNames ) {

		for ( const [ placed, list ] of ir.instances ) {

			const name = templateNames.get( placed ) ?? placed;
			let rec = this.placements.get( name );
			if ( ! rec ) this.placements.set( name, rec = { counts: new Int32Array( this.times.length ), diffs: new Map() } );
			rec.counts[ f ] = list.count;
			if ( f === 0 ) continue;

			const base = this.base.instances.get( name );
			const baseCount = base?.count ?? 0;
			for ( let p = 0; p < list.count; p ++ ) {

				const o = p * 16;
				if ( p < baseCount && sameMatrix( list.matrices, o, base.matrices, o ) ) continue;
				let perFrame = rec.diffs.get( p );
				if ( ! perFrame ) rec.diffs.set( p, perFrame = new Map() );
				perFrame.set( f, list.matrices.slice( o, o + 16 ) );

			}

		}

	}

	/** @returns {object} the first frame's IR with every frame's motion folded in */
	finish() {

		const ir = this.base;
		const times = this.times;
		const F = this.frame + 1;

		// First-frame shapes keep their order; later arrivals follow in order of appearance.
		ir.shapes = this.tracks.map( track => {

			const { shape, first, last, ctms } = track;
			if ( first > 0 || last < F - 1 || ctms ) {

				shape.motion = motionFromFrames( times, g => g >= first && g <= last, g => ( ctms ? ctms[ g - first ] : shape.ctm ) );

			}

			return shape;

		} );

		ir.warnings = [ ...this.warnings ];
		ir.animatedInstances = this._finishPlacements( ir, times, F );

		const cams = this.cameras;
		if ( cams[ 0 ] && cams.every( Boolean ) ) {

			const motion = motionFromFrames( times, () => true, g => cams[ g ].cameraToWorld );
			const fovs = cams.map( c => c.fov ?? cams[ 0 ].fov );
			const fovVaries = fovs.some( v => v !== fovs[ 0 ] );
			if ( ! motionIsStatic( motion ) || fovVaries ) {

				ir.camera.motion = { ...motion, fov: fovVaries ? Float32Array.from( fovs ) : null };

			}

		}

		ir.animation = { name: this.name, duration: times[ F - 1 ], frames: F };
		return ir;

	}

	_finishPlacements( ir, times, F ) {

		const animated = [];
		let skipped = 0;

		for ( const [ name, { counts, diffs } ] of this.placements ) {

			const list = ir.instances.get( name );
			const baseCount = list?.count ?? 0;
			const most = Math.max( ...counts.subarray( 0, F ) );
			const keep = [];

			for ( let p = 0; p < most; p ++ ) {

				const frames = diffs.get( p );
				let moves = !! frames;
				for ( let g = 0; g < F && ! moves; g ++ ) moves = p >= counts[ g ];

				if ( moves && animated.length < MAX_ANIMATED_PLACEMENTS ) {

					const motion = motionFromFrames( times, g => p < counts[ g ],
						g => frames?.get( g ) ?? list.matrices.subarray( p * 16, p * 16 + 16 ) );
					animated.push( { name, motion } );

				} else {

					if ( moves ) skipped ++;
					if ( p < baseCount ) keep.push( p );

				}

			}

			if ( list && keep.length !== baseCount ) {

				const matrices = new Float32Array( keep.length * 16 );
				keep.forEach( ( p, i ) => matrices.set( list.matrices.subarray( p * 16, p * 16 + 16 ), i * 16 ) );
				ir.instanceCount -= baseCount - keep.length;
				list.matrices = matrices;
				list.matricesEnd = null;
				list.count = keep.length;

			}

		}

		if ( skipped > 0 ) ir.warnings.push( `${skipped.toLocaleString()} moving placement(s) past ${MAX_ANIMATED_PLACEMENTS.toLocaleString()} left static` );
		return animated;

	}

}

/**
 * One file's animated transforms as two keys each; the start transform stays the static pose.
 * @param {object} ir - parser output
 * @returns {object} the same IR
 */
export function motionFromShutter( ir ) {

	if ( ! ir.hasMotion ) return ir;

	const { start, end } = ir.transformTimes;
	const duration = end - start;
	if ( ! ( duration > 0 ) ) return ir;

	const times = Float32Array.of( 0, duration );
	const pair = ( a, ao, b, bo ) => {

		const matrices = new Float32Array( 32 );
		for ( let i = 0; i < 16; i ++ ) {

			matrices[ i ] = a[ ao + i ];
			matrices[ 16 + i ] = b[ bo + i ];

		}

		return { times, matrices, visible: null };

	};

	for ( const shape of ir.shapes ) {

		if ( shape.ctmEnd ) shape.motion = pair( shape.ctm, 0, shape.ctmEnd, 0 );

	}

	ir.animatedInstances = [];
	for ( const list of ir.instances.values() ) {

		if ( ! list.matricesEnd ) continue;

		const keep = [];
		for ( let p = 0; p < list.count; p ++ ) {

			const o = p * 16;
			if ( sameMatrix( list.matrices, o, list.matricesEnd, o ) || ir.animatedInstances.length >= MAX_ANIMATED_PLACEMENTS ) keep.push( p );
			else ir.animatedInstances.push( { name: list.name, motion: pair( list.matrices, o, list.matricesEnd, o ) } );

		}

		if ( keep.length !== list.count ) {

			const matrices = new Float32Array( keep.length * 16 );
			keep.forEach( ( p, i ) => matrices.set( list.matrices.subarray( p * 16, p * 16 + 16 ), i * 16 ) );
			ir.instanceCount -= list.count - keep.length;
			list.matrices = matrices;
			list.count = keep.length;

		}

		list.matricesEnd = null;

	}

	if ( ir.camera?.cameraToWorldEnd ) {

		ir.camera.motion = { ...pair( ir.camera.cameraToWorld, 0, ir.camera.cameraToWorldEnd, 0 ), fov: null };

	}

	ir.animation = { name: 'Shutter motion', duration, frames: 2 };
	return ir;

}
