import { createLogger, fmt } from '../utils/Logger.js';

/**
 * BuildTimer - Tracks and logs timing for all build pipeline steps.
 *
 * Nested timers default to `debug` so a normal load only shows the top-level
 * summary; pass `{ level: 'info' }` for the one phase worth a visible line.
 *
 * Usage:
 *   const timer = new BuildTimer( '', { namespace: 'scene', level: 'info' } );
 *   timer.start('stepName');
 *   // ... work ...
 *   timer.end('stepName');
 *   timer.print( [ '18,016 tris' ] ); // one summary line, steps folded into a group
 */
export class BuildTimer {

	constructor( label = 'Build', { namespace = 'build', level = 'debug' } = {} ) {

		this.label = label;
		this.level = level;
		this.logger = createLogger( namespace );
		this.entries = new Map();
		this.order = [];
		this.totalStart = performance.now();

	}

	start( name ) {

		this.entries.set( name, { start: performance.now(), end: null } );
		if ( ! this.order.includes( name ) ) this.order.push( name );
		return this;

	}

	end( name ) {

		const entry = this.entries.get( name );
		if ( entry ) {

			entry.end = performance.now();
			entry.duration = entry.end - entry.start;

		}

		return this;

	}

	getDuration( name ) {

		const entry = this.entries.get( name );
		return entry?.duration ?? 0;

	}

	/**
	 * @param {string[]} [parts] - extra summary segments (counts, sizes) shown before the total
	 */
	print( parts = [] ) {

		const totalDuration = performance.now() - this.totalStart;

		const steps = this.order
			.map( name => {

				const dur = this.entries.get( name )?.duration ?? 0;
				return dur >= 1 ? `${name} ${Math.round( dur )}ms` : null;

			} )
			.filter( Boolean );

		const headline = fmt.list( [ this.label, ...parts, fmt.ms( totalDuration ) ] );

		if ( this.level === 'info' ) this.logger.summary( headline, steps );
		else this.logger.debug( fmt.list( [ headline, steps.join( ' · ' ) ] ) );

		return { steps: Object.fromEntries( this.order.map( n => [ n, Math.round( this.entries.get( n )?.duration ?? 0 ) ] ) ), total: Math.round( totalDuration ) };

	}

}
