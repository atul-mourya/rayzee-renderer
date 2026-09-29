/**
 * IESParser.js
 * Parser for IESNA LM-63 photometric data files (.ies).
 *
 * Returns the candela grid (one row per vertical angle), the angle lists,
 * and the peak candela for normalisation.
 *
 * Reference: IESNA LM-63-2002 standard.
 */

/**
 * @typedef {Object} IESProfile
 * @property {number[]} verticalAngles    - degrees, length V
 * @property {number[]} horizontalAngles  - degrees, length H
 * @property {Float32Array[]} candela     - row-major [V][H], H values per row
 * @property {number} maxCandela          - peak intensity across the grid
 * @property {number} lumens              - lumens per lamp
 * @property {number} photometricType     - 1 = C (most common), 2 = B, 3 = A
 * @property {string} [name]              - optional source-file basename
 */

/**
 * Parses an IES file's text content into a numeric profile.
 * @param {string} text  - raw .ies file contents
 * @param {string} [name]  - optional identifier used in error messages
 * @returns {IESProfile}
 */
export function parseIES( text, name = 'ies' ) {

	// Strip the header (everything up to and including the TILT line).
	const tiltIdx = text.search( /TILT\s*=/i );
	if ( tiltIdx < 0 ) throw new Error( `IES (${name}): missing TILT line` );

	const headerEnd = text.indexOf( '\n', tiltIdx );
	if ( headerEnd < 0 ) throw new Error( `IES (${name}): truncated TILT line` );

	const tiltMatch = text.slice( tiltIdx, headerEnd ).match( /TILT\s*=\s*(\w+)/i );
	const tilt = tiltMatch ? tiltMatch[ 1 ].toUpperCase() : 'NONE';

	let body = text.slice( headerEnd );

	// TILT=INCLUDE has an inline tilt-data block we need to skip. The block has:
	//   <lampToLuminaireGeometry>
	//   <numTiltAngles>
	//   <tiltAngles ...>
	//   <multipliers ...>
	if ( tilt === 'INCLUDE' ) {

		const tokens = tokenize( body );
		// First token = geometry (1, 2, or 3)
		// Second token = number of pairs
		const numPairs = Number( tokens[ 1 ] );
		// Skip: geometry + count + 2 * numPairs values
		const skip = 2 + 2 * numPairs;
		body = remainderAfterTokens( body, skip );

	}

	const tokens = tokenize( body );
	let i = 0;
	const next = () => Number( tokens[ i ++ ] );

	const lampCount = next();
	const lumens = next();
	const multiplier = next();
	const numVertAngles = next();
	const numHorizAngles = next();
	const photometricType = next();
	/* const unitsType = */ next();
	/* width   */ next();
	/* length  */ next();
	/* height  */ next();
	const ballastFactor = next();
	/* futureUse */ next();
	/* inputWatts */ next();

	if ( ! Number.isFinite( numVertAngles ) || numVertAngles <= 0 ) {

		throw new Error( `IES (${name}): invalid vertical angle count ${numVertAngles}` );

	}

	if ( ! Number.isFinite( numHorizAngles ) || numHorizAngles <= 0 ) {

		throw new Error( `IES (${name}): invalid horizontal angle count ${numHorizAngles}` );

	}

	const verticalAngles = new Array( numVertAngles );
	for ( let v = 0; v < numVertAngles; v ++ ) verticalAngles[ v ] = next();

	const horizontalAngles = new Array( numHorizAngles );
	for ( let h = 0; h < numHorizAngles; h ++ ) horizontalAngles[ h ] = next();

	// Candela grid: in LM-63 the order is [horizontal][vertical] — for each
	// horizontal plane, all vertical samples are listed before the next plane.
	// We store as candela[v][h] for direct (theta, phi) lookups in the shader.
	const candela = new Array( numVertAngles );
	for ( let v = 0; v < numVertAngles; v ++ ) candela[ v ] = new Float32Array( numHorizAngles );

	const scale = multiplier * ballastFactor;
	let peak = 0;

	for ( let h = 0; h < numHorizAngles; h ++ ) {

		for ( let v = 0; v < numVertAngles; v ++ ) {

			const cd = next() * scale;
			candela[ v ][ h ] = cd;
			if ( cd > peak ) peak = cd;

		}

	}

	return {
		verticalAngles,
		horizontalAngles,
		candela,
		maxCandela: peak,
		lumens: lumens * lampCount,
		photometricType,
		name,
	};

}

