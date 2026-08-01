/**
 * Dev-only guard against texture-binding aliasing.
 *
 * Two TextureNodes still holding the default EmptyTexture when a stage's kernel is first
 * compiled can share one GPU binding, which then resolves to whichever is assigned last.
 * Nothing throws — the aliased node reads a real texture, just not its own. BilateralFilter
 * shipped this way, reading ASVGF's history counter as its variance.
 *
 * Rule enforced: every TextureNode a kernel reads must hold its real texture before that
 * kernel is first dispatched. StorageTexture-typed nodes are exempt — `textureLoad` codegen
 * only emits the required `level` parameter while the node still holds EmptyTexture, so those
 * are deliberately bound after compile (see ASVGF.render).
 *
 * Off by default; the bench harness turns it on.
 */

let enabled = false;
const findings = [];

/** Per-stage audit state. WeakMap so a disposed stage does not pin its entry. */
const stageState = new WeakMap();

/**
 * @param {boolean} on
 */
export function setBindingAudit( on ) {

	enabled = !! on;

}

export function isBindingAuditEnabled() {

	return enabled;

}

/** @returns {Array<{stage: string, nodes: string[], unboundAtCompile: string[], message: string}>} */
export function getBindingAuditFindings() {

	return findings.slice();

}

export function clearBindingAuditFindings() {

	findings.length = 0;

}

/** Own enumerable properties holding a TSL TextureNode. */
function textureNodeKeys( stage ) {

	const keys = [];

	for ( const key of Object.keys( stage ) ) {

		if ( stage[ key ]?.isTextureNode === true ) keys.push( key );

	}

	return keys;

}

// EmptyTexture (the TextureNode default) is a bare `new Texture()`, so its image is null.
// Every real texture the stages bind — RenderTarget textures and StorageTextures alike —
// carries an image with a nonzero width.
const isUnbound = ( texture ) => ! texture || ! texture.image || ! ( texture.image.width > 0 );

/**
 * Runs a stage's render with the audit wrapped around it.
 *
 * The snapshot must be taken when the stage first calls `renderer.compute`, not before or
 * after render() — the binding assignments and the compile are interleaved inside that one
 * call, so by the time it returns everything is bound. Sampling after render() was the first
 * version of this guard and it silently caught nothing.
 *
 * A later frame then resolves: a candidate now holding a StorageTexture is the sanctioned
 * pattern; anything else was bound too late.
 *
 * @param {Object} stage
 * @param {Object} renderer
 * @param {function(): void} renderFn
 */
export function auditStageRender( stage, renderer, renderFn ) {

	if ( ! enabled ) {

		renderFn();
		return;

	}

	let state = stageState.get( stage );

	if ( ! state ) {

		state = { phase: 'pending', unboundAtCompile: [] };
		stageState.set( stage, state );

	}

	if ( state.phase !== 'pending' ) {

		renderFn();
		if ( state.phase === 'watch' ) resolve( stage, state );
		return;

	}

	// Shadow the prototype method for the duration of this stage's render only.
	const hadOwn = Object.prototype.hasOwnProperty.call( renderer, 'compute' );
	const original = renderer.compute;

	renderer.compute = function ( ...args ) {

		if ( state.phase === 'pending' ) {

			state.unboundAtCompile = textureNodeKeys( stage )
				.filter( ( key ) => isUnbound( stage[ key ].value ) );

			// A single unbound node has nothing to alias with, so it cannot produce this bug.
			state.phase = state.unboundAtCompile.length < 2 ? 'done' : 'watch';

		}

		return original.apply( this, args );

	};

	try {

		renderFn();

	} finally {

		if ( hadOwn ) renderer.compute = original;
		else delete renderer.compute;

	}

}

function resolve( stage, state ) {

	const lateBound = [];

	for ( const key of state.unboundAtCompile ) {

		const texture = stage[ key ]?.value;

		// Still unassigned — the stage may bind it on a later frame (or never, which is also
		// not this bug). Leave the audit open rather than guessing.
		if ( isUnbound( texture ) ) return;

		if ( texture.isStorageTexture !== true ) lateBound.push( key );

	}

	state.phase = 'done';

	if ( lateBound.length === 0 ) return;

	findings.push( {
		stage: stage.name,
		nodes: lateBound,
		unboundAtCompile: state.unboundAtCompile.slice(),
		message:
			`${stage.name}: ${lateBound.join( ', ' )} ` +
			`${lateBound.length === 1 ? 'was' : 'were'} still holding EmptyTexture when the stage ` +
			`first dispatched, alongside ${state.unboundAtCompile.length - lateBound.length} ` +
			'other unbound node(s), and later received a non-storage texture. Two nodes unbound at ' +
			'compile time can share one GPU binding and then both resolve to whichever is assigned ' +
			'last. Assign these before the first dispatch.',
	} );

}
