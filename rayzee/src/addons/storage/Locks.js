const local = new Map();

function tryGrant( state, mode ) {

	if ( state.exclusive ) return false;
	if ( mode === 'exclusive' && state.shared > 0 ) return false;
	if ( mode === 'exclusive' ) state.exclusive = true;
	else state.shared ++;
	return true;

}

function localAcquire( name, mode, ifAvailable ) {

	let state = local.get( name );
	if ( ! state ) {

		state = { shared: 0, exclusive: false, queue: [] };
		local.set( name, state );

	}

	const release = once( () => {

		if ( mode === 'exclusive' ) state.exclusive = false;
		else state.shared --;

		while ( state.queue.length && tryGrant( state, state.queue[ 0 ].mode ) ) state.queue.shift().grant();
		if ( ! state.exclusive && state.shared === 0 && state.queue.length === 0 ) local.delete( name );

	} );

	if ( state.queue.length === 0 && tryGrant( state, mode ) ) return Promise.resolve( release );

	if ( ifAvailable ) {

		if ( ! state.exclusive && state.shared === 0 && state.queue.length === 0 ) local.delete( name );
		return Promise.resolve( null );

	}

	return new Promise( ( resolve ) => state.queue.push( { mode, grant: () => resolve( release ) } ) );

}

function once( fn ) {

	let done = false;
	return () => {

		if ( done ) return;
		done = true;
		fn();

	};

}

const webLocks = () => ( typeof navigator !== 'undefined' && navigator.locks?.request ? navigator.locks : null );

/**
 * Holds a Web Lock until the returned function is called; resolves null when `ifAvailable` and taken.
 * Falls back to an in-process lock where Web Locks are missing (Node).
 * @returns {Promise<?function(): void>}
 */
export function acquireLock( name, { mode = 'exclusive', ifAvailable = false } = {} ) {

	const locks = webLocks();
	if ( ! locks ) return localAcquire( name, mode, ifAvailable );

	return new Promise( ( resolve, reject ) => {

		locks.request( name, { mode, ifAvailable }, ( lock ) => {

			if ( ! lock ) {

				resolve( null );
				return undefined;

			}

			return new Promise( ( done ) => resolve( once( done ) ) );

		} ).catch( reject );

	} );

}

/** @returns {Promise<Set<string>>} names of locks currently held by any tab of this origin */
export async function heldLockNames() {

	const locks = webLocks();
	if ( ! locks ) return new Set( local.keys() );

	const { held = [] } = await locks.query();
	return new Set( held.map( ( lock ) => lock.name ) );

}