/**
 * Resample an IESProfile onto a fixed-size 2D grid suitable for a
 * DataArrayTexture layer. Values are normalised to [0,1] by `maxCandela`
 * so the shader gets a pure shape multiplier; absolute intensity scaling
 * stays in `light.intensity`.
 *
 * UV convention:
 *   U = horizontal angle / 360  (0..1)
 *   V = vertical angle / 180    (0..1, 0 = bulb axis, 1 = opposite axis)
 *
 * Profiles that are rotationally symmetric (single horizontal sample, or all
 * H angles identical) replicate the row across the U axis so the shader can
 * sample uniformly without a symmetry flag.
 *
 * @param {IESProfile} profile
 * @param {number} width   - texture width in samples (horizontal/U axis)
 * @param {number} height  - texture height in samples (vertical/V axis)
 * @returns {Uint8Array}  width*height bytes, R channel only
 */
export function resampleIESToGrid( profile, width, height ) {

	const data = new Uint8Array( width * height );
	const { verticalAngles: vA, horizontalAngles: hA, candela, maxCandela } = profile;

	if ( maxCandela <= 0 ) return data; // dead profile → zeros

	const vMaxDeg = vA[ vA.length - 1 ];
	const hMaxDeg = hA[ hA.length - 1 ];
	const hMin = hA[ 0 ];
	const rotationallySymmetric = hA.length === 1 || hMaxDeg === hMin;

	for ( let py = 0; py < height; py ++ ) {

		// V coordinate → vertical angle in degrees. Texture covers [0, vMaxDeg].
		const tV = ( py + 0.5 ) / height;
		const vDeg = tV * vMaxDeg;
		const v0 = lowerBoundIdx( vA, vDeg );
		const v1 = Math.min( v0 + 1, vA.length - 1 );
		const vSpan = vA[ v1 ] - vA[ v0 ];
		const vt = vSpan > 0 ? ( vDeg - vA[ v0 ] ) / vSpan : 0;

		for ( let px = 0; px < width; px ++ ) {

			let cd;

			if ( rotationallySymmetric ) {

				// Single column → just bilerp on V axis.
				cd = lerp( candela[ v0 ][ 0 ], candela[ v1 ][ 0 ], vt );

			} else {

				const tH = ( px + 0.5 ) / width;
				const hDeg = hMin + tH * ( hMaxDeg - hMin );
				const h0 = lowerBoundIdx( hA, hDeg );
				const h1 = Math.min( h0 + 1, hA.length - 1 );
				const hSpan = hA[ h1 ] - hA[ h0 ];
				const ht = hSpan > 0 ? ( hDeg - hA[ h0 ] ) / hSpan : 0;

				const c00 = candela[ v0 ][ h0 ];
				const c10 = candela[ v0 ][ h1 ];
				const c01 = candela[ v1 ][ h0 ];
				const c11 = candela[ v1 ][ h1 ];
				cd = lerp( lerp( c00, c10, ht ), lerp( c01, c11, ht ), vt );

			}

			const norm = Math.min( 1, Math.max( 0, cd / maxCandela ) );
			data[ py * width + px ] = Math.round( norm * 255 );

		}

	}

	return data;

}

/**
 * Estimate a sensible spot-light cone half-angle from an IES profile.
 *
 * Returns the smallest vertical angle (radians) where the average candela
 * across the horizontal samples drops below `threshold * maxCandela`. The
 * resulting cone snugly bounds the profile's meaningful emission.
 *
 * @param {IESProfile} profile
 * @param {number} [threshold=0.1] - intensity ratio considered "off"
 * @returns {number} suggested half-angle in radians, clamped to [5°, 89°]
 */
