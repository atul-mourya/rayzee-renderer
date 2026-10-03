import { Fn, wgslFn, vec2, vec3, ivec2, float, int, If, Loop, sin, sqrt, min, max, clamp, select } from 'three/tsl';

import { EXACT_TABLE_MAX_WIDTH } from '../Processor/EnvironmentExactTable.js';

// Convert direction to UV coordinates for equirectangular map
// Exact implementation from three-gpu-pathtracer
export const equirectDirectionToUv = /*@__PURE__*/ wgslFn( `
	fn equirectDirectionToUv( direction: vec3f, environmentMatrix: mat4x4f ) -> vec2f {
		let d = normalize( ( environmentMatrix * vec4f( direction, 0.0f ) ).xyz );
		var uv = vec2f( atan2( d.z, d.x ), acos( d.y ) );
		uv = uv / vec2f( 6.28318530717958647692f, 3.14159265358979323846f );
		uv.x = uv.x + 0.5f;
		uv.y = 1.0f - uv.y;
		return uv;
	}
` );

// Convert UV coordinates to direction
// Exact implementation from three-gpu-pathtracer
export const equirectUvToDirection = /*@__PURE__*/ wgslFn( `
	fn equirectUvToDirection( uv: vec2f, environmentMatrix: mat4x4f ) -> vec3f {
		let adjustedUv = vec2f( uv.x - 0.5f, 1.0f - uv.y );
		let theta = adjustedUv.x * 6.28318530717958647692f;
		let phi = adjustedUv.y * 3.14159265358979323846f;
		let sinPhi = sin( phi );
		let localDir = vec3f( sinPhi * cos( theta ), cos( phi ), sinPhi * sin( theta ) );
		return normalize( ( transpose( environmentMatrix ) * vec4f( localDir, 0.0f ) ).xyz );
	}
` );

// The table (EnvironmentExactTable.js packExactTable): each row's running sum over its w cells in columns [0, w) of
// rows [h, 2h), the rows' in column w; their guides in the same places of rows [0, h). Sizes as exactTableSize.
const exactTable = ( cdfTexture, envResolution ) => {

	const W = int( envResolution.x );
	const H = int( envResolution.y );
	const k = max( W.add( int( EXACT_TABLE_MAX_WIDTH - 1 ) ).div( int( EXACT_TABLE_MAX_WIDTH ) ), int( 1 ) );
	const w = W.add( k ).sub( int( 1 ) ).div( k ).toVar();
	const h = H.add( k ).sub( int( 1 ) ).div( k ).toVar();
	const at = ( x, y ) => cdfTexture.load( ivec2( x, h.add( y ) ) ).x;
	const guide = ( x, y ) => int( cdfTexture.load( ivec2( x, y ) ).x );
	const below = ( x, y, along ) => select( along.greaterThan( int( 0 ) ), at( x, y ), float( 0.0 ) );
	return { w, h, at, guide, below };

};

// First of `count` entries above `target`, the last when none is. The answer lies between the guides of the step
// below and two above: one entry of slack each way for f32 rounding of target × count.
const guidedSearch = ( count, guideAt, valueAt, target ) => {

	const step = clamp( int( target.mul( float( count ) ) ), int( 0 ), count.sub( int( 1 ) ) ).toVar();
	const lo = max( guideAt( step ).sub( int( 1 ) ), int( 0 ) ).toVar();
	const hi = select( step.add( int( 2 ) ).lessThan( count ), guideAt( min( step.add( int( 2 ) ), count.sub( int( 1 ) ) ) ), count.sub( int( 1 ) ) ).toVar();
	Loop( lo.lessThan( hi ), () => {

		const mid = lo.add( hi ).div( 2 ).toVar();
		If( valueAt( mid ).lessThanEqual( target ), () => {

			lo.assign( mid.add( 1 ) );

		} ).Else( () => {

			hi.assign( mid );

		} );

	} );
	return lo;

};

// Cell density over uv, per steradian at v.
const cellPdf = ( share, w, h, v ) => {

	const sinTheta = sin( v.mul( Math.PI ) );
	return select( sinTheta.greaterThan( 0.0 ).and( share.greaterThan( 0.0 ) ),
		share.mul( float( w ) ).mul( float( h ) ).div( max( sinTheta.mul( 2 * Math.PI * Math.PI ), 1e-30 ) ), float( 0.0 ) );

};

