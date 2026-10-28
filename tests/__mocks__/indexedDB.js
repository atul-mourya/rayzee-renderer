// In-memory IndexedDB. `faults.open` fails the next opens with that error name, `faults.ops` the named requests.

const domError = ( name ) => new DOMException( name, name );

// A value structuredClone refuses (a handle with methods, which browsers serialise) is kept as is.
function clone( value ) {

	try {

		return structuredClone( value );

	} catch {

		return value;

	}

}

function compareKeys( a, b ) {

	if ( typeof a !== typeof b ) return typeof a === 'number' ? - 1 : 1;
	return a < b ? - 1 : a > b ? 1 : 0;

}

class FakeRequest {

	constructor() {

		this.result = undefined;
		this.error = null;
		this.onsuccess = null;
		this.onerror = null;
		this.onupgradeneeded = null;

	}

}

class FakeObjectStore {

	constructor( data, mode, faults ) {

		this._data = data;
		this._mode = mode;
		this._faults = faults;
		this.name = data.name;
		this.keyPath = data.keyPath;
		this.autoIncrement = data.autoIncrement;

	}

	_request( op, fn ) {

		const req = new FakeRequest();
		queueMicrotask( () => {

			try {

				if ( this._faults.ops.includes( op ) ) throw domError( 'UnknownError' );
				req.result = fn();
				req.onsuccess?.( { target: req } );

			} catch ( error ) {

				req.error = error;
				req.onerror?.( { target: req } );

			}

		} );
		return req;

	}

	_writable() {

		if ( this._mode !== 'readwrite' && this._mode !== 'versionchange' ) throw domError( 'ReadOnlyError' );

	}

	_store( value, key, { overwrite } ) {

		this._writable();
		const data = this._data;
		const stored = clone( value );
		const given = data.keyPath ? value?.[ data.keyPath ] : key;
		if ( given === undefined && ! data.autoIncrement ) throw domError( 'DataError' );

		return this._request( overwrite ? 'put' : 'add', () => {

			const id = given ?? data.next;
			if ( given === undefined && data.keyPath ) stored[ data.keyPath ] = id;
			if ( ! overwrite && data.records.has( id ) ) throw domError( 'ConstraintError' );
			data.records.set( id, stored );
			if ( typeof id === 'number' && id >= data.next ) data.next = Math.floor( id ) + 1;
			return id;

		} );

	}

	put( value, key ) {

		return this._store( value, key, { overwrite: true } );

	}

	add( value, key ) {

		return this._store( value, key, { overwrite: false } );

	}

	get( key ) {

		return this._request( 'get', () => clone( this._data.records.get( key ) ) );

	}

	getAll() {

		return this._request( 'getAll', () => this._sortedKeys().map( ( key ) => clone( this._data.records.get( key ) ) ) );

	}

	getAllKeys() {

		return this._request( 'getAllKeys', () => this._sortedKeys() );

	}

	delete( key ) {

		this._writable();
		return this._request( 'delete', () => {

			this._data.records.delete( key );
			return undefined;

		} );

	}

	createIndex( name ) {

		if ( this._mode !== 'versionchange' ) throw domError( 'InvalidStateError' );
		this._data.indexes.add( name );

	}

	_sortedKeys() {

		return [ ...this._data.records.keys() ].sort( compareKeys );

	}

}

function storeData( name, { keyPath = null, autoIncrement = false } = {} ) {

	return { name, keyPath, autoIncrement, records: new Map(), next: 1, indexes: new Set() };

}

class FakeConnection {

	constructor( database, faults ) {

		this._database = database;
		this._faults = faults;
		this._upgrading = false;
		this._closed = false;
		this.name = database.name;
		this.objectStoreNames = { contains: ( name ) => database.stores.has( name ) };

	}

	get version() {

		return this._database.version;

	}

	createObjectStore( name, options ) {

		if ( ! this._upgrading ) throw domError( 'InvalidStateError' );
		if ( this._database.stores.has( name ) ) throw domError( 'ConstraintError' );
		const data = storeData( name, options );
		this._database.stores.set( name, data );
		return new FakeObjectStore( data, 'versionchange', this._faults );

	}

	transaction( name, mode = 'readonly' ) {

		if ( this._closed ) throw domError( 'InvalidStateError' );
		const data = this._database.stores.get( name );
		if ( ! data ) throw domError( 'NotFoundError' );
		return {
			mode,
			objectStore: ( storeName ) => {

				if ( storeName !== name ) throw domError( 'NotFoundError' );
				return new FakeObjectStore( data, mode, this._faults );

			},
		};

	}

	close() {

		this._closed = true;

	}

}

export function createFakeIndexedDB() {

	const databases = new Map();
	const faults = { open: null, ops: [] };

	const indexedDB = {
		open( name, version ) {

			if ( version !== undefined && ! ( Number.isInteger( version ) && version > 0 ) ) throw new TypeError( `bad version ${version}` );
			const req = new FakeRequest();
			queueMicrotask( () => {

				if ( faults.open ) {

					req.error = domError( faults.open );
					req.onerror?.( { target: req } );
					return;

				}

				let database = databases.get( name );
				if ( ! database ) {

					database = { name, version: 0, stores: new Map() };
					databases.set( name, database );

				}

				const target = version ?? Math.max( database.version, 1 );
				if ( target < database.version ) {

					req.error = domError( 'VersionError' );
					req.onerror?.( { target: req } );
					return;

				}

				const connection = new FakeConnection( database, faults );
				req.result = connection;
				if ( target > database.version ) {

					const oldVersion = database.version;
					database.version = target;
					connection._upgrading = true;
					req.onupgradeneeded?.( { target: req, oldVersion, newVersion: target } );
					connection._upgrading = false;

				}

				req.onsuccess?.( { target: req } );

			} );
			return req;

		},
	};

	/** A database as an earlier (or later) build left it. */
	const seed = ( name, version, stores ) => {

		const database = { name, version, stores: new Map() };
		for ( const [ storeName, { records = [], ...options } ] of Object.entries( stores ) ) {

			const data = storeData( storeName, options );
			for ( const record of records ) {

				const id = record[ options.keyPath ];
				data.records.set( id, clone( record ) );
				if ( typeof id === 'number' && id >= data.next ) data.next = id + 1;

			}

			database.stores.set( storeName, data );

		}

		databases.set( name, database );

	};

	const records = ( name, storeName ) => databases.get( name )?.stores.get( storeName )?.records ?? new Map();

	return { indexedDB, faults, seed, records, databases };

}
