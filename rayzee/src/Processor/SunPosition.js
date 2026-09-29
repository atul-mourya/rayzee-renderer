/**
 * Where the sun stands, from local solar time, day of the year and latitude. Declination is
 * Spencer's (1971) series; azimuth is clockwise from north. Degrees in and out.
 */

const RAD = Math.PI / 180;

function declination( dayOfYear ) {

	const g = 2 * Math.PI * ( dayOfYear - 1 ) / 365;
	return 0.006918 - 0.399912 * Math.cos( g ) + 0.070257 * Math.sin( g ) - 0.006758 * Math.cos( 2 * g )
		+ 0.000907 * Math.sin( 2 * g ) - 0.002697 * Math.cos( 3 * g ) + 0.00148 * Math.sin( 3 * g );

}

/** @returns {{ azimuth: number, elevation: number }} */
export function sunPosition( { hours, dayOfYear, latitude } ) {

	const d = declination( dayOfYear );
	const h = ( hours - 12 ) * 15 * RAD;
	const lat = latitude * RAD;
	const sinEl = Math.sin( lat ) * Math.sin( d ) + Math.cos( lat ) * Math.cos( d ) * Math.cos( h );
	const elevation = Math.asin( Math.min( 1, Math.max( - 1, sinEl ) ) ) / RAD;
	const azimuth = ( Math.atan2( Math.sin( h ), Math.cos( h ) * Math.sin( lat ) - Math.tan( d ) * Math.cos( lat ) ) / RAD + 540 ) % 360;
	return { azimuth, elevation };

}

/** The solar time the sun reaches `elevation`, before or after noon; noon or midnight when it never does. */
export function timeForSunElevation( { elevation, dayOfYear, latitude, afternoon = false } ) {

	const d = declination( dayOfYear );
	const lat = latitude * RAD;
	const cosH = ( Math.sin( elevation * RAD ) - Math.sin( lat ) * Math.sin( d ) ) / ( Math.cos( lat ) * Math.cos( d ) );
	const h = Math.acos( Math.min( 1, Math.max( - 1, cosH ) ) ) / RAD / 15;
	return afternoon ? 12 + h : 12 - h;

}

/** Day of the year of the 21st of `month` (1–12), near each solstice and equinox. */
export const dayOfYearForMonth = month => [ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 ][ month - 1 ] + 21;