/** A direction drawn exactly from the table, and its density per steradian. */
export function sampleEnvironmentExact( cdfTexture, environmentMatrix, envResolution, xi ) {

	const { w, h, at, guide, below } = exactTable( cdfTexture, envResolution );

	const y = guidedSearch( h, ( i ) => guide( w, i ), ( i ) => at( w, i ), xi.y ).toVar();
	const rowTop = at( w, y ).toVar();
	const rowBottom = below( w, max( y.sub( int( 1 ) ), int( 0 ) ), y ).toVar();
	const x = guidedSearch( w, ( i ) => guide( i, y ), ( i ) => at( i, y ), xi.x ).toVar();
	const cellTop = at( x, y ).toVar();
	const cellBottom = below( max( x.sub( int( 1 ) ), int( 0 ) ), y, x ).toVar();
	const pRow = rowTop.sub( rowBottom ).toVar();
	const pCell = cellTop.sub( cellBottom ).toVar();

	const fv = clamp( xi.y.sub( rowBottom ).div( max( pRow, 1e-30 ) ), 0.0, 0.99999994 );
	const fu = clamp( xi.x.sub( cellBottom ).div( max( pCell, 1e-30 ) ), 0.0, 0.99999994 );
	const uv = vec2( float( x ).add( fu ).div( float( w ) ), float( y ).add( fv ).div( float( h ) ) ).toVar();

	return { direction: equirectUvToDirection( { uv, environmentMatrix } ), pdf: cellPdf( pRow.mul( pCell ), w, h, uv.y ) };

}

/** sampleEnvironmentExact's density per steradian for `direction`. */
export function environmentPdfExact( cdfTexture, environmentMatrix, envResolution, direction ) {

	const { w, h, at, below } = exactTable( cdfTexture, envResolution );
	const uv = equirectDirectionToUv( { direction, environmentMatrix } ).toVar();
	const x = clamp( int( uv.x.mul( float( w ) ) ), int( 0 ), w.sub( int( 1 ) ) ).toVar();
	const y = clamp( int( uv.y.mul( float( h ) ) ), int( 0 ), h.sub( int( 1 ) ) ).toVar();
	const pRow = at( w, y ).sub( below( w, max( y.sub( int( 1 ) ), int( 0 ) ), y ) );
	const pCell = at( x, y ).sub( below( max( x.sub( int( 1 ) ), int( 0 ) ), y, x ) );
	return cellPdf( pRow.mul( pCell ), w, h, uv.y );

}

// Simple environment lookup (no importance sampling) — native WGSL
export const sampleEnvironment = /*@__PURE__*/ wgslFn( `
	fn sampleEnvironment(
		tex: texture_2d<f32>,
		samp: sampler,
		direction: vec3f,
		environmentMatrix: mat4x4f,
		environmentIntensity: f32,
		enableEnvironmentLight: f32
	) -> vec4f {
		if ( enableEnvironmentLight < 0.5 ) { return vec4f( 0.0 ); }
		let uv = equirectDirectionToUv( direction, environmentMatrix );
		let texSample = textureSampleLevel( tex, samp, uv, 0.0 );
		return texSample * environmentIntensity;
	}
`, [ equirectDirectionToUv ] );

// Port of three.js PR #33611 (getGroundProjectedNormal) adapted from rasterizer fragment math
// (cameraPosition + positionWorld) to path-tracer ray math (rayOrigin + rayDirection). When the
// ray misses the projection sphere it falls back to rayDirection so distant scenes degrade gracefully.
export const getGroundProjectedDirection = Fn( ( [ rayOrigin, rayDirection, radius, height ] ) => {

	const p = rayDirection.toConst();
	const camPos = rayOrigin.toVar();
	camPos.y.subAssign( height );

	const r2 = radius.mul( radius ).toConst();
	const b = camPos.dot( p ).toConst();
	const c = camPos.dot( camPos ).sub( r2 ).toConst();
	const h = b.mul( b ).sub( c ).toConst();

	const projected = rayDirection.toVar();

	If( h.greaterThanEqual( 0.0 ), () => {

		const tSphere = sqrt( h ).sub( b ).toVar();

		// Disk sits at world y=0; the camPos shift only repositions the sphere.
		const tDisk = float( 1e6 ).toVar();
		const py = p.y.toConst();
		If( py.lessThanEqual( 0.0 ), () => {

			const t = rayOrigin.y.negate().div( py ).toConst();
			const q = rayOrigin.add( p.mul( t ) ).toConst();
			If( q.dot( q ).lessThan( r2 ), () => {

				tDisk.assign( t );

			} );

		} );

		If( tSphere.greaterThan( 0.0 ), () => {

			projected.assign( camPos.add( p.mul( min( tSphere, tDisk ) ) ).div( radius ) );

		} );

	} );

	return projected;

} );

// Primary-ray environment lookup direction: bends onto the ground-projection sphere/disk when
// ground projection is enabled, else returns the ray direction unchanged. Shared by the background
// miss branch AND the shadow catcher so they can never disagree on the projection (the source of a
// past horizon-seam bug when only one path bent the direction).
export const groundProjectedEnvDir = Fn( ( [ rayOrigin, rayDirection, enabled, radius, height, level ] ) => {

	const dir = rayDirection.toVar();
	If( enabled, () => {

		// Relocate the projected ground plane from y=0 to world y=level (the scene floor) so a model
		// authored off the origin still sits ON the ground instead of sinking. Shifting the projection
		// origin down by `level` puts the disk at y=level and the sphere at y=level+height; the internal
		// horizontal radius test stays correct because the shifted disk point lands at y'=0.
		const shiftedOrigin = vec3( rayOrigin.x, rayOrigin.y.sub( level ), rayOrigin.z );
		dir.assign( getGroundProjectedDirection( shiftedOrigin, rayDirection, radius, height ) );

	} );
	return dir;

} );
