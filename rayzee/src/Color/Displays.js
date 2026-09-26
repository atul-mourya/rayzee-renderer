/**
 * Which OCIO displays the canvas can show as intended.
 *
 * Only a display whose encoding *is* a canvas colour space qualifies. sRGB, Rec.1886 and gamma 2.2
 * Rec.709 are all shown on an sRGB canvas. "Display P3" is P3 primaries with the sRGB curve — exactly
 * `display-p3`. "P3-D65" is the cinema variant with a 2.6 gamma, and Rec.2020 and the HDR displays
 * have no canvas equivalent at all.
 *
 * @returns {'srgb'|'display-p3'|null}
 */
export function displayCanvasFit( display ) {

	const name = String( display ?? '' );
	if ( /(hdr|pq|hlg|2100|st2084)/i.test( name ) ) return null;
	if ( /^display\s*p3\b/i.test( name ) ) return 'display-p3';
	if ( /^(srgb|rec\.?\s*1886|bt\.?\s*1886|gamma\s*2\.2\s*rec\.?\s*709)\b(?!.*(p3|2020))/i.test( name ) ) return 'srgb';
	return null;

}
