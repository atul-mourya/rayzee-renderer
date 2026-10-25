/** Minimal addEventListener/dispatchEvent, so the storage core runs in workers without three.js. */
export class Emitter {

	constructor() {

		this._handlers = new Map();

	}

	addEventListener( type, handler ) {

		if ( ! this._handlers.has( type ) ) this._handlers.set( type, new Set() );
		this._handlers.get( type ).add( handler );

	}

	removeEventListener( type, handler ) {

		this._handlers.get( type )?.delete( handler );

	}

	dispatchEvent( event ) {

		for ( const handler of [ ...( this._handlers.get( event.type ) ?? [] ) ] ) handler.call( this, event );

	}

}
