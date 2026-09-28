import { Color, Quaternion, Vector2, Vector3, Vector4 } from 'three';

/**
 * JSON-safe copies of setting and material values: colours, vectors and non-finite numbers are
 * tagged so {@link fromPortable} gives back the same types. Anything else that is not plain data
 * comes back undefined, so a caller can leave it out.
 */
export function toPortable( value ) {

	if ( value === null || typeof value === 'boolean' || typeof value === 'string' ) return value;
	if ( typeof value === 'number' ) return Number.isFinite( value ) ? value : { $num: String( value ) };
	if ( typeof value !== 'object' ) return undefined;
	if ( value.isColor ) return { $color: [ value.r, value.g, value.b ] };
	if ( value.isQuaternion ) return { $quat: [ value.x, value.y, value.z, value.w ] };
	if ( value.isVector2 || value.isVector3 || value.isVector4 ) return { $vec: value.toArray() };
	if ( ArrayBuffer.isView( value ) ) return Array.from( value );
	if ( Array.isArray( value ) ) return value.map( v => toPortable( v ) ?? null );

	const proto = Object.getPrototypeOf( value );
	if ( proto !== Object.prototype && proto !== null ) return undefined;

	const out = {};
	for ( const [ key, v ] of Object.entries( value ) ) {

		const p = toPortable( v );
		if ( p !== undefined ) out[ key ] = p;

	}

	return out;

}

export function fromPortable( value ) {

	if ( value === null || typeof value !== 'object' ) return value;
	if ( Array.isArray( value ) ) return value.map( fromPortable );
	if ( '$num' in value ) return Number( value.$num );
	if ( value.$color ) return new Color( ...value.$color );
	if ( value.$quat ) return new Quaternion( ...value.$quat );
	if ( value.$vec ) {

		const Vector = [ null, null, Vector2, Vector3, Vector4 ][ value.$vec.length ];
		return new Vector( ...value.$vec );

	}

	const out = {};
	for ( const [ key, v ] of Object.entries( value ) ) out[ key ] = fromPortable( v );
	return out;

}
