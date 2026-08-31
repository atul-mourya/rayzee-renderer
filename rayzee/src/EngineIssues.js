/**
 * Structured record of what the engine degraded rather than failed on. Lenient hosts read
 * `app.issues`; strict hosts throw at the point of degradation.
 *
 * Codes are API surface — add, never rename or repurpose.
 */
export const ISSUE_CODES = Object.freeze( {
	ADAPTER_SOFTWARE: 'adapter.software',
	ASSET_UNREACHABLE: 'asset.unreachable',
	TEXTURE_BUILD_FAILED: 'texture.build_failed',
	TEXTURE_PROCESSING_FALLBACK: 'texture.processing_fallback',
	ENVIRONMENT_LOAD_FAILED: 'environment.load_failed',
	SETTING_UNKNOWN_KEY: 'setting.unknown_key',
	RENDER_SIZE_DECLINED: 'render.size_declined',
	STAGE_RENDER_FAILED: 'stage.render_failed',
	RENDER_RESERVE_CAPPED: 'render.reserve_capped',
} );

/** Strict throws on ERROR only. */
export const ISSUE_SEVERITY = Object.freeze( { ERROR: 'error', WARNING: 'warning' } );

export class EngineIssueError extends Error {

	constructor( issue ) {

		super( `[${issue.code}] ${issue.message}` );
		this.name = 'EngineIssueError';
		this.code = issue.code;
		this.detail = issue.detail;

	}

}

export class IssueLog {

	/** @param {{strict?: boolean, onIssue?: function(Object): void}} [options] */
	constructor( { strict = false, onIssue = null } = {} ) {

		this.strict = strict === true;
		this._onIssue = onIssue;
		this._entries = [];

	}

	/** @throws {EngineIssueError} when strict and severity is 'error' */
	record( code, message, detail = {}, severity = ISSUE_SEVERITY.ERROR ) {

		const issue = Object.freeze( { code, message, detail, severity, at: Date.now() } );
		this._entries.push( issue );

		this._onIssue?.( issue );

		if ( this.strict && severity === ISSUE_SEVERITY.ERROR ) throw new EngineIssueError( issue );

		return issue;

	}

	warn( code, message, detail ) {

		return this.record( code, message, detail, ISSUE_SEVERITY.WARNING );

	}

	/** @returns {Object[]} a copy */
	get list() {

		return this._entries.slice();

	}

	get errors() {

		return this._entries.filter( ( issue ) => issue.severity === ISSUE_SEVERITY.ERROR );

	}

	clear() {

		this._entries.length = 0;

	}

	/** Call from dispose(): onIssue captures the app, and this log outlives it via injectees. */
	detach() {

		this._onIssue = null;
		this.strict = false;

	}

}
