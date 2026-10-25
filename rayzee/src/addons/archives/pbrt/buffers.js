/**
 * A dropped ArrayBuffer is freed at the next major GC, which a parse allocating gigabytes of
 * scene text and growing arrays reaches late: the 80M-triangle Moana parse held ~4 GB of such
 * garbage. Transferring a buffer away frees it at once.
 */

const whole = view => view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
	&& typeof view.buffer.transfer === 'function'
	&& ! ( typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer );

/** Frees a view's memory now. Only for a view that alone holds its whole buffer. */
export function freeNow( view ) {

	if ( view && whole( view ) ) view.buffer.transfer( 0 );

}

/** `view` at `length` elements, the old memory let go at once; zero-filled when it grows. */
export function resized( view, length ) {

	const Type = view.constructor;
	if ( whole( view ) ) return new Type( view.buffer.transfer( length * Type.BYTES_PER_ELEMENT ) );
	const out = new Type( length );
	out.set( length < view.length ? view.subarray( 0, length ) : view );
	return out;

}
