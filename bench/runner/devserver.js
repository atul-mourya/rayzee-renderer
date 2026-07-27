/**
 * Vite dev-server lifecycle for the bench runner.
 *
 * The harness is served through the dev server rather than a static build because the
 * engine is aliased straight to source — a bench run therefore always measures the
 * working tree, with no build step to go stale.
 */

import { spawn } from 'node:child_process';
import { DEV_SERVER } from './config.js';

/**
 * Starts `npm run dev` and resolves once Vite prints its local URL.
 *
 * @param {Object} [options]
 * @param {string} [options.cwd] - repo to run in (an A/B worktree passes its own path)
 * @param {boolean} [options.verbose]
 * @returns {Promise<{ url: string, stop: function(): Promise<void> }>}
 */
export async function startDevServer( { cwd = DEV_SERVER.cwd, verbose = false } = {} ) {

	const child = spawn( DEV_SERVER.command, DEV_SERVER.args, {
		cwd,
		env: { ...process.env, FORCE_COLOR: '0' },
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		// npm forks vite as a grandchild; making the child a group leader lets stop()
		// signal the whole tree instead of orphaning the actual server.
		detached: true,
	} );

	let output = '';

	// Vite colours its banner regardless of FORCE_COLOR, and the escape codes land INSIDE
	// the URL ("http://localhost:\x1b[1m5173\x1b[22m/"), so the pattern must match on
	// stripped text.
	// eslint-disable-next-line no-control-regex
	const stripAnsi = ( text ) => text.replace( /\x1B\[[0-9;]*m/g, '' );

	const url = await new Promise( ( resolve, reject ) => {

		const timer = setTimeout( () => {

			reject( new Error(
				`dev server did not start within ${DEV_SERVER.timeoutMs} ms.\n--- output ---\n${output}`
			) );

		}, DEV_SERVER.timeoutMs );

		const onData = ( chunk ) => {

			const text = chunk.toString();
			output += stripAnsi( text );
			if ( verbose ) process.stdout.write( text );

			const match = output.match( DEV_SERVER.readyPattern );
			if ( match ) {

				clearTimeout( timer );
				resolve( match[ 1 ].replace( /\/$/, '' ) );

			}

		};

		child.stdout.on( 'data', onData );
		child.stderr.on( 'data', onData );

		child.on( 'error', ( error ) => {

			clearTimeout( timer );
			reject( error );

		} );

		child.on( 'exit', ( code ) => {

			clearTimeout( timer );
			reject( new Error( `dev server exited early with code ${code}\n--- output ---\n${output}` ) );

		} );

	} );

	// A detached child survives Ctrl-C: the signal reaches this process's group, not the
	// child's own. Without this a cancelled run leaves vite holding the port, and the next
	// run silently binds a different one.
	const killOnSignal = () => {

		try {

			process.kill( - child.pid, 'SIGKILL' );

		} catch { /* already gone */ }

	};

	process.once( 'SIGINT', killOnSignal );
	process.once( 'SIGTERM', killOnSignal );
	process.once( 'exit', killOnSignal );

	const stop = () => new Promise( ( resolve ) => {

		process.off( 'SIGINT', killOnSignal );
		process.off( 'SIGTERM', killOnSignal );
		process.off( 'exit', killOnSignal );

		if ( child.exitCode !== null || child.signalCode !== null ) return resolve();

		child.once( 'exit', () => resolve() );
		// Vite spawns through npm, so kill the process group to avoid orphaning the child.
		try {

			process.kill( - child.pid, 'SIGTERM' );

		} catch {

			child.kill( 'SIGTERM' );

		}

		setTimeout( () => {

			try {

				child.kill( 'SIGKILL' );

			} catch { /* already gone */ }

			resolve();

		}, 5000 ).unref?.();

	} );

	return { url, stop };

}
