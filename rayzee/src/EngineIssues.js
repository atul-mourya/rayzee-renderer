/**
 * Structured record of everything the engine chose to survive.
 *
 * The engine is a viewer by default: a missing texture, an unreachable environment or a
 * declined resize all degrade rather than stop, because a viewer showing something beats a
 * viewer showing nothing. A batch renderer wants the opposite — a wrong image gets uploaded
 * and believed. Rather than two code paths, every degradation records an issue here and a
 * single policy decides what that means: lenient hosts read `app.issues`, strict hosts get a
 * throw at the point of degradation.
 */

/**
 * Issue codes are API surface: hosts pin a version and branch on these strings. Codes may be
 * ADDED, never renamed or repurposed — a taxonomy that shifts between minors is worse than no
 * taxonomy at all. Retire a code by leaving it here unused.
 */
export const ISSUE_CODES = Object.freeze( {
	/** A software rasterizer (SwiftShader, llvmpipe, WARP) is doing the work. */
	ADAPTER_SOFTWARE: 'adapter.software',
	/** A model, texture or other sub-resource could not be fetched. */
	ASSET_UNREACHABLE: 'asset.unreachable',
	/** A material texture array failed to build — those surfaces render untextured. */
	TEXTURE_BUILD_FAILED: 'texture.build_failed',
	/** Worker texture processing failed and fell back to the main thread. */
	TEXTURE_PROCESSING_FALLBACK: 'texture.processing_fallback',
	/** The environment map failed to load — lighting falls back to whatever was there. */
	ENVIRONMENT_LOAD_FAILED: 'environment.load_failed',
	/** settings.set() was given a key with no route; the value is stored and never applied. */
	SETTING_UNKNOWN_KEY: 'setting.unknown_key',
	/** A resize was declined, so the render is not the size that was asked for. */
	RENDER_SIZE_DECLINED: 'render.size_declined',
	/** The requested storage reserve exceeded device limits and was capped. */
	RENDER_RESERVE_CAPPED: 'render.reserve_capped',
} );

/** Severities that a strict host throws on. Warnings are recorded and never throw. */
export const ISSUE_SEVERITY = Object.freeze( { ERROR: 'error', WARNING: 'warning' } );

/**
 * Thrown by {@link IssueLog#record} when the log is strict and the issue is an error.
 * Carries the issue so a caller can branch on `error.code` without parsing a message.
 */
export class EngineIssueError extends Error {

	constructor( issue ) {

		super( `[${issue.code}] ${issue.message}` );
		this.name = 'EngineIssueError';
		this.code = issue.code;
		this.detail = issue.detail;
		this.issue = issue;

	}

}

export class IssueLog {

	/**
	 * @param {Object} [options]
	 * @param {boolean} [options.strict=false] - throw on every error-severity issue
	 * @param {function(Object): void} [options.onIssue] - called for every issue, before any throw
	 */
	constructor( { strict = false, onIssue = null } = {} ) {

		this.strict = strict === true;
		this._onIssue = onIssue;
		this._entries = [];

	}

	/**
	 * @param {string} code - one of ISSUE_CODES
	 * @param {string} message - human-readable, specific enough to act on
	 * @param {Object} [detail] - structured context (url, map type, requested size…)
	 * @param {string} [severity] - ISSUE_SEVERITY.ERROR (default) or WARNING
	 * @returns {Object} the recorded issue
	 * @throws {EngineIssueError} when strict and severity is 'error'
	 */
	record( code, message, detail = {}, severity = ISSUE_SEVERITY.ERROR ) {

		const issue = Object.freeze( { code, message, detail, severity, at: Date.now() } );
		this._entries.push( issue );

		this._onIssue?.( issue );

		if ( this.strict && severity === ISSUE_SEVERITY.ERROR ) throw new EngineIssueError( issue );

		return issue;

	}

	/** Convenience for the non-throwing severity. */
	warn( code, message, detail ) {

		return this.record( code, message, detail, ISSUE_SEVERITY.WARNING );

	}

	/** @returns {Object[]} a copy — mutating the result cannot corrupt the log */
	get list() {

		return this._entries.slice();

	}

	get length() {

		return this._entries.length;

	}

	has( code ) {

		return this._entries.some( ( issue ) => issue.code === code );

	}

	/** @returns {Object[]} issues of error severity only */
	get errors() {

		return this._entries.filter( ( issue ) => issue.severity === ISSUE_SEVERITY.ERROR );

	}

	clear() {

		this._entries.length = 0;

	}

}
