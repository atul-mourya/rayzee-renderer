/**
 * The analytic lights as bidirectional sources: the camera side's lamp choice, made as the path tracer
 * makes it, and the densities a light path needs to weigh the strategies against it.
 */

import { float, int, If, Loop, select, cos, max, min } from 'three/tsl';

import { struct } from './patches.js';
import {
	DirectionalLight, AreaLight, PointLight, SpotLight,
	getDirectionalLight, getAreaLight, getPointLight, getSpotLight,
	LIGHT_TYPE_DIRECTIONAL, LIGHT_TYPE_AREA, LIGHT_TYPE_POINT, sphQuadSolidAngle,
} from './LightsCore.js';
import {
	calculateDirectionalLightImportance, estimateLightImportance, calculatePointLightImportance, calculateSpotLightImportance,
} from './LightsDirect.js';
import { SAMPLER_DIM_AUX_BASE } from './Random.js';
import { PI } from './Common.js';

export const LampPick = struct( { kind: 'int', index: 'int', pdf: 'float', total: 'float' } );

/** @param lamps { directional, numDirectional, area, numArea, point, numPoint, spot, numSpot } */
export const lampCount = ( lamps ) => lamps.numDirectional.add( lamps.numArea ).add( lamps.numPoint ).add( lamps.numSpot );

export const lampTypeAt = ( lamps, flat ) => select( flat.lessThan( lamps.numDirectional ), int( LIGHT_TYPE_DIRECTIONAL ),
	select( flat.lessThan( lamps.numDirectional.add( lamps.numArea ) ), int( LIGHT_TYPE_AREA ),
		select( flat.lessThan( lamps.numDirectional.add( lamps.numArea ).add( lamps.numPoint ) ), int( LIGHT_TYPE_POINT ), int( 3 ) ) ) );

const typeStart = ( lamps, type ) => select( type.equal( int( LIGHT_TYPE_DIRECTIONAL ) ), int( 0 ),
	select( type.equal( int( LIGHT_TYPE_AREA ) ), lamps.numDirectional,
		select( type.equal( int( LIGHT_TYPE_POINT ) ), lamps.numDirectional.add( lamps.numArea ),
			lamps.numDirectional.add( lamps.numArea ).add( lamps.numPoint ) ) ) );

// The path tracer's importance (LightsDirect.js) without its bounce-depth factor, which a light path cannot know.
const walkLamps = ( lamps, hitPoint, N, material, visit ) => {

	const each = ( type, count, read ) => If( count.greaterThan( int( 0 ) ), () => {

		Loop( { start: int( 0 ), end: count, type: 'int', condition: '<' }, ( { i } ) => {

			visit( int( type ), i, read( i ).toVar() );

		} );

	} );
	each( LIGHT_TYPE_DIRECTIONAL, lamps.numDirectional, ( i ) =>
		calculateDirectionalLightImportance( DirectionalLight.wrap( getDirectionalLight( lamps.directional, i ) ), N, material, int( 0 ) ) );
	each( LIGHT_TYPE_AREA, lamps.numArea, ( i ) => {

		const light = AreaLight.wrap( getAreaLight( lamps.area, i ) );
		return select( light.intensity.greaterThan( 0.0 ), estimateLightImportance( light, hitPoint, N, material ), float( 0.0 ) );

	} );
	each( LIGHT_TYPE_POINT, lamps.numPoint, ( i ) =>
		calculatePointLightImportance( PointLight.wrap( getPointLight( lamps.point, i ) ), hitPoint, N, material ) );
	each( 3, lamps.numSpot, ( i ) =>
		calculateSpotLightImportance( SpotLight.wrap( getSpotLight( lamps.spot, i ) ), hitPoint, N, material ) );

};

/**
 * One lamp, as the path tracer's reservoir picks it, on the same dimensions; uniform when nothing has importance.
 * `sample1D( dim )` draws a 1D variate, `u` is the fallback's.
 */
export function pickLamp( lamps, hitPoint, N, material, u, sample1D ) {

	const type = int( - 1 ).toVar();
	const index = int( - 1 ).toVar();
	const chosen = float( 0.0 ).toVar();
	const total = float( 0.0 ).toVar();
	walkLamps( lamps, hitPoint, N, material, ( t, i, w ) => {

		total.addAssign( w );
		If( w.greaterThan( 0.0 ).and( sample1D( int( SAMPLER_DIM_AUX_BASE + 64 ).add( typeStart( lamps, t ) ).add( i ) ).mul( total ).lessThan( w ) ), () => {

			type.assign( t );
			index.assign( i );
			chosen.assign( w );

		} );

	} );

	const count = lampCount( lamps ).toVar();
	const pdf = chosen.div( max( total, 1e-10 ) ).toVar();
	If( total.lessThanEqual( 0.0 ), () => {

		const flat = min( int( u.mul( float( count ) ) ), count.sub( int( 1 ) ) ).toVar();
		type.assign( lampTypeAt( lamps, flat ) );
		index.assign( flat.sub( typeStart( lamps, type ) ) );
		pdf.assign( float( 1.0 ).div( max( float( count ), 1.0 ) ) );

	} );

	return LampPick( { kind: type, index, pdf, total } );

}

/** The chance `pickLamp` at this point takes lamp (type, index). */
export function lampPickPdf( lamps, type, index, hitPoint, N, material ) {

	const total = float( 0.0 ).toVar();
	const own = float( 0.0 ).toVar();
	walkLamps( lamps, hitPoint, N, material, ( t, i, w ) => {

		total.addAssign( w );
		If( t.equal( type ).and( i.equal( index ) ), () => {

			own.assign( w );

		} );

	} );
	return select( total.greaterThan( 0.0 ), own.div( total ), float( 1.0 ).div( max( float( lampCount( lamps ) ), 1.0 ) ) );

}

// Solid angle of a spot's cone, over which its light paths leave uniformly.
export const spotConeSolidAngle = ( light ) => float( 2 * PI ).mul( max( float( 1.0 ).sub( cos( light.angle ) ), 1e-10 ) );

// A soft directional light's cone (angle = angular diameter), as sampleDirectionalLight computes it.
export const directionalConeSolidAngle = ( light ) => float( 2 * PI ).mul( max( float( 1.0 ).sub( cos( light.angle.mul( 0.5 ) ) ), 1e-10 ) );

/** Area-light NEE's solid-angle density for any point of the light, seen from `from` (sampleRectAreaLight). */
export const areaLightDirectPdfW = ( light, from, dist, cosLight ) => {

	const corner = light.position.sub( light.u ).sub( light.v );
	const solidAngle = sphQuadSolidAngle( from, corner, light.u.mul( 2.0 ), light.v.mul( 2.0 ) ).toVar();
	return select( light.shape.lessThan( 0.5 ).and( solidAngle.greaterThan( 1e-5 ) ), float( 1.0 ).div( solidAngle ),
		dist.mul( dist ).div( max( light.area.mul( max( cosLight, 0.001 ) ), 1e-10 ) ) );

};