export function deriveIESBeamAngle( profile, threshold = 0.1 ) {

	const { verticalAngles: vA, horizontalAngles: hA, candela, maxCandela } = profile;
	const fallback = Math.PI / 4;
	if ( maxCandela <= 0 || ! vA?.length ) return fallback;

	const cutoff = maxCandela * threshold;
	const hCount = hA.length;

	// Scan from on-axis outward — works correctly for monotonically falling
	// beams (the common case). For peaks-off-axis profiles (rare) this just
	// picks the first low-intensity ring outside the centre.
	let crossingDeg = vA[ vA.length - 1 ];
	let everAboveCutoff = false;
	for ( let v = 0; v < vA.length; v ++ ) {

		let avg = 0;
		for ( let h = 0; h < hCount; h ++ ) avg += candela[ v ][ h ];
		avg /= hCount;

		if ( avg >= cutoff ) everAboveCutoff = true;
		if ( everAboveCutoff && avg < cutoff ) {

			crossingDeg = vA[ v ];
			break;

		}

	}

	const rad = crossingDeg * Math.PI / 180;
	// Clamp to [5°, 89°] so it stays useful for both very tight and diffuse profiles.
	return Math.min( Math.max( rad, 5 * Math.PI / 180 ), 89 * Math.PI / 180 );

}

/**
 * Estimate a sensible penumbra factor [0,1] from an IES profile, matching
 * the three.js spot-light convention (0 = sharp edge, 1 = entire cone is the
 * transition band).
 *
 * Penumbra = 1 - (innerAngle / outerAngle), where:
 *   outerAngle = `cutoff * maxCandela` crossing (use the value from deriveIESBeamAngle)
 *   innerAngle = where the candela average first drops below `peakRatio * maxCandela`
 *
 * For tightly-clamped beams (innerAngle ≈ outerAngle) this returns near-zero;
 * for soft profiles with a long tail it returns a high value.
 *
 * @param {IESProfile} profile
 * @param {number} outerAngleRad - the cone half-angle returned by deriveIESBeamAngle
 * @param {number} [peakRatio=0.7] - intensity ratio considered "still hot"
 * @returns {number} penumbra in [0,1]
 */
export function deriveIESPenumbra( profile, outerAngleRad, peakRatio = 0.7 ) {

	const { verticalAngles: vA, horizontalAngles: hA, candela, maxCandela } = profile;
	if ( maxCandela <= 0 || ! vA?.length || outerAngleRad <= 0 ) return 0;

	const hotCutoff = maxCandela * peakRatio;
	const hCount = hA.length;
	let innerDeg = 0;

	for ( let v = 0; v < vA.length; v ++ ) {

		let avg = 0;
		for ( let h = 0; h < hCount; h ++ ) avg += candela[ v ][ h ];
		avg /= hCount;
		if ( avg >= hotCutoff ) innerDeg = vA[ v ]; else break;

	}

	const outerDeg = outerAngleRad * 180 / Math.PI;
	const penumbra = outerDeg > 0 ? 1 - ( innerDeg / outerDeg ) : 0;
	return Math.min( Math.max( penumbra, 0 ), 1 );

}

// ── helpers ─────────────────────────────────────────────────────────

function tokenize( text ) {

	return text.split( /\s+/ ).filter( s => s.length > 0 );

}

function remainderAfterTokens( text, count ) {

	const re = /\S+/g;
	let n = 0;
	while ( re.exec( text ) !== null ) {

		n ++;
		if ( n === count ) return text.slice( re.lastIndex );

	}

	return '';

}

function lowerBoundIdx( arr, x ) {

	if ( x <= arr[ 0 ] ) return 0;
	if ( x >= arr[ arr.length - 1 ] ) return arr.length - 1;

	let lo = 0;
	let hi = arr.length - 1;
	while ( hi - lo > 1 ) {

		const mid = ( lo + hi ) >> 1;
		if ( arr[ mid ] <= x ) lo = mid; else hi = mid;

	}

	return lo;

}

function lerp( a, b, t ) {

	return a + ( b - a ) * t;

}
